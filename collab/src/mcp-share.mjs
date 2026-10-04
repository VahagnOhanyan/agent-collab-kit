// What it takes to add an MCP server one vendor has to another vendor, and the command that does it in each vendor's
// own form. The panel shows these commands to copy into a terminal; nothing here runs them or writes any settings.
//
// A description never carries a secret: values of env and headers are not read at all (only their names, with
// PLACEHOLDER where the value goes), a URL loses its query, fragment and login, and an argument that may hold a secret
// becomes PLACEHOLDER — when in doubt it is replaced: a wrong placeholder costs the person one edit, a leaked token
// cannot be taken back. The program is shown as it is (owner's decision 04.10.2026).

export const PLACEHOLDER = 'ВАШ_КЛЮЧ'

// collab is registered by the installer, with an agent id of its own for every vendor: a copied entry would be wrong.
const NOT_SHARED = new Set(['collab'])
// Never starting with '-': a name like `--help` would be read as an option by every vendor's CLI.
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const SECRET_WORD = /(token|key|secret|passw|pwd|auth|bearer|basic|credential|cookie|session|signature|private)/i
const SECRET_PREFIX = /^(sk-|sk_|pk_|rk_|ghp_|gho_|ghs_|github_pat_|xox[abpr]-|glpat-|AKIA|ASIA|AIza|ya29\.)/
const JWT = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./
// Flags whose value is a header or a key, whatever its own name says.
const VALUE_FLAG = /^(-H|--header|--headers|-e|--env)$/i
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
// Header names as vendors write them, underscores included (context7's is CONTEXT7_API_KEY).
const HEADER_NAME = /^[A-Za-z0-9_-]{1,64}$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

function cleanUrl(value) {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return null
    return `${url.origin}${url.pathname === '/' ? '' : url.pathname}`
  } catch {
    return null
  }
}

function looksRandom(value) {
  return value.length >= 24 && /^[A-Za-z0-9_\-+/=.]+$/.test(value) && /[0-9]/.test(value) && /[A-Za-z]/.test(value)
}

// One argument that is not a flag: kept only when nothing about it suggests a secret.
function cleanArg(arg) {
  if (/^https?:\/\//i.test(arg)) return cleanUrl(arg) ?? PLACEHOLDER
  if (/^[[{]/.test(arg.trim())) return PLACEHOLDER // JSON or similar: structured values hold keys
  if (JWT.test(arg) || SECRET_PREFIX.test(arg) || looksRandom(arg) || SECRET_WORD.test(arg)) return PLACEHOLDER
  return arg
}

// Arguments as they may be shown: each one kept, cut down (a URL) or replaced.
export function cleanArgs(args) {
  const out = []
  let secretNext = false
  for (const raw of args) {
    const arg = String(raw)
    if (secretNext) {
      out.push(PLACEHOLDER)
      secretNext = false
      continue
    }
    const flag = /^(-{1,2}[A-Za-z0-9_.-]+)=(.*)$/s.exec(arg)
    if (flag) {
      out.push(SECRET_WORD.test(flag[1]) || VALUE_FLAG.test(flag[1]) ? `${flag[1]}=${PLACEHOLDER}` : `${flag[1]}=${cleanArg(flag[2])}`)
      continue
    }
    if (/^-{1,2}[A-Za-z0-9_.-]+$/.test(arg)) {
      out.push(arg)
      secretNext = SECRET_WORD.test(arg) || VALUE_FLAG.test(arg)
      continue
    }
    const pair = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(arg)
    if (pair) {
      out.push(SECRET_WORD.test(pair[1]) ? `${pair[1]}=${PLACEHOLDER}` : `${pair[1]}=${cleanArg(pair[2])}`)
      continue
    }
    out.push(cleanArg(arg))
  }
  return out
}

const names = (table, valid) => (table && typeof table === 'object' && !Array.isArray(table) ? Object.keys(table).filter((k) => valid.test(k)) : [])

// From a JSON settings entry (Claude, Cursor, Gemini and the vendors described by data). Nothing is offered for an
// entry with a control character anywhere in what would be shown: pasted into a terminal it could rewrite the line.
export function sharedSpec(name, spec) {
  if (!NAME.test(name) || NOT_SHARED.has(name) || !spec || typeof spec !== 'object') return null
  const address = typeof spec.url === 'string' ? spec.url : typeof spec.serverUrl === 'string' ? spec.serverUrl : null
  let share
  if (address !== null) {
    const url = cleanUrl(address)
    if (!url) return null
    share = { name, transport: 'http', url, headers: names(spec.headers, HEADER_NAME) }
  } else {
    if (typeof spec.command !== 'string' || !spec.command) return null
    // A server built into another vendor's application (a program inside `*.app/Contents/`, e.g. Codex's node_repl
    // and computer-use) runs on that application's paths, environment and permissions: a copy elsewhere would not
    // start. Nor would one that needs a working directory, which none of the commands carries.
    if (/\.app\/Contents\//.test(spec.command) || spec.cwd !== undefined) return null
    const args = Array.isArray(spec.args) ? spec.args : []
    if (!args.every((a) => typeof a === 'string')) return null
    share = { name, transport: 'stdio', command: spec.command, args: cleanArgs(args), env: names(spec.env, ENV_NAME) }
  }
  const shown = [share.url, share.command, ...(share.args || [])].filter((v) => typeof v === 'string')
  return shown.some((v) => CONTROL.test(v)) ? null : share
}

// From one `[<table>.<name>]` TOML table of Codex or a TOML vendor: its own lines, and the lines of its nested
// `.env` / `.http_headers` / `.env_http_headers` tables prefixed with that section (`env.KEY = …`). Only simple
// one-line values are read; a server written otherwise gives no description rather than a wrong command.
export function sharedSpecFromToml(name, lines) {
  const own = lines.filter((line) => !/^(env|http_headers|env_http_headers)\.\S/.test(line))
  const field = (key) => own.map((line) => new RegExp(`^${key}\\s*=\\s*(.+)$`).exec(line)).find(Boolean)?.[1]
  const string = (value) => {
    const v = value?.trim()
    if (!v) return null
    if (/^"([^"\\]*)"$/.test(v) || /^'([^']*)'$/.test(v)) return v.slice(1, -1)
    return null
  }
  const list = (value) => {
    if (!value) return []
    const m = /^\[(.*)\]$/.exec(value.trim())
    if (!m) return null
    if (!m[1].trim()) return []
    const items = m[1].match(/"([^"\\]*)"|'([^']*)'/g)
    if (!items) return null
    return items.map((item) => item.slice(1, -1))
  }
  const inlineKeys = (value) => {
    const m = value && /^\{(.*)\}$/.exec(value.trim())
    return m ? [...m[1].matchAll(/(?:^|,)\s*["']?([A-Za-z0-9_-]+)["']?\s*=/g)].map((k) => k[1]) : []
  }
  const sectionKeys = (section) => lines.map((line) => new RegExp(`^${section}\\.["']?([A-Za-z0-9_-]+)["']?\\s*=`).exec(line)?.[1]).filter(Boolean)
  const url = string(field('url'))
  if (url) {
    const headers = [...inlineKeys(field('http_headers')), ...sectionKeys('http_headers'), ...inlineKeys(field('env_http_headers')), ...sectionKeys('env_http_headers')]
    if (string(field('bearer_token_env_var'))) headers.push('Authorization')
    return sharedSpec(name, { url, headers: Object.fromEntries(headers.map((h) => [h, ''])) })
  }
  const command = string(field('command'))
  const args = list(field('args'))
  if (!command || args === null) return null
  if (field('cwd') !== undefined) return null // a working directory none of the commands carries
  const env = [...inlineKeys(field('env')), ...sectionKeys('env')]
  return sharedSpec(name, { command, args, env: Object.fromEntries(env.map((k) => [k, ''])) })
}

// POSIX shell quoting: plain words as they are, everything else in single quotes.
export function shellWord(value) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${String(value).replace(/'/g, `'\\''`)}'`
}

const line = (parts) => parts.map(shellWord).join(' ')
const headerArg = (header) => `${header}: ${PLACEHOLDER}`
const tomlString = (value) => JSON.stringify(value)

// Cursor has no command of its own that adds a server: a node one-liner merges the entry into ~/.cursor/mcp.json,
// keeps everything else, and refuses when a server of that name is already there.
function cursorCommand(name, entry) {
  const script = [
    "const fs=require('fs'),p=require('path'),os=require('os');",
    "const f=p.join(os.homedir(),'.cursor','mcp.json');",
    "const d=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):{};",
    'd.mcpServers=d.mcpServers||{};',
    `const n=${JSON.stringify(name)};`,
    "if(d.mcpServers[n]){console.error('уже есть: '+n);process.exit(1)}",
    `d.mcpServers[n]=${JSON.stringify(entry)};`,
    "fs.mkdirSync(p.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(d,null,2)+'\\n');console.log('добавлено в '+f)"
  ].join('')
  return `node -e ${shellWord(script)}`
}

// Codex CLI sets no HTTP headers: the table goes into ~/.codex/config.toml with them, by a here-document.
function codexTomlCommand(name, url, headers) {
  const body = [
    `[mcp_servers.${name}]`,
    `url = ${tomlString(url)}`,
    `http_headers = { ${headers.map((h) => `${tomlString(h)} = ${tomlString(PLACEHOLDER)}`).join(', ')} }`
  ].join('\n')
  return `mkdir -p ~/.codex && cat >> ~/.codex/config.toml <<'EOF'\n\n${body}\nEOF`
}

// One command per vendor, in that vendor's own form, all of them for a terminal.
export function mcpAddCommands(share) {
  if (!share) return null
  const { name } = share
  if (share.transport === 'http') {
    const headers = share.headers || []
    return {
      // Claude's --header and -e take several values: after the name and the URL, as its own help shows, never before.
      claude: line(['claude', 'mcp', 'add', '--scope', 'user', '--transport', 'http', name, share.url, ...headers.flatMap((h) => ['--header', headerArg(h)])]),
      codex: headers.length ? codexTomlCommand(name, share.url, headers) : line(['codex', 'mcp', 'add', name, '--url', share.url]),
      // agy: every flag before the name.
      gemini: line(['agy', 'mcp', 'add', ...headers.flatMap((h) => ['--header', headerArg(h)]), name, share.url]),
      cursor: cursorCommand(name, { url: share.url, ...(headers.length ? { headers: Object.fromEntries(headers.map((h) => [h, PLACEHOLDER])) } : {}) })
    }
  }
  const env = share.env || []
  const program = [share.command, ...share.args]
  return {
    claude: line(['claude', 'mcp', 'add', '--scope', 'user', name, ...env.flatMap((k) => ['-e', `${k}=${PLACEHOLDER}`]), '--', ...program]),
    codex: line(['codex', 'mcp', 'add', name, ...env.flatMap((k) => ['--env', `${k}=${PLACEHOLDER}`]), '--', ...program]),
    // agy: every flag before the name, `--` before a command whose arguments may begin with '-'.
    gemini: line(['agy', 'mcp', 'add', ...env.flatMap((k) => ['--env', `${k}=${PLACEHOLDER}`]), name, '--', ...program]),
    cursor: cursorCommand(name, { command: share.command, args: share.args, ...(env.length ? { env: Object.fromEntries(env.map((k) => [k, PLACEHOLDER])) } : {}) })
  }
}
