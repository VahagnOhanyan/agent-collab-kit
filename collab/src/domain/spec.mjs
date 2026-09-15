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

// Merges onto what is already there: a spec is filled in as the work is
// understood, and re-sending the whole thing to add one criterion is how fields
// like this end up unused. An explicit empty list clears one.
export function normaliseSpec(config, input, existing = null) {
  if (input === undefined || input === null) return existing || null
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new CollabError(CODES.INVALID_INPUT, 'spec must be an object', {})
  }
  const levels = config.models?.levels || {}
  const known = new Set([...SPEC_LISTS, ...SPEC_LEVELS, 'classification_reason'])
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
  return Object.keys(next).length ? next : null
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
