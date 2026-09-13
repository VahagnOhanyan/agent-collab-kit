// Decisions, and what happens when two agents disagree.
//
// The rule this module exists to enforce: the latest opinion does not win. A
// disagreement is recorded as POSITIONS on one decision, each with the reasoning
// behind it, and it is resolved either by argument or by the owner. Nothing
// resolves it by being said last.
//
// This is deliberately NOT a second decision journal. docs/decisions/ (ADR) is
// the repository's mechanism for decisions that bind everyone, and it is already
// gate-enforced. A decision here is a lightweight working record that ends with
// `adr_ref` pointing at the ADR it became — and the CLI says so when you resolve
// one. Two sources of truth about why the code is shaped this way is the exact
// problem the ADR directory was created to end.

import { CODES, CollabError } from '../errors.mjs'
import { assertNoSecret } from '../policy.mjs'
import { touchAgent } from './agents.mjs'

export const DECISION_STATUS = Object.freeze(['open', 'disputed', 'decided', 'escalated', 'superseded'])

export function createDecision(ctx, { title, context = '', options = [], task_id = null, position = null }) {
  if (!title) throw new CollabError(CODES.INVALID_INPUT, 'a decision needs a title')
  assertNoSecret(context, 'decision context')

  return ctx.store.transact(async (tx) => {
    const decision = tx.create('decisions', {
      title,
      context,
      options: options.map((o) => ({ id: o.id || o.label, label: o.label || o.id, summary: o.summary || '' })),
      task_id,
      status: 'open',
      positions: position
        ? [{ agent: ctx.agentId, option: position.option, rationale: position.rationale || '', at: tx.iso() }]
        : [],
      outcome: null,
      decided_by: null,
      decided_by_kind: null,
      rationale: null,
      adr_ref: null,
      created_by: ctx.agentId
    })
    touchAgent(tx, ctx)
    tx.emit('decision.created', { collection: 'decisions', id: decision.id }, { title, task_id })
    return decision
  })
}

// Adding a position that disagrees with an existing one flips the decision to
// `disputed`, which is a state a task cannot be completed through by accident.
export function addPosition(ctx, { decision_id, option, rationale }) {
  if (!rationale || rationale.trim().length < 10) {
    throw new CollabError(
      CODES.INVALID_INPUT,
      'a position without reasoning is a vote, and this is not decided by voting — say why'
    )
  }
  assertNoSecret(rationale, 'decision rationale')

  return ctx.store.transact(async (tx) => {
    const decision = tx.get('decisions', decision_id)
    if (!decision) throw new CollabError(CODES.NOT_FOUND, `no decision ${decision_id}`, { id: decision_id })
    if (['decided', 'superseded'].includes(decision.status)) {
      throw new CollabError(CODES.INVALID_INPUT, `decision ${decision_id} is already ${decision.status}`, {
        id: decision_id,
        status: decision.status
      })
    }

    const positions = [
      ...(decision.positions || []).filter((p) => p.agent !== ctx.agentId),
      { agent: ctx.agentId, option, rationale, at: tx.iso() }
    ]
    const distinct = new Set(positions.map((p) => p.option))
    const status = distinct.size > 1 ? 'disputed' : decision.status === 'disputed' ? 'open' : decision.status

    const next = tx.put('decisions', { ...decision, positions, status })
    touchAgent(tx, ctx)
    tx.emit('decision.position', { collection: 'decisions', id: decision_id }, { agent: ctx.agentId, option, status })
    return next
  })
}

export function resolveDecision(ctx, { decision_id, outcome, rationale, adr_ref = null, decided_by_kind = 'agent' }) {
  if (!outcome) throw new CollabError(CODES.INVALID_INPUT, 'resolving a decision needs an outcome')
  if (!rationale) throw new CollabError(CODES.INVALID_INPUT, 'resolving a decision needs the reasoning that settled it')
  assertNoSecret(rationale, 'decision rationale')

  return ctx.store.transact(async (tx) => {
    const decision = tx.get('decisions', decision_id)
    if (!decision) throw new CollabError(CODES.NOT_FOUND, `no decision ${decision_id}`, { id: decision_id })

    // A disputed decision cannot be closed by one of the disputing agents: that
    // would be exactly "whoever speaks last wins". It goes to the owner.
    if (decision.status === 'disputed' && decided_by_kind === 'agent') {
      throw new CollabError(
        CODES.NOT_PERMITTED,
        `decision ${decision_id} is disputed — an agent that holds a position in it cannot also settle it. ` +
          'Escalate it to the owner instead.',
        { id: decision_id, positions: decision.positions }
      )
    }

    const next = tx.put('decisions', {
      ...decision,
      status: 'decided',
      outcome,
      rationale,
      adr_ref,
      decided_by: decided_by_kind === 'user' ? 'owner' : ctx.agentId,
      decided_by_kind,
      decided_at: tx.iso()
    })
    touchAgent(tx, ctx)
    tx.emit('decision.resolved', { collection: 'decisions', id: decision_id }, { outcome, decided_by_kind, adr_ref })
    return next
  })
}

export function escalateDecision(ctx, { decision_id, reason }) {
  return ctx.store.transact(async (tx) => {
    const decision = tx.get('decisions', decision_id)
    if (!decision) throw new CollabError(CODES.NOT_FOUND, `no decision ${decision_id}`, { id: decision_id })
    const next = tx.put('decisions', { ...decision, status: 'escalated', escalation_reason: reason })
    touchAgent(tx, ctx)
    tx.emit('decision.escalated', { collection: 'decisions', id: decision_id }, { reason })
    return next
  })
}

export function listDecisions(ctx, { status = null, task_id = null } = {}) {
  return ctx.store.list('decisions', {
    filter: (d) => {
      if (status && d.status !== status) return false
      if (task_id && d.task_id !== task_id) return false
      return true
    }
  })
}
