// One error type with a closed code vocabulary.
//
// Every caller of this layer is a machine — the MCP registry turns a CollabError
// into a tool result an agent reads, and the CLI prints it to a human. Both need
// the same thing: a stable code they can branch on and enough detail to act
// without a second round trip. That is why `details` carries the current record
// on a version conflict and the holder on a lock timeout: an agent that has to
// re-read to find out what happened will usually just retry blindly instead.
//
// A thrown Error that is not a CollabError is a bug in this layer, and the MCP
// server reports it as one rather than dressing it up as a domain outcome.

export const CODES = Object.freeze({
  // configuration — the process should not have started
  CONFIG_INVALID: 'CONFIG_INVALID',
  UNKNOWN_AGENT: 'UNKNOWN_AGENT',
  UNKNOWN_ROLE: 'UNKNOWN_ROLE',
  UNKNOWN_CAPABILITY: 'UNKNOWN_CAPABILITY',

  // where the journal lives
  NOT_INITIALIZED: 'NOT_INITIALIZED',
  ROOT_REFUSED: 'ROOT_REFUSED',
  JOURNAL_INVALID: 'JOURNAL_INVALID',

  // input
  INVALID_INPUT: 'INVALID_INPUT',
  NOT_FOUND: 'NOT_FOUND',
  UNKNOWN_TOOL: 'UNKNOWN_TOOL',

  // concurrency
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  ALREADY_CLAIMED: 'ALREADY_CLAIMED',
  LOCK_TIMEOUT: 'LOCK_TIMEOUT',
  REENTRANT_TRANSACTION: 'REENTRANT_TRANSACTION',
  PATH_CONFLICT: 'PATH_CONFLICT',

  // domain
  ILLEGAL_TRANSITION: 'ILLEGAL_TRANSITION',
  GUARD_FAILED: 'GUARD_FAILED',
  NO_AGENT_AVAILABLE: 'NO_AGENT_AVAILABLE',
  SELF_REVIEW: 'SELF_REVIEW',

  // policy and safety
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  APPROVAL_INVALID: 'APPROVAL_INVALID',
  ACTION_UNRECOGNISED: 'ACTION_UNRECOGNISED',
  SECRET_IN_CONTENT: 'SECRET_IN_CONTENT',
  RUNNER_REFUSED: 'RUNNER_REFUSED',
  NOT_PERMITTED: 'NOT_PERMITTED',
  READ_ONLY: 'READ_ONLY'
})

export class CollabError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'CollabError'
    this.code = code
    this.details = details
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details }
  }
}

export const fail = (code, message, details) => {
  throw new CollabError(code, message, details)
}

// Config problems are collected, not thrown one at a time: the guard script
// prints every problem in one run so a misconfigured registry is fixed in one
// pass instead of one restart per typo.
export class CollabConfigError extends CollabError {
  constructor(problems) {
    const list = problems.map((p) => `  - ${p}`).join('\n')
    super(CODES.CONFIG_INVALID, `collab configuration is invalid:\n${list}`, { problems })
    this.name = 'CollabConfigError'
    this.problems = problems
  }
}
