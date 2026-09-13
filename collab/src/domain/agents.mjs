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
