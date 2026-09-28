// `collab connect` / `collab disconnect`: put any project on this machine under
// the kit, or take it off.
//
// A project is an entry in the trusted registry (projects.mjs): an id, the
// journal roots it owns, and what agents may do there. Connecting writes that
// entry from what the project itself shows — its tracked top-level entries
// become the implementer's write scope, an Xcode project enables the verifier's
// Apple commands, an executable scripts/preflight.sh becomes the gate — and the
// person connecting sees the proposal first. The entry grants rights, so the
// CLI writes it only for a person at an interactive terminal (cli.mjs); this
// module only proposes and writes what it is told to.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { CODES, CollabError } from './errors.mjs'
import { writeJsonAtomic } from './jsonio.mjs'
import { findProject, readProjectEntry } from './projects.mjs'
import { gitProbe, isExecutableFile, lstatOrNull, safeRealpath } from './paths.mjs'

const PROJECT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/

export function suggestId(root) {
  const id = basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+/, '')
    .slice(0, 64)
  return PROJECT_ID.test(id) ? id : null
}

// What git tracks here. Only git's definitive "not a git repository" means "not
// a repository"; any other failure (dubious ownership, a corrupt index, a
// timeout) refuses — a guess would widen what agents may write.
function trackedTopLevel(root) {
  const probe = gitProbe(root, ['ls-files', '-z'])
  if (!probe.ok) {
    if (probe.notRepo) return null
    throw new CollabError(CODES.CONFIG_INVALID, `cannot list what git tracks in ${root}: ${probe.stderr || `git exited ${probe.status}`}`, { root })
  }
  const tops = new Set()
  const all = []
  for (const path of probe.stdout.split('\0')) {
    if (!path) continue
    all.push(path)
    tops.add(path.split('/')[0])
  }
  return { tops: [...tops].sort(), all }
}

// Enables only the verifier's read-only platform commands, so for a directory
// without git the top-level names are enough evidence.
function detectApple(tracked, root) {
  const names = tracked ? tracked.all : readdirSync(root)
  return names.some((p) => /(^|\/)[^/]+\.(xcodeproj|xcworkspace)(\/|$)/.test(p) || p === 'Package.swift')
}

// What connecting `root` would write. Refuses (with a reason) when the root is
// already another project's, or when the id is taken by a different project.
export function proposeConnection({ journalRoot, registryDir, id = null }) {
  const root = safeRealpath(journalRoot)
  const existing = findProject(root, { registry: registryDir })
  if (existing) return { ok: false, reason: `already connected as "${existing.id}"`, existing: existing.id, root }

  const chosen = id || suggestId(root)
  if (!chosen || !PROJECT_ID.test(chosen)) {
    return { ok: false, reason: `"${id || basename(root)}" is not a valid project id — pass --id <lowercase-letters-digits-_->`, root }
  }
  if (existsSync(join(registryDir, chosen))) {
    return { ok: false, reason: `the id "${chosen}" is already used by another project — pass --id <other>`, root }
  }

  // Without git there is nothing that says what is source and what is build
  // output or secrets, so the implementer gets no write scope until the owner
  // names it in scopes.json.
  const tracked = trackedTopLevel(root)
  const allow = (tracked ? tracked.tops : [])
    .filter((name) => !name.startsWith('.'))
    .map((name) => {
      try {
        return statSync(join(root, name)).isDirectory() ? `${name}/` : name
      } catch {
        return `${name}/`
      }
    })
  const gate = isExecutableFile(join(root, 'scripts', 'preflight.sh')) ? 'scripts/preflight.sh' : null
  const apple = detectApple(tracked, root)

  const files = {
    'project.json': { id: chosen, roots: [root], ...(gate ? { gate } : {}) },
    'scopes.json': { implementer: { allow, deny: [] } }
  }
  if (apple) files['readonly-guard.json'] = { platforms: ['apple'] }
  return { ok: true, id: chosen, root, gate, apple, allow, files, git: Boolean(tracked) }
}

// The whole entry is built in a staging directory and published with one
// rename: a crash leaves either no entry or a complete one, and a rename onto an
// id somebody created meanwhile fails instead of mixing their files with ours.
export function writeConnection(proposal, { registryDir }) {
  if (lstatOrNull(registryDir)?.isSymbolicLink()) {
    throw new CollabError(CODES.CONFIG_INVALID, `the registry ${registryDir} is a symbolic link — refusing to write into it`, { registryDir })
  }
  const final = join(registryDir, proposal.id)
  const staging = join(registryDir, '.tmp')
  mkdirSync(staging, { recursive: true })
  const stage = mkdtempSync(join(staging, `${proposal.id}-`))
  try {
    for (const [name, value] of Object.entries(proposal.files)) writeFileSync(join(stage, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    renameSync(stage, final)
  } catch (error) {
    rmSync(stage, { recursive: true, force: true })
    if (['EEXIST', 'ENOTEMPTY', 'EISDIR', 'ENOTDIR'].includes(error.code)) {
      throw new CollabError(CODES.CONFIG_INVALID, `the id "${proposal.id}" appeared in the registry meanwhile — nothing written`, { id: proposal.id })
    }
    throw error
  }
  return final
}

// Take this root off the registry. The last root of a project removes the
// project's entry; the journal (.collab/) in the project is never touched.
export function disconnectRoot({ journalRoot, registryDir }) {
  const root = safeRealpath(journalRoot)
  const entry = findProject(root, { registry: registryDir })
  if (!entry) return { ok: false, reason: 'this directory is not connected', root }
  const keep = entry.roots.filter((r, i) => entry.realRoots[i] !== root)
  if (keep.length === 0) {
    rmSync(entry.dir, { recursive: true, force: true })
    return { ok: true, id: entry.id, root, removed: 'project' }
  }
  // Everything else in project.json (gate, legacy_journal, …) is kept as is.
  const stored = JSON.parse(readFileSync(entry.file, 'utf8'))
  writeJsonAtomic(join(entry.dir, 'project.json'), { ...stored, roots: keep }, { tmpDir: join(registryDir, '.tmp') })
  return { ok: true, id: entry.id, root, removed: 'root' }
}

// The first write to the persistent registry brings the release's registry
// along, so projects connected the old way keep working. Built aside and
// published with one rename: an interrupted move leaves no persistent registry
// (the release one keeps serving) rather than a half-copied one that would
// switch every lookup over. Only entries that validate, and no symlinks.
export function ensurePersistentRegistry({ persistent, release }) {
  if (lstatOrNull(persistent)) return { created: false, copied: [], skipped: [] }
  mkdirSync(dirname(persistent), { recursive: true })
  const stage = mkdtempSync(join(dirname(persistent), '.projects-'))
  const copied = []
  const skipped = []
  try {
    if (release && lstatOrNull(release)?.isDirectory()) {
      for (const name of readdirSync(release)) {
        if (name.startsWith('.')) continue
        const from = join(release, name)
        if (!lstatOrNull(from)?.isDirectory()) continue
        if (readProjectEntry(from, name).problems.length) {
          skipped.push(name)
          continue
        }
        cpSync(from, join(stage, name), { recursive: true })
        copied.push(name)
      }
    }
    renameSync(stage, persistent)
  } catch (error) {
    rmSync(stage, { recursive: true, force: true })
    if (['EEXIST', 'ENOTEMPTY'].includes(error.code)) return { created: false, copied: [], skipped: [] }
    throw error
  }
  return { created: true, copied, skipped }
}
