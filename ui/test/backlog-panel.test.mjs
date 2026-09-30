// The panel's backlog section: groups read from the project's backlog by the features in its registry entry, and
// the one journal write — a cleanup task for one group — made only from the panel page, from what the owner saw,
// once per group while it is open, for a role somebody holds.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'

import { createApi } from '../../collab/src/api.mjs'
import { gitRepo, initialisedJournal, tempDir, writeJson } from '../../collab/test/helpers.mjs'
import { startPanel } from '../server.mjs'

const TOKEN = '0123456789abcdef0123456789abcdef0123456789abcdef'
const BACKLOG = [
  '- [CC-1/Сториз] Tripix/Story/Export/A.swift — первое',
  '- [CC-2/Сториз] Tripix/Story/Export/B.swift:10 — второе',
  '- [CC-3/Бэк] backend/src/x.js — третье'
].join('\n')
const machine = () => ({ home: '/nowhere', platform: 'darwin', which: (b) => `/usr/bin/${b}`, exists: () => false, read: () => null })

function project() {
  const base = tempDir('panel-backlog-')
  const root = gitRepo(join(base, 'repo'))
  initialisedJournal(join(root, '.collab'))
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(join(root, 'docs', 'backlog.md'), BACKLOG)
  const registryDir = join(base, 'registry')
  writeJson(join(registryDir, 'demo', 'project.json'), { id: 'demo', roots: [root], review_backlog: 'docs/backlog.md' })
  writeJson(join(registryDir, 'demo', 'features.json'), { features: [{ name: 'Сториз', paths: ['Tripix/Story/**'] }, { name: 'Бэкенд', paths: ['backend/**'] }] })
  const machineDir = join(base, 'no-machine')
  const options = { cwd: root, registryDir, machineDir, probeEnv: machine() }
  return {
    base,
    root,
    registryDir,
    apiFactory: () => createApi({ agentId: 'claude', ...options, readOnly: true }),
    writeApiFactory: () => createApi({ agentId: 'claude', ...options }),
    cleanup: () => rmSync(base, { recursive: true, force: true })
  }
}

async function panel(t, p, extra = {}) {
  let started
  try {
    started = await startPanel({ token: TOKEN, apiFactory: p.apiFactory, writeApiFactory: p.writeApiFactory, registryDir: p.registryDir, cwd: p.root, allowWrite: true, ...extra })
  } catch (error) {
    if (error?.code !== 'EPERM') throw error
    t.skip(`sandbox refused 127.0.0.1 listen: ${error.message}`)
    return null
  }
  t.after(() => started.close())
  return started
}

function send(started, method, path, body, over = {}) {
  const { port } = new URL(started.url)
  const payload = body === undefined ? '' : JSON.stringify(body)
  const headers = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-panel-token': TOKEN, 'content-length': Buffer.byteLength(payload), ...over }
  for (const key of Object.keys(headers)) if (headers[key] === undefined) delete headers[key]
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

test('the section shows the backlog grouped by feature, with counts, the threshold and a suggested role', async (t) => {
  const p = project()
  try {
    const started = await panel(t, p)
    if (!started) return
    const view = (await send(started, 'GET', '/api/backlog')).json
    assert.equal(view.configured, true, view.reason)
    assert.deepEqual([view.total, view.threshold, view.writable], [3, 8, true])
    assert.deepEqual(view.groups.map((g) => [g.feature, g.count, g.role, g.cleanup]), [['Сториз', 2, 'ios_engineer', null], ['Бэкенд', 1, 'backend_engineer', null]])
  } finally {
    p.cleanup()
  }
})

test('a cleanup task is created for one group, once while it is open, and the backlog file is not touched', async (t) => {
  const p = project()
  try {
    const started = await panel(t, p)
    if (!started) return
    const before = readFileSync(join(p.root, 'docs', 'backlog.md'), 'utf8')
    const view = (await send(started, 'GET', '/api/backlog')).json
    const done = await send(started, 'POST', '/api/backlog/cleanup', { feature: 'Сториз', role: 'ios_engineer', expect: view.expect })
    assert.equal(done.status, 200, done.text)
    assert.equal(done.json.task.title, 'Уборка мелочей: Сториз (2)')
    const task = await p.apiFactory().getTask({ task_id: done.json.task.id })
    assert.equal(task.role, 'ios_engineer')
    assert.match(task.description, /Создано панелью владельца/)
    assert.equal(task.description.split('\n').filter((l) => l.startsWith('- [')).length, 2)
    const after = (await send(started, 'GET', '/api/backlog')).json
    assert.deepEqual(after.groups[0].cleanup?.id, done.json.task.id)
    const again = await send(started, 'POST', '/api/backlog/cleanup', { feature: 'Сториз', role: 'ios_engineer', expect: after.expect })
    assert.equal(again.status, 409)
    assert.match(again.json.reason, /уже заведена/)
    assert.equal(readFileSync(join(p.root, 'docs', 'backlog.md'), 'utf8'), before)
  } finally {
    p.cleanup()
  }
})

test('refused: a stale backlog, a group that is not there, a role nobody holds, and anything not from the panel page', async (t) => {
  const p = project()
  try {
    const started = await panel(t, p)
    if (!started) return
    const view = (await send(started, 'GET', '/api/backlog')).json
    const good = { feature: 'Бэкенд', role: 'backend_engineer', expect: view.expect }
    const cases = [
      ['stale', { ...good, expect: '0'.repeat(64) }, {}, 409],
      ['no such group', { ...good, feature: 'Нет такой' }, {}, 409],
      ['unknown role', { ...good, role: 'wizard' }, {}, 409],
      ['extra field', { ...good, title: 'x' }, {}, 400],
      ['foreign origin', good, { origin: 'http://127.0.0.1:1' }, 403],
      ['no fetch metadata', good, { 'sec-fetch-site': undefined }, 403],
      ['no token', good, { 'x-panel-token': undefined }, 403],
      ['a form', good, { 'content-type': 'text/plain' }, 415]
    ]
    for (const [name, body, over, status] of cases) {
      const res = await send(started, 'POST', '/api/backlog/cleanup', body, over)
      assert.equal(res.status, status, `${name}: ${res.text}`)
    }
    assert.equal((await p.apiFactory().listTasks({ open: true })).length, 0, 'nothing was created')
  } finally {
    p.cleanup()
  }
})

// Known limit: in one Node process the two requests below happen not to interleave between the "no open cleanup"
// check and the write, so removing the panel's queue (server.mjs createCleanup) does not make this test fail — the
// queue is kept as the defence, and this test pins only the outcome (verifier, 30.09.2026).
test('two requests for the same group at once create one task, not two', async (t) => {
  const p = project()
  try {
    const started = await panel(t, p)
    if (!started) return
    const view = (await send(started, 'GET', '/api/backlog')).json
    const body = { feature: 'Сториз', role: 'ios_engineer', expect: view.expect }
    const [a, b] = await Promise.all([send(started, 'POST', '/api/backlog/cleanup', body), send(started, 'POST', '/api/backlog/cleanup', body)])
    assert.deepEqual([a.status, b.status].sort(), [200, 409])
    const open = (await p.apiFactory().listTasks({ open: true })).filter((task) => task.title.startsWith('Уборка мелочей: Сториз'))
    assert.equal(open.length, 1)
  } finally {
    p.cleanup()
  }
})

test('a cleanup in review or blocked is still open; a known role nobody holds is refused', async (t) => {
  const p = project()
  try {
    const started = await panel(t, p)
    if (!started) return
    const view = (await send(started, 'GET', '/api/backlog')).json
    const done = await send(started, 'POST', '/api/backlog/cleanup', { feature: 'Сториз', role: 'ios_engineer', expect: view.expect })
    const writer = p.writeApiFactory()
    await writer.claimTask({ task_id: done.json.task.id })
    await writer.blockTask({ task_id: done.json.task.id, reason: 'Waiting for the owner to look at the list.' })
    const blocked = (await send(started, 'GET', '/api/backlog')).json
    assert.equal(blocked.groups[0].cleanup?.status, 'blocked')
    assert.equal((await send(started, 'POST', '/api/backlog/cleanup', { feature: 'Сториз', role: 'ios_engineer', expect: blocked.expect })).status, 409)
    // A role the registry knows but nobody holds here.
    const allRoles = Object.keys(writer.registry.roles())
    const vacant = allRoles.find((role) => !blocked.roles.includes(role))
    if (vacant) {
      const res = await send(started, 'POST', '/api/backlog/cleanup', { feature: 'Бэкенд', role: vacant, expect: blocked.expect })
      assert.equal(res.status, 409)
      assert.match(res.json.reason, /никто не держит/)
    }
  } finally {
    p.cleanup()
  }
})

test('a panel without the right to write shows the backlog but creates nothing', async (t) => {
  const p = project()
  try {
    const started = await panel(t, p, { allowWrite: false })
    if (!started) return
    const view = (await send(started, 'GET', '/api/backlog')).json
    assert.equal(view.writable, false)
    const res = await send(started, 'POST', '/api/backlog/cleanup', { feature: 'Бэкенд', role: 'backend_engineer', expect: view.expect })
    assert.equal(res.status, 403)
  } finally {
    p.cleanup()
  }
})
