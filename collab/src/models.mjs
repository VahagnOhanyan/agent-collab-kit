// Reading the model registry: which model a level means, and whether the ids in
// it are still true.
//
// Nothing here starts a model or picks one. The lead session decides and
// launches; this module answers "what may L2 mean for this vendor", "what does
// `terra` stand for today" and "does the vendor's own catalog still contain what
// we claim". The last question is the reason the registry is worth having as
// data instead of prose: model line-ups drift, and a file that cannot be checked
// against the vendor goes stale silently.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

export function listModels(ctx) {
  const config = ctx.config.models
  const levels = Object.entries(config.levels).map(([id, level]) => ({
    id,
    rank: level.rank,
    summary: level.summary,
    models: config.models.filter((m) => m.level === id).map((m) => m.ref)
  }))
  levels.sort((a, b) => a.rank - b.rank)
  return {
    levels,
    vendors: Object.entries(config.vendors).map(([name, vendor]) => ({
      name,
      agent: vendor.agent,
      verified: vendor.verified || null,
      verified_at: vendor.verified_at || null,
      checkable: Boolean(vendor.catalog_file),
      note: vendor.note || null
    })),
    models: config.models.map((model) => ({ ...model }))
  }
}

export function modelByRef(config, ref) {
  return config.models.models.find((model) => model.ref === ref) || null
}

export const levelIds = (config) => Object.keys(config.models.levels)
export const levelRank = (config, id) => config.models.levels[id]?.rank ?? null

// The level a task's review risk cannot go below, given what the POLICY TABLE
// made of its action — not given what the task said about itself. One line in
// auth is the case this exists for: the diff is tiny, the cost of a missed
// mistake is not, and the layer already knows the action class. Returns null
// when the class floors nothing, and the floor level otherwise.
//
// It RETURNS a floor and never throws: a declared level below it is a reading
// worth correcting, not a reason to refuse the work.
export function reviewRiskFloor(config, actionClass) {
  const floor = config.models.review_risk_floor?.[actionClass]
  return floor && config.models.levels[floor] ? floor : null
}

// What the effective review risk is, and whether the declaration was raised.
export function effectiveReviewRisk(config, { declared = null, actionClass = null } = {}) {
  const floor = reviewRiskFloor(config, actionClass)
  if (!floor) return { level: declared || null, floor: null, raised: false }
  const floorRank = levelRank(config, floor)
  const declaredRank = declared ? levelRank(config, declared) : null
  const raised = declaredRank === null || declaredRank < floorRank
  return { level: raised ? floor : declared, floor, raised }
}

// What a free-text model name means, if anything. The lead names a model in a
// delegation; this maps `sonnet`, `claude-sonnet-5` or `sonnet (effort high)`
// onto a registry entry so the journal can be counted later instead of being a
// pile of near-synonyms. An unknown name is NOT an error — a model the registry
// has not heard of is exactly what the owner needs to see in the journal.
export function resolveModel(config, value) {
  const raw = String(value || '').trim()
  if (!raw) return { ref: null, id: null, effort: null, known: false, named: raw }
  const effortMatch = /\b(?:effort|reasoning)[ :=]+([a-z]+)/i.exec(raw)
  const effort = effortMatch ? effortMatch[1].toLowerCase() : null
  const name = raw
    .replace(/\((?:[^()]*)\)/g, ' ')
    .replace(/\b(?:effort|reasoning)[ :=]+[a-z]+/gi, ' ')
    .trim()
  const byRef = config.models.models.find((model) => model.ref === name.toLowerCase())
  const byId = byRef || config.models.models.find((model) => model.id === name)
  const model = byId || null
  return {
    ref: model?.ref || null,
    id: model?.id || null,
    effort: effort || model?.effort || null,
    known: Boolean(model),
    named: raw
  }
}

const expand = (path) => (path.startsWith('~/') ? join(homedir(), path.slice(2)) : path)

function readCatalog(vendor) {
  const file = expand(vendor.catalog_file)
  if (!isAbsolute(file)) return { error: `catalog_file ${vendor.catalog_file} is not an absolute path` }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    return { file, error: error.code === 'ENOENT' ? `${file} does not exist` : `${file}: ${error.message}` }
  }
  const at = vendor.catalog_path ? parsed?.[vendor.catalog_path] : parsed
  if (!Array.isArray(at)) return { file, error: `${file} has no array at "${vendor.catalog_path || '(root)'}"` }
  const key = vendor.catalog_key || 'id'
  return { file, ids: new Set(at.map((entry) => entry?.[key]).filter(Boolean)), fetched_at: parsed?.fetched_at || null }
}

// Per vendor: does its own catalog still list what we claim, and what has it
// gained that we do not know about. A vendor with no catalog file is reported as
// UNVERIFIABLE rather than ok — saying "ok" about something nobody checked is
// the failure this whole file exists to prevent.
export function catalogDrift(config) {
  return Object.entries(config.models.vendors).map(([name, vendor]) => {
    const declared = config.models.models.filter((model) => model.vendor === name)
    const base = { vendor: name, agent: vendor.agent, declared: declared.length }
    if (!vendor.catalog_file) {
      return {
        ...base,
        status: 'unverifiable',
        verified: vendor.verified || null,
        verified_at: vendor.verified_at || null,
        detail: vendor.note || 'no catalog on this machine to check the ids against'
      }
    }
    const catalog = readCatalog(vendor)
    if (catalog.error) return { ...base, status: 'unreadable', detail: catalog.error }
    const ids = new Set(declared.map((model) => model.id))
    const missing = [...ids].filter((id) => !catalog.ids.has(id))
    const appeared = [...catalog.ids].filter((id) => !ids.has(id))
    return {
      ...base,
      status: missing.length ? 'drift' : 'ok',
      catalog_file: catalog.file,
      fetched_at: catalog.fetched_at,
      missing,
      appeared
    }
  })
}
