// The panel's owner write on tasks: closing (one or a batch) and reopening — only from a panel that may write, only
// from the page itself, a reason required, and the answer says why when it refuses.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'

import { createApi } from '../../collab/src/api.mjs'
import { gitRepo, initialisedJournal, tempDir, writeJson } from '../../collab/test/helpers.mjs'
import { startPanel } from '../server.mjs'

const TOKEN = '0123456789abcdef0123456789abcdef0123456789abcdef'
const machine = () => ({ home: '/nowhere', platform: 'darwin', which: (b) => `/usr/bin/${b}`, exists: () => false, read: () => null })

function project() {
  const base = tempDir('panel-owner-')
  const root = gitRepo(join(base, 'repo'))
  initialisedJournal(join(root, '.collab'))
  mkdirSync(join(base, 'registry', 'demo'), { recursive: true })
  const registryDir = join(base, 'registry')
  writeJson(join(registryDir, 'demo', 'project.json'), { id: 'demo', roots: [root] })
  const options = { cwd: root, registryDir, machineDir: join(base, 'no-machine'), probeEnv: machine() }
  return {
    root,
    registryDir,
    agent: () => createApi({ agentId: 'claude', ...options }),
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

test('the owner closes a batch and reopens one through the panel; a reason is required', async (t) => {
  const p = project()
  try {
    const started = await panel(t, p)
    if (!started) return
    assert.deepEqual((await send(started, 'GET', '/api/panel')).json, { writable: true })
    const api = p.agent()
    const a = await api.createTask({ title: 'Old idea number one', action: 'edit a file' })
    const b = await api.createTask({ title: 'Old idea number two', action: 'edit a file' })

    const noReason = await send(started, 'POST', '/api/tasks/close', { task_ids: [a.id, b.id], outcome: 'cancelled', reason: ' ' })
    assert.equal(noReason.status, 409)
    assert.match(noReason.json.reason, /reason is required/)
    const extra = await send(started, 'POST', '/api/tasks/close', { task_ids: [a.id], outcome: 'cancelled', reason: 'x', force: true })
    assert.equal(extra.status, 400)

    const closed = await send(started, 'POST', '/api/tasks/close', { task_ids: [a.id, b.id], outcome: 'cancelled', reason: 'nobody needs these' })
    assert.equal(closed.status, 200, closed.text)
    assert.deepEqual(closed.json.closed.map((c) => c.status), ['cancelled', 'cancelled'])
    assert.equal(p.agent().getTask({ task_id: a.id }).closed_by_owner.reason, 'nobody needs these')

    const reopened = await send(started, 'POST', '/api/tasks/reopen', { task_id: a.id, reason: 'needed after all' })
    assert.equal(reopened.status, 200, reopened.text)
    assert.equal(p.agent().getTask({ task_id: a.id }).status, 'created')
    const twice = await send(started, 'POST', '/api/tasks/reopen', { task_id: a.id, reason: 'again' })
    assert.equal(twice.status, 409)
  } finally {
    p.cleanup()
  }
})

test('a panel without the right to write, or a request not from its page, changes nothing', async (t) => {
  const p = project()
  try {
    const task = await p.agent().createTask({ title: 'Something to keep', action: 'edit a file' })
    const readOnly = await panel(t, p, { allowWrite: false })
    if (!readOnly) return
    assert.deepEqual((await send(readOnly, 'GET', '/api/panel')).json, { writable: false })
    const refused = await send(readOnly, 'POST', '/api/tasks/close', { task_ids: [task.id], outcome: 'cancelled', reason: 'x' })
    assert.equal(refused.status, 403)

    const writable = await panel(t, p)
    const foreign = await send(writable, 'POST', '/api/tasks/close', { task_ids: [task.id], outcome: 'cancelled', reason: 'x' }, { 'sec-fetch-site': 'cross-site' })
    assert.equal(foreign.status, 403)
    assert.equal(p.agent().getTask({ task_id: task.id }).status, 'created', 'nothing changed')
  } finally {
    p.cleanup()
  }
})
