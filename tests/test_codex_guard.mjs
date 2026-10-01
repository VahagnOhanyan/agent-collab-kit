// Тесты hooks/codex-guard.mjs: модель и план до правки. Запуск — как у хоста, через bin/agent-collab-kit-hook.
// Вход — как у codex-cli 0.154: Bash → tool_input.command; apply_patch → tool_input.command — текст патча.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { modelProblem } from '../hooks/codex-guard.mjs';

const LAUNCHER = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agent-collab-kit-hook');

function run(event, home = join(tmpdir(), 'agent-collab-kit-no-such-home')) {
  const env = { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' };
  const proc = spawnSync(process.execPath, [LAUNCHER, 'codex-guard'], { input: JSON.stringify(event), env, encoding: 'utf8', timeout: 30_000 });
  return { code: proc.status, err: proc.stderr };
}
const bash = (command, cwd = tmpdir()) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd });

test('вызовы агента без модели блокируются', () => {
  for (const command of ["codex exec 'review this'", 'cd sub && codex exec hi </dev/null', 'FOO=1 codex e hi',
    "claude -p 'review this'", 'ls | claude --print x']) {
    const { code, err } = run(bash(command));
    assert.equal(code, 2, command);
    assert.match(err, /без явной модели/);
  }
});

test('явная модель и прочие команды проходят', () => {
  for (const command of ['codex exec -m gpt-5.6-luna hi', 'codex exec --model=gpt-5.6-sol hi', 'codex exec -p cheap hi',
    'claude -p x --model sonnet', 'claude --model=haiku -p x', 'claude --version', 'codex --version', 'ls -la',
    "echo 'codex exec hi'"]) {
    assert.equal(run(bash(command)).code, 0, command);
  }
});

test('Windows: .exe/.cmd, пути с обратным слешем и & разбираются так же', () => {
  const blocked = ['C:\\Tools\\codex.exe exec hi', 'codex.cmd exec hi', 'CODEX.EXE exec hi', '& "C:\\Program Files\\codex\\codex.exe" exec hi',
    'cd C:\\work & codex exec hi', 'C:\\Users\\me\\bin\\claude.exe -p "x y"'];
  for (const command of blocked) assert.ok(modelProblem(command, true), command);
  const passing = ['codex.cmd exec -m gpt-5.6-luna hi', '"C:\\Program Files\\codex\\codex.exe" exec --model=x hi', 'dir C:\\codex',
    'claude.exe --version', 'type codex.txt'];
  for (const command of passing) assert.equal(modelProblem(command, true), null, command);
});

test('непонятная команда (незакрытая кавычка) не роняет хук и не блокирует', () => {
  assert.equal(run(bash("echo 'unterminated")).code, 0);
});

function world() {
  const base = mkdtempSync(join(tmpdir(), 'codex-guard-'));
  const root = join(base, 'project');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'plans'));
  const registry = join(base, 'registry');
  const writeProject = (gate) => {
    mkdirSync(join(registry, 'demo'), { recursive: true });
    const project = { id: 'demo', roots: [root] };
    if (gate) project.plan_gate = gate;
    writeFileSync(join(registry, 'demo', 'project.json'), JSON.stringify(project));
  };
  writeProject({ plans_dir: 'plans', paths: ['src/'] });
  const home = join(base, 'home');
  const binDir = join(home, '.agent-collab-kit', 'current', 'bin');
  mkdirSync(binDir, { recursive: true });
  const payload = join(binDir, 'collab.payload.json');
  writeFileSync(payload, JSON.stringify({ projectId: 'demo', registryDir: registry, codeRoot: root }));
  writeFileSync(join(binDir, 'collab'), `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(payload)}, 'utf8'))\n`);
  const plan = (name, text, ageSeconds = 0) => {
    const file = join(root, 'plans', name);
    writeFileSync(file, text);
    const stamp = (Date.now() - ageSeconds * 1000) / 1000;
    utimesSync(file, stamp, stamp);
    return file;
  };
  const patch = (target, transcript = null) => run({
    hook_event_name: 'PreToolUse', tool_name: 'apply_patch',
    tool_input: { command: `*** Begin Patch\n*** Add File: ${target}\n+x\n*** End Patch` }, cwd: root, transcript_path: transcript,
  }, home);
  return { base, root, home, writeProject, plan, patch, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test('правка кода требует план со строками «Маршрут:» и ux_impact', () => {
  const w = world();
  try {
    let r = w.patch(join(w.root, 'src', 'a.js'));
    assert.equal(r.code, 2);
    assert.match(r.err, /нет плана/);
    w.plan('p.md', '# p\nМаршрут: я\n');
    r = w.patch(join(w.root, 'src', 'a.js'));
    assert.equal(r.code, 2);
    assert.match(r.err, /ux_impact/);
    w.plan('p.md', '# p\nМаршрут: я\n- ux_impact: LOW\n');
    assert.equal(w.patch(join(w.root, 'src', 'a.js')).code, 0);
  } finally { w.cleanup(); }
});

test('относительный путь разрешается от cwd; выход из корня наружу не считается правкой кода', () => {
  const w = world();
  try {
    assert.equal(w.patch('src/a.js').code, 2);
    assert.equal(w.patch('src/../../outside.js').code, 0);
  } finally { w.cleanup(); }
});

test('не под plan_gate, сам план, проект без plan_gate и хост без collab — проходят', () => {
  const w = world();
  try {
    assert.equal(w.patch(join(w.root, 'docs.md')).code, 0);
    assert.equal(w.patch(join(w.root, 'plans', 'new.md')).code, 0);
    w.writeProject(null);
    assert.equal(w.patch(join(w.root, 'src', 'a.js')).code, 0);
    assert.equal(run({ tool_name: 'apply_patch', tool_input: { command: '*** Add File: /x\n' }, cwd: tmpdir() }).code, 0);
  } finally { w.cleanup(); }
});

test('план этой сессии из транскрипта важнее более свежего чужого', () => {
  const w = world();
  try {
    const mine = w.plan('mine.md', 'Маршрут: я\nux_impact: NONE\n', 100);
    w.plan('theirs.md', 'Маршрут: они\n', 0);
    const transcript = join(w.base, 'rollout.jsonl');
    writeFileSync(transcript, `${JSON.stringify({ patch: `*** Add File: ${mine}\n` })}\n`);
    assert.equal(w.patch(join(w.root, 'src', 'a.js'), transcript).code, 0);
    assert.equal(w.patch(join(w.root, 'src', 'a.js')).code, 2, 'без транскрипта решает самый свежий план');
  } finally { w.cleanup(); }
});

test('план внутри защищённого пути можно писать без плана, соседний код — нет', () => {
  const w = world();
  try {
    mkdirSync(join(w.root, 'src', 'plans'), { recursive: true });
    w.writeProject({ plans_dir: 'src/plans', paths: ['src/'] });
    assert.equal(w.patch(join(w.root, 'src', 'plans', 'new.md')).code, 0, 'сам план');
    assert.equal(w.patch(join(w.root, 'src', 'a.js')).code, 2, 'код рядом с планами');
  } finally { w.cleanup(); }
});
