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
// The second half is the owner's PROPOSED composition (docs/minimax-grok-composition.proposed.json):
// all three agents on this machine, every one of them able to implement, research, decide
// architecture and review. It is applied here the way `collab setup` applies one — written into a
// temporary machine directory, briefings and all, then read back through loadConfig — so what is
// checked is the shipped file and not a fixture resembling it. What must hold: it validates; the
// lead and review mode are the ones the owner chose; nobody holds a role its capabilities do not
// support and the flexible kinds (implementation, research, architecture, review) are all covered
// for everybody; and no agent is ever the only reviewer of its own change. What is deliberately
// NOT checked: that it has been activated anywhere, that any of these clients has run.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { adapterFor } from '../src/adapters/index.mjs'
import { agentLaunchable, rolesItCanHold, writeComposition } from '../src/composition.mjs'
import { independenceReport } from '../src/independence.mjs'
import { DEFAULT_CONFIG_DIR } from '../src/paths.mjs'
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
  assert.deepEqual([worker.level, worker.max_level], ['L1', 'L2'])
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
      ['grok-review', 'grok-4.6', 'L2', 'L3']
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

// ── the owner's proposed composition: three agents, no fixed division of labour ──

const KIT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PROPOSED = join(KIT_ROOT, 'docs', 'minimax-grok-composition.proposed.json')
const ROSTER = ['codex', 'minimax', 'grok']

// The four kinds of work a flexible composition has to leave everybody able to do, by the shape of the
// role catalog rather than by a list of ids: the lead, the routine implementer and the reviewer are
// the same three agents here, so each kind must reach each of them.
const KINDS = {
  architecture: ['architect'],
  implementation: ['software_engineer', 'ios_engineer', 'backend_engineer', 'product_engineer', 'test_engineer'],
  research: ['researcher'],
  review: ['code_reviewer', 'security_reviewer', 'ux_reviewer']
}

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

test('all three can implement, research, decide architecture and review, and nothing more than their capabilities support', () => {
  const world = applied()
  try {
    for (const agent of world.registry.agents()) {
      for (const [kind, roles] of Object.entries(KINDS)) {
        for (const role of roles) {
          assert.ok(agent.roles.includes(role), `${agent.id} cannot do ${kind} (${role}) — the point of the proposal`)
        }
      }
      const permitted = new Set(rolesItCanHold(agent, world.config.roles.roles))
      for (const role of agent.roles) {
        assert.ok(permitted.has(role), `${agent.id} holds ${role}, which its capabilities do not support`)
      }
    }
  } finally {
    world.cleanup()
  }
})

test('no agent is ever its own reviewer: every author has another vendor to send the review to', () => {
  const world = applied()
  try {
    const report = independenceReport({ agents: world.config.agents.agents, roleDefs: world.config.roles.roles })
    assert.deepEqual(report.problems, [], 'every author role has another holder of its reviewing roles')
    assert.equal(report.single_vendor, false, 'three providers, so a same-vendor review is not the fallback being relied on')
    for (const author of world.registry.agents()) {
      const candidates = world.registry.find({ role: 'code_reviewer', exclude: [author.id] })
      assert.deepEqual(
        candidates.map((a) => a.id).sort(),
        ROSTER.filter((id) => id !== author.id).sort(),
        `${author.id}'s work can be reviewed by either of the other two, by nobody else and by not itself`
      )
    }
  } finally {
    world.cleanup()
  }
})
