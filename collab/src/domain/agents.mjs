// Runtime state of an agent, and how the layer notices one has gone away.
//
// THERE IS NO DAEMON, AND NO HEARTBEAT TOOL.
// Every call an agent makes stamps its own heartbeat, because an agent that is
// doing something is by definition alive. That removes a tool the agent has to
// remember, removes "the agent forgot to heartbeat" as a false positive, and
// makes the signal impossible to fake in the direction that matters.
//
// STALENESS IS PROJECTED, NOT PERSISTED.
// A read never writes. `project` derives `offline` and `stale` from timestamps
// on the way out, so an abandoned task is visible the instant it goes stale even
// though nothing has run. Persisting the consequence happens opportunistically,
// in sweep(), on the calls a working agent already makes.
//
// Static config (who CAN exist) lives in agents.json (built-in or registry).
// This file is who IS running. Mixing the two turns a config file into a
// mutable database, which is how config stops being reviewable.

import { AGENT_STATUSES } from '../registry.mjs'
import { CODES, CollabError } from '../errors.mjs'
import { assertNoSecret } from '../policy.mjs'
import { TASK_STATUS, TERMINAL, assertTransition } from '../transitions.mjs'

export const DECLARED_STATUSES = AGENT_STATUSES

export function projectAgent(runtime, { now, staleAfterMs }) {
  if (!runtime) return null
  const last = runtime.last_seen_at ? Date.parse(runtime.last_seen_at) : 0
  const silentMs = now - last
  // `failed` is set explicitly and is never inferred: an inferred failure is
  // indistinguishable from an absence, and the difference is the whole reason
  // both statuses exist.
  const effective =
    runtime.status === 'failed' ? 'failed' : silentMs > staleAfterMs ? 'offline' : runtime.status || 'available'
  return {
    ...runtime,
    effective_status: effective,
    silent_ms: silentMs,
    is_stale: effective === 'offline' && runtime.status !== 'offline'
  }
}

export function readAgent(ctx, agentId) {
  const declared = ctx.registry.agent(agentId)
  const runtime = ctx.store.get('agents', agentId) || {
    id: agentId,
    status: 'offline',
    last_seen_at: null,
    current_task_id: null
  }
  const staleAfterMs = (ctx.registry.defaults().heartbeat_stale_seconds || 900) * 1000
  return {
    id: agentId,
    name: declared.name,
    provider: declared.provider,
    roles: declared.roles,
    capabilities: declared.capabilities,
    adapter: declared.adapter,
    runtime: projectAgent(runtime, { now: ctx.clock.now(), staleAfterMs })
  }
}

export function listAgents(ctx, { role = null, capability = null, availableOnly = false } = {}) {
  const declared = ctx.registry.find({ role, capability })
  const out = declared.map((agent) => readAgent(ctx, agent.id))
  return availableOnly ? out.filter((a) => ['available', 'busy'].includes(a.runtime.effective_status)) : out
}

// Called inside an existing transaction by every write path.
export function touchAgent(tx, ctx, patch = {}) {
  const current = tx.get('agents', ctx.agentId) || { id: ctx.agentId, version: 0 }
  const next = {
    ...current,
    id: ctx.agentId,
    status: patch.status || current.status || 'available',
    last_seen_at: tx.iso(),
    pid: process.pid,
    ...patch
  }
  return tx.put('agents', next)
}

// ── a role the agent finds it cannot do (ADR-0026, stage 4) ──────────────────
//
// The agent says so itself: the role stops counting for it at once (registry.find, hasRole), and its open task
// that needs the role goes back to the queue. It is kept in the agent's own runtime record — no new journal
// collection, so existing journals stay valid. Only the owner gives the role back (`collab role restore`, at a
// terminal); taking it away for good is the owner unticking it in the panel. A suspension of a role the agent no
// longer holds is simply over.

const SUSPEND_REASON_MAX = 500

export async function suspendRole(ctx, { role, reason = '', task_id = null }) {
  ctx.registry.role(role)
  const clean = typeof reason === 'string' ? reason.trim() : ''
  if (clean.length < 10) {
    throw new CollabError(CODES.INVALID_INPUT, 'say why the role cannot be done here — the owner decides from this reason whether to give it back', { field: 'reason' })
  }
  if (clean.length > SUSPEND_REASON_MAX) {
    throw new CollabError(CODES.INVALID_INPUT, `the reason is one or two sentences, under ${SUSPEND_REASON_MAX} characters`, { field: 'reason' })
  }
  assertNoSecret(clean, 'suspension reason')
  if (!(ctx.registry.agent(ctx.agentId).roles || []).includes(role)) {
    throw new CollabError(CODES.NOT_PERMITTED, `${ctx.agentId} does not hold role "${role}", so there is nothing to suspend`, { role })
  }
  return ctx.store.transact(async (tx) => {
    let released = null
    if (task_id) {
      const task = tx.get('tasks', task_id)
      if (!task) throw new CollabError(CODES.NOT_FOUND, `no task ${task_id}`, { id: task_id })
      if (task.owner === ctx.agentId && task.role === role && !TERMINAL.has(task.status)) {
        assertTransition(task, TASK_STATUS.CREATED, {})
        tx.put('tasks', { ...task, status: TASK_STATUS.CREATED, owner: null, lease: null })
        tx.emit('task.released', { collection: 'tasks', id: task_id }, { by: ctx.agentId, previous_owner: ctx.agentId, reason: `role ${role} suspended: ${clean}` })
        released = task_id
      }
    }
    const current = tx.get('agents', ctx.agentId) || { id: ctx.agentId, version: 0 }
    const others = (current.suspended_roles || []).filter((s) => s.role !== role)
    const suspension = { role, reason: clean, task_id, at: tx.iso() }
    touchAgent(tx, ctx, { suspended_roles: [...others, suspension], ...(released ? { status: 'available', current_task_id: null } : {}) })
    tx.emit('agent.role_suspended', { collection: 'agents', id: ctx.agentId }, { role, reason: clean, task_id, released })
    return { suspended: suspension, released_task: released }
  })
}

export function suspendedRoles(ctx, agentId) {
  const runtime = ctx.store.get('agents', agentId)
  const held = ctx.registry.has(agentId) ? ctx.registry.agent(agentId).roles || [] : []
  return (runtime?.suspended_roles || []).filter((s) => held.includes(s.role))
}

export function restoreRole(ctx, { agent_id, role }) {
  return ctx.store.transact(async (tx) => {
    const current = tx.get('agents', agent_id)
    const had = (current?.suspended_roles || []).some((s) => s.role === role)
    if (!had) throw new CollabError(CODES.NOT_FOUND, `${agent_id} has no suspended role "${role}"`, { agent_id, role })
    tx.put('agents', { ...current, suspended_roles: current.suspended_roles.filter((s) => s.role !== role) })
    tx.emit('agent.role_restored', { collection: 'agents', id: agent_id }, { role, by: ctx.agentId })
    return { restored: { agent_id, role } }
  })
}

export function setStatus(ctx, { status, note = null, taskId = undefined }) {
  if (!DECLARED_STATUSES.includes(status)) {
    throw new Error(`unknown agent status "${status}" — expected one of ${DECLARED_STATUSES.join(', ')}`)
  }
  return ctx.store.transact(async (tx) => {
    const patch = { status, note }
    if (taskId !== undefined) patch.current_task_id = taskId
    const next = touchAgent(tx, ctx, patch)
    tx.emit('agent.status', { collection: 'agents', id: ctx.agentId }, { status, note })
    return next
  })
}
