// `collab setup` — the offer/apply logic, tested as pure functions so none of
// this needs PATH, a TTY or a registered project. The interactive wrapper
// (barriers, prompts, wiring to describeProject) is covered in cli.test.mjs by
// the two refusal paths only, same as approve/init --adopt: the positive path
// through a real terminal isn't something a spawned test process has.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { applyAgentSetup, planAgentSetup, writeProjectAgentsFile } from '../src/registry.mjs'
import { tempDir } from './helpers.mjs'

const BUILTIN = {
  defaults: { lease_seconds: 3600, heartbeat_stale_seconds: 900 },
  agents: [
    { id: 'claude', name: 'Claude Code', provider: 'anthropic', roles: ['architect'], capabilities: ['read_code'], adapter: { kind: 'manual' } },
    { id: 'codex', name: 'Codex CLI', provider: 'openai', roles: ['software_engineer'], capabilities: ['read_code'], adapter: { kind: 'cli', binary: 'codex', enabled: false } },
    { id: 'gemini', name: 'Gemini', provider: 'google', roles: ['software_engineer'], capabilities: ['read_code'], adapter: { kind: 'cli', binary: 'agy', enabled: false } }
  ]
}

test('planAgentSetup offers to add a reachable agent missing from the project', () => {
  const offers = planAgentSetup(BUILTIN, null, new Set(['claude', 'codex']))
  assert.deepEqual(
    offers.filter((o) => o.action === 'add').map((o) => o.id),
    ['claude', 'codex']
  )
})

test('planAgentSetup offers to remove a project agent that is no longer reachable', () => {
  const project = { agents: [{ id: 'gemini', name: 'Gemini' }] }
  const offers = planAgentSetup(BUILTIN, project, new Set(['claude', 'codex']))
  const removals = offers.filter((o) => o.action === 'remove')
  assert.deepEqual(removals.map((o) => o.id), ['gemini'])
})

test('planAgentSetup offers nothing once reachability and the project agree', () => {
  const project = { agents: [{ id: 'claude' }, { id: 'codex' }] }
  const offers = planAgentSetup(BUILTIN, project, new Set(['claude', 'codex']))
  assert.deepEqual(offers, [])
})

test('planAgentSetup ignores an unreachable agent the project never listed', () => {
  // gemini: not reachable, not in the project — nothing to ask, it is simply absent.
  const offers = planAgentSetup(BUILTIN, null, new Set(['claude']))
  assert.deepEqual(
    offers.map((o) => o.id),
    ['claude']
  )
})

test('applyAgentSetup adds the built-in entry without its adapter, keeping other project entries untouched', () => {
  const project = {
    '//': 'existing comment',
    defaults: { lease_seconds: 999, heartbeat_stale_seconds: 999 },
    agents: [{ id: 'claude', name: 'Claude Code', roles: ['ios_engineer'], briefing: 'custom, hand-edited' }]
  }
  const updated = applyAgentSetup(BUILTIN, project, [{ id: 'codex', action: 'add' }])

  assert.equal(updated['//'], 'existing comment', 'unrelated top-level keys must survive untouched')
  assert.deepEqual(updated.defaults, { lease_seconds: 999, heartbeat_stale_seconds: 999 }, 'existing defaults must not be overwritten by the built-in ones')

  const claude = updated.agents.find((a) => a.id === 'claude')
  assert.equal(claude.briefing, 'custom, hand-edited', 'the existing, hand-customised entry must not be touched')

  const codex = updated.agents.find((a) => a.id === 'codex')
  assert.ok(codex, 'the added entry must be present')
  assert.equal(codex.adapter, undefined, 'adapter must never be written into a project override')

  assert.deepEqual(project.agents.map((a) => a.id), ['claude'], 'the input object must not be mutated')
})

test('applyAgentSetup removes an entry by id and leaves the rest alone', () => {
  const project = { agents: [{ id: 'claude' }, { id: 'gemini' }] }
  const updated = applyAgentSetup(BUILTIN, project, [{ id: 'gemini', action: 'remove' }])
  assert.deepEqual(updated.agents.map((a) => a.id), ['claude'])
})

test('applyAgentSetup builds a fresh skeleton with the usual comment keys when the project has no file yet', () => {
  const updated = applyAgentSetup(BUILTIN, null, [{ id: 'claude', action: 'add' }])
  assert.ok(updated['//'])
  assert.ok(updated['//briefing'])
  assert.ok(updated['//adapter'])
  assert.deepEqual(updated.defaults, BUILTIN.defaults)
  assert.deepEqual(updated.agents.map((a) => a.id), ['claude'])
})

test('writeProjectAgentsFile writes formatted JSON with a trailing newline and creates missing directories', () => {
  const base = tempDir('collab-setup-')
  try {
    const path = join(base, 'projects', 'demo', 'collab', 'agents.json')
    writeProjectAgentsFile(path, { agents: [{ id: 'claude' }] })
    assert.ok(existsSync(path))
    const text = readFileSync(path, 'utf8')
    assert.ok(text.endsWith('\n'))
    assert.deepEqual(JSON.parse(text), { agents: [{ id: 'claude' }] })
  } finally {
    // tempDir() fixtures elsewhere clean up via sandbox().cleanup; this one has
    // no api/journal attached, so remove it directly.
    rmSync(base, { recursive: true, force: true })
  }
})
