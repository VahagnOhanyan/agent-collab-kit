// The person's machine composition: which agents they have, who leads, who
// holds which role. Between a project's files and the built-in catalog, and no
// vendor is the lead unless the composition says so.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createApi } from '../src/api.mjs'
import { planComposition } from '../src/composition.mjs'
import { createRegistry, loadConfig, loadConfigFrom, validateRegistry } from '../src/registry.mjs'
import { DEFAULT_CONFIG_DIR } from '../src/paths.mjs'
import { runCli, sandbox, tempDir, writeJson } from './helpers.mjs'

const ONLY_CODEX = {
  lead: 'codex',
  agents: [
    {
      id: 'codex',
      name: 'Codex CLI',
      provider: 'openai',
      roles: ['architect', 'software_engineer', 'code_reviewer', 'test_engineer', 'ux_reviewer'],
      capabilities: ['read_code', 'modify_code', 'run_tests', 'run_gates', 'review_code', 'inspect_git', 'use_mcp_tool', 'research', 'record_decision'],
      briefing: 'You are the agent this person works with. whoami says whether you lead; the rules are in your instructions file.'
    }
  ]
}

function machine(composition) {
  const base = tempDir('collab-machine-')
  const dir = join(base, 'collab')
  mkdirSync(dir)
  if (composition) writeJson(join(dir, 'agents.json'), composition)
  return { base, dir, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

test('the catalog alone names no lead', () => {
  const builtin = loadConfigFrom(DEFAULT_CONFIG_DIR, { kind: 'builtin' })
  assert.equal(builtin.agents.lead, undefined)
})

test('a machine composition replaces the catalog: only codex, and codex leads', () => {
  const m = machine(ONLY_CODEX)
  try {
    const config = loadConfig({ machineDir: m.dir, registryDir: join(m.base, 'no-registry') })
    assert.deepEqual(validateRegistry(config).problems, [])
    assert.deepEqual(config.agents.agents.map((a) => a.id), ['codex'])
    assert.equal(config.agents.lead, 'codex')
    assert.deepEqual(createRegistry(config).find({ role: 'architect' }).map((a) => a.id), ['codex'])
  } finally {
    m.cleanup()
  }
})

test('a lead that is not declared is a problem', () => {
  const m = machine({ ...ONLY_CODEX, lead: 'claude' })
  try {
    const config = loadConfig({ machineDir: m.dir, registryDir: join(m.base, 'no-registry') })
    assert.ok(validateRegistry(config).problems.some((p) => /lead "claude" is not one of the declared agents/.test(p)))
  } finally {
    m.cleanup()
  }
})

test("a project's own agents.json wins over the machine composition", () => {
  const m = machine(ONLY_CODEX)
  const sbx = sandbox()
  try {
    const registry = join(m.base, 'registry')
    writeJson(join(registry, 'demo', 'project.json'), { id: 'demo', roots: [sbx.root] })
    const fromMachine = loadConfig({ journalRoot: sbx.root, registryDir: registry, machineDir: m.dir })
    assert.equal(fromMachine.agents.lead, 'codex', 'a project without its own agents.json uses the composition')
    writeJson(join(registry, 'demo', 'collab', 'agents.json'), { ...ONLY_CODEX, lead: undefined })
    const fromProject = loadConfig({ journalRoot: sbx.root, registryDir: registry, machineDir: m.dir })
    assert.equal(fromProject.agents.lead, undefined, 'the project file is the one in force')
  } finally {
    m.cleanup()
    sbx.cleanup()
  }
})

test('whoami tells the lead it leads; the CLI reads as the lead without being told', async () => {
  const m = machine(ONLY_CODEX)
  const sbx = sandbox()
  try {
    const api = createApi({ agentId: 'codex', roots: sbx.roots, machineDir: m.dir })
    const me = api.whoami()
    assert.equal(me.lead, true)
    assert.equal(me.lead_agent, 'codex')

    // The CLI once defaulted to "claude"; with a codex-only composition that is
    // no registered agent at all.
    const r = runCli(['status'], { cwd: sbx.root, options: { machineDir: m.dir, registryDir: join(m.base, 'no-registry') } })
    assert.equal(r.status, 0, r.stdout + r.stderr)
  } finally {
    m.cleanup()
    sbx.cleanup()
  }
})

test('setup plan: one agent holds every role it can; several keep the catalog roles; the lead must be chosen', () => {
  const catalog = loadConfigFrom(DEFAULT_CONFIG_DIR, { kind: 'builtin' }).agents
  const roleDefs = loadConfigFrom(DEFAULT_CONFIG_DIR, { kind: 'builtin' }).roles.roles
  const ids = catalog.agents.map((a) => a.id)

  const solo = planComposition({ catalog, roleDefs, include: [ids[1]], lead: ids[1] })
  assert.ok(solo.ok)
  assert.equal(solo.content.lead, ids[1])
  assert.ok(['architect', 'code_reviewer', 'ux_reviewer', 'software_engineer'].every((r) => solo.content.agents[0].roles.includes(r)), solo.content.agents[0].roles.join(','))
  assert.equal(solo.content.agents[0].adapter, undefined, 'adapters never leave the catalog')

  const both = planComposition({ catalog, roleDefs, include: ids, lead: ids[1] })
  assert.ok(both.ok)
  assert.deepEqual(both.content.agents.map((a) => a.roles), catalog.agents.map((a) => a.roles))
  const m = machine(both.content)
  try {
    assert.deepEqual(validateRegistry(loadConfigFrom([m.dir], { kind: 'machine', dir: m.dir })).problems, [])
  } finally {
    m.cleanup()
  }

  assert.equal(planComposition({ catalog, roleDefs, include: [ids[0]], lead: ids[1] }).ok, false)
  assert.equal(planComposition({ catalog, roleDefs, include: ['nobody'], lead: 'nobody' }).ok, false)
})

test('setup writes the composition for the owner, copies briefings, keeps other files; --dry-run writes nothing', () => {
  const m = machine(null)
  try {
    writeFileSync(join(m.dir, 'policy.json.keep'), 'mine\n')
    const dry = runCli(['setup', '--agents', 'codex', '--dry-run'], { cwd: m.base, options: { machineDir: m.dir } })
    assert.equal(dry.status, 0, dry.stdout + dry.stderr)
    assert.match(dry.stdout, /lead +codex/)
    assert.equal(existsSync(join(m.dir, 'agents.json')), false)

    const r = runCli(['setup', '--agents', 'codex', '--lead', 'codex'], { cwd: m.base, options: { machineDir: m.dir, assumeHuman: true } })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    const written = JSON.parse(readFileSync(join(m.dir, 'agents.json'), 'utf8'))
    assert.equal(written.lead, 'codex')
    assert.deepEqual(written.agents.map((a) => a.id), ['codex'])
    assert.ok(existsSync(join(m.dir, 'briefings', 'codex.md')), 'the briefing it points at is next to it')
    assert.equal(readFileSync(join(m.dir, 'policy.json.keep'), 'utf8'), 'mine\n')
  } finally {
    m.cleanup()
  }
})

test('single_vendor: the same agent reviews in a separate session, recorded as such, and gated tasks can close', async () => {
  const m = machine({ ...ONLY_CODEX, review_mode: 'single_vendor' })
  const sbx = sandbox()
  try {
    const codex = createApi({ agentId: 'codex', roots: sbx.roots, machineDir: m.dir, registryDir: join(m.base, 'no-registry') })
    const task = await codex.createTask({ title: 'Solo work', action: 'edit a file', spec: { ux_impact: 'HIGH' } })
    await codex.claimTask({ task_id: task.id })
    const review = await codex.requestReview({ task_id: task.id })
    assert.equal(review.routed_to, 'codex')
    assert.equal(review.review.independence, 'same_agent_separate_session')
    await codex.submitReview({ review_id: review.review.id, verdict: 'approved', summary: 'Separate session: re-read the diff and ran the tests.' })
    await assert.rejects(codex.completeTask({ task_id: task.id }), /ux_reviewer/, 'the UX gate still applies')
    const ux = await codex.requestReview({ task_id: task.id, reviewer_role: 'ux_reviewer', slot: 'ui', blocking: false })
    assert.equal(ux.routed_to, 'codex')
    await codex.submitReview({ review_id: ux.review.id, verdict: 'approved', summary: 'Separate session: flows checked.' })
    assert.equal((await codex.completeTask({ task_id: task.id })).status, 'completed')
  } finally {
    m.cleanup()
    sbx.cleanup()
  }
})

test('cross_vendor stays strict: with one agent a review has nobody to go to', async () => {
  const m = machine({ ...ONLY_CODEX, review_mode: 'cross_vendor' })
  const sbx = sandbox()
  try {
    const codex = createApi({ agentId: 'codex', roots: sbx.roots, machineDir: m.dir, registryDir: join(m.base, 'no-registry') })
    const task = await codex.createTask({ title: 'Strict work', action: 'edit a file' })
    await codex.claimTask({ task_id: task.id })
    await assert.rejects(codex.requestReview({ task_id: task.id }), (e) => e.code === 'NO_AGENT_AVAILABLE')
    await assert.rejects(codex.requestReview({ task_id: task.id, reviewer_agent: 'codex' }), (e) => e.code === 'SELF_REVIEW')
  } finally {
    m.cleanup()
    sbx.cleanup()
  }
})

test('setup sets single_vendor for one vendor, cross_vendor for several, and --single-vendor forces it', () => {
  const builtin = loadConfigFrom(DEFAULT_CONFIG_DIR, { kind: 'builtin' })
  const ids = builtin.agents.agents.map((a) => a.id)
  const plan = (include, singleVendor) => planComposition({ catalog: builtin.agents, roleDefs: builtin.roles.roles, include, lead: include[0], singleVendor })
  assert.equal(plan([ids[1]]).content.review_mode, 'single_vendor')
  assert.equal(plan(ids).content.review_mode, 'cross_vendor')
  assert.equal(plan(ids, true).content.review_mode, 'single_vendor')
})

test('check-config checks the machine composition', () => {
  const m = machine({ ...ONLY_CODEX, lead: 'nobody' })
  try {
    const r = runCli(['check-config'], { cwd: m.base, options: { machineDir: m.dir, registryDir: join(m.base, 'no-registry') } })
    assert.equal(r.status, 1)
    assert.match(r.stdout, /machine composition[\s\S]*lead "nobody"/)
  } finally {
    m.cleanup()
  }
})
