// The owner closing and reopening tasks — on purpose around the state machine.
//
// ⛔ OWNER ONLY, AND NOT ON THE AGENTS' SURFACE. The transition table (transitions.mjs) is unchanged: an agent still
// cannot complete a task that skipped its review, and nothing an agent calls leads out of `completed`/`cancelled`.
// These two functions are reached the way approvals are answered — by importing this module directly, from
// `collab close|reopen` (refused in an agent's shell and without a terminal) and from the panel's write path (only a
// panel started from the owner's terminal may write). They are deliberately absent from api.mjs and the MCP tools.
// As with approvals, that is a barrier against the realistic accident, not a security boundary: agents run as the
// same user. What makes a forced close visible instead of indistinguishable from a real one is the record it leaves:
// `closed_by_owner` on the task, with the reason, and its own event.
//
// Closing a task tidies everything that would otherwise keep pointing at it, in the same transaction:
// - its lease (a closed task holds no files: claims only count on open, owned tasks);
// - pending reviews of it — released, so no reviewer is sent to answer a question about closed work;
// - delegations without an outcome — closed with the owner's reason;
// - a pending approval for it — DENIED, never granted: closing is not a way to authorise anything;
// - the holder is told, by a message, who closed it and why.
// Reopening puts the task back in the pool (`created`, nobody holding it). Its history — the earlier summary, reviews,
// the closing note — stays; a task that needs a review still needs one to be completed again.

import { CODES, CollabError } from '../errors.mjs'
import { assertNoSecret } from '../policy.mjs'
import { TASK_STATUS, TERMINAL } from '../transitions.mjs'
import { RELEASED } from './reviews.mjs'
import { closed } from './sessions.mjs'

export const OWNER_OUTCOMES = Object.freeze([TASK_STATUS.COMPLETED, TASK_STATUS.CANCELLED])
const OUTCOME_RU = { completed: 'завершена', cancelled: 'отменена' }

function requireReason(reason) {
  const text = typeof reason === 'string' ? reason.trim() : ''
  if (!text) throw new CollabError(CODES.INVALID_INPUT, 'a reason is required: why the owner closes or reopens this task', { field: 'reason' })
  assertNoSecret(text, 'reason')
  return text
}

function tell(tx, to, task, subject, body) {
  if (!to) return
  tx.create('messages', {
    from_agent: 'owner',
    to: { agent: to, role: null, capability: null },
    resolved_at_send: [to],
    message_type: 'task_update',
    subject,
    body,
    task_id: task.id,
    thread_id: null,
    in_reply_to: null,
    priority: 'normal',
    requires_reply: false,
    status: 'unread',
    read_by: {},
    replied_by: null
  })
}

// Several tasks in one go (the panel's list), all or nothing: one of them already closed or unknown refuses the batch,
// so the owner never wonders which half went through.
// async: a refused input is a rejected promise like a refused write, for the CLI, the panel and the tests alike.
export async function ownerCloseTasks(ctx, { task_ids, outcome, reason }) {
  if (!OWNER_OUTCOMES.includes(outcome)) throw new CollabError(CODES.INVALID_INPUT, 'outcome is "completed" or "cancelled"', { outcome })
  const ids = [...new Set(Array.isArray(task_ids) ? task_ids : [task_ids])].filter((id) => typeof id === 'string' && id)
  if (!ids.length) throw new CollabError(CODES.INVALID_INPUT, 'name at least one task', { field: 'task_ids' })
  const why = requireReason(reason)
  return ctx.store.transact(async (tx) => {
    const found = ids.map((id) => ({ id, task: tx.get('tasks', id) }))
    const missing = found.filter((f) => !f.task).map((f) => f.id)
    if (missing.length) throw new CollabError(CODES.NOT_FOUND, `no task ${missing.join(', ')}`, { ids: missing })
    const closedAlready = found.filter((f) => TERMINAL.has(f.task.status)).map((f) => `${f.id} (${f.task.status})`)
    if (closedAlready.length) {
      throw new CollabError(CODES.ILLEGAL_TRANSITION, `already closed: ${closedAlready.join(', ')} — reopen first`, { ids: closedAlready })
    }

    const at = tx.iso()
    const results = []
    for (const { task } of found) {
      const releasedReviews = []
      for (const review of tx.list('reviews', { filter: (r) => r.task_id === task.id && r.verdict === 'pending' })) {
        tx.put('reviews', { ...review, verdict: RELEASED, released_at: at, released_by: 'owner', release_reason: `задача ${OUTCOME_RU[outcome]} владельцем: ${why}` })
        tx.emit('review.released', { collection: 'reviews', id: review.id }, { task_id: task.id, reviewer: review.reviewer, by: 'owner', reason: why, actor_kind: 'user' })
        releasedReviews.push(review.id)
      }

      let deniedApproval = null
      const approval = task.approval_id ? tx.get('approvals', task.approval_id) : null
      if (approval && approval.status === 'pending') {
        tx.put('approvals', { ...approval, status: 'denied', resolved_at: at, resolved_by: 'owner', resolution_channel: 'owner-close', resolution_note: why, resolution_evidence: {} })
        tx.emit('approval.resolved', { collection: 'approvals', id: approval.id }, { decision: 'denied', channel: 'owner-close', note: why, actor_kind: 'user' })
        deniedApproval = approval.id
      }

      const openDelegations = (task.delegations || []).filter((d) => !d.finished_at).map((d) => d.id)
      const delegations = (task.delegations || []).map((d) => (d.finished_at ? d : { ...d, finished_at: at, outcome: `закрыто владельцем: ${why}`, rework_required: null }))

      const closed = tx.put('tasks', {
        ...task,
        status: outcome,
        lease: null,
        waiting_on: null,
        blocked_reason: null,
        delegations,
        closed_by_owner: { outcome, reason: why, at, from_status: task.status, previous_owner: task.owner || null }
      })
      tell(tx, task.owner, task, `Задача ${OUTCOME_RU[outcome]} владельцем: ${task.title}`,
        `Владелец перевёл задачу ${task.id} из «${task.status}» в «${OUTCOME_RU[outcome]}» мимо обычных проверок.\n\nПричина: ${why}\n\nРаботу по ней остановите; закреплённые файлы освобождены.`)
      tx.emit('task.closed_by_owner', { collection: 'tasks', id: task.id }, {
        outcome, reason: why, from_status: task.status, previous_owner: task.owner || null, actor_kind: 'user',
        released_reviews: releasedReviews, closed_delegations: openDelegations, denied_approval: deniedApproval
      })
      results.push({ id: closed.id, status: closed.status, from_status: task.status, released_reviews: releasedReviews, closed_delegations: openDelegations.length, denied_approval: deniedApproval })
    }
    return { closed: results }
  })
}

export async function ownerReopenTask(ctx, { task_id, reason }) {
  const why = requireReason(reason)
  return ctx.store.transact(async (tx) => {
    const task = tx.get('tasks', task_id)
    if (!task) throw new CollabError(CODES.NOT_FOUND, `no task ${task_id}`, { id: task_id })
    if (!TERMINAL.has(task.status)) {
      throw new CollabError(CODES.ILLEGAL_TRANSITION, `task ${task_id} is ${task.status}, not closed — nothing to reopen`, { id: task_id, status: task.status })
    }
    const at = tx.iso()
    // The closing note moves into the history: a reopened task completed later the ordinary way must not still read
    // "closed by the owner".
    const { closed_by_owner: closedBefore = null, ...rest } = task
    const reopened = tx.put('tasks', {
      ...rest,
      status: TASK_STATUS.CREATED,
      owner: null,
      lease: null,
      ...closed(task, at),
      waiting_on: null,
      blocked_reason: null,
      owner_history: [...(task.owner_history || []), ...(closedBefore ? [{ action: 'closed', ...closedBefore }] : []), { action: 'reopened', reason: why, at, from_status: task.status, previous_owner: task.owner || null }]
    })
    tx.emit('task.reopened_by_owner', { collection: 'tasks', id: task_id }, { reason: why, from_status: task.status, previous_owner: task.owner || null, actor_kind: 'user' })
    return { id: reopened.id, status: reopened.status, from_status: task.status }
  })
}
