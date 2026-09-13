#!/usr/bin/env node
// The human's window into the collaboration, and the only place an approval can
// be answered.
//
// ⛔ APPROVE / REJECT ARE NOT AVAILABLE TO AGENTS, AND THE HONEST VERSION OF WHY:
// there is no MCP tool that grants an approval, so the ordinary path does not
// exist. On top of that this command refuses to run when COLLAB_AGENT_ID is set
// (every agent shell has it) and requires an interactive terminal plus the
// approval id typed back. Both agents run as the same user on this machine, so
// none of that is a security boundary against a determined process — it is a
// barrier against the realistic accident, plus an audit trail that makes a
// forged grant visible rather than invisible. Real enforcement for a dangerous
// action belongs in the harness: see docs/decisions/0011.

import { createInterface } from 'node:readline/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createApi } from './api.mjs'
import { REPO_ROOT } from './paths.mjs'
import { adapterFor } from './adapters/index.mjs'
import { resolveApproval } from './domain/approvals.mjs'
import { resolveDecision } from './domain/decisions.mjs'
import { CollabError } from './errors.mjs'

const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', off: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', bold: '\x1b[1m' }
  : { dim: '', off: '', red: '', green: '', yellow: '', bold: '' }

const out = (...lines) => console.log(lines.join('\n'))
const dim = (s) => `${C.dim}${s}${C.off}`

// The CLI acts as the owner unless told otherwise. `--as <agent>` is for
// driving a flow by hand and for tests; it never unlocks approval resolution.
function parseArgs(argv) {
  const args = []
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const [name, inline] = token.slice(2).split('=')
      if (inline !== undefined) flags[name] = inline
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[name] = argv[++i]
      else flags[name] = true
    } else args.push(token)
  }
  return { args, flags }
}

const STATUS_COLOUR = {
  completed: C.green,
  approved: C.green,
  blocked: C.red,
  changes_requested: C.yellow,
  waiting_for_user: C.yellow,
  waiting_for_agent: C.yellow
}
const paint = (status) => `${STATUS_COLOUR[status] || ''}${status}${C.off}`

const COMMANDS = {
  async status(api) {
    const s = await api.status()
    out(`${C.bold}agents${C.off}`)
    for (const a of s.agents) {
      const task = a.current_task_id ? ` on ${a.current_task_id}` : ''
      out(`  ${a.id.padEnd(8)} ${paint(a.status).padEnd(20)} ${dim(a.roles.join(', '))}${task}`)
      out(`  ${' '.repeat(8)} ${dim(a.adapter.how)}`)
    }
    out('', `${C.bold}tasks${C.off}`)
    const entries = Object.entries(s.tasks.by_status)
    if (!entries.length) out(dim('  none yet'))
    for (const [status, count] of entries) out(`  ${paint(status).padEnd(20)} ${count}`)
    if (s.tasks.stale) out(`  ${C.yellow}${s.tasks.stale} with a lapsed lease${C.off} ${dim('(claimable again)')}`)

    out(
      '',
      `${C.bold}waiting${C.off}`,
      `  reviews pending    ${s.reviews_pending}`,
      `  approvals pending  ${s.approvals_pending}${s.approvals_pending ? `  ${C.yellow}<- waiting on you${C.off}` : ''}`,
      `  decisions open     ${s.decisions_open}`,
      `  runs failed        ${s.runs_failed}`
    )

    out('', `${C.bold}working tree${C.off}`, `  ${s.git.branch} @ ${s.git.head}, ${s.git.dirty_files} dirty`)
    for (const c of s.git.claimed_dirty.slice(0, 10)) out(`  ${dim('claimed')} ${c.file} ${dim(`(${c.task_id}, ${c.owner})`)}`)
    if (s.git.unclaimed_dirty.length) {
      // Naming these is the point. git cannot say WHO changed a file, so this
      // does not claim to: it says no task owns them, which is the question you
      // need answered before you fold one into your own commit.
      out(
        `  ${C.yellow}${s.git.unclaimed_dirty.length} dirty file(s) no task claims${C.off}`,
        dim('    could be yours, could be another session — check before committing or editing')
      )
      for (const f of s.git.unclaimed_dirty.slice(0, 8)) out(`    ${f}`)
      if (s.git.unclaimed_dirty.length > 8) out(dim(`    … and ${s.git.unclaimed_dirty.length - 8} more`))
    }
  },

  async tasks(api, { flags }) {
    const list = await api.listTasks({ open: flags.all ? null : true, status: flags.status, owner: flags.owner })
    if (!list.length) return out(dim('no tasks'))
    for (const t of list) {
      out(
        `${t.id}  ${paint(t.status).padEnd(20)} ${t.title}`,
        dim(`   owner=${t.owner || '—'} role=${t.role || '—'} class=${t.action_class}${t.lease_expired ? ' LEASE EXPIRED' : ''}`)
      )
    }
  },

  async task(api, { args }) {
    const task = api.getTask({ task_id: args[0] })
    out(
      `${C.bold}${task.title}${C.off}`,
      `${task.id}  ${paint(task.status)}  ${dim(`v${task.version}`)}`,
      '',
      task.description || dim('(no description)'),
      '',
      `owner        ${task.owner || '—'}`,
      `role         ${task.role || '—'}`,
      `action class ${task.action_class}${task.requires_approval ? `  ${C.yellow}needs the owner${C.off}` : ''}`,
      `files        ${(task.files || []).join(', ') || '—'}`,
      `may go to    ${task.allowed_next.join(', ') || '—'}`
    )
    if (task.blocked_reason) out(`${C.red}blocked${C.off}      ${task.blocked_reason}`)
    if (task.waiting_on) out(`${C.yellow}waiting on${C.off}   ${task.waiting_on.kind} ${task.waiting_on.ref}`)

    const reviews = api.listReviews({ task_id: task.id })
    if (reviews.length) {
      out('', `${C.bold}reviews${C.off}`)
      for (const r of reviews) {
        out(`  round ${r.round}  ${r.reviewer}  ${paint(r.verdict)}  ${dim(r.summary || '')}`)
        for (const f of r.findings || []) out(`    [${f.severity}] ${f.file || '—'}${f.line ? `:${f.line}` : ''} ${f.note}`)
      }
    }
    const messages = await api.getMessages({ task_id: task.id, agent_id: task.owner || api.agentId })
    if (messages.length) {
      out('', `${C.bold}messages${C.off}`)
      for (const m of messages) out(`  ${m.from_agent} -> ${describeTo(m.to)}  ${dim(m.message_type)}  ${m.subject || m.body.slice(0, 60)}`)
    }
  },

  async inbox(api, { args, flags }) {
    const who = args[0] || api.agentId
    const list = await api.getMessages({ agent_id: who, unread_only: Boolean(flags.unread) })
    if (!list.length) return out(dim(`nothing addressed to ${who}`))
    for (const m of list) {
      const read = m.read_by && m.read_by[who] ? dim('read') : `${C.yellow}unread${C.off}`
      out(
        `${m.id}  ${dim(m.created_at)}  ${read}`,
        `  ${m.from_agent} -> ${describeTo(m.to)}  ${C.bold}${m.message_type}${C.off}${m.task_id ? dim(`  task ${m.task_id}`) : ''}`,
        `  ${m.subject || ''}`,
        m.body
          .split('\n')
          .map((l) => `    ${l}`)
          .join('\n'),
        ''
      )
    }
  },

  async thread(api, { args }) {
    for (const m of api.getThread({ thread_id: args[0] })) {
      out(`${dim(m.created_at)} ${C.bold}${m.from_agent}${C.off} -> ${describeTo(m.to)} (${m.message_type})`, m.body, '')
    }
  },

  async reviews(api, { flags }) {
    const list = api.listReviews({ pending_only: Boolean(flags.pending) })
    if (!list.length) return out(dim('no reviews'))
    for (const r of list) {
      out(`${r.id}  task ${r.task_id}  round ${r.round}  ${r.author} -> ${r.reviewer}  ${paint(r.verdict)}`)
      if (r.summary) out(dim(`   ${r.summary}`))
    }
  },

  async decisions(api, { flags }) {
    const list = api.listDecisions({ status: flags.status })
    if (!list.length) return out(dim('no decisions recorded'))
    for (const d of list) {
      out(`${d.id}  ${paint(d.status)}  ${C.bold}${d.title}${C.off}`)
      for (const p of d.positions || []) out(dim(`   ${p.agent} favours "${p.option}": ${p.rationale}`))
      if (d.outcome) out(`   -> ${d.outcome}${d.adr_ref ? dim(`  (${d.adr_ref})`) : ''}`)
      if (d.status === 'decided' && !d.adr_ref) {
        out(dim('   no ADR yet — if this binds everyone, write docs/decisions/ and set adr_ref'))
      }
    }
  },

  async approvals(api) {
    const list = api.listApprovals({ pending_only: true })
    if (!list.length) return out(dim('nothing is waiting on you'))
    for (const a of list) {
      out(
        `${C.yellow}${a.id}${C.off}  ${C.bold}${a.action_class}${C.off}  requested by ${a.requested_by}`,
        `  action  ${a.action.summary || a.action.command}`,
        `  reason  ${a.reason}`,
        a.details ? `  detail  ${a.details}` : '',
        a.cost_estimate ? `  ${C.yellow}cost${C.off}    ${a.cost_estimate}` : '',
        a.task_id ? `  blocks  task ${a.task_id}` : '',
        a.expired ? `  ${C.red}expired${C.off}` : dim(`  expires ${a.expires_at}`),
        ''
      )
    }
    out(dim('answer with: node tools/collab/src/cli.mjs approve <id>   (or reject <id> --note "...")'))
  },

  approve: (api, parsed) => resolveApprovalInteractively(api, parsed, 'granted'),
  reject: (api, parsed) => resolveApprovalInteractively(api, parsed, 'denied'),

  async decide(api, { args, flags }) {
    // The owner settling a disagreement the agents could not.
    const decision = resolveDecision(api.ctx, {
      decision_id: args[0],
      outcome: args.slice(1).join(' ') || flags.outcome,
      rationale: flags.why || 'owner decision',
      adr_ref: flags.adr || null,
      decided_by_kind: 'user'
    })
    const settled = await decision
    out(`${C.green}decided${C.off} ${settled.id}: ${settled.outcome}`)
    if (!settled.adr_ref) out(dim('if this binds everyone, write it up in docs/decisions/ and re-run with --adr <path>'))
  },

  async runs(api, { flags }) {
    const list = api.listRuns({ failed_only: Boolean(flags.failed) })
    if (!list.length) return out(dim('no runs'))
    for (const r of list) {
      out(`${r.id}  ${paint(r.status)}  ${r.runner}${r.args.length ? ` ${r.args.join(' ')}` : ''}  ${dim(r.result?.headline || '')}`)
    }
  },

  async run(api, { args }) {
    const run = api.getRun({ run_id: args[0] })
    out(`${run.runner}  ${paint(run.status)}  ${run.result?.headline || ''}`, dim(run.command), '', run.log_tail || '')
  },

  async log(api, { flags }) {
    for (const e of api.events({ limit: Number(flags.tail || 40) })) {
      out(`${dim(e.ts)}  ${e.actor.padEnd(8)} ${C.bold}${e.type.padEnd(22)}${C.off} ${e.subject?.id || ''} ${dim(JSON.stringify(e.data))}`)
    }
  },

  async brief(api, { args }) {
    const agent = api.getAgent({ agent_id: args[0] || api.agentId })
    out(`${C.bold}${agent.name}${C.off} (${agent.id}) — ${agent.provider}`, '')
    out(`roles         ${agent.roles.join(', ')}`)
    out(`capabilities  ${agent.capabilities.join(', ')}`, '')
    out(agent.runtime ? dim(`status ${agent.runtime.effective_status}, last seen ${agent.runtime.last_seen_at || 'never'}`) : '')
    out('', agent.briefing)
    const declared = api.registry.agent(agent.id)
    if (declared.briefing_file) {
      try {
        out('', readFileSync(join(REPO_ROOT, declared.briefing_file), 'utf8'))
      } catch {
        out('', dim(`(${declared.briefing_file} is not readable from here)`))
      }
    }
  },

  async doctor(api) {
    const report = api.doctor()
    out(`state        ${report.state_dir}`, `repo         ${report.repo_root}`, '')
    out(`${C.bold}agents${C.off}`)
    for (const a of report.agents) {
      const mark = a.reachable ? `${C.green}ok${C.off}` : `${C.red}unavailable${C.off}`
      out(`  ${a.id.padEnd(8)} ${mark}  ${dim(a.how)}  ${dim(`runtime ${a.runtime_status}`)}`)
      if (a.note) out(`  ${' '.repeat(8)} ${dim(a.note)}`)
      if (a.fix) out(`  ${' '.repeat(8)} ${C.yellow}fix:${C.off} ${a.fix}`)
    }
    out('', `${C.bold}runners${C.off}`)
    for (const r of report.runners) out(`  ${r.id.padEnd(22)} ${dim(r.summary)}`)
    if (report.unheld_roles.length) {
      out('', dim(`roles nobody holds: ${report.unheld_roles.join(', ')} — register an agent for them when you need one`))
    }
  },

  async sweep(api) {
    const result = await api.sweep()
    out(`released ${result.released.length}, marked offline ${result.marked_offline.length}`)
    for (const id of result.released) out(dim(`  released ${id}`))
    for (const id of result.marked_offline) out(dim(`  offline  ${id}`))
  },

  help() {
    out(
      `${C.bold}collab${C.off} — shared state for the agents working on this repository`,
      '',
      '  status                 who is doing what, what is waiting, what the tree looks like',
      '  tasks [--all]          list tasks',
      '  task <id>              one task with its reviews and messages',
      '  inbox [agent]          messages addressed to an agent',
      '  thread <id>            one conversation',
      '  reviews [--pending]    reviews and their verdicts',
      '  decisions [--status]   decisions and open disagreements',
      '  approvals              what is waiting on you',
      `  approve <id>           ${C.yellow}authorise a request. Interactive terminal only${C.off}`,
      `  reject <id> --note     ${C.yellow}decline a request${C.off}`,
      '  decide <id> <outcome>  settle a disagreement the agents could not',
      '  runs [--failed]        check results',
      '  run <id>               one check result with its log tail',
      '  log [--tail N]         the audit log',
      '  brief [agent]          what an agent is told about itself — paste this into a new session',
      '  doctor                 agents, adapters, what is unavailable and how to fix it',
      '  sweep                  release work abandoned by an agent that went away',
      '',
      dim('  --as <agent>         act as an agent (never unlocks approve/reject)')
    )
  }
}

function describeTo(to) {
  if (!to) return '?'
  if (to.agent) return to.agent
  if (to.role) return `role:${to.role}`
  if (to.capability) return `capability:${to.capability}`
  return '?'
}

async function resolveApprovalInteractively(api, { args, flags }, decision) {
  const id = args[0]
  if (!id) throw new CollabError('INVALID_INPUT', `usage: cli.mjs ${decision === 'granted' ? 'approve' : 'reject'} <approval-id>`)

  // Barrier 1: an agent shell always carries this variable. Clearing it to get
  // past this line is a deliberate act that shows up in shell history, not an
  // accident an agent can pattern-match its way into.
  if (process.env.COLLAB_AGENT_ID) {
    process.stderr.write(
      `refusing: COLLAB_AGENT_ID is set to "${process.env.COLLAB_AGENT_ID}", so this is an agent's shell.\n` +
        'Approvals are answered by the owner, at their own terminal.\n'
    )
    process.exit(3)
  }
  // Barrier 2: a human is at a terminal.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('refusing: approve/reject needs an interactive terminal — it is the owner\'s decision, not a script\'s.\n')
    process.exit(3)
  }

  const pending = api.listApprovals({ pending_only: true }).find((a) => a.id === id)
  if (!pending) {
    process.stderr.write(`no pending approval ${id}\n`)
    process.exit(1)
  }

  out(
    '',
    `${C.bold}${pending.action_class}${C.off} requested by ${pending.requested_by}`,
    `  action  ${pending.action.summary || pending.action.command}`,
    `  reason  ${pending.reason}`,
    pending.details ? `  detail  ${pending.details}` : '',
    pending.cost_estimate ? `  ${C.yellow}cost    ${pending.cost_estimate}${C.off}` : '',
    pending.task_id ? `  blocks  task ${pending.task_id}` : '',
    ''
  )

  // Barrier 3: type the id back. y/n is too easy to answer without reading.
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const typed = await rl.question(`Type the approval id to ${decision === 'granted' ? 'GRANT' : 'DENY'} it, anything else to abort: `)
  rl.close()
  if (typed.trim() !== id) {
    out('aborted — nothing changed')
    process.exit(0)
  }

  const resolved = await resolveApproval(api.ctx, {
    approval_id: id,
    decision,
    note: flags.note || '',
    channel: 'cli-tty',
    // Recorded so a forged grant is visible in the audit log rather than
    // indistinguishable from a real one.
    evidence: { pid: process.pid, ppid: process.ppid, tty: Boolean(process.stdin.isTTY), term: process.env.TERM || null }
  })
  out(`${decision === 'granted' ? C.green : C.yellow}${decision}${C.off} ${resolved.id}`)
  if (resolved.task_id) out(dim(`task ${resolved.task_id} is unblocked`))
}

async function main() {
  const [, , command = 'help', ...rest] = process.argv
  const parsed = parseArgs(rest)
  const handler = COMMANDS[command]
  if (!handler) {
    process.stderr.write(`unknown command "${command}"\n`)
    COMMANDS.help()
    process.exit(1)
  }
  if (command === 'help') return COMMANDS.help()

  // The CLI acts as the owner's stand-in; `claude` is used only as the ledger
  // identity for reads, and approve/reject refuse to use it at all.
  const api = createApi({ agentId: parsed.flags.as || process.env.COLLAB_AGENT_ID || 'claude' })
  try {
    await handler(api, parsed)
  } catch (error) {
    if (error instanceof CollabError) {
      process.stderr.write(`${C.red}${error.code}${C.off} ${error.message}\n`)
      if (Object.keys(error.details || {}).length) process.stderr.write(`${dim(JSON.stringify(error.details, null, 2))}\n`)
      process.exit(1)
    }
    throw error
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (invokedDirectly) main()
