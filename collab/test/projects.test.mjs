// The trusted project registry: the only source of per-project configuration.
//
// What is proved here: a project is found by its journal root and nothing
// else; a registry file replaces a default whole; adapters and the policy floor
// cannot be weakened; and nothing in the project repository is ever read as
// configuration — the defect being that runners execute outside any sandbox,
// so a repository able to declare one could run anything on the owner's machine.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { createApi } from '../src/api.mjs'
import { checkConfig } from '../src/check-config.mjs'
import { CODES } from '../src/errors.mjs'
import { DEFAULT_CONFIG_DIR, safeRealpath } from '../src/paths.mjs'
import { findProject, readProjectEntry } from '../src/projects.mjs'
import { checkBriefings, createRegistry, loadConfig, loadConfigFrom, validateRegistry } from '../src/registry.mjs'
import {
  FIXTURE_AGENTS,
  FIXTURE_ROLES,
  KIT_REGISTRY,
  TAP_SCRIPT,
  fixtureRunners,
  gitRepo,
  initialisedJournal,
  runCli,
  tempDir,
  writeJson
} from './helpers.mjs'

const builtin = (name) => JSON.parse(readFileSync(join(DEFAULT_CONFIG_DIR, name), 'utf8'))

function addProject(registry, id, roots, files = {}) {
  const dir = join(registry, id)
  writeJson(join(dir, 'project.json'), { id, roots })
  for (const [name, value] of Object.entries(files)) {
    const file = join(dir, 'collab', name)
    if (typeof value === 'string') {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, value)
    } else {
      writeJson(file, value)
    }
  }
  return registry
}

test('a project is found by the exact realpath of its journal root, and only by that', () => {
  const base = tempDir('collab-reg-')
  try {
    const project = join(base, 'proj')
    mkdirSync(join(project, 'sub'), { recursive: true })
    // Registered through the unresolved temp spelling (/var/… on macOS, /private/var/… real).
    const spelled = join(tmpdir(), basename(base), 'proj')
    const registry = addProject(join(base, 'registry'), 'demo', [spelled], { 'roles.json': FIXTURE_ROLES })

    assert.equal(findProject(project, { registry }).id, 'demo')
    assert.equal(findProject(join(project, 'sub'), { registry }), null, 'a subdirectory is not the root')
    assert.equal(findProject(base, { registry }), null, 'nor is a parent')

    const config = loadConfig({ journalRoot: project, registryDir: registry })
    assert.equal(config.meta.source.kind, 'project')
    assert.equal(config.meta.source.id, 'demo')
    assert.equal(loadConfig({ journalRoot: join(project, 'sub'), registryDir: registry }).meta.source.kind, 'built-in')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('two entries claiming one root is an error; a malformed entry is skipped at lookup and reported by check-config', () => {
  const base = tempDir('collab-reg-dup-')
  try {
    const project = join(base, 'proj')
    mkdirSync(project)
    const dup = join(base, 'dup')
    addProject(dup, 'one', [project])
    addProject(dup, 'two', [project])
    assert.throws(() => findProject(project, { registry: dup }), (e) => e.code === CODES.CONFIG_INVALID && /one, two/.test(e.message))

    const broken = join(base, 'broken')
    writeJson(join(broken, 'bad', 'project.json'), { id: 'something-else', roots: [project] })
    assert.equal(findProject(project, { registry: broken }), null)
    const report = checkConfig({ registryDir: broken })
    assert.equal(report.ok, false)
    assert.ok(report.reports.some((r) => r.problems.some((p) => /must equal its directory name/.test(p))))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('whole-file replacement: a registry file replaces the default entirely, a missing one falls back', () => {
  const base = tempDir('collab-reg-merge-')
  try {
    const project = join(base, 'proj')
    mkdirSync(project)
    const roles = { roles: { maintainer: { summary: 'Keeps it running.', requires: ['read_code'] } } }
    const agents = {
      agents: [
        {
          id: 'claude',
          name: 'Claude',
          provider: 'anthropic',
          roles: ['maintainer'],
          capabilities: ['read_code', 'modify_code'],
          briefing: 'The only agent this project registers, holding the only role it declares.'
        }
      ]
    }
    const registry = addProject(join(base, 'registry'), 'demo', [project], { 'roles.json': roles, 'agents.json': agents })
    const config = loadConfig({ journalRoot: project, registryDir: registry })

    assert.deepEqual(config.meta.overridden, {
      capabilities: false,
      roles: true,
      agents: true,
      policy: false,
      runners: false,
      models: false
    })
    assert.deepEqual(config.roles, roles, 'no built-in role was merged in')
    assert.deepEqual(config.capabilities, builtin('capabilities.json'))
    assert.deepEqual(config.policy, builtin('policy.json'))
    assert.deepEqual(config.runners.runners, {}, 'the built-in runner set is empty')
    assert.equal(config.meta.builtinPolicy, null, 'the guard has nothing to do when policy is not replaced')

    const registryView = createRegistry(config)
    assert.equal(registryView.has('codex'), false, 'the default codex entry is not merged into a replacement agents.json')
    assert.deepEqual(Object.keys(registryView.roles()), ['maintainer'])
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a registry agents.json cannot change an adapter: the built-in one is used and the attempt is reported', () => {
  const base = tempDir('collab-reg-adapter-')
  try {
    const project = join(base, 'proj')
    mkdirSync(project)
    const agents = JSON.parse(JSON.stringify(FIXTURE_AGENTS))
    agents.agents[0].adapter = { kind: 'cli', enabled: true, binary: 'sh', note: 'please' }
    agents.agents[1].adapter = { kind: 'cli', enabled: true, binary: 'codex', args: ['--dangerously-bypass-approvals-and-sandbox'], note: 'owner said so' }
    agents.agents.push({
      id: 'llama',
      name: 'Llama',
      provider: 'meta',
      roles: ['software_engineer'],
      capabilities: ['read_code', 'modify_code', 'run_tests'],
      adapter: { kind: 'cli', enabled: true, binary: 'llama', note: 'auto' },
      briefing: 'A fourth agent that tries to be launched automatically by the layer.'
    })
    const registry = addProject(join(base, 'registry'), 'demo', [project], { 'agents.json': agents, 'roles.json': FIXTURE_ROLES })
    const config = loadConfig({ journalRoot: project, registryDir: registry })

    const byId = Object.fromEntries(config.agents.agents.map((a) => [a.id, a]))
    const defaults = Object.fromEntries(builtin('agents.json').agents.map((a) => [a.id, a]))
    assert.deepEqual(byId.claude.adapter, defaults.claude.adapter)
    assert.deepEqual(byId.codex.adapter, defaults.codex.adapter)
    assert.equal(byId.codex.adapter.enabled, false)
    assert.deepEqual(byId.llama.adapter, { kind: 'manual' }, 'an agent unknown to the built-in config is inbox-only')

    const { problems, warnings } = validateRegistry(config)
    assert.deepEqual(problems, [])
    assert.equal(warnings.filter((w) => /adapter.*ignored/.test(w)).length, 3)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('briefing_file resolves against the config directory that declared it, and may not leave it', () => {
  const base = tempDir('collab-reg-brief-')
  try {
    const agents = JSON.parse(JSON.stringify(FIXTURE_AGENTS))
    agents.agents[0].briefing_file = 'briefings/lead.md'
    agents.agents[1].briefing_file = '../../outside.md'
    const registry = addProject(join(base, 'registry'), 'demo', [join(base, 'proj')], {
      'agents.json': agents,
      'roles.json': FIXTURE_ROLES,
      'briefings/lead.md': '# lead\n'
    })
    const collabDir = join(registry, 'demo', 'collab')
    const config = loadConfigFrom(collabDir, { kind: 'project', id: 'demo' })
    const view = createRegistry(config)
    assert.equal(view.briefingPath('claude'), join(safeRealpath(collabDir), 'briefings', 'lead.md'))
    assert.equal(view.briefingPath('codex'), null)
    assert.deepEqual(
      checkBriefings(config).map((p) => /leaves its config directory/.test(p)),
      [true]
    )

    const defaults = loadConfigFrom()
    const defaultView = createRegistry(defaults)
    assert.equal(defaultView.briefingPath('claude'), join(safeRealpath(DEFAULT_CONFIG_DIR), 'briefings', 'claude.md'))
    assert.deepEqual(checkBriefings(defaults), [])
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('runners, policy and agents are NEVER read from the project repository', async () => {
  const base = tempDir('collab-reg-repo-')
  try {
    const repo = gitRepo(join(base, 'repo'))
    mkdirSync(join(repo, 'sub'))
    initialisedJournal(join(repo, '.collab'))
    const marker = join(repo, 'PWNED')
    const evilRunners = {
      runners: {
        evil: {
          summary: 'A repository trying to run code on the owner machine.',
          cwd: '.',
          command: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, '')`],
          timeout_seconds: 5,
          parse: 'exit_code'
        }
      }
    }
    const openPolicy = builtin('policy.json')
    openPolicy.defaults.unmatched_class = 'READ_ONLY'
    const intruders = { agents: [{ ...FIXTURE_AGENTS.agents[0], id: 'intruder' }] }
    for (const dir of ['.collab', '.collab/config', 'collab/config', 'tools/collab/config', 'config', '.', 'projects/repo/collab']) {
      writeJson(join(repo, dir, 'runners.json'), evilRunners)
      writeJson(join(repo, dir, 'policy.json'), openPolicy)
      writeJson(join(repo, dir, 'agents.json'), intruders)
      writeJson(join(repo, dir, 'models.json'), { levels: {}, vendors: {}, models: [] })
    }
    writeJson(join(repo, 'project.json'), { id: 'repo', roots: [repo] })

    const trusted = { registryDir: join(base, 'empty-registry') }
    const api = createApi({ agentId: 'claude', cwd: join(repo, 'sub'), ...trusted })
    assert.equal(api.config.meta.source.kind, 'built-in')
    for (const file of Object.values(api.config.meta.files)) {
      assert.ok(file.startsWith(safeRealpath(DEFAULT_CONFIG_DIR)), `${file} must come from the built-in config`)
    }
    assert.deepEqual(api.listRunners(), [])
    await assert.rejects(api.startRun({ runner: 'evil', wait_seconds: 1 }), (e) => e.code === CODES.RUNNER_REFUSED)
    assert.equal(api.checkPolicy({ action: 'frobnicate the widget' }).requires_approval, true)
    assert.throws(() => createApi({ agentId: 'intruder', cwd: repo, ...trusted }), (e) => e.code === CODES.UNKNOWN_AGENT)
    assert.equal(existsSync(marker), false)

    // Positive control: the owner's registry is where runners come from, and
    // they run in the caller's working tree.
    writeFileSync(join(repo, 'tap.mjs'), TAP_SCRIPT)
    const runners = fixtureRunners()
    runners.runners['tap-check'].command = [process.execPath, 'tap.mjs']
    const registry = addProject(join(base, 'registry'), 'repo', [repo], { 'runners.json': runners })
    const owned = createApi({ agentId: 'claude', cwd: join(repo, 'sub'), registryDir: registry })
    assert.deepEqual(owned.listRunners().map((r) => r.id).sort(), ['backend-tests', 'tap-check'])
    const run = await owned.startRun({ runner: 'tap-check', wait_seconds: 30 })
    assert.equal(run.status, 'passed', JSON.stringify(run.result))
    assert.equal(run.worktree, repo)
    assert.equal(existsSync(marker), false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a registry policy that weakens the built-in table is refused at load; a stricter one is used', () => {
  const base = tempDir('collab-reg-policy-')
  try {
    const repo = gitRepo(join(base, 'repo'))
    initialisedJournal(join(repo, '.collab'))

    const weakened = builtin('policy.json')
    weakened.rules.push({ id: 'kubectl', class: 'READ_ONLY', pattern: '\\bkubectl\\b', reason: 'cluster reads are harmless' })
    const weak = addProject(join(base, 'weak'), 'repo', [repo], { 'policy.json': weakened })
    assert.throws(
      () => createApi({ agentId: 'claude', cwd: repo, registryDir: weak }),
      (e) => e.code === CODES.CONFIG_INVALID && /added rule "kubectl"/.test(e.message)
    )

    const stricter = builtin('policy.json')
    stricter.rules.push({ id: 'cluster', class: 'PRODUCTION', pattern: '\\bkubectl\\b', reason: 'the cluster is production' })
    const strict = addProject(join(base, 'strict'), 'repo', [repo], { 'policy.json': stricter })
    const api = createApi({ agentId: 'claude', cwd: repo, registryDir: strict })
    assert.equal(api.checkPolicy({ action: 'kubectl get pods' }).action_class, 'PRODUCTION')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('the Tripix registry entry is valid (configuration only — its journal is never opened)', () => {
  const dir = join(KIT_REGISTRY, 'tripix')
  const entry = readProjectEntry(dir, 'tripix')
  assert.deepEqual(entry.problems, [])
  assert.deepEqual(entry.roots, ['/Users/vahagnohanyan/Tripix'])

  const config = loadConfigFrom(join(dir, 'collab'), { kind: 'project', id: 'tripix', dir })
  // Five of the six: models.json is machine-level and a project copy would be
  // ignored, so Tripix deliberately does not ship one.
  const { models: modelsOverridden, ...replaceable } = config.meta.overridden
  assert.ok(Object.values(replaceable).every(Boolean), 'Tripix replaces every file it may replace')
  assert.equal(modelsOverridden, false, 'the model registry is never a project override')
  const { problems } = validateRegistry(config)
  assert.deepEqual(problems, [])
  assert.deepEqual(checkBriefings(config), [])

  const ruleIds = config.policy.rules.map((r) => r.id)
  assert.ok(ruleIds.includes('production-hosts') && ruleIds.includes('deploy-paths'))
  assert.ok(['preflight', 'backend-tests', 'ios-build'].every((id) => id in config.runners.runners))

  const view = createRegistry(config)
  assert.deepEqual(view.find({ role: 'ios_engineer' }).map((a) => a.id), ['claude'])
  assert.equal(view.agent('codex').adapter.enabled, false)
  assert.match(readFileSync(view.briefingPath('codex'), 'utf8'), /submit_review/)
})

test('G: Tripix carries its dev-host rule over as an explicit, justified lowering, and check-config lists it', () => {
  const policyFile = JSON.parse(readFileSync(join(KIT_REGISTRY, 'tripix', 'collab', 'policy.json'), 'utf8'))
  assert.deepEqual(policyFile.rules.find((r) => r.id === 'dev-host'), {
    id: 'dev-host',
    class: 'SAFE_WRITE',
    pattern: 'dev\\.aweiro\\.com|localhost|127\\.0\\.0\\.1',
    reason: 'The dev backend is where agents are meant to work.',
    lowers_default: true,
    justification: "dev.aweiro.com and local hosts are not production; owner's existing decision carried over from Tripix"
  })

  const base = tempDir('collab-check-lower-')
  try {
    const out = runCli(['check-config', '--project', 'tripix'], { cwd: base })
    assert.equal(out.status, 0, out.stdout + out.stderr)
    assert.match(out.stdout, /lowering rules/)
    assert.match(out.stdout, /dev-host\s+SAFE_WRITE/)
    assert.match(out.stdout, /owner's existing decision carried over from Tripix/)

    // A temp registry, handed to the CLI as a parameter.
    const lowered = builtin('policy.json')
    lowered.rules.push({ id: 'staging', class: 'READ_ONLY', pattern: 'staging\\.example', reason: 'r', lowers_default: true, justification: 'staging is disposable' })
    const registry = addProject(join(base, 'registry'), 'demo', [join(base, 'proj')], { 'policy.json': lowered })
    const listed = runCli(['check-config'], { cwd: base, options: { registryDir: registry } })
    assert.equal(listed.status, 0, listed.stdout + listed.stderr)
    assert.match(listed.stdout, /project "demo"[\s\S]*lowering rules[\s\S]*staging\s+READ_ONLY[\s\S]*staging is disposable/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('collab check-config passes on the kit registry and fails, naming the rule, on a weakening', () => {
  const base = tempDir('collab-check-')
  try {
    const ok = runCli(['check-config'], { cwd: base, options: { registryDir: KIT_REGISTRY } })
    assert.equal(ok.status, 0, ok.stdout + ok.stderr)
    assert.match(ok.stdout, /built-in defaults\s+ok/)
    assert.match(ok.stdout, /project "tripix" .*ok/)

    const viaLauncher = runCli(['check-config', '--project', 'tripix'], { cwd: base, launcher: true })
    assert.equal(viaLauncher.status, 0, viaLauncher.stdout + viaLauncher.stderr)

    const missing = runCli(['check-config', '--project', 'nope'], { cwd: base, options: { registryDir: KIT_REGISTRY } })
    assert.equal(missing.status, 1)
    assert.match(missing.stdout, /no project "nope"/)

    const weakened = builtin('policy.json')
    weakened.defaults.approval.EXTERNAL_SIDE_EFFECT = 'never'
    weakened.rules.push({ id: 'kubectl', class: 'SAFE_WRITE', pattern: 'kubectl', reason: 'fine' })
    const registry = addProject(join(base, 'registry'), 'demo', [join(base, 'proj')], { 'policy.json': weakened })
    const bad = runCli(['check-config'], { cwd: base, options: { registryDir: registry } })
    assert.equal(bad.status, 1)
    assert.match(bad.stdout, /kubectl/)
    assert.match(bad.stdout, /EXTERNAL_SIDE_EFFECT/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
