// Тесты hooks/post-edit.mjs и hooks/session-start.mjs — проектные хуки ведущей сессии, настройки которых
// (`post_edit`, `githooks_dir`) лежат в реестре проекта. Запуск — как у хоста, через bin/agent-collab-kit-hook.
// Гейты в тестах — .mjs-скрипты (одинаково запускаются на macOS и Windows), они пишут метку в файл.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const LAUNCHER = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agent-collab-kit-hook');

function launch(name, stdin, home, extraEnv = {}) {
  const env = { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', ...extraEnv };
  const input = typeof stdin === 'string' ? stdin : JSON.stringify(stdin);
  const proc = spawnSync(process.execPath, [LAUNCHER, name], { input, env, encoding: 'utf8', timeout: 30_000 });
  return { code: proc.status, out: proc.stdout, err: proc.stderr };
}

function world(projectExtra) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'post-edit-')));
  const root = join(base, 'project');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  spawnSync('git', ['init', '-q', root]);
  const ran = (name) => join(base, `ran-${name}`);
  const gate = (name, exit = 0) =>
    writeFileSync(
      join(root, 'scripts', `${name}.mjs`),
      `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(ran(name))}, 'x');\nconsole.error('строка из гейта ${name}');\nprocess.exit(${exit});\n`
    );
  const registry = join(base, 'registry');
  const writeProject = (extra) => {
    mkdirSync(join(registry, 'demo'), { recursive: true });
    writeFileSync(join(registry, 'demo', 'project.json'), JSON.stringify({ id: 'demo', roots: [root], ...extra }));
  };
  writeProject(projectExtra);
  const home = join(base, 'home');
  const binDir = join(home, '.agent-collab-kit', 'current', 'bin');
  mkdirSync(binDir, { recursive: true });
  const payload = join(binDir, 'collab.payload.json');
  writeFileSync(payload, JSON.stringify({ projectId: 'demo', registryDir: registry, codeRoot: root }));
  writeFileSync(join(binDir, 'collab'), `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(payload)}, 'utf8'))\n`);
  const edit = (file, extraEnv, cwd = root) =>
    launch('post-edit', { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: file }, cwd }, home, extraEnv);
  return {
    base,
    root,
    home,
    gate,
    writeProject,
    edit,
    runs: (name) => (existsSync(ran(name)) ? readFileSync(ran(name), 'utf8').length : 0),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

function scenario(name, extra, body) {
  test(name, async () => {
    const w = world(extra);
    try {
      await body(w);
    } finally {
      w.cleanup();
    }
  });
}

const RULES = {
  post_edit: [
    {
      gate: 'scripts/contracts.mjs',
      paths: ['app/DTO/', 'shared/manifest.json'],
      registries: [{ file: 'shared/manifest.json', keys: { swiftFile: '', contractFile: 'test/contracts/' } }],
    },
    { gate: 'scripts/enums.mjs', registries: [{ file: 'shared/enums.json', keys: { file: '' } }] },
  ],
};

function seed(w) {
  w.gate('contracts');
  w.gate('enums');
  mkdirSync(join(w.root, 'shared'), { recursive: true });
  writeFileSync(join(w.root, 'shared', 'manifest.json'), JSON.stringify({ items: [{ swiftFile: 'app/Other/A.swift', nested: { contractFile: 'a.js' } }] }));
  writeFileSync(join(w.root, 'shared', 'enums.json'), JSON.stringify({ sites: [{ file: 'web/enum.ts' }] }));
}

scenario('файл вне правил — гейт не запускается', RULES, (w) => {
  seed(w);
  for (const file of ['app/Views/Home.swift', 'README.md', 'scripts/contracts.mjs']) assert.equal(w.edit(join(w.root, file)).code, 0, file);
  assert.equal(w.runs('contracts') + w.runs('enums'), 0);
});

scenario('префикс из paths запускает гейт, зелёный — проход без вывода', RULES, (w) => {
  seed(w);
  const r = w.edit(join(w.root, 'app/DTO/New.swift'));
  assert.equal(r.code, 0);
  assert.equal(r.err, '');
  assert.equal(w.runs('contracts'), 1);
  assert.equal(w.runs('enums'), 0);
});

scenario('красный гейт: код 2, хвост вывода и напоминание про чужой файл и baseline', RULES, (w) => {
  seed(w);
  w.gate('contracts', 1);
  const r = w.edit(join(w.root, 'app/DTO/New.swift'));
  assert.equal(r.code, 2);
  assert.match(r.err, /scripts\/contracts\.mjs — провал после правки app\/DTO\/New\.swift:/);
  assert.match(r.err, /строка из гейта contracts/);
  assert.match(r.err, /Гейт красный\. Если в выводе чужой файл/);
  assert.match(r.err, /--update-baseline/);
});

scenario('файл, названный в реестре (с префиксом значения), запускает свой гейт', RULES, (w) => {
  seed(w);
  assert.equal(w.edit(join(w.root, 'app/Other/A.swift')).code, 0);
  assert.equal(w.runs('contracts'), 1, 'swiftFile без префикса');
  assert.equal(w.edit(join(w.root, 'test/contracts/a.js')).code, 0);
  assert.equal(w.runs('contracts'), 2, 'contractFile с префиксом');
  assert.equal(w.edit(join(w.root, 'a.js')).code, 0);
  assert.equal(w.runs('contracts'), 2, 'значение без префикса — не тот файл');
  assert.equal(w.edit(join(w.root, 'web/enum.ts')).code, 0);
  assert.equal(w.runs('enums'), 1);
});

scenario('сам реестр запускает гейт; путь с .. и относительный путь нормализуются', RULES, (w) => {
  seed(w);
  assert.equal(w.edit(join(w.root, 'shared/enums.json')).code, 0);
  assert.equal(w.runs('enums'), 1, 'реестр без paths — по registries[].file');
  assert.equal(w.edit(join(w.root, 'x/../app/DTO/New.swift')).code, 0);
  assert.equal(w.runs('contracts'), 1, '..');
  assert.equal(w.edit('app/DTO/New.swift').code, 0);
  assert.equal(w.runs('contracts'), 2, 'относительно cwd');
});

scenario('два правила на один гейт — он запускается один раз; красный не мешает зелёному', RULES, (w) => {
  seed(w);
  w.writeProject({ post_edit: [...RULES.post_edit, { gate: 'scripts/contracts.mjs', paths: ['app/DTO/'] }, { gate: 'scripts/enums.mjs', paths: ['app/DTO/'] }] });
  w.gate('enums', 1);
  const r = w.edit(join(w.root, 'app/DTO/New.swift'));
  assert.equal(r.code, 2);
  assert.equal(w.runs('contracts'), 1);
  assert.equal(w.runs('enums'), 1);
  assert.match(r.err, /enums\.mjs — провал/);
  assert.doesNotMatch(r.err, /contracts\.mjs — провал/);
});

scenario('файл вне дерева проекта — проход', RULES, (w) => {
  seed(w);
  assert.equal(w.edit(join(w.base, 'elsewhere', 'app', 'DTO', 'New.swift')).code, 0);
  assert.equal(w.runs('contracts'), 0);
});

scenario('гейт не уложился в бюджет — красный с просьбой прогнать самому', RULES, (w) => {
  seed(w);
  writeFileSync(join(w.root, 'scripts', 'contracts.mjs'), 'setTimeout(() => {}, 30000);\n');
  const r = w.edit(join(w.root, 'app/DTO/New.swift'), { POST_EDIT_SECONDS: '1' });
  assert.equal(r.code, 2);
  assert.match(r.err, /не уложился во время/);
});

scenario('нет post_edit — проход; объявленный гейт без файла — сообщение, а не молчание', undefined, (w) => {
  assert.equal(w.edit(join(w.root, 'app/DTO/New.swift')).code, 0);
  w.writeProject(RULES);
  const r = w.edit(join(w.root, 'app/DTO/New.swift'));
  assert.equal(r.code, 2, 'файла гейта нет');
  assert.match(r.err, /scripts\/contracts\.mjs — объявлен в реестре, но файла нет/);
});

scenario('post_edit: битый project.json и неверный тип — сообщение', RULES, (w) => {
  w.writeProject({ post_edit: 'oops' });
  const wrongType = w.edit(join(w.root, 'app/DTO/New.swift'));
  assert.equal(wrongType.code, 2);
  assert.match(wrongType.err, /не массив/);
  const file = join(w.base, 'registry', 'demo', 'project.json');
  writeFileSync(file, '{ "post_edit": [');
  const broken = w.edit(join(w.root, 'app/DTO/New.swift'));
  assert.equal(broken.code, 2);
  assert.match(broken.err, /не читаются/);
});

scenario('collab не нашёл проект из-за битого project.json — реестр всё равно опознаётся по roots', RULES, (w) => {
  const payload = join(w.home, '.agent-collab-kit', 'current', 'bin', 'collab.payload.json');
  writeFileSync(payload, JSON.stringify({ projectId: null, registryDir: join(w.base, 'registry'), codeRoot: w.root }));
  writeFileSync(join(w.base, 'registry', 'demo', 'project.json'), `{ "roots": [${JSON.stringify(w.root)}], "post_edit": [`);
  const r = w.edit(join(w.root, 'app/DTO/New.swift'));
  assert.equal(r.code, 2);
  assert.match(r.err, /не читаются/);
  writeFileSync(join(w.base, 'registry', 'demo', 'project.json'), `{ "roots": [${JSON.stringify(join(w.base, 'other'))}], "post_edit": [`);
  assert.equal(w.edit(join(w.root, 'app/DTO/New.swift')).code, 0, 'чужой проект с битым реестром не мешает');
});

test('нештатный вход и хост без collab — проход, хук не падает', () => {
  const home = join(tmpdir(), 'agent-collab-kit-no-such-home');
  for (const stdin of ['not json', '', 'null', '[]', '{"tool_input":{}}', '{"tool_input":{"file_path":42}}']) {
    const r = launch('post-edit', stdin, home);
    assert.equal(r.code, 0, stdin);
    assert.equal(r.err, '', stdin);
  }
  assert.equal(launch('post-edit', { tool_input: { file_path: join(tmpdir(), 'x.swift') }, cwd: tmpdir() }, home).code, 0);
});

// ── session-start ────────────────────────────────────────────────────────────

const hooksPath = (w) => spawnSync('git', ['-C', w.root, 'config', '--get', 'core.hooksPath'], { encoding: 'utf8' }).stdout.trim();
const start = (w, cwd = w.root) => launch('session-start', { hook_event_name: 'SessionStart', cwd }, w.home);

scenario('session-start включает каталог git-хуков один раз и молчит при повторе', { githooks_dir: 'scripts/githooks' }, (w) => {
  mkdirSync(join(w.root, 'scripts', 'githooks'), { recursive: true });
  const first = start(w);
  assert.equal(first.code, 0);
  assert.match(first.out, /core\.hooksPath → scripts\/githooks/);
  assert.equal(hooksPath(w), 'scripts/githooks');
  const second = start(w);
  assert.equal(second.code, 0);
  assert.equal(second.out, '', 'stdout идёт в контекст сессии — печатать только при изменении');
});

scenario('session-start: нет каталога, неверный путь — ничего не меняет, но говорит; нет настройки — молчит', { githooks_dir: 'scripts/githooks' }, (w) => {
  assert.match(start(w).out, /объявлен в реестре, но не найден/);
  assert.equal(hooksPath(w), '', 'каталога нет');
  mkdirSync(join(w.base, 'outside'), { recursive: true });
  for (const dir of ['../outside', '..\\outside', join(w.base, 'outside')]) {
    w.writeProject({ githooks_dir: dir });
    assert.match(start(w).out, /задан неверно/, dir);
    assert.equal(hooksPath(w), '', dir);
  }
  writeFileSync(join(w.base, 'registry', 'demo', 'project.json'), '{ broken');
  assert.match(start(w).out, /настройки проекта не читаются/);
  mkdirSync(join(w.root, 'scripts', 'githooks'), { recursive: true });
  w.writeProject({});
  assert.equal(start(w).out, '', 'нет настройки');
  assert.equal(hooksPath(w), '');
});
