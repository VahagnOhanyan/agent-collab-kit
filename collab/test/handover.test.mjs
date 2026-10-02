// Tasks of an agent the owner took out of the composition: each goes to an agent that holds its role (the one with
// the fewest open tasks, the lead on a tie), or back to the queue when nobody holds it — wherever a session opens.
// Never while the excluded agent's lease is live (its session may still be working), never to a pending reviewer of
// the task, and a pending review of an excluded reviewer goes to another vendor's reviewer.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

import { createApi } from '../src/api.mjs'
import { loadConfigFrom } from '../src/registry.mjs'
import { sandbox, tempDir, writeJson } from './helpers.mjs'

const CAPS = Object.keys(loadConfigFrom().capabilities.capabilities)
const BRIEFING = 'A test agent. It reads the journal, takes work and answers reviews like any other agent here.'
const agent = (id, provider, roles) => ({ id, name: id, provider, briefing: BRIEFING, capabilities: CAPS, roles })
const machine = () => ({ home: '/nowhere', platform: 'darwin', which: (b) => `/usr/bin/${b}`, exists: () => false, read: () => null })
// Two hours on: every lease taken "now" (one hour) has lapsed.
const LATER = Object.freeze({ now: () => Date.now() + 2 * 3600 * 1000, iso: () => new Date(Date.now() + 2 * 3600 * 1000).toISOString() })

function world() {
  const base = tempDir('collab-handover-')
  const sbx = sandbox()
  const machineDir = join(base, 'machine')
  const compose = (agents, lead = 'claude') => writeJson(join(machineDir, 'agents.json'), { lead, review_mode: 'cross_vendor', agents })
  const api = (id, { later = false } = {}) => createApi({ agentId: id, roots: sbx.roots, machineDir, registryDir: join(base, 'no-registry'), probeEnv: machine(), ...(later ? { clock: LATER } : {}) })
  return { compose, api, cleanup: () => { rmSync(base, { recursive: true, force: true }); sbx.cleanup() } }
}

const BOTH = ['software_engineer', 'code_reviewer']
const three = () => [agent('claude', 'anthropic', BOTH), agent('codex', 'openai', BOTH), agent('gemini', 'google', [...BOTH, 'researcher'])]
const withoutGemini = () => three().filter((a) => a.id !== 'gemini')

async function taskHeldBy(api, id, role) {
  const held = api(id)
  const task = await held.createTask({ title: `Work for ${role}`, role, action: 'edit a file' })
  await held.claimTask({ task_id: task.id })
  return task.id
}

test('a task of an agent taken out goes, once its lease lapsed, to the role holder with the fewest open tasks, as assigned, with a record', async () => {
  const w = world()
  try {
    w.compose(three())
    const busy = await taskHeldBy(w.api, 'claude', 'software_engineer')
    const left = await taskHeldBy(w.api, 'gemini', 'software_engineer')
    w.compose(withoutGemini())
    // Right now its lease is live: the excluded session may still be working on it, so it is not taken away.
    const now = await w.api('claude').handOverFromAbsent()
    assert.deepEqual(now.kept.map((k) => [k.id, k.why]), [[left, 'lease']])
    const result = await w.api('claude', { later: true }).handOverFromAbsent()
    assert.deepEqual(result.handed_over.map((h) => [h.id, h.from, h.to, h.status]), [[left, 'gemini', 'codex', 'assigned']])
    const task = await w.api('codex').getTask({ task_id: left })
    assert.deepEqual([task.owner, task.status], ['codex', 'assigned'])
    assert.equal(task.contributors.includes('gemini'), false, 'the one who left is no longer a contributor')
    assert.ok(w.api('codex').events({}).some((e) => e.type === 'task.handed_over' && e.data?.from === 'gemini'), 'the journal says who it came from')
    assert.equal((await w.api('claude').getTask({ task_id: busy })).owner, 'claude', 'tasks of agents still in the composition stay')
    assert.deepEqual((await w.api('claude', { later: true }).handOverFromAbsent()).handed_over, [], 'a second pass has nothing to do')
  } finally {
    w.cleanup()
  }
})

test('on a tie the lead takes it; a role nobody holds sends the task back to the queue; a blocked task stays blocked', async () => {
  const w = world()
  try {
    w.compose(three(), 'codex')
    // A writing role: gemini cannot hold a reviewer role at all (no launch that cannot write).
    const tie = await taskHeldBy(w.api, 'gemini', 'software_engineer')
    const orphan = await taskHeldBy(w.api, 'gemini', 'researcher')
    const blocked = await taskHeldBy(w.api, 'gemini', 'software_engineer')
    await w.api('gemini').blockTask({ task_id: blocked, reason: 'Waiting for the owner to choose the API shape.' })
    w.compose(withoutGemini(), 'codex')
    const result = await w.api('claude', { later: true }).handOverFromAbsent()
    assert.deepEqual(result.queued.map((q) => [q.id, q.role]), [[orphan, 'researcher']])
    assert.equal(result.handed_over.find((h) => h.id === tie).to, 'codex')
    const queued = await w.api('claude').getTask({ task_id: orphan })
    assert.deepEqual([queued.owner, queued.status], [null, 'created'])
    const still = await w.api('claude').getTask({ task_id: blocked })
    assert.equal(still.status, 'blocked', 'the reason it was blocked has not gone away')
    assert.notEqual(still.owner, 'gemini')
  } finally {
    w.cleanup()
  }
})

test('a pending review of an excluded reviewer goes to another vendor\'s reviewer; the new holder is never the task\'s reviewer', async () => {
  const w = world()
  try {
    // At the time of the request only codex reviews (gemini, the author, cannot: it has no review launch).
    const writer = (id, provider) => agent(id, provider, ['software_engineer'])
    w.compose([writer('gemini', 'google'), writer('claude', 'anthropic'), agent('codex', 'openai', BOTH)])
    const task = await taskHeldBy(w.api, 'gemini', 'software_engineer')
    await w.api('gemini').requestReview({ task_id: task, reviewer_role: 'code_reviewer' })
    assert.equal((await w.api('gemini').listReviews({ task_id: task })).at(-1).reviewer, 'codex')
    // codex leaves; claude now reviews too.
    w.compose([writer('gemini', 'google'), agent('claude', 'anthropic', BOTH)])
    const result = await w.api('claude', { later: true }).handOverFromAbsent()
    assert.deepEqual(result.reviews.map((r) => [r.from, r.to]), [['codex', 'claude']], 'not the author (gemini): another vendor')
    assert.equal((await w.api('claude').listReviews({ task_id: task })).at(-1).reviewer, 'claude')
    assert.ok(w.api('claude').events({}).some((e) => e.type === 'review.handed_over'))
  } finally {
    w.cleanup()
  }
})

test('it happens by itself in a session: the first listing of tasks after the lease lapsed hands them over', async () => {
  const w = world()
  try {
    w.compose(three())
    const left = await taskHeldBy(w.api, 'gemini', 'software_engineer')
    w.compose(withoutGemini())
    await w.api('codex', { later: true }).getMessages({})
    assert.notEqual((await w.api('codex').getTask({ task_id: left })).owner, 'gemini')
  } finally {
    w.cleanup()
  }
})
