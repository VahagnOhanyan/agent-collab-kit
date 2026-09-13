// Asynchronous messages between agents.
//
// A message stores the SELECTOR it was addressed with — an agent id, a role, or
// a capability — and never a resolved recipient list. Resolution happens when an
// inbox is read, against the registry as it is then. Granting an agent the
// code_reviewer role therefore makes every pending role-addressed message
// visible to it without rewriting a single record.
//
// ⛔ The obvious optimisation — resolve at send time and store an array of ids —
// silently destroys that, and with it the reason routing is by role at all.
//
// Asynchrony is structural: a message is a file. Neither side has to be running
// when the other writes, which is the only assumption that survives two agents
// with independent session lifetimes.

import { CODES, CollabError } from '../errors.mjs'
import { assertNoSecret } from '../policy.mjs'
import { touchAgent } from './agents.mjs'

export const MESSAGE_TYPES = Object.freeze([
  'question',
  'answer',
  'review_request',
  'review_response',
  'task_assignment',
  'task_update',
  'blocking_issue',
  'decision_request',
  'decision',
  'completion',
  'clarification'
])

function resolveSelector(ctx, to) {
  if (to.agent) {
    ctx.registry.agent(to.agent)
    return [to.agent]
  }
  const found = ctx.registry.find({ role: to.role || null, capability: to.capability || null })
  return found.map((a) => a.id)
}

export function sendMessage(ctx, input) {
  const {
    to_agent = null,
    to_role = null,
    to_capability = null,
    message_type = 'question',
    subject = '',
    body,
    task_id = null,
    thread_id = null,
    in_reply_to = null,
    priority = 'normal',
    requires_reply = false
  } = input

  if (!MESSAGE_TYPES.includes(message_type)) {
    throw new CollabError(CODES.INVALID_INPUT, `unknown message_type "${message_type}"`, { known: MESSAGE_TYPES })
  }
  if (!body || body.trim().length < 2) {
    throw new CollabError(CODES.INVALID_INPUT, 'a message needs a body')
  }
  if (!to_agent && !to_role && !to_capability) {
    throw new CollabError(CODES.INVALID_INPUT, 'address the message to an agent, a role, or a capability')
  }
  assertNoSecret(body, 'message body')
  assertNoSecret(subject, 'message subject')

  const to = { agent: to_agent, role: to_role, capability: to_capability }
  const recipients = resolveSelector(ctx, to)
  if (recipients.length === 0) {
    throw new CollabError(
      CODES.NO_AGENT_AVAILABLE,
      `nobody registered holds ${to_role || to_capability} — the message would go nowhere`,
      { to }
    )
  }

  return ctx.store.transact(async (tx) => {
    const message = tx.create('messages', {
      from_agent: ctx.agentId,
      to,
      // Kept for the audit trail: who the selector meant AT THE TIME, which is
      // what you need when asking later why somebody did or did not see it.
      resolved_at_send: recipients,
      message_type,
      subject,
      body,
      task_id,
      thread_id: thread_id || in_reply_to || null,
      in_reply_to,
      priority,
      requires_reply,
      status: 'unread',
      read_by: {},
      replied_by: null
    })
    const fixed = message.thread_id ? message : tx.put('messages', { ...message, thread_id: message.id })
    touchAgent(tx, ctx)
    tx.emit('message.sent', { collection: 'messages', id: message.id }, {
      to,
      message_type,
      recipients,
      task_id
    })
    return fixed
  })
}

export function getMessages(ctx, { agent_id = null, unread_only = false, task_id = null, thread_id = null, limit = 50 } = {}) {
  const who = agent_id || ctx.agentId
  ctx.registry.agent(who)

  const addressed = (message) => {
    const to = message.to || {}
    if (to.agent) return to.agent === who
    if (to.role) return ctx.registry.hasRole(who, to.role)
    if (to.capability) return ctx.registry.hasCapability(who, to.capability)
    return false
  }

  return ctx.store.list('messages', {
    filter: (m) => {
      if (thread_id) return m.thread_id === thread_id
      if (task_id && m.task_id !== task_id) return false
      if (!addressed(m)) return false
      if (unread_only && m.read_by && m.read_by[who]) return false
      return true
    },
    limit
  })
}

export function getThread(ctx, thread_id) {
  return ctx.store.list('messages', { filter: (m) => m.thread_id === thread_id || m.id === thread_id })
}

export function ackMessage(ctx, { message_id }) {
  return ctx.store.transact(async (tx) => {
    const message = tx.get('messages', message_id)
    if (!message) throw new CollabError(CODES.NOT_FOUND, `no message ${message_id}`, { id: message_id })
    const next = tx.put('messages', {
      ...message,
      read_by: { ...(message.read_by || {}), [ctx.agentId]: tx.iso() },
      status: 'read'
    })
    touchAgent(tx, ctx)
    return next
  })
}

export function replyMessage(ctx, { message_id, body, message_type = 'answer' }) {
  const original = ctx.store.get('messages', message_id)
  if (!original) throw new CollabError(CODES.NOT_FOUND, `no message ${message_id}`, { id: message_id })

  const reply = sendMessage(ctx, {
    to_agent: original.from_agent,
    message_type,
    subject: original.subject ? `Re: ${original.subject}` : '',
    body,
    task_id: original.task_id,
    thread_id: original.thread_id || original.id,
    in_reply_to: original.id
  })

  return reply.then
    ? reply.then(async (created) => {
        await ctx.store.update('messages', message_id, (current) => ({
          replied_by: ctx.agentId,
          status: 'answered',
          read_by: { ...(current.read_by || {}), [ctx.agentId]: ctx.clock.iso() }
        }))
        return created
      })
    : reply
}
