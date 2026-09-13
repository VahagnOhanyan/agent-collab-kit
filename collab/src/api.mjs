// The single facade. The MCP server, the CLI and the tests all go through here
// and never touch the store directly.
//
// Having exactly one entry point is what makes "the MCP surface has no tool that
// grants an approval" a checkable statement: there is one list of what the
// outside world can ask for, and resolveApproval is not on it. The CLI reaches
// the approval resolver by importing the domain module directly, which is a
// deliberate asymmetry, not an oversight — see domain/approvals.mjs.
//
// Identity comes from COLLAB_AGENT_ID, set per client at registration time.
// Without it the process refuses to start — an unidentified writer in a shared
// ledger is worse than none.
//
// Roots (journal, working tree, state dir) are resolved once here and handed to
// the domain through ctx.roots; nothing below this file decides where it is.

import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { CODES, CollabError } from './errors.mjs'
import { systemClock } from './ids.mjs'
import { DEFAULT_REGISTRY_DIR, INSTALL_ROOT, ignoredEnv, journalState, resolveRoots, runGit, safeRealpath } from './paths.mjs'
import { findProject } from './projects.mjs'
import { classifyAction } from './policy.mjs'
import { createRegistry, loadConfig } from './registry.mjs'
import { createStore } from './store.mjs'
import * as agents from './domain/agents.mjs'
import * as approvals from './domain/approvals.mjs'
import * as decisions from './domain/decisions.mjs'
import * as messages from './domain/messages.mjs'
import * as reviews from './domain/reviews.mjs'
import * as tasks from './domain/tasks.mjs'
import * as delegations from './domain/delegations.mjs'
import * as runs from './runs.mjs'
import { adapterFor } from './adapters/index.mjs'

const SWEEP_INTERVAL_MS = 60_000

export const isUninitialised = (error) =>
  error instanceof CollabError && [CODES.NOT_INITIALIZED, CODES.ROOT_REFUSED, CODES.JOURNAL_INVALID].includes(error.code)

function notInitialised(roots, state) {
  if (!roots.journalRoot) {
    return new CollabError(
      CODES.NOT_INITIALIZED,
      `no collab journal for ${roots.cwd}: it is not inside a git repository and no .collab/ directory exists above it. ` +
        'Run `collab init` in the project root to start one — nothing is created implicitly.',
      { command: 'collab init', run_in: 'the project root directory', cwd: roots.cwd }
    )
  }
  const reason = state?.reason || `${roots.stateDir} does not exist`
  return new CollabError(
    CODES.NOT_INITIALIZED,
    `this project has no usable collab journal: ${reason}. ` +
      `Run \`collab init\` in ${roots.journalRoot} — nothing is created implicitly.`,
    { command: 'collab init', run_in: roots.journalRoot, journal_root: roots.journalRoot, state_dir: roots.stateDir, reason }
  )
}

// Whether the trusted registry vouches for a markerless legacy journal at a root.
// Any lookup failure answers no: the journal is then refused, not trusted.
export const legacyJournalLookup =
  ({ registryDir = DEFAULT_REGISTRY_DIR, home = undefined } = {}) =>
  (root) => {
    if (!root) return false
    try {
      return findProject(root, { registry: registryDir, home })?.legacyJournal === true
    } catch {
      return false
    }
  }

// Options — all trusted inputs are parameters, never environment variables:
//   agentId      required
//   root         explicit state directory (tests); shorthand for roots.stateDir
//   roots        explicit { journalRoot, codeRoot, stateDir } — skips resolution
//   cwd/home     inputs to resolveRoots when roots are not given
//   projectRoot  explicit journal root (tests)
//   configDir    explicit config directory (tests); otherwise registry/defaults
//   registryDir  the trusted registry (default DEFAULT_REGISTRY_DIR)
export function createApi({
  agentId,
  root = null,
  roots: givenRoots = null,
  cwd = undefined,
  home = undefined,
  clock = systemClock,
  configDir = undefined,
  registryDir = DEFAULT_REGISTRY_DIR,
  projectRoot = null
} = {}) {
  if (!agentId) {
    throw new CollabError(
      CODES.CONFIG_INVALID,
      'COLLAB_AGENT_ID is required — every write is attributed, so the layer will not run for an anonymous caller'
    )
  }

  let roots
  let rootsError = null
  if (root || givenRoots) {
    const stateDir = root ? resolve(root) : givenRoots.stateDir ? resolve(givenRoots.stateDir) : null
    roots = {
      cwd: null,
      journalRoot: givenRoots?.journalRoot ? safeRealpath(givenRoots.journalRoot) : null,
      codeRoot: givenRoots?.codeRoot ? safeRealpath(givenRoots.codeRoot) : null,
      stateDir,
      source: 'explicit'
    }
  } else {
    try {
      roots = resolveRoots({ cwd, projectRoot, legacyJournalFor: legacyJournalLookup({ registryDir, home }), ...(home ? { home } : {}) })
    } catch (error) {
      if (!isUninitialised(error)) throw error
      rootsError = error
      roots = { cwd: cwd || process.cwd(), journalRoot: null, codeRoot: null, stateDir: null, source: null }
    }
  }

  // Identity and config are checked before the journal, so a misregistered
  // agent fails loudly even in a folder that has no journal.
  const config = loadConfig({ journalRoot: roots.journalRoot, configDir, registryDir, home })
  const registry = createRegistry(config)
  registry.agent(agentId) // fails fast if the caller is not a registered agent

  if (rootsError) throw rootsError
  // Initialised means `collab init` made it (or it is a complete legacy journal):
  // a symlink, an empty directory or a half-built one is refused before any mkdir.
  // A tracked or copied journal is JOURNAL_INVALID, not merely uninitialised.
  const state = roots.stateDir
    ? roots.journal ||
      journalState(roots.stateDir, {
        legacyJournal: legacyJournalLookup({ registryDir, home })(roots.journalRoot || dirname(roots.stateDir))
      })
    : null
  if (state?.code === CODES.JOURNAL_INVALID) {
    throw new CollabError(CODES.JOURNAL_INVALID, state.reason, {
      journal_root: roots.journalRoot,
      state_dir: roots.stateDir,
      reason: state.reason,
      ...(state.moved ? { command: 'collab init --adopt' } : {})
    })
  }
  if (!state?.initialized) throw notInitialised(roots, state)

  const store = createStore({ root: roots.stateDir, agentId, clock, legacyJournal: state.kind === 'legacy' })
  const ctx = { store, registry, config, clock, agentId, roots }

  let lastSweep = 0
  const maybeSweep = async () => {
    const now = clock.now()
    if (now - lastSweep < SWEEP_INTERVAL_MS) return
    lastSweep = now
    try {
      await tasks.sweep(ctx)
    } catch {
      // Recovery is opportunistic. A failed sweep must never fail the call the
      // agent actually made.
    }
  }

  const configSource = () => {
    const source = config.meta?.source || { kind: 'built-in' }
    if (source.kind === 'project') return `registry project "${source.id}" (${source.dir})`
    if (source.kind === 'config-dir') return `config dir ${source.dir}`
    return 'built-in defaults'
  }

  const api = {
    ctx,
    agentId,
    registry,
    config,
    store,
    roots,

    // ── identity and discovery ────────────────────────────────────────────
    whoami() {
      const declared = registry.agent(agentId)
      const mine = tasks.listTasks(ctx, { owner: agentId, open: true })
      return {
        agent_id: agentId,
        name: declared.name,
        provider: declared.provider,
        roles: declared.roles,
        capabilities: declared.capabilities,
        briefing: declared.briefing,
        briefing_file: registry.briefingPath(agentId),
        journal_root: roots.journalRoot,
        worktree: roots.codeRoot,
        state_dir: store.paths.root,
        config: configSource(),
        open_tasks: mine.map((t) => ({ id: t.id, title: t.title, status: t.status })),
        unread_messages: messages.getMessages(ctx, { unread_only: true }).length,
        pending_reviews: reviews.listReviews(ctx, { reviewer: agentId, pending_only: true }).length,
        how_to_reply:
          'Read your inbox with get_messages, take work with claim_task, answer a review with submit_review. ' +
          'Anything that costs money, touches production or destroys data goes through request_user_approval and stops there.'
      }
    },

    listAgents: (input = {}) => agents.listAgents(ctx, input),
    getAgent: ({ agent_id }) => agents.readAgent(ctx, agent_id),
    findAgents: ({ role = null, capability = null, exclude_self = false } = {}) =>
      registry
        .find({ role, capability, includeSelf: !exclude_self, self: agentId })
        .map((a) => agents.readAgent(ctx, a.id)),
    setStatus: (input) => agents.setStatus(ctx, input),

    // ── tasks ─────────────────────────────────────────────────────────────
    createTask: (input) => tasks.createTask(ctx, input),
    getTask: ({ task_id }) => tasks.getTask(ctx, task_id),
    async listTasks(input = {}) {
      await maybeSweep()
      return tasks.listTasks(ctx, input)
    },
    claimTask: (input = {}) => tasks.claimTask(ctx, input),
    assignTask: (input) => tasks.assignTask(ctx, input),
    updateTask: (input) => tasks.updateTask(ctx, input),
    completeTask: (input) => tasks.completeTask(ctx, input),
    blockTask: ({ task_id, reason, expected_version }) =>
      tasks.updateTask(ctx, { task_id, status: 'blocked', reason, expected_version }),
    releaseTask: (input) => tasks.releaseTask(ctx, input),
    claimFiles: (input) => tasks.claimFiles(ctx, input),
    addDelegation: (input) => delegations.addDelegation(ctx, input),
    completeDelegation: (input) => delegations.completeDelegation(ctx, input),
    sweep: () => tasks.sweep(ctx),

    // ── messages ──────────────────────────────────────────────────────────
    sendMessage: (input) => messages.sendMessage(ctx, input),
    async getMessages(input = {}) {
      await maybeSweep()
      return messages.getMessages(ctx, input)
    },
    getThread: ({ thread_id }) => messages.getThread(ctx, thread_id),
    ackMessage: (input) => messages.ackMessage(ctx, input),
    replyMessage: (input) => messages.replyMessage(ctx, input),

    // ── reviews ───────────────────────────────────────────────────────────
    requestReview: (input) => reviews.requestReview(ctx, input),
    submitReview: (input) => reviews.submitReview(ctx, input),
    listReviews: (input = {}) => reviews.listReviews(ctx, input),

    // ── decisions ─────────────────────────────────────────────────────────
    createDecision: (input) => decisions.createDecision(ctx, input),
    addPosition: (input) => decisions.addPosition(ctx, input),
    resolveDecision: (input) => decisions.resolveDecision(ctx, { ...input, decided_by_kind: 'agent' }),
    escalateDecision: (input) => decisions.escalateDecision(ctx, input),
    listDecisions: (input = {}) => decisions.listDecisions(ctx, input),

    // ── approvals: request and read only ──────────────────────────────────
    requestUserApproval: (input) => approvals.requestApproval(ctx, input),
    listApprovals: (input = {}) => approvals.listApprovals(ctx, input),
    checkPolicy: ({ action }) => classifyAction(config.policy, action),

    // ── checks ────────────────────────────────────────────────────────────
    listRunners: () => runs.listRunners(ctx),
    startRun: (input) => runs.startRun(ctx, input),
    getRun: (input) => runs.getRun(ctx, input),
    listRuns: (input = {}) => runs.listRuns(ctx, input),

    // ── observability ─────────────────────────────────────────────────────
    events: (query = {}) => store.events(query),

    async status() {
      await maybeSweep()
      const all = tasks.listTasks(ctx, {})
      const byStatus = {}
      for (const task of all) byStatus[task.status] = (byStatus[task.status] || 0) + 1

      // A pending review whose task was cancelled or completed is STALE, not
      // waiting: nobody is going to answer it, because the work it asked about
      // no longer exists. Counting it as pending made this line tell the owner
      // that something was outstanding when nothing was — seen on 2026-09-13,
      // where `reviews pending 1` pointed at a task cancelled the day before.
      // `collab reviews` already draws this distinction (status: stale); status
      // now agrees with it instead of contradicting it.
      const liveTaskIds = new Set(all.filter((t) => !['completed', 'cancelled'].includes(t.status)).map((t) => t.id))
      const pendingReviews = reviews.listReviews(ctx, { pending_only: true })
      const waitingReviews = pendingReviews.filter((r) => liveTaskIds.has(r.task_id))
      return {
        journal_root: roots.journalRoot,
        agents: agents.listAgents(ctx).map((a) => ({
          id: a.id,
          roles: a.roles,
          status: a.runtime.effective_status,
          current_task_id: a.runtime.current_task_id || null,
          last_seen_at: a.runtime.last_seen_at,
          adapter: adapterFor(a).describe()
        })),
        tasks: {
          by_status: byStatus,
          open: all.filter((t) => !['completed', 'cancelled'].includes(t.status)).length,
          stale: all.filter((t) => t.lease_expired).length
        },
        reviews_pending: waitingReviews.length,
        reviews_stale: pendingReviews.length - waitingReviews.length,
        approvals_pending: approvals.listApprovals(ctx, { pending_only: true }).length,
        decisions_open: decisions.listDecisions(ctx, {}).filter((d) => ['open', 'disputed', 'escalated'].includes(d.status)).length,
        runs_failed: runs.listRuns(ctx, { failed_only: true }).length,
        delegations: delegations.openDelegations(ctx),
        git: gitSnapshot(roots.codeRoot, all)
      }
    },

    doctor() {
      const declared = registry.agents()
      return {
        state_dir: store.paths.root,
        journal_root: roots.journalRoot,
        journal_kind: state.kind,
        worktree: roots.codeRoot,
        root_source: roots.source,
        config: configSource(),
        registry: registryDir,
        ignored_env: ignoredEnv(),
        install_root: INSTALL_ROOT,
        agents: declared.map((agent) => {
          const view = agents.readAgent(ctx, agent.id)
          const adapter = adapterFor(view)
          return {
            id: agent.id,
            roles: agent.roles,
            runtime_status: view.runtime.effective_status,
            last_seen_at: view.runtime.last_seen_at,
            ...adapter.probe()
          }
        }),
        runners: runs.listRunners(ctx),
        unheld_roles: Object.keys(registry.roles()).filter((role) => registry.find({ role }).length === 0)
      }
    }
  }

  return api
}

// `collab project`: what this layer would use for a directory, as one answer
// skills and hooks can rely on. It reads; it never creates or writes anything,
// and it does not need a journal or a valid identity.
export function describeProject({
  cwd = process.cwd(),
  home = undefined,
  registryDir = DEFAULT_REGISTRY_DIR,
  projectRoot = null,
  configDir = null,
  env = process.env
} = {}) {
  const answer = {
    cwd: safeRealpath(cwd),
    journalRoot: null,
    codeRoot: null,
    stateDir: null,
    initialized: false,
    projectId: null,
    registryDir,
    configSource: configDir ? 'config-dir' : 'built-in',
    ignoredEnv: ignoredEnv(env),
    error: null
  }
  let roots
  try {
    roots = resolveRoots({ cwd, projectRoot, legacyJournalFor: legacyJournalLookup({ registryDir, home }), ...(home ? { home } : {}) })
  } catch (error) {
    answer.error = { code: error.code || 'ERROR', message: error.message }
    return answer
  }
  Object.assign(answer, {
    journalRoot: roots.journalRoot,
    codeRoot: roots.codeRoot,
    stateDir: roots.stateDir,
    initialized: roots.initialized,
    journalProblem: roots.journal && !roots.journal.initialized ? { code: roots.journal.code, reason: roots.journal.reason } : null
  })
  if (!configDir && roots.journalRoot) {
    try {
      const project = findProject(roots.journalRoot, { registry: registryDir, home })
      if (project) {
        answer.projectId = project.id
        answer.configSource = 'registry'
      }
    } catch (error) {
      answer.error = { code: error.code || 'ERROR', message: error.message }
    }
  }
  return answer
}

// Read-only git context, so `collab status` can put ownership next to reality:
// a dirty file that no task claims is somebody else's work in progress, and
// saying so is more useful than pretending the tree is ours. It looks at ONE
// working tree — the caller's — and says which.
function gitSnapshot(worktree, allTasks) {
  const run = (args) => {
    try {
      return runGit(worktree, args).trim()
    } catch {
      return ''
    }
  }
  // Only a directory that IS a work tree's top level is inspected; otherwise git
  // would walk up and report some unrelated enclosing repository.
  const isWorktree = Boolean(worktree && existsSync(worktree) && safeRealpath(run(['rev-parse', '--show-toplevel']) || '/nonexistent') === worktree)
  if (!isWorktree) {
    return { worktree, is_git: false, head: '', branch: '', dirty_files: 0, unclaimed_dirty: [], claimed_dirty: [] }
  }
  const head = run(['rev-parse', '--short', 'HEAD'])
  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD'])
  // ⛔ NOT through run(): it trims, and a porcelain line starts with a SPACE when
  // a file is modified in the working tree but not staged (" M path"). Trimming
  // the whole output ate that space on the first line only, and slice(3) then ate
  // the first letter of its path — `.claude/rules/…` was printed as
  // `claude/rules/…`. Worse than the typo: the mangled path no longer matched its
  // own task's claim, so a claimed file was reported as claimed by nobody, which
  // is the one question this snapshot exists to answer.
  const porcelain = (() => {
    try {
      return runGit(worktree, ['status', '--porcelain'])
    } catch {
      return ''
    }
  })()
  const dirty = porcelain
    .split('\n')
    // A line is two status columns, a space, then the path: shorter than four
    // characters is the trailing empty line, not a file.
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3))

  const claimed = new Map()
  for (const task of allTasks) {
    if (['completed', 'cancelled'].includes(task.status)) continue
    for (const file of task.files || []) claimed.set(file, { task_id: task.id, owner: task.owner })
  }

  const owns = (path) => {
    for (const [claim, who] of claimed) {
      if (path === claim || path.startsWith(claim.endsWith('/') ? claim : `${claim}/`)) return who
    }
    return null
  }

  return {
    worktree,
    is_git: true,
    head,
    branch,
    dirty_files: dirty.length,
    unclaimed_dirty: dirty.filter((f) => !owns(f)),
    claimed_dirty: dirty.filter((f) => owns(f)).map((f) => ({ file: f, ...owns(f) }))
  }
}
