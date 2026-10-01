// Every kind of work must have somebody other than its author to review it
// while two vendors are there; with one vendor the gap is a note, answered by a
// different, not weaker model on the task. Proved on plain data, then on the
// registry (reviewed_by must name declared roles) and on doctor.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createApi } from '../src/api.mjs'
import { independenceReport } from '../src/independence.mjs'
import { planComposition, writeComposition } from '../src/composition.mjs'
import { DEFAULT_CONFIG_DIR } from '../src/paths.mjs'
import { expandCatalogAgents, loadBuiltinAgents, loadConfigFrom, validateRegistry } from '../src/registry.mjs'
import { runCli, sandbox, tempDir, writeJson } from './helpers.mjs'

const roleDefs = {
  software_engineer: { summary: 's', requires: [], reviewed_by: ['code_reviewer'] },
  code_reviewer: { summary: 'r', requires: [] },
  ux_reviewer: { summary: 'u', requires: [] }
}
const agent = (id, provider, roles) => ({ id, provider, roles })

test('two vendors, each able to review the other: nothing to report', () => {
  const report = independenceReport({
    agents: [agent('a', 'one', ['software_engineer', 'code_reviewer']), agent('b', 'two', ['software_engineer', 'code_reviewer'])],
    roleDefs
  })
  assert.deepEqual([report.single_vendor, report.problems, report.notes], [false, [], []])
})

test('two vendors, the author is the only reviewer: a problem naming who and what is missing', () => {
  const report = independenceReport({
    agents: [agent('a', 'one', ['software_engineer', 'code_reviewer']), agent('b', 'two', ['software_engineer'])],
    roleDefs
  })
  assert.deepEqual(report.problems.map((p) => [p.role, p.author, p.reviewer_role, p.only_the_author]), [['software_engineer', 'a', 'code_reviewer', true]])
  assert.deepEqual(report.notes, [])
  assert.match(report.problems[0].message, /a itself/)
})

test('two vendors, nobody holds the reviewing role: a problem for every author', () => {
  const report = independenceReport({ agents: [agent('a', 'one', ['software_engineer']), agent('b', 'two', ['software_engineer'])], roleDefs })
  assert.deepEqual(report.problems.map((p) => [p.author, p.only_the_author]), [['a', false], ['b', false]])
})

test('one vendor — one agent, or two of the same provider: the gap is a note, not a problem', () => {
  const alone = independenceReport({ agents: [agent('a', 'one', ['software_engineer', 'code_reviewer'])], roleDefs })
  assert.deepEqual([alone.single_vendor, alone.problems.length, alone.notes.length], [true, 0, 1])
  const sameVendor = independenceReport({ agents: [agent('a', 'one', ['software_engineer', 'code_reviewer']), agent('b', 'one', ['software_engineer'])], roleDefs })
  assert.deepEqual([sameVendor.single_vendor, sameVendor.problems.length], [true, 0])
  // a reviews only itself; b is reviewed by a — another agent, but of the same vendor: both are notes.
  assert.deepEqual(sameVendor.notes.map((n) => [n.author, Boolean(n.same_vendor)]).sort(), [['a', false], ['b', true]])
})

test('reviewed_by with several roles asks another holder for EACH of them', () => {
  const defs = { ...roleDefs, software_engineer: { ...roleDefs.software_engineer, reviewed_by: ['code_reviewer', 'ux_reviewer'] } }
  const report = independenceReport({
    agents: [agent('a', 'one', ['software_engineer', 'code_reviewer', 'ux_reviewer']), agent('b', 'two', ['code_reviewer'])],
    roleDefs: defs
  })
  assert.deepEqual(report.problems.map((p) => [p.author, p.reviewer_role]), [['a', 'ux_reviewer']])
})

test('an agent that names no provider is a vendor of its own, not a reason to relax the check', () => {
  const report = independenceReport({
    agents: [agent('a', 'one', ['software_engineer', 'code_reviewer']), { id: 'b', roles: ['software_engineer'] }],
    roleDefs
  })
  assert.equal(report.single_vendor, false)
  assert.equal(report.problems.length, 1)
})

test('collab setup refuses a composition where the author is the only reviewer', () => {
  const base = tempDir('collab-independence-setup-')
  try {
    const dir = join(base, 'machine')
    const home = join(base, 'home')
    // Codex's sessions are read-only here, so only claude can hold software_engineer. On this machine architect work
    // is reviewed by a software_engineer: claude's architect work could then be reviewed only by claude.
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(join(home, '.codex', 'config.toml'), 'sandbox_mode = "read-only"\n')
    const roles = structuredClone(loadConfigFrom().roles)
    roles.roles.architect.reviewed_by = ['software_engineer']
    writeJson(join(dir, 'roles.json'), roles)
    const refused = runCli(['setup', '--agents', 'claude,codex', '--lead', 'claude', '--dry-run'], { cwd: base, options: { machineDir: dir, probeHome: home } })
    assert.equal(refused.status, 1, refused.stdout + refused.stderr)
    assert.match(refused.stdout, /refusing\s+architect work done by claude can only be reviewed as software_engineer by claude itself/)
    // One vendor where the author holds the reviewing role itself: the accepted same-agent answer, a note.
    const alone = runCli(['setup', '--agents', 'claude', '--lead', 'claude', '--dry-run'], { cwd: base, options: { machineDir: dir, probeHome: home } })
    assert.equal(alone.status, 0, alone.stdout + alone.stderr)
    assert.match(alone.stdout, /note/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('one vendor where NOBODY holds the reviewing role is a problem: the same-agent fallback needs a holder', () => {
  const report = independenceReport({ agents: [agent('a', 'one', ['software_engineer'])], roleDefs })
  assert.equal(report.single_vendor, true)
  assert.deepEqual(report.problems.map((p) => [p.author, p.reviewer_role, p.only_the_author]), [['a', 'code_reviewer', false]])
  assert.deepEqual(report.notes, [])
})

test('a provider string can never stand in for a missing provider', () => {
  const report = independenceReport({
    agents: [{ id: 'a', roles: ['software_engineer', 'code_reviewer'] }, agent('b', 'unknown:a', [])],
    roleDefs
  })
  assert.equal(report.single_vendor, false)
  assert.equal(report.problems.length, 1)
})

test('every agent is proposed exactly the roles its capabilities satisfy, nothing the catalog says by vendor', () => {
  const defs = { writer: { summary: 'w', requires: ['modify_code'] }, runner: { summary: 'r', requires: ['run_application'] }, reader: { summary: 'x', requires: ['read_code'] } }
  const catalog = {
    agents: [
      { id: 'a', provider: 'one', capabilities: ['read_code', 'modify_code', 'run_application'], roles: ['reader'] },
      { id: 'b', provider: 'two', capabilities: ['read_code'] }
    ]
  }
  const planned = planComposition({ catalog, roleDefs: defs, include: ['a', 'b'], lead: 'a' })
  const roles = Object.fromEntries(planned.content.agents.map((agent) => [agent.id, agent.roles]))
  assert.deepEqual(roles, { a: ['writer', 'runner', 'reader'], b: ['reader'] }, 'a role list in the catalog is ignored; capabilities decide')
})

test('expanding a catalog agent leaves out what its program cannot have, and the roles that need it', () => {
  const defs = { writer: { summary: 'w', requires: ['modify_code'] }, runner: { summary: 'r', requires: ['run_application'] } }
  const expanded = expandCatalogAgents(
    { agents: [{ id: 'a', provider: 'one', adapter: { kind: 'manual', cannot: ['run_application'] } }] },
    { capabilityIds: ['modify_code', 'run_application'], roleDefs: defs }
  )
  assert.deepEqual([expanded.agents[0].capabilities, expanded.agents[0].roles], [['modify_code'], ['writer']])
})

test('the catalog binds no role or capability to a vendor; each agent may have all but what its program cannot', () => {
  const file = JSON.parse(readFileSync(join(DEFAULT_CONFIG_DIR, 'agents.json'), 'utf8'))
  for (const agent of file.agents) {
    assert.equal(agent.roles, undefined, `${agent.id} has no roles in the catalog`)
    assert.equal(agent.capabilities, undefined, `${agent.id} has no capabilities in the catalog`)
    assert.ok(Array.isArray(agent.adapter.cannot), `${agent.id} states what its program cannot have`)
  }
  const expanded = loadBuiltinAgents()
  const allCaps = Object.keys(loadConfigFrom().capabilities.capabilities)
  for (const agent of expanded.agents) {
    assert.deepEqual(agent.capabilities, allCaps.filter((c) => !agent.adapter.cannot.includes(c)))
    assert.ok(agent.roles.length > 0)
  }
  assert.deepEqual(validateRegistry(loadConfigFrom()).problems, [], 'the catalog alone is still a working registry')
})

test('collab setup writes what the configuration in force already gives, with the machine\'s own capabilities and roles', () => {
  const base = tempDir('collab-independence-setup-write-')
  try {
    const dir = join(base, 'machine')
    // This machine declares one more capability and a role on it: "all, then cut by facts" gives both to everyone —
    // before anything is written (the catalog in force) and in what setup writes. One configuration, one answer.
    const capabilities = structuredClone(loadConfigFrom().capabilities)
    capabilities.capabilities.sign_releases = 'Sign a release with the owner key.'
    writeJson(join(dir, 'capabilities.json'), capabilities)
    const roles = structuredClone(loadConfigFrom().roles)
    roles.roles.release_signer = { summary: 'Signs releases.', requires: ['sign_releases'] }
    writeJson(join(dir, 'roles.json'), roles)
    // The agents setup is asked for: the catalog may hold more (gemini), and what is not chosen is not written.
    const chosen = ['claude', 'codex']
    const inForce = Object.fromEntries(loadConfigFrom([dir], { kind: 'machine', dir }).agents.agents.filter((a) => chosen.includes(a.id)).map((a) => [a.id, [...a.roles].sort()]))
    const r = runCli(['setup', '--agents', 'claude,codex', '--lead', 'claude'], { cwd: base, options: { machineDir: dir, assumeHuman: true } })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    const written = JSON.parse(readFileSync(join(dir, 'agents.json'), 'utf8'))
    assert.deepEqual(Object.fromEntries(written.agents.map((a) => [a.id, [...a.roles].sort()])), inForce)
    assert.ok(written.agents.every((a) => a.roles.includes('release_signer')))
    assert.deepEqual(validateRegistry(loadConfigFrom([dir], { kind: 'machine', dir })).problems, [])
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a role without reviewed_by asks nothing of the composition', () => {
  const report = independenceReport({ agents: [agent('a', 'one', ['ux_reviewer']), agent('b', 'two', [])], roleDefs })
  assert.deepEqual(report.problems, [])
})

test('the registry refuses reviewed_by that names an unknown role or the role itself', () => {
  const config = loadConfigFrom()
  const broken = structuredClone(config)
  Object.defineProperty(broken, 'meta', { value: config.meta, enumerable: false })
  broken.roles.roles.software_engineer.reviewed_by = ['no_such_role', 'software_engineer']
  const problems = validateRegistry(broken).problems.join(' | ')
  assert.match(problems, /reviewed_by unknown role "no_such_role"/)
  assert.match(problems, /cannot be reviewed_by itself/)
})

test('the built-in catalog and its default two-agent composition are independent', () => {
  const config = loadConfigFrom()
  assert.deepEqual(validateRegistry(config).problems, [])
  const planned = planComposition({ catalog: loadBuiltinAgents(), roleDefs: config.roles.roles, include: ['claude', 'codex'], lead: 'claude' })
  assert.deepEqual(independenceReport({ agents: planned.content.agents, roleDefs: config.roles.roles }).problems, [])
})

test('doctor reports independence from the composition it runs with', () => {
  const base = tempDir('collab-independence-doctor-')
  const sbx = sandbox()
  try {
    const dir = join(base, 'machine')
    const roleDefsBuiltin = loadConfigFrom().roles.roles
    const planned = planComposition({ catalog: loadBuiltinAgents(), roleDefs: roleDefsBuiltin, include: ['claude', 'codex'], lead: 'claude' })
    writeComposition(dir, planned.content, { catalogDir: DEFAULT_CONFIG_DIR })
    const api = () => createApi({ agentId: 'claude', roots: sbx.roots, machineDir: dir, registryDir: join(base, 'no-registry') })
    assert.deepEqual(api().doctor().independence.problems, [])
    // Codex stops reviewing: Claude's work now has nobody but Claude to review it.
    const content = { ...planned.content, agents: planned.content.agents.map((a) => (a.id === 'codex' ? { ...a, roles: a.roles.filter((r) => r !== 'code_reviewer') } : a)) }
    writeJson(join(dir, 'agents.json'), content)
    const report = api().doctor().independence
    assert.ok(report.problems.length > 0)
    assert.ok(report.problems.every((p) => p.author === 'claude' && p.reviewer_role === 'code_reviewer'))
  } finally {
    rmSync(base, { recursive: true, force: true })
    sbx.cleanup()
  }
})
