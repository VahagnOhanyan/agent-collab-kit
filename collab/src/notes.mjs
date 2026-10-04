// Project notes for a skill: `<registry>/<project>/<skill>.md`, what a project-neutral skill (verify, ui-shot,
// device-run, db-migration, api-change) reads to learn which commands, paths and flags are THIS project's.
//
// ⛔ THEY ARE INSTRUCTIONS AN AGENT OBEYS. The skill says "run the project's gate command" and the note says what that
// command is, so whoever can edit a note can make the next session run anything with the owner's rights. That is why
// notes live in the registry, which agents cannot write, and why this is the ONLY way into it: an agent drafts the note
// anywhere it likes, and the owner — at their own terminal, after reading what would change — installs it. Nothing in
// this file can be reached from an agent: the command that uses it refuses an agent's shell and a script (cli.mjs).

import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { CODES, CollabError } from './errors.mjs'
import { assertNoSecret } from './policy.mjs'

// The skills that read project notes. A name outside this list is refused: the registry is not a place to put
// arbitrary files, and a typo must not create one.
export const NOTE_SKILLS = Object.freeze(['verify', 'ui-shot', 'device-run', 'db-migration', 'api-change'])
// What can be installed and under what name in the registry. The five notes are prose; `ui-review.json` is DATA the
// kit's scripts turn into build and simulator commands, so it gets a stricter check (below) instead of a size check.
export const NOTE_TARGETS = Object.freeze({
  ...Object.fromEntries(NOTE_SKILLS.map((skill) => [skill, `${skill}.md`])),
  'ui-review.json': 'ui-review.json'
})
export const NOTE_MAX_BYTES = 65_536
export const UI_REVIEW_MAX_BYTES = 4_096

// The fields ui-review/capture.sh reads (all non-empty strings when the platform is the simulator) and what each may
// contain. The values reach `xcodebuild` and `simctl` and a path under DerivedData, so a name is letters, digits and a
// few separators — never a space-free shell word like `a;b`, a `..`, or a leading slash.
const UI_REVIEW_FIELDS = Object.freeze({
  platform: /^[a-z0-9-]{1,40}$/,
  project: /^(?!\/)(?!.*\.\.)[A-Za-z0-9 ._+/-]{1,120}\.(xcodeproj|xcworkspace)$/,
  scheme: /^[A-Za-z0-9 ._+-]{1,80}$/,
  bundleId: /^[A-Za-z0-9.-]{1,155}$/,
  product: /^[A-Za-z0-9 ._+-]{1,80}$/,
  device: /^[A-Za-z0-9 ()._+-]{1,80}$/
})
const UI_REVIEW_REQUIRED_ON_SIMULATOR = Object.freeze(['project', 'scheme', 'bundleId', 'product', 'device'])

export function checkUiReviewJson(text) {
  let data
  try {
    data = JSON.parse(text)
  } catch (error) {
    refuse(`the draft is not valid JSON: ${error.message}`)
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) refuse('ui-review.json is one JSON object')
  const known = [...Object.keys(UI_REVIEW_FIELDS), 'appearanceNote']
  for (const key of Object.keys(data)) {
    if (!known.includes(key)) refuse(`ui-review.json has no field "${key}" — the fields are ${known.join(', ')}`, { field: key, known })
  }
  if (typeof data.platform !== 'string') refuse('ui-review.json needs a "platform" (ios-simulator, or another name when screenshots are supplied by hand)')
  const required = data.platform === 'ios-simulator' ? ['platform', ...UI_REVIEW_REQUIRED_ON_SIMULATOR] : ['platform']
  for (const key of required) {
    if (typeof data[key] !== 'string' || !data[key]) refuse(`ui-review.json needs a non-empty string "${key}" for platform ${data.platform}`, { field: key })
  }
  for (const [key, pattern] of Object.entries(UI_REVIEW_FIELDS)) {
    if (data[key] === undefined) continue
    if (typeof data[key] !== 'string' || !pattern.test(data[key])) {
      refuse(`ui-review.json "${key}" is ${JSON.stringify(data[key])}, which is not a plain value for it — these reach build and simulator commands`, { field: key })
    }
  }
  if (data.appearanceNote !== undefined) {
    if (typeof data.appearanceNote !== 'string' || data.appearanceNote.length > 600 || /[\u0000-\u0008\u000b-\u001f]/.test(data.appearanceNote)) {
      refuse('ui-review.json "appearanceNote" is one short piece of text, under 600 characters')
    }
  }
}

const refuse = (message, details = {}) => {
  throw new CollabError(CODES.INVALID_INPUT, message, details)
}

// Lines that are in `after` and not in `before`, and the other way round, counted as a multiset. Not a diff in the
// patch sense — enough for a person to see what a replacement adds and drops before agreeing to it.
export function lineChanges(before, after) {
  const count = (text) => {
    const map = new Map()
    for (const line of text.split('\n')) map.set(line, (map.get(line) || 0) + 1)
    return map
  }
  const was = count(before)
  const now = count(after)
  const added = []
  const removed = []
  for (const [line, n] of now) for (let i = 0; i < n - (was.get(line) || 0); i += 1) added.push(line)
  for (const [line, n] of was) for (let i = 0; i < n - (now.get(line) || 0); i += 1) removed.push(line)
  return { added, removed }
}

// Everything that can be checked before the owner is asked: the skill, the draft, the target. Throws a CollabError
// (INVALID_INPUT, or SECRET_IN_CONTENT from the secret check) with the reason; nothing is written.
export function planNoteInstall({ projectDir, skill, file }) {
  if (!Object.hasOwn(NOTE_TARGETS, skill)) {
    refuse(`"${skill}" is not something that can be installed here — the skills with project notes are ${NOTE_SKILLS.join(', ')}, and the build parameters are ui-review.json`, {
      skill,
      known: Object.keys(NOTE_TARGETS)
    })
  }
  const isData = skill === 'ui-review.json'
  if (!file) refuse('name the draft file: collab notes install <skill> <file>')
  let stat
  try {
    stat = lstatSync(file)
  } catch {
    refuse(`the draft ${file} does not exist`, { file })
  }
  // A link could point anywhere, and what is installed is what it points to at that moment, not what was read here.
  if (stat.isSymbolicLink() || !stat.isFile()) refuse(`the draft ${file} must be a regular file, not a link or a directory`, { file })
  if (stat.size === 0) refuse(`the draft ${file} is empty`, { file })
  const limit = isData ? UI_REVIEW_MAX_BYTES : NOTE_MAX_BYTES
  if (stat.size > limit) refuse(`the draft ${file} is ${stat.size} bytes; ${isData ? 'a ui-review.json is a few lines' : 'notes are read whole by an agent'}, keep it under ${limit}`, { file, bytes: stat.size })
  const text = readFileSync(file, 'utf8')
  if (text.includes('\0')) refuse(`the draft ${file} is not text`, { file })
  assertNoSecret(text, `the draft ${file}`)
  if (isData) checkUiReviewJson(text)

  const target = join(projectDir, NOTE_TARGETS[skill])
  let existing = null
  if (existsSync(target) || isLink(target)) {
    const targetStat = lstatSync(target)
    if (targetStat.isSymbolicLink() || !targetStat.isFile()) refuse(`${target} is not a regular file — look at it before replacing anything`, { target })
    existing = readFileSync(target, 'utf8')
  }
  return { skill, target, text, existing, bytes: stat.size, changes: existing === null ? null : lineChanges(existing, text), same: existing === text }
}

function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

// Written beside the target and moved into place, so a reader never sees half a note. Content is what was planned —
// the draft is not read a second time.
export function writeNote(plan) {
  const temporary = `${plan.target}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, plan.text, { flag: 'wx', mode: 0o644 })
    renameSync(temporary, plan.target)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
  return plan.target
}
