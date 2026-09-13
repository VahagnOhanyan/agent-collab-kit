// Requests for the owner's authorisation.
//
// ⛔ THERE IS NO GRANT FUNCTION HERE THAT AN AGENT CAN REACH.
// `resolve` below is exported for the CLI, which refuses to run it unless a
// human is at a terminal. It is never wired into the MCP tool list, and
// mcp.test.mjs asserts that no exposed tool name can grant anything. Absence
// from the surface is a stronger guarantee than a runtime check, because it
// needs no correct implementation to hold.
//
// ⚠️ HONEST LIMIT, worth stating plainly because the opposite is easy to assume:
// both agents run as the same user on this machine, with a shell. Nothing here
// is a security boundary against a determined process — a TTY check is defeated
// by `script`, and any file this layer writes, an agent could write. What these
// mechanisms do achieve:
//   - no MCP tool grants anything, so the ordinary path simply does not exist;
//   - the CLI refuses when COLLAB_AGENT_ID is set, so an agent shell cannot
//     grant by accident, and clearing it is a deliberate, greppable act;
//   - every resolution records pid, ppid and tty, so a forged grant is not
//     invisible — it is a line in the audit log with implausible ancestry.
// The real enforcement for a dangerous action belongs in the harness, outside
// the agent's reach: .claude/settings.json permissions and a PreToolUse hook,
// the same pattern scripts/claude-hooks/push-gate.py already uses. That is
// written down in docs/decisions/0011 so it is not misremembered later as
// "the collab layer prevents spending".

import { CODES, CollabError } from '../errors.mjs'
import { assertNoSecret, classifyAction, fingerprintAction } from '../policy.mjs'
import { TASK_STATUS, assertTransition } from '../transitions.mjs'
import { touchAgent } from './agents.mjs'

export function requestApproval(ctx, { task_id = null, action, reason, details = '', cost_estimate = null }) {
  if (!action) throw new CollabError(CODES.INVALID_INPUT, 'an approval request needs the action it is asking about')
  if (!reason) throw new CollabError(CODES.INVALID_INPUT, 'an approval request needs a reason the owner can judge')
  assertNoSecret(details, 'approval details')
  assertNoSecret(reason, 'approval reason')

  const verdict = classifyAction(ctx.config.policy, action)
  const ttl = (ctx.config.policy.defaults.approval_ttl_seconds || 86400) * 1000

  return ctx.store.transact(async (tx) => {
    const approval = tx.create('approvals', {
      requested_by: ctx.agentId,
      task_id,
      action: typeof action === 'string' ? { summary: action } : action,
      action_fingerprint: fingerprintAction(action),
      action_class: verdict.action_class,
      requires_approval: verdict.requires_approval,
      policy_reason: verdict.reason,
      reason,
      details,
      cost_estimate,
      status: 'pending',
      expires_at: new Date(tx.now() + ttl).toISOString(),
      resolved_at: null,
      resolved_by: null,
      resolution_note: null,
      consumed_at: null,
      consumed_by: null
    })

    if (task_id) {
      const task = tx.get('tasks', task_id)
      if (task) {
        // The task stops here. It cannot be completed while this is pending —
        // the state machine checks it, so no tool handler has to remember to.
        if (task.status !== TASK_STATUS.WAITING_FOR_USER) {
          assertTransition(task, TASK_STATUS.WAITING_FOR_USER, {})
        }
        tx.put('tasks', {
          ...task,
          status: TASK_STATUS.WAITING_FOR_USER,
          approval_id: approval.id,
          waiting_on: { kind: 'user', ref: approval.id }
        })
      }
    }

    touchAgent(tx, ctx, { status: 'waiting' })
    tx.emit('approval.requested', { collection: 'approvals', id: approval.id }, {
      task_id,
      action_class: verdict.action_class,
      cost_estimate,
      reason
    })
    return approval
  })
}

export function listApprovals(ctx, { pending_only = true, task_id = null } = {}) {
  const now = ctx.clock.now()
  return ctx.store
    .list('approvals', {
      filter: (a) => {
        if (task_id && a.task_id !== task_id) return false
        if (pending_only && a.status !== 'pending') return false
        return true
      }
    })
    .map((a) => ({
      ...a,
      // Expiry is projected, never persisted: a read that writes is a read that
      // needs the lock, and this one is on the human's status path.
      expired: Boolean(a.expires_at && Date.parse(a.expires_at) < now && a.status === 'pending')
    }))
}

// CLI ONLY. See the header. `channel` is recorded so the audit log says how the
// answer arrived, and the CLI is the only caller that passes 'cli-tty'.
export function resolveApproval(ctx, { approval_id, decision, note = '', channel = 'unknown', evidence = {} }) {
  if (!['granted', 'denied'].includes(decision)) {
    throw new CollabError(CODES.INVALID_INPUT, 'decision must be "granted" or "denied"', { decision })
  }
  return ctx.store.transact(async (tx) => {
    const approval = tx.get('approvals', approval_id)
    if (!approval) throw new CollabError(CODES.NOT_FOUND, `no approval ${approval_id}`, { id: approval_id })
    if (approval.status !== 'pending') {
      throw new CollabError(CODES.INVALID_INPUT, `approval ${approval_id} was already ${approval.status}`, {
        id: approval_id,
        status: approval.status
      })
    }

    const next = tx.put('approvals', {
      ...approval,
      status: decision,
      resolved_at: tx.iso(),
      resolved_by: 'owner',
      resolution_channel: channel,
      resolution_note: note,
      resolution_evidence: evidence
    })

    if (approval.task_id) {
      const task = tx.get('tasks', approval.task_id)
      if (task && task.status === TASK_STATUS.WAITING_FOR_USER) {
        // Granted: back to work — to `in_progress` if somebody already holds it,
        // otherwise into the pool as `created`, because an authorised task that
        // nobody owns is available work, not work under way.
        // Denied: blocked, carrying the owner's answer as the reason, so the
        // record says why it stopped and not merely that it did.
        const to =
          decision === 'granted'
            ? task.owner
              ? TASK_STATUS.IN_PROGRESS
              : TASK_STATUS.CREATED
            : TASK_STATUS.BLOCKED
        assertTransition(task, to, { reason: note || 'the owner declined this action' })
        tx.put('tasks', {
          ...task,
          status: to,
          waiting_on: null,
          blocked_reason: decision === 'denied' ? note || 'the owner declined this action' : null
        })
      }
    }

    tx.emit('approval.resolved', { collection: 'approvals', id: approval_id }, {
      decision,
      channel,
      note,
      evidence,
      actor_kind: 'user'
    })
    return next
  })
}

export function consumeApproval(ctx, { approval_id }) {
  return ctx.store.transact(async (tx) => {
    const approval = tx.get('approvals', approval_id)
    if (!approval) throw new CollabError(CODES.NOT_FOUND, `no approval ${approval_id}`, { id: approval_id })
    if (approval.status !== 'granted') {
      throw new CollabError(CODES.APPROVAL_INVALID, `approval ${approval_id} is ${approval.status}`, { id: approval_id })
    }
    if (approval.consumed_at) {
      throw new CollabError(CODES.APPROVAL_INVALID, `approval ${approval_id} was already used`, { id: approval_id })
    }
    const next = tx.put('approvals', { ...approval, consumed_at: tx.iso(), consumed_by: ctx.agentId })
    tx.emit('approval.consumed', { collection: 'approvals', id: approval_id }, { by: ctx.agentId })
    return next
  })
}
