// Who the lead handed a subtask to, and with which model.
//
// The layer routes by ROLE among REGISTERED agents. A subagent is not one of
// them: no COLLAB_AGENT_ID, no inbox, no lease, and everything it does is
// written to the journal as its parent's work. So the owner could read
// "claude is on tsk_…" and never learn that the editing was done by an
// ios-implementer on sonnet, or the search by Explore on haiku.
//
// ⛔ THIS IS A RECORD, NOT A CONTROL — the distinction this file exists to keep.
// Nothing here starts a subagent, and nothing can verify which model actually
// ran; the layer stores what the lead declared, exactly as claim_files stores
// intent about files. Read as a guarantee, it would be worse than absent.
//
// The record lives ON THE TASK rather than in its own collection: a delegation
// has no life of its own, it is a sentence about who did this task's work, and
// keeping it there means one read answers "what happened to this task".

import { CODES, CollabError } from '../errors.mjs'
import { assertNoSecret } from '../policy.mjs'
import { TERMINAL } from '../transitions.mjs'
import { touchAgent } from './agents.mjs'
import { assertOwnerOrContributor } from './gate.mjs'

const MAX = 120

function label(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new CollabError(CODES.INVALID_INPUT, `a delegation needs ${field}`, { field })
  }
  const clean = value.trim()
  if (clean.length > MAX || /[\n\r]/.test(clean)) {
    throw new CollabError(CODES.INVALID_INPUT, `${field} must be one short line, not a paragraph`, { field })
  }
  return clean
}

const PURPOSE_MAX = 400

// Free text, unlike `to` and `model`, but not unbounded: this record lives
// inside the task and is printed by `collab status`, so a brief pasted in here
// costs the readability the whole feature exists for.
function brief(value, field) {
  const clean = typeof value === 'string' ? value.trim() : ''
  if (clean.length > PURPOSE_MAX) {
    throw new CollabError(
      CODES.INVALID_INPUT,
      `${field} is one line for the owner to read, not a brief — keep it under ${PURPOSE_MAX} characters`,
      { field, length: clean.length }
    )
  }
  return clean
}

export function addDelegation(ctx, { task_id, to, model, purpose = '' }) {
  const target = label(to, 'the subagent it goes to')
  // The model is REQUIRED, and that is the point of the field. Project agents
  // declare `model: inherit`, so a delegation with no model named is not "the
  // system chose sensibly" — it is the lead's own model, the most expensive
  // option, taken by omission.
  const chosen = label(model, 'the model it runs on')
  assertNoSecret(purpose, 'delegation purpose')
  const why = brief(purpose, 'the delegation purpose')

  return ctx.store.transact(async (tx) => {
    const task = tx.get('tasks', task_id)
    if (!task) throw new CollabError(CODES.NOT_FOUND, `no task ${task_id}`, { id: task_id })
    if (TERMINAL.has(task.status)) {
      throw new CollabError(CODES.INVALID_INPUT, `task ${task_id} is ${task.status}; nothing is being delegated on it`, {
        id: task_id,
        status: task.status
      })
    }
    // Delegating is speaking as the task's author, like asking for its review.
    assertOwnerOrContributor(task, ctx.agentId, 'delegate work on')

    const existing = task.delegations || []
    const delegation = {
      id: `d${existing.length + 1}`,
      to: target,
      model: chosen,
      purpose: why,
      by: ctx.agentId,
      started_at: tx.iso(),
      finished_at: null,
      outcome: null
    }
    tx.put('tasks', { ...task, delegations: [...existing, delegation] })
    touchAgent(tx, ctx)
    tx.emit('task.delegated', { collection: 'tasks', id: task_id }, {
      to: target,
      model: chosen,
      by: ctx.agentId,
      purpose: delegation.purpose
    })
    return { task_id, delegation }
  })
}

export function completeDelegation(ctx, { task_id, delegation_id, outcome = '' }) {
  assertNoSecret(outcome, 'delegation outcome')
  const summary = brief(outcome, 'the delegation outcome')

  return ctx.store.transact(async (tx) => {
    const task = tx.get('tasks', task_id)
    if (!task) throw new CollabError(CODES.NOT_FOUND, `no task ${task_id}`, { id: task_id })
    assertOwnerOrContributor(task, ctx.agentId, 'close a delegation on')

    const existing = task.delegations || []
    const found = existing.find((d) => d.id === delegation_id)
    if (!found) {
      throw new CollabError(CODES.NOT_FOUND, `task ${task_id} has no delegation ${delegation_id}`, {
        id: task_id,
        delegation_id,
        known: existing.map((d) => d.id)
      })
    }
    if (found.finished_at) {
      throw new CollabError(CODES.INVALID_INPUT, `delegation ${delegation_id} already finished at ${found.finished_at}`, {
        delegation_id,
        finished_at: found.finished_at
      })
    }
    const closed = { ...found, finished_at: tx.iso(), outcome: summary || 'finished' }
    tx.put('tasks', { ...task, delegations: existing.map((d) => (d.id === delegation_id ? closed : d)) })
    touchAgent(tx, ctx)
    tx.emit('task.delegation_closed', { collection: 'tasks', id: task_id }, {
      delegation_id,
      to: closed.to,
      model: closed.model,
      outcome: closed.outcome
    })
    return { task_id, delegation: closed }
  })
}

// What is running RIGHT NOW, for `collab status`. Derived on read, never stored:
// a delegation on a task that was cancelled or completed is history, not work in
// flight, and deriving it means no state can drift out of date.
export function openDelegations(ctx) {
  const live = []
  for (const task of ctx.store.list('tasks', { filter: (t) => !TERMINAL.has(t.status) })) {
    for (const delegation of task.delegations || []) {
      if (delegation.finished_at) continue
      live.push({ ...delegation, task_id: task.id, task_title: task.title })
    }
  }
  return live
}
