// Тесты hooks/scope-guard.mjs. Хук запускается как у хоста — через bin/agent-collab-kit-hook, отдельным
// процессом: важны код выхода (2 = блок, всё остальное хост пропускает) и русское сообщение в stderr.
//
// Чёрного хода в хуке нет: заглушка `collab` кладётся по боевому пути <HOME>/.agent-collab-kit/current/bin/collab
// во временном HOME. Фикстуры живут в каталоге временных файлов ОС, который на macOS НЕ под /tmp
// (/var/folders/…): под /tmp хук даёт особое исключение, его тесты создают каталоги под /tmp явно.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const LAUNCHER = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agent-collab-kit-hook');
const WINDOWS = process.platform === 'win32';
const GIT = ['/usr/bin/git', '/opt/homebrew/bin/git'].find((g) => !WINDOWS && spawnSync(g, ['--version']).status === 0) ?? (WINDOWS ? 'git' : null);
const skipNoSymlink = WINDOWS ? 'symlink на Windows требует прав' : false;
const skipNoGit = GIT ? false : 'git не найден';

function envFor(home, agent) {
  const env = { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' };
  if (agent) env.KIT_AGENT = agent;
  return env;
}

function runHook(stdin, { home, agent = 'implementer', cwd, extraEnv = {}, timeout = 25_000 }) {
  const input = typeof stdin === 'string' || Buffer.isBuffer(stdin) ? stdin : JSON.stringify(stdin);
  const proc = spawnSync(process.execPath, [LAUNCHER, 'scope-guard'], {
    input, env: { ...envFor(home, agent), ...extraEnv }, cwd: cwd ?? home, encoding: 'utf8', timeout,
  });
  return { code: proc.status, err: proc.stderr ?? '' };
}

function world() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'scope-guard-')));
  const dirs = { home: join(base, 'home'), code: join(base, 'code'), registry: join(base, 'registry') };
  for (const d of Object.values(dirs)) mkdirSync(d);
  mkdirSync(join(dirs.registry, 'demo'));
  const cleanups = [() => rmSync(base, { recursive: true, force: true })];
  const w = {
    base, ...dirs, cleanups,
    cleanup: () => cleanups.forEach((f) => f()),
    scopes(scopes, raw) {
      writeFileSync(join(dirs.registry, 'demo', 'scopes.json'), raw ?? JSON.stringify(scopes));
    },
    collab({ json, raw, exitCode = 0, hang = false, home = dirs.home } = {}) {
      const binDir = join(home, '.agent-collab-kit', 'current', 'bin');
      mkdirSync(binDir, { recursive: true });
      const payload = join(binDir, 'collab.payload');
      writeFileSync(payload, raw ?? JSON.stringify(json ?? {}));
      const hangCode = hang
        ? `require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { stdio: ['ignore', 'inherit', 'inherit'] });\nsetTimeout(() => {}, 30000);\n`
        : `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(payload)}));\nprocess.exitCode = ${exitCode};\n`;
      writeFileSync(join(binDir, 'collab'), hangCode);
    },
    collabOk({ projectId = 'demo', codeRoot = dirs.code, registryDir = dirs.registry, home } = {}) {
      w.collab({ json: { codeRoot, projectId, registryDir, initialized: true, error: null }, home });
    },
    event(rel, { tool = 'Edit', root = dirs.code } = {}) {
      const field = tool === 'NotebookEdit' ? 'notebook_path' : 'file_path';
      return { tool_name: tool, tool_input: { [field]: join(root, rel) }, cwd: root };
    },
    run(stdin, opts = {}) { return runHook(stdin, { home: dirs.home, ...opts }); },
    // каталог под /tmp (для исключения временного каталога), убирается вместе с миром
    tmpDir() {
      const d = mkdtempSync(WINDOWS ? join(tmpdir(), 'sg-tmp-') : '/tmp/scope-guard-test-');
      cleanups.push(() => rmSync(d, { recursive: true, force: true }));
      return d;
    },
    gitInit(dir) {
      spawnSync(GIT, ['init', '-q', dir], { env: { PATH: process.env.PATH, HOME: '/nonexistent', LC_ALL: 'C' } });
    },
  };
  return w;
}

// Каждый тест — в своём мире; тело получает w.
function scenario(name, body, options = {}) {
  test(name, options, async () => {
    const w = world();
    try { await body(w); } finally { w.cleanup(); }
  });
}
const APP = { implementer: { allow: ['App/'], deny: [] } };

// ── правила областей ─────────────────────────────────────────────────────────

scenario('правка внутри области проходит, Write и NotebookEdit — тоже', (w) => {
  w.scopes(APP); w.collabOk();
  assert.equal(w.run(w.event('App/Foo.swift')).code, 0);
  assert.equal(w.run(w.event('App/New.swift', { tool: 'Write' })).code, 0);
  assert.equal(w.run(w.event('App/a.ipynb', { tool: 'NotebookEdit' })).code, 0);
});

scenario('граница компонента: App/ не пускает AppTests/', (w) => {
  w.scopes(APP); w.collabOk();
  const blocked = w.run(w.event('AppTests/FooTests.swift'));
  assert.equal(blocked.code, 2);
  assert.match(blocked.err, /вне разрешённых областей/);
});

scenario('deny внутри allow блокирует', (w) => {
  w.scopes({ implementer: { allow: ['App/'], deny: ['App/Secrets/'] } }); w.collabOk();
  const r = w.run(w.event('App/Secrets/keys.swift'));
  assert.equal(r.code, 2);
  assert.match(r.err, /запрещён явно/);
});

scenario('вне корня кода — блок', (w) => {
  w.scopes(APP); w.collabOk();
  const r = w.run({ tool_name: 'Write', tool_input: { file_path: join(w.base, 'elsewhere', 'f.txt') }, cwd: w.code });
  assert.equal(r.code, 2);
  assert.match(r.err, /вне корня кода/);
});

scenario('служебные имена блокируются при любом allow, где угодно в корне', (w) => {
  w.scopes({ implementer: { allow: ['.claude/', '.mcp.json', '.git/', '.collab/', 'App/', 'Modules/'], deny: [] } }); w.collabOk();
  for (const rel of ['.claude/settings.json', '.mcp.json', '.git/config', '.collab/tasks/t1.json',
    'App/.git/config', 'Modules/Sub/.claude/settings.json', 'App/.collab/x', 'Modules/.mcp.json']) {
    const r = w.run(w.event(rel));
    assert.equal(r.code, 2, rel);
    assert.match(r.err, /служебн/, rel);
  }
});

scenario('корень кода сам может лежать под .claude/worktrees', (w) => {
  const wt = join(w.base, 'repo', '.claude', 'worktrees', 'feat');
  mkdirSync(wt, { recursive: true });
  w.scopes(APP); w.collabOk({ codeRoot: wt });
  assert.equal(w.run(w.event('App/Foo.swift', { root: wt })).code, 0);
});

scenario('защищённые каталоги HOME блокируются раньше запуска collab', (w) => {
  for (const name of ['agent-collab-kit', '.agent-collab-kit', '.claude', '.codex']) {
    const r = w.run({ tool_name: 'Edit', tool_input: { file_path: join(w.home, name, 'secret.py') }, cwd: w.home });
    assert.equal(r.code, 2, name);
    assert.match(r.err, /защищённого каталога/, name);
  }
});

scenario('симлинк внутри корня наружу — блок', (w) => {
  w.scopes(APP); w.collabOk();
  const outside = join(w.base, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.swift'), '// outside');
  symlinkSync(outside, join(w.code, 'App'), 'dir');
  const r = w.run(w.event('App/secret.swift'));
  assert.equal(r.code, 2);
  assert.match(r.err, /вне корня кода/);
}, { skip: skipNoSymlink });

scenario('симлинк из разрешённого каталога в запрещённый — блок', (w) => {
  w.scopes({ implementer: { allow: ['App/'], deny: ['shared/'] } }); w.collabOk();
  mkdirSync(join(w.code, 'shared'));
  mkdirSync(join(w.code, 'App'));
  symlinkSync(join(w.code, 'shared'), join(w.code, 'App', 'link'), 'dir');
  assert.equal(w.run(w.event('App/link/x.swift')).code, 2);
}, { skip: skipNoSymlink });

scenario('проект не описан в реестре', (w) => {
  w.scopes(APP); w.collabOk({ projectId: null });
  const r = w.run(w.event('App/Foo.swift'));
  assert.equal(r.code, 2);
  assert.match(r.err, /не описан в реестре/);
});

scenario('нет scopes.json', (w) => {
  w.collabOk();
  const r = w.run(w.event('App/Foo.swift'));
  assert.equal(r.code, 2);
  assert.match(r.err, /scopes\.json/);
});

scenario('у агента нет записи; KIT_AGENT не задан', (w) => {
  w.scopes({ 'someone-else': { allow: ['App/'], deny: [] } }); w.collabOk();
  const r = w.run(w.event('App/Foo.swift'));
  assert.equal(r.code, 2);
  assert.match(r.err, /нет описанных областей/);
  w.scopes(APP);
  assert.equal(w.run(w.event('App/Foo.swift'), { agent: null }).code, 2);
});

scenario('сбои collab: нет файла, код ≠ 0, мусор, error в ответе', (w) => {
  w.scopes(APP);
  assert.equal(w.run(w.event('App/Foo.swift')).code, 2, 'collab не установлен');
  w.collab({ json: {}, exitCode: 1 });
  assert.equal(w.run(w.event('App/Foo.swift')).code, 2, 'код 1');
  w.collab({ raw: 'not json at all {{{' });
  assert.equal(w.run(w.event('App/Foo.swift')).code, 2, 'мусор');
  w.collab({ json: { codeRoot: w.code, projectId: 'demo', registryDir: w.registry, error: { code: 'AMBIGUOUS_PROJECT' } } });
  assert.equal(w.run(w.event('App/Foo.swift')).code, 2, 'error');
});

// ── жёсткие ссылки и не-обычные файлы ────────────────────────────────────────

function withApp(name, body, options) {
  scenario(name, (w) => {
    w.scopes(APP); w.collabOk();
    mkdirSync(join(w.code, 'App'));
    return body(w);
  }, options);
}

withApp('жёсткая ссылка на файл вне области — блок', (w) => {
  const outside = join(w.base, 'outside.txt');
  writeFileSync(outside, 'out');
  linkSync(outside, join(w.code, 'App', 'link.swift'));
  const r = w.run(w.event('App/link.swift'));
  assert.equal(r.code, 2);
  assert.match(r.err, /жёстк/);
});

withApp('обе жёсткие ссылки внутри области — всё равно блок', (w) => {
  writeFileSync(join(w.code, 'App', 'a.swift'), '// a');
  linkSync(join(w.code, 'App', 'a.swift'), join(w.code, 'App', 'b.swift'));
  for (const rel of ['App/a.swift', 'App/b.swift']) assert.equal(w.run(w.event(rel)).code, 2, rel);
});

withApp('жёсткая ссылка под /tmp — блок', (w) => {
  const outside = join(w.base, 'outside.txt');
  writeFileSync(outside, 'out');
  const target = join(w.tmpDir(), 'alias.txt');
  linkSync(outside, target);
  const r = w.run({ tool_name: 'Edit', tool_input: { file_path: target }, cwd: dirname(target) });
  assert.equal(r.code, 2, r.err);
});

withApp('обычный файл и новые файлы проходят', (w) => {
  writeFileSync(join(w.code, 'App', 'Foo.swift'), '// single');
  assert.equal(w.run(w.event('App/Foo.swift')).code, 0);
  for (const rel of ['App/New.swift', 'App/NewDir/Deeper/New.swift']) assert.equal(w.run(w.event(rel, { tool: 'Write' })).code, 0, rel);
});

withApp('висячий симлинк — блок', (w) => {
  symlinkSync(join(w.code, 'App', 'missing.swift'), join(w.code, 'App', 'dangling.swift'));
  assert.equal(w.run(w.event('App/dangling.swift', { tool: 'Write' })).code, 2);
}, { skip: skipNoSymlink });

withApp('каталог как цель — блок', (w) => {
  mkdirSync(join(w.code, 'App', 'Sub'));
  assert.equal(w.run(w.event('App/Sub', { tool: 'Write' })).code, 2);
});

// ── жёсткие запреты раньше исключения для /tmp ───────────────────────────────

scenario('/tmp вне git — проходит без collab', (w) => {
  const d = w.tmpDir();
  for (const target of [join(d, 'notes.txt'), join(d, 'deeper', 'not-yet', 'file.txt')]) {
    const r = w.run({ tool_name: 'Write', tool_input: { file_path: target }, cwd: w.code });
    assert.equal(r.code, 0, `${target}: ${r.err}`);
  }
});

scenario('/tmp: служебные имена блокируются и без репозитория', (w) => {
  const d = w.tmpDir();
  const r = w.run({ tool_name: 'Write', tool_input: { file_path: join(d, '.claude', 'settings.json') }, cwd: d });
  assert.equal(r.code, 2);
});

scenario('/tmp: клон git — жёсткие запреты и правила проекта', (w) => {
  const repo = join(w.tmpDir(), 'repo');
  mkdirSync(repo);
  w.gitInit(repo);
  for (const rel of ['.git/config', '.claude/settings.json', '.mcp.json', '.collab/t.json']) {
    assert.equal(w.run(w.event(rel, { root: repo })).code, 2, rel);
  }
  assert.equal(w.run(w.event('App/Foo.swift', { root: repo })).code, 2, 'без collab');
  w.scopes({ implementer: { allow: ['App/'], deny: ['shared/'] } }); w.collabOk({ codeRoot: repo });
  assert.equal(w.run(w.event('App/Foo.swift', { root: repo })).code, 0);
  for (const rel of ['shared/x.swift', 'README.md']) assert.equal(w.run(w.event(rel, { root: repo })).code, 2, rel);
}, { skip: skipNoGit });

scenario('защищённый каталог HOME, симлинком ведущий в /tmp, — блок', (w) => {
  const d = w.tmpDir();
  symlinkSync(d, join(w.home, '.claude'), 'dir');
  const r = w.run({ tool_name: 'Write', tool_input: { file_path: join(w.home, '.claude', 'settings.json') }, cwd: w.home });
  assert.equal(r.code, 2);
  assert.match(r.err, /защищённого каталога/);
}, { skip: skipNoSymlink });

scenario('симлинк из корня кода в защищённый каталог HOME — блок', (w) => {
  w.scopes(APP); w.collabOk();
  mkdirSync(join(w.home, '.codex'));
  mkdirSync(join(w.code, 'App'));
  symlinkSync(join(w.home, '.codex'), join(w.code, 'App', 'cfg'), 'dir');
  const r = w.run(w.event('App/cfg/config.toml'));
  assert.equal(r.code, 2);
  assert.match(r.err, /защищённого каталога/);
}, { skip: skipNoSymlink });

// ── регистр и Unicode ────────────────────────────────────────────────────────

scenario('регистр: запрещённый файл и каталог, служебные имена, защищённый HOME', (w) => {
  w.scopes({ implementer: { allow: ['App/', 'backend/', '.CLAUDE/', '.Git/'], deny: ['App/CLAUDE.md', 'backend/test/contracts/'] } }); w.collabOk();
  const r = w.run(w.event('App/claude.md'));
  assert.equal(r.code, 2);
  assert.match(r.err, /запрещён явно/);
  assert.equal(w.run(w.event('backend/Test/contracts/x.ts')).code, 2);
  for (const rel of ['.CLAUDE/x', '.Git/config', 'App/.MCP.json', '.Collab/t.json']) assert.equal(w.run(w.event(rel)).code, 2, rel);
  const home = w.run({ tool_name: 'Edit', tool_input: { file_path: join(w.home, '.CLAUDE', 'settings.json') }, cwd: w.home });
  assert.equal(home.code, 2);
  assert.match(home.err, /защищённого каталога/);
});

scenario('Unicode: декомпозиция и регистр совпадают с шаблоном', (w) => {
  const composed = 'Café'.normalize('NFC');
  const decomposed = 'Café'.normalize('NFD');
  assert.notEqual(composed, decomposed);
  w.scopes({ implementer: { allow: ['App/', `Menu/${composed}/`], deny: [`App/${composed}/`] } }); w.collabOk();
  assert.equal(w.run(w.event(`App/${decomposed}/menu.swift`)).code, 2, 'deny по NFD');
  assert.equal(w.run(w.event(`menu/${decomposed.toLowerCase()}/menu.swift`)).code, 0, 'allow по NFD + регистр');
});

scenario('свёрнутый префикс сохраняет границу компонента', (w) => {
  w.scopes({ implementer: { allow: ['app/'], deny: [] } }); w.collabOk();
  assert.equal(w.run(w.event('AppTests/FooTests.swift')).code, 2);
});

// ── fail-closed ──────────────────────────────────────────────────────────────

test('на Windows свёртка отбрасывает хвостовые точки, пробелы и потоки', async () => {
  const { foldPart, rawParts } = await import('../hooks/scope-guard.mjs');
  for (const name of ['.git.', '.git ', '.git::$INDEX_ALLOCATION', '.GIT', '.git. .']) assert.equal(foldPart(name, true), '.git', name);
  assert.equal(foldPart('.git.', false), '.git.');
  assert.deepEqual(rawParts('a\\b/c', true), ['a', 'b', 'c']);
  assert.deepEqual(rawParts('a\\b/c', false), ['a\\b', 'c']);
});

function failClosedWorld(name, body, options) {
  scenario(name, (w) => { w.scopes(APP); w.collabOk(); return body(w); }, options);
}

failClosedWorld('NUL в пути и одиночный суррогат — блок без стека', (w) => {
  const nul = w.run(w.event('App/a\0b.swift'));
  assert.equal(nul.code, 2, nul.err);
  const raw = JSON.stringify(w.event('App/x.swift')).replace('x.swift', '\\ud800.swift');
  const lone = w.run(raw);
  assert.equal(lone.code, 2, lone.err);
  assert.doesNotMatch(nul.err + lone.err, /at .*\.mjs/);
});

failClosedWorld('не UTF-8, пустые и невалидные события — блок', (w) => {
  const bad = Buffer.from(JSON.stringify(w.event('App/PLACEHOLDER.swift'))).toString('latin1').replace('PLACEHOLDER', '\xff\xfe');
  assert.equal(w.run(Buffer.from(bad, 'latin1')).code, 2, 'не UTF-8');
  const cases = ['', 'not { valid json', 'null', '[]', '"Edit"', '{"tool_name": "Edit"}',
    '{"tool_name": "Edit", "tool_input": [], "cwd": "/"}',
    JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 42 }, cwd: w.code })];
  for (const raw of cases) assert.equal(w.run(raw).code, 2, raw);
});

failClosedWorld('не UTF-8 в scopes.json и в ответе collab; кривые шаблоны', (w) => {
  w.scopes(null, Buffer.from('{"implementer": {"allow": ["App/\xff"]}}', 'latin1'));
  assert.equal(w.run(w.event('App/Foo.swift')).code, 2, 'scopes не UTF-8');
  for (const scopes of [
    { implementer: { allow: ['App/'], deny: [42, 'shared/'] } },
    { implementer: { allow: ['App/'], deny: 'shared/' } },
    { implementer: { allow: ['/'], deny: [] } },
    { implementer: { allow: ['App/../'], deny: [] } },
  ]) {
    w.scopes(scopes);
    assert.equal(w.run(w.event('App/Foo.swift')).code, 2, JSON.stringify(scopes));
  }
  w.collab({ raw: Buffer.from('{"codeRoot": "\xff"}', 'latin1') });
  assert.equal(w.run(w.event('App/Foo.swift')).code, 2, 'collab не UTF-8');
});

failClosedWorld('projectId с обходом каталога и относительный codeRoot — блок', (w) => {
  const evil = join(w.base, 'evil');
  mkdirSync(evil);
  writeFileSync(join(evil, 'scopes.json'), JSON.stringify({ implementer: { allow: ['App/', 'shared/'], deny: [] } }));
  w.collabOk({ projectId: '../evil' });
  assert.equal(w.run(w.event('shared/x.swift')).code, 2, 'projectId');
  w.collabOk({ codeRoot: 'code' });
  assert.equal(w.run(w.event('App/Foo.swift'), { cwd: w.base }).code, 2, 'codeRoot');
});

failClosedWorld('collab завис вместе с внуком — блок сильно раньше таймаута хоста', (w) => {
  w.collab({ hang: true });
  const start = Date.now();
  const r = w.run(w.event('App/Foo.swift'), { timeout: 20_000 });
  assert.equal(r.code, 2, r.err);
  assert.ok(Date.now() - start < 8000, `collab должен отвалиться за ~5 с, ушло ${Date.now() - start} мс`);
});

test('stdin не закрывается — лаунчер блокирует до таймаута хоста', async () => {
  const w = world();
  try {
    w.scopes(APP); w.collabOk();
    const start = Date.now();
    const child = spawn(process.execPath, [LAUNCHER, 'scope-guard'], { env: envFor(w.home, 'implementer'), cwd: w.home, stdio: ['pipe', 'pipe', 'pipe'] });
    const code = await new Promise((resolve) => {
      const guard = setTimeout(() => { child.kill('SIGKILL'); resolve('завис'); }, 14_000);
      child.on('close', (c) => { clearTimeout(guard); resolve(c); });
    });
    assert.equal(code, 2);
    assert.ok(Date.now() - start < 13_000);
  } finally { w.cleanup(); }
});

// ── нет чёрного хода ─────────────────────────────────────────────────────────

scenario('KIT_COLLAB_BIN ничего не значит', async (w) => {
  w.scopes({ implementer: { allow: ['App/', 'shared/'], deny: [] } });
  const otherHome = join(w.base, 'other-home');
  w.collabOk({ home: otherHome });
  const forged = join(otherHome, '.agent-collab-kit', 'current', 'bin', 'collab');
  assert.equal(w.run(w.event('shared/x.swift'), { extraEnv: { KIT_COLLAB_BIN: forged } }).code, 2);
  const { readFileSync } = await import('node:fs');
  assert.ok(!readFileSync(join(dirname(LAUNCHER), '..', 'hooks', 'scope-guard.mjs'), 'utf8').includes('KIT_COLLAB_BIN'));
});

// ── проверка события ─────────────────────────────────────────────────────────

function eventWorld(name, body) {
  scenario(name, (w) => { w.scopes({ implementer: { allow: ['App/'], deny: ['shared/'] } }); w.collabOk(); return body(w); });
}

eventWorld('чужой или отсутствующий tool_name — блок', (w) => {
  for (const tool of ['Bash', 'MultiEdit', 'edit', '', undefined, 7]) {
    const event = w.event('App/Foo.swift');
    if (tool === undefined) delete event.tool_name; else event.tool_name = tool;
    assert.equal(w.run(event).code, 2, String(tool));
  }
});

eventWorld('cwd: нет, относительный — блок; cwd процесса не подставляется', (w) => {
  assert.equal(w.run({ tool_name: 'Edit', tool_input: { file_path: 'App/Foo.swift' } }, { cwd: w.code }).code, 2);
  assert.equal(w.run({ tool_name: 'Edit', tool_input: { file_path: 'App/Foo.swift' }, cwd: 'code' }, { cwd: w.base }).code, 2);
});

eventWorld('оба поля пути или поле не под инструмент — блок', (w) => {
  const both = { tool_name: 'NotebookEdit', tool_input: { file_path: join(w.code, 'App', 'ok.ipynb'), notebook_path: join(w.code, 'shared', 'bad.ipynb') }, cwd: w.code };
  assert.equal(w.run(both).code, 2);
  const wrong = { tool_name: 'Edit', tool_input: { notebook_path: join(w.code, 'App', 'a.ipynb') }, cwd: w.code };
  assert.equal(w.run(wrong).code, 2);
});

eventWorld('относительный путь разрешается только от cwd события', (w) => {
  const decoy = join(w.base, 'decoy');
  mkdirSync(join(decoy, 'shared'), { recursive: true });
  const event = { tool_name: 'Edit', tool_input: { file_path: 'shared/x.swift' }, cwd: w.code };
  assert.equal(w.run(event, { cwd: decoy }).code, 2);
  event.tool_input.file_path = 'App/x.swift';
  assert.equal(w.run(event, { cwd: decoy }).code, 0);
});
