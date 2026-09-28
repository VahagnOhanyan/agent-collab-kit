// The gate: the one way into `in_progress`, and the rule about who may hold a task.
//
// Every move into work — claim_task, update_task, the owner's grant for a task
// that already has an owner — calls admitWork inside its transaction. It checks,
// in this order:
//   1. the edge is legal at all;
//   2. the ACTOR may hold the task: it owns it, or nobody does, or the task is
//      `created`, or the holder's lease has lapsed (the same rule as a claim);
//   3. the actor holds the task's role;
//   4. the policy: when the owner is needed, a granted, unexpired, UNUSED
//      approval whose fingerprint matches this action — consumed in this write;
// and returns the fields the task must be written with: the actor as owner and a
// fresh lease. transitions.mjs refuses `in_progress` without the admission, so a
// new path that skips this function fails loudly instead of skipping the checks.
//
// assertMayHold is rule 2 on its own, for moves that are not into work but would
// let a caller take a task away (releasing it, re-statusing it).
//
// A GRANT IS SINGLE-USE for every class ("грант одноразовый"). `never_standing` is recorded on the consumed approval for the
// audit trail; there are no standing grants to exempt from it.

import { CODES, CollabError } from '../errors.mjs'
import { assertActionAllowed } from '../policy.mjs'
import { TASK_STATUS, assertEdge } from '../transitions.mjs'

// A lease means "somebody is working on this right now"; only these states hold one.
export const LEASED_STATES = new Set([TASK_STATUS.IN_PROGRESS, TASK_STATUS.ASSIGNED])
const DEFAULT_LEASE_SECONDS = 3600

export function holdProblem(task, actor, now) {
  if (!task.owner || task.owner === actor || task.status === TASK_STATUS.CREATED) return null
  const expires = task.lease?.expires_at ? Date.parse(task.lease.expires_at) : null
  if (LEASED_STATES.has(task.status) && expires !== null && expires < now) return null
  return `task ${task.id} is ${task.status} and held by ${task.owner}${expires !== null ? ` (lease until ${task.lease.expires_at})` : ''}`
}

export function assertMayHold(tx, task, actor, what) {
  const problem = holdProblem(task, actor, tx.now())
  if (problem) {
    throw new CollabError(CODES.NOT_PERMITTED, `${problem}; ${actor} cannot ${what} it`, {
      id: task.id,
      owner: task.owner,
      status: task.status,
      actor
    })
  }
}

// Operations that speak AS the task's author — asking for its review, declaring
// it complete — belong to whoever did the work: the owner or a listed
// contributor. assign_task (coordination) and request_user_approval (anyone may
// ask the owner; only the owner grants) are deliberately not restricted.
export function assertOwnerOrContributor(task, actor, what) {
  if (task.owner === actor || (task.contributors || []).includes(actor)) return
  throw new CollabError(
    CODES.NOT_PERMITTED,
    `${actor} is neither the owner (${task.owner || 'nobody'}) nor a contributor of task ${task.id}, so it cannot ${what} it`,
    { id: task.id, owner: task.owner, contributors: task.contributors || [], actor }
  )
}

export function admitWork(tx, ctx, task, { approval: known = undefined, actor = ctx.agentId, leaseSeconds = null } = {}) {
  assertEdge(task, TASK_STATUS.IN_PROGRESS)
  assertMayHold(tx, task, actor, 'start work on')
  if (task.role && !ctx.registry.hasRole(actor, task.role)) {
    throw new CollabError(CODES.NOT_PERMITTED, `task ${task.id} needs role "${task.role}", which ${actor} does not hold`, {
      id: task.id,
      role: task.role,
      actor
    })
  }

  const approval = known !== undefined ? known : task.approval_id ? tx.get('approvals', task.approval_id) : null
  const verdict = assertActionAllowed({ policy: ctx.config.policy, action: task.action, approval, now: tx.iso() })

  let consumed = null
  if (verdict.requires_approval) {
    consumed = tx.put('approvals', {
      ...approval,
      consumed_at: tx.iso(),
      consumed_by: actor,
      consumed_for_task: task.id,
      never_standing: verdict.never_standing
    })
    tx.emit('approval.consumed', { collection: 'approvals', id: approval.id }, {
      by: actor,
      task_id: task.id,
      action_class: verdict.action_class,
      never_standing: verdict.never_standing
    })
  }

  const seconds = leaseSeconds || ctx.registry.defaults().lease_seconds || DEFAULT_LEASE_SECONDS
  const fields = {
    status: TASK_STATUS.IN_PROGRESS,
    owner: actor,
    contributors: [...new Set([...(task.contributors || []), actor])],
    lease: { holder: actor, acquired_at: tx.iso(), expires_at: new Date(tx.now() + seconds * 1000).toISOString() }
  }
  return Object.freeze({ task_id: task.id, actor, verdict, approval: consumed, fields })
}
