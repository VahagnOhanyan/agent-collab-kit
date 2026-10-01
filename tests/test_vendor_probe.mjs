// Тесты детерминированной разведки: только локальные sh-заглушки, без живых CLI.
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkProfile, sandboxTest } from '../skills/vendor-probe/probe.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROBE = join(ROOT, 'skills', 'vendor-probe', 'probe.mjs');
const SCHEMA = JSON.parse(spawnSync(process.execPath, ['-e', `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(join(ROOT, 'skills/vendor-probe/profile.schema.json'))}, 'utf8'))`], { encoding: 'utf8' }).stdout);
const skipWindows = process.platform === 'win32';

function world() {
  const base = mkdtempSync(join(tmpdir(), 'vendor-probe-test-'));
  const bin = join(base, 'bin');
  const cwd = join(base, 'cwd');
  mkdirSync(bin); mkdirSync(cwd);
  const script = (name, body) => {
    const file = join(bin, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
  };
  return { base, bin, cwd, script, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function profile() {
  const group = { status: 'not_found', evidence: '' };
  return {
    id: 'vendor', binary: 'vendor', version: '1',
    headless: { ...group }, readonly: { ...group }, config: { ...group }, mcp: { ...group }, hooks: { ...group }, auth: { ...group }, limits: { ...group },
    models: [{ id: 'small', tier_guess: 'cheap', source: 'help' }],
  };
}

test('check-profile принимает корректный профиль и отвергает обязательные поля', () => {
  assert.equal(checkProfile(profile(), SCHEMA).ok, true);
  const missing = profile(); delete missing.version;
  assert.equal(checkProfile(missing, SCHEMA).ok, false);
});

test('check-profile требует непустой evidence для verified', () => {
  const empty = profile(); empty.config = { status: 'verified', evidence: '' };
  assert.equal(checkProfile(empty, SCHEMA).ok, false);
});

test('check-profile требует успешную пробу для verified readonly', () => {
  const value = profile(); value.readonly = { status: 'verified', evidence: 'run', sandbox_test: { status: 'inconclusive' } };
  const result = checkProfile(value, SCHEMA);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.path === '$.readonly.status'));
});

test('check-profile не пропускает секреты и домашние пути, не печатая секрет', () => {
  const value = profile();
  const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
  value.auth = { status: 'documented', evidence: `token ${secret}; Bearer 12345678901234567890; -----BEGIN PRIVATE KEY-----` };
  value.config.path = '/Users/someone/x';
  const result = checkProfile(value, SCHEMA);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.message === 'обнаружен секрет'));
  assert.ok(result.problems.some((problem) => problem.message.includes('замени на ~')));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

test('sandbox-test различает отказ, запись и молчание', { skip: skipWindows }, async () => {
  const w = world();
  try {
    const denied = w.script('denied', 'echo "permission denied" >&2\nexit 1');
    const writes = w.script('writes', 'printf ok > probe-write-test.txt');
    const quiet = w.script('quiet', 'exit 0');
    for (const [bin, expected] of [[denied, 'verified'], [writes, 'failed'], [quiet, 'inconclusive']]) {
      const result = await sandboxTest({ bin, args: [], cwd: w.cwd });
      assert.equal(result.status, expected);
      if (result.file_created) unlinkSync(join(w.cwd, 'probe-write-test.txt'));
    }
  } finally { w.cleanup(); }
});

test('sandbox-test изолирует HOME, обрабатывает запуск и таймаут', { skip: skipWindows }, async () => {
  const w = world();
  try {
    const home = w.script('home', 'printf "%s" "$HOME"');
    const sleepy = w.script('sleepy', 'sleep 1');
    const homeResult = await sandboxTest({ bin: home, args: [], cwd: w.cwd });
    assert.notEqual(homeResult.stdout_excerpt, process.env.HOME ?? '');
    const missing = await sandboxTest({ bin: join(w.bin, 'missing'), args: [], cwd: w.cwd });
    assert.equal(missing.status, 'inconclusive');
    const timeout = await sandboxTest({ bin: sleepy, args: [], cwd: w.cwd, timeoutMs: 20 });
    assert.equal(timeout.status, 'inconclusive');
    assert.equal(timeout.timed_out, true);
  } finally { w.cleanup(); }
});

test('detect видит PATH и регистрацию в agents.json', { skip: skipWindows }, async () => {
  const w = world();
  try {
    w.script('found', 'exit 0');
    const candidates = join(w.base, 'candidates.json');
    const agents = join(w.base, 'agents.json');
    writeFileSync(candidates, JSON.stringify({ candidates: [{ binary: 'found', vendor: 'a' }, { binary: 'registered', vendor: 'b' }, { binary: 'also-registered', vendor: 'c' }, { binary: 'missing', vendor: 'd' }] }));
    writeFileSync(agents, JSON.stringify({ agents: [{ id: 'registered' }, { adapter: { binary: 'also-registered' } }] }));
    const call = spawnSync(process.execPath, [PROBE, 'detect', '--agents', agents, '--candidates', candidates], {
      encoding: 'utf8', env: { PATH: w.bin },
    });
    assert.equal(call.status, 0, call.stderr);
    const result = JSON.parse(call.stdout);
    assert.deepEqual(result.candidates.map(({ binary, found, registered }) => ({ binary, found, registered })), [
      { binary: 'found', found: true, registered: false },
      { binary: 'registered', found: false, registered: true },
      { binary: 'also-registered', found: false, registered: true },
      { binary: 'missing', found: false, registered: false },
    ]);
  } finally { w.cleanup(); }
});

// The installed copy is reached through the `~/.agent-collab-kit/current` link: run that way the script used to exit 0 with
// no output at all, so an agent read "nothing found".
test('запуск через символическую ссылку на каталог (как из ~/.agent-collab-kit/current) печатает результат', { skip: skipWindows }, () => {
  const w = world();
  try {
    const link = join(w.base, 'current');
    symlinkSync(ROOT, link);
    const candidates = join(w.base, 'candidates.json');
    const agents = join(w.base, 'agents.json');
    writeFileSync(candidates, JSON.stringify({ candidates: [{ binary: 'nothing-here', vendor: 'x' }] }));
    writeFileSync(agents, JSON.stringify({ agents: [] }));
    const call = spawnSync(process.execPath, [join(link, 'skills', 'vendor-probe', 'probe.mjs'), 'detect', '--agents', agents, '--candidates', candidates], { encoding: 'utf8', env: { PATH: w.bin } });
    assert.equal(call.status, 0, call.stderr);
    assert.equal(JSON.parse(call.stdout).candidates[0].binary, 'nothing-here');
  } finally { w.cleanup(); }
});

test('неизвестная подкоманда возвращает usage и код 2', () => {
  const result = spawnSync(process.execPath, [PROBE, 'unknown'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage:/);
});
