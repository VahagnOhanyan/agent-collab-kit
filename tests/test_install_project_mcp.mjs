// MCP servers a project asks for in its registry entry (projects/<id>/mcp.json): registered with Claude Code at local
// scope from the project's roots only, in every config directory, and removed only by the kit that added them.
//
// Shared world and fakes: tests/helpers/install-world.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setup, makeSource, makeWorld } from './helpers/install-world.mjs'

setup()

const URL_A = 'https://mcp.example.com/mcp/my-org'
const URL_B = 'https://mcp.example.com/mcp/other-org'

// A registered project "my-app" with one root, and a directory outside every project.
function world(name, servers) {
  const W = makeWorld(name)
  const root = join(W.root, 'my-app')
  const elsewhere = join(W.root, 'elsewhere')
  mkdirSync(root, { recursive: true })
  mkdirSync(elsewhere, { recursive: true })
  const entry = W.kit('projects', 'my-app')
  mkdirSync(entry, { recursive: true })
  writeFileSync(join(entry, 'project.json'), JSON.stringify({ id: 'my-app', roots: [root] }))
  const setServers = (s) => writeFileSync(join(entry, 'mcp.json'), JSON.stringify({ servers: s }))
  if (servers) setServers(servers)
  return { W, root: realpathSync(root), elsewhere: realpathSync(elsewhere), setServers, source: makeSource(name) }
}

const install = (W, source, extra = [], env = {}) => W.run(['--source', source, '--skip-kit-tests', ...extra], env)
const record = (W) => (existsSync(W.kit('state', 'project-mcp.json')) ? JSON.parse(readFileSync(W.kit('state', 'project-mcp.json'), 'utf8')) : null)
const trackerCalls = (W) => W.claudeCalls().filter((argv) => (argv[1] === 'add' || argv[1] === 'remove') && argv.includes('tracker'))

test('a project server is registered at local scope for the project root only, in every config directory', () => {
  const { W, root, elsewhere, source } = world('pmcp-basic', { tracker: { type: 'http', url: URL_A } })
  const second = join(W.home, '.claude-account-2')
  const r = install(W, source, ['--claude-config-dir', second])
  assert.equal(r.status, 0, r.all)
  for (const local of [W.claudeLocal(), W.claudeLocal('.claude-account-2')]) {
    assert.deepEqual(local, { [root]: { tracker: { url: URL_A } } })
    assert.equal(local[elsewhere], undefined)
  }
  // Never machine-wide.
  assert.equal(W.claudeState().tracker, undefined)
  assert.equal(W.claudeStateIn('.claude-account-2').tracker, undefined)
  const rec = record(W)
  assert.equal(rec.registrations.length, 2)
  assert.ok(rec.registrations.every((x) => x.root === root && x.name === 'tracker' && x.url === URL_A))
  assert.match(r.all, /Claude Code only/)
})

test('a second install changes nothing; a server dropped from mcp.json is removed', () => {
  const { W, setServers, source } = world('pmcp-idem', { tracker: { type: 'http', url: URL_A } })
  assert.equal(install(W, source).status, 0)
  const before = trackerCalls(W).length
  const again = install(W, source)
  assert.equal(again.status, 0, again.all)
  assert.equal(trackerCalls(W).length, before, 'a repeat install must not add or remove anything')

  setServers({})
  const dropped = install(W, source)
  assert.equal(dropped.status, 0, dropped.all)
  assert.deepEqual(W.claudeLocal(), {})
  assert.deepEqual(record(W).registrations, [])
  assert.match(dropped.all, new RegExp(`project MCP tracker .*removed`))
})

test('a changed URL replaces the registration the kit made', () => {
  const { W, root, setServers, source } = world('pmcp-url', { tracker: { type: 'http', url: URL_A } })
  assert.equal(install(W, source).status, 0)
  setServers({ tracker: { type: 'http', url: URL_B } })
  const r = install(W, source)
  assert.equal(r.status, 0, r.all)
  assert.deepEqual(W.claudeLocal(), { [root]: { tracker: { url: URL_B } } })
})

test('a server of the same name the kit did not add is left alone', () => {
  const { W, root, source } = world('pmcp-foreign', { tracker: { type: 'http', url: URL_A } })
  const localFile = join(W.root, 'claude-state-local.json')
  writeFileSync(localFile, JSON.stringify({ [root]: { tracker: { url: URL_B } } }))
  const r = install(W, source)
  assert.equal(r.status, 0, r.all)
  assert.match(r.all, /NOT registered .*left alone/)
  assert.deepEqual(W.claudeLocal(), { [root]: { tracker: { url: URL_B } } })
  assert.equal(trackerCalls(W).length, 0)
  // And it is not adopted: dropping it from the registry later must not remove somebody else's server.
  assert.ok(!record(W)?.registrations?.length)
})

test('an identical server added by hand is not adopted, so dropping it from mcp.json never removes it', () => {
  const { W, root, setServers, source } = world('pmcp-identical', { tracker: { type: 'http', url: URL_A } })
  writeFileSync(join(W.root, 'claude-state-local.json'), JSON.stringify({ [root]: { tracker: { url: URL_A } } }))
  assert.equal(install(W, source).status, 0)
  assert.ok(!record(W)?.registrations?.length, 'a hand-added server must not enter the record')
  setServers({})
  const r = install(W, source)
  assert.equal(r.status, 0, r.all)
  assert.deepEqual(W.claudeLocal(), { [root]: { tracker: { url: URL_A } } })
  assert.equal(trackerCalls(W).length, 0)
})

test('an account whose CLI does not answer is reported and skipped; the others are registered', () => {
  const { W, root, source } = world('pmcp-unreachable', { tracker: { type: 'http', url: URL_A } })
  const second = join(W.home, '.claude-account-2')
  const r = install(W, source, ['--claude-config-dir', second], { FAKE_CLAUDE_FAIL_DIR: second })
  assert.equal(r.status, 0, r.all)
  assert.match(r.all, /project MCP servers NOT checked/)
  assert.deepEqual(W.claudeLocal(), { [root]: { tracker: { url: URL_A } } })
  assert.deepEqual(W.claudeLocal('.claude-account-2'), {})
  assert.ok(record(W).registrations.every((x) => x.dir !== second))
})

test('a failure in another config directory rolls back what was already registered', () => {
  const { W, source } = world('pmcp-rollback', { tracker: { type: 'http', url: URL_A } })
  const second = join(W.home, '.claude-account-2')
  const r = install(W, source, ['--claude-config-dir', second], { FAKE_CLAUDE_FAIL_LOCAL_ADD_DIR: second })
  assert.notEqual(r.status, 0, r.all)
  assert.match(r.all, /rolled back/)
  assert.deepEqual(W.claudeLocal(), {}, 'the primary directory must be undone too')
  assert.equal(record(W), null)
})

for (const [label, servers, reason] of [
  ['plain http', { tracker: { type: 'http', url: 'http://mcp.example.com/mcp' } }, /must be https/],
  ['a query', { tracker: { type: 'http', url: `${URL_A}?token=abc` } }, /query or fragment/],
  ['a fragment', { tracker: { type: 'http', url: `${URL_A}#token=abc` } }, /query or fragment/],
  ['a login', { tracker: { type: 'http', url: 'https://me:pw@mcp.example.com/mcp' } }, /login/],
  ['headers', { tracker: { type: 'http', url: URL_A, headers: { Authorization: 'x' } } }, /only "type" and "url"/],
  ['stdio', { tracker: { type: 'stdio', url: URL_A } }, /must be "http"/],
  ['the name collab', { collab: { type: 'http', url: URL_A } }, /registered by the installer itself/]
]) {
  test(`an entry with ${label} is refused before anything changes`, () => {
    const { W, source } = world(`pmcp-refuse-${label.replace(/\W+/g, '-')}`, servers)
    const r = install(W, source)
    assert.notEqual(r.status, 0, r.all)
    assert.match(r.all, reason)
    assert.match(r.all, /nothing was changed/)
    assert.deepEqual(W.claudeLocal(), {})
    assert.equal(existsSync(W.kit('current')), false, 'the install must stop before it switches anything')
  })
}
