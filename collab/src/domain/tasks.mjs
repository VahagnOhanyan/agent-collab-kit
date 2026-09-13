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
import { classifyAction } from '../policy.mjs'
import { LEASED_STATES, admitWork, assertMayHold, assertOwnerOrContributor } from './gate.mjs'
import { TASK_STATUS, TERMINAL, allowedNext, assertTransition } from '../transitions.mjs'
import { touchAgent } from './agents.mjs'

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

const project = (ctx, task) =>
  task
    ? projectTask(task, {
        now: ctx.clock.now(),
        leaseSeconds: ctx.registry.defaults().lease_seconds || DEFAULT_LEASE_SECONDS
      })
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
  const { title, description = '', role = null, priority = 'p2', needs_review = true, action = null, files = [], depends_on = [] } = input
  if (!title || title.length < 3) {
    throw new CollabError(CODES.INVALID_INPUT, 'a task needs a title that says what is to be done')
  }
  if (role) ctx.registry.role(role)

  // Classification is computed here, from the table — never taken from the
  // caller. An agent that supplies its own action_class has it ignored.
  const verdict = classifyAction(ctx.config.policy, action || title)

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
      action: action || title,
      action_class: verdict.action_class,
      requires_approval: verdict.requires_approval,
      approval_id: null,
      files,
      depends_on,
      lease: null,
      git_base: null,
      branch: null,
      blocked_reason: null,
      waiting_on: null
    })
    touchAgent(tx, ctx)
    tx.emit('task.created', { collection: 'tasks', id: task.id }, {
      title,
      action_class: verdict.action_class,
      requires_approval: verdict.requires_approval
    })
    return project(ctx, task)
  })
}

function approvalFor(tx, task) {
  return task.approval_id ? tx.get('approvals', task.approval_id) : null
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
  return ctx.store.transact(async (tx) => {
    const task = tx.get('tasks', task_id)
    if (!task) throw new CollabError(CODES.NOT_FOUND, `no task ${task_id}`, { id: task_id })

    // Field edits (title, description, files…) by any agent keep their old
    // behaviour. STATUS changes do not: see below.
    const fields = { ...task, ...pick(patch, ['title', 'description', 'priority', 'files', 'depends_on', 'branch', 'waiting_on']) }
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
      assertTransition(task, status, { reason, pendingApproval, admission })
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

export function completeTask(ctx, { task_id, summary = '', expected_version }) {
  return ctx.store.transact(async (tx) => {
    const task = tx.get('tasks', task_id)
    if (!task) throw new CollabError(CODES.NOT_FOUND, `no task ${task_id}`, { id: task_id })
    assertOwnerOrContributor(task, ctx.agentId, 'complete')
    const approval = approvalFor(tx, task)
    const pendingApproval = approval && approval.status === 'pending' ? approval.id : null

    assertTransition(task, TASK_STATUS.COMPLETED, { pendingApproval })
    const next = tx.put(
      'tasks',
      { ...task, status: TASK_STATUS.COMPLETED, lease: null, completion_summary: summary },
      { expectedVersion: expected_version }
    )
    touchAgent(tx, ctx, { status: 'available', current_task_id: null })
    tx.emit('task.completed', { collection: 'tasks', id: task_id }, { by: ctx.agentId, summary })
    return project(ctx, next)
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
    // AN OWNERLESS TASK HOLDS NOTHING. On 2026-09-13 three files in the Tripix
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

// Directory-prefix aware: claiming `Tripix/TripMap/` conflicts with a claim on a
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
