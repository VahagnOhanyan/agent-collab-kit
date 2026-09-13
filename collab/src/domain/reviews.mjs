// Independent review, requested by ROLE.
//
// requestReview never names an agent. The caller says "I need a code_reviewer";
// the registry answers with somebody who is not the author. That is the whole
// distinction the collaboration layer exists to keep:
//
//     BAD:   claude -> codex
//     GOOD:  claude -> code_reviewer capability -> whoever holds it
//
// so that adding a security_reviewer later changes a config file and nothing
// else. The author is excluded from the candidate set structurally, not by
// asking the author to be honest about it.
//
// submitReview writes the verdict AND moves the task in one transaction. A
// review recorded against a task that stayed in `review` is exactly the
// split-brain this layer exists to prevent.

import { CODES, CollabError } from '../errors.mjs'
import { assertNoSecret } from '../policy.mjs'
import { TASK_STATUS, assertTransition } from '../transitions.mjs'
import { touchAgent } from './agents.mjs'
import { projectAgent } from './agents.mjs'
import { assertOwnerOrContributor } from './gate.mjs'

export const VERDICTS = Object.freeze(['approved', 'changes_requested'])

export function requestReview(ctx, { task_id, reviewer_role = 'code_reviewer', reviewer_capability = null, reviewer_agent = null, instructions = '', scope = [] }) {
  return ctx.store.transact(async (tx) => {
    const task = tx.get('tasks', task_id)
    if (!task) throw new CollabError(CODES.NOT_FOUND, `no task ${task_id}`, { id: task_id })
    assertOwnerOrContributor(task, ctx.agentId, 'request a review of')

    const author = task.owner || ctx.agentId
    let reviewer = reviewer_agent
    if (reviewer) {
      ctx.registry.agent(reviewer)
      if (reviewer === author) {
        throw new CollabError(CODES.SELF_REVIEW, `${author} cannot review their own work`, { task_id, author })
      }
    } else {
      const candidates = ctx.registry.find({
        role: reviewer_capability ? null : reviewer_role,
        capability: reviewer_capability,
        exclude: [author]
      })
      if (!candidates.length) {
        throw new CollabError(
          CODES.NO_AGENT_AVAILABLE,
          `no registered agent other than ${author} holds ${reviewer_capability || reviewer_role}`,
          { task_id, role: reviewer_role, capability: reviewer_capability, author }
        )
      }
      // Prefer somebody who has been seen recently; fall back to the first
      // registered holder so a review can still be QUEUED for an agent that is
      // not running. Queueing for an absent agent is the normal case here.
      const staleAfterMs = (ctx.registry.defaults().heartbeat_stale_seconds || 900) * 1000
      const now = tx.now()
      const live = candidates.filter((c) => {
        const runtime = tx.get('agents', c.id)
        return runtime && projectAgent(runtime, { now, staleAfterMs }).effective_status !== 'offline'
      })
      reviewer = (live[0] || candidates[0]).id
    }

    assertTransition(task, TASK_STATUS.REVIEW, {})

    const review = tx.create('reviews', {
      task_id,
      author,
      reviewer,
      requested_by: ctx.agentId,
      requested_role: reviewer_capability ? null : reviewer_role,
      requested_capability: reviewer_capability,
      instructions: assertNoSecret(instructions, 'review instructions'),
      scope: scope.length ? scope : task.files || [],
      verdict: 'pending',
      summary: null,
      findings: [],
      round: (tx.list('reviews', { filter: (r) => r.task_id === task_id }).length || 0) + 1
    })

    tx.put('tasks', {
      ...task,
      status: TASK_STATUS.REVIEW,
      reviewers: [...new Set([...(task.reviewers || []), reviewer])],
      waiting_on: { kind: 'agent', ref: review.id }
    })

    const message = tx.create('messages', {
      from_agent: ctx.agentId,
      to: { agent: reviewer, role: null, capability: null },
      resolved_at_send: [reviewer],
      message_type: 'review_request',
      subject: `Review requested: ${task.title}`,
      body:
        `${instructions || 'Please review this work.'}\n\n` +
        `Task: ${task_id} — ${task.title}\n` +
        `Review: ${review.id} (round ${review.round})\n` +
        `Scope: ${(scope.length ? scope : task.files || []).join(', ') || 'not narrowed'}\n\n` +
        'Reply with submit_review, verdict approved or changes_requested. ' +
        'changes_requested needs at least one finding.',
      task_id,
      thread_id: review.id,
      in_reply_to: null,
      priority: 'normal',
      requires_reply: true,
      status: 'unread',
      read_by: {},
      replied_by: null
    })

    touchAgent(tx, ctx)
    tx.emit('review.requested', { collection: 'reviews', id: review.id }, {
      task_id,
      author,
      reviewer,
      selected_by: reviewer_agent ? 'caller' : `role:${reviewer_capability || reviewer_role}`,
      round: review.round,
      message_id: message.id
    })
    return { review, routed_to: reviewer, message_id: message.id }
  })
}

export function submitReview(ctx, { review_id, verdict, summary = '', findings = [] }) {
  if (!VERDICTS.includes(verdict)) {
    throw new CollabError(CODES.INVALID_INPUT, `verdict must be one of ${VERDICTS.join(', ')}`, { verdict })
  }
  assertNoSecret(summary, 'review summary')

  return ctx.store.transact(async (tx) => {
    const review = tx.get('reviews', review_id)
    if (!review) throw new CollabError(CODES.NOT_FOUND, `no review ${review_id}`, { id: review_id })
    if (review.verdict !== 'pending') {
      throw new CollabError(CODES.INVALID_INPUT, `review ${review_id} already returned "${review.verdict}"`, {
        id: review_id,
        verdict: review.verdict
      })
    }
    if (review.reviewer !== ctx.agentId) {
      throw new CollabError(CODES.NOT_PERMITTED, `review ${review_id} was routed to ${review.reviewer}, not to ${ctx.agentId}`, {
        id: review_id,
        reviewer: review.reviewer
      })
    }

    const task = tx.get('tasks', review.task_id)
    if (!task) throw new CollabError(CODES.NOT_FOUND, `review ${review_id} points at a task that is gone`, { id: review.task_id })

    const normalised = findings.map((f) => ({
      severity: f.severity || 'minor',
      file: f.file || null,
      line: f.line || null,
      note: assertNoSecret(f.note || '', 'review finding')
    }))

    const nextStatus = verdict === 'approved' ? TASK_STATUS.APPROVED : TASK_STATUS.CHANGES_REQUESTED
    assertTransition(task, nextStatus, { review: { reviewer: ctx.agentId, findings: normalised } })

    const stored = tx.put('reviews', {
      ...review,
      verdict,
      summary,
      findings: normalised,
      submitted_at: tx.iso()
    })
    tx.put('tasks', { ...task, status: nextStatus, waiting_on: null })

    tx.create('messages', {
      from_agent: ctx.agentId,
      to: { agent: review.author, role: null, capability: null },
      resolved_at_send: [review.author],
      message_type: 'review_response',
      subject: `Review ${verdict}: ${task.title}`,
      body:
        `${summary || '(no summary)'}\n\n` +
        (normalised.length
          ? normalised.map((f, i) => `${i + 1}. [${f.severity}] ${f.file || '—'}${f.line ? `:${f.line}` : ''} — ${f.note}`).join('\n')
          : 'No findings.'),
      task_id: review.task_id,
      thread_id: review.id,
      in_reply_to: null,
      priority: verdict === 'changes_requested' ? 'high' : 'normal',
      requires_reply: false,
      status: 'unread',
      read_by: {},
      replied_by: null
    })

    touchAgent(tx, ctx)
    tx.emit('review.submitted', { collection: 'reviews', id: review_id }, {
      task_id: review.task_id,
      verdict,
      findings: normalised.length,
      round: review.round
    })
    return { review: stored, task_status: nextStatus }
  })
}

export function listReviews(ctx, { task_id = null, reviewer = null, pending_only = false } = {}) {
  return ctx.store.list('reviews', {
    filter: (r) => {
      if (task_id && r.task_id !== task_id) return false
      if (reviewer && r.reviewer !== reviewer) return false
      if (pending_only && r.verdict !== 'pending') return false
      return true
    }
  })
}
