// The protocol, end to end: discovery, tasks, messages, review cycles,
// approvals, concurrency and recovery.
//
// Every test here drives the SAME facade the MCP server exposes, so what passes
// is what an agent would actually get. Where a claim is about two agents racing,
// the test spawns two real processes — a promise race inside one process proves
// only that the in-process queue works.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createApi } from '../src/api.mjs'
import { CODES } from '../src/errors.mjs'
import { fixedClock } from '../src/ids.mjs'
import { resolveApproval } from '../src/domain/approvals.mjs'
import { sandbox } from './helpers.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const API = join(HERE, '..', 'src', 'api.mjs')

// A temp project with an initialised journal and a fixture config dir; nothing
// here depends on any real project's configuration.
function world({ clock } = {}) {
  const sbx = sandbox()
  const shared = clock || fixedClock()
  const make = (agentId) => createApi({ agentId, roots: sbx.roots, configDir: sbx.configDir, clock: shared })
  return {
    dir: sbx.stateDir,
    sbx,
    clock: shared,
    claude: make('claude'),
    codex: make('codex'),
    cleanup: sbx.cleanup
  }
}

// ── discovery ──────────────────────────────────────────────────────────────

test('an agent discovers who can review without knowing any names', async () => {
  const w = world()
  try {
    // This is the shape the whole design turns on: ask for a capability, get an
    // agent. The word "codex" never appears in the request.
    const reviewers = w.claude.findAgents({ role: 'code_reviewer', exclude_self: true })
    assert.equal(reviewers.length, 1)
    assert.ok(reviewers[0].capabilities.includes('review_code'))

    const runners = w.claude.findAgents({ capability: 'run_application' })
    assert.deepEqual(runners.map((a) => a.id), ['claude'], 'only the agent with a simulator holds run_application')

    const nobody = w.claude.findAgents({ role: 'security_reviewer' })
    assert.deepEqual(nobody, [], 'an unheld role answers "nobody", it does not substitute somebody unsuitable')
  } finally {
    w.cleanup()
  }
})

test('whoami tells an agent what it is responsible for', async () => {
  const w = world()
  try {
    const me = w.codex.whoami()
    assert.equal(me.agent_id, 'codex')
    assert.ok(me.roles.includes('code_reviewer'))
    assert.ok(!me.capabilities.includes('run_application'), 'codex cannot drive the app and is told so')
    assert.match(me.briefing, /independent engineer/)
    assert.match(me.how_to_reply, /request_user_approval/)
  } finally {
    w.cleanup()
  }
})

// ── the cooperative workflow ───────────────────────────────────────────────

test('the full cycle: create, claim, review, changes requested, fix, re-review, complete', async () => {
  const w = world()
  try {
    const task = await w.claude.createTask({
      title: 'Analyse the MCP tool registry and propose one safe refactoring',
      description: 'Read-only analysis. Propose exactly one change and say why it is safe.',
      action: 'read backend/mcp/registry.js and summarise it',
      files: ['backend/mcp/registry.js']
    })
    assert.equal(task.status, 'created')
    assert.equal(task.action_class, 'READ_ONLY')
    assert.equal(task.requires_approval, false)

    const claimed = await w.claude.claimTask({ task_id: task.id })
    assert.equal(claimed.claimed, true)
    assert.equal(claimed.task.owner, 'claude')
    assert.equal(claimed.task.status, 'in_progress')

    // Round 1: routed by role, and it must not come back to the author.
    const round1 = await w.claude.requestReview({
      task_id: task.id,
      reviewer_role: 'code_reviewer',
      instructions: 'Is the error mapping complete?'
    })
    assert.equal(round1.routed_to, 'codex')
    assert.equal(w.claude.getTask({ task_id: task.id }).status, 'review')

    // The reviewer finds the request in its own inbox.
    const inbox = await w.codex.getMessages({ unread_only: true })
    assert.equal(inbox.length, 1)
    assert.equal(inbox[0].message_type, 'review_request')
    assert.match(inbox[0].body, new RegExp(round1.review.id))

    const rejected = await w.codex.submitReview({
      review_id: round1.review.id,
      verdict: 'changes_requested',
      summary: 'One path returns an unmapped error.',
      findings: [{ severity: 'major', file: 'backend/mcp/registry.js', line: 60, note: 'A non-Collab error escapes as a throw.' }]
    })
    assert.equal(rejected.task_status, 'changes_requested')

    // The author hears about it in their inbox, not by polling a status field.
    const authorInbox = await w.claude.getMessages({ unread_only: true })
    assert.equal(authorInbox[0].message_type, 'review_response')
    assert.match(authorInbox[0].body, /unmapped error/)

    await w.claude.updateTask({ task_id: task.id, status: 'in_progress', note: 'mapped the escaping error' })

    // Round 2 on the same task — the cycle repeats rather than being one-shot.
    const round2 = await w.claude.requestReview({ task_id: task.id, reviewer_role: 'code_reviewer' })
    assert.equal(round2.review.round, 2)

    const approved = await w.codex.submitReview({
      review_id: round2.review.id,
      verdict: 'approved',
      summary: 'The mapping is complete now. I checked every throw site in the file.'
    })
    assert.equal(approved.task_status, 'approved')

    const done = await w.claude.completeTask({ task_id: task.id, summary: 'Refactoring proposed and reviewed.' })
    assert.equal(done.status, 'completed')

    // The whole history is in the audit log, in order.
    const types = w.claude.events({ limit: 50 }).map((e) => e.type)
    assert.deepEqual(types.slice(0, 4), ['task.created', 'task.claimed', 'review.requested', 'review.submitted'])
    assert.ok(types.includes('task.completed'))
  } finally {
    w.cleanup()
  }
})

test('an agent cannot review its own work, whichever way it asks', async () => {
  const w = world()
  try {
    const task = await w.codex.createTask({ title: 'Codex does some work', action: 'refactor a helper' })
    await w.codex.claimTask({ task_id: task.id })

    let error = null
    try {
      await w.codex.requestReview({ task_id: task.id, reviewer_agent: 'codex' })
    } catch (e) {
      error = e
    }
    assert.equal(error.code, CODES.SELF_REVIEW)

    // And by role: codex is the only code_reviewer, so there is nobody else.
    let byRole = null
    try {
      await w.codex.requestReview({ task_id: task.id, reviewer_role: 'code_reviewer' })
    } catch (e) {
      byRole = e
    }
    assert.equal(byRole.code, CODES.NO_AGENT_AVAILABLE)
    assert.match(byRole.message, /other than codex/)
  } finally {
    w.cleanup()
  }
})

test('a review verdict can only be returned by the agent it was routed to', async () => {
  const w = world()
  try {
    const task = await w.claude.createTask({ title: 'Something to review', action: 'edit a file' })
    await w.claude.claimTask({ task_id: task.id })
    const review = await w.claude.requestReview({ task_id: task.id })

    let error = null
    try {
      await w.claude.submitReview({ review_id: review.review.id, verdict: 'approved', summary: 'looks fine to me' })
    } catch (e) {
      error = e
    }
    assert.equal(error.code, CODES.NOT_PERMITTED)
    assert.match(error.message, /routed to codex, not to claude/)
  } finally {
    w.cleanup()
  }
})

test('changes_requested without findings is refused', async () => {
  const w = world()
  try {
    const task = await w.claude.createTask({ title: 'Work', action: 'edit a file' })
    await w.claude.claimTask({ task_id: task.id })
    const review = await w.claude.requestReview({ task_id: task.id })

    let error = null
    try {
      await w.codex.submitReview({ review_id: review.review.id, verdict: 'changes_requested', summary: 'nope' })
    } catch (e) {
      error = e
    }
    assert.equal(error.code, CODES.GUARD_FAILED)
    assert.match(error.message, /tells the owner nothing/)
  } finally {
    w.cleanup()
  }
})

// ── messages ───────────────────────────────────────────────────────────────

test('a role-addressed message reaches whoever holds the role when it is READ', async () => {
  const w = world()
  try {
    await w.claude.sendMessage({
      to_role: 'test_engineer',
      message_type: 'question',
      subject: 'Fixture question',
      body: 'Does the trip fixture cover a multi-day stay?'
    })
    const forCodex = await w.codex.getMessages({ unread_only: true })
    assert.equal(forCodex.length, 1)
    assert.equal(forCodex[0].to.role, 'test_engineer')
    // Resolution happens at read time against the registry, so the record keeps
    // the selector rather than a frozen recipient list.
    assert.equal(forCodex[0].to.agent, null)

    const forClaude = await w.claude.getMessages({ unread_only: true })
    assert.deepEqual(forClaude, [], 'claude does not hold test_engineer, so it is not addressed')
  } finally {
    w.cleanup()
  }
})

test('a reply lands in the same thread and marks the question answered', async () => {
  const w = world()
  try {
    const question = await w.claude.sendMessage({
      to_agent: 'codex',
      message_type: 'question',
      subject: 'Naming',
      body: 'Should the new field be snake_case on the wire?',
      requires_reply: true
    })
    const reply = await w.codex.replyMessage({ message_id: question.id, body: 'Yes — every other field on that route is.' })

    assert.equal(reply.thread_id, question.thread_id)
    assert.equal(reply.in_reply_to, question.id)
    assert.equal(reply.message_type, 'answer')

    const thread = w.claude.getThread({ thread_id: question.thread_id })
    assert.equal(thread.length, 2)
    assert.equal(w.claude.store.get('messages', question.id).status, 'answered')
    assert.equal(w.claude.store.get('messages', question.id).replied_by, 'codex')
  } finally {
    w.cleanup()
  }
})

test('a message addressed to a role nobody holds is refused rather than lost', async () => {
  const w = world()
  try {
    let error = null
    try {
      await w.claude.sendMessage({ to_role: 'security_reviewer', body: 'Please look at the token handling.' })
    } catch (e) {
      error = e
    }
    assert.equal(error.code, CODES.NO_AGENT_AVAILABLE)
    assert.match(error.message, /would go nowhere/)
  } finally {
    w.cleanup()
  }
})

test('a secret in a message is refused before it is ever written', async () => {
  const w = world()
  try {
    let error = null
    try {
      await w.claude.sendMessage({ to_agent: 'codex', body: 'use this key: sk-ant-abcdefghijklmnopqrstuvwxyz' })
    } catch (e) {
      error = e
    }
    assert.equal(error.code, CODES.SECRET_IN_CONTENT)
    assert.equal(w.claude.store.list('messages').length, 0, 'nothing was written')
  } finally {
    w.cleanup()
  }
})

// ── owner approval ─────────────────────────────────────────────────────────

test('a task that costs money stops at the owner and cannot be completed', async () => {
  const w = world()
  try {
    const task = await w.codex.createTask({
      title: 'Add live flight data',
      action: 'buy a subscription to the flight data API'
    })
    assert.equal(task.action_class, 'FINANCIAL')
    assert.equal(task.requires_approval, true)

    // It cannot even be started without the owner.
    let start = null
    try {
      await w.codex.claimTask({ task_id: task.id })
    } catch (e) {
      start = e
    }
    assert.equal(start.code, CODES.APPROVAL_REQUIRED)

    const approval = await w.codex.requestUserApproval({
      task_id: task.id,
      action: 'buy a subscription to the flight data API',
      reason: 'The free tier does not return live status, which is what the feature needs.',
      cost_estimate: 'about $49/month'
    })
    assert.equal(approval.status, 'pending')
    assert.equal(w.codex.getTask({ task_id: task.id }).status, 'waiting_for_user')

    // Nothing an agent can call moves it on.
    let complete = null
    try {
      await w.codex.completeTask({ task_id: task.id, summary: 'done anyway' })
    } catch (e) {
      complete = e
    }
    assert.ok(complete, 'a task waiting on the owner must not be completable')

    const pending = w.claude.listApprovals({ pending_only: true })
    assert.equal(pending.length, 1)
    assert.equal(pending[0].cost_estimate, 'about $49/month')
  } finally {
    w.cleanup()
  }
})

test('the owner granting an approval unblocks the task; denying it blocks with the reason', async () => {
  const w = world()
  try {
    const granted = await w.codex.createTask({ title: 'Buy it', action: 'buy a subscription to the mapping API' })
    const a1 = await w.codex.requestUserApproval({ task_id: granted.id, action: granted.action, reason: 'needed for tiles' })
    // resolveApproval is reachable only from the CLI, which is why the test
    // imports the domain module directly rather than going through the facade.
    await resolveApproval(w.claude.ctx, { approval_id: a1.id, decision: 'granted', note: 'go ahead', channel: 'test' })
    // Nobody had claimed it, so it goes back into the pool — and the claim that
    // was refused before the owner answered now succeeds. That is the loop closing.
    assert.equal(w.codex.getTask({ task_id: granted.id }).status, 'created')
    const nowAllowed = await w.codex.claimTask({ task_id: granted.id })
    assert.equal(nowAllowed.claimed, true)
    assert.equal(nowAllowed.task.status, 'in_progress')

    const refused = await w.codex.createTask({ title: 'Buy that too', action: 'buy a subscription to the weather API' })
    const a2 = await w.codex.requestUserApproval({ task_id: refused.id, action: refused.action, reason: 'nice to have' })
    await resolveApproval(w.claude.ctx, {
      approval_id: a2.id,
      decision: 'denied',
      note: 'we already pay for this data elsewhere',
      channel: 'test'
    })
    const blocked = w.codex.getTask({ task_id: refused.id })
    assert.equal(blocked.status, 'blocked')
    assert.equal(blocked.blocked_reason, 'we already pay for this data elsewhere')
  } finally {
    w.cleanup()
  }
})

test('the facade exposes no way to resolve an approval', () => {
  const w = world()
  try {
    const names = Object.keys(w.codex)
    assert.ok(!names.some((n) => /resolveApproval|grantApproval|approve/i.test(n)), `facade exposes: ${names.join(', ')}`)
    assert.ok(names.includes('requestUserApproval'))
    assert.ok(names.includes('listApprovals'))
  } finally {
    w.cleanup()
  }
})

// ── disagreement ───────────────────────────────────────────────────────────

test('two agents disagreeing marks a decision disputed, and neither may settle it', async () => {
  const w = world()
  try {
    const decision = await w.claude.createDecision({
      title: 'Where does playback camera state live',
      context: 'Two designs were proposed for the same problem.',
      options: [{ id: 'a', label: 'Camera owns the route' }, { id: 'b', label: 'Route owns the camera' }],
      position: { option: 'a', rationale: 'The camera already owns the animation clock, so it must not outrun geometry.' }
    })
    assert.equal(decision.status, 'open')

    const disputed = await w.codex.addPosition({
      decision_id: decision.id,
      option: 'b',
      rationale: 'The route is the source of truth for geometry and the camera should follow it, not lead.'
    })
    assert.equal(disputed.status, 'disputed', 'a second, different position is a disagreement, not an overwrite')
    assert.equal(disputed.positions.length, 2)

    // Neither side gets to close it by speaking last.
    for (const agent of [w.claude, w.codex]) {
      let error = null
      try {
        await agent.resolveDecision({ decision_id: decision.id, outcome: 'my way', rationale: 'because I said so' })
      } catch (e) {
        error = e
      }
      assert.equal(error.code, CODES.NOT_PERMITTED)
      assert.match(error.message, /cannot also settle it/)
    }

    // It goes to the owner instead.
    const escalated = await w.claude.escalateDecision({ decision_id: decision.id, reason: 'no objective test separates them' })
    assert.equal(escalated.status, 'escalated')
  } finally {
    w.cleanup()
  }
})

test('a position without reasoning is refused — this is not settled by voting', async () => {
  const w = world()
  try {
    const decision = await w.claude.createDecision({ title: 'Something', options: [{ id: 'a' }, { id: 'b' }] })
    let error = null
    try {
      await w.codex.addPosition({ decision_id: decision.id, option: 'b', rationale: 'no' })
    } catch (e) {
      error = e
    }
    assert.equal(error.code, CODES.INVALID_INPUT)
    assert.match(error.message, /not decided by voting/)
  } finally {
    w.cleanup()
  }
})

// ── shared working tree ────────────────────────────────────────────────────

test('two tasks cannot claim the same file, and the error names who holds it', async () => {
  const w = world()
  try {
    const mine = await w.claude.createTask({ title: 'Edit the style sync', action: 'edit a file' })
    await w.claude.claimTask({ task_id: mine.id })
    await w.claude.claimFiles({ task_id: mine.id, paths: ['Tripix/TripMap/Presentation/Core/TripMapView+StyleSync.swift'] })

    const theirs = await w.codex.createTask({ title: 'Also edit the style sync', action: 'edit a file' })
    await w.codex.claimTask({ task_id: theirs.id })

    let error = null
    try {
      await w.codex.claimFiles({ task_id: theirs.id, paths: ['Tripix/TripMap/Presentation/Core/TripMapView+StyleSync.swift'] })
    } catch (e) {
      error = e
    }
    assert.equal(error.code, CODES.PATH_CONFLICT)
    assert.equal(error.details.conflicts[0].task_id, mine.id)
    assert.equal(error.details.conflicts[0].owner, 'claude')
  } finally {
    w.cleanup()
  }
})

test('claiming a directory conflicts with a claim on a file inside it', async () => {
  const w = world()
  try {
    const first = await w.claude.createTask({ title: 'One file', action: 'edit a file' })
    await w.claude.claimTask({ task_id: first.id })
    await w.claude.claimFiles({ task_id: first.id, paths: ['backend/src/domains/trip/tripService.js'] })

    const second = await w.codex.createTask({ title: 'The whole domain', action: 'refactor the domain' })
    await w.codex.claimTask({ task_id: second.id })
    let error = null
    try {
      await w.codex.claimFiles({ task_id: second.id, paths: ['backend/src/domains/trip/'] })
    } catch (e) {
      error = e
    }
    assert.equal(error.code, CODES.PATH_CONFLICT, 'a directory claim must see the file claim inside it')
  } finally {
    w.cleanup()
  }
})

// ── concurrency, with real processes ───────────────────────────────────────

test('two real processes claiming one task: exactly one wins', async () => {
  const w = world({ clock: undefined })
  try {
    const task = await w.claude.createTask({ title: 'Contested work', action: 'edit a file' })
    const script = join(w.dir, 'race.mjs')
    writeFileSync(
      script,
      [
        `import { createApi } from ${JSON.stringify(API)}`,
        'const api = createApi({ agentId: process.argv[2], root: process.argv[3], configDir: process.argv[4] })',
        `const result = await api.claimTask({ task_id: ${JSON.stringify(task.id)} })`,
        'process.stdout.write(JSON.stringify({ agent: process.argv[2], claimed: result.claimed, reason: result.reason || null }))'
      ].join('\n')
    )

    const runOne = (agent) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [script, agent, w.dir, w.sbx.configDir], {
          cwd: w.sbx.root,
          stdio: ['ignore', 'pipe', 'pipe']
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (d) => {
          stdout += d
        })
        child.stderr.on('data', (d) => {
          stderr += d
        })
        child.on('exit', (code) => (code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr))))
      })

    const results = await Promise.all([runOne('claude'), runOne('codex')])
    const winners = results.filter((r) => r.claimed)
    const losers = results.filter((r) => !r.claimed)
    assert.equal(winners.length, 1, `exactly one process may win, got ${JSON.stringify(results)}`)
    assert.equal(losers.length, 1)
    assert.equal(losers[0].reason, CODES.ALREADY_CLAIMED)

    const final = w.claude.getTask({ task_id: task.id })
    assert.equal(final.owner, winners[0].agent)
    assert.equal(final.status, 'in_progress')
  } finally {
    w.cleanup()
  }
})

test('a stale read is refused instead of silently overwriting the other agent', async () => {
  const w = world()
  try {
    const task = await w.claude.createTask({ title: 'Shared', action: 'edit a file' })
    const asRead = w.claude.getTask({ task_id: task.id })

    await w.codex.assignTask({ task_id: task.id, to_agent: 'codex' })

    let error = null
    try {
      await w.claude.updateTask({ task_id: task.id, patch: { title: 'Renamed from stale state' }, expected_version: asRead.version })
    } catch (e) {
      error = e
    }
    assert.equal(error.code, CODES.VERSION_CONFLICT)
    assert.equal(w.claude.getTask({ task_id: task.id }).title, 'Shared', 'the stale write changed nothing')
  } finally {
    w.cleanup()
  }
})

// ── failure and recovery ───────────────────────────────────────────────────

test('work held by an agent that went away becomes claimable again', async () => {
  const clock = fixedClock()
  const w = world({ clock })
  try {
    const task = await w.codex.createTask({ title: 'Half-done work', action: 'edit a file' })
    await w.codex.claimTask({ task_id: task.id, lease_seconds: 60 })
    assert.equal(w.claude.getTask({ task_id: task.id }).owner, 'codex')

    // Codex disappears. Nothing runs, nothing is notified — time simply passes.
    clock.advance(120 * 1000)

    const stale = w.claude.getTask({ task_id: task.id })
    assert.equal(stale.lease_expired, true, 'the lapse is visible without anything having run')
    assert.equal(stale.claimable, true)

    // Another agent picks it up, and the audit log says why it changed hands.
    const taken = await w.claude.claimTask({ task_id: task.id })
    assert.equal(taken.claimed, true)
    assert.equal(taken.task.owner, 'claude')
    const types = w.claude.events({ limit: 20 }).map((e) => e.type)
    assert.ok(types.includes('task.lease_expired'))
  } finally {
    w.cleanup()
  }
})

test('sweep releases abandoned work and marks the silent agent offline', async () => {
  const clock = fixedClock()
  const w = world({ clock })
  try {
    const task = await w.codex.createTask({ title: 'Abandoned', action: 'edit a file' })
    await w.codex.claimTask({ task_id: task.id, lease_seconds: 60 })
    clock.advance(2000 * 1000)

    const result = await w.claude.sweep()
    assert.deepEqual(result.released, [task.id])
    assert.deepEqual(result.marked_offline, ['codex'])

    const released = w.claude.getTask({ task_id: task.id })
    assert.equal(released.status, 'created')
    assert.equal(released.owner, null)
    assert.equal(w.claude.getAgent({ agent_id: 'codex' }).runtime.effective_status, 'offline')
  } finally {
    w.cleanup()
  }
})

test('a task waiting on a reviewer is NOT swept, however long it waits', async () => {
  // Found in the wild on 2026-09-10: a task sat in `review` overnight, the
  // sweep judged it abandoned because its lease had lapsed, and released it to
  // `created`. The reviewer then had to push it back through `in_progress`
  // before it could answer a review that had been pending the whole time.
  // A lease means "somebody is working right now"; waiting for somebody else is
  // not that.
  const clock = fixedClock()
  const w = world({ clock })
  try {
    const task = await w.claude.createTask({ title: 'Waiting on a reviewer', action: 'edit a file' })
    await w.claude.claimTask({ task_id: task.id, lease_seconds: 60 })
    const review = await w.claude.requestReview({ task_id: task.id })
    assert.equal(w.claude.getTask({ task_id: task.id }).status, 'review')

    clock.advance(48 * 3600 * 1000) // two days

    const parked = w.claude.getTask({ task_id: task.id })
    assert.equal(parked.status, 'review', 'it is still under review')
    assert.equal(parked.lease_expired, false, 'a parked task holds no lease to expire')
    assert.equal(parked.claimable, false, 'nobody may take it away from the reviewer')
    assert.equal(parked.waiting_on_somebody, true)

    const swept = await w.claude.sweep()
    assert.deepEqual(swept.released, [], 'the sweep must leave it alone')
    assert.equal(w.claude.getTask({ task_id: task.id }).status, 'review')

    // And the reviewer can still answer, with no state gymnastics in between.
    const answered = await w.codex.submitReview({
      review_id: review.review.id,
      verdict: 'approved',
      summary: 'Checked it two days later and it was still exactly where it was left.'
    })
    assert.equal(answered.task_status, 'approved')
  } finally {
    w.cleanup()
  }
})

test('a parked task that lost its owner stays pickable rather than stuck', async () => {
  // The other half of the same lesson. "Parked" means it is somebody's turn; if
  // the record has no owner, there is nobody whose turn it is, and refusing the
  // claim would leave the task in a state nothing can leave.
  const w = world()
  try {
    const task = await w.claude.createTask({ title: 'Orphaned mid-flow', action: 'edit a file' })
    await w.claude.claimTask({ task_id: task.id })
    const review = await w.claude.requestReview({ task_id: task.id })
    await w.codex.submitReview({
      review_id: review.review.id,
      verdict: 'changes_requested',
      summary: 'needs work',
      findings: [{ severity: 'minor', note: 'rename this' }]
    })
    // Simulate the owner being lost, which is what the old sweep did.
    await w.claude.store.update('tasks', task.id, () => ({ owner: null }))

    const orphan = w.claude.getTask({ task_id: task.id })
    assert.equal(orphan.status, 'changes_requested')
    assert.equal(orphan.claimable, true, 'with no owner it must be pickable')

    const taken = await w.codex.claimTask({ task_id: task.id })
    assert.equal(taken.claimed, true)
    assert.equal(taken.task.status, 'in_progress')
  } finally {
    w.cleanup()
  }
})

test('the same is true while waiting on the owner', async () => {
  const clock = fixedClock()
  const w = world({ clock })
  try {
    const task = await w.codex.createTask({ title: 'Needs the owner', action: 'buy a subscription' })
    await w.codex.requestUserApproval({ task_id: task.id, action: task.action, reason: 'needed' })
    clock.advance(48 * 3600 * 1000)

    assert.deepEqual((await w.claude.sweep()).released, [], 'an unanswered approval is not abandoned work')
    assert.equal(w.codex.getTask({ task_id: task.id }).status, 'waiting_for_user')
  } finally {
    w.cleanup()
  }
})

test('a live lease is not stolen', async () => {
  const clock = fixedClock()
  const w = world({ clock })
  try {
    const task = await w.codex.createTask({ title: 'In hand', action: 'edit a file' })
    await w.codex.claimTask({ task_id: task.id, lease_seconds: 600 })
    clock.advance(60 * 1000)

    const result = await w.claude.claimTask({ task_id: task.id })
    assert.equal(result.claimed, false)
    assert.equal(result.reason, CODES.ALREADY_CLAIMED)
    assert.equal(w.claude.getTask({ task_id: task.id }).owner, 'codex')
  } finally {
    w.cleanup()
  }
})

test('a task requiring a role cannot be claimed by an agent without it', async () => {
  const w = world()
  try {
    const task = await w.claude.createTask({ title: 'iOS work', role: 'ios_engineer', action: 'edit a swift file' })
    let error = null
    try {
      await w.codex.claimTask({ task_id: task.id })
    } catch (e) {
      error = e
    }
    assert.equal(error.code, CODES.NOT_PERMITTED)
    assert.match(error.message, /needs role "ios_engineer"/)
  } finally {
    w.cleanup()
  }
})

// ── shared checks ──────────────────────────────────────────────────────────

test('a runner outside the allowlist is refused, and so is an argument outside its directory', async () => {
  const w = world()
  try {
    let unknown = null
    try {
      await w.claude.startRun({ runner: 'rm -rf /' })
    } catch (e) {
      unknown = e
    }
    assert.equal(unknown.code, CODES.RUNNER_REFUSED)

    let escape = null
    try {
      await w.claude.startRun({ runner: 'backend-tests', args: ['../../etc/passwd'] })
    } catch (e) {
      escape = e
    }
    assert.equal(escape.code, CODES.RUNNER_REFUSED)

    let outside = null
    try {
      await w.claude.startRun({ runner: 'backend-tests', args: ['backend/src/index.js'] })
    } catch (e) {
      outside = e
    }
    assert.equal(outside.code, CODES.RUNNER_REFUSED)
    assert.match(outside.message, /not under backend\/test/)

    let missing = null
    try {
      await w.claude.startRun({ runner: 'backend-tests', args: ['backend/test/does-not-exist.test.js'] })
    } catch (e) {
      missing = e
    }
    assert.equal(missing.code, CODES.RUNNER_REFUSED)
    assert.match(missing.message, /does not exist/)
  } finally {
    w.cleanup()
  }
})

test('a check both agents can read is run once', async () => {
  // A fixture runner in a temp working tree; no real project's checks are run.
  const w = world()
  try {
    const run = await w.claude.startRun({ runner: 'tap-check', wait_seconds: 60 })
    assert.equal(run.status, 'passed', JSON.stringify(run.result))
    assert.equal(run.result.counts.pass, 1)
    assert.equal(run.worktree, w.sbx.root, 'the run happened in the caller\'s working tree')
    // The point of storing it: the other agent reads the result rather than
    // spending the same minutes reproducing it.
    const seenByCodex = w.codex.getRun({ run_id: run.id })
    assert.equal(seenByCodex.id, run.id)
    assert.equal(seenByCodex.started_by, 'claude')
  } finally {
    w.cleanup()
  }
})

// ── a claim needs a holder ─────────────────────────────────────────────────

test('files are claimed by whoever holds the task, not by anybody holding its id', async () => {
  const w = world()
  try {
    const task = await w.claude.createTask({ title: 'Nobody took this', action: 'edit a file' })
    let error = null
    try {
      await w.claude.claimFiles({ task_id: task.id, paths: ['Tripix/TripMap/Presentation/Core/TripMapSheetLiftPolicy.swift'] })
    } catch (e) {
      error = e
    }
    assert.equal(error?.code, CODES.NOT_PERMITTED, 'a claim without a holder has no lease and can never expire')
  } finally {
    w.cleanup()
  }
})

test('an ownerless task holds no files, however long it sits there', async () => {
  const w = world()
  try {
    // create_task's own `files` list is the other way a claim can exist with no
    // owner. On 2026-09-13 a task in `created` held three files of the Tripix
    // tree this way and `collab status` printed its holder as `null`: a task in
    // `created` has no lease, so `lease_expired` stayed false forever.
    const ghost = await w.claude.createTask({
      title: 'Never claimed',
      action: 'edit a file',
      files: ['Tripix/TripMap/Presentation/Core/TripMapSheetLiftPolicy.swift']
    })
    assert.equal(ghost.owner, null)

    const real = await w.codex.createTask({ title: 'Actual work on the same file', action: 'edit a file' })
    await w.codex.claimTask({ task_id: real.id })
    const claimed = await w.codex.claimFiles({
      task_id: real.id,
      paths: ['Tripix/TripMap/Presentation/Core/TripMapSheetLiftPolicy.swift']
    })
    assert.ok(
      claimed.files.includes('Tripix/TripMap/Presentation/Core/TripMapSheetLiftPolicy.swift'),
      'ownership is what holds a file, not the listing'
    )
  } finally {
    w.cleanup()
  }
})

// ── who actually did the work ──────────────────────────────────────────────

test('a delegation says who and on which model, and shows as running until it is closed', async () => {
  const w = world()
  try {
    const task = await w.claude.createTask({ title: 'Extract the parser', action: 'edit a file' })
    await w.claude.claimTask({ task_id: task.id })

    const { delegation } = await w.claude.addDelegation({
      task_id: task.id,
      to: 'ios-implementer',
      model: 'sonnet',
      purpose: 'move the parser into its own file, plan attached'
    })
    assert.equal(delegation.to, 'ios-implementer')
    assert.equal(delegation.model, 'sonnet')
    assert.equal(delegation.finished_at, null)

    const live = await w.claude.status()
    assert.equal(live.delegations.length, 1, 'the owner can see it while it runs')
    assert.equal(live.delegations[0].task_id, task.id)

    await w.claude.completeDelegation({ task_id: task.id, delegation_id: delegation.id, outcome: 'done, two files' })
    const after = await w.claude.status()
    assert.equal(after.delegations.length, 0, 'a finished delegation is history, not work in flight')
    assert.equal(w.claude.getTask({ task_id: task.id }).delegations[0].outcome, 'done, two files')
  } finally {
    w.cleanup()
  }
})

test('a delegation is recorded by whoever holds the task, and names a model', async () => {
  const w = world()
  try {
    const task = await w.claude.createTask({ title: 'Claude holds this', action: 'edit a file' })
    await w.claude.claimTask({ task_id: task.id })

    let error = null
    try {
      await w.codex.addDelegation({ task_id: task.id, to: 'general-purpose', model: 'haiku', purpose: 'not mine to hand out' })
    } catch (e) {
      error = e
    }
    assert.equal(error?.code, CODES.NOT_PERMITTED)

    // The model is required on purpose: project agents declare `model: inherit`,
    // so leaving it out is not "let the system choose" — it is the lead's own
    // model by omission, the most expensive one.
    error = null
    try {
      await w.claude.addDelegation({ task_id: task.id, to: 'ios-implementer', model: '', purpose: 'no model named' })
    } catch (e) {
      error = e
    }
    assert.equal(error?.code, CODES.INVALID_INPUT)

    // The purpose is a line the owner reads in `collab status`, not a place to
    // paste the whole brief: the record lives inside the task.
    error = null
    try {
      await w.claude.addDelegation({ task_id: task.id, to: 'ios-implementer', model: 'sonnet', purpose: 'x'.repeat(401) })
    } catch (e) {
      error = e
    }
    assert.equal(error?.code, CODES.INVALID_INPUT)
  } finally {
    w.cleanup()
  }
})
