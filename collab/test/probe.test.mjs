// What an agent can do on a machine comes from facts: confirmed, missing or unknown. Only `missing` takes a role
// away; `unknown` marks it and routes it last. Every machine here is described by the test — the owner's own
// configuration is never read.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createApi } from '../src/api.mjs'
import { planComposition, writeComposition } from '../src/composition.mjs'
import { DEFAULT_CONFIG_DIR } from '../src/paths.mjs'
import { factConflicts, factsFor, fitToFacts, probeAgent, rolesByFacts } from '../src/probe.mjs'
import { createRegistry, loadBuiltinAgents, loadConfigFrom, validateRegistry } from '../src/registry.mjs'
import { runCli, sandbox, tempDir, writeJson } from './helpers.mjs'

const CONFIG = loadConfigFrom()
const CAPS = Object.keys(CONFIG.capabilities.capabilities)
const ROLES = CONFIG.roles.roles
const CATALOG = loadBuiltinAgents()
const agentOf = (id) => CATALOG.agents.find((a) => a.id === id)

// A machine: which programs are on PATH, which files exist and what they say.
function machine({ binaries = ['claude', 'codex'], files = {}, apps = ['/Applications/Xcode.app'], platform = 'darwin', home = '/h' } = {}) {
  return {
    home,
    platform,
    which: (binary) => (binaries.includes(binary) ? `/usr/bin/${binary}` : null),
    exists: (file) => apps.includes(file) || Object.hasOwn(files, file),
    read: (file) => (Object.hasOwn(files, file) ? files[file] : null)
  }
}
const readOnlyCodex = (home = '/h') => ({ [join(home, '.codex', 'config.toml')]: 'approval_policy = "never"\nsandbox_mode = "read-only"\n' })

test('an agent whose program is not here is unknown on everything, never missing', () => {
  const probe = probeAgent(agentOf('codex'), CAPS, machine({ binaries: ['claude'] }))
  assert.equal(probe.installed, false)
  assert.ok(Object.values(probe.capabilities).every((c) => c.status === 'unknown'))
})

test('what the vendor\'s program cannot have (adapter.cannot) is missing on any machine, with the reason', () => {
  const agent = { ...agentOf('codex'), adapter: { ...agentOf('codex').adapter, cannot: ['run_application'] } }
  const probe = probeAgent(agent, CAPS, machine())
  assert.equal(probe.capabilities.run_application.status, 'missing')
  assert.match(probe.capabilities.run_application.reason, /adapter\.cannot/)
  assert.equal(probe.capabilities.read_code.status, 'confirmed')
})

test('a read-only session rules out writing and running, and nothing else', () => {
  const probe = probeAgent(agentOf('codex'), CAPS, machine({ files: readOnlyCodex() }))
  assert.equal(probe.sandbox, 'read-only')
  for (const capability of ['modify_code', 'run_tests', 'run_gates', 'run_application']) assert.equal(probe.capabilities[capability].status, 'missing', capability)
  for (const capability of ['read_code', 'review_code', 'inspect_git']) assert.equal(probe.capabilities[capability].status, 'confirmed', capability)
})

test('only the top-level sandbox counts: a profile table does not set the default', () => {
  const files = { '/h/.codex/config.toml': '[profiles.careful]\nsandbox_mode = "read-only"\n' }
  assert.equal(probeAgent(agentOf('codex'), CAPS, machine({ files })).sandbox, null)
})

test('running an application is never ruled out by what was not found: unknown with or without a browser', () => {
  assert.equal(probeAgent(agentOf('claude'), CAPS, machine()).capabilities.run_application.status, 'unknown')
  assert.equal(probeAgent(agentOf('claude'), CAPS, machine({ apps: [], platform: 'win32' })).capabilities.run_application.status, 'unknown')
})

test('MCP servers registered for the agent confirm use_mcp_tool', () => {
  const home = tempDir('probe-home-')
  try {
    writeJson(join(home, '.claude.json'), { mcpServers: { collab: { command: 'node' } } })
    const env = { ...machine(), home, read: () => null }
    assert.equal(probeAgent(agentOf('claude'), CAPS, env).capabilities.use_mcp_tool.status, 'confirmed')
    assert.equal(probeAgent(agentOf('codex'), CAPS, env).capabilities.use_mcp_tool.status, 'unknown')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('roles: missing blocks with the reason, unknown marks, an undeclared capability blocks', () => {
  const codex = agentOf('codex')
  const byFacts = rolesByFacts(codex, ROLES, probeAgent(codex, CAPS, machine({ files: readOnlyCodex() })))
  const blocked = Object.fromEntries(byFacts.blocked.map((b) => [b.role, b.reasons.join(' | ')]))
  assert.match(blocked.software_engineer, /read-only/)
  assert.ok(byFacts.allowed.includes('code_reviewer'), 'reviewing needs no writing')
  const defs = { ...ROLES, ux_reviewer: { ...ROLES.ux_reviewer, requires: [...ROLES.ux_reviewer.requires, 'run_application'] } }
  const claude = agentOf('claude')
  const marked = rolesByFacts(claude, defs, probeAgent(claude, CAPS, machine()))
  assert.ok(marked.allowed.includes('ux_reviewer') && marked.unverified.includes('ux_reviewer'))
  const noRun = { ...claude, capabilities: claude.capabilities.filter((c) => c !== 'run_application') }
  assert.match(rolesByFacts(noRun, defs, probeAgent(noRun, CAPS, machine())).blocked.find((b) => b.role === 'ux_reviewer').reasons.join(), /нет способности run_application/)
})

test('a proposal is fitted to the facts; a written composition is only reported on', () => {
  const planned = planComposition({ catalog: CATALOG, roleDefs: ROLES, include: ['claude', 'codex'], lead: 'claude' })
  const facts = factsFor(planned.content.agents, { roleDefs: ROLES, capabilityIds: CAPS, env: machine({ files: readOnlyCodex() }) })
  const fitted = fitToFacts(planned.content.agents, facts)
  const codex = fitted.find((a) => a.id === 'codex')
  assert.ok(!codex.roles.includes('software_engineer') && codex.roles.includes('code_reviewer'))
  assert.equal('unverified_roles' in codex, false, 'an empty mark is not written')
  const conflicts = factConflicts(planned.content.agents, facts)
  assert.ok(conflicts.some((c) => c.agent === 'codex' && c.role === 'software_engineer'))
  assert.ok(!conflicts.some((c) => c.agent === 'claude'))
})

test('a holder whose role is unconfirmed is found after every confirmed holder', () => {
  const config = loadConfigFrom()
  const both = config.agents.agents.filter((a) => ['claude', 'codex'].includes(a.id)).map((a) => ({ ...a, roles: ['code_reviewer'] }))
  config.agents = { ...config.agents, agents: [{ ...both[0], unverified_roles: ['code_reviewer'] }, both[1]] }
  const registry = createRegistry(config)
  assert.deepEqual(registry.find({ role: 'code_reviewer' }).map((a) => a.id), [both[1].id, both[0].id])
  assert.deepEqual(registry.find({ capability: 'read_code' }).map((a) => a.id), [both[0].id, both[1].id], 'a capability search is not reordered')
})

test('the registry refuses an unverified mark on a role the agent does not hold', () => {
  const config = loadConfigFrom()
  const broken = structuredClone(config)
  Object.defineProperty(broken, 'meta', { value: config.meta, enumerable: false })
  broken.agents.agents[0].unverified_roles = ['security_reviewer']
  broken.agents.agents[0].roles = broken.agents.agents[0].roles.filter((r) => r !== 'security_reviewer')
  assert.match(validateRegistry(broken).problems.join(' | '), /marks "security_reviewer" unverified but does not hold it/)
})

test('doctor names a held role the facts now rule out', () => {
  const base = tempDir('probe-doctor-')
  const sbx = sandbox()
  try {
    const dir = join(base, 'machine')
    const home = join(base, 'home')
    mkdirSync(join(home, '.codex'), { recursive: true })
    const planned = planComposition({ catalog: CATALOG, roleDefs: ROLES, include: ['claude', 'codex'], lead: 'claude' })
    writeComposition(dir, planned.content, { catalogDir: DEFAULT_CONFIG_DIR })
    // The machine is described, with both programs on PATH whatever the machine running the test has.
    const api = () => createApi({ agentId: 'claude', roots: sbx.roots, machineDir: dir, registryDir: join(base, 'no-registry'), probeEnv: { ...machine(), home, read: (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null) } })
    assert.deepEqual(api().doctor().fact_conflicts, [])
    // The owner turns Codex's own sessions read-only.
    writeFileSync(join(home, '.codex', 'config.toml'), 'sandbox_mode = "read-only"\n')
    const conflicts = api().doctor().fact_conflicts
    assert.ok(conflicts.length > 0)
    assert.ok(conflicts.every((c) => c.agent === 'codex'))
  } finally {
    rmSync(base, { recursive: true, force: true })
    sbx.cleanup()
  }
})

test('collab setup proposes only what the facts allow on this machine', () => {
  const base = tempDir('probe-setup-')
  try {
    const dir = join(base, 'machine')
    const home = join(base, 'home')
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(join(home, '.codex', 'config.toml'), 'sandbox_mode = "read-only"\n')
    const r = runCli(['setup', '--agents', 'claude,codex', '--lead', 'claude'], { cwd: base, options: { machineDir: dir, assumeHuman: true, probeHome: home } })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /not given\s+codex software_engineer/)
    const written = JSON.parse(readFileSync(join(dir, 'agents.json'), 'utf8'))
    const codex = written.agents.find((a) => a.id === 'codex')
    assert.ok(!codex.roles.includes('software_engineer') && codex.roles.includes('code_reviewer'))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

