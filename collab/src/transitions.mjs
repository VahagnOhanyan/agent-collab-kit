// The task state machine, as a table.
//
// A status field that anything may set to anything is not a state machine, it is
// a string. The table below is what makes "this task was completed without ever
// being reviewed" impossible to write rather than merely discouraged.
//
// The approval gate is ENFORCED here: entering `in_progress` requires an
// admission for that task, and only domain/gate.mjs admitWork() makes one —
// after checking the policy and consuming the owner's grant in the same
// transaction. A code path that forgets the gate fails this guard instead of
// silently skipping it, which is exactly what update_task once did. That is what
// turns "an agent must not spend money on its own" from prompt advice into a
// property of the system.
//
// ⚠️ NAMING. `approved` is a task status meaning a code review passed. An
// `approval` record is the owner authorising a risky action. They are unrelated
// and one letter apart, so the status is only ever written as
// TASK_STATUS.APPROVED and the other is always spelled out as an approval record.

import { CODES, CollabError } from './errors.mjs'

export const TASK_STATUS = Object.freeze({
  CREATED: 'created',
  ASSIGNED: 'assigned',
  IN_PROGRESS: 'in_progress',
  WAITING_FOR_AGENT: 'waiting_for_agent',
  WAITING_FOR_USER: 'waiting_for_user',
  REVIEW: 'review',
  CHANGES_REQUESTED: 'changes_requested',
  APPROVED: 'approved',
  COMPLETED: 'completed',
  BLOCKED: 'blocked',
  CANCELLED: 'cancelled'
})

export const TERMINAL = Object.freeze(new Set([TASK_STATUS.COMPLETED, TASK_STATUS.CANCELLED]))

const S = TASK_STATUS

// from -> allowed next states.
export const TRANSITIONS = Object.freeze({
  // created -> waiting_for_user is not an oddity: a task whose action needs the
  // owner cannot be CLAIMED until they answer, so asking has to be possible
  // before anyone owns it. Leaving that edge out made the approval path
  // unreachable for exactly the tasks it exists for.
  [S.CREATED]: [S.ASSIGNED, S.IN_PROGRESS, S.WAITING_FOR_USER, S.BLOCKED, S.CANCELLED],
  [S.ASSIGNED]: [S.IN_PROGRESS, S.CREATED, S.ASSIGNED, S.WAITING_FOR_USER, S.BLOCKED, S.CANCELLED],
  [S.IN_PROGRESS]: [
    S.REVIEW,
    S.COMPLETED,
    S.WAITING_FOR_AGENT,
    S.WAITING_FOR_USER,
    S.CREATED,
    S.BLOCKED,
    S.CANCELLED
  ],
  [S.WAITING_FOR_AGENT]: [S.IN_PROGRESS, S.BLOCKED, S.CANCELLED],
  // Back to `created` when the answer arrives and nobody had claimed it yet:
  // an authorised task that nobody owns belongs in the pool, not in progress.
  [S.WAITING_FOR_USER]: [S.IN_PROGRESS, S.CREATED, S.BLOCKED, S.CANCELLED],
  [S.REVIEW]: [S.APPROVED, S.CHANGES_REQUESTED, S.BLOCKED, S.CANCELLED],
  [S.CHANGES_REQUESTED]: [S.IN_PROGRESS, S.ASSIGNED, S.BLOCKED, S.CANCELLED],
  [S.APPROVED]: [S.COMPLETED, S.CHANGES_REQUESTED, S.CANCELLED],
  [S.BLOCKED]: [S.CREATED, S.ASSIGNED, S.IN_PROGRESS, S.CANCELLED],
  [S.COMPLETED]: [],
  [S.CANCELLED]: []
})

export function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to)
}

export function allowedNext(task) {
  return [...(TRANSITIONS[task.status] || [])]
}

// Guards that cannot be expressed as an edge. Each returns null or a reason.
const GUARDS = {
  [S.IN_PROGRESS]: (task, ctx) =>
    ctx?.admission?.task_id === task.id
      ? null
      : "work starts only through the approval gate (admitWork), which checks the policy and consumes the owner's grant",
  [S.REVIEW]: (task) => (task.needs_review === false ? 'this task was created with needs_review false' : null),
  [S.COMPLETED]: (task, ctx) => {
    if (task.needs_review && task.status === S.IN_PROGRESS) {
      return 'it needs a review: move it to review and let a reviewer approve it first'
    }
    if (ctx?.pendingApproval) {
      return `the owner has not answered approval ${ctx.pendingApproval} yet`
    }
    return null
  },
  [S.BLOCKED]: (task, ctx) => (ctx?.reason ? null : 'blocking a task requires a reason'),
  [S.APPROVED]: (task, ctx) => {
    if (!ctx?.review) return 'a task becomes approved by a submitted review, not by assertion'
    if (ctx.review.reviewer === task.owner) return 'a review by the task owner is not an independent review'
    return null
  },
  [S.CHANGES_REQUESTED]: (task, ctx) =>
    ctx?.review && (ctx.review.findings || []).length === 0
      ? 'changes_requested with no findings tells the owner nothing about what to change'
      : null
}

// The edge alone: known status, not terminal, allowed by the table. The gate
// checks this first so an illegal move is reported as illegal, not as a
// missing approval.
export function assertEdge(task, to) {
  const from = task.status
  if (from === to) return to
  if (!TRANSITIONS[from]) {
    throw new CollabError(CODES.ILLEGAL_TRANSITION, `task ${task.id} has unknown status "${from}"`, { id: task.id, from })
  }
  if (TERMINAL.has(from)) {
    throw new CollabError(CODES.ILLEGAL_TRANSITION, `task ${task.id} is ${from}; terminal states have no way out`, {
      id: task.id,
      from,
      to
    })
  }
  if (!canTransition(from, to)) {
    throw new CollabError(
      CODES.ILLEGAL_TRANSITION,
      `task ${task.id} cannot go ${from} -> ${to}. From ${from} it may go to: ${TRANSITIONS[from].join(', ')}`,
      { id: task.id, from, to, allowed: TRANSITIONS[from] }
    )
  }
  return to
}

export function assertTransition(task, to, ctx = {}) {
  const from = task.status
  if (from === to) return to
  assertEdge(task, to)
  const guard = GUARDS[to]
  if (guard) {
    const problem = guard(task, ctx)
    if (problem) {
      throw new CollabError(CODES.GUARD_FAILED, `task ${task.id} cannot become ${to}: ${problem}`, {
        id: task.id,
        from,
        to,
        problem
      })
    }
  }
  return to
}
