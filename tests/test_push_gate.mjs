// Тесты hooks/push-gate.mjs — push только через зелёный гейт проекта и без обходов. Запуск — как у хоста,
// через bin/agent-kit-hook; вход — событие Claude: Bash → tool_input.command. Гейт в тестах — .mjs-скрипт
// (одинаково запускается на macOS и Windows); он пишет метку в файл, чтобы видеть, что его вызывали.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const LAUNCHER = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agent-kit-hook');

function run(stdin, home = join(tmpdir(), 'agent-kit-no-such-home'), extraEnv = {}) {
  const env = { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', ...extraEnv };
  const input = typeof stdin === 'string' ? stdin : JSON.stringify(stdin);
  const proc = spawnSync(process.execPath, [LAUNCHER, 'push-gate'], { input, env, encoding: 'utf8', timeout: 30_000 });
  return { code: proc.status, err: proc.stderr };
}

function world({ gate = 'gate.mjs', gateExit = 0 } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'push-gate-')));
  const root = join(base, 'project');
  mkdirSync(root, { recursive: true });
  const ran = join(base, 'gate-ran');
  writeFileSync(
    join(root, 'gate.mjs'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(ran)}, process.argv.slice(2).join(' '));\n` +
      `console.error('красная строка из гейта');\nprocess.exit(${gateExit});\n`
  );
  const registry = join(base, 'registry');
  const writeProject = (gateValue) => {
    mkdirSync(join(registry, 'demo'), { recursive: true });
    const project = { id: 'demo', roots: [root] };
    if (gateValue) project.gate = gateValue;
    writeFileSync(join(registry, 'demo', 'project.json'), JSON.stringify(project));
  };
  writeProject(gate);
  const home = join(base, 'home');
  const binDir = join(home, '.agent-kit', 'current', 'bin');
  mkdirSync(binDir, { recursive: true });
  const payload = join(binDir, 'collab.payload.json');
  writeFileSync(payload, JSON.stringify({ projectId: 'demo', registryDir: registry, codeRoot: root }));
  writeFileSync(join(binDir, 'collab'), `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(payload)}, 'utf8'))\n`);
  const bash = (command, extraEnv) => run({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: root }, home, extraEnv);
  return {
    root,
    writeProject,
    bash,
    gateRan: () => existsSync(ran),
    gateArgs: () => readFileSync(ran, 'utf8'),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

function scenario(name, opts, body) {
  test(name, () => {
    const w = world(opts);
    try {
      body(w);
    } finally {
      w.cleanup();
    }
  });
}

scenario('не push проходит и гейт не запускается', {}, (w) => {
  for (const command of ['git status', 'git pull --rebase', 'ls', 'git commit -m "push later"', 'echo pushing']) {
    assert.equal(w.bash(command).code, 0, command);
  }
  assert.equal(w.gateRan(), false);
});

scenario('push с зелёным гейтом проходит, гейт запущен с --quiet', {}, (w) => {
  assert.equal(w.bash('git push origin main').code, 0);
  assert.equal(w.gateRan(), true);
  assert.equal(w.gateArgs(), '--quiet');
});

scenario('красный гейт блокирует и показывает хвост вывода', { gateExit: 1 }, (w) => {
  const r = w.bash('git push');
  assert.equal(r.code, 2);
  assert.match(r.err, /^push-gate: гейт gate\.mjs красный/);
  assert.match(r.err, /красная строка из гейта/);
});

scenario('обходы блокируются до запуска гейта', {}, (w) => {
  const cases = [
    'git push --force origin main',
    'git push -f',
    'git push --no-verify',
    'git push --force-with-lease',
    'git push --force-with-lease=main:abc',
    'git push origin +main',
    'git -C /tmp/x push --force',
  ];
  for (const command of cases) {
    const r = w.bash(command);
    assert.equal(r.code, 2, command);
    assert.match(r.err, /^push-gate: `/, command);
  }
  assert.equal(w.gateRan(), false, 'обход отсекается раньше гейта');
});

scenario('push внутри sh -c, второй строки и цепочки — тоже push', { gateExit: 1 }, (w) => {
  for (const command of ['sh -c "git push origin main"', 'echo ok\ngit push', 'make && git push', '  git   push']) {
    assert.equal(w.bash(command).code, 2, command);
  }
});

scenario('гейт, не уложившийся во время, блокирует push', { gate: 'slow.mjs' }, (w) => {
  writeFileSync(join(w.root, 'slow.mjs'), 'setTimeout(() => {}, 30000);\n');
  const r = w.bash('git push', { PUSH_GATE_SECONDS: '1' });
  assert.equal(r.code, 2);
  assert.match(r.err, /не уложился в 1 с/);
});

scenario('нет настройки gate или нет файла гейта — push проходит', {}, (w) => {
  w.writeProject(null);
  assert.equal(w.bash('git push').code, 0);
  w.writeProject('no/such/gate.mjs');
  assert.equal(w.bash('git push').code, 0);
  assert.equal(w.gateRan(), false);
});

test('нештатный вход и хост без collab — проход, хук не падает', () => {
  for (const stdin of ['not json', '', 'null', '[]', '{"tool_name":"Bash"}', '{"tool_input":{"command":42}}']) {
    const r = run(stdin);
    assert.equal(r.code, 0, stdin);
    assert.equal(r.err, '', stdin);
  }
  assert.equal(run({ tool_name: 'Bash', tool_input: { command: 'git push' }, cwd: tmpdir() }).code, 0, 'нет collab');
  assert.equal(run({ tool_name: 'Bash', tool_input: { command: 'git push -f' }, cwd: tmpdir() }).code, 2, 'обход блокируется и без collab');
});
