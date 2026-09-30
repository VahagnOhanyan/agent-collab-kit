// Every kind of work must have somebody other than its author to review it
// while two vendors are there; with one vendor the gap is a note, answered by a
// different, not weaker model on the task. Proved on plain data, then on the
// registry (reviewed_by must name declared roles) and on doctor.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

import { createApi } from '../src/api.mjs'
import { independenceReport } from '../src/independence.mjs'
import { planComposition, writeComposition } from '../src/composition.mjs'
import { DEFAULT_CONFIG_DIR } from '../src/paths.mjs'
import { loadBuiltinAgents, loadConfigFrom, validateRegistry } from '../src/registry.mjs'
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
  assert.deepEqual([sameVendor.single_vendor, sameVendor.problems.length, sameVendor.notes.length], [true, 0, 1])
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
    // The machine's own roles: ux_reviewer work must be checked by a security_reviewer — nobody holds that role.
    const roles = structuredClone(loadConfigFrom().roles)
    roles.roles.ux_reviewer.reviewed_by = ['security_reviewer']
    writeJson(join(dir, 'roles.json'), roles)
    const refused = runCli(['setup', '--agents', 'claude,codex', '--lead', 'claude', '--dry-run'], { cwd: base, options: { machineDir: dir } })
    assert.equal(refused.status, 1, refused.stdout + refused.stderr)
    assert.match(refused.stdout, /refusing\s+ux_reviewer work done by codex/)
    const alone = runCli(['setup', '--agents', 'codex', '--lead', 'codex', '--dry-run'], { cwd: base, options: { machineDir: dir } })
    assert.equal(alone.status, 0, alone.stdout + alone.stderr)
    assert.match(alone.stdout, /note/)
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
