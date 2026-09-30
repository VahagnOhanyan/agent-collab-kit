import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'

import { planComposition, writeComposition } from '../../collab/src/composition.mjs'
import { DEFAULT_CONFIG_DIR } from '../../collab/src/paths.mjs'
import { loadBuiltinAgents, loadConfigFrom } from '../../collab/src/registry.mjs'
import { tempDir } from '../../collab/test/helpers.mjs'
import { startPanel } from '../server.mjs'
import { inertApi } from '../test-helpers.mjs'

const TOKEN = '0123456789abcdef0123456789abcdef0123456789abcdef'

function machineWith({ lead = 'claude', singleVendor = false } = {}) {
  const dir = tempDir('panel-apply-')
  const planned = planComposition({
    catalog: loadBuiltinAgents(),
    roleDefs: loadConfigFrom().roles.roles,
    include: ['claude', 'codex'],
    lead,
    singleVendor
  })
  assert.ok(planned.ok, planned.reason)
  writeComposition(dir, planned.content, { catalogDir: DEFAULT_CONFIG_DIR })
  return dir
}

async function panel(t, machineDir, options = {}) {
  let started
  try {
    started = await startPanel({ token: TOKEN, apiFactory: inertApi, machineDir, allowWrite: true, ...options })
  } catch (error) {
    if (error?.code !== 'EPERM') throw error
    t.skip(`sandbox refused 127.0.0.1 listen: ${error.message}`)
    return null
  }
  t.after(() => started.close())
  return started
}

// A request the way the panel's own page sends it; `over` replaces or (with undefined) removes headers.
function send(started, method, path, body, over = {}) {
  const { port } = new URL(started.url)
  const payload = typeof body === 'string' ? body : JSON.stringify(body ?? {})
  const headers = {
    host: `127.0.0.1:${port}`,
    origin: `http://127.0.0.1:${port}`,
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
    'x-panel-token': TOKEN,
    'content-length': Buffer.byteLength(payload),
    ...over
  }
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

const read = (dir) => JSON.parse(readFileSync(join(dir, 'agents.json'), 'utf8'))
const expectOf = async (started) => (await send(started, 'GET', '/api/setup/detect')).json.current.machine.expect
const IDS = ['claude', 'codex']

test('apply changes the lead and only the lead: agents, roles and every other key stay as written', async (t) => {
  const dir = machineWith()
  const started = await panel(t, dir)
  if (!started) return
  const before = readFileSync(join(dir, 'agents.json'), 'utf8')
  const done = await send(started, 'POST', '/api/setup/apply', { agents: IDS, lead: 'codex', single_vendor: false, expect: await expectOf(started) })
  assert.equal(done.status, 200, done.text)
  assert.deepEqual(done.json.changes, [{ field: 'lead', from: 'claude', to: 'codex' }])
  const after = read(dir)
  assert.equal(after.lead, 'codex')
  assert.deepEqual({ ...after, lead: 'claude' }, JSON.parse(before), 'nothing but the lead moved')
  assert.equal(readFileSync(join(dir, 'agents.json.prev'), 'utf8'), before, 'the previous composition is kept')
})

test('apply switches the review mode to single_vendor and back', async (t) => {
  const dir = machineWith()
  const started = await panel(t, dir)
  if (!started) return
  const first = await send(started, 'POST', '/api/setup/apply', { agents: IDS, lead: 'claude', single_vendor: true, expect: await expectOf(started) })
  assert.equal(first.status, 200, first.text)
  assert.equal(read(dir).review_mode, 'single_vendor')
  const back = await send(started, 'POST', '/api/setup/apply', { agents: IDS, lead: 'claude', single_vendor: false, expect: first.json.expect })
  assert.equal(back.status, 200, back.text)
  assert.equal(read(dir).review_mode, 'cross_vendor')
})

test('an apply that changes nothing writes nothing', async (t) => {
  const dir = machineWith()
  const started = await panel(t, dir)
  if (!started) return
  const done = await send(started, 'POST', '/api/setup/apply', { agents: IDS, lead: 'claude', single_vendor: false, expect: await expectOf(started) })
  assert.equal(done.status, 200)
  assert.equal(done.json.changed, false)
  assert.equal(existsSync(join(dir, 'agents.json.prev')), false)
})

test('the preview names what an apply would change, before anything is written', async (t) => {
  const dir = machineWith()
  const started = await panel(t, dir)
  if (!started) return
  const before = readFileSync(join(dir, 'agents.json'), 'utf8')
  const preview = await send(started, 'GET', '/api/setup/preview?agents=claude,codex&lead=codex&single_vendor=1')
  assert.equal(preview.json.apply.available, true)
  assert.deepEqual(preview.json.apply.changes.map((c) => c.field).sort(), ['lead', 'review_mode'])
  assert.equal(JSON.stringify(preview.json).includes('_next'), false, 'internals do not leave the server')
  assert.equal(readFileSync(join(dir, 'agents.json'), 'utf8'), before)
})

const revertExpect = async (started) => (await send(started, 'GET', '/api/setup/preview?agents=claude,codex&lead=codex&single_vendor=0')).json.apply.revert.expect

test('revert brings the previous lead and review mode back, and shows what it will return first', async (t) => {
  const dir = machineWith()
  const started = await panel(t, dir)
  if (!started) return
  const before = readFileSync(join(dir, 'agents.json'), 'utf8')
  await send(started, 'POST', '/api/setup/apply', { agents: IDS, lead: 'codex', single_vendor: true, expect: await expectOf(started) })
  const preview = (await send(started, 'GET', '/api/setup/preview?agents=claude,codex&lead=codex&single_vendor=1')).json.apply.revert
  assert.deepEqual(preview.changes.map((c) => c.field).sort(), ['lead', 'review_mode'])
  assert.equal(JSON.stringify(preview).includes('_next'), false)
  const undone = await send(started, 'POST', '/api/setup/revert', { expect: preview.expect })
  assert.equal(undone.status, 200, undone.text)
  assert.equal(readFileSync(join(dir, 'agents.json'), 'utf8'), before)
})

test('revert with nothing to return, without a fingerprint or with a stale one is refused', async (t) => {
  const dir = machineWith()
  const started = await panel(t, dir)
  if (!started) return
  assert.equal((await send(started, 'POST', '/api/setup/revert', { expect: 'x' })).status, 409, 'no saved composition')
  await send(started, 'POST', '/api/setup/apply', { agents: IDS, lead: 'codex', single_vendor: false, expect: await expectOf(started) })
  const now = readFileSync(join(dir, 'agents.json'), 'utf8')
  assert.equal((await send(started, 'POST', '/api/setup/revert', {})).status, 400)
  assert.equal((await send(started, 'POST', '/api/setup/revert', { expect: '0'.repeat(64) })).status, 409)
  assert.equal(readFileSync(join(dir, 'agents.json'), 'utf8'), now)
})

test('revert never puts back agents or roles: a composition the owner re-set in the terminal stays', async (t) => {
  const dir = machineWith()
  const started = await panel(t, dir)
  if (!started) return
  await send(started, 'POST', '/api/setup/apply', { agents: IDS, lead: 'codex', single_vendor: false, expect: await expectOf(started) })
  // The owner runs `collab setup` in a terminal: the roles of an agent change and the saved copy is left behind.
  const reset = read(dir)
  reset.agents[0].roles = ['code_reviewer']
  writeFileSync(join(dir, 'agents.json'), `${JSON.stringify(reset, null, 2)}\n`)
  const info = (await send(started, 'GET', '/api/setup/preview?agents=claude,codex&lead=codex&single_vendor=0')).json.apply.revert
  assert.equal(info.available, false)
  const undone = await send(started, 'POST', '/api/setup/revert', { expect: await expectOf(started) })
  assert.equal(undone.status, 409)
  assert.deepEqual(read(dir).agents[0].roles, ['code_reviewer'])
})

test('a write that blows up halfway is answered, not fatal, and both files are put back', async (t) => {
  const dir = machineWith()
  const started = await panel(t, dir)
  if (!started) return
  const before = readFileSync(join(dir, 'agents.json'), 'utf8')
  const expect = await expectOf(started)
  writeFileSync(join(dir, 'roles.json'), '{ this is not json')
  const applied = await send(started, 'POST', '/api/setup/apply', { agents: IDS, lead: 'codex', single_vendor: false, expect })
  assert.equal(applied.status, 409, applied.text)
  assert.equal(readFileSync(join(dir, 'agents.json'), 'utf8'), before)
  assert.equal(existsSync(join(dir, 'agents.json.prev')), false, 'no saved copy is left claiming a change that did not happen')
  assert.equal((await send(started, 'GET', '/api/setup/detect')).status, 200, 'the panel is still alive')
})

test('a broken registry during a revert leaves the current composition and its saved copy as they were', async (t) => {
  const dir = machineWith()
  const started = await panel(t, dir)
  if (!started) return
  await send(started, 'POST', '/api/setup/apply', { agents: IDS, lead: 'codex', single_vendor: false, expect: await expectOf(started) })
  const current = readFileSync(join(dir, 'agents.json'), 'utf8')
  const saved = readFileSync(join(dir, 'agents.json.prev'), 'utf8')
  const expect = await revertExpect(started)
  writeFileSync(join(dir, 'roles.json'), '{ this is not json')
  const undone = await send(started, 'POST', '/api/setup/revert', { expect })
  assert.equal(undone.status, 409, undone.text)
  assert.equal(readFileSync(join(dir, 'agents.json'), 'utf8'), current)
  assert.equal(readFileSync(join(dir, 'agents.json.prev'), 'utf8'), saved)
})

test('one string that joins two agent ids does not pass for the set of agents', async (t) => {
  const dir = machineWith()
  const started = await panel(t, dir)
  if (!started) return
  const res = await send(started, 'POST', '/api/setup/apply', { agents: ['claude,codex'], lead: 'codex', single_vendor: false, expect: await expectOf(started) })
  assert.equal(res.status, 409)
})

test('every way of getting a write past the panel is refused and leaves the file alone', async (t) => {
  const dir = machineWith()
  const started = await panel(t, dir)
  if (!started) return
  const before = readFileSync(join(dir, 'agents.json'), 'utf8')
  const good = { agents: IDS, lead: 'codex', single_vendor: false, expect: await expectOf(started) }
  const cases = [
    ['no fetch metadata (curl)', good, { 'sec-fetch-site': undefined }, 403],
    ['a typed address', good, { 'sec-fetch-site': 'none' }, 403],
    ['another site', good, { 'sec-fetch-site': 'cross-site' }, 403],
    ['another local port', good, { 'sec-fetch-site': 'same-site' }, 403],
    ['a foreign Origin', good, { origin: 'http://127.0.0.1:1' }, 403],
    ['no Origin', good, { origin: undefined }, 403],
    ['no token', good, { 'x-panel-token': undefined }, 403],
    ['a wrong token', good, { 'x-panel-token': 'x'.repeat(48) }, 403],
    ['a form content type', good, { 'content-type': 'application/x-www-form-urlencoded' }, 415],
    ['plain text', good, { 'content-type': 'text/plain' }, 415],
    ['a foreign Host', good, { host: 'evil.example' }, 403],
    ['an unknown field', { ...good, roles: ['x'] }, {}, 400],
    ['a missing field', { agents: IDS, lead: 'codex' }, {}, 400],
    ['a string instead of a boolean', { ...good, single_vendor: 'true' }, {}, 400],
    ['not JSON', '{nope', {}, 400],
    ['a JSON array', '[]', {}, 400],
    ['an oversized body', { ...good, lead: 'a'.repeat(5000) }, {}, 413],
    ['a lead that is not an agent', { ...good, lead: 'gemini' }, {}, 409],
    ['another set of agents', { ...good, agents: ['claude'] }, {}, 409],
    ['a stale fingerprint', { ...good, expect: '0'.repeat(64) }, {}, 409]
  ]
  for (const [name, body, over, status] of cases) {
    const res = await send(started, 'POST', '/api/setup/apply', body, over)
    assert.equal(res.status, status, `${name}: ${res.text}`)
  }
  assert.equal(readFileSync(join(dir, 'agents.json'), 'utf8'), before)
  assert.equal(existsSync(join(dir, 'agents.json.prev')), false)
})

test('a panel started without the right to write refuses every write', async (t) => {
  const dir = machineWith()
  const started = await panel(t, dir, { allowWrite: false })
  if (!started) return
  const res = await send(started, 'POST', '/api/setup/apply', { agents: IDS, lead: 'codex', single_vendor: false, expect: 'x' })
  assert.equal(res.status, 403)
  assert.equal(res.json.error.code, 'READ_ONLY')
  assert.equal((await send(started, 'POST', '/api/setup/revert', { expect: 'x' })).status, 403)
  assert.equal((await send(started, 'GET', '/api/setup/detect')).json.writable, false)
})

const emptyMachine = () => join(tempDir('panel-first-'), 'machine')

test('first setup: with nothing recorded the panel writes what `collab setup` would, and says so before', async (t) => {
  const dir = emptyMachine()
  const started = await panel(t, dir)
  if (!started) return
  const preview = (await send(started, 'GET', '/api/setup/preview?agents=claude,codex&lead=codex&single_vendor=0')).json.apply
  assert.equal(preview.first_setup, true)
  assert.equal(preview.expect, 'none')
  assert.deepEqual(preview.changes.map((c) => c.field), ['agents', 'lead', 'review_mode'])
  assert.equal(JSON.stringify(preview).includes('_init'), false)
  assert.equal(existsSync(join(dir, 'agents.json')), false, 'a preview writes nothing')

  const done = await send(started, 'POST', '/api/setup/apply', { agents: IDS, lead: 'codex', single_vendor: false, expect: 'none' })
  assert.equal(done.status, 200, done.text)
  const expected = planComposition({ catalog: loadBuiltinAgents(), roleDefs: loadConfigFrom().roles.roles, include: IDS, lead: 'codex' }).content
  assert.deepEqual(read(dir), expected, 'exactly the composition collab setup would write')
  assert.equal(existsSync(join(dir, 'agents.json.prev')), false)
  for (const agent of expected.agents) if (agent.briefing_file) assert.ok(existsSync(join(dir, agent.briefing_file)), agent.briefing_file)
})

test('first setup honours the review mode and only takes agents from the catalog', async (t) => {
  const dir = emptyMachine()
  const started = await panel(t, dir)
  if (!started) return
  const unknown = await send(started, 'POST', '/api/setup/apply', { agents: ['claude', 'nobody'], lead: 'claude', single_vendor: false, expect: 'none' })
  assert.equal(unknown.status, 409)
  const noLead = await send(started, 'POST', '/api/setup/apply', { agents: IDS, lead: 'gemini', single_vendor: false, expect: 'none' })
  assert.equal(noLead.status, 409)
  assert.equal(existsSync(join(dir, 'agents.json')), false)
  const single = await send(started, 'POST', '/api/setup/apply', { agents: IDS, lead: 'claude', single_vendor: true, expect: 'none' })
  assert.equal(single.status, 200, single.text)
  assert.equal(read(dir).review_mode, 'single_vendor')
})

test('first setup is refused when a file appeared meanwhile or with any other fingerprint', async (t) => {
  const dir = emptyMachine()
  const started = await panel(t, dir)
  if (!started) return
  const wrong = await send(started, 'POST', '/api/setup/apply', { agents: IDS, lead: 'claude', single_vendor: false, expect: 'x' })
  assert.equal(wrong.status, 409)
  assert.equal(existsSync(join(dir, 'agents.json')), false)
  const ok = await send(started, 'POST', '/api/setup/apply', { agents: IDS, lead: 'claude', single_vendor: false, expect: 'none' })
  assert.equal(ok.status, 200)
  const before = readFileSync(join(dir, 'agents.json'), 'utf8')
  // The owner's tab still holds "nothing is recorded": it must not overwrite what is there now.
  const again = await send(started, 'POST', '/api/setup/apply', { agents: IDS, lead: 'codex', single_vendor: false, expect: 'none' })
  assert.equal(again.status, 409)
  assert.equal(readFileSync(join(dir, 'agents.json'), 'utf8'), before)
})

test('a first setup the registry finds problems with is taken back, not left half-written', async (t) => {
  const dir = emptyMachine()
  mkdirSync(dir, { recursive: true })
  // Valid JSON that names no roles: the composition then holds roles the registry does not know.
  writeFileSync(join(dir, 'roles.json'), JSON.stringify({ roles: {} }))
  const started = await panel(t, dir)
  if (!started) return
  const res = await send(started, 'POST', '/api/setup/apply', { agents: IDS, lead: 'claude', single_vendor: false, expect: 'none' })
  assert.equal(res.status, 409, res.text)
  assert.match(res.json.reason, /не прошёл проверку/)
  assert.equal(existsSync(join(dir, 'agents.json')), false)
})

test('a first setup the registry rejects leaves nothing behind', async (t) => {
  const dir = emptyMachine()
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'roles.json'), '{ this is not json')
  const started = await panel(t, dir)
  if (!started) return
  const res = await send(started, 'POST', '/api/setup/apply', { agents: IDS, lead: 'claude', single_vendor: false, expect: 'none' })
  assert.equal(res.status, 409, res.text)
  assert.equal(existsSync(join(dir, 'agents.json')), false)
  assert.equal(existsSync(join(dir, 'briefings')) && readdirSync(join(dir, 'briefings')).length > 0, false, 'copied briefings are removed too')
  assert.equal((await send(started, 'GET', '/api/setup/detect')).status, 200)
})

test('only the two write paths take a POST; everything else stays GET and HEAD', async (t) => {
  const started = await panel(t, machineWith())
  if (!started) return
  for (const path of ['/api/overview', '/api/kit', '/api/setup/detect', '/api/setup/preview', '/api/setup/apply/x']) {
    assert.equal((await send(started, 'POST', path, {})).status, 405, path)
  }
  assert.equal((await send(started, 'PUT', '/api/setup/apply', {})).status, 405)
})

test('a composition the registry rejects after the write is put back as it was', async (t) => {
  const dir = machineWith()
  const file = join(dir, 'agents.json')
  const broken = read(dir)
  broken.agents[0].roles = ['no_such_role_exists']
  writeFileSync(file, `${JSON.stringify(broken, null, 2)}\n`)
  const before = readFileSync(file, 'utf8')
  const started = await panel(t, dir)
  if (!started) return
  const res = await send(started, 'POST', '/api/setup/apply', { agents: IDS, lead: 'codex', single_vendor: false, expect: await expectOf(started) })
  assert.equal(res.status, 409, res.text)
  assert.equal(readFileSync(file, 'utf8'), before)
})
