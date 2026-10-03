// Which actions an agent may take alone, and which stop and wait for the owner.
//
// EVALUATION IS MAX-SEVERITY, NOT FIRST-MATCH. Every rule is tested and the
// highest severity among the matches wins. First-match-wins would make the ORDER
// of rules load-bearing, so moving a line in a JSON file could silently
// downgrade a rule — a property no safety table should have.
//
// AN UNMATCHED ACTION IS NOT SAFE. It falls to defaults.unmatched_class, which
// requires approval. A classifier that fails open has not classified anything.
//
// The fingerprint is what makes an approval single-use and bound to one action:
// permission to buy one thing cannot be replayed to buy another.

import { createHash } from 'node:crypto'
import { CODES, CollabError } from './errors.mjs'

// The kind of an action, named by the agent instead of a verb the table knows (owner, 03.10.2026). It is one more
// match, never a replacement: the most dangerous class among the text's rules AND the kind wins, so a kind cannot
// lower what the words say ("rotate the api key", kind edit → still SECURITY_SENSITIVE). A closed list in code, not
// in policy.json: a project table cannot widen what a kind means.
export const ACTION_KINDS = Object.freeze({
  read: 'READ_ONLY',
  edit: 'SAFE_WRITE',
  test: 'SAFE_WRITE',
  publish: 'EXTERNAL_SIDE_EFFECT',
  delete: 'DESTRUCTIVE',
  secrets: 'SECURITY_SENSITIVE',
  deploy: 'PRODUCTION',
  pay: 'FINANCIAL'
})

export function classifyAction(policy, action) {
  const text = actionText(action)
  const matched = []
  const kind = typeof action === 'object' && action ? action.kind : null
  if (kind && !Object.hasOwn(ACTION_KINDS, kind)) {
    throw new CollabError(CODES.INVALID_INPUT, `action kind must be one of ${Object.keys(ACTION_KINDS).join(', ')}`, { kind })
  }
  for (const rule of policy.rules || []) {
    let re
    try {
      re = new RegExp(rule.pattern, 'i')
    } catch {
      continue // validatePolicy already reports this; do not fail classification on it
    }
    if (re.test(text)) matched.push(rule)
  }
  // The kind is the LAST match: a tie in severity is won by the first, so a rule the words matched keeps its class
  // (and its never_standing mark, and the review-risk floor that class carries) against a kind of equal severity.
  if (kind) matched.push({ id: `kind:${kind}`, class: ACTION_KINDS[kind], reason: `the agent named the kind of action: ${kind}` })

  const severityOf = (cls) => policy.classes?.[cls]?.severity ?? 0
  let chosen = policy.defaults.unmatched_class
  for (const rule of matched) {
    if (severityOf(rule.class) > severityOf(chosen)) chosen = rule.class
  }
  // If anything matched, the default no longer applies unless it outranks them.
  if (matched.length && severityOf(chosen) === severityOf(policy.defaults.unmatched_class)) {
    const best = matched.reduce((a, b) => (severityOf(b.class) > severityOf(a.class) ? b : a))
    chosen = best.class
  }

  const approval = policy.defaults.approval[chosen] || 'mandatory'
  const neverStanding = matched.some((r) => r.class === chosen && r.never_standing === true)

  return {
    action_class: chosen,
    requires_approval: approval === 'mandatory',
    never_standing: neverStanding,
    matched: matched.map((r) => ({ id: r.id, class: r.class, reason: r.reason })),
    reason: matched.length
      ? matched.filter((r) => r.class === chosen).map((r) => r.reason)[0]
      : `nothing in the policy table matched, so it is treated as ${chosen} — the table asks rather than guesses`
  }
}

function actionText(action) {
  if (typeof action === 'string') return action
  return [action?.summary, action?.command, action?.target, action?.tool].filter(Boolean).join(' — ')
}

export function fingerprintAction(action) {
  const normalised = typeof action === 'string' ? { summary: action } : action || {}
  // The kind joins the fingerprint only when it is set: an action written before kinds existed keeps its fingerprint,
  // so its approvals stay valid; one with a kind is a different action from the same words without it.
  const canonical = JSON.stringify({
    tool: normalised.tool || null,
    summary: (normalised.summary || '').trim(),
    command: (normalised.command || '').trim(),
    target: (normalised.target || '').trim(),
    ...(normalised.kind ? { kind: normalised.kind } : {})
  })
  return `sha256:${createHash('sha256').update(canonical).digest('hex').slice(0, 32)}`
}

// The gate the task state machine calls. An agent reaches work only through it.
export function assertActionAllowed({ policy, action, approval, now }) {
  const verdict = classifyAction(policy, action)
  if (!verdict.requires_approval) return verdict

  if (!approval) {
    throw new CollabError(
      CODES.APPROVAL_REQUIRED,
      `this is a ${verdict.action_class} action and needs the owner's approval before any work starts: ${verdict.reason}`,
      { ...verdict, action_fingerprint: fingerprintAction(action) }
    )
  }
  if (approval.status !== 'granted') {
    throw new CollabError(CODES.APPROVAL_INVALID, `approval ${approval.id} is "${approval.status}", not "granted"`, {
      approval_id: approval.id,
      status: approval.status
    })
  }
  if (approval.consumed_at) {
    throw new CollabError(CODES.APPROVAL_INVALID, `approval ${approval.id} was already used at ${approval.consumed_at}`, {
      approval_id: approval.id,
      consumed_at: approval.consumed_at,
      consumed_by: approval.consumed_by
    })
  }
  if (approval.expires_at && now && approval.expires_at < now) {
    throw new CollabError(CODES.APPROVAL_INVALID, `approval ${approval.id} expired at ${approval.expires_at}`, {
      approval_id: approval.id,
      expires_at: approval.expires_at
    })
  }
  const wanted = fingerprintAction(action)
  if (approval.action_fingerprint !== wanted) {
    throw new CollabError(
      CODES.APPROVAL_INVALID,
      `approval ${approval.id} was granted for a different action — permission for one thing is not permission for another`,
      { approval_id: approval.id, granted_for: approval.action_fingerprint, wanted }
    )
  }
  return verdict
}

// Cheap, high-signal patterns. This is not a secret scanner and does not pretend
// to be one; it is the barrier that stops a token being pasted into a message
// where it would sit in .collab/ and in the audit log forever. It REFUSES rather
// than warns, because a warning in a machine-to-machine channel is read by nobody.
const SECRET_PATTERNS = [
  [/\bsk-[A-Za-z0-9_-]{16,}/, 'an OpenAI-style secret key'],
  [/\bsk-ant-[A-Za-z0-9_-]{16,}/, 'an Anthropic-style secret key'],
  [/\bghp_[A-Za-z0-9]{20,}/, 'a GitHub personal access token'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/, 'a GitHub fine-grained token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key id'],
  [/\bAIza[0-9A-Za-z_-]{30,}/, 'a Google API key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'a JSON Web Token'],
  [/postgres(ql)?:\/\/[^\s:]+:[^\s@]+@/, 'a database URL with a password in it']
]

export function assertNoSecret(text, where) {
  if (typeof text !== 'string' || !text) return text
  for (const [pattern, what] of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      throw new CollabError(
        CODES.SECRET_IN_CONTENT,
        `${where} looks like it contains ${what}. Collaboration records are written to disk and to the audit log — ` +
          'refer to the secret by name and location instead of quoting it.',
        { where, kind: what }
      )
    }
  }
  return text
}
