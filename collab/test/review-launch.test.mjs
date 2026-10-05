// Only an agent with a launch that cannot write reviews (owner, 02.10.2026). The rule is in the facts (probe.mjs);
// these tests close the ways around it an independent review found: a project roles.json, a program that is not
// here, a platform the launch was not written for, asking by name, asking by capability, and a review pending since
// before the reviewer lost its role.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { createApi } from '../src/api.mjs'
import { CODES } from '../src/errors.mjs'
import { probeAgent } from '../src/probe.mjs'
import { loadBuiltinAgents, loadConfigFrom } from '../src/registry.mjs'
import { rolesWithoutReadOnly, sandbox, tempDir, writeJson } from './helpers.mjs'

const CAPS = Object.keys(loadConfigFrom().capabilities.capabilities)
const agentOf = (id) => loadBuiltinAgents().agents.find((a) => a.id === id)
const BRIEFING = 'A test agent. It reads the journal, takes work and answers reviews like any other agent here.'
const agent = (id, provider, roles) => ({ id, name: id, provider, briefing: BRIEFING, capabilities: CAPS, roles })
const machine = ({ binaries = null, platform = 'darwin' } = {}) => ({
  home: '/nowhere',
  platform,
  which: (b) => (!binaries || binaries.includes(b) ? `/usr/bin/${b}` : null),
  exists: () => false,
  read: () => null
})
const BOTH = ['software_engineer', 'code_reviewer']

function world() {
  const base = tempDir('collab-review-launch-')
  const sbx = sandbox()
  const machineDir = join(base, 'machine')
  const compose = (agents) => writeJson(join(machineDir, 'agents.json'), { lead: 'claude', review_mode: 'cross_vendor', agents })
  const api = (id) => createApi({ agentId: id, roots: sbx.roots, machineDir, registryDir: join(base, 'no-registry'), probeEnv: machine() })
  return { api, compose, machineDir, roots: sbx.roots, registryDir: join(base, 'no-registry'), cleanup: () => { rmSync(base, { recursive: true, force: true }); sbx.cleanup() } }
}

async function workedTask(api, id) {
  const task = await api(id).createTask({ title: 'Work to review', role: 'software_engineer', action: 'edit a file' })
  await api(id).claimTask({ task_id: task.id })
  return task.id
}

test('a project roles.json cannot make a reviewer role writable: read_only is raised back, and said', () => {
  const dir = tempDir('collab-roles-')
  try {
    mkdirSync(dir, { recursive: true })
    writeJson(join(dir, 'roles.json'), rolesWithoutReadOnly())
    const config = loadConfigFrom([dir], { kind: 'registry', dir })
    for (const id of ['code_reviewer', 'ux_reviewer', 'security_reviewer']) assert.equal(config.roles.roles[id].read_only, true, id)
    assert.ok(config.meta.warnings.some((w) => /role "code_reviewer" is read-only/.test(w)))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a launch that cannot run here is no launch: the program missing, or another platform', () => {
  assert.equal(probeAgent(agentOf('codex'), CAPS, machine({ binaries: ['claude'] })).review_launch.status, 'missing')
  const windows = probeAgent(agentOf('claude'), CAPS, machine({ platform: 'win32' })).review_launch
  assert.equal(windows.status, 'missing')
  assert.match(windows.reason, /win32/)
  assert.equal(probeAgent(agentOf('claude'), CAPS, machine()).review_launch.status, 'confirmed')
})

test('asking by name or by capability does not route a review to an agent with no reviewer role', async () => {
  const w = world()
  try {
    // cursor is given code_reviewer in the composition, and the facts take it away: no review launch.
    w.compose([agent('claude', 'anthropic', BOTH), agent('cursor', 'cursor', BOTH)])
    const task = await workedTask(w.api, 'claude')
    await assert.rejects(w.api('claude').requestReview({ task_id: task, reviewer_agent: 'cursor' }), (e) => e.code === CODES.NOT_PERMITTED && /cursor holds no read-only reviewer role/.test(e.message))
    await assert.rejects(w.api('claude').requestReview({ task_id: task, reviewer_capability: 'review_code' }), (e) => e.code === CODES.NO_AGENT_AVAILABLE)
    await assert.rejects(w.api('claude').requestReview({ task_id: task }), (e) => e.code === CODES.NO_AGENT_AVAILABLE)
  } finally {
    w.cleanup()
  }
})

test('a review pending since before the reviewer lost its role cannot be answered by it', async () => {
  const w = world()
  try {
    w.compose([agent('claude', 'anthropic', ['software_engineer']), agent('codex', 'openai', BOTH)])
    const task = await workedTask(w.api, 'claude')
    const review = await w.api('claude').requestReview({ task_id: task })
    assert.equal(review.routed_to, 'codex')
    // The owner takes code_reviewer away from codex; the pending review is still addressed to it.
    w.compose([agent('claude', 'anthropic', ['software_engineer']), agent('codex', 'openai', ['software_engineer'])])
    await assert.rejects(
      w.api('codex').submitReview({ review_id: review.review.id, verdict: 'approved', summary: 'Read the diff.' }),
      (e) => e.code === CODES.NOT_PERMITTED && /release_review/.test(e.message)
    )
  } finally {
    w.cleanup()
  }
})

test('a suspended reviewer role does not route a review, by name or otherwise, and does not answer one', async () => {
  const w = world()
  try {
    w.compose([agent('claude', 'anthropic', ['software_engineer']), agent('codex', 'openai', BOTH)])
    const task = await workedTask(w.api, 'claude')
    const pending = await w.api('claude').requestReview({ task_id: task })
    assert.equal(pending.routed_to, 'codex')
    await w.api('codex').suspendRole({ role: 'code_reviewer', reason: 'My read-only launch fails on this machine today.' })
    await assert.rejects(
      w.api('codex').submitReview({ review_id: pending.review.id, verdict: 'approved', summary: 'Read the diff.' }),
      (e) => e.code === CODES.NOT_PERMITTED
    )
    const other = await workedTask(w.api, 'claude')
    await assert.rejects(w.api('claude').requestReview({ task_id: other, reviewer_agent: 'codex' }), (e) => e.code === CODES.NOT_PERMITTED)
  } finally {
    w.cleanup()
  }
})

test('a review asked by capability is handed over only to a reviewer, never to an agent with no review launch', async () => {
  const w = world()
  try {
    const writer = (id, provider) => agent(id, provider, ['software_engineer'])
    w.compose([writer('claude', 'anthropic'), agent('codex', 'openai', BOTH), agent('cursor', 'cursor', BOTH)])
    const task = await workedTask(w.api, 'claude')
    const review = await w.api('claude').requestReview({ task_id: task, reviewer_capability: 'review_code' })
    assert.equal(review.routed_to, 'codex')
    // codex leaves; cursor still lists code_reviewer in the composition, but the facts take it away.
    w.compose([writer('claude', 'anthropic'), agent('cursor', 'cursor', BOTH)])
    const later = createApi({ agentId: 'claude', roots: w.roots, machineDir: w.machineDir, registryDir: w.registryDir, probeEnv: machine(), clock: { now: () => Date.now() + 7200e3, iso: () => new Date(Date.now() + 7200e3).toISOString() } })
    const result = await later.handOverFromAbsent()
    assert.deepEqual(result.reviews.map((r) => [r.from, r.to]), [['codex', null]], 'nobody safe to take it: it stays, to be released')
  } finally {
    w.cleanup()
  }
})

test('a configuration with no read-only role lets nobody review, rather than everybody', async () => {
  const w = world()
  try {
    // A project roles file that replaced the roles and left every reviewer role out.
    const roles = rolesWithoutReadOnly()
    for (const id of ['code_reviewer', 'ux_reviewer', 'security_reviewer']) delete roles.roles[id]
    for (const role of Object.values(roles.roles)) role.reviewed_by = (role.reviewed_by || []).filter((r) => roles.roles[r])
    writeJson(join(w.machineDir, 'roles.json'), roles)
    w.compose([agent('claude', 'anthropic', ['software_engineer']), agent('gemini', 'google', ['software_engineer', 'test_engineer'])])
    const task = await workedTask(w.api, 'claude')
    await assert.rejects(w.api('claude').requestReview({ task_id: task, reviewer_capability: 'review_code' }), (e) => e.code === CODES.NO_AGENT_AVAILABLE)
    await assert.rejects(w.api('claude').requestReview({ task_id: task, reviewer_agent: 'gemini' }), (e) => e.code === CODES.NOT_PERMITTED)
  } finally {
    w.cleanup()
  }
})
