// What "done" means for a task, said in fields instead of prose.
//
// A task has always had a title and a free-text description, and that is enough
// while one agent holds the whole thing in its head. It stops being enough the
// moment the work crosses an agent boundary: a reviewer cannot tell drift from
// intent without the acceptance criteria, and a second agent cannot tell what
// was deliberately left out without the non-goals.
//
// ⛔ LIKE A DELEGATION, THIS IS A RECORD. The three levels here are the lead's
// own reading of the work — the layer cannot compute how hard a task is, and
// does not pretend to. It checks only what it can: that a level is one of the
// declared ones, and that a review risk is not claimed BELOW the floor the
// policy table already implies (see models.mjs reviewRiskFloor). Everything
// else is text, kept short enough to stay readable in `collab task`.
//
// Every field is optional, and a task with no spec behaves exactly as before:
// the threshold the owner set is "artifacts when work crosses a boundary or the
// risk is real", not "ceremony on every edit".

import { CODES, CollabError } from '../errors.mjs'
import { assertNoSecret } from '../policy.mjs'

const ITEM_MAX = 200
const ITEMS_MAX = 12
const REASON_MAX = 400

export const SPEC_LISTS = Object.freeze(['non_goals', 'constraints', 'assumptions', 'acceptance_criteria'])
export const SPEC_LEVELS = Object.freeze(['complexity', 'implementation_risk', 'review_risk'])

// UX impact is a fourth reading of the same kind as the three levels: the lead
// judges it while writing the plan, the layer only checks its shape and gates
// completion on it. It measures what the USER sees, understands or can do —
// not how hard the code is — so a one-line change can be HIGH and a module
// extraction NONE.
export const UX_IMPACT = Object.freeze(['NONE', 'LOW', 'MEDIUM', 'HIGH'])
export const UX_DOMAINS = Object.freeze([
  'interaction',
  'async-feedback',
  'destructive-action',
  'navigation',
  'maps',
  'media',
  'accessibility',
  'adaptive-layout'
])
export const UX_FLAGS = Object.freeze(['needs_ux_critic', 'needs_visual_verification'])
export const UX_REVIEWER_ROLE = 'ux_reviewer'

function list(value, field) {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) {
    throw new CollabError(CODES.INVALID_INPUT, `spec.${field} must be a list of short lines`, { field })
  }
  if (value.length > ITEMS_MAX) {
    throw new CollabError(CODES.INVALID_INPUT, `spec.${field} has ${value.length} items; keep it under ${ITEMS_MAX}`, {
      field,
      length: value.length
    })
  }
  return value.map((raw, index) => {
    const clean = typeof raw === 'string' ? raw.trim() : ''
    if (!clean) throw new CollabError(CODES.INVALID_INPUT, `spec.${field}[${index}] is empty`, { field, index })
    if (clean.length > ITEM_MAX || /[\n\r]/.test(clean)) {
      throw new CollabError(CODES.INVALID_INPUT, `spec.${field}[${index}] must be one short line, not a paragraph`, {
        field,
        index
      })
    }
    return assertNoSecret(clean, `spec.${field}`)
  })
}

function level(value, field, levels) {
  if (value === undefined || value === null || value === '') return undefined
  if (!levels[value]) {
    throw new CollabError(
      CODES.INVALID_INPUT,
      `spec.${field} is "${value}", which is not a declared level — list_models says what they are`,
      { field, value, known: Object.keys(levels) }
    )
  }
  return value
}

// The PLANNED route: who the lead meant to do each part, on which model, at which level — the "Маршрут:" line of the
// plan as data, so the panel can set it beside what actually happened (delegations and the model the owner works on).
// A record of intent, not a control: nothing here starts an agent. An empty list clears it.
const ROUTE_FIELDS = Object.freeze(['step', 'agent', 'model', 'level'])
function routeOf(value, levels) {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) {
    throw new CollabError(CODES.INVALID_INPUT, 'spec.route must be a list of {step, agent, model, level}', { field: 'route' })
  }
  if (value.length > ITEMS_MAX) {
    throw new CollabError(CODES.INVALID_INPUT, `spec.route has ${value.length} items; keep it under ${ITEMS_MAX}`, {
      field: 'route',
      length: value.length
    })
  }
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new CollabError(CODES.INVALID_INPUT, `spec.route[${index}] must be an object`, { field: 'route', index })
    }
    for (const key of Object.keys(raw)) {
      if (!ROUTE_FIELDS.includes(key)) {
        throw new CollabError(CODES.INVALID_INPUT, `spec.route[${index}] has no field "${key}"`, { field: 'route', index, known: ROUTE_FIELDS })
      }
    }
    const step = typeof raw.step === 'string' ? raw.step.trim() : ''
    if (!step) throw new CollabError(CODES.INVALID_INPUT, `spec.route[${index}] needs a step: what this part of the work is`, { field: 'route', index })
    const out = { step }
    for (const key of ['agent', 'model']) {
      const clean = typeof raw[key] === 'string' ? raw[key].trim() : ''
      if (clean) out[key] = clean
    }
    const rung = level(raw.level, `route[${index}].level`, levels)
    if (rung !== undefined) out.level = rung
    for (const key of Object.keys(out)) {
      if (out[key].length > ITEM_MAX || /[\n\r]/.test(out[key])) {
        throw new CollabError(CODES.INVALID_INPUT, `spec.route[${index}].${key} must be one short line`, { field: 'route', index })
      }
      assertNoSecret(out[key], `spec.route[${index}].${key}`)
    }
    return out
  })
}

// Merges onto what is already there: a spec is filled in as the work is
// understood, and re-sending the whole thing to add one criterion is how fields
// like this end up unused. An explicit empty list clears one.
export function normaliseSpec(config, input, existing = null) {
  if (input === undefined || input === null) return existing || null
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new CollabError(CODES.INVALID_INPUT, 'spec must be an object', {})
  }
  const levels = config.models?.levels || {}
  const known = new Set([...SPEC_LISTS, ...SPEC_LEVELS, 'classification_reason', 'ux_impact', 'ux_domains', 'route', ...UX_FLAGS])
  for (const key of Object.keys(input)) {
    if (!known.has(key)) {
      throw new CollabError(CODES.INVALID_INPUT, `spec has no field "${key}"`, { field: key, known: [...known] })
    }
  }

  const next = { ...(existing || {}) }
  for (const field of SPEC_LISTS) {
    const value = list(input[field], field)
    if (value !== undefined) next[field] = value
  }
  for (const field of SPEC_LEVELS) {
    const value = level(input[field], field, levels)
    if (value !== undefined) next[field] = value
  }
  if (input.classification_reason !== undefined && input.classification_reason !== null) {
    const clean = String(input.classification_reason).trim()
    if (clean.length > REASON_MAX) {
      throw new CollabError(
        CODES.INVALID_INPUT,
        `spec.classification_reason is one line saying why the levels are what they are, under ${REASON_MAX} characters`,
        { length: clean.length }
      )
    }
    next.classification_reason = assertNoSecret(clean, 'spec.classification_reason')
  }
  const route = routeOf(input.route, levels)
  if (route !== undefined) next.route = route
  if (input.ux_impact !== undefined && input.ux_impact !== null && input.ux_impact !== '') {
    if (!UX_IMPACT.includes(input.ux_impact)) {
      throw new CollabError(CODES.INVALID_INPUT, `spec.ux_impact must be one of ${UX_IMPACT.join(', ')}`, {
        field: 'ux_impact',
        value: input.ux_impact
      })
    }
    next.ux_impact = input.ux_impact
  }
  const domains = list(input.ux_domains, 'ux_domains')
  if (domains !== undefined) {
    const unknown = domains.filter((d) => !UX_DOMAINS.includes(d))
    if (unknown.length) {
      throw new CollabError(CODES.INVALID_INPUT, `spec.ux_domains has unknown domain(s): ${unknown.join(', ')}`, {
        field: 'ux_domains',
        unknown,
        known: UX_DOMAINS
      })
    }
    next.ux_domains = [...new Set(domains)]
  }
  for (const flag of UX_FLAGS) {
    if (input[flag] === undefined || input[flag] === null) continue
    if (typeof input[flag] !== 'boolean') {
      throw new CollabError(CODES.INVALID_INPUT, `spec.${flag} must be true or false`, { field: flag })
    }
    next[flag] = input[flag]
  }
  // Contradictory, not missing: a HIGH change that opts out of the critic is
  // the one case the gate exists for, so it is refused rather than recorded.
  if (next.ux_impact === 'HIGH' && next.needs_ux_critic === false) {
    throw new CollabError(
      CODES.INVALID_INPUT,
      'spec.ux_impact HIGH always gets an independent UX review; needs_ux_critic cannot be false for it',
      { field: 'needs_ux_critic' }
    )
  }
  return Object.keys(next).length ? next : null
}

export function uxCriticRequired(spec) {
  if (!spec) return false
  if (spec.ux_impact === 'HIGH') return true
  return spec.ux_impact === 'MEDIUM' && spec.needs_ux_critic === true
}

const BLOCKING_UX = new Set(['blocker', 'critical', 'major'])

// Why a task that needs a UX review cannot be completed yet, or null. The
// latest submitted review by the ux_reviewer role decides: it must approve and
// carry no proven blocker/major — a finding without evidence is a hypothesis,
// not a blocker, the same rule every other review follows.
export function uxGateProblem(task, reviews = []) {
  if (!uxCriticRequired(task.spec)) return null
  const submitted = reviews
    .filter((r) => r.task_id === task.id && r.requested_role === UX_REVIEWER_ROLE && r.submitted_at)
    .sort((a, b) => String(a.submitted_at).localeCompare(String(b.submitted_at)))
  const latest = submitted[submitted.length - 1]
  if (!latest) {
    return `its ux_impact is ${task.spec.ux_impact} and it has no review by the ${UX_REVIEWER_ROLE} role yet — request_review with reviewer_role "${UX_REVIEWER_ROLE}" and slot "ui"`
  }
  if (latest.verdict !== 'approved') {
    return `the latest ${UX_REVIEWER_ROLE} review (${latest.id}) is ${latest.verdict}, not approved`
  }
  const open = (latest.findings || []).filter((f) => BLOCKING_UX.has(f.severity) && f.confidence !== 'hypothesis')
  if (open.length) {
    return `the latest ${UX_REVIEWER_ROLE} review (${latest.id}) still carries ${open.length} proven blocker/major finding(s)`
  }
  return null
}

export const CRITERION_STATUS = Object.freeze(['met', 'not_met', 'unverified'])

// The half of an evidence bundle the layer CANNOT see for itself. Changed files
// are in git, commands and their counters are in the runs, and both are attached
// on read — asking for them again as a declaration would invite a prettier
// version of what actually happened. What is asked for here is the part no
// machine can produce: which criteria the author believes are met, and what was
// left unverified.
export function normaliseEvidence(input) {
  if (input === undefined || input === null) return null
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new CollabError(CODES.INVALID_INPUT, 'evidence must be an object', {})
  }
  const known = new Set(['criteria_status', 'unverified', 'limitations', 'risks'])
  for (const key of Object.keys(input)) {
    if (!known.has(key)) {
      throw new CollabError(CODES.INVALID_INPUT, `evidence has no field "${key}"`, { field: key, known: [...known] })
    }
  }
  const next = {}
  for (const field of ['unverified', 'limitations', 'risks']) {
    const value = list(input[field], field)
    if (value !== undefined) next[field] = value
  }
  if (input.criteria_status !== undefined && input.criteria_status !== null) {
    if (!Array.isArray(input.criteria_status)) {
      throw new CollabError(CODES.INVALID_INPUT, 'evidence.criteria_status must be a list', {})
    }
    if (input.criteria_status.length > ITEMS_MAX) {
      throw new CollabError(CODES.INVALID_INPUT, `evidence.criteria_status has more than ${ITEMS_MAX} entries`, {})
    }
    next.criteria_status = input.criteria_status.map((entry, index) => {
      const criterion = typeof entry?.criterion === 'string' ? entry.criterion.trim() : ''
      if (!criterion || criterion.length > ITEM_MAX || /[\n\r]/.test(criterion)) {
        throw new CollabError(CODES.INVALID_INPUT, `evidence.criteria_status[${index}].criterion must be one short line`, {
          index
        })
      }
      if (!CRITERION_STATUS.includes(entry?.status)) {
        throw new CollabError(
          CODES.INVALID_INPUT,
          `evidence.criteria_status[${index}].status must be one of ${CRITERION_STATUS.join(', ')}`,
          { index, status: entry?.status }
        )
      }
      return { criterion: assertNoSecret(criterion, 'evidence.criteria_status'), status: entry.status }
    })
  }
  return Object.keys(next).length ? next : null
}

// What is missing for work that is about to cross an agent boundary. Advice,
// never a refusal: the owner's rule is that the layer records and advises, and
// a delegation blocked for a missing field would just be filled with filler.
export function boundaryWarnings(task, { what = 'this' } = {}) {
  const spec = task.spec || null
  const warnings = []
  if (!spec?.review_risk) {
    warnings.push(`no review_risk on ${task.id}: say how much a missed mistake costs before ${what} leaves your hands`)
  }
  if (!spec?.acceptance_criteria?.length) {
    warnings.push(`no acceptance_criteria on ${task.id}: a reviewer cannot tell drift from intent without them`)
  }
  return warnings
}
