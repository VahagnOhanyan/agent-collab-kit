// Where things live, and the rules about it that matter.
//
// THREE ROOTS, NEVER CONFUSED.
//   INSTALL_ROOT  this package (collab/). Built-in defaults live in its config/.
//   JOURNAL_ROOT  the project the journal belongs to. `.collab/` lives here.
//                 For a git repository it is the parent of the COMMON git dir,
//                 so every linked worktree of one repository shares one journal.
//   CODE_ROOT     the working tree this process is looking at (git status,
//                 runners). For a worktree that is the worktree, not the main tree.
//
// TRUSTED INPUTS ARE PARAMETERS, NEVER ENVIRONMENT VARIABLES. The environment of
// an MCP server can be written by a repository's .mcp.json. So:
//   - config dir, registry and project root come only from parameters; the env
//     variables that once chose them are listed in IGNORED_ENV and reported;
//   - git is chosen once by a working `--version` probe over a fixed list of
//     absolute paths (never a PATH lookup) and run with GIT_*, NODE_OPTIONS,
//     loader and Apple toolchain variables (DEVELOPER_DIR, SDKROOT, …) stripped,
//     a fixed PATH and LC_ALL=C;
//   - a definitive "not a git repository" is the ONLY git failure read as "no
//     repository". Any other failure makes journal validation fail closed.
//
// A JOURNAL IS SOMETHING `collab init` MADE, HERE. `.collab` counts only when it
// is a real directory without symlinks, has no git-tracked content, and holds a
// marker bound to this exact root — or the complete legacy layout, but only for a
// root whose trusted registry project declares `"legacy_journal": true`. Nothing
// is ever created implicitly.
//
// The staging directory for atomic writes is INSIDE .collab/ and not os.tmpdir():
// rename(2) is atomic only within one filesystem.

import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CODES, CollabError } from './errors.mjs'
import { writeJsonAtomic } from './jsonio.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

// collab/src -> collab
export const INSTALL_ROOT = resolve(HERE, '..')
export const DEFAULT_CONFIG_DIR = join(INSTALL_ROOT, 'config')

// The trusted project registry. The single place its location is decided; the
// install step may later change this constant, tests pass a registryDir.
export const DEFAULT_REGISTRY_DIR = resolve(INSTALL_ROOT, '..', 'projects')

export const IGNORED_ENV = Object.freeze(['COLLAB_CONFIG_DIR', 'COLLAB_PROJECT_ROOT', 'COLLAB_REGISTRY_DIR', 'COLLAB_STATE_DIR'])
export const ignoredEnv = (env = process.env) => IGNORED_ENV.filter((name) => typeof env[name] === 'string' && env[name] !== '')

// ── executables and their environment ─────────────────────────────────────

const IS_WINDOWS = process.platform === 'win32'

// The node running this layer is the owner's registration, so its directory is
// on the fixed PATH (runners commonly need `node`/`npm`). A fixed PATH is not a
// trust anchor against a same-user process — see SECURITY.md.
export const FIXED_PATH_DIRS = Object.freeze([
  ...new Set(
    IS_WINDOWS
      ? [dirname(process.execPath), process.env.WINDIR ? `${process.env.WINDIR}\\System32` : 'C:\\Windows\\System32']
      : [dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin', '/opt/homebrew/bin', '/usr/local/bin']
  )
])
export const FIXED_PATH = FIXED_PATH_DIRS.join(IS_WINDOWS ? ';' : ':')

export function isExecutableFile(path) {
  try {
    const stat = statSync(path)
    return stat.isFile() && (stat.mode & 0o111) !== 0
  } catch {
    return false
  }
}

const STRIPPED_ENV =
  /^(GIT_|DYLD_|XCRUN_|XCODE)|^(NODE_OPTIONS|LD_PRELOAD|LD_LIBRARY_PATH|DEVELOPER_DIR|SDKROOT|TOOLCHAINS)$/i

export function sanitisedEnv(base = process.env) {
  const env = {}
  for (const [key, value] of Object.entries(base)) if (!STRIPPED_ENV.test(key)) env[key] = value
  env.PATH = FIXED_PATH
  return env
}

// LC_ALL=C so "not a git repository" can be recognised by its message.
const gitEnv = () => ({ ...sanitisedEnv(), LC_ALL: 'C' })

// Real binaries first; /usr/bin/git on macOS is an xcrun shim.
export const GIT_CANDIDATES = Object.freeze([
  '/opt/homebrew/bin/git',
  '/usr/local/bin/git',
  '/Library/Developer/CommandLineTools/usr/bin/git',
  '/Applications/Xcode.app/Contents/Developer/usr/bin/git',
  '/usr/bin/git'
])

export function selectGit(candidates = GIT_CANDIDATES) {
  for (const candidate of candidates) {
    if (!isExecutableFile(candidate)) continue
    try {
      const out = execFileSync(candidate, ['--version'], { env: gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 })
      if (/^git version \d/.test(out)) return candidate
    } catch {
      // not a working git: try the next one
    }
  }
  return null
}

let cachedGit
export function gitBinary() {
  if (cachedGit === undefined) cachedGit = selectGit()
  return cachedGit
}

// { ok: true, stdout } or { ok: false, notRepo, status, stderr }. `notRepo` is
// true only for git's definitive answer (exit 128, "not a git repository").
export function gitProbe(cwd, args) {
  const binary = gitBinary()
  if (!binary) return { ok: false, notRepo: false, status: -1, stderr: `no working git among ${GIT_CANDIDATES.join(', ')}` }
  const result = spawnSync(binary, args, { cwd, env: gitEnv(), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30_000 })
  if (result.status === 0) return { ok: true, stdout: result.stdout }
  const stderr = `${result.stderr || ''}${result.error ? ` ${result.error.message}` : ''}`.trim()
  return { ok: false, status: result.status, stderr, notRepo: result.status === 128 && /not a git repository/.test(stderr) }
}

// For callers that only want output (status, snapshots): throws on any failure.
export function runGit(cwd, args) {
  const probe = gitProbe(cwd, args)
  if (probe.ok) return probe.stdout
  const error = new Error(probe.stderr || `git exited ${probe.status}`)
  error.status = probe.status
  throw error
}

export const lstatOrNull = (path) => {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

function hasDotGitAbove(dir) {
  for (let current = resolve(dir); ; current = dirname(current)) {
    if (lstatOrNull(join(current, '.git'))) return true
    if (dirname(current) === current) return false
  }
}

// ── the journal ────────────────────────────────────────────────────────────

export const STATE_DIR_NAME = '.collab'
export const JOURNAL_MARKER = 'journal.json'

export const COLLECTIONS = Object.freeze([
  'tasks',
  'messages',
  'reviews',
  'decisions',
  'approvals',
  'runs',
  'agents'
])

export const LAYOUT_DIRS = Object.freeze(['tmp', 'locks', ...COLLECTIONS])

export function safeRealpath(path) {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

// lstat: a symlink to a directory is NOT a directory here.
const isRealDirectory = (path) => Boolean(lstatOrNull(path)?.isDirectory())

// git facts about a directory: an info object; null when git says definitively
// that it is not inside a repository; `{ unknown: true, reason }` for any other
// failure (broken config, dubious ownership, a git that does not run, …).
export function gitInfo(dir) {
  const probe = gitProbe(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'])
  if (!probe.ok) {
    if (probe.notRepo) return null
    // No working git at all, and no `.git` anywhere above: nothing to ask about.
    if (!gitBinary() && !hasDotGitAbove(dir)) return null
    return { unknown: true, reason: probe.stderr || `git exited ${probe.status}` }
  }
  const [commonDir, toplevel] = probe.stdout.trim().split('\n')
  if (!commonDir || !toplevel) return { unknown: true, reason: 'git rev-parse gave no answer' }
  const common = safeRealpath(commonDir)
  const top = safeRealpath(toplevel)
  // A normal repository and all its linked worktrees share `<main>/.git`, whose
  // parent is the main tree. A submodule (or --separate-git-dir) has a common
  // dir like `<super>/.git/modules/<name>`; its parent is not a working tree,
  // so the journal falls back to the checkout itself.
  const journalRoot = basename(common) === '.git' ? dirname(common) : top
  return { commonDir: common, toplevel: top, journalRoot }
}

function assertAllowedRoot(root, { home, how }) {
  const realHome = safeRealpath(home)
  if (root === '/' || root === realHome) {
    const what = root === '/' ? 'the filesystem root' : 'your home directory'
    throw new CollabError(
      CODES.ROOT_REFUSED,
      `refusing to use ${what} (${root}) as a collab project root (${how}) — a journal there would collect every session on the machine. ` +
        'Open the session inside a project directory.',
      { root, how }
    )
  }
  return root
}

// Any entry named `.collab` stops the walk — a symlink or a file included — so
// the error names it instead of silently picking some directory further up.
function walkUpFor(start, name) {
  let dir = start
  for (;;) {
    if (lstatOrNull(join(dir, name))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

// Entries of a state directory that are symbolic links. A journal never has one:
// every write follows the path, so a link would send records, run logs or the
// lock to wherever it points.
export function journalLinks(stateDir) {
  const root = stateDir ? lstatOrNull(stateDir) : null
  if (!root) return []
  if (root.isSymbolicLink()) return [stateDir]
  if (!root.isDirectory()) return []
  return [...LAYOUT_DIRS, 'events.jsonl', JOURNAL_MARKER]
    .map((name) => join(stateDir, name))
    .filter((path) => lstatOrNull(path)?.isSymbolicLink())
}

// Files of the state directory that git tracks. `error` whenever git could not
// give a definitive answer — a journal that cannot be verified is refused.
function trackedJournalFiles(stateDir) {
  const root = dirname(stateDir)
  const info = gitInfo(root)
  if (!info) return { tracked: [] }
  if (info.unknown) return { tracked: [], error: info.reason }
  const probe = gitProbe(root, ['ls-files', '-z', '--', basename(stateDir)])
  if (!probe.ok) return { tracked: [], error: probe.stderr || `git exited ${probe.status}` }
  return { tracked: probe.stdout.split('\0').filter(Boolean) }
}

function readMarker(stateDir) {
  const marker = join(stateDir, JOURNAL_MARKER)
  const entry = lstatOrNull(marker)
  if (!entry) return null
  try {
    const data = entry.isFile() ? JSON.parse(readFileSync(marker, 'utf8')) : null
    return data?.collab_journal === 1 ? data : 'invalid'
  } catch {
    return 'invalid'
  }
}

const isLegacyLayout = (stateDir) =>
  Boolean(lstatOrNull(join(stateDir, 'events.jsonl'))?.isFile()) && COLLECTIONS.every((c) => isRealDirectory(join(stateDir, c)))

// `legacyJournal`: the trusted registry vouches for a markerless journal at this root.
export function journalState(stateDir, { legacyJournal = false } = {}) {
  const absent = (reason) => ({ initialized: false, code: CODES.NOT_INITIALIZED, reason })
  const invalid = (reason, extra = {}) => ({ initialized: false, code: CODES.JOURNAL_INVALID, reason, ...extra })

  const entry = stateDir ? lstatOrNull(stateDir) : null
  if (!entry) return absent(`${stateDir} does not exist`)
  const links = journalLinks(stateDir)
  if (links.length) {
    return absent(`${links.join(', ')} ${links.length === 1 ? 'is a symbolic link' : 'are symbolic links'}, which a journal never contains`)
  }
  if (!entry.isDirectory()) return absent(`${stateDir} is not a directory`)

  const tracking = trackedJournalFiles(stateDir)
  if (tracking.error) {
    return invalid(`could not ask git whether ${stateDir} is tracked (${tracking.error}), so it cannot be verified and is refused`)
  }
  if (tracking.tracked.length) {
    const sample = tracking.tracked.slice(0, 3).join(', ') + (tracking.tracked.length > 3 ? ', …' : '')
    return invalid(
      `${stateDir} contains files tracked by git (${sample}) — a journal is local state, and a committed one could have been ` +
        `forged by the repository. Remove it from git (git rm -r --cached ${basename(stateDir)}) and run \`collab init\``,
      { tracked: true }
    )
  }

  const marker = readMarker(stateDir)
  if (marker === 'invalid') return absent(`${join(stateDir, JOURNAL_MARKER)} is not a valid journal marker`)
  if (marker) {
    const here = safeRealpath(dirname(stateDir))
    if (marker.journal_root !== here) {
      return invalid(
        `journal was copied or moved: it is bound to ${marker.journal_root || '(no recorded root)'} but found at ${here}. ` +
          'Run `collab init --adopt` after checking it',
        { moved: true, bound_to: marker.journal_root || null }
      )
    }
    return { initialized: true, kind: 'marker' }
  }
  if (isLegacyLayout(stateDir)) {
    // Journals written before the marker existed. Without a marker nothing ties
    // one to this root, so only the owner's registry can vouch for it.
    if (legacyJournal) return { initialized: true, kind: 'legacy' }
    return invalid(
      `${stateDir} has the legacy layout but no marker, and no registry project for this root declares "legacy_journal": true — ` +
        'it could be a copy. Run `collab init --adopt` after checking it',
      { legacyUnbound: true }
    )
  }
  return absent(`${stateDir} exists but is not a journal (no ${JOURNAL_MARKER} and no complete legacy layout)`)
}

// Resolution order:
//   1. the projectRoot parameter (absolute path; tests and explicit callers);
//   2. inside a git work tree: the parent of the common git dir;
//   3. the nearest ancestor of cwd holding a `.collab` entry;
//   4. unresolved (journalRoot null).
// `/` and the home directory are refused, whichever step produced them.
// `legacyJournalFor(root)` answers whether the registry vouches for a markerless journal there.
export function resolveRoots({ cwd = process.cwd(), home = homedir(), projectRoot = null, legacyJournalFor = () => false } = {}) {
  const realCwd = safeRealpath(cwd)
  const probed = gitInfo(realCwd)
  const git = probed && !probed.unknown ? probed : null
  let journalRoot = null
  let source = null

  if (projectRoot) {
    if (!isAbsolute(projectRoot)) {
      throw new CollabError(CODES.ROOT_REFUSED, `projectRoot must be an absolute path, got "${projectRoot}"`, { value: projectRoot })
    }
    journalRoot = safeRealpath(projectRoot)
    source = 'parameter'
  } else if (git) {
    journalRoot = git.journalRoot
    source = 'git'
  } else {
    journalRoot = walkUpFor(realCwd, STATE_DIR_NAME)
    source = journalRoot ? 'collab-dir' : null
  }

  if (journalRoot) assertAllowedRoot(journalRoot, { home, how: source })

  // The working tree is the cwd's own worktree only when it belongs to the same
  // journal: a projectRoot for project A from a shell inside project B must not
  // run A's checks in B's tree.
  const codeRoot = journalRoot && git && git.journalRoot === journalRoot ? git.toplevel : journalRoot
  const stateDir = journalRoot ? join(journalRoot, STATE_DIR_NAME) : null
  const journal = stateDir ? journalState(stateDir, { legacyJournal: Boolean(legacyJournalFor(journalRoot)) }) : null

  return { cwd: realCwd, journalRoot, codeRoot, stateDir, source, journal, initialized: Boolean(journal?.initialized) }
}

export const layout = (root) => ({
  root,
  tmp: join(root, 'tmp'),
  locks: join(root, 'locks'),
  lockFile: join(root, 'locks', 'store.lock'),
  events: join(root, 'events.jsonl'),
  marker: join(root, JOURNAL_MARKER),
  collection: (name) => join(root, name),
  record: (name, id) => join(root, name, `${id}.json`),
  runLog: (id) => join(root, 'runs', `${id}.log`)
})

// Opens the layout of an INITIALISED journal (filling in a missing tmp/ or
// locks/ of a legacy one). Without `create` — which only `collab init` passes —
// anything that is not a journal is refused before a single mkdir.
export function ensureLayout(root, { create = false, legacyJournal = false } = {}) {
  if (!create) {
    const state = journalState(root, { legacyJournal })
    if (!state.initialized) {
      const hint = state.code === CODES.JOURNAL_INVALID ? '' : ' — run `collab init` in the project first'
      throw new CollabError(state.code, `${state.reason}${hint}`, { state_dir: root, reason: state.reason, command: 'collab init' })
    }
  }
  for (const dir of [root, ...LAYOUT_DIRS.map((d) => join(root, d))]) {
    if (!existsSync(dir)) mkdirSync(dir)
  }
  return layout(root)
}

// The marker is written LAST and atomically (staged in tmp/, renamed into
// place): a concurrent reader sees either no journal or a complete one. It
// records the realpath of the root, so a copy elsewhere is recognisable.
function writeMarker(stateDir, journalRoot, extra = {}) {
  ensureLayout(stateDir, { create: true })
  writeJsonAtomic(
    join(stateDir, JOURNAL_MARKER),
    { collab_journal: 1, created_at: new Date().toISOString(), ...extra, journal_root: journalRoot },
    { tmpDir: join(stateDir, 'tmp') }
  )
}

function gitStatus(cwd, args) {
  const probe = gitProbe(cwd, args)
  return probe.ok ? 0 : typeof probe.status === 'number' ? probe.status : -1
}

// `collab init` (and `collab init --adopt`): the only code paths that create or
// re-bind a journal. The CLI puts --adopt behind a TTY and a typed-back root.
export function initJournal({ cwd = process.cwd(), home = homedir(), projectRoot = null, adopt = false, legacyJournalFor = () => false } = {}) {
  const roots = resolveRoots({ cwd, home, projectRoot, legacyJournalFor })
  const journalRoot = roots.journalRoot || assertAllowedRoot(roots.cwd, { home, how: 'cwd' })
  const stateDir = join(journalRoot, STATE_DIR_NAME)

  const links = journalLinks(stateDir)
  if (links.length) {
    throw new CollabError(
      CODES.JOURNAL_INVALID,
      `refusing to initialise: ${links.join(', ')} ${links.length === 1 ? 'is a symbolic link' : 'are symbolic links'} — ` +
        'a journal is never built inside a link target. Remove the link and run `collab init` again.',
      { links }
    )
  }
  const entry = lstatOrNull(stateDir)
  if (entry && !entry.isDirectory()) {
    throw new CollabError(CODES.JOURNAL_INVALID, `refusing to initialise: ${stateDir} exists and is not a directory`, { state_dir: stateDir })
  }

  const before = journalState(stateDir, { legacyJournal: Boolean(legacyJournalFor(journalRoot)) })
  let created = false
  let adopted = false
  if (adopt) {
    if (before.tracked) {
      throw new CollabError(CODES.JOURNAL_INVALID, `${before.reason}. Adoption does not make a tracked journal trustworthy.`, { state_dir: stateDir })
    }
    if (before.initialized && before.kind === 'marker') {
      // already bound to this root: nothing to do
    } else if (before.moved || before.legacyUnbound || (before.initialized && before.kind === 'legacy')) {
      const previous = readMarker(stateDir)
      writeMarker(stateDir, journalRoot, {
        ...(previous && previous !== 'invalid' ? { created_at: previous.created_at } : {}),
        adopted_at: new Date().toISOString(),
        adopted_from: before.bound_to || 'legacy layout'
      })
      adopted = true
    } else {
      throw new CollabError(before.code, `nothing to adopt: ${before.reason}. Use \`collab init\` to start a journal.`, { state_dir: stateDir })
    }
  } else {
    if (before.code === CODES.JOURNAL_INVALID) {
      throw new CollabError(CODES.JOURNAL_INVALID, before.reason, { state_dir: stateDir, journal_root: journalRoot })
    }
    if (!before.initialized) {
      writeMarker(stateDir, journalRoot)
      created = true
    }
  }

  // Ignored through the COMMON git dir's info/exclude: it covers every worktree
  // and changes no tracked file, so `git status` stays exactly as it was.
  let ignore = 'not-a-git-repository'
  let ignoreFile = null
  const git = gitInfo(journalRoot)
  if (git?.unknown) {
    ignore = 'check-failed'
  } else if (git) {
    const status = gitStatus(journalRoot, ['check-ignore', '-q', '--', `${STATE_DIR_NAME}/`])
    if (status === 0) {
      ignore = 'already-ignored'
    } else if (status === 1) {
      ignoreFile = join(git.commonDir, 'info', 'exclude')
      mkdirSync(dirname(ignoreFile), { recursive: true })
      const current = existsSync(ignoreFile) ? readFileSync(ignoreFile, 'utf8') : ''
      const lead = current && !current.endsWith('\n') ? '\n' : ''
      appendFileSync(ignoreFile, `${lead}# collab journal (local state, never committed)\n${STATE_DIR_NAME}/\n`, 'utf8')
      ignore = 'excluded'
    } else {
      ignore = 'check-failed'
    }
  }
  return {
    journalRoot,
    stateDir,
    created,
    adopted,
    kind: before.initialized ? before.kind : 'marker',
    ignore,
    ignore_file: ignoreFile,
    source: roots.source || 'cwd'
  }
}
