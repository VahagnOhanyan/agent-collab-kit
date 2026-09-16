// Shared fixtures. Every test builds its own world in a temp directory:
// its own project root, its own journal, its own config dir, its own registry.
// Nothing here reads a real project's configuration or journal, and child
// processes never inherit the caller's COLLAB_* variables — a test run started
// from inside a real project must not end up writing that project's journal.

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createApi } from '../src/api.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const CLI = join(HERE, '..', 'src', 'cli.mjs')
export const SERVER = join(HERE, '..', 'src', 'mcp', 'server.mjs')
export const LAUNCHER = join(HERE, '..', '..', 'bin', 'collab')
export const KIT_REGISTRY = join(HERE, '..', '..', 'projects')

export const tempDir = (prefix = 'collab-') => realpathSync(mkdtempSync(join(tmpdir(), prefix)))

// os.homedir() reads $HOME on POSIX but %USERPROFILE% on Windows — a test
// that spawns a child process and sets only HOME to fake its home directory
// silently stops overriding anything there, and the child ends up resolving
// the machine's real home instead of the fixture. Use this wherever a test
// needs a child process to believe `home` is its home directory.
export const homeEnv = (home) => (process.platform === 'win32' ? { USERPROFILE: home } : { HOME: home })

export function cleanEnv(extra = {}) {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('COLLAB_')) env[key] = value
  return { ...env, ...extra }
}

// Trusted inputs (configDir, registryDir, projectRoot) are FUNCTION PARAMETERS,
// never environment variables — the environment of a server can be written by
// a repository's .mcp.json. A child process gets them through a throwaway
// launcher script that calls main() with the options, written to a temp dir
// and removed afterwards, so no such entry point ships with the package.
function writeLauncher(kind, options) {
  const dir = mkdtempSync(join(tmpdir(), 'collab-launch-'))
  const file = join(dir, `${kind}.mjs`)
  const target = pathToFileURL(kind === 'cli' ? CLI : SERVER).href
  const call = kind === 'cli' ? `main(process.argv.slice(2), ${JSON.stringify(options)})` : `main(${JSON.stringify(options)})`
  writeFileSync(file, `import { main } from ${JSON.stringify(target)}\nawait ${call}\n`)
  return { file, remove: () => rmSync(dir, { recursive: true, force: true }) }
}

export function runCli(args, { cwd, env = {}, launcher = false, options = null } = {}) {
  const custom = options ? writeLauncher('cli', options) : null
  try {
    return spawnSync(process.execPath, [custom ? custom.file : launcher ? LAUNCHER : CLI, ...args], {
      cwd,
      encoding: 'utf8',
      env: cleanEnv({ COLLAB_AGENT_ID: '', ...env })
    })
  } finally {
    custom?.remove()
  }
}

// A tiny MCP stdio client: writes lines, resolves each response by id.
export function startServer({ agentId = 'claude', cwd, env = {}, options = null }) {
  const custom = options ? writeLauncher('server', options) : null
  const child = spawn(process.execPath, [custom ? custom.file : SERVER], {
    cwd,
    env: cleanEnv({ COLLAB_AGENT_ID: agentId, ...env }),
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const pending = new Map()
  const unsolicited = []
  let carry = ''
  let stderr = ''

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    carry += chunk
    let index = carry.indexOf('\n')
    while (index !== -1) {
      const line = carry.slice(0, index)
      carry = carry.slice(index + 1)
      if (line.trim()) {
        const message = JSON.parse(line)
        const resolve = pending.get(message.id)
        if (resolve) {
          pending.delete(message.id)
          resolve(message)
        } else {
          unsolicited.push(message)
        }
      }
      index = carry.indexOf('\n')
    }
  })
  child.stderr.on('data', (d) => {
    stderr += d
  })
  child.on('exit', () => custom?.remove())

  return {
    child,
    stderr: () => stderr,
    unsolicited,
    request(id, method, params) {
      const answered = new Promise((resolve) => pending.set(id, resolve))
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      return answered
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
    },
    raw(text) {
      child.stdin.write(text)
    },
    // Wait for the child to actually exit before the caller removes the state
    // directory: the server writes on its way out, and rmSync racing that
    // produces an ENOTEMPTY that has nothing to do with what is under test.
    stop() {
      return new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve()
        child.on('exit', resolve)
        child.stdin.end()
        child.kill()
      })
    }
  }
}

export const toolPayload = (response) => JSON.parse(response.result.content[0].text)

// git with no user or system config, so a signing hook or template on the
// machine cannot change what a test sees.
export function git(cwd, args) {
  return execFileSync(
    'git',
    ['-c', 'user.name=collab-test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
    }
  ).trim()
}

export function gitRepo(dir, { commit = true } = {}) {
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q'])
  if (commit) git(dir, ['commit', '-q', '--allow-empty', '-m', 'init'])
  return dir
}

export const writeJson = (file, value) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

// A roster with the shape the protocol tests rely on: codex is the only
// code_reviewer, only claude can run the application, security_reviewer is
// unheld, and ios_engineer is a role codex does not hold.
export const FIXTURE_AGENTS = {
  defaults: { lease_seconds: 3600, heartbeat_stale_seconds: 900 },
  agents: [
    {
      id: 'claude',
      name: 'Claude Code',
      provider: 'anthropic',
      roles: ['architect', 'ios_engineer', 'backend_engineer', 'product_engineer'],
      capabilities: ['read_code', 'modify_code', 'run_tests', 'run_gates', 'review_code', 'inspect_git', 'run_application', 'use_mcp_tool', 'research', 'record_decision'],
      briefing_file: 'briefings/claude.md',
      briefing: 'You are the lead session in this fixture. Ask for an independent review by role, never by name.'
    },
    {
      id: 'codex',
      name: 'Codex CLI',
      provider: 'openai',
      roles: ['software_engineer', 'code_reviewer', 'test_engineer'],
      capabilities: ['read_code', 'modify_code', 'run_tests', 'run_gates', 'review_code', 'inspect_git', 'use_mcp_tool', 'research'],
      briefing_file: 'briefings/codex.md',
      briefing: 'You are the independent engineer in this fixture. A review that finds nothing says what it checked.'
    }
  ]
}

export const FIXTURE_ROLES = {
  roles: {
    architect: { summary: 'Owns shape.', requires: ['read_code', 'inspect_git', 'record_decision'] },
    ios_engineer: { summary: 'Implements in the client.', requires: ['read_code', 'modify_code', 'run_tests'] },
    backend_engineer: { summary: 'Implements in the backend.', requires: ['read_code', 'modify_code', 'run_tests'] },
    product_engineer: { summary: 'Product behaviour.', requires: ['read_code', 'modify_code'] },
    software_engineer: { summary: 'General implementation.', requires: ['read_code', 'modify_code', 'run_tests'] },
    code_reviewer: { summary: 'Independent review.', requires: ['read_code', 'review_code', 'inspect_git'] },
    test_engineer: { summary: 'Test analysis.', requires: ['read_code', 'run_tests', 'review_code'] },
    security_reviewer: { summary: 'Security review.', requires: ['read_code', 'review_code'] }
  }
}

export function fixtureRunners() {
  return {
    runners: {
      'tap-check': {
        summary: 'Prints a TAP summary from a script in the working tree.',
        cwd: '.',
        command: [process.execPath, 'scripts/tap.mjs'],
        timeout_seconds: 60,
        parse: 'tap'
      },
      'backend-tests': {
        summary: 'Named test files.',
        cwd: 'backend',
        command: [process.execPath, '--test'],
        args: {
          kind: 'paths',
          min: 1,
          max: 20,
          must_be_under: 'backend/test',
          must_exist: true,
          must_match: '\\.test\\.js$',
          strip_prefix: 'backend/'
        },
        timeout_seconds: 60,
        parse: 'tap'
      }
    }
  }
}

// A config dir with agents, roles and runners; capabilities and policy fall
// back to the built-in files (whole-file rule).
export function writeFixtureConfig(dir, { runners = fixtureRunners() } = {}) {
  writeJson(join(dir, 'agents.json'), FIXTURE_AGENTS)
  writeJson(join(dir, 'roles.json'), FIXTURE_ROLES)
  writeJson(join(dir, 'runners.json'), runners)
  mkdirSync(join(dir, 'briefings'), { recursive: true })
  writeFileSync(join(dir, 'briefings', 'claude.md'), '# claude fixture brief\n\nClaim before you do.\n')
  writeFileSync(join(dir, 'briefings', 'codex.md'), '# codex fixture brief\n\nAnswer a review with submit_review.\n')
  return dir
}

export const TAP_SCRIPT = [
  "process.stdout.write('TAP version 13\\nok 1 - fixture\\n1..1\\n')",
  "process.stdout.write('# tests 1\\n# pass 1\\n# fail 0\\n# skipped 0\\n# todo 0\\n')"
].join('\n')

// A project (not a git repository unless asked), an initialised journal unless
// asked otherwise, and a fixture config dir outside the project.
export function sandbox({ git: withGit = false, init = true } = {}) {
  const base = tempDir('collab-sbx-')
  const root = join(base, 'project')
  mkdirSync(root)
  if (withGit) gitRepo(root)
  const configDir = writeFixtureConfig(join(base, 'config'))
  const stateDir = join(root, '.collab')
  if (init) initialisedJournal(stateDir)
  mkdirSync(join(root, 'scripts'))
  writeFileSync(join(root, 'scripts', 'tap.mjs'), TAP_SCRIPT)
  mkdirSync(join(root, 'backend', 'test'), { recursive: true })
  return {
    base,
    root,
    configDir,
    stateDir,
    roots: { journalRoot: root, codeRoot: root, stateDir },
    // Passed to main()/createApi as parameters — never as environment variables.
    options: { projectRoot: root, configDir, registryDir: join(base, 'empty-registry') },
    cleanup: () => rmSync(base, { recursive: true, force: true })
  }
}

// A journal as `collab init` writes it: the full layout, then the marker.
export function initialisedJournal(stateDir) {
  for (const dir of ['tmp', 'locks', 'tasks', 'messages', 'reviews', 'decisions', 'approvals', 'runs', 'agents']) {
    mkdirSync(join(stateDir, dir), { recursive: true })
  }
  // Bound to the realpath of its root, exactly as `collab init` binds it.
  const journalRoot = realpathSync(dirname(stateDir))
  writeFileSync(join(stateDir, 'journal.json'), `${JSON.stringify({ collab_journal: 1, created_at: new Date().toISOString(), journal_root: journalRoot })}\n`)
  return stateDir
}

export function apis(sbx, { clock, configDir = sbx.configDir } = {}) {
  const make = (agentId) => createApi({ agentId, roots: sbx.roots, configDir, ...(clock ? { clock } : {}) })
  return { claude: make('claude'), codex: make('codex') }
}
