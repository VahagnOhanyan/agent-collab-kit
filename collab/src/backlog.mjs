// The project's backlog of small review findings, grouped by FEATURE (a screen, an area of the product) rather than
// by review code, so a batch of small things in one place can be cleaned up in one go.
//
// Where the file is and which features exist come only from the trusted project registry
// (`<registry>/<project>/project.json` → `review_backlog`, `<registry>/<project>/features.json`); this module names
// no project. The backlog file itself is read from the project's root. Nothing here writes it.
//
// A record is one line `- [Tag] path[:line] — what`. Its feature is the first entry of features.json, top to
// bottom, one of whose path patterns matches the record's path (`*` within a path segment, `**` across segments,
// `{a,b}` alternatives). A record no feature claims goes to "Без фичи".

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

export const CLEANUP_THRESHOLD = 8
export const NO_FEATURE = 'Без фичи'
export const CLEANUP_TITLE_PREFIX = 'Уборка мелочей: '

// `- [Tag] path[:line] [symbol …] — what`. The separator is an em or en dash (a hyphen occurs in file names); what
// stands between the path and the dash (a symbol like `importMedia`) belongs to the text.
const RECORD = /^\s*[-*]\s+\[([^\]]+)\]\s+(\S+?)(?::(\d+(?:-\d+)?))?(?:\s+([^—–\s].*?))?\s+[—–]\s+(.+)$/

function escapeRegex(text) {
  return text.replace(/[.+^$()|[\]\\]/g, '\\$&')
}

// Inside {a,b} every character is literal — `*` and `?` included — so a pattern cannot turn into a broken regex.
function escapeLiteral(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// A path pattern as a regular expression over a repository-relative path with forward slashes.
export function patternToRegex(pattern) {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*' && pattern[i + 1] === '*') {
      // `**/` matches any number of whole segments (including none); a trailing `**` matches the rest.
      if (pattern[i + 2] === '/') {
        out += '(?:[^/]+/)*'
        i += 2
      } else {
        out += '.*'
        i += 1
      }
    } else if (c === '*') {
      out += '[^/]*'
    } else if (c === '?') {
      out += '[^/]'
    } else if (c === '{') {
      const end = pattern.indexOf('}', i)
      if (end === -1) {
        out += '\\{'
      } else {
        out += `(?:${pattern.slice(i + 1, end).split(',').map(escapeLiteral).join('|')})`
        i = end
      }
    } else {
      out += escapeRegex(c)
    }
  }
  return new RegExp(`^${out}$`)
}

export function parseBacklog(text) {
  const records = []
  const lines = text.split(/\r?\n/)
  lines.forEach((line, index) => {
    const match = RECORD.exec(line)
    if (!match) return
    const [, tag, rawPath, fileLine, symbol, rest] = match
    const what = symbol ? `${symbol} — ${rest}` : rest
    records.push({
      tag,
      subarea: tag.includes('/') ? tag.slice(tag.indexOf('/') + 1).trim() : null,
      path: rawPath.replace(/^\.\//, '').replace(/[`,;]+$/, '').replace(/^`/, ''),
      file_line: fileLine || null,
      text: what.trim(),
      source_line: index + 1
    })
  })
  return records
}

export function validateFeatures(features) {
  const problems = []
  if (!Array.isArray(features)) return ['features.json: "features" must be a list']
  const seen = new Set()
  features.forEach((feature, index) => {
    const where = `features.json: feature #${index + 1}`
    if (!feature || typeof feature.name !== 'string' || !feature.name.trim()) problems.push(`${where} has no name`)
    else if (seen.has(feature.name)) problems.push(`${where} repeats the name "${feature.name}"`)
    else seen.add(feature.name)
    if (!Array.isArray(feature?.paths) || !feature.paths.length || !feature.paths.every((p) => typeof p === 'string' && p.length)) {
      problems.push(`${where} needs a non-empty list of path patterns`)
    }
    // Optional: the role a cleanup of this feature goes to (an id of the roles in force; the panel refuses one nobody holds).
    if (feature?.role !== undefined && (typeof feature.role !== 'string' || !/^[a-z][a-z0-9_]{1,63}$/.test(feature.role))) {
      problems.push(`${where} has a role that is not a role id`)
    }
  })
  return problems
}

export function groupByFeature(records, features) {
  const compiled = features.map((feature) => ({ name: feature.name, patterns: feature.paths.map(patternToRegex) }))
  const groups = new Map(features.map((feature) => [feature.name, []]))
  const roles = new Map(features.map((feature) => [feature.name, feature.role || null]))
  groups.set(NO_FEATURE, [])
  for (const record of records) {
    const owner = compiled.find((feature) => feature.patterns.some((pattern) => pattern.test(record.path)))
    groups.get(owner ? owner.name : NO_FEATURE).push(record)
  }
  return [...groups.entries()].filter(([, list]) => list.length).map(([name, list]) => ({ feature: name, records: list, role: roles.get(name) || null }))
}

// A path inside the project root, never outside it — lexically, and again after links are resolved, so a linked
// directory on the way cannot lead out.
function projectFile(root, path) {
  if (typeof path !== 'string' || !path || isAbsolute(path)) return null
  const full = resolve(root, path)
  const inside = (base, candidate) => {
    const rel = relative(base, candidate)
    return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel)
  }
  if (!inside(root, full)) return null
  if (existsSync(full)) {
    try {
      if (!inside(realpathSync(root), realpathSync(full))) return null
    } catch {
      return null
    }
  }
  return full
}

// Everything the panel shows, read-only. `projectDir` is the registry entry's directory; `projectRoot` the journal
// root of the project.
export function readBacklog({ projectDir, projectRoot, openTasks = [] }) {
  const empty = (reason) => ({ configured: false, reason, groups: [], total: 0, threshold: CLEANUP_THRESHOLD })
  if (!projectDir || !projectRoot) return empty('Проект не подключён к набору: бэклог мелочей настраивается в реестре проекта.')
  let project
  try {
    project = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8'))
  } catch (error) {
    return empty(`project.json не читается: ${error.message}`)
  }
  if (!project.review_backlog) return empty('В реестре проекта не задан путь к бэклогу мелочей (review_backlog в project.json).')
  const file = projectFile(projectRoot, project.review_backlog)
  if (!file) return empty('review_backlog должен быть путём внутри проекта.')
  let features = []
  const featuresFile = join(projectDir, 'features.json')
  if (existsSync(featuresFile)) {
    try {
      features = JSON.parse(readFileSync(featuresFile, 'utf8')).features
    } catch (error) {
      return empty(`features.json не читается: ${error.message}`)
    }
    const problems = validateFeatures(features)
    if (problems.length) return empty(problems.join('; '))
    // A pattern that still cannot be read is named, never a crash of the page.
    for (const feature of features) {
      for (const pattern of feature.paths) {
        try {
          patternToRegex(pattern)
        } catch (error) {
          return empty(`features.json: шаблон «${pattern}» у фичи «${feature.name}» не читается: ${error.message}`)
        }
      }
    }
  }
  if (!existsSync(file)) return { ...empty('Файла бэклога ещё нет — мелочей не записано.'), configured: true, file: project.review_backlog, expect: 'none' }
  if (!lstatSync(file).isFile()) return empty('Бэклог мелочей должен быть обычным файлом.')
  const bytes = readFileSync(file)
  const records = parseBacklog(bytes.toString('utf8'))
  const open = new Map(openTasks.filter((task) => task.title?.startsWith(CLEANUP_TITLE_PREFIX)).map((task) => [cleanupFeature(task.title), task]))
  const groups = groupByFeature(records, features || []).map((group) => {
    const task = open.get(group.feature)
    return { ...group, count: group.records.length, cleanup: task ? { id: task.id, status: task.status } : null }
  })
  return {
    configured: true,
    file: project.review_backlog,
    total: records.length,
    threshold: CLEANUP_THRESHOLD,
    features: (features || []).map((feature) => feature.name),
    groups,
    expect: createHash('sha256').update(bytes).digest('hex')
  }
}

// "1 запись", "3 записи", "5 записей", "11 записей", "21 запись".
export function recordsWord(n) {
  const tens = n % 100
  const ones = n % 10
  if (tens >= 11 && tens <= 14) return 'записей'
  if (ones === 1) return 'запись'
  if (ones >= 2 && ones <= 4) return 'записи'
  return 'записей'
}

// "Уборка мелочей: Экспорт (4)" → "Экспорт".
export function cleanupFeature(title) {
  return title.slice(CLEANUP_TITLE_PREFIX.length).replace(/\s*\(\d+\)\s*$/, '').trim()
}

// The role a cleanup of a group needs is the project's to say — `role` of the feature in features.json — never
// guessed from paths here: this module knows no project's layout. No role named: anyone who writes code.
export const DEFAULT_CLEANUP_ROLE = 'software_engineer'
export function suggestedRole(group) {
  return typeof group?.role === 'string' && group.role ? group.role : DEFAULT_CLEANUP_ROLE
}

export function cleanupTask(group, file) {
  return {
    title: `${CLEANUP_TITLE_PREFIX}${group.feature} (${group.count})`,
    description: [
      `Бэклог мелочей: ${file}. Группа «${group.feature}» — ${group.count} ${recordsWord(group.count)}.`,
      'Исправить все записи одним заходом, убрать их из файла бэклога в том же заходе, один круг ревью на весь пакет.',
      'Создано панелью владельца.',
      '',
      ...group.records.map((record) => `- [${record.tag}] ${record.path}${record.file_line ? `:${record.file_line}` : ''} — ${record.text}`)
    ].join('\n'),
    action: 'edit the files named in the backlog records and remove the fixed records from the backlog file',
    files: [...new Set(group.records.map((record) => record.path))]
  }
}
