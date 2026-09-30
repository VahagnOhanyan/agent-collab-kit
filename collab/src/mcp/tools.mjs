// The tool surface agents see.
//
// ⛔ THE MOST IMPORTANT PROPERTY OF THIS FILE IS SOMETHING THAT IS NOT IN IT.
// There is no tool that grants, approves or resolves an approval. An agent can
// ASK the owner (request_user_approval) and can READ what is pending, and that
// is the end of the path. Absence from this list is a stronger guarantee than a
// runtime check, because it does not depend on the check being written
// correctly. test/mcp.test.mjs asserts no exposed name matches /grant|approve|
// resolve.*approval/, so the property survives somebody adding a tool later.
//
// Schemas are plain JSON Schema literals rather than zod, to keep the server
// dependency-free — see mcp/jsonrpc.mjs for why that matters. Shape otherwise
// follows backend/mcp/: name, title, description, inputSchema, annotations,
// async handler.

const str = (description, extra = {}) => ({ type: 'string', description, ...extra })
const bool = (description, extra = {}) => ({ type: 'boolean', description, ...extra })
const int = (description, extra = {}) => ({ type: 'integer', description, ...extra })
const arr = (description, items) => ({ type: 'array', description, items })

const object = (properties, required = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false
})

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }

const TASK_STATUSES = [
  'created',
  'assigned',
  'in_progress',
  'waiting_for_agent',
  'waiting_for_user',
  'review',
  'changes_requested',
  'approved',
  'completed',
  'blocked',
  'cancelled'
]

const LEVELS = ['L0', 'L1', 'L2', 'L3']

// Mirror domain/spec.mjs UX_IMPACT and UX_DOMAINS; kept identical by
// test/ux-guard.test.mjs, not by an import.
export const UX_IMPACT = ['NONE', 'LOW', 'MEDIUM', 'HIGH']
export const UX_DOMAINS = [
  'interaction',
  'async-feedback',
  'destructive-action',
  'navigation',
  'maps',
  'media',
  'accessibility',
  'adaptive-layout'
]

// Mirrors domain/reviews.mjs SLOTS, the way TASK_STATUSES below mirrors
// transitions.mjs: this file deliberately imports nothing, so the two lists are
// kept identical by a test (test/routing.test.mjs) rather than by an import.
const SLOTS = [
  'requirements',
  'architecture',
  'implementation',
  'tests',
  'ui',
  'consistency',
  'security',
  'challenger'
]

// What "done" means, and how hard the work was judged to be. Every field is
// optional and a task without it behaves as before; it earns its keep when the
// work crosses an agent boundary, which is when a reviewer has to tell drift
// from intent. The three levels are the LEAD'S OWN READING — the layer cannot
// compute how hard a task is. It checks only that a level is a declared one and
// that a review risk is not claimed below the floor the policy table implies.
const SPEC = object({
  acceptance_criteria: arr('What must be true for this to be done. Reviewers check findings against these.', { type: 'string' }),
  non_goals: arr('What this deliberately does NOT do, so a second agent does not "fix" it.', { type: 'string' }),
  constraints: arr('What the implementation may not do — a pinned version, a boundary, a forbidden path.', { type: 'string' }),
  assumptions: arr('What is taken as true without checking. The first place to look when the result is wrong.', { type: 'string' }),
  complexity: str('How hard the work is: L0 mechanical, L1 ordinary, L2 hard, L3 critical. list_models has the ladder.', {
    enum: LEVELS
  }),
  implementation_risk: str('How easily this is done WRONG, which is not the same as how hard it is.', { enum: LEVELS }),
  review_risk: str('What a missed mistake would cost. One line in auth is L3 however small the diff.', { enum: LEVELS }),
  classification_reason: str('One line on why those levels — read later to see whether the reading was right.'),
  ux_impact: str(
    'What the USER sees, understands or can do differently — not how hard the code is. NONE internal only; LOW spacing/icon/copy; MEDIUM a localized interaction change (button, sheet, state, gesture, error/loading); HIGH a new or changed workflow. HIGH cannot be completed without an approved review by the ux_reviewer role.',
    { enum: UX_IMPACT }
  ),
  ux_domains: arr('Which UX areas the change touches; decides which ux-guidance references are loaded.', {
    type: 'string',
    enum: UX_DOMAINS
  }),
  needs_ux_critic: { type: 'boolean', description: 'MEDIUM only: true when the interaction is ambiguous enough to need an independent ux_reviewer. Always true for HIGH.' },
  needs_visual_verification: { type: 'boolean', description: 'True when the change must be seen rendered (screenshot) before it counts as done.' }
})

const EVIDENCE = object({
  criteria_status: arr('Per acceptance criterion: met, not_met or unverified.', {
    type: 'object',
    properties: {
      criterion: str('The criterion, as written on the task.'),
      status: str('met, not_met or unverified.', { enum: ['met', 'not_met', 'unverified'] })
    },
    required: ['criterion', 'status'],
    additionalProperties: false
  }),
  unverified: arr('What was NOT checked. "Tests not run" is a better report than "should work".', { type: 'string' }),
  limitations: arr('What this knowingly does not handle.', { type: 'string' }),
  risks: arr('What could still break because of this.', { type: 'string' })
})

const MESSAGE_TYPES = [
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
]

export const TOOLS = [
  {
    name: 'whoami',
    title: 'Who am I in this collaboration',
    description:
      'Your agent id, roles, capabilities and briefing, the project\'s own rules for you (project_briefing, when the ' +
      'project sets any: read it as part of the briefing), plus your open tasks, unread messages and pending reviews. ' +
      'Call this first in a session: it tells you what you are responsible for and how to answer.',
    inputSchema: object({}),
    annotations: READ,
    handler: (_input, api) => api.whoami()
  },
  {
    name: 'collab_status',
    title: 'What everybody is doing',
    description:
      'One digest of the whole collaboration: every agent and its status, tasks by state, pending reviews and ' +
      'approvals, open decisions, failed checks, and which dirty files in the working tree no task has claimed.',
    inputSchema: object({}),
    annotations: READ,
    handler: (_input, api) => api.status()
  },
  {
    name: 'list_agents',
    title: 'List registered agents',
    description: 'Every agent registered in this project, with its roles, capabilities and whether it has been seen recently.',
    inputSchema: object({
      role: str('Only agents holding this role.'),
      capability: str('Only agents holding this capability.'),
      available_only: bool('Drop agents that have not been seen recently.')
    }),
    annotations: READ,
    handler: (input, api) => api.listAgents({ role: input.role, capability: input.capability, availableOnly: input.available_only })
  },
  {
    name: 'get_agent',
    title: 'Describe one agent',
    description: 'Roles, capabilities, briefing, runtime status and how work reaches this agent.',
    inputSchema: object({ agent_id: str('The agent id, as returned by list_agents.') }, ['agent_id']),
    annotations: READ,
    handler: (input, api) => api.getAgent(input)
  },
  {
    name: 'find_agents',
    title: 'Find an agent by what it can do',
    description:
      'Ask by role or capability rather than by name — "who can review code" instead of "is Codex there". ' +
      'This is how work should be routed: naming an agent hard-codes today, naming a role keeps working when the roster changes.',
    inputSchema: object({
      role: str('The role you need, e.g. code_reviewer, test_engineer, security_reviewer.'),
      capability: str('The capability you need, e.g. review_code, run_tests.'),
      exclude_self: bool('Leave yourself out — the right thing when you are looking for an independent opinion.')
    }),
    annotations: READ,
    handler: (input, api) => api.findAgents(input)
  },
  {
    name: 'suspend_role',
    title: 'Say you cannot do one of your roles here',
    description:
      'When you find you cannot do the work a role asks for on this machine (no simulator, no access, the program ' +
      'refuses), suspend that role for yourself: it stops being routed to you at once, and your open task that needs ' +
      'it (task_id) goes back to the queue for somebody else. You cannot give it back to yourself — the owner restores ' +
      'it or takes it away for good. Say why in one or two sentences: the owner decides from that.',
    inputSchema: object(
      {
        role: str('The role you cannot do here, one of the roles whoami lists.'),
        reason: str('Why, in one or two sentences — what you tried and what stopped you.'),
        task_id: str('Your open task that needs the role, if any: it is released back to the queue.')
      },
      ['role', 'reason']
    ),
    annotations: WRITE,
    handler: (input, api) => api.suspendRole(input)
  },

  {
    name: 'create_task',
    title: 'Create a task',
    description:
      'Register a unit of work so other agents can see it, claim it, review it and find out why it stopped. ' +
      'The action text is classified against the policy table: anything that costs money, touches production or ' +
      'destroys data is marked as needing the owner and cannot be started until they answer.',
    inputSchema: object(
      {
        title: str('What is to be done, in one line.'),
        description: str('Detail: what "done" means, constraints, where to look.'),
        role: str('The role required to do it, e.g. software_engineer. Only agents holding it can claim it.'),
        priority: str('p0 highest to p3 lowest.', { enum: ['p0', 'p1', 'p2', 'p3'] }),
        needs_review: bool('Whether it must pass an independent review before it can be completed. Defaults to true.'),
        action: str('The concrete action, if it differs from the title. This is what gets classified.'),
        files: arr('Files or directories this work will touch.', { type: 'string' }),
        depends_on: arr('Task ids this one waits for.', { type: 'string' }),
        spec: SPEC
      },
      ['title']
    ),
    annotations: WRITE,
    handler: (input, api) => api.createTask(input)
  },
  {
    name: 'get_task',
    title: 'Read a task',
    description: 'The full task record, including who holds it, whether its lease has lapsed, and which states it may move to next.',
    inputSchema: object({ task_id: str('The task id.') }, ['task_id']),
    annotations: READ,
    handler: (input, api) => api.getTask(input)
  },
  {
    name: 'list_tasks',
    title: 'List tasks',
    description: 'Tasks, filtered. Also sweeps up work abandoned by an agent that stopped reporting in, so stale tasks become claimable.',
    inputSchema: object({
      status: str('One status to filter by.', { enum: TASK_STATUSES }),
      owner: str('Only tasks held by this agent.'),
      role: str('Only tasks requiring this role.'),
      open: bool('True for unfinished work only, false for finished only.'),
      limit: int('Maximum returned.')
    }),
    annotations: READ,
    handler: (input, api) => api.listTasks(input)
  },
  {
    name: 'claim_task',
    title: 'Take a task',
    description:
      'Claim a specific task, or the highest-priority claimable one matching a role. Safe when two agents race: ' +
      'exactly one wins and the other is told so rather than quietly doing the same work. Claiming takes a lease; ' +
      'if you stop reporting in, the task returns to the pool instead of being stuck on you forever.',
    inputSchema: object({
      task_id: str('A specific task. Omit to take the next claimable one.'),
      role: str('When taking the next one, restrict to tasks needing this role.'),
      lease_seconds: int('How long you expect to hold it.'),
      git_base: str('The commit you are starting from, for the record.')
    }),
    annotations: WRITE,
    handler: (input, api) => api.claimTask(input)
  },
  {
    name: 'assign_task',
    title: 'Assign a task to somebody',
    description: 'Give a task to a named agent, or to whoever holds a role or capability. The registry picks; you do not have to know who exists.',
    inputSchema: object(
      {
        task_id: str('The task id.'),
        to_agent: str('A specific agent id.'),
        role: str('Or: whoever holds this role.'),
        capability: str('Or: whoever holds this capability.')
      },
      ['task_id']
    ),
    annotations: WRITE,
    handler: (input, api) => api.assignTask(input)
  },
  {
    name: 'update_task',
    title: 'Update a task',
    description:
      'Change status or fields. Illegal moves are refused and the error says which moves were legal instead. ' +
      'Pass expected_version to be told about a conflict rather than overwriting somebody who moved it while you were thinking.',
    inputSchema: object(
      {
        task_id: str('The task id.'),
        status: str('The new status.', { enum: TASK_STATUSES }),
        expected_version: int('The version you read. A mismatch is reported, not overwritten.'),
        note: str('What changed and why.'),
        reason: str('Required when blocking.'),
        patch: object({
          title: str('New title.'),
          description: str('New description.'),
          priority: str('New priority.', { enum: ['p0', 'p1', 'p2', 'p3'] }),
          files: arr('Replacement file list.', { type: 'string' }),
          branch: str('The branch this work lives on.'),
          spec: SPEC
        })
      },
      ['task_id']
    ),
    annotations: WRITE,
    handler: (input, api) => api.updateTask(input)
  },
  {
    name: 'complete_task',
    title: 'Finish a task',
    description:
      'Mark work done. Refused if it still needs a review that has not been approved, or if the owner has not answered ' +
      'an approval it is waiting on — so "completed" always means what it says. The evidence asked for here is only the ' +
      'part the layer cannot see for itself: which criteria you believe are met and what you did NOT check. Changed ' +
      'files are in git and the checks are in the runs, and get_task already attaches those.',
    inputSchema: object(
      {
        task_id: str('The task id.'),
        summary: str('What was done and what was verified.'),
        evidence: EVIDENCE,
        expected_version: int('The version you read.')
      },
      ['task_id']
    ),
    annotations: WRITE,
    handler: (input, api) => api.completeTask(input)
  },
  {
    name: 'block_task',
    title: 'Block a task',
    description: 'Stop a task and say why. A reason is required: "blocked" without one tells the next reader nothing.',
    inputSchema: object({ task_id: str('The task id.'), reason: str('What is in the way.'), expected_version: int('The version you read.') }, ['task_id', 'reason']),
    annotations: WRITE,
    handler: (input, api) => api.blockTask(input)
  },
  {
    name: 'release_task',
    title: 'Give a task back',
    description: 'Drop a task you claimed so somebody else can take it. Use this rather than going silent when you cannot continue.',
    inputSchema: object({ task_id: str('The task id.'), reason: str('Why you are letting it go.') }, ['task_id']),
    annotations: WRITE,
    handler: (input, api) => api.releaseTask(input)
  },
  {
    name: 'claim_files',
    title: 'Claim the files you are about to edit',
    description:
      'Declare which files this task owns. Overlapping with another live task is refused, and the error names the task ' +
      'and the agent holding them, so two agents cannot silently edit the same file in this shared working tree.',
    inputSchema: object({ task_id: str('The task id.'), paths: arr('Repository-relative files or directories.', { type: 'string' }) }, ['task_id', 'paths']),
    annotations: WRITE,
    handler: (input, api) => api.claimFiles(input)
  },
  {
    name: 'add_delegation',
    title: 'Say who you handed this subtask to, and on which model',
    description:
      'Record that work on this task went to a subagent, and which model it runs on. A subagent is not a registered ' +
      'agent here, so without this the journal shows only your own id and the owner cannot see who did the work. ' +
      'This is a RECORD, not a control: nothing is started by writing it, and the layer cannot verify the model.',
    inputSchema: object(
      {
        task_id: str('The task the work belongs to.'),
        to: str('The subagent, e.g. "ios-implementer", "verifier", "Explore".'),
        model: str(
          'The model it runs on, as a ref or id from list_models ("sonnet", "terra", "gpt-5.6-sol"). Required: omitting ' +
            'it is how work quietly runs on whatever the lead happens to be, which is the most expensive option. An ' +
            'unrecognised name is kept as written and marked unknown rather than refused.'
        ),
        purpose: str('One line on what it was asked to do.'),
        level: str('The level this subtask was judged to be. Escalating past the task level is a choice worth recording.', {
          enum: LEVELS
        }),
        reasons: str('Why this executor and this model — read later to see whether the escalation was worth it.'),
        fallback_from: str('The model originally chosen, if this one is a fallback after a limit, an outage or an error.')
      },
      ['task_id', 'to', 'model']
    ),
    annotations: WRITE,
    handler: (input, api) => api.addDelegation(input)
  },
  {
    name: 'complete_delegation',
    title: 'Close a delegation you recorded',
    description: 'Mark a recorded delegation finished and say how it went, so `collab status` stops showing it as running.',
    inputSchema: object(
      {
        task_id: str('The task the delegation is on.'),
        delegation_id: str('The delegation id returned by add_delegation.'),
        outcome: str('How it went, in one line.'),
        rework_required: bool('Whether its output had to be redone. This is what tells the owner a rung was too low — or too high.')
      },
      ['task_id', 'delegation_id']
    ),
    annotations: WRITE,
    handler: (input, api) => api.completeDelegation(input)
  },

  {
    name: 'send_message',
    title: 'Message another agent',
    description:
      'Send to a named agent, or to whoever holds a role or capability. Address by role when you can: the message then ' +
      'reaches whoever holds that role at the time it is read, including an agent registered after you sent it. ' +
      'Delivery is asynchronous — the recipient does not have to be running.',
    inputSchema: object(
      {
        to_agent: str('A specific agent id.'),
        to_role: str('Or: whoever holds this role.'),
        to_capability: str('Or: whoever holds this capability.'),
        message_type: str('What kind of message this is.', { enum: MESSAGE_TYPES }),
        subject: str('One-line subject.'),
        body: str('The message. Never put credentials or tokens in here — it is written to disk and to the audit log.'),
        task_id: str('The task it concerns.'),
        thread_id: str('An existing thread to continue.'),
        priority: str('normal or high.', { enum: ['normal', 'high'] }),
        requires_reply: bool('Whether you are blocked until they answer.')
      },
      ['body']
    ),
    annotations: WRITE,
    handler: (input, api) => api.sendMessage(input)
  },
  {
    name: 'get_messages',
    title: 'Read your inbox',
    description:
      'Messages addressed to you — directly, or through a role or capability you hold. Reading does not mark them read; ' +
      'use ack_message or reply_message for that.',
    inputSchema: object({
      unread_only: bool('Only what you have not acknowledged.'),
      task_id: str('Only messages about this task.'),
      thread_id: str('One conversation.'),
      limit: int('Maximum returned.')
    }),
    annotations: READ,
    handler: (input, api) => api.getMessages(input)
  },
  {
    name: 'reply_message',
    title: 'Reply to a message',
    description: 'Answer in the same thread and mark the original as answered, so the sender can tell a reply from silence.',
    inputSchema: object(
      {
        message_id: str('The message you are answering.'),
        body: str('Your answer.'),
        message_type: str('Defaults to answer.', { enum: MESSAGE_TYPES })
      },
      ['message_id', 'body']
    ),
    annotations: WRITE,
    handler: (input, api) => api.replyMessage(input)
  },
  {
    name: 'ack_message',
    title: 'Mark a message read',
    description: 'Acknowledge a message you have acted on but are not replying to.',
    inputSchema: object({ message_id: str('The message id.') }, ['message_id']),
    annotations: WRITE,
    handler: (input, api) => api.ackMessage(input)
  },

  {
    name: 'request_review',
    title: 'Ask for an independent review',
    description:
      'Ask for a review by ROLE, not by name — say you need a code_reviewer and the registry finds one who is not you. ' +
      'Never review your own work. The task moves to review and the reviewer gets a message; they do not have to be ' +
      'running when you ask.',
    inputSchema: object(
      {
        task_id: str('The task to review.'),
        reviewer_role: str('The role you need. Defaults to code_reviewer.'),
        reviewer_capability: str('Or select by capability instead.'),
        reviewer_agent: str('A specific agent, when you genuinely mean that one. Prefer role.'),
        instructions: str(
          'What to look at and what you are unsure about. Read LAST by the reviewer and labelled as your claim: the ' +
            'acceptance criteria and the checks that ran come first, so your account cannot anchor the review.'
        ),
        scope: arr('Files the reviewer should read.', { type: 'string' }),
        slot: str(
          'Which question this review answers, when more than one needs answering: requirements, architecture, ' +
            'implementation, tests, ui, consistency, security or challenger. How many a task deserves is judgement.',
          { enum: SLOTS }
        ),
        reviewer_model: str(
          'The model the reviewer will run on (a ref from `collab models`). REQUIRED when the same agent reviews its own ' +
            'task (single_vendor): it must differ from the author\'s model and not be weaker.'
        ),
        author_model: str(
          'The model the author worked on, when the task has no delegation that says so. Only compared in a same-vendor review.'
        ),
        blocking: bool(
          'Whether this is the review that gates the task. Defaults to true, which is the old behaviour. Ask for extra ' +
            'slots with false: they record a verdict beside the task without moving it, so a reviewer that never answers ' +
            'cannot strand the work.'
        )
      },
      ['task_id']
    ),
    annotations: WRITE,
    handler: (input, api) => api.requestReview(input)
  },
  {
    name: 'submit_review',
    title: 'Return a review verdict',
    description:
      'Answer a review routed to you: approved, or changes_requested with at least one finding. A changes_requested ' +
      'with no findings is refused — it tells the author nothing. A gating review moves the task with your verdict, in ' +
      'the same write; a slot records it beside the task. A finding with no evidence is stored as a hypothesis, however ' +
      'it was labelled — say what SHOWS it if you want it to block.',
    inputSchema: object(
      {
        review_id: str('The review id from the request.'),
        verdict: str('approved or changes_requested.', { enum: ['approved', 'changes_requested'] }),
        summary: str('What you checked, and how you could have been wrong.'),
        findings: arr('What you found.', {
          type: 'object',
          properties: {
            severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'] },
            confidence: {
              type: 'string',
              enum: ['proven', 'likely', 'hypothesis'],
              description: 'How sure you are. Without evidence this is recorded as hypothesis whatever you put here.'
            },
            file: { type: 'string' },
            line: { type: 'integer' },
            note: { type: 'string' },
            criterion: { type: 'string', description: 'The acceptance criterion this is about, if it is about one.' },
            evidence: { type: 'string', description: 'What shows it: a failing path, a run, a line of code. No evidence, no blocker.' },
            repro: { type: 'string', description: 'The shortest way to see it happen.' },
            impact: { type: 'string', description: 'What goes wrong for a user or a caller.' },
            recommendation: { type: 'string', description: 'What to do instead.' }
          },
          required: ['note'],
          additionalProperties: false
        })
      },
      ['review_id', 'verdict']
    ),
    annotations: WRITE,
    handler: (input, api) => api.submitReview(input)
  },
  {
    name: 'release_review',
    title: 'Withdraw a review nobody is going to answer',
    description:
      'Void a pending review instead of leaving it stuck: the reviewer is offline for good, hit a limit, or the ' +
      'question no longer applies. The reviewer, the requester, or the task\'s owner/a contributor may do this — the ' +
      'same people who could have asked for it. Releasing the review that GATES the task moves it to blocked with the ' +
      'reason, rather than leaving it silently "in review" waiting on nothing; a non-blocking slot just disappears.',
    inputSchema: object(
      { review_id: str('The review id.'), reason: str('Why — recorded, and used as the block reason if this was gating the task.') },
      ['review_id']
    ),
    annotations: WRITE,
    handler: (input, api) => api.releaseReview(input)
  },
  {
    name: 'list_reviews',
    title: 'List reviews',
    description: 'Reviews, filtered — use pending_only to find what is waiting on you.',
    inputSchema: object({ task_id: str('One task.'), reviewer: str('One reviewer.'), pending_only: bool('Only unanswered.') }),
    annotations: READ,
    handler: (input, api) => api.listReviews(input)
  },

  {
    name: 'create_decision',
    title: 'Record a decision or a disagreement',
    description:
      'Write down a choice that should bind later work, with the options and the reasoning. When agents disagree, ' +
      'each records a position here: the later opinion does not win by being later. A decision that binds everyone ' +
      "belongs in the project's own decision records (an ADR, for example) — record it here, then point adr_ref at it.",
    inputSchema: object(
      {
        title: str('The decision, in one line.'),
        context: str('What forced the choice.'),
        options: arr('The options considered.', {
          type: 'object',
          properties: { id: { type: 'string' }, label: { type: 'string' }, summary: { type: 'string' } },
          additionalProperties: false
        }),
        task_id: str('The task it came from.'),
        position: object({ option: str('Which option you favour.'), rationale: str('Why.') })
      },
      ['title']
    ),
    annotations: WRITE,
    handler: (input, api) => api.createDecision(input)
  },
  {
    name: 'add_decision_position',
    title: 'State your position on a decision',
    description:
      'Add or replace your position, with reasoning — a position without reasoning is a vote, and this is not settled ' +
      'by voting. Two different positions mark the decision disputed, and a disputed decision cannot be closed by ' +
      'either of the agents holding a position in it.',
    inputSchema: object(
      { decision_id: str('The decision id.'), option: str('Which option.'), rationale: str('Why, in enough detail to be argued with.') },
      ['decision_id', 'option', 'rationale']
    ),
    annotations: WRITE,
    handler: (input, api) => api.addPosition(input)
  },
  {
    name: 'resolve_decision',
    title: 'Close a decision',
    description:
      'Record the outcome and the reasoning that settled it. Refused while the decision is disputed: that one goes to ' +
      'the owner, through escalate_decision.',
    inputSchema: object(
      { decision_id: str('The decision id.'), outcome: str('What was decided.'), rationale: str('Why this and not the other.'), adr_ref: str('Path of the ADR it became, if any.') },
      ['decision_id', 'outcome', 'rationale']
    ),
    annotations: WRITE,
    handler: (input, api) => api.resolveDecision(input)
  },
  {
    name: 'escalate_decision',
    title: 'Send a decision to the owner',
    description: 'Hand an unresolvable disagreement to the owner, with the reason it cannot be settled between agents.',
    inputSchema: object({ decision_id: str('The decision id.'), reason: str('Why the agents cannot settle it.') }, ['decision_id', 'reason']),
    annotations: WRITE,
    handler: (input, api) => api.escalateDecision(input)
  },
  {
    name: 'get_decisions',
    title: 'List decisions',
    description: 'Decisions already taken and disagreements still open, so the same ground is not re-argued.',
    inputSchema: object({ status: str('open, disputed, decided, escalated or superseded.'), task_id: str('One task.') }),
    annotations: READ,
    handler: (input, api) => api.listDecisions(input)
  },

  {
    name: 'check_policy',
    title: 'Would this action need the owner',
    description:
      'Classify an action before you plan around it: which class it falls into and whether it needs the owner. ' +
      'Anything unrecognised is treated as needing them — the table asks rather than guesses.',
    inputSchema: object({ action: str('The action, in plain words.') }, ['action']),
    annotations: READ,
    handler: (input, api) => api.checkPolicy(input)
  },
  {
    name: 'request_user_approval',
    title: 'Ask the owner to authorise something',
    description:
      'The only way to proceed with an action that costs money, touches production, destroys data or handles ' +
      'credentials. The task stops in waiting_for_user and cannot be completed until the owner answers at their ' +
      'terminal. There is no tool that grants an approval, including this one — you ask, and then you wait.',
    inputSchema: object(
      {
        action: str('Exactly what you want to do.'),
        reason: str('Why it is needed, in terms the owner can judge.'),
        task_id: str('The task this blocks.'),
        details: str('What it affects, what happens if it is refused, and whether there is a way around it.'),
        cost_estimate: str('What it will cost, if anything.')
      },
      ['action', 'reason']
    ),
    annotations: WRITE,
    handler: (input, api) => api.requestUserApproval(input)
  },
  {
    name: 'get_pending_approvals',
    title: 'What is waiting on the owner',
    description: 'Approval requests the owner has not answered yet, and what each one is blocking.',
    inputSchema: object({ task_id: str('One task.'), pending_only: bool('Defaults to true.') }),
    annotations: READ,
    handler: (input, api) => api.listApprovals(input)
  },

  {
    name: 'list_models',
    title: 'What each level of difficulty means, per vendor',
    description:
      'The level ladder (L0 mechanical, L1 ordinary, L2 hard, L3 critical) and which model each level means for each ' +
      'vendor, with maturity, cost and fallback. Ask here instead of naming a model from memory: line-ups drift, and ' +
      'the level is what the rules are written in. This is a list to choose FROM — nothing here starts anything, and ' +
      'the layer cannot verify which model actually ran.',
    inputSchema: object({}),
    annotations: READ,
    handler: (_input, api) => api.listModels()
  },
  {
    name: 'list_runners',
    title: 'Which checks can be run',
    description:
      "The allowlist of checks this layer will run for this project, declared in the owner's project registry. " +
      'Empty when the project declares none — then there is nothing to run through here.',
    inputSchema: object({}),
    annotations: READ,
    handler: (_input, api) => api.listRunners()
  },
  {
    name: 'start_run',
    title: 'Run a check',
    description:
      'Run one allowlisted check and record the result where every agent can read it — so a reviewer reads the run ' +
      'the author already did instead of repeating it. Returns as soon as the check finishes, or hands back a run id ' +
      'to poll if it is slow. Only the declared runners exist; there is no way to pass a shell command.',
    inputSchema: object(
      {
        runner: str('The runner id from list_runners.'),
        args: arr('Arguments, where the runner accepts them — for example test file paths. list_runners says which do.', { type: 'string' }),
        task_id: str('The task this check belongs to.'),
        wait_seconds: int('How long to wait before handing back a run id. Defaults to 20.')
      },
      ['runner']
    ),
    annotations: WRITE,
    handler: (input, api) => api.startRun(input)
  },
  {
    name: 'get_run',
    title: 'Read a check result',
    description:
      'The outcome of a run, with the pass/fail/skip counters parsed out — a suite that skipped everything exits zero, ' +
      'so the counters are what tell you whether anything actually ran.',
    inputSchema: object({ run_id: str('The run id.') }, ['run_id']),
    annotations: READ,
    handler: (input, api) => api.getRun(input)
  }
]

export function assertUniqueNames(tools = TOOLS) {
  const seen = new Set()
  for (const tool of tools) {
    if (seen.has(tool.name)) throw new Error(`Duplicate collab MCP tool name: ${tool.name}`)
    seen.add(tool.name)
  }
  return tools
}

assertUniqueNames()
