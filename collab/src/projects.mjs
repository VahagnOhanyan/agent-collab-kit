// The trusted project registry: the ONLY source of per-project configuration.
//
//   <registry>/<id>/project.json        { "id": "<id>", "roots": ["/abs/journal/root", ...] }
//   <registry>/<id>/collab/*.json       optional whole-file replacements of the defaults
//   <registry>/<id>/collab/briefings/   briefing files the agents.json there points at
//
// A project is found by its JOURNAL root (exact realpath match), never by
// anything inside the repository. Runners execute outside any sandbox, and a
// policy decides what needs the owner, so a repository must never be able to
// supply either: a cloned repo would otherwise ship the commands the layer runs.
// The registry lives outside every repository and belongs to the owner.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { CollabConfigError } from './errors.mjs'
import { safeRealpath } from './paths.mjs'

const PROJECT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/

export function readProjectEntry(dir, name, { home = homedir() } = {}) {
  const file = join(dir, 'project.json')
  const entry = { id: name, dir, file, roots: [], realRoots: [], legacyJournal: false, problems: [], warnings: [] }
  const where = `projects/${name}/project.json`
  let project
  try {
    project = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    entry.problems.push(`${where}: ${error.code === 'ENOENT' ? 'missing' : error.message}`)
    return entry
  }
  if (!PROJECT_ID.test(name)) entry.problems.push(`${where}: directory name "${name}" is not a valid project id`)
  if (project.id !== name) entry.problems.push(`${where}: id "${project.id}" must equal its directory name "${name}"`)
  // `legacy_journal: true` vouches for a markerless journal (made before
  // `collab init` wrote markers) at this project's roots. Only a real boolean.
  if (project.legacy_journal !== undefined && typeof project.legacy_journal !== 'boolean') {
    entry.problems.push(`${where}: legacy_journal must be true or false`)
  }
  entry.legacyJournal = project.legacy_journal === true
  if (!Array.isArray(project.roots) || project.roots.length === 0) {
    entry.problems.push(`${where}: roots must be a non-empty array of absolute paths`)
    return entry
  }
  const realHome = safeRealpath(home)
  for (const root of project.roots) {
    if (typeof root !== 'string' || !isAbsolute(root)) {
      entry.problems.push(`${where}: root ${JSON.stringify(root)} is not an absolute path`)
      continue
    }
    const real = safeRealpath(root)
    if (real === '/' || real === realHome) entry.problems.push(`${where}: root ${root} is the filesystem root or the home directory`)
    if (!existsSync(root)) entry.warnings.push(`${where}: root ${root} does not exist on this machine`)
    entry.roots.push(root)
    entry.realRoots.push(real)
  }
  return entry
}

export function listProjects(registry, options = {}) {
  let names
  try {
    names = readdirSync(registry)
  } catch {
    return []
  }
  return names
    .filter((name) => !name.startsWith('.'))
    .filter((name) => {
      try {
        return statSync(join(registry, name)).isDirectory()
      } catch {
        return false
      }
    })
    .sort()
    .map((name) => readProjectEntry(join(registry, name), name, options))
}

// An entry with problems is skipped rather than half-trusted; `collab
// check-config` is what reports it.
export function findProject(journalRoot, { registry, home } = {}) {
  const target = safeRealpath(journalRoot)
  const matches = listProjects(registry, { home }).filter((e) => e.problems.length === 0 && e.realRoots.includes(target))
  if (matches.length > 1) {
    throw new CollabConfigError([
      `journal root ${target} is claimed by more than one registry project: ${matches.map((m) => m.id).join(', ')}`
    ])
  }
  return matches[0] || null
}
