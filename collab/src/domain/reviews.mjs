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
import { levelRank, modelByRef, resolveModel } from '../models.mjs'
import { assertNoSecret } from '../policy.mjs'
import { TASK_STATUS, TERMINAL, assertTransition } from '../transitions.mjs'
import { touchAgent } from './agents.mjs'
import { projectAgent } from './agents.mjs'
import { assertOwnerOrContributor } from './gate.mjs'
import { boundaryWarnings } from './spec.mjs'

export const VERDICTS = Object.freeze(['approved', 'changes_requested'])

export const SLOTS = Object.freeze([
  'requirements',
  'architecture',
  'implementation',
  'tests',
  'ui',
  'consistency',
  'security',
  'challenger'
])

export const CONFIDENCE = Object.freeze(['proven', 'likely', 'hypothesis'])

// More than one thing can need checking about one change, and they are not the
// same question: does it meet the requirement, does it belong where it was put,
// does the diff hold up, is it tested, is it consistent with the rest.
//
// ⛔ WHY THERE IS NO QUORUM. The obvious design — the task waits until every
// requested slot answers — deadlocks here, and the live journal shows why: a
// review can be QUEUED for an agent that is not running (see the fallback
// below), and on 2026-09-14 a round-8 review went unanswered because the
// reviewer hit its plan's rate limit. A task that could never move again would
// be the layer's own doing. releaseReview (below) is the escape hatch for
// exactly that case — it did not exist when this note was first written, and
// its absence is why that round-8 review is still sitting there.
//
// So exactly one review gates the task — the BLOCKING one, behaving as it always
// has — and any number of others record a verdict beside it without touching the
// task's status. How many slots a level deserves is judgement, and judgement
// lives in the rules, not here.
const runsFor = (tx, taskId) =>
  tx.list('runs', { filter: (r) => r.task_id === taskId }).map((r) => ({
    id: r.id,
    runner: r.runner,
    status: r.status,
    headline: r.result?.headline || null
  }))

// WHAT THE REVIEWER READS FIRST, and why the order is the mechanism.
//
// The author's own account used to be the opening paragraph, which is the one
// thing a reviewer should read last: "I checked X and it is correct" is an
// anchor, and a reviewer who starts there is checking the account rather than
// the work. Suppressing it would be theatre — the reviewer can read the task
// description, which the author also writes and may edit — so it is not hidden,
// it is put last and labelled as the author's claim.
//
// What comes first instead is what the reviewer is supposed to check against:
// the acceptance criteria, and the checks that actually ran with their counters.
// What one side of a same-vendor review ran on, read from the registry. `rank`
// is null when the name is not a registered model: an unknown model cannot be
// compared, and the caller treats that as "not proven", not as "fine".
function modelReading(config, named) {
  const resolved = resolveModel(config, named)
  const entry = resolved.ref ? modelByRef(config, resolved.ref) : null
  return {
    named: resolved.named,
    ref: resolved.ref,
    level: entry?.level || null,
    rank: entry ? levelRank(config, entry.level) : null
  }
}

// ⛔ The same agent reviewing its own task (single_vendor) has no second model
// family to lean on, so the only independence left is a DIFFERENT model that is
// NOT WEAKER. The rule is refused here, on the request, rather than printed in
// a briefing: a weaker or identical reviewer records a green verdict that means
// less than it looks. The author's model is what the caller says it is, else
// what the task's latest delegation ran on — the journal never observes it.
function assertReviewerModelFitsAuthor(config, task, { reviewer_model, author_model }) {
  if (!reviewer_model) {
    throw new CollabError(
      CODES.INVALID_INPUT,
      'the same agent reviews its own task here (single_vendor), so name the reviewer model: pass reviewer_model, a ref from `collab models` that is not the author\'s and not weaker',
      { field: 'reviewer_model' }
    )
  }
  const authorNamed = author_model || task.delegations?.at(-1)?.model || null
  if (!authorNamed) {
    throw new CollabError(
      CODES.INVALID_INPUT,
      'a same-vendor review compares models, and the author\'s model is not on record: pass author_model, or delegate the work with add_delegation first',
      { field: 'author_model' }
    )
  }
  const reviewer = modelReading(config, reviewer_model)
  const author = modelReading(config, authorNamed)
  if (reviewer.rank === null || author.rank === null) {
    throw new CollabError(
      CODES.INVALID_INPUT,
      `cannot compare "${reviewer.named}" with "${author.named}": a same-vendor review needs both to be models from \`collab models\``,
      { reviewer_model: reviewer.named, author_model: author.named }
    )
  }
  if (reviewer.ref === author.ref) {
    throw new CollabError(CODES.INVALID_INPUT, `the reviewer runs on ${reviewer.ref}, the same model as the author — a same-vendor review needs a different one`, { reviewer_model: reviewer.ref, author_model: author.ref })
  }
  if (reviewer.rank < author.rank) {
    throw new CollabError(
      CODES.INVALID_INPUT,
      `the reviewer model ${reviewer.ref} (${reviewer.level}) is weaker than the author's ${author.ref} (${author.level}) — a same-vendor review must not be weaker`,
      { reviewer_model: reviewer.ref, author_model: author.ref }
    )
  }
  return { reviewer, author }
}

function reviewRequestBody({ task, review, scope, instructions, runs = [] }) {
  const criteria = task.spec?.acceptance_criteria || []
  const lines = [
    `Task: ${task.id} — ${task.title}`,
    `Review: ${review.id} (round ${review.round}${review.slot ? `, slot ${review.slot}` : ''}${review.blocking ? '' : ', not blocking'})`,
    `Scope: ${(scope.length ? scope : task.files || []).join(', ') || 'not narrowed'}`
  ]
  if (task.review_risk || task.spec?.review_risk) {
    lines.push(`Review risk: ${task.review_risk || task.spec.review_risk} (declared by the author)`)
  }
  lines.push('')

  if (criteria.length) {
    lines.push('Done when — check the work against these, not against the author\'s account:')
    criteria.forEach((c, i) => lines.push(`  ${i + 1}. ${c}`))
    lines.push('')
  }
  for (const [field, title] of [
    ['non_goals', 'Deliberately NOT in scope'],
    ['constraints', 'Constraints'],
    ['assumptions', 'Assumed without checking (a good place to look)']
  ]) {
    const items = task.spec?.[field] || []
    if (!items.length) continue
    lines.push(`${title}:`)
    items.forEach((item) => lines.push(`  · ${item}`))
    lines.push('')
  }
  if (runs.length) {
    lines.push('Checks already run (read the counters, not just the status):')
    runs.forEach((r) => lines.push(`  ${r.runner}: ${r.status}${r.headline ? ` — ${r.headline}` : ''} (${r.id})`))
    lines.push('')
  }
  lines.push(
    'Reply with submit_review, verdict approved or changes_requested. changes_requested needs at least one finding. ' +
      'A finding with no evidence is recorded as a hypothesis, not a blocker — say what shows it.'
  )
  if (instructions) {
    lines.push('', "The author's own note, read last and on purpose — it is a claim, not a finding:", `  ${instructions}`)
  }
  if (!criteria.length) {
    lines.push('', 'This task has no acceptance criteria recorded, so intent has to be inferred. Say so if that made the review weaker.')
  }
  return lines.join('\n')
}

function slotOf(value) {
  if (value === undefined || value === null || value === '') return null
  if (!SLOTS.includes(value)) {
    throw new CollabError(CODES.INVALID_INPUT, `slot must be one of ${SLOTS.join(', ')}`, { value, known: SLOTS })
  }
  return value
}

const short = (value, field) => {
  const clean = typeof value === 'string' ? value.trim() : ''
  if (!clean) return null
  if (clean.length > 600) {
    throw new CollabError(CODES.INVALID_INPUT, `a finding's ${field} is a short paragraph, not a report`, { field })
  }
  return assertNoSecret(clean, `review finding ${field}`)
}

// ⛔ NO EVIDENCE, NO BLOCKER. A finding that cannot say what SHOWS it is a
// suspicion, and a suspicion filed as a blocker costs the author a round of
// work to disprove. So confidence is not taken at face value: without evidence
// it is recorded as a hypothesis whatever was claimed, and the severity stays
// as filed so nothing is hidden — the pair reads honestly as "major, but
// unproven". This is a normalisation, never a refusal: a reviewer's suspicion is
// worth recording, just not worth blocking on.
function normaliseFinding(f) {
  const evidence = short(f?.evidence, 'evidence')
  const declared = CONFIDENCE.includes(f?.confidence) ? f.confidence : null
  const confidence = evidence ? declared || 'likely' : 'hypothesis'
  return {
    severity: f?.severity || 'minor',
    confidence,
    file: f?.file || null,
    line: f?.line || null,
    note: assertNoSecret(f?.note || '', 'review finding'),
    criterion: short(f?.criterion, 'criterion'),
    evidence,
    repro: short(f?.repro, 'repro'),
    impact: short(f?.impact, 'impact'),
    recommendation: short(f?.recommendation, 'recommendation')
  }
}

export function requestReview(ctx, {
  task_id,
  reviewer_role = 'code_reviewer',
  reviewer_capability = null,
  reviewer_agent = null,
  instructions = '',
  scope = [],
  slot = null,
  blocking = true,
  reviewer_model = null,
  author_model = null
}) {
  const checking = slotOf(slot)
  const gates = blocking !== false
  return ctx.store.transact(async (tx) => {
    const task = tx.get('tasks', task_id)
    if (!task) throw new CollabError(CODES.NOT_FOUND, `no task ${task_id}`, { id: task_id })
    assertOwnerOrContributor(task, ctx.agentId, 'request a review of')

    // ⛔ THE BUG THIS PREVENTS. Before this check, asking for a second gating
    // review while one was still pending was silently ALLOWED — assertTransition
    // shortcuts when from === to (task already in `review`). Both reviews then
    // sat pending, but only the task's `waiting_on` (overwritten by the newer
    // one) said which one anybody was waiting on. Whichever answered first moved
    // the task out of `review`; the other then hit a table with no edge back in
    // (changes_requested -> review does not exist) and its `approved` failed,
    // while a second `changes_requested` passed through the same from===to
    // shortcut as if it meant something. Refusing the second REQUEST is cheaper
    // than trying to make the state machine cope with two answers to one
    // question — release the first one (release_review) if it is not coming.
    if (gates) {
      const openGate = tx
        .list('reviews', { filter: (r) => r.task_id === task_id && r.verdict === 'pending' && r.blocking !== false })
        .at(-1)
      if (openGate) {
        throw new CollabError(
          CODES.INVALID_INPUT,
          `task ${task_id} already has a pending gating review (${openGate.id}, round ${openGate.round}, routed to ` +
            `${openGate.reviewer}) — release it first with release_review, or ask for a non-blocking slot instead`,
          { task_id, review_id: openGate.id, reviewer: openGate.reviewer }
        )
      }
    }

    const author = task.owner || ctx.agentId
    // One vendor on this machine (the person's composition says so): nobody of
    // another model family exists, so the same agent reviews in a SEPARATE
    // session rather than every review-gated task being stuck forever. The
    // review records it; the owner sees the lower independence.
    const singleVendor = ctx.config?.agents?.review_mode === 'single_vendor'
    let reviewer = reviewer_agent
    if (reviewer) {
      ctx.registry.agent(reviewer)
      if (reviewer === author && !singleVendor) {
        throw new CollabError(CODES.SELF_REVIEW, `${author} cannot review their own work`, { task_id, author })
      }
    } else {
      const query = { role: reviewer_capability ? null : reviewer_role, capability: reviewer_capability }
      let candidates = ctx.registry.find({ ...query, exclude: [author] })
      if (!candidates.length && singleVendor) candidates = ctx.registry.find(query)
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

    // Models are recorded whenever they are given; they are REQUIRED, and
    // compared, only when the author reviews itself.
    const sameAgent = reviewer === author
    let models = null
    if (sameAgent) {
      models = assertReviewerModelFitsAuthor(ctx.config, task, { reviewer_model, author_model })
    } else if (reviewer_model) {
      models = { reviewer: modelReading(ctx.config, reviewer_model), author: null }
    }

    // Only the gating review moves the task. A slot asked for alongside it is
    // an extra opinion, and a task is not "in review" because of one.
    if (gates) assertTransition(task, TASK_STATUS.REVIEW, {})

    // Rounds count ATTEMPTS, not opinions: three slots asked for alongside one
    // gating review are all round 1, which is what makes "round two checks the
    // fix" true. Records written before slots existed have no `blocking` field
    // and count as gating, so the number a task is on does not shift.
    const attempts = tx.list('reviews', { filter: (r) => r.task_id === task_id && r.blocking !== false }).length
    const review = tx.create('reviews', {
      task_id,
      author,
      reviewer,
      requested_by: ctx.agentId,
      requested_role: reviewer_capability ? null : reviewer_role,
      requested_capability: reviewer_capability,
      instructions: assertNoSecret(instructions, 'review instructions'),
      scope: scope.length ? scope : task.files || [],
      slot: checking,
      blocking: gates,
      independence: sameAgent ? 'same_agent_separate_session' : 'independent',
      reviewer_model: models?.reviewer.ref || models?.reviewer.named || null,
      reviewer_model_level: models?.reviewer.level || null,
      author_model: models?.author ? models.author.ref : null,
      author_model_level: models?.author ? models.author.level : null,
      verdict: 'pending',
      summary: null,
      findings: [],
      round: gates ? attempts + 1 : Math.max(1, attempts)
    })

    tx.put('tasks', {
      ...task,
      ...(gates ? { status: TASK_STATUS.REVIEW, waiting_on: { kind: 'agent', ref: review.id } } : {}),
      reviewers: [...new Set([...(task.reviewers || []), reviewer])]
    })

    const message = tx.create('messages', {
      from_agent: ctx.agentId,
      to: { agent: reviewer, role: null, capability: null },
      resolved_at_send: [reviewer],
      message_type: 'review_request',
      subject: `Review requested: ${task.title}`,
      body: reviewRequestBody({ task, review, scope, instructions, runs: runsFor(tx, task_id) }),
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
      slot: review.slot,
      blocking: review.blocking,
      round: review.round,
      message_id: message.id
    })
    // Advice, not a refusal: a review asked for without acceptance criteria is
    // still better than none, but the reviewer will be guessing at intent, and
    // the lead should hear that while it can still be fixed.
    return { review, routed_to: reviewer, message_id: message.id, warnings: boundaryWarnings(task, { what: 'the review' }) }
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

    const normalised = findings.map((f) => normaliseFinding(f))
    const gates = review.blocking !== false

    const nextStatus = verdict === 'approved' ? TASK_STATUS.APPROVED : TASK_STATUS.CHANGES_REQUESTED
    if (gates) {
      assertTransition(task, nextStatus, { review: { reviewer: ctx.agentId, findings: normalised, independence: review.independence } })
    } else if (verdict === 'changes_requested' && normalised.length === 0) {
      // The transition guard carries this rule for a gating review, and a slot
      // that skips the transition must not skip the rule with it: a verdict with
      // no findings tells the author nothing either way.
      throw new CollabError(CODES.INVALID_INPUT, 'changes_requested with no findings tells the author nothing about what to change', {
        review_id
      })
    }

    const stored = tx.put('reviews', {
      ...review,
      verdict,
      summary,
      findings: normalised,
      submitted_at: tx.iso()
    })
    // A slot records its verdict beside the task; only the gating review moves
    // it. See the note above requestReview for why there is no quorum.
    if (gates) tx.put('tasks', { ...task, status: nextStatus, waiting_on: null })

    // ⛔ THE DEFECT THIS CLOSES. get_messages(unread_only: true) is what a
    // reviewer uses to find this review — and being a pure read, it does not
    // mark anything read (see getMessages above: no side effect, on purpose).
    // Only ack_message/reply_message do. The codex-review skill's own prompt
    // tells Codex to call get_messages and finish with submit_review, never
    // ack_message — so every review it has ever answered left its
    // review-request message "unread" forever, even though the review itself
    // has a real verdict. Fixing the one skill would not fix the next one: the
    // review being answered IS the message being answered, structurally, so
    // it is marked here, once, for whichever workflow gets a reviewer this far
    // — this skill, a different one, or a different vendor entirely.
    const requested = tx
      .list('messages', { filter: (m) => m.thread_id === review_id && m.message_type === 'review_request' })
      .find((m) => m.to?.agent === ctx.agentId)
    if (requested && !requested.read_by?.[ctx.agentId]) {
      tx.put('messages', {
        ...requested,
        status: 'answered',
        read_by: { ...(requested.read_by || {}), [ctx.agentId]: tx.iso() }
      })
    }

    tx.create('messages', {
      from_agent: ctx.agentId,
      to: { agent: review.author, role: null, capability: null },
      resolved_at_send: [review.author],
      message_type: 'review_response',
      subject: `Review ${verdict}: ${task.title}`,
      body:
        `${summary || '(no summary)'}\n\n` +
        (normalised.length
          ? normalised
              .map((f, i) => {
                const head = `${i + 1}. [${f.severity}/${f.confidence}] ${f.file || '—'}${f.line ? `:${f.line}` : ''} — ${f.note}`
                const rest = [
                  f.criterion ? `   criterion: ${f.criterion}` : null,
                  f.evidence ? `   shown by: ${f.evidence}` : null,
                  f.repro ? `   repro: ${f.repro}` : null,
                  f.impact ? `   impact: ${f.impact}` : null,
                  f.recommendation ? `   do: ${f.recommendation}` : null
                ].filter(Boolean)
                return [head, ...rest].join('\n')
              })
              .join('\n')
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
      slot: review.slot || null,
      blocking: gates,
      findings: normalised.length,
      hypotheses: normalised.filter((f) => f.confidence === 'hypothesis').length,
      round: review.round
    })
    return {
      review: stored,
      // What the task is NOW, which for a slot is what it already was.
      task_status: gates ? nextStatus : task.status,
      blocking: gates,
      proven: normalised.filter((f) => f.confidence !== 'hypothesis').length,
      hypotheses: normalised.filter((f) => f.confidence === 'hypothesis').length
    }
  })
}

export const RELEASED = 'released'

function assertMayRelease(task, review, actor) {
  if (actor === review.reviewer || actor === review.requested_by) return
  if (task && (task.owner === actor || (task.contributors || []).includes(actor))) return
  throw new CollabError(
    CODES.NOT_PERMITTED,
    `${actor} is neither the reviewer, the requester, nor the task's owner or a contributor, so it cannot release review ${review.id}`,
    { id: review.id, reviewer: review.reviewer, requested_by: review.requested_by, actor }
  )
}

// Void a review nobody is going to answer: the reviewer is offline for good, a
// duplicate request slipped through before the guard above existed, or the work
// moved on and the question no longer applies. Two callers may do this — the
// reviewer, declining what it cannot get to, or whoever could have requested it
// (the requester, or the task's owner/a contributor) — the same people who could
// ask for it in the first place may take the question back.
//
// Releasing the GATING review leaves the task somewhere real: BLOCKED, with the
// reason recorded, rather than silently in `review` waiting on nothing. A slot
// review carries no such consequence — it never held the task up.
export function releaseReview(ctx, { review_id, reason = '' }) {
  assertNoSecret(reason, 'review release reason')
  return ctx.store.transact(async (tx) => {
    const review = tx.get('reviews', review_id)
    if (!review) throw new CollabError(CODES.NOT_FOUND, `no review ${review_id}`, { id: review_id })
    if (review.verdict !== 'pending') {
      throw new CollabError(CODES.INVALID_INPUT, `review ${review_id} already returned "${review.verdict}"`, {
        id: review_id,
        verdict: review.verdict
      })
    }
    const task = tx.get('tasks', review.task_id)
    assertMayRelease(task, review, ctx.agentId)

    const stored = tx.put('reviews', {
      ...review,
      verdict: RELEASED,
      released_at: tx.iso(),
      released_by: ctx.agentId,
      release_reason: reason || null
    })

    let taskStatus = task?.status || null
    const wasGating = task && !TERMINAL.has(task.status) && task.waiting_on?.kind === 'agent' && task.waiting_on?.ref === review_id
    if (wasGating) {
      const blockedReason = reason || `review ${review_id} was released`
      if (task.status === TASK_STATUS.REVIEW) {
        // The only edge out of `review` that does not claim an answer that was
        // never given: not approved, not changes_requested, just stopped.
        assertTransition(task, TASK_STATUS.BLOCKED, { reason: blockedReason })
        tx.put('tasks', { ...task, status: TASK_STATUS.BLOCKED, blocked_reason: blockedReason, waiting_on: null })
        taskStatus = TASK_STATUS.BLOCKED
      } else {
        // Status already moved on by some other path (a manual override, an
        // older bug) — nothing to transition, just stop pointing at a review
        // that no longer exists as a live question.
        tx.put('tasks', { ...task, waiting_on: null })
      }
    }

    if (task && review.author !== ctx.agentId) {
      tx.create('messages', {
        from_agent: ctx.agentId,
        to: { agent: review.author, role: null, capability: null },
        resolved_at_send: [review.author],
        message_type: 'review_response',
        subject: `Review released: ${task.title}`,
        body:
          `${review.id} (round ${review.round}, routed to ${review.reviewer}) was released instead of answered.\n\n` +
          `${reason || '(no reason given)'}`,
        task_id: review.task_id,
        thread_id: review.id,
        in_reply_to: null,
        priority: 'normal',
        requires_reply: false,
        status: 'unread',
        read_by: {},
        replied_by: null
      })
    }

    touchAgent(tx, ctx)
    tx.emit('review.released', { collection: 'reviews', id: review_id }, {
      task_id: review.task_id,
      reviewer: review.reviewer,
      slot: review.slot || null,
      blocking: review.blocking !== false,
      by: ctx.agentId,
      reason
    })
    return { review: stored, task_status: taskStatus }
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
