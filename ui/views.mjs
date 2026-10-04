// Screen-shaped projections stay separate from HTTP so the same contract can
// be tested without a listening socket.

import { standstillOf } from './standstill.mjs'
import { classifyAction } from '../collab/src/policy.mjs'

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
      orphaned_tasks: report.orphaned_tasks || [],
      suspended_roles: report.suspended_roles || [],
      models: report.models || []
    }
  }
}

export async function tasksView(api, filters) {
  const tasks = await api.listTasks(filters)
  const reviews = api.listReviews({})
  const approvals = api.listApprovals({ pending_only: true })
  return tasks.map((task) => ({ ...task, standstill: standstillOf(task, { reviews, approvals }) }))
}

export async function taskView(api, taskId) {
  const task = api.getTask({ task_id: taskId })
  const reviews = api.listReviews({ task_id: taskId })
  // The tree is read from one field, `parent_task`: the parent is looked up, the children are the tasks that name this
  // one. Nothing about children is stored on the parent, so the two sides cannot disagree.
  const everyTask = await api.listTasks({})
  const brief = ({ id, title, status, owner }) => ({ id, title, status, owner: owner || null })
  const parent = task.parent_task ? everyTask.find((t) => t.id === task.parent_task) : null
  // The cost is read from the agents' own logs on demand (collab/src/usage.mjs); a log that cannot be read is "no
  // data" for that task, never a reason the page does not open.
  const costOf = (id) => {
    try {
      return api.taskUsage({ task_id: id })
    } catch {
      return null
    }
  }
  const usage = costOf(taskId)
  // The branch: this task and everything created within it, however deep (capped, and a task is counted once).
  const branch = { tasks: 0, total: { input: 0, output: 0, cache_creation: 0, cache_read: 0 }, approximate: false }
  const seen = new Set()
  const queue = [taskId]
  while (queue.length && seen.size < 60) {
    const id = queue.shift()
    if (seen.has(id)) continue
    seen.add(id)
    const cost = id === taskId ? usage : costOf(id)
    if (cost && !cost.none) {
      branch.tasks += 1
      branch.approximate ||= cost.approximate
      for (const key of Object.keys(branch.total)) branch.total[key] += cost.total[key] || 0
    }
    for (const child of everyTask) if (child.parent_task === id) queue.push(child.id)
  }
  // The skills the task's role names (roles.json): a hint for whoever takes it, shown so the owner sees what was meant.
  const skills = task.role && Array.isArray(api.config?.roles?.roles?.[task.role]?.skills) ? api.config.roles.roles[task.role].skills : []
  return {
    task,
    skills,
    usage,
    branch: { ...branch, descendants: seen.size - 1, none: branch.tasks === 0 },
    parent: parent ? brief(parent) : null,
    children: everyTask.filter((t) => t.parent_task === taskId).map(brief),
    standstill: standstillOf(task, { reviews, approvals: api.listApprovals({ pending_only: true, task_id: taskId }) }),
    reviews,
    // getMessages() also filters by who a message is addressed to, and the panel
    // reads as the lead: that would hide every message between other agents.
    // The task's page is the whole conversation about it.
    messages: api.store.list('messages', { filter: (message) => message.task_id === taskId, limit: 200 }),
    delegations: task.delegations || []
  }
}

export async function waitingView(api) {
  const live = new Set((await api.listTasks({ open: true })).map((task) => task.id))
  // A question or a review belongs to a task (open or not): the screen names that task and its status beside it.
  const byId = new Map((await api.listTasks({})).map((task) => [task.id, task]))
  const taskOf = (id) => {
    const task = id ? byId.get(id) : null
    return task ? { task_title: task.title, task_status: task.status } : null
  }
  // A task waiting for the owner, with what the owner can do about it now. Its approval may be live (approve or
  // reject it), expired (it can no longer be granted — the agent asks again, or the owner closes the task) or absent
  // (asked without one). Without this list an expired approval leaves the task stuck and the screen says "nothing".
  const waitingTasks = (await api.listTasks({ open: true })).filter((task) => task.status === 'waiting_for_user').map((task) => {
    const asked = api.listApprovals({ pending_only: true, task_id: task.id })
    const live = asked.find((approval) => !approval.expired) || null
    const latest = live || asked.at(-1) || null
    // The class the task waits under was fixed when it was created, by the table of that day; the same words read
    // by the table in force now may say something else (an old table missed Russian). Shown beside it, never instead:
    // the stored class is what blocks the task.
    let now = null
    try {
      if (api.config?.policy && task.action) {
        const read = classifyAction(api.config.policy, task.action)
        now = { action_class: read.action_class, reason: read.reason, recognised: read.matched.length > 0, requires_approval: read.requires_approval }
      }
    } catch {
      now = null // a policy that cannot be read is no reason to hide the task
    }
    return {
      id: task.id,
      title: task.title,
      action: task.action?.summary || (typeof task.action === 'string' ? task.action : null),
      action_class: task.action_class || latest?.action_class || null,
      owner: task.owner || task.created_by || null,
      policy_reason: latest?.policy_reason || null,
      reason: latest?.reason || null,
      approval: latest ? { id: latest.id, expired: Boolean(latest.expired), expires_at: latest.expires_at || null } : null,
      now,
      state: live ? 'live' : latest ? 'expired' : 'none'
    }
  })
  return {
    tasks: waitingTasks,
    approvals: api.listApprovals({ pending_only: true }).map((approval) => ({ ...approval, ...taskOf(approval.task_id) })),
    decisions: api.listDecisions({}).filter((decision) => LIVE_DECISIONS.has(decision.status)).map((decision) => ({ ...decision, ...taskOf(decision.task_id) })),
    reviews: api.listReviews({ pending_only: true }).filter((review) => live.has(review.task_id)).map((review) => ({ ...review, ...taskOf(review.task_id) })),
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
