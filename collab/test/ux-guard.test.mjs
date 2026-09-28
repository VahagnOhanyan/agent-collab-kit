// UX Guard: ux_impact is a fourth reading in the spec, and a HIGH (or MEDIUM
// with needs_ux_critic) task cannot be completed until the ux_reviewer role has
// approved it without a proven blocker/major — on both ways into `completed`.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { UX_DOMAINS, UX_IMPACT, normaliseSpec } from '../src/domain/spec.mjs'
import { CODES } from '../src/errors.mjs'
import { UX_DOMAINS as TOOL_UX_DOMAINS, UX_IMPACT as TOOL_UX_IMPACT } from '../src/mcp/tools.mjs'
import { DEFAULT_CONFIG_DIR } from '../src/paths.mjs'
import { createRegistry, loadConfigFrom, validateRegistry } from '../src/registry.mjs'
import { FIXTURE_AGENTS, FIXTURE_ROLES, KIT_REGISTRY, apis, sandbox, writeJson } from './helpers.mjs'

const CONFIG = { models: { levels: { L0: {}, L1: {}, L2: {}, L3: {} } } }

function uxSandbox() {
  const sbx = sandbox()
  const agents = structuredClone(FIXTURE_AGENTS)
  agents.agents.find((a) => a.id === 'codex').roles.push('ux_reviewer')
  const roles = structuredClone(FIXTURE_ROLES)
  roles.roles.ux_reviewer = { summary: 'UX review from diff and screenshots.', requires: ['read_code', 'review_code'] }
  writeJson(join(sbx.configDir, 'agents.json'), agents)
  writeJson(join(sbx.configDir, 'roles.json'), roles)
  return sbx
}

async function claimedTask(claude, spec) {
  const task = await claude.createTask({ title: 'User-facing change', action: 'edit a file', needs_review: false, spec })
  await claude.claimTask({ task_id: task.id })
  return task
}

const refusedByGuard = (e) => e.code === CODES.GUARD_FAILED

test('ux fields: shape is checked, a HIGH that opts out of the critic is refused, a spec without them is unchanged', () => {
  assert.throws(() => normaliseSpec(CONFIG, { ux_impact: 'SEVERE' }), (e) => e.code === CODES.INVALID_INPUT)
  assert.throws(() => normaliseSpec(CONFIG, { ux_domains: ['vibes'] }), (e) => e.code === CODES.INVALID_INPUT)
  assert.throws(() => normaliseSpec(CONFIG, { needs_ux_critic: 'yes' }), (e) => e.code === CODES.INVALID_INPUT)
  assert.throws(
    () => normaliseSpec(CONFIG, { ux_impact: 'HIGH', needs_ux_critic: false }),
    (e) => e.code === CODES.INVALID_INPUT && /cannot be false/.test(e.message)
  )
  assert.throws(
    () => normaliseSpec(CONFIG, { ux_impact: 'HIGH' }, { ux_impact: 'MEDIUM', needs_ux_critic: false }),
    (e) => e.code === CODES.INVALID_INPUT,
    'raising an opted-out MEDIUM to HIGH is the same contradiction'
  )
  assert.deepEqual(
    normaliseSpec(CONFIG, { ux_impact: 'MEDIUM', ux_domains: ['destructive-action', 'destructive-action'], needs_visual_verification: true }),
    { ux_impact: 'MEDIUM', ux_domains: ['destructive-action'], needs_visual_verification: true }
  )
  assert.deepEqual(normaliseSpec(CONFIG, { review_risk: 'L1' }), { review_risk: 'L1' })
})

test('the MCP schema mirrors the spec vocabulary', () => {
  assert.deepEqual(TOOL_UX_IMPACT, [...UX_IMPACT])
  assert.deepEqual(TOOL_UX_DOMAINS, [...UX_DOMAINS])
})

test('HIGH: completion is refused until ux_reviewer approves without a proven blocker/major, on both paths', async () => {
  const sbx = uxSandbox()
  const { claude, codex } = apis(sbx)
  try {
    const task = await claimedTask(claude, { ux_impact: 'HIGH', ux_domains: ['async-feedback'] })

    await assert.rejects(claude.completeTask({ task_id: task.id, summary: 'done' }), refusedByGuard)
    await assert.rejects(claude.updateTask({ task_id: task.id, status: 'completed' }), refusedByGuard)

    const first = await claude.requestReview({ task_id: task.id, reviewer_role: 'ux_reviewer', slot: 'ui', blocking: false })
    assert.equal(first.routed_to, 'codex')
    await codex.submitReview({
      review_id: first.review.id,
      verdict: 'changes_requested',
      summary: 'Progress disappears when the user leaves and returns.',
      findings: [
        {
          severity: 'major',
          file: 'Feature/Export.swift',
          line: 10,
          note: 'no progress after returning to the app',
          evidence: 'screenshot after foregrounding shows an empty state'
        }
      ]
    })
    await assert.rejects(claude.completeTask({ task_id: task.id, summary: 'done' }), refusedByGuard)

    const second = await claude.requestReview({ task_id: task.id, reviewer_role: 'ux_reviewer', slot: 'ui', blocking: false })
    await codex.submitReview({ review_id: second.review.id, verdict: 'approved', summary: 'Checked leave/return, cancel and retry.' })
    assert.equal((await claude.completeTask({ task_id: task.id, summary: 'done' })).status, 'completed')
  } finally {
    sbx.cleanup()
  }
})

test('a MEDIUM that asked for the critic is gated; an unproven major does not block; MEDIUM/LOW/none otherwise complete freely', async () => {
  const sbx = uxSandbox()
  const { claude, codex } = apis(sbx)
  try {
    const gated = await claimedTask(claude, { ux_impact: 'MEDIUM', needs_ux_critic: true })
    await assert.rejects(claude.completeTask({ task_id: gated.id }), refusedByGuard)
    const review = await claude.requestReview({ task_id: gated.id, reviewer_role: 'ux_reviewer', slot: 'ui', blocking: false })
    await codex.submitReview({
      review_id: review.review.id,
      verdict: 'approved',
      summary: 'Fine; one suspicion noted.',
      findings: [{ severity: 'major', note: 'the confirm button might be hard to find' }]
    })
    assert.equal((await claude.completeTask({ task_id: gated.id })).status, 'completed')

    for (const spec of [{ ux_impact: 'MEDIUM' }, { ux_impact: 'LOW' }, { ux_impact: 'NONE' }, null]) {
      const free = await claimedTask(claude, spec)
      assert.equal((await claude.completeTask({ task_id: free.id })).status, 'completed', JSON.stringify(spec))
    }
  } finally {
    sbx.cleanup()
  }
})

test('the built-in and Tripix registries give ux_reviewer to an agent that does not run the app', () => {
  const builtin = loadConfigFrom(DEFAULT_CONFIG_DIR, { kind: 'builtin' })
  assert.deepEqual(validateRegistry(builtin).problems, [])
  assert.deepEqual(builtin.roles.roles.ux_reviewer.requires, ['read_code', 'review_code'])
  assert.deepEqual(createRegistry(builtin).find({ role: 'ux_reviewer' }).map((a) => a.id), ['codex'])

  const dir = join(KIT_REGISTRY, 'tripix')
  if (!existsSync(dir)) return
  const tripix = loadConfigFrom(join(dir, 'collab'), { kind: 'project', id: 'tripix', dir })
  assert.deepEqual(validateRegistry(tripix).problems, [])
  assert.deepEqual(createRegistry(tripix).find({ role: 'ux_reviewer' }).map((a) => a.id), ['codex'])
})
