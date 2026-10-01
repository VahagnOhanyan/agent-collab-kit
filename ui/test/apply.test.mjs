import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
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
  // Every agent is proposed every role; this owner took two away — backend_engineer from codex, and
  // security_reviewer from everybody (so it is a vacant role) — which the tests below add back or rely on.
  const content = {
    ...planned.content,
    agents: planned.content.agents.map((agent) => ({
      ...agent,
      roles: agent.roles.filter((role) => role !== 'security_reviewer' && !(agent.id === 'codex' && role === 'backend_engineer'))
    }))
  }
  writeComposition(dir, content, { catalogDir: DEFAULT_CONFIG_DIR })
  return dir
}

// The machine the panel's facts describe (collab/src/probe.mjs): both agents installed, a simulator toolchain, no
// configuration read — so no test depends on the owner's own ~/.codex or ~/.claude.json.
const machineFacts = ({ files = {} } = {}) => ({
  home: '/nowhere',
  platform: 'darwin',
  which: (binary) => `/usr/bin/${binary}`,
  exists: (file) => file === '/Applications/Xcode.app' || Object.hasOwn(files, file),
  read: (file) => (Object.hasOwn(files, file) ? files[file] : null)
})
const READ_ONLY_CODEX = { '/nowhere/.codex/config.toml': 'sandbox_mode = "read-only"\n' }

async function panel(t, machineDir, options = {}) {
  let started
  try {
    started = await startPanel({ token: TOKEN, apiFactory: inertApi, machineDir, allowWrite: true, probeEnv: machineFacts(), ...options })
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

const rolesOf = (dir) => Object.fromEntries(read(dir).agents.map((a) => [a.id, a.roles]))

test('roles: the panel changes an agent\'s roles and nothing else about it, and shows the change first', async (t) => {
  const dir = machineWith()
  const started = await panel(t, dir)
  if (!started) return
  const before = read(dir)
  const roles = { ...rolesOf(dir), codex: [...rolesOf(dir).codex, 'backend_engineer'] }
  const preview = (await send(started, 'GET', `/api/setup/preview?agents=claude,codex&lead=claude&single_vendor=0&roles=${encodeURIComponent(JSON.stringify(roles))}`)).json.apply
  assert.equal(preview.available, true, preview.reason)
  assert.deepEqual(preview.changes, [{ field: 'roles', agent: 'codex', from: before.agents[1].roles, to: roles.codex }])
  assert.ok(preview.holdable.codex.includes('backend_engineer'))
  const done = await send(started, 'POST', '/api/setup/apply', { agents: IDS, lead: 'claude', single_vendor: false, roles, expect: await expectOf(started) })
  assert.equal(done.status, 200, done.text)
  const after = read(dir)
  assert.deepEqual(after.agents[1].roles, roles.codex)
  assert.deepEqual({ ...after, agents: after.agents.map(({ roles: _r, ...rest }) => rest) }, { ...before, agents: before.agents.map(({ roles: _r, ...rest }) => rest) })
})

test('roles: revert gives the previous roles back', async (t) => {
  const dir = machineWith()
  const started = await panel(t, dir)
  if (!started) return
  const original = rolesOf(dir)
  const roles = { ...original, codex: [...original.codex, 'backend_engineer'] }
  await send(started, 'POST', '/api/setup/apply', { agents: IDS, lead: 'claude', single_vendor: false, roles, expect: await expectOf(started) })
  const info = (await send(started, 'GET', '/api/setup/preview?agents=claude,codex&lead=claude&single_vendor=0')).json.apply.revert
  assert.equal(info.available, true, info.reason)
  assert.equal((await send(started, 'POST', '/api/setup/revert', { expect: info.expect })).status, 200)
  assert.deepEqual(rolesOf(dir), original)
})

test('roles: an unknown role, a role beyond the agent\'s capabilities, and roles for other agents are refused', async (t) => {
  const dir = machineWith()
  // This machine's codex cannot record decisions: architect needs that.
  const content = read(dir)
  content.agents = content.agents.map((a) => (a.id === 'codex'
    ? { ...a, capabilities: a.capabilities.filter((c) => c !== 'record_decision'), roles: a.roles.filter((r) => r !== 'architect') }
    : a))
  writeFileSync(join(dir, 'agents.json'), `${JSON.stringify(content, null, 2)}\n`)
  const started = await panel(t, dir)
  if (!started) return
  const before = readFileSync(join(dir, 'agents.json'), 'utf8')
  const expect = await expectOf(started)
  const base = rolesOf(dir)
  const cases = [
    ['unknown role', { ...base, codex: [...base.codex, 'wizard'] }, /нет в реестре/],
    ['beyond capabilities', { ...base, codex: [...base.codex, 'architect'] }, /не хватает способностей/],
    ['other agents', { claude: base.claude, gemini: [] }, /не для тех агентов/],
    ['duplicated role', { ...base, codex: [...base.codex, base.codex[0]] }, /неверном виде/]
  ]
  for (const [name, roles, pattern] of cases) {
    const res = await send(started, 'POST', '/api/setup/apply', { agents: IDS, lead: 'claude', single_vendor: false, roles, expect })
    assert.equal(res.status, 409, `${name}: ${res.text}`)
    assert.match(res.json.reason, pattern, name)
  }
  assert.equal((await send(started, 'POST', '/api/setup/apply', { agents: IDS, lead: 'claude', single_vendor: false, roles: [], expect })).status, 400, 'roles as a list')
  assert.equal(readFileSync(join(dir, 'agents.json'), 'utf8'), before)
})

test('roles: a composition where the author is the only reviewer is refused with two vendors', async (t) => {
  const dir = machineWith()
  const started = await panel(t, dir)
  if (!started) return
  const before = readFileSync(join(dir, 'agents.json'), 'utf8')
  const base = rolesOf(dir)
  const roles = { ...base, codex: base.codex.filter((r) => r !== 'code_reviewer') }
  const preview = (await send(started, 'GET', `/api/setup/preview?agents=claude,codex&lead=claude&single_vendor=0&roles=${encodeURIComponent(JSON.stringify(roles))}`)).json.apply
  assert.equal(preview.available, false)
  assert.ok(preview.independence.problems.length > 0)
  const res = await send(started, 'POST', '/api/setup/apply', { agents: IDS, lead: 'claude', single_vendor: false, roles, expect: await expectOf(started) })
  assert.equal(res.status, 409)
  assert.match(res.json.reason, /некому будет проверить/)
  assert.equal(readFileSync(join(dir, 'agents.json'), 'utf8'), before)
})

test('roles: the gate reads the machine\'s own roles.json, the one the written file will run with', async (t) => {
  const dir = machineWith()
  const roles = structuredClone(loadConfigFrom().roles)
  // On this machine test_engineer work must be checked by a security_reviewer — nobody holds that role.
  roles.roles.test_engineer.reviewed_by = ['security_reviewer']
  writeFileSync(join(dir, 'roles.json'), `${JSON.stringify(roles, null, 2)}\n`)
  const started = await panel(t, dir)
  if (!started) return
  const before = readFileSync(join(dir, 'agents.json'), 'utf8')
  const res = await send(started, 'POST', '/api/setup/apply', { agents: IDS, lead: 'codex', single_vendor: false, expect: await expectOf(started) })
  assert.equal(res.status, 409, res.text)
  assert.match(res.json.reason, /test_engineer/)
  assert.equal(readFileSync(join(dir, 'agents.json'), 'utf8'), before)
})

test('roles: revert will not bring back a composition that breaks independence', async (t) => {
  const dir = machineWith()
  const started = await panel(t, dir)
  if (!started) return
  // The saved copy is one where only claude could review: written by the panel's own path, then made unreviewable
  // by a later change of the machine's roles.json (the definitions revert is checked against).
  await send(started, 'POST', '/api/setup/apply', { agents: IDS, lead: 'codex', single_vendor: false, expect: await expectOf(started) })
  const roles = structuredClone(loadConfigFrom().roles)
  roles.roles.ux_reviewer.reviewed_by = ['security_reviewer']
  writeFileSync(join(dir, 'roles.json'), `${JSON.stringify(roles, null, 2)}\n`)
  const now = readFileSync(join(dir, 'agents.json'), 'utf8')
  const info = (await send(started, 'GET', '/api/setup/preview?agents=claude,codex&lead=codex&single_vendor=0')).json.apply
  assert.equal(info.available, false, 'apply is refused too: the current composition is unreviewable under these roles')
  const res = await send(started, 'POST', '/api/setup/revert', { expect: await expectOf(started) })
  assert.equal(res.status, 409, res.text)
  assert.match(res.json.reason, /независимость/)
  assert.equal(readFileSync(join(dir, 'agents.json'), 'utf8'), now)
})

test('roles: with one vendor, a composition where nobody holds the reviewing role is refused', async (t) => {
  const dir = join(tempDir('panel-one-vendor-'), 'machine')
  const started = await panel(t, dir)
  if (!started) return
  const planned = (await send(started, 'GET', '/api/setup/preview?agents=claude&lead=claude&single_vendor=0')).json.apply.roles
  const roles = { claude: planned.claude.filter((r) => r !== 'code_reviewer') }
  const res = await send(started, 'POST', '/api/setup/apply', { agents: ['claude'], lead: 'claude', single_vendor: false, roles, expect: 'none' })
  assert.equal(res.status, 409, res.text)
  assert.equal(existsSync(join(dir, 'agents.json')), false)
  const ok = await send(started, 'POST', '/api/setup/apply', { agents: ['claude'], lead: 'claude', single_vendor: false, roles: planned, expect: 'none' })
  assert.equal(ok.status, 200, 'holding the reviewing role itself is the accepted one-vendor answer')
})

test('roles: revert refuses a saved copy that was changed outside the panel', async (t) => {
  const dir = machineWith()
  const started = await panel(t, dir)
  if (!started) return
  await send(started, 'POST', '/api/setup/apply', { agents: IDS, lead: 'codex', single_vendor: false, expect: await expectOf(started) })
  const saved = JSON.parse(readFileSync(join(dir, 'agents.json.prev'), 'utf8'))
  writeFileSync(join(dir, 'agents.json.prev'), `${JSON.stringify({ ...saved, review_mode: 'single_vendor' }, null, 2)}\n`)
  const now = readFileSync(join(dir, 'agents.json'), 'utf8')
  const info = (await send(started, 'GET', '/api/setup/preview?agents=claude,codex&lead=codex&single_vendor=0')).json.apply.revert
  assert.equal(info.available, false)
  assert.match(info.reason, /вне панели/)
  assert.equal((await send(started, 'POST', '/api/setup/revert', { expect: await expectOf(started) })).status, 409)
  assert.equal(readFileSync(join(dir, 'agents.json'), 'utf8'), now)
})

test('a write that fails AFTER both files were replaced puts back the composition and the saved copy', async (t) => {
  const dir = machineWith()
  const started = await panel(t, dir)
  if (!started) return
  // First apply: a saved copy and its mark exist.
  await send(started, 'POST', '/api/setup/apply', { agents: IDS, lead: 'codex', single_vendor: false, expect: await expectOf(started) })
  const current = readFileSync(join(dir, 'agents.json'), 'utf8')
  const saved = readFileSync(join(dir, 'agents.json.prev'), 'utf8')
  // The mark cannot be written now (a directory stands where it goes): the failure comes after agents.json and
  // agents.json.prev were already replaced, so restore is what has to put them back.
  rmSync(join(dir, 'agents.json.prev.after'))
  mkdirSync(join(dir, 'agents.json.prev.after'))
  const res = await send(started, 'POST', '/api/setup/apply', { agents: IDS, lead: 'claude', single_vendor: false, expect: await expectOf(started) })
  assert.equal(res.status, 409, res.text)
  assert.match(res.json.reason, /прежние файлы возвращены/)
  assert.equal(readFileSync(join(dir, 'agents.json'), 'utf8'), current)
  assert.equal(readFileSync(join(dir, 'agents.json.prev'), 'utf8'), saved)
})

test('facts: a role the machine rules out is shown with the reason and cannot be written', async (t) => {
  const dir = machineWith()
  const started = await panel(t, dir, { probeEnv: machineFacts({ files: READ_ONLY_CODEX }) })
  if (!started) return
  const before = readFileSync(join(dir, 'agents.json'), 'utf8')
  const preview = (await send(started, 'GET', '/api/setup/preview?agents=claude,codex&lead=claude&single_vendor=0')).json.apply
  assert.ok(!preview.holdable.codex.includes('software_engineer'))
  assert.match(preview.facts.codex.blocked.find((b) => b.role === 'software_engineer').reasons.join(), /read-only/)
  const roles = { ...rolesOf(dir), codex: ['software_engineer', 'code_reviewer'] }
  const res = await send(started, 'POST', '/api/setup/apply', { agents: IDS, lead: 'claude', single_vendor: false, roles, expect: await expectOf(started) })
  assert.equal(res.status, 409)
  assert.match(res.json.reason, /software_engineer \(.*read-only/)
  assert.equal(readFileSync(join(dir, 'agents.json'), 'utf8'), before)
})

test('facts: the first setup leaves out what the machine rules out and marks what it cannot confirm', async (t) => {
  const dir = join(tempDir('panel-facts-first-'), 'machine')
  // On this machine reviewing usability means running the application — which nothing can confirm.
  const roles = structuredClone(loadConfigFrom().roles)
  roles.roles.ux_reviewer.requires = [...roles.roles.ux_reviewer.requires, 'run_application']
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'roles.json'), `${JSON.stringify(roles, null, 2)}\n`)
  const agents = JSON.parse(readFileSync(join(DEFAULT_CONFIG_DIR, 'agents.json'), 'utf8'))
  const started = await panel(t, dir, { probeEnv: machineFacts({ files: READ_ONLY_CODEX }) })
  if (!started) return
  const preview = (await send(started, 'GET', '/api/setup/preview?agents=claude,codex&lead=claude&single_vendor=0')).json.apply
  assert.ok(!preview.roles.codex.includes('software_engineer'), 'read-only codex is not proposed to write')
  const done = await send(started, 'POST', '/api/setup/apply', { agents: IDS, lead: 'claude', single_vendor: false, roles: preview.roles, expect: 'none' })
  assert.equal(done.status, 200, done.text)
  const written = read(dir)
  const codex = written.agents.find((a) => a.id === 'codex')
  const claude = written.agents.find((a) => a.id === 'claude')
  assert.ok(!codex.roles.includes('software_engineer'), 'a read-only session is not given writing roles')
  assert.ok(codex.roles.includes('code_reviewer'), 'reviewing needs no writing')
  assert.ok(claude.roles.includes('software_engineer'), 'claude is not read-only')
  // ux_reviewer needs running the application here: claude may, as far as anything can tell — given, marked;
  // read-only codex cannot run anything — not given at all.
  assert.deepEqual(claude.unverified_roles, ['ux_reviewer'])
  assert.ok(!codex.roles.includes('ux_reviewer') && codex.unverified_roles === undefined)
  assert.equal(agents.agents.every((a) => a.roles === undefined), true, 'the catalog names no roles')
})

test('facts: a role kept on an unconfirmed capability is written with its mark', async (t) => {
  const dir = machineWith()
  const roles = structuredClone(loadConfigFrom().roles)
  roles.roles.ux_reviewer.requires = [...roles.roles.ux_reviewer.requires, 'run_application']
  writeFileSync(join(dir, 'roles.json'), `${JSON.stringify(roles, null, 2)}\n`)
  const started = await panel(t, dir)
  if (!started) return
  const current = rolesOf(dir)
  // The owner leaves usability reviews to claude alone; claude keeps ux_reviewer, now on an unconfirmed capability.
  const next = { claude: current.claude, codex: current.codex.filter((r) => r !== 'ux_reviewer') }
  const preview = (await send(started, 'GET', `/api/setup/preview?agents=claude,codex&lead=claude&single_vendor=0&roles=${encodeURIComponent(JSON.stringify(next))}`)).json.apply
  assert.ok(preview.facts.claude.unverified.includes('ux_reviewer'))
  const res = await send(started, 'POST', '/api/setup/apply', { agents: IDS, lead: 'claude', single_vendor: false, roles: next, expect: await expectOf(started) })
  assert.equal(res.status, 200, res.text)
  assert.deepEqual(read(dir).agents.find((a) => a.id === 'claude').unverified_roles, ['ux_reviewer'])
})

test('facts: revert does not bring back a role this machine now rules out', async (t) => {
  const dir = machineWith()
  const open = await panel(t, dir)
  if (!open) return
  // Codex gives up software_engineer through the panel: the saved copy still has it.
  const current = rolesOf(dir)
  const roles = { ...current, codex: current.codex.filter((r) => r !== 'software_engineer') }
  const done = await send(open, 'POST', '/api/setup/apply', { agents: IDS, lead: 'claude', single_vendor: false, roles, expect: await expectOf(open) })
  assert.equal(done.status, 200, done.text)
  const now = readFileSync(join(dir, 'agents.json'), 'utf8')
  // Then Codex's sessions become read-only: going back would hand it a role it cannot do here.
  const readOnly = await panel(t, dir, { probeEnv: machineFacts({ files: READ_ONLY_CODEX }) })
  const info = (await send(readOnly, 'GET', '/api/setup/preview?agents=claude,codex&lead=claude&single_vendor=0')).json.apply.revert
  assert.equal(info.available, false)
  assert.match(info.reason, /software_engineer \(.*read-only/)
  assert.equal((await send(readOnly, 'POST', '/api/setup/revert', { expect: await expectOf(readOnly) })).status, 409)
  assert.equal(readFileSync(join(dir, 'agents.json'), 'utf8'), now)
})

test('migration: roles an agent may hold but does not are offered, and nothing is added without a write', async (t) => {
  const dir = machineWith()
  const started = await panel(t, dir)
  if (!started) return
  const before = readFileSync(join(dir, 'agents.json'), 'utf8')
  const preview = (await send(started, 'GET', '/api/setup/preview?agents=claude,codex&lead=claude&single_vendor=0')).json.apply
  assert.deepEqual(preview.suggested.codex.sort(), ['backend_engineer', 'security_reviewer'])
  assert.deepEqual(preview.suggested.claude, ['security_reviewer'])
  assert.deepEqual(preview.changes, [], 'offering is not writing')
  assert.equal(readFileSync(join(dir, 'agents.json'), 'utf8'), before)
})

test('confirmed: the owner confirms running the application for claude — shown first, written, and it turns the capability confirmed', async (t) => {
  const dir = machineWith()
  const started = await panel(t, dir)
  if (!started) return
  const current = (await send(started, 'GET', '/api/setup/preview?agents=claude,codex&lead=claude&single_vendor=0')).json.apply
  assert.deepEqual(current.confirmed, { claude: [], codex: [] })
  assert.equal(current.facts.claude.capabilities.run_application.status, 'unknown')
  const confirmed = { claude: ['run_application'], codex: [] }
  const preview = (await send(started, 'GET', `/api/setup/preview?agents=claude,codex&lead=claude&single_vendor=0&confirmed=${encodeURIComponent(JSON.stringify(confirmed))}`)).json.apply
  assert.deepEqual(preview.changes, [{ field: 'confirmed', agent: 'claude', from: [], to: ['run_application'] }])
  assert.equal(preview.facts.claude.capabilities.run_application.status, 'confirmed')
  const done = await send(started, 'POST', '/api/setup/apply', { agents: IDS, lead: 'claude', single_vendor: false, confirmed, expect: await expectOf(started) })
  assert.equal(done.status, 200, done.text)
  assert.deepEqual(read(dir).agents.find((a) => a.id === 'claude').confirmed_capabilities, ['run_application'])
  assert.equal(read(dir).agents.find((a) => a.id === 'codex').confirmed_capabilities, undefined)
  // And back: revert gives the previous confirmations back too.
  const info = (await send(started, 'GET', '/api/setup/preview?agents=claude,codex&lead=claude&single_vendor=0')).json.apply.revert
  assert.equal((await send(started, 'POST', '/api/setup/revert', { expect: info.expect })).status, 200)
  assert.equal(read(dir).agents.find((a) => a.id === 'claude').confirmed_capabilities, undefined)
})

test('confirmed: the machine\'s "no" beats the owner\'s "yes", and only capabilities the agent has can be confirmed', async (t) => {
  const dir = machineWith()
  const started = await panel(t, dir, { probeEnv: machineFacts({ files: READ_ONLY_CODEX }) })
  if (!started) return
  const before = readFileSync(join(dir, 'agents.json'), 'utf8')
  const expect = await expectOf(started)
  const ruledOut = await send(started, 'POST', '/api/setup/apply', { agents: IDS, lead: 'claude', single_vendor: false, confirmed: { claude: [], codex: ['modify_code'] }, expect })
  assert.equal(ruledOut.status, 409)
  assert.match(ruledOut.json.reason, /Нельзя подтвердить агенту codex: modify_code \(.*read-only/)
  const foreign = await send(started, 'POST', '/api/setup/apply', { agents: IDS, lead: 'claude', single_vendor: false, confirmed: { claude: ['telepathy'], codex: [] }, expect })
  assert.equal(foreign.status, 409)
  assert.equal((await send(started, 'POST', '/api/setup/apply', { agents: IDS, lead: 'claude', single_vendor: false, confirmed: [], expect })).status, 400)
  assert.equal(readFileSync(join(dir, 'agents.json'), 'utf8'), before)
})

test('roles: the first setup takes the roles the owner ticked', async (t) => {
  const dir = join(tempDir('panel-first-roles-'), 'machine')
  const started = await panel(t, dir)
  if (!started) return
  const planned = (await send(started, 'GET', '/api/setup/preview?agents=claude,codex&lead=claude&single_vendor=0')).json.apply.roles
  // Everything is proposed to everyone; the owner keeps iOS with claude.
  const roles = { ...planned, codex: planned.codex.filter((r) => r !== 'ios_engineer') }
  const done = await send(started, 'POST', '/api/setup/apply', { agents: IDS, lead: 'claude', single_vendor: false, roles, expect: 'none' })
  assert.equal(done.status, 200, done.text)
  assert.deepEqual(rolesOf(dir), roles)
})

const emptyMachine = () => join(tempDir('panel-first-'), 'machine')

test('first setup: with nothing recorded the panel writes what `collab setup` would, and says so before', async (t) => {
  const dir = emptyMachine()
  const started = await panel(t, dir)
  if (!started) return
  const preview = (await send(started, 'GET', '/api/setup/preview?agents=claude,codex&lead=codex&single_vendor=0')).json.apply
  assert.equal(preview.first_setup, true)
  assert.equal(preview.expect, 'none')
  assert.deepEqual(preview.changes.map((c) => c.agent ? `${c.field}:${c.agent}` : c.field), ['agents', 'lead', 'review_mode', 'roles:claude', 'roles:codex'])
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

// ── the owner's language (owner_language) ────────────────────────────────────

test('language: apply sets the owner\'s language and nothing else, shown first; "" takes it away; revert gives it back', async (t) => {
  const dir = machineWith()
  const started = await panel(t, dir)
  if (!started) return
  const before = readFileSync(join(dir, 'agents.json'), 'utf8')
  const preview = (await send(started, 'GET', '/api/setup/preview?agents=claude,codex&lead=claude&single_vendor=0&owner_language=ru')).json.apply
  assert.deepEqual(preview.changes, [{ field: 'owner_language', from: null, to: 'ru' }])
  assert.equal(readFileSync(join(dir, 'agents.json'), 'utf8'), before, 'a preview writes nothing')
  const set = await send(started, 'POST', '/api/setup/apply', { agents: IDS, lead: 'claude', single_vendor: false, owner_language: 'ru', expect: await expectOf(started) })
  assert.equal(set.status, 200, set.text)
  const after = read(dir)
  assert.equal(after.owner_language, 'ru')
  const { owner_language: _ru, ...rest } = after
  assert.deepEqual(rest, JSON.parse(before), 'nothing but the language moved')
  // Not sent = kept: a lead change does not drop the language.
  const lead = await send(started, 'POST', '/api/setup/apply', { agents: IDS, lead: 'codex', single_vendor: false, expect: set.json.expect })
  assert.equal(lead.status, 200, lead.text)
  assert.equal(read(dir).owner_language, 'ru')
  // "" = not set: the key goes away.
  const cleared = await send(started, 'POST', '/api/setup/apply', { agents: IDS, lead: 'codex', single_vendor: false, owner_language: '', expect: lead.json.expect })
  assert.equal(cleared.status, 200, cleared.text)
  assert.deepEqual(cleared.json.changes, [{ field: 'owner_language', from: 'ru', to: null }])
  assert.equal(Object.hasOwn(read(dir), 'owner_language'), false)
  const revert = (await send(started, 'GET', '/api/setup/preview?agents=claude,codex&lead=codex&single_vendor=0')).json.apply.revert
  assert.deepEqual(revert.changes, [{ field: 'owner_language', from: null, to: 'ru' }])
  const undone = await send(started, 'POST', '/api/setup/revert', { expect: revert.expect })
  assert.equal(undone.status, 200, undone.text)
  assert.equal(read(dir).owner_language, 'ru')
})

test('language: the first setup records it; a code that is not a language is refused and writes nothing', async (t) => {
  const dir = emptyMachine()
  const started = await panel(t, dir)
  if (!started) return
  const bad = await send(started, 'POST', '/api/setup/apply', { agents: IDS, lead: 'claude', single_vendor: false, owner_language: 'russian', expect: 'none' })
  assert.equal(bad.status, 409, bad.text)
  const notText = await send(started, 'POST', '/api/setup/apply', { agents: IDS, lead: 'claude', single_vendor: false, owner_language: 7, expect: 'none' })
  assert.equal(notText.status, 400, notText.text)
  assert.equal(existsSync(join(dir, 'agents.json')), false)
  const done = await send(started, 'POST', '/api/setup/apply', { agents: IDS, lead: 'claude', single_vendor: false, owner_language: 'ru', expect: 'none' })
  assert.equal(done.status, 200, done.text)
  assert.ok(done.json.changes.some((c) => c.field === 'owner_language' && c.to === 'ru'))
  assert.equal(read(dir).owner_language, 'ru')
})

// ── who is in the orchestration: the set of agents from the wizard (30.09.2026) ─

test('set: ticking an agent of the catalog adds it — shown first, written with its roles and briefing; others untouched', async (t) => {
  const dir = machineWith()
  const started = await panel(t, dir)
  if (!started) return
  const before = read(dir)
  const preview = (await send(started, 'GET', '/api/setup/preview?agents=claude,codex,gemini&lead=claude&single_vendor=0')).json.apply
  assert.equal(preview.available, true, preview.reason)
  assert.deepEqual(preview.changes.find((c) => c.field === 'agents'), { field: 'agents', from: ['claude', 'codex'], to: ['claude', 'codex', 'gemini'] })
  const done = await send(started, 'POST', '/api/setup/apply', { agents: [...IDS, 'gemini'], lead: 'claude', single_vendor: false, expect: await expectOf(started) })
  assert.equal(done.status, 200, done.text)
  const after = read(dir)
  assert.deepEqual(after.agents.map((a) => a.id), ['claude', 'codex', 'gemini'])
  const gemini = after.agents.find((a) => a.id === 'gemini')
  assert.ok(gemini.roles.length, 'it holds the roles the facts allow')
  assert.ok(existsSync(join(dir, gemini.briefing_file)), 'its briefing file is copied like collab setup copies it')
  assert.deepEqual(after.agents.slice(0, 2), before.agents, 'the agents already there are written exactly as they were')
})

test('set: unticking an agent takes it out; the lead cannot be taken out; an id outside the catalog cannot be added', async (t) => {
  const dir = machineWith()
  const started = await panel(t, dir)
  if (!started) return
  const lead = await send(started, 'POST', '/api/setup/apply', { agents: ['codex'], lead: 'claude', single_vendor: true, expect: await expectOf(started) })
  assert.equal(lead.status, 409)
  assert.match(lead.json.reason, /Ведущий/)
  const unknown = await send(started, 'POST', '/api/setup/apply', { agents: [...IDS, 'nobody'], lead: 'claude', single_vendor: false, expect: await expectOf(started) })
  assert.equal(unknown.status, 409)
  assert.deepEqual(read(dir).agents.map((a) => a.id), IDS, 'nothing written by the refusals')
  const preview = (await send(started, 'GET', '/api/setup/preview?agents=claude&lead=claude&single_vendor=1')).json.apply
  assert.deepEqual(preview.removed_agents, ['codex'])
  const out = await send(started, 'POST', '/api/setup/apply', { agents: ['claude'], lead: 'claude', single_vendor: true, expect: await expectOf(started) })
  assert.equal(out.status, 200, out.text)
  assert.deepEqual(read(dir).agents.map((a) => a.id), ['claude'])
})

test('set: "Вернуть прежний" brings the previous set of agents back', async (t) => {
  const dir = machineWith()
  const started = await panel(t, dir)
  if (!started) return
  const before = readFileSync(join(dir, 'agents.json'), 'utf8')
  const added = await send(started, 'POST', '/api/setup/apply', { agents: [...IDS, 'gemini'], lead: 'claude', single_vendor: false, expect: await expectOf(started) })
  assert.equal(added.status, 200, added.text)
  const revert = (await send(started, 'GET', '/api/setup/preview?agents=claude,codex,gemini&lead=claude&single_vendor=0')).json.apply.revert
  assert.equal(revert.available, true, revert.reason)
  assert.deepEqual(revert.changes.find((c) => c.field === 'agents'), { field: 'agents', from: ['claude', 'codex', 'gemini'], to: ['claude', 'codex'] })
  const undone = await send(started, 'POST', '/api/setup/revert', { expect: revert.expect })
  assert.equal(undone.status, 200, undone.text)
  assert.equal(readFileSync(join(dir, 'agents.json'), 'utf8'), before)
})

test('set: a briefing copy never follows a link out of the machine directory; nothing is written then', async (t) => {
  const dir = machineWith()
  const started = await panel(t, dir)
  if (!started) return
  const outside = mkdtempSync(join(tmpdir(), 'panel-outside-'))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  rmSync(join(dir, 'briefings'), { recursive: true, force: true })
  symlinkSync(outside, join(dir, 'briefings'))
  const before = readFileSync(join(dir, 'agents.json'), 'utf8')
  const res = await send(started, 'POST', '/api/setup/apply', { agents: [...IDS, 'gemini'], lead: 'claude', single_vendor: false, expect: await expectOf(started) })
  assert.equal(res.status, 409, res.text)
  assert.match(res.json.reason, /outside/)
  assert.deepEqual(readdirSync(outside), [], 'nothing copied through the link')
  assert.equal(readFileSync(join(dir, 'agents.json'), 'utf8'), before)
})
