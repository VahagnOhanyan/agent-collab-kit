// The single facade. The MCP server, the CLI and the tests all go through here
// and never touch the store directly.
//
// Having exactly one entry point is what makes "the MCP surface has no tool that
// grants an approval" a checkable statement: there is one list of what the
// outside world can ask for, and resolveApproval is not on it. The CLI reaches
// the approval resolver by importing the domain module directly, which is a
// deliberate asymmetry, not an oversight — see domain/approvals.mjs.
//
// Identity comes from COLLAB_AGENT_ID, set per client at registration time:
// `claude` in .mcp.json, `codex` in ~/.codex/config.toml. Without it the process
// refuses to start, the same way backend/mcp/config.js refuses without
// AWEIRO_AS_USER — an unidentified writer in a shared ledger is worse than none.

import { execFileSync } from 'node:child_process'
import { CODES, CollabError } from './errors.mjs'
import { systemClock } from './ids.mjs'
import { REPO_ROOT, stateRoot } from './paths.mjs'
import { classifyAction } from './policy.mjs'
import { createRegistry, loadRegistryConfig } from './registry.mjs'
import { createStore } from './store.mjs'
import * as agents from './domain/agents.mjs'
import * as approvals from './domain/approvals.mjs'
import * as decisions from './domain/decisions.mjs'
import * as messages from './domain/messages.mjs'
import * as reviews from './domain/reviews.mjs'
import * as tasks from './domain/tasks.mjs'
import * as runs from './runs.mjs'
import { adapterFor } from './adapters/index.mjs'

const SWEEP_INTERVAL_MS = 60_000

export function createApi({ agentId, root = null, clock = systemClock, configDir = undefined } = {}) {
  if (!agentId) {
    throw new CollabError(
      CODES.CONFIG_INVALID,
      'COLLAB_AGENT_ID is required — every write is attributed, so the layer will not run for an anonymous caller'
    )
  }
  const config = loadRegistryConfig(configDir)
  const registry = createRegistry(config)
  registry.agent(agentId) // fails fast if the caller is not a registered agent

  const store = createStore({ root: root || stateRoot(), agentId, clock })
  const ctx = { store, registry, config, clock, agentId }

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

  const api = {
    ctx,
    agentId,
    registry,
    config,
    store,

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
        briefing_file: declared.briefing_file,
        state_dir: store.paths.root,
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
      return {
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
        reviews_pending: reviews.listReviews(ctx, { pending_only: true }).length,
        approvals_pending: approvals.listApprovals(ctx, { pending_only: true }).length,
        decisions_open: decisions.listDecisions(ctx, {}).filter((d) => ['open', 'disputed', 'escalated'].includes(d.status)).length,
        runs_failed: runs.listRuns(ctx, { failed_only: true }).length,
        git: gitSnapshot(all)
      }
    },

    doctor() {
      const declared = registry.agents()
      return {
        state_dir: store.paths.root,
        repo_root: REPO_ROOT,
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

// Read-only git context, so `collab status` can put ownership next to reality:
// a dirty file that no task claims is somebody else's work in progress, and
// saying so is more useful than pretending the tree is ours.
function gitSnapshot(allTasks) {
  const run = (args) => {
    try {
      return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim()
    } catch {
      return ''
    }
  }
  const head = run(['rev-parse', '--short', 'HEAD'])
  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD'])
  const dirty = run(['status', '--porcelain'])
    .split('\n')
    .filter(Boolean)
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
    head,
    branch,
    dirty_files: dirty.length,
    unclaimed_dirty: dirty.filter((f) => !owns(f)),
    claimed_dirty: dirty.filter((f) => owns(f)).map((f) => ({ file: f, ...owns(f) }))
  }
}
