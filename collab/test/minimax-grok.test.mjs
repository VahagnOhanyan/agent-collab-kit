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

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync } from 'node:fs'

import { adapterFor } from '../src/adapters/index.mjs'
import { agentLaunchable } from '../src/composition.mjs'
import { briefingPath, loadConfigFrom, validateRegistry } from '../src/registry.mjs'

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
