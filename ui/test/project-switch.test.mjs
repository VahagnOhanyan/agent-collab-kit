// The panel's project switcher: `?project=<id>` makes every journal screen read that registry project's journal, and
// nothing outside the trusted registry can be named. Two projects, a task in each.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'

import { createApi } from '../../collab/src/api.mjs'
import { gitRepo, initialisedJournal, tempDir, writeJson } from '../../collab/test/helpers.mjs'
import { startPanel } from '../server.mjs'

const TOKEN = '0123456789abcdef0123456789abcdef0123456789abcdef'
const machine = () => ({ home: '/nowhere', platform: 'darwin', which: (b) => `/usr/bin/${b}`, exists: () => false, read: () => null })

async function world() {
  const base = tempDir('panel-projects-')
  const registryDir = join(base, 'registry')
  const machineDir = join(base, 'no-machine')
  const roots = {}
  for (const id of ['alpha', 'beta']) {
    const root = gitRepo(join(base, id))
    initialisedJournal(join(root, '.collab'))
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'docs', 'backlog.md'), `- [X/Код] app/${id}.js — мелочь в ${id}\n`)
    writeJson(join(registryDir, id, 'project.json'), { id, roots: [root], review_backlog: 'docs/backlog.md' })
    roots[id] = root
  }
  const options = (where) => ({ cwd: where?.cwd || roots.alpha, registryDir, machineDir, probeEnv: machine() })
  const apiFactory = (where) => createApi({ agentId: 'claude', ...options(where), readOnly: true })
  const writeApiFactory = (where) => createApi({ agentId: 'claude', ...options(where) })
  for (const id of ['alpha', 'beta']) {
    await createApi({ agentId: 'claude', ...options({ cwd: roots[id] }) }).createTask({ title: `Work in ${id}`, action: 'edit a file' })
  }
  return { base, roots, registryDir, apiFactory, writeApiFactory, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

async function panel(t, w) {
  let started
  try {
    started = await startPanel({ token: TOKEN, apiFactory: w.apiFactory, writeApiFactory: w.writeApiFactory, registryDir: w.registryDir, cwd: w.roots.alpha, allowWrite: true })
  } catch (error) {
    if (error?.code !== 'EPERM') throw error
    t.skip(`sandbox refused 127.0.0.1 listen: ${error.message}`)
    return null
  }
  t.after(() => started.close())
  return started
}

function send(started, method, path, body) {
  const { port } = new URL(started.url)
  const payload = body === undefined ? '' : JSON.stringify(body)
  const headers = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-panel-token': TOKEN, 'content-length': Buffer.byteLength(payload) }
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: Number(port), method, path, headers }, (res) => {
      let text = ''
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(text) } catch { /* not JSON */ }
        resolve({ status: res.statusCode, json, text })
      })
    })
    req.on('error', reject)
    req.end(payload)
  })
}

const titles = (list) => (Array.isArray(list) ? list : list.tasks || []).map((task) => task.title)

test('the switcher lists the registry projects; ?project= makes the journal screens read that project', async (t) => {
  const w = await world()
  try {
    const started = await panel(t, w)
    if (!started) return
    const projects = (await send(started, 'GET', '/api/projects')).json
    assert.deepEqual(projects.projects.map((p) => [p.id, p.present, p.initialized]), [['alpha', true, true], ['beta', true, true]])
    assert.deepEqual([projects.started, projects.selected], ['alpha', 'alpha'])
    assert.deepEqual(titles((await send(started, 'GET', '/api/tasks')).json), ['Work in alpha'], 'no parameter: the project the panel started in')
    assert.deepEqual(titles((await send(started, 'GET', '/api/tasks?project=beta')).json), ['Work in beta'])
    assert.equal((await send(started, 'GET', '/api/projects?project=beta')).json.selected, 'beta')
    const backlog = (await send(started, 'GET', '/api/backlog?project=beta')).json
    assert.match(JSON.stringify(backlog.groups), /мелочь в beta/, 'the backlog is the selected project\'s too')
  } finally {
    w.cleanup()
  }
})

test('nothing outside the registry can be named: an unknown id, a path, two values', async (t) => {
  const w = await world()
  try {
    const started = await panel(t, w)
    if (!started) return
    assert.equal((await send(started, 'GET', '/api/tasks?project=gamma')).status, 404)
    assert.equal((await send(started, 'GET', `/api/tasks?project=${encodeURIComponent('../alpha')}`)).status, 400)
    assert.equal((await send(started, 'GET', `/api/tasks?project=${encodeURIComponent(w.roots.beta)}`)).status, 400)
    assert.equal((await send(started, 'GET', '/api/tasks?project=alpha&project=beta')).status, 400)
  } finally {
    w.cleanup()
  }
})

test('a cleanup created with a project chosen lands in that project\'s journal', async (t) => {
  const w = await world()
  try {
    const started = await panel(t, w)
    if (!started) return
    const view = (await send(started, 'GET', '/api/backlog?project=beta')).json
    const done = await send(started, 'POST', '/api/backlog/cleanup?project=beta', { feature: view.groups[0].feature, role: 'software_engineer', expect: view.expect })
    assert.equal(done.status, 200, done.text)
    assert.ok(titles((await send(started, 'GET', '/api/tasks?project=beta')).json).some((title) => title.startsWith('Уборка мелочей')))
    assert.equal(titles((await send(started, 'GET', '/api/tasks')).json).some((title) => title.startsWith('Уборка мелочей')), false, 'nothing in the other project')
  } finally {
    w.cleanup()
  }
})

test('review fixes: a repeated parameter is refused even with an empty first value; machine screens and the list survive an unusable choice; no root is sent', async (t) => {
  const w = await world()
  try {
    const started = await panel(t, w)
    if (!started) return
    assert.equal((await send(started, 'GET', '/api/tasks?project=&project=beta')).status, 400)
    const list = (await send(started, 'GET', '/api/projects?project=gamma')).json
    assert.equal(list.selected, null)
    assert.match(list.unusable, /gamma/)
    assert.equal(JSON.stringify(list).includes(w.roots.alpha), false, 'no root path in the answer')
    assert.equal((await send(started, 'GET', '/api/kit?project=gamma')).status, 200, 'a machine screen does not depend on the project')
    assert.equal((await send(started, 'GET', '/api/tasks?project=gamma')).status, 404, 'a journal screen still refuses it')
  } finally {
    w.cleanup()
  }
})
