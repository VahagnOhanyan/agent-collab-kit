// Tasks: the unit of work, its lease, and the file ownership that keeps two
// agents out of the same source file.
//
// claimTask is a compare-and-set. The comparison happens INSIDE the transaction,
// after the lock is held, which is what makes it safe when two processes race:
// the second one re-reads and sees the first one's write. Losing that race
// returns `claimed: false` rather than throwing, because for a worker loop
// losing a race is a normal outcome, not an error.
//
// FILE OWNERSHIP. `.claude/rules/workflow.md` says one writing agent per tree.
// That rule was true and unenforced. claimFiles gives it a machine: an overlap
// with another live task's claim is refused, and it names the task and the owner
// so the caller can go and talk to them instead of guessing.

import { CODES, CollabError } from '../errors.mjs'
import { effectiveReviewRisk } from '../models.mjs'
import { ACTION_KINDS, classifyAction } from '../policy.mjs'
import { normaliseEvidence, normaliseSpec } from './spec.mjs'
import { LEASED_STATES, admitWork, assertMayHold, assertOwnerOrContributor } from './gate.mjs'
import { TASK_STATUS, TERMINAL, allowedNext, assertTransition } from '../transitions.mjs'
import { touchAgent } from './agents.mjs'
import { holdsReviewerRole } from './reviewer-roles.mjs'

const DEFAULT_LEASE_SECONDS = 3600

// A lease says "somebody is working on this right now". Only these two states
// mean that. A task in `review` is not abandoned — it is waiting on a reviewer
// who may not run for a day; the same goes for one waiting on the owner, on
// another agent, or one sitting in `changes_requested` until its author comes
// back. Sweeping those was a real bug: on 2026-09-10 a task parked in `review`
// was released overnight, and the reviewer had to shove it back through
// `in_progress` before it could answer the review that was still pending on it.
// (LEASED_STATES lives in gate.mjs, next to the rule about who may hold a task.)

export function projectTask(task, { now, leaseSeconds }) {
  const expiresAt = task.lease?.expires_at ? Date.parse(task.lease.expires_at) : null
  const holdsLease = LEASED_STATES.has(task.status)
  const leaseExpired = Boolean(holdsLease && expiresAt && expiresAt < now)
  const active = !TERMINAL.has(task.status)
  // Parked means "it is somebody's turn". With no owner there is nobody whose
  // turn it is, so it must stay pickable — otherwise a task that lost its owner
  // (a crash, or the sweep bug above) is stuck in a state nothing can leave.
  const parked = active && !holdsLease && task.status !== TASK_STATUS.CREATED && Boolean(task.owner)
  return {
    ...task,
    lease_expired: leaseExpired,
    // "Claimable" is derived, never stored: a task whose owner vanished is
    // available the moment the lease lapses, with nothing having had to run.
    // A parked task is not claimable however long it sits — it is somebody's
    // turn, and taking it would be taking it away from them.
    claimable: active && !parked && (task.status === TASK_STATUS.CREATED || !task.owner || leaseExpired),
    waiting_on_somebody: parked,
    allowed_next: allowedNext(task),
    lease_seconds: leaseSeconds
  }
}

// Derived on read, from things the layer knows for itself: how long each open
// delegation has been running, and what the review risk EFFECTIVELY is once the
// floor implied by the action class is applied to what the task declared. Both
// are computed rather than stored so neither can drift away from the record.
function withDerived(ctx, task) {
  const risk = effectiveReviewRisk(ctx.config, {
    declared: task.spec?.review_risk || null,
    actionClass: task.action_class || null
  })
  const now = ctx.clock.now()
  return {
    ...task,
    review_risk: risk.level,
    review_risk_declared: task.spec?.review_risk || null,
    review_risk_floor: risk.floor,
    review_risk_raised_by_floor: risk.raised,
    delegations: (task.delegations || []).map((d) => ({
      ...d,
      running_ms: d.finished_at ? null : Math.max(0, now - Date.parse(d.started_at)),
      took_ms: d.finished_at ? Math.max(0, Date.parse(d.finished_at) - Date.parse(d.started_at)) : null
    }))
  }
}

const project = (ctx, task) =>
  task
    ? withDerived(
        ctx,
        projectTask(task, {
          now: ctx.clock.now(),
          leaseSeconds: ctx.registry.defaults().lease_seconds || DEFAULT_LEASE_SECONDS
        })
      )
    : null

export function getTask(ctx, id) {
  const task = ctx.store.get('tasks', id)
  if (!task) throw new CollabError(CODES.NOT_FOUND, `no task ${id}`, { id })
  return project(ctx, task)
}

export function listTasks(ctx, { status = null, owner = null, role = null, open = null, limit = 0 } = {}) {
  const statuses = status ? (Array.isArray(status) ? status : [status]) : null
  return ctx.store
    .list('tasks', {
      filter: (t) => {
        if (statuses && !statuses.includes(t.status)) return false
        if (owner && t.owner !== owner) return false
        if (role && t.role !== role) return false
        if (open === true && TERMINAL.has(t.status)) return false
        if (open === false && !TERMINAL.has(t.status)) return false
        return true
      },
      limit
    })
    .map((t) => project(ctx, t))
}

export function createTask(ctx, input) {
  const { title, description = '', role = null, priority = 'p2', needs_review = true, action = null, action_kind = null, files = [], depends_on = [], spec = null } = input
  if (!title || title.length < 3) {
    throw new CollabError(CODES.INVALID_INPUT, 'a task needs a title that says what is to be done')
  }
  if (role) {
    ctx.registry.role(role)
    // A task for a role nobody holds can never be claimed: it would sit unassigned and look like work in progress.
    // Refused here, like a review, a message or an assignment addressed to such a role — the roster and the roles
    // work is asked of must agree.
    if (!ctx.registry.find({ role }).length) {
      throw new CollabError(
        CODES.NO_AGENT_AVAILABLE,
        `no registered agent holds "${role}", so a task for it could never be claimed — give the role to an agent in the composition first, or create the task without a role`,
        { role }
      )
    }
  }
  const taskSpec = normaliseSpec(ctx.config, spec)

  // Classification is computed here, from the table — never taken from the
  // caller. An agent that supplies its own action_class has it ignored. A kind
  // (action_kind) is one more match: it can raise the class, never lower it.
  const words = action || title
  const subject = action_kind ? { ...(typeof words === 'string' ? { summary: words } : words), kind: action_kind } : words
  const verdict = classifyAction(ctx.config.policy, subject)
  // ⛔ An action the table does not recognise goes back to its author, not to the owner (owner, 03.10.2026). Before,
  // it became an approval "just in case", and the owner was asked about "Stage 2: model tests" because the words had
  // no verb. Nothing is created, so nothing reaches the owner; the agent says what it will do — a verb and an object,
  // or a kind. Fail-closed still: the unknown is never treated as safe. requestApproval and the gate are unchanged.
  if (!verdict.matched.length) {
    throw new CollabError(
      CODES.ACTION_UNRECOGNISED,
      `the action "${typeof words === 'string' ? words : words?.summary || ''}" is not recognised by the policy table, so the task is not created: say what you will DO — a verb and an object ("fix the frame crop on iPhone Duo", "write tests for the story model", "исправить обрезку кадра", "написать тесты модели"), not the task's title or a symptom — or pass action_kind (${Object.keys(ACTION_KINDS).join(', ')})`,
      { action: words, kinds: Object.keys(ACTION_KINDS) }
    )
  }

  return ctx.store.transact(async (tx) => {
    const task = tx.create('tasks', {
      title,
      description,
      status: TASK_STATUS.CREATED,
      priority,
      role,
      needs_review,
      owner: null,
      created_by: ctx.agentId,
      contributors: [],
      reviewers: [],
      // Stored as classified: the gate reads it again at claim time and must reach the same class.
      action: subject,
      action_class: verdict.action_class,
      requires_approval: verdict.requires_approval,
      approval_id: null,
      files: normalisePaths(files),
      depends_on,
      spec: taskSpec,
      lease: null,
      git_base: null,
      branch: null,
      blocked_reason: null,
      waiting_on: null
    })
    touchAgent(tx, ctx)
    // The spec itself is deliberately NOT in the payload: an event is capped at
    // 16 KB and a truncated one loses the whole `data`, so what goes here is the
    // three levels, which is what a later reading of the journal needs.
    tx.emit('task.created', { collection: 'tasks', id: task.id }, {
      title,
      action_class: verdict.action_class,
      requires_approval: verdict.requires_approval,
      levels: taskSpec
        ? {
            complexity: taskSpec.complexity || null,
            implementation_risk: taskSpec.implementation_risk || null,
            review_risk: taskSpec.review_risk || null,
            ux_impact: taskSpec.ux_impact || null
          }
        : null
    })
    return project(ctx, task)
  })
}

function approvalFor(tx, task) {
  return task.approval_id ? tx.get('approvals', task.approval_id) : null
}

// Both ways into `completed` (complete_task and update_task with a status) pass
// these to the guard; a path that passes none fails closed on a UX-gated task.
function reviewsOf(tx, task) {
  return tx.list('reviews', { filter: (r) => r.task_id === task.id })
}

export function claimTask(ctx, { task_id = null, role = null, lease_seconds = null, git_base = null } = {}) {
  const leaseSeconds = lease_seconds || ctx.registry.defaults().lease_seconds || DEFAULT_LEASE_SECONDS

  return ctx.store.transact(async (tx) => {
    const now = tx.now()

    // Pick a candidate deterministically so two racers choose the SAME task and
    // one loses cleanly, rather than each quietly taking a different one.
    let task
    if (task_id) {
      task = tx.get('tasks', task_id)
      if (!task) throw new CollabError(CODES.NOT_FOUND, `no task ${task_id}`, { id: task_id })
    } else {
      const candidates = tx
        .list('tasks', {
          filter: (t) => {
            const p = projectTask(t, { now, leaseSeconds })
            if (!p.claimable) return false
            if (role && t.role !== role) return false
            if (t.role && !ctx.registry.hasRole(ctx.agentId, t.role)) return false
            return true
          }
        })
        .sort((a, b) => (a.priority || 'p2').localeCompare(b.priority || 'p2') || a.id.localeCompare(b.id))
      task = candidates[0]
      if (!task) return { claimed: false, reason: 'NOTHING_CLAIMABLE', task: null }
    }

    const projected = projectTask(task, { now, leaseSeconds })
    if (!projected.claimable) {
      return {
        claimed: false,
        reason: CODES.ALREADY_CLAIMED,
        message: `task ${task.id} is ${task.status} and held by ${task.owner}`,
        task: project(ctx, task)
      }
    }
    // The gate: hold, role, policy and grant — and the lease this claim gets.
    const admission = admitWork(tx, ctx, task, { leaseSeconds })

    if (projected.lease_expired && task.owner && task.owner !== ctx.agentId) {
      // Record the steal before performing it, so the audit log shows why a task
      // changed hands rather than just that it did.
      tx.emit('task.lease_expired', { collection: 'tasks', id: task.id }, {
        previous_owner: task.owner,
        expired_at: task.lease?.expires_at
      })
    }

    assertTransition(task, TASK_STATUS.IN_PROGRESS, { admission })
    const next = tx.put('tasks', { ...task, ...admission.fields, git_base: git_base || task.git_base })
    touchAgent(tx, ctx, { status: 'busy', current_task_id: task.id })
    tx.emit('task.claimed', { collection: 'tasks', id: task.id }, { owner: ctx.agentId })
    return { claimed: true, task: project(ctx, next) }
  })
}

export function assignTask(ctx, { task_id, to_agent = null, role = null, capability = null }) {
  return ctx.store.transact(async (tx) => {
    const task = tx.get('tasks', task_id)
    if (!task) throw new CollabError(CODES.NOT_FOUND, `no task ${task_id}`, { id: task_id })

    let target = to_agent
    if (!target) {
      const found = ctx.registry.find({ role, capability, exclude: [], includeSelf: true })
      if (!found.length) {
        throw new CollabError(CODES.NO_AGENT_AVAILABLE, `no registered agent holds ${role || capability}`, { role, capability })
      }
      target = found[0].id
    }
    ctx.registry.agent(target)
    if (task.role && !ctx.registry.hasRole(target, task.role)) {
      throw new CollabError(CODES.NOT_PERMITTED, `${target} does not hold role "${task.role}"`, { id: task_id, role: task.role })
    }

    // Coordination may place an unowned task. Taking a HELD one away is refused:
    // only its holder hands it over, or anyone once the holder's lease lapsed.
    // Without this, assign-to-self then update_task walked past the gate.
    assertMayHold(tx, task, ctx.agentId, 'reassign')
    assertTransition(task, TASK_STATUS.ASSIGNED, {})
    // An assignment carries a lease, so an assignee that never starts does not
    // hold the task forever: when it lapses the task can be reassigned or swept.
    const leaseSeconds = ctx.registry.defaults().lease_seconds || DEFAULT_LEASE_SECONDS
    const next = tx.put('tasks', {
      ...task,
      status: TASK_STATUS.ASSIGNED,
      owner: target,
      lease: { holder: target, acquired_at: tx.iso(), expires_at: new Date(tx.now() + leaseSeconds * 1000).toISOString() }
    })
    touchAgent(tx, ctx)
    tx.emit('task.assigned', { collection: 'tasks', id: task_id }, { to: target, by: ctx.agentId })
    return project(ctx, next)
  })
}

export function updateTask(ctx, { task_id, status = null, expected_version, note = null, reason = null, patch = {} }) {
  // Shape-checked before the lock, like the title in createTask: a malformed
  // patch has no business first taking a transaction on a shared journal. The
  // merge itself needs the stored spec, so it happens again inside.
  if (patch.spec !== undefined) normaliseSpec(ctx.config, patch.spec)
  return ctx.store.transact(async (tx) => {
    const task = tx.get('tasks', task_id)
    if (!task) throw new CollabError(CODES.NOT_FOUND, `no task ${task_id}`, { id: task_id })

    // Field edits (title, description, files…) by any agent keep their old
    // behaviour. STATUS changes do not: see below.
    const fields = { ...task, ...pick(patch, ['title', 'description', 'priority', 'files', 'depends_on', 'branch', 'waiting_on']) }
    if (patch.files !== undefined) fields.files = normalisePaths(fields.files)
    // `spec` is merged, not replaced: it is filled in as the work is understood,
    // and having to re-send the whole thing to add one criterion is how a field
    // like this ends up unused. It is handled here rather than in `pick` for
    // that reason — and because a field the MCP layer does not validate must be
    // normalised before it reaches the disk, or it silently stores nonsense.
    if (patch.spec !== undefined) fields.spec = normaliseSpec(ctx.config, patch.spec, task.spec)
    let admission = null
    if (status && status !== task.status) {
      const pendingApproval =
        task.approval_id && tx.get('approvals', task.approval_id)?.status === 'pending' ? task.approval_id : null
      if (status === TASK_STATUS.IN_PROGRESS) {
        // Moving into work by status is moving into work: the same gate as a
        // claim (hold, role, policy, grant), and the caller gets the lease.
        admission = admitWork(tx, ctx, task)
      } else {
        // Re-statusing a task somebody else holds would let a caller release it
        // and then claim it — the lease bypassed in two steps.
        assertMayHold(tx, task, ctx.agentId, 'change the status of')
      }
      const reviews = status === TASK_STATUS.COMPLETED ? reviewsOf(tx, task) : []
      // The spec being written in this same call counts: raising ux_impact and
      // completing in one update must not slip past the gate on the old spec.
      assertTransition({ ...task, spec: fields.spec }, status, { reason, pendingApproval, admission, reviews })
      fields.status = status
      if (admission) Object.assign(fields, admission.fields)
      if (status === TASK_STATUS.BLOCKED) fields.blocked_reason = reason
      if (status === TASK_STATUS.IN_PROGRESS) fields.blocked_reason = null
    }
    const next = tx.put('tasks', fields, { expectedVersion: expected_version })
    touchAgent(tx, ctx, admission ? { status: 'busy', current_task_id: task_id } : {})
    tx.emit('task.updated', { collection: 'tasks', id: task_id }, { status: fields.status, note, reason })
    return project(ctx, next)
  })
}

export function completeTask(ctx, { task_id, summary = '', evidence = null, expected_version }) {
  const bundle = normaliseEvidence(evidence)
  return ctx.store.transact(async (tx) => {
    const task = tx.get('tasks', task_id)
    if (!task) throw new CollabError(CODES.NOT_FOUND, `no task ${task_id}`, { id: task_id })
    assertOwnerOrContributor(task, ctx.agentId, 'complete')
    const approval = approvalFor(tx, task)
    const pendingApproval = approval && approval.status === 'pending' ? approval.id : null

    assertTransition(task, TASK_STATUS.COMPLETED, { pendingApproval, reviews: reviewsOf(tx, task) })
    const next = tx.put(
      'tasks',
      { ...task, status: TASK_STATUS.COMPLETED, lease: null, completion_summary: summary, evidence: bundle },
      { expectedVersion: expected_version }
    )
    touchAgent(tx, ctx, { status: 'available', current_task_id: null })
    tx.emit('task.completed', { collection: 'tasks', id: task_id }, {
      by: ctx.agentId,
      summary,
      unverified: bundle?.unverified?.length || 0
    })
    return project(ctx, next)
  })
}

// An agent the owner took out of the composition (the panel's wizard) can still hold tasks in this project's journal —
// the composition is per machine, the journal per project, so this runs wherever a session opens (the opportunistic
// sweep) and right after the panel writes the composition. Each open task it holds goes to an agent in the
// composition holding the task's role: the one with the fewest open tasks, the lead on a tie. Work in hand becomes
// "assigned" to it; a task in review, approved or waiting keeps its status and only changes holder. When nobody holds
// the role, the task goes back to the queue if it can, and is reported as kept otherwise. Nothing to hand over,
// nothing written.
// A blocked task stays blocked with its new holder: the reason it was blocked has not gone away with the old one.
const KEEP_STATUS_ON_HANDOVER = new Set([TASK_STATUS.REVIEW, TASK_STATUS.APPROVED, TASK_STATUS.WAITING_FOR_USER, TASK_STATUS.WAITING_FOR_AGENT, TASK_STATUS.BLOCKED])

export function handOverFromAbsent(ctx, { lead = null } = {}) {
  const absent = (id) => Boolean(id) && !ctx.registry.has(id)
  const absentOwned = (t) => absent(t.owner) && !TERMINAL.has(t.status)
  const absentReviewer = (r) => r.verdict === 'pending' && absent(r.reviewer)
  if (!ctx.store.list('tasks', { filter: absentOwned }).length && !ctx.store.list('reviews', { filter: absentReviewer }).length) {
    return Promise.resolve({ handed_over: [], queued: [], kept: [], reviews: [] })
  }
  return ctx.store.transact(async (tx) => {
    const handedOver = []
    const queued = []
    const kept = []
    const reviewsMoved = []
    const load = new Map()
    for (const t of tx.list('tasks', { filter: (t) => Boolean(t.owner) && !TERMINAL.has(t.status) })) load.set(t.owner, (load.get(t.owner) || 0) + 1)
    const leaseSeconds = ctx.registry.defaults().lease_seconds || DEFAULT_LEASE_SECONDS
    const byLoad = (a, b) => (load.get(a.id) || 0) - (load.get(b.id) || 0) || (a.id === lead ? -1 : b.id === lead ? 1 : 0) || a.id.localeCompare(b.id)
    const pendingReviewers = (taskId) => new Set(tx.list('reviews', { filter: (r) => r.task_id === taskId && r.verdict === 'pending' }).map((r) => r.reviewer))

    for (const task of tx.list('tasks', { filter: absentOwned })) {
      const from = task.owner
      const reason = `${from} is no longer in the composition`
      // A session of the excluded agent may still be running and holding the work: a live lease is not taken away —
      // the task moves once the lease lapses (the next sweep after that). Two writers on one task is the one thing a
      // handover must never cause.
      const projected = projectTask(task, { now: tx.now(), leaseSeconds })
      if (LEASED_STATES.has(task.status) && task.lease && !projected.lease_expired) {
        kept.push({ id: task.id, status: task.status, owner: from, why: 'lease' })
        continue
      }
      // The new holder is never one of the task's pending reviewers: they could no longer answer their own review.
      const reviewers = pendingReviewers(task.id)
      const holders = ctx.registry.agents()
        .filter((a) => (task.role ? ctx.registry.hasRole(a.id, task.role) : true) && !reviewers.has(a.id))
        .sort(byLoad)
      const target = holders[0]?.id || null
      const lease = (holder) => ({ holder, acquired_at: tx.iso(), expires_at: new Date(tx.now() + leaseSeconds * 1000).toISOString() })
      // The one who left is no longer a contributor either: if they come back later, the task is not theirs to move.
      const contributors = (task.contributors || []).filter((id) => id !== from)
      if (target) {
        const keepStatus = KEEP_STATUS_ON_HANDOVER.has(task.status)
        const status = keepStatus ? task.status : TASK_STATUS.ASSIGNED
        // in_progress cannot become assigned directly; through the queue it can, which is what a handover is.
        if (!keepStatus && !allowedNext(task).includes(TASK_STATUS.ASSIGNED) && !allowedNext(task).includes(TASK_STATUS.CREATED)) {
          kept.push({ id: task.id, status: task.status, owner: from, why: 'status' })
          continue
        }
        tx.put('tasks', { ...task, status, owner: target, contributors: [...new Set([...contributors, target])], lease: keepStatus && !task.lease ? null : lease(target) })
        load.set(target, (load.get(target) || 0) + 1)
        tx.emit('task.handed_over', { collection: 'tasks', id: task.id }, { from, to: target, reason, status })
        handedOver.push({ id: task.id, from, to: target, status })
      } else if (allowedNext(task).includes(TASK_STATUS.CREATED)) {
        tx.put('tasks', { ...task, status: TASK_STATUS.CREATED, owner: null, lease: null, contributors })
        tx.emit('task.released', { collection: 'tasks', id: task.id }, { by: 'collab', previous_owner: from, reason: `${reason}; nobody holds role ${task.role}` })
        queued.push({ id: task.id, from, role: task.role })
      } else {
        // Nobody holds the role and the task cannot go back to the queue from where it stands (in review, approved,
        // waiting): it stays, and `collab doctor` / the panel name it as work of a role nobody holds.
        kept.push({ id: task.id, status: task.status, owner: from, why: 'no holder' })
      }
    }

    // A pending review whose reviewer left goes to another agent with the requested role — never the author or a
    // contributor of the task, and of another vendor than the author, so the review stays independent. None such:
    // it stays, and the requester can release it (release_review) and ask again.
    for (const review of tx.list('reviews', { filter: absentReviewer })) {
      const task = tx.get('tasks', review.task_id)
      const near = new Set([review.author, task?.owner, ...(task?.contributors || [])].filter(Boolean))
      const authorVendor = review.author && ctx.registry.has(review.author) ? ctx.registry.agent(review.author).provider : null
      const candidates = ctx.registry.agents()
        // A reviewer at all (a read-only role, not suspended), whether the review asked for a role or a capability.
        .filter((a) => !near.has(a.id) && (review.requested_role ? ctx.registry.hasRole(a.id, review.requested_role) : true) && holdsReviewerRole(ctx, a.id, review.requested_role) && (!authorVendor || a.provider !== authorVendor))
        .sort(byLoad)
      const target = candidates[0]?.id || null
      if (!target) {
        reviewsMoved.push({ id: review.id, task_id: review.task_id, from: review.reviewer, to: null })
        continue
      }
      tx.put('reviews', { ...review, reviewer: target, independence: 'independent' })
      tx.emit('review.handed_over', { collection: 'reviews', id: review.id }, { from: review.reviewer, to: target, task_id: review.task_id, reason: `${review.reviewer} is no longer in the composition` })
      reviewsMoved.push({ id: review.id, task_id: review.task_id, from: review.reviewer, to: target })
    }
    return { handed_over: handedOver, queued, kept, reviews: reviewsMoved }
  })
}

export function releaseTask(ctx, { task_id, reason = 'released' }) {
  return ctx.store.transact(async (tx) => {
    const task = tx.get('tasks', task_id)
    if (!task) throw new CollabError(CODES.NOT_FOUND, `no task ${task_id}`, { id: task_id })
    // Only the holder (or anyone, once nobody holds it) may give it back.
    assertMayHold(tx, task, ctx.agentId, 'release')
    assertTransition(task, TASK_STATUS.CREATED, {})
    const next = tx.put('tasks', { ...task, status: TASK_STATUS.CREATED, owner: null, lease: null })
    touchAgent(tx, ctx, { status: 'available', current_task_id: null })
    tx.emit('task.released', { collection: 'tasks', id: task_id }, { by: ctx.agentId, previous_owner: task.owner, reason })
    return project(ctx, next)
  })
}

export function claimFiles(ctx, { task_id, paths }) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new CollabError(CODES.INVALID_INPUT, 'claim_files needs at least one path')
  }
  return ctx.store.transact(async (tx) => {
    const task = tx.get('tasks', task_id)
    if (!task) throw new CollabError(CODES.NOT_FOUND, `no task ${task_id}`, { id: task_id })
    // A claim is made by whoever is doing the work, so that the claim hangs off a
    // lease with a holder. Claiming for a task nobody has taken produced a claim
    // with no owner and no lease — and nothing can expire a lease that does not
    // exist. create_task's `files` reached the same dead end.
    assertOwnerOrContributor(task, ctx.agentId, 'claim files for')

    const now = tx.now()
    const leaseSeconds = ctx.registry.defaults().lease_seconds || DEFAULT_LEASE_SECONDS
    const conflicts = []
    // AN OWNERLESS TASK HOLDS NOTHING. On 2026-09-13 three files in a project
    // tree were locked by a task nobody had ever claimed, and `collab status`
    // printed its holder as `null`: the listing was there, the lease never was,
    // so `lease_expired` stayed false forever. Ownership is what holds a file,
    // not the listing.
    for (const other of tx.list('tasks', { filter: (t) => t.id !== task_id && !TERMINAL.has(t.status) && Boolean(t.owner) })) {
      const live = projectTask(other, { now, leaseSeconds })
      if (live.lease_expired) continue // an abandoned claim holds nothing
      for (const path of other.files || []) {
        if (paths.some((p) => overlaps(p, path))) {
          conflicts.push({ path, task_id: other.id, owner: other.owner, title: other.title })
        }
      }
    }
    if (conflicts.length) {
      throw new CollabError(
        CODES.PATH_CONFLICT,
        `those files are claimed by other live work: ${conflicts.map((c) => `${c.path} (${c.task_id}, ${c.owner})`).join('; ')}`,
        { conflicts }
      )
    }

    const next = tx.put('tasks', { ...task, files: [...new Set([...(task.files || []), ...paths])] })
    touchAgent(tx, ctx)
    tx.emit('task.files_claimed', { collection: 'tasks', id: task_id }, { paths })
    return project(ctx, next)
  })
}

// Claimed paths are free-form strings an agent chooses, never run through
// node:path — overlaps() below treats a literal '/' as the nesting separator
// (matching git's own path spelling, which never uses '\' even on a Windows
// checkout). Normalising every path to that form here, once, wherever one
// enters `files` (create_task, update_task, claim_files), keeps the
// comparison correct regardless of which OS the calling agent runs on —
// without a Windows-flavoured agent's backslashed claim silently failing to
// register as nested under a POSIX-spelled directory claim.
const toPosixPath = (p) => String(p).replace(/\\/g, '/')
const normalisePaths = (paths) => (Array.isArray(paths) ? paths.map(toPosixPath) : paths)

// Directory-prefix aware: claiming `App/Map/` conflicts with a claim on a
// file inside it, which is the case that actually bites.
function overlaps(a, b) {
  if (a === b) return true
  const dirA = a.endsWith('/') ? a : `${a}/`
  const dirB = b.endsWith('/') ? b : `${b}/`
  return a.startsWith(dirB) || b.startsWith(dirA)
}

// Opportunistic recovery. Runs on the reads a working agent already makes, so a
// task abandoned by a crashed session becomes claimable without anything
// scheduled and without a process that has to stay alive.
export function sweep(ctx) {
  const leaseSeconds = ctx.registry.defaults().lease_seconds || DEFAULT_LEASE_SECONDS
  const staleAfterMs = (ctx.registry.defaults().heartbeat_stale_seconds || 900) * 1000
  const now = ctx.clock.now()

  // Only work somebody is actively holding can be abandoned. projectTask already
  // refuses to expire a lease on a parked task; the filter mirrors it so the
  // intent is visible at the call site too.
  const expired = ctx.store
    .list('tasks', { filter: (t) => LEASED_STATES.has(t.status) && t.owner })
    .filter((t) => projectTask(t, { now, leaseSeconds }).lease_expired)

  const goneQuiet = ctx.store
    .list('agents', { filter: (a) => a.status !== 'offline' && a.status !== 'failed' })
    .filter((a) => now - (a.last_seen_at ? Date.parse(a.last_seen_at) : 0) > staleAfterMs)

  if (!expired.length && !goneQuiet.length) return { released: [], marked_offline: [] }

  // The lists above are OBSERVATIONS made without the lock. Between them and the
  // transaction an owner may renew its lease, request a review, finish, or come
  // back online. So every candidate is re-read and re-decided under the lock,
  // and skipped if its record moved at all.
  return ctx.store.transact(async (tx) => {
    const lockedNow = tx.now()
    const released = []
    for (const task of expired) {
      const fresh = tx.get('tasks', task.id)
      if (!fresh || fresh.version !== task.version) continue
      if (!LEASED_STATES.has(fresh.status) || !fresh.owner) continue
      if (!projectTask(fresh, { now: lockedNow, leaseSeconds }).lease_expired) continue
      tx.put('tasks', { ...fresh, status: TASK_STATUS.CREATED, owner: null, lease: null })
      tx.emit('task.released', { collection: 'tasks', id: task.id }, {
        by: 'sweep',
        previous_owner: fresh.owner,
        reason: 'lease expired — the owner stopped reporting in'
      })
      released.push(task.id)
    }
    const offline = []
    for (const agent of goneQuiet) {
      const fresh = tx.get('agents', agent.id)
      if (!fresh || fresh.version !== agent.version) continue
      if (fresh.status === 'offline' || fresh.status === 'failed') continue
      if (lockedNow - (fresh.last_seen_at ? Date.parse(fresh.last_seen_at) : 0) <= staleAfterMs) continue
      tx.put('agents', { ...fresh, status: 'offline' })
      tx.emit('agent.status', { collection: 'agents', id: agent.id }, { status: 'offline', by: 'sweep' })
      offline.push(agent.id)
    }
    return { released, marked_offline: offline }
  })
}

function pick(source, keys) {
  const out = {}
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key]
  return out
}
