// Screen-shaped projections stay separate from HTTP so the same contract can
// be tested without a listening socket.

const LIVE_DECISIONS = new Set(['open', 'disputed', 'escalated'])

export async function overviewView(api) {
  const status = await api.status()
  const report = api.doctor()
  return {
    initialized: true,
    journal_root: status.journal_root,
    status,
    doctor: {
      problems: report.problems || [],
      agents: report.agents || [],
      unheld_roles: report.unheld_roles || [],
      models: report.models || []
    }
  }
}

export const tasksView = (api, filters) => api.listTasks(filters)

export async function taskView(api, taskId) {
  const task = api.getTask({ task_id: taskId })
  return {
    task,
    reviews: api.listReviews({ task_id: taskId }),
    // getMessages() also filters by who a message is addressed to, and the panel
    // reads as the lead: that would hide every message between other agents.
    // The task's page is the whole conversation about it.
    messages: api.store.list('messages', { filter: (message) => message.task_id === taskId, limit: 200 }),
    delegations: task.delegations || []
  }
}

export async function waitingView(api) {
  const live = new Set((await api.listTasks({ open: true })).map((task) => task.id))
  return {
    approvals: api.listApprovals({ pending_only: true }),
    decisions: api.listDecisions({}).filter((decision) => LIVE_DECISIONS.has(decision.status)),
    reviews: api.listReviews({ pending_only: true }).filter((review) => live.has(review.task_id)),
    commands: {
      approve: 'collab approve <id>',
      reject: 'collab reject <id> --note …'
    }
  }
}

export function rosterView(api) {
  const agents = api.listAgents().map((agent) => ({
    id: agent.id,
    name: agent.name,
    provider: agent.provider,
    roles: agent.roles,
    capabilities: agent.capabilities,
    status: agent.runtime?.effective_status || 'offline'
  }))
  return {
    lead: api.config.agents?.lead || null,
    review_mode: api.config.agents?.review_mode || 'cross_vendor',
    agents,
    roles: api.registry.roles(),
    models: api.listModels()
  }
}

export const eventsView = (api, limit) => api.events({ limit })

export const setupCheckView = (api) => api.doctor()
