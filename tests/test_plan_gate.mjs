// Тесты hooks/plan-gate.mjs — план до правки для ведущей сессии Claude Code. Запуск — как у хоста,
// через bin/agent-kit-hook; вход — событие Claude: Edit/Write/MultiEdit → tool_input.file_path,
// NotebookEdit → tool_input.notebook_path.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const LAUNCHER = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agent-kit-hook');

function run(stdin, home = join(tmpdir(), 'agent-kit-no-such-home')) {
  const env = { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' };
  const input = typeof stdin === 'string' ? stdin : JSON.stringify(stdin);
  const proc = spawnSync(process.execPath, [LAUNCHER, 'plan-gate'], { input, env, encoding: 'utf8', timeout: 30_000 });
  return { code: proc.status, err: proc.stderr };
}

function world() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'plan-gate-')));
  const root = join(base, 'project');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, '.claude', 'plans'), { recursive: true });
  const registry = join(base, 'registry');
  const writeProject = (gate) => {
    mkdirSync(join(registry, 'demo'), { recursive: true });
    const project = { id: 'demo', roots: [root] };
    if (gate) project.plan_gate = gate;
    writeFileSync(join(registry, 'demo', 'project.json'), JSON.stringify(project));
  };
  writeProject({ plans_dir: '.claude/plans', paths: ['src/', 'web/src/'] });
  const home = join(base, 'home');
  const binDir = join(home, '.agent-kit', 'current', 'bin');
  mkdirSync(binDir, { recursive: true });
  const payload = join(binDir, 'collab.payload.json');
  writeFileSync(payload, JSON.stringify({ projectId: 'demo', registryDir: registry, codeRoot: root }));
  writeFileSync(join(binDir, 'collab'), `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(payload)}, 'utf8'))\n`);
  const plan = (name, text, ageSeconds = 0) => {
    const file = join(root, '.claude', 'plans', name);
    writeFileSync(file, text);
    const stamp = (Date.now() - ageSeconds * 1000) / 1000;
    utimesSync(file, stamp, stamp);
    return file;
  };
  const edit = (target, { tool = 'Edit', transcript = null } = {}) => run({
    hook_event_name: 'PreToolUse', tool_name: tool,
    tool_input: tool === 'NotebookEdit' ? { notebook_path: target } : { file_path: target },
    cwd: root, transcript_path: transcript,
  }, home);
  return { base, root, writeProject, plan, edit, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function scenario(name, body) {
  test(name, () => {
    const w = world();
    try { body(w); } finally { w.cleanup(); }
  });
}

const GOOD = '# p\nМаршрут: всё сам\n\nux_impact: NONE\n';

scenario('правка кода без плана и без нужных строк — блок, с полным планом — проход', (w) => {
  const target = join(w.root, 'src', 'a.js');
  let r = w.edit(target);
  assert.equal(r.code, 2);
  assert.match(r.err, /^plan-gate: .*нет плана/);
  w.plan('p.md', '# p\nux_impact: LOW\n');
  r = w.edit(target);
  assert.equal(r.code, 2);
  assert.match(r.err, /«Маршрут:»/);
  w.plan('p.md', '# p\nМаршрут: я\n');
  r = w.edit(target);
  assert.equal(r.code, 2);
  assert.match(r.err, /ux_impact/);
  w.plan('p.md', GOOD);
  assert.equal(w.edit(target).code, 0);
});

scenario('все инструменты записи Claude проверяются', (w) => {
  for (const tool of ['Edit', 'Write', 'MultiEdit']) assert.equal(w.edit(join(w.root, 'src', 'a.js'), { tool }).code, 2, tool);
  assert.equal(w.edit(join(w.root, 'src', 'a.ipynb'), { tool: 'NotebookEdit' }).code, 2);
  assert.equal(w.edit(join(w.root, 'web', 'src', 'b.ts')).code, 2, 'второй путь из paths');
});

scenario('вне paths, сам каталог планов, граница компонента — проходят', (w) => {
  assert.equal(w.edit(join(w.root, 'README.md')).code, 0);
  assert.equal(w.edit(join(w.root, 'srcx', 'a.js')).code, 0, 'src/ не пускает srcx/');
  assert.equal(w.edit(join(w.root, '.claude', 'plans', 'new.md')).code, 0, 'первый план пишется без плана');
  assert.equal(w.edit(join(w.base, 'elsewhere', 'a.js')).code, 0, 'вне корня кода');
});

scenario('проект без plan_gate проходит', (w) => {
  w.writeProject(null);
  assert.equal(w.edit(join(w.root, 'src', 'a.js')).code, 0);
});

scenario('план этой сессии из транскрипта важнее более свежего чужого', (w) => {
  const mine = w.plan('mine.md', GOOD, 100);
  w.plan('theirs.md', '# чужой, без строк\n', 0);
  const transcript = join(w.base, 'session.jsonl');
  // Claude пишет путь в JSON: в Windows-пути обратный слеш удвоен, здесь — обычный путь.
  writeFileSync(transcript, `${JSON.stringify({ type: 'tool_use', name: 'Write', input: { file_path: mine } })}\n`);
  assert.equal(w.edit(join(w.root, 'src', 'a.js'), { transcript }).code, 0);
  assert.equal(w.edit(join(w.root, 'src', 'a.js')).code, 2, 'без транскрипта решает самый свежий план');
});

test('нештатный вход и хост без collab — проход, хук не падает', () => {
  for (const stdin of ['not json', '', 'null', '[]', '{"tool_name":"Edit"}', '{"tool_input":{"file_path":42}}']) {
    const r = run(stdin);
    assert.equal(r.code, 0, stdin);
    assert.equal(r.err, '', stdin);
  }
  assert.equal(run({ tool_name: 'Edit', tool_input: { file_path: '/x/src/a.js' }, cwd: tmpdir() }).code, 0);
});
