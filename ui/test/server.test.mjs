import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { createApi } from '../../collab/src/api.mjs'
import { CollabError } from '../../collab/src/errors.mjs'
import { sandbox, tempDir } from '../../collab/test/helpers.mjs'
import { startPanel } from '../server.mjs'
import { get, inertApi } from '../test-helpers.mjs'

const TOKEN = '0123456789abcdef0123456789abcdef0123456789abcdef'

async function panel(t, options = {}) {
  let started
  try {
    started = await startPanel({ token: TOKEN, apiFactory: inertApi, ...options })
  } catch (error) {
    if (error?.code !== 'EPERM') throw error
    t.skip(`sandbox refused 127.0.0.1 listen: ${error.message}`)
    return null
  }
  t.after(() => started.close())
  return started
}

function digest(root) {
  const hash = createHash('sha256')
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const file = join(dir, name)
      const stat = statSync(file)
      hash.update(relative(root, file))
      if (stat.isDirectory()) visit(file)
      else hash.update(readFileSync(file))
    }
  }
  visit(root)
  return hash.digest('hex')
}

test('M1 rejects a foreign Host header', async (t) => {
  const started = await panel(t)
  if (!started) return
  const response = await get(started, '/', { host: 'evil.example', token: TOKEN })
  assert.equal(response.status, 403)
  assert.equal(response.json().error.code, 'FORBIDDEN_HOST')
})

test('M2 listens only on 127.0.0.1', async (t) => {
  const started = await panel(t)
  if (!started) return
  assert.equal(started.server.address().address, '127.0.0.1')
})

test('M3 rejects a request without a token and establishes a strict cookie with one', async (t) => {
  const started = await panel(t)
  if (!started) return
  assert.equal((await get(started, '/')).status, 403)
  const response = await get(started, `/?t=${TOKEN}`)
  assert.equal(response.status, 200)
  assert.match(response.headers['set-cookie'][0], /HttpOnly; SameSite=Strict; Path=\/$/)
})

test('M4 rejects literal and encoded static traversal', async (t) => {
  const started = await panel(t)
  if (!started) return
  // ui/server.mjs really exists one level above ui/public, so a guard that is
  // missing serves it (200) instead of failing to find a file (404): the old
  // targets under etc/ did not exist and answered 404 with or without a guard.
  for (const path of ['/../server.mjs', '/%2e%2e/server.mjs', '/..%2fserver.mjs', '/..\\server.mjs', '/public/../server.mjs']) {
    const response = await get(started, path, { token: TOKEN })
    assert.equal(response.status, 404, path)
    assert.doesNotMatch(response.text, /startPanel/, path)
  }
  // Positive control: the same route serves a real file inside public.
  assert.equal((await get(started, '/style.css', { token: TOKEN })).status, 200)
})

test('M6 API responses redact the token, environment values and home paths', async (t) => {
  const sentinel = 'panel-secret-environment-value'
  const previous = process.env.PANEL_TEST_SECRET
  process.env.PANEL_TEST_SECRET = sentinel
  t.after(() => previous === undefined ? delete process.env.PANEL_TEST_SECRET : process.env.PANEL_TEST_SECRET = previous)
  const leaking = inertApi()
  leaking.status = async () => ({ journal_root: `${process.env.HOME}/my-app`, token: TOKEN, leaked: sentinel })
  const started = await panel(t, { apiFactory: () => leaking })
  if (!started) return
  const response = await get(started, '/api/overview', { token: TOKEN })
  assert.equal(response.status, 200)
  assert.doesNotMatch(response.text, new RegExp(TOKEN))
  assert.doesNotMatch(response.text, new RegExp(sentinel))
  if (process.env.HOME) assert.doesNotMatch(response.text, new RegExp(process.env.HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('M7 SSE waits for the newline before publishing a half-written event', async (t) => {
  const root = tempDir('panel-stream-')
  const state = join(root, '.collab')
  mkdirSync(state)
  const events = join(state, 'events.jsonl')
  writeFileSync(events, '')
  const api = inertApi()
  api.store.paths.events = events
  const started = await panel(t, { apiFactory: () => api })
  if (!started) return
  const address = started.server.address()
  const { request } = await import('node:http')

  let text = ''
  const response = await new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: address.port, path: '/api/stream', headers: { Host: `127.0.0.1:${address.port}`, 'x-panel-token': TOKEN } }, resolve)
    req.on('error', reject)
    req.end()
  })
  response.on('data', (chunk) => { text += chunk.toString('utf8') })
  await new Promise((resolve) => setTimeout(resolve, 20))
  appendFileSync(events, '{"type":"task.created"}')
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.doesNotMatch(text, /data:/)
  appendFileSync(events, '\n')
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('SSE event was not delivered')), 1000)
    const poll = setInterval(() => {
      if (!text.includes('data:')) return
      clearInterval(poll)
      clearTimeout(timeout)
      resolve()
    }, 10)
  })
  assert.match(text, /data: \{"type":"task\.created"\}/)
  response.destroy()
})

test('M6b SSE events are scrubbed like every other body', async (t) => {
  const sentinel = 'panel-stream-secret-value'
  const previous = process.env.PANEL_TEST_STREAM_SECRET
  process.env.PANEL_TEST_STREAM_SECRET = sentinel
  t.after(() => previous === undefined ? delete process.env.PANEL_TEST_STREAM_SECRET : process.env.PANEL_TEST_STREAM_SECRET = previous)
  const root = tempDir('panel-stream-scrub-')
  const state = join(root, '.collab')
  mkdirSync(state)
  const events = join(state, 'events.jsonl')
  writeFileSync(events, '')
  const api = inertApi()
  api.store.paths.events = events
  const started = await panel(t, { apiFactory: () => api })
  if (!started) return
  const address = started.server.address()
  const { request } = await import('node:http')
  let text = ''
  const response = await new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: address.port, path: '/api/stream', headers: { Host: `127.0.0.1:${address.port}`, 'x-panel-token': TOKEN } }, resolve)
    req.on('error', reject)
    req.end()
  })
  response.on('data', (chunk) => { text += chunk.toString('utf8') })
  await new Promise((resolve) => setTimeout(resolve, 20))
  appendFileSync(events, `${JSON.stringify({ type: 'task.files_claimed', data: { file: `${process.env.HOME}/my-app/a.js`, note: sentinel, token: TOKEN } })}\n`)
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('SSE event was not delivered')), 1000)
    const poll = setInterval(() => {
      if (!text.includes('data:')) return
      clearInterval(poll)
      clearTimeout(timeout)
      resolve()
    }, 10)
  })
  response.destroy()
  assert.match(text, /task\.files_claimed/, 'the event itself is delivered')
  assert.doesNotMatch(text, new RegExp(sentinel))
  assert.doesNotMatch(text, new RegExp(TOKEN))
  assert.match(text, /~\/my-app\/a\.js/, 'the home directory is shortened, not dropped')
})

test('M8 GET routes leave the journal byte-for-byte unchanged', async (t) => {
  const sbx = sandbox()
  t.after(sbx.cleanup)
  const writer = createApi({ agentId: 'claude', roots: sbx.roots, configDir: sbx.configDir })
  const task = await writer.createTask({ title: '<img onerror=alert(1)>', description: 'Untrusted task text.', role: 'software_engineer' })
  const factory = () => createApi({ agentId: 'claude', roots: sbx.roots, configDir: sbx.configDir, readOnly: true })
  const started = await panel(t, { apiFactory: factory, cwd: sbx.root, registryDir: sbx.options.registryDir })
  if (!started) return
  const before = digest(sbx.stateDir)
  for (const path of ['/api/overview', '/api/tasks', `/api/tasks/${task.id}`, '/api/waiting', '/api/events?limit=500', '/api/roster', '/api/setup/check']) {
    const response = await get(started, path, { token: TOKEN })
    assert.equal(response.status, 200, `${path}: ${response.text}`)
  }
  assert.equal(digest(sbx.stateDir), before)
})

test('missing, empty, corrupt and half-written journals return structured responses', async (t) => {
  const missing = await panel(t, { apiFactory: () => { throw new CollabError('NOT_INITIALIZED', 'no journal') }, cwd: '/tmp/my-app' })
  if (!missing) return
  const absent = await get(missing, '/api/overview', { token: TOKEN })
  assert.deepEqual(absent.json(), { initialized: false, hint: { command: 'collab init', run_in: '/tmp/my-app' } })

  const sbx = sandbox()
  t.after(sbx.cleanup)
  const events = join(sbx.stateDir, 'events.jsonl')
  const factory = () => createApi({ agentId: 'claude', roots: sbx.roots, configDir: sbx.configDir, readOnly: true })
  const started = await panel(t, { apiFactory: factory })
  if (!started) return
  assert.deepEqual((await get(started, '/api/events', { token: TOKEN })).json(), [])
  writeFileSync(events, '{broken}\n{"half":')
  const broken = await get(started, '/api/events', { token: TOKEN })
  assert.equal(broken.status, 200)
  assert.equal(broken.json().length, 2)
  assert.ok(broken.json().every((event) => event.type === 'log.unparseable'))
})

test('doctor failure is a structured error rather than a server crash', async (t) => {
  const api = inertApi()
  api.doctor = () => { throw new Error('doctor unavailable') }
  const started = await panel(t, { apiFactory: () => api })
  if (!started) return
  const response = await get(started, '/api/setup/check', { token: TOKEN })
  assert.equal(response.status, 500)
  assert.deepEqual(response.json(), { error: { code: 'INTERNAL_ERROR', message: 'doctor unavailable' } })
  assert.equal((await get(started, '/', { token: TOKEN })).status, 200)
})

test('unknown tasks are 404 and responses carry the security headers without CORS', async (t) => {
  const api = inertApi()
  api.getTask = () => { throw new CollabError('NOT_FOUND', 'no task') }
  const started = await panel(t, { apiFactory: () => api })
  if (!started) return
  const response = await get(started, '/api/tasks/tsk_missing', { token: TOKEN })
  assert.equal(response.status, 404)
  assert.equal(response.headers['access-control-allow-origin'], undefined)
  assert.equal(response.headers['x-content-type-options'], 'nosniff')
  assert.equal(response.headers['referrer-policy'], 'no-referrer')
  assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/)
})
