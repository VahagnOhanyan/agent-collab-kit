// MiniMax and Grok in the built-in catalog: two known clients added as MANUAL,
// never-launched agents, with the model rungs their vendors actually have.
//
// What is proved here, and not by re-reading the strings: both are reachable by hand (the
// headless command) but nothing can start them (manual adapter, no autostart, delivery is the
// inbox); each names its own provider and the binary that identifies it; the pinned MiniMax route
// is ONE rung with no invented second tier and no cross-vendor fallback; the Grok ids are recorded
// as the unverified local-cache evidence they are; and no price, context width or capability is
// guessed for either. The catalog alone still validates — the rest of the registry is covered
// elsewhere, not mirrored here.
//
// The second half is the PROPOSED composition (docs/minimax-grok-composition.proposed.json): Codex
// leads and reviews, MiniMax and Grok implement. It is applied here the way `collab setup` applies
// one — written into a temporary machine directory, briefings and all, then read back through
// loadConfig — so what is checked is the shipped file and not a fixture resembling it. What must
// hold, judged on the FACTS of a machine where all three programs are installed: it validates;
// nobody holds a role its capabilities or the facts rule out; only an agent with a proven
// read-only launch reviews; and no agent is ever the only reviewer of its own change. What is
// deliberately NOT checked: that it has been activated anywhere, that any of these clients has run.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { adapterFor } from '../src/adapters/index.mjs'
import { agentLaunchable, rolesItCanHold, writeComposition } from '../src/composition.mjs'
import { independenceReport } from '../src/independence.mjs'
import { DEFAULT_CONFIG_DIR } from '../src/paths.mjs'
import { factsFor, fitToFacts } from '../src/probe.mjs'
import { briefingPath, checkBriefings, createRegistry, loadConfig, loadConfigFrom, validateRegistry } from '../src/registry.mjs'
import { tempDir } from './helpers.mjs'

const config = loadConfigFrom()
const agentOf = (id) => config.agents.agents.find((a) => a.id === id)
const modelOf = (ref) => config.models.models.find((m) => m.ref === ref)
const allOn = (vendor) => config.models.models.filter((m) => m.vendor === vendor)
const which = (binary) => `/usr/local/bin/${binary}`

test('both are in the catalog as manual clients, each under its own provider and binary', () => {
  for (const [id, provider, detect] of [
    ['minimax', 'minimax', 'minimax-dev'],
    ['grok', 'xai', 'grok']
  ]) {
    const agent = agentOf(id)
    assert.ok(agent, `${id} is in the built-in catalog`)
    assert.deepEqual([agent.provider, agent.detect], [provider, detect])
    assert.equal(agent.adapter.kind, 'manual', 'a manual agent is started by a person, never by the layer')
    assert.equal(agent.adapter.binary, undefined, 'a manual adapter declares no command of its own to spawn')
    assert.equal(agent.adapter.enabled, undefined)
    assert.deepEqual(agent.adapter.headless, [detect], 'the hand-started command is the same one that identifies it')
    assert.deepEqual(agent.adapter.cannot, [], 'nothing is subtracted from the program: what a run may do is the run\'s choice')
    assert.equal(existsSync(briefingPath(config, agent)), true, `${id} has a briefing file to read`)
  }
})

test('nothing starts either of them: delivery is the inbox, and a run begins only from a shell', () => {
  for (const id of ['minimax', 'grok']) {
    const agent = agentOf(id)
    const adapter = adapterFor(agent)
    assert.deepEqual(adapter.probe({ reachable: true, how: 'inbox' }).how, 'inbox', `${id} is reachable, through the journal`)
    assert.equal(adapter.deliver({}).delivered, 'queued', `${id} is delivered as a record, not as a spawned process`)
    // The one thing that does start it: somebody typing its command, which composition reports as a PATH fact.
    assert.equal(agentLaunchable(agent, { which }), `/usr/local/bin/${agent.detect}`)
    assert.equal(agentLaunchable(agent, { which: () => null }), null, 'with no binary on PATH nothing can start it either')
  }
})

test('the pinned MiniMax route is one rung, with no invented second tier and no fallback anywhere', () => {
  const worker = modelOf('minimax-worker')
  assert.equal(worker.id, 'MiniMax-M3.1-Flash-Preview', 'the id is the route the launcher pins')
  assert.equal(worker.vendor, 'minimax')
  // Ceiling L1: a preview route nobody has watched run is not trusted with harder work.
  assert.deepEqual([worker.level, worker.max_level], ['L1', 'L1'])
  assert.equal(worker.maturity, 'preview')
  assert.equal(worker.fallback_policy, 'stop')
  assert.equal(worker.fallback, null, 'there is no other MiniMax route to fall back to, and no GPT one to borrow')
  assert.equal(worker.verified, 'unverified', 'the launcher accepting a route is not a catalog confirming it')
  assert.equal(config.models.vendors.minimax.catalog_file, null, 'nothing on this machine to check the id against')
  assert.equal(allOn('minimax').length, 1, 'one route, one rung — a second tier would be a fiction')
  assert.ok(
    !config.models.models.some((m) => ['minimax', 'xai'].includes(m.vendor) && m.fallback),
    'neither new vendor hands its work to a model on another account, least of all a GPT one'
  )
})

test('the Grok rungs are the local-cache evidence they are: unverified, and no cross-vendor fallback', () => {
  assert.deepEqual(
    allOn('xai').map((m) => [m.ref, m.id, m.level, m.max_level]),
    [
      ['grok-basic', 'grok-4.5', 'L1', 'L2'],
      // Ceiling L2, not L3: the work whose miss costs most is not given to a model never seen to run.
      ['grok-review', 'grok-4.6', 'L2', 'L2']
    ]
  )
  const vendor = config.models.vendors.xai
  assert.equal(vendor.catalog_file, null)
  assert.equal(vendor.verified, 'unverified', 'a refresh that answers 401 confirms nothing')
  for (const model of allOn('xai')) {
    assert.equal(model.verified, 'unverified', `${model.ref} has never been seen running`)
    assert.equal(model.fallback, null, 'no rung leaves its vendor on the quiet')
  }
})

test('no price, context width or capability is claimed for a model nobody has run', () => {
  for (const ref of ['minimax-worker', 'grok-basic', 'grok-review']) {
    const model = modelOf(ref)
    for (const guessed of ['cost_class', 'latency_class', 'context', 'modalities', 'tool_use']) {
      assert.equal(model[guessed], undefined, `${ref}.${guessed} would be a guess, and a guess here reads as a fact`)
    }
  }
})

test('the catalog with both of them is still a registry that validates', () => {
  const { problems } = validateRegistry(config)
  assert.deepEqual(problems, [], 'adding a client must not make the built-in defaults invalid')
})

test('preview requires a real fallback or an explicit stop policy', () => {
  const copy = structuredClone(config)
  const model = copy.models.models.find((m) => m.ref === 'minimax-worker')
  delete model.fallback_policy
  assert.ok(validateRegistry(copy).problems.some((p) => p.includes('preview with no fallback')))
  model.fallback_policy = 'automatic'
  assert.ok(validateRegistry(copy).problems.some((p) => p.includes('unsupported fallback_policy')))
  model.fallback_policy = 'stop'
  model.fallback = 'grok-basic'
  assert.ok(validateRegistry(copy).problems.some((p) => p.includes('cannot combine fallback_policy')))
  model.fallback = null
  assert.deepEqual(validateRegistry(copy).problems, [])
})

// ── the proposed composition: Codex leads and reviews, MiniMax and Grok implement ──

const KIT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PROPOSED = join(KIT_ROOT, 'docs', 'minimax-grok-composition.proposed.json')
const ROSTER = ['codex', 'minimax', 'grok']
const REVIEWER_ROLES = ['code_reviewer', 'security_reviewer', 'ux_reviewer']
const WRITING_ROLES = ['software_engineer', 'ios_engineer', 'backend_engineer', 'product_engineer', 'test_engineer', 'architect']
// A machine where all three programs are on PATH: the facts, not the file, decide what each may hold.
const MACHINE = { home: '/nowhere', platform: 'darwin', which: (b) => `/usr/local/bin/${b}`, exists: () => false, read: () => null }

// The file the owner would apply, as a composition this machine would really hold.
function applied() {
  const base = tempDir('collab-proposed-composition-')
  const dir = join(base, 'machine')
  const proposed = JSON.parse(readFileSync(PROPOSED, 'utf8'))
  // The real write path, not a hand-made directory: agents.json plus the briefings it points at.
  writeComposition(dir, proposed, { catalogDir: DEFAULT_CONFIG_DIR })
  const loaded = loadConfig({ machineDir: dir, registryDir: join(base, 'no-registry') })
  return { config: loaded, registry: createRegistry(loaded), cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

test('the proposed composition is a registry that validates once it is a machine composition', () => {
  const world = applied()
  try {
    assert.deepEqual(validateRegistry(world.config).problems, [], 'the file must be applicable as it stands')
    assert.deepEqual(checkBriefings(world.config), [], 'every briefing_file resolves to a file that is there')
    assert.deepEqual(world.config.agents.agents.map((a) => a.id), ROSTER)
    assert.equal(world.config.agents.lead, 'codex')
    assert.equal(world.config.agents.review_mode, 'cross_vendor', 'cross_vendor is what makes self-review unreachable')
    // Adapters are not the owner's to write: the composition carries none and the built-in ones stay in force.
    for (const agent of world.registry.agents()) {
      const builtin = config.agents.agents.find((a) => a.id === agent.id)
      assert.deepEqual(agent.adapter, builtin.adapter, `${agent.id} runs on its built-in adapter, whatever the composition says`)
    }
  } finally {
    world.cleanup()
  }
})

test('nobody holds a role its capabilities do not support, and the facts of the machine take nothing away', () => {
  const world = applied()
  try {
    const facts = factsFor(world.config.agents.agents, { roleDefs: world.config.roles.roles, capabilityIds: Object.keys(world.config.capabilities.capabilities), env: MACHINE })
    for (const agent of world.registry.agents()) {
      const permitted = new Set(rolesItCanHold(agent, world.config.roles.roles))
      for (const role of agent.roles) {
        assert.ok(permitted.has(role), `${agent.id} holds ${role}, which its capabilities do not support`)
        assert.ok(facts[agent.id].allowed.includes(role), `${agent.id} holds ${role}, which the facts take away: ${JSON.stringify(facts[agent.id].blocked.find((b) => b.role === role)?.reasons)}`)
      }
    }
  } finally {
    world.cleanup()
  }
})

test('only an agent with a proven read-only launch reviews: Codex reviews, MiniMax and Grok implement', () => {
  const world = applied()
  try {
    const facts = factsFor(world.config.agents.agents, { roleDefs: world.config.roles.roles, capabilityIds: Object.keys(world.config.capabilities.capabilities), env: MACHINE })
    for (const id of ['minimax', 'grok']) {
      for (const role of REVIEWER_ROLES) assert.ok(facts[id].blocked.some((b) => b.role === role), `${id} cannot hold ${role} without a review launch`)
    }
    const byId = Object.fromEntries(world.config.agents.agents.map((a) => [a.id, a]))
    assert.deepEqual(byId.codex.roles.filter((r) => REVIEWER_ROLES.includes(r)).sort(), [...REVIEWER_ROLES].sort())
    assert.deepEqual(byId.codex.roles.filter((r) => WRITING_ROLES.includes(r)), [], 'the only reviewer writes nothing: its own work would have no reviewer')
  } finally {
    world.cleanup()
  }
})

test('no agent is ever its own reviewer, judged on the composition the machine would actually hold', () => {
  const world = applied()
  try {
    const roleDefs = world.config.roles.roles
    const facts = factsFor(world.config.agents.agents, { roleDefs, capabilityIds: Object.keys(world.config.capabilities.capabilities), env: MACHINE })
    // What the facts leave, not what the file promises.
    const held = fitToFacts(world.config.agents.agents, facts)
    const report = independenceReport({ agents: held, roleDefs })
    assert.deepEqual(report.problems, [], 'every author role has another holder of its reviewing roles')
    assert.equal(report.single_vendor, false, 'three providers, so a same-vendor review is not the fallback being relied on')
    for (const author of ['minimax', 'grok']) {
      const reviewers = held.filter((a) => a.id !== author && a.roles.includes('code_reviewer')).map((a) => a.id)
      assert.deepEqual(reviewers, ['codex'], `${author}'s work goes to codex for review, and to nobody without a read-only launch`)
    }
  } finally {
    world.cleanup()
  }
})

test('fallback_policy "stop" is kept by the journal: a fall-back from such a model is refused', async () => {
  const { apis, sandbox } = await import('./helpers.mjs')
  const sbx = sandbox()
  const { claude } = apis(sbx)
  try {
    const task = await claude.createTask({ title: 'Bounded work', action: 'edit a file' })
    await claude.claimTask({ task_id: task.id })
    await assert.rejects(
      async () => claude.addDelegation({ task_id: task.id, to: 'implementer', model: 'grok-basic', purpose: 'Bounded implementation after the pinned route failed.', fallback_from: 'minimax-worker' }),
      (e) => e.code === 'INVALID_INPUT' && /fallback_policy "stop"/.test(e.message)
    )
    // A model with no such policy may still record a fall-back.
    const ok = await claude.addDelegation({ task_id: task.id, to: 'implementer', model: 'sol', purpose: 'Bounded implementation on the next model.', fallback_from: 'terra' })
    assert.ok(ok)
  } finally {
    sbx.cleanup()
  }
})
