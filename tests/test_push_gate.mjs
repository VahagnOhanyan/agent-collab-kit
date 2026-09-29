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
  const writeRaw = (text) => {
    mkdirSync(join(registry, 'demo'), { recursive: true });
    writeFileSync(join(registry, 'demo', 'project.json'), text);
  };
  writeProject(gate);
  const home = join(base, 'home');
  const binDir = join(home, '.agent-kit', 'current', 'bin');
  mkdirSync(binDir, { recursive: true });
  const payload = join(binDir, 'collab.payload.json');
  writeFileSync(payload, JSON.stringify({ projectId: 'demo', registryDir: registry, codeRoot: root }));
  // Как настоящий collab: проект отвечает только каталогу внутри него, из чужого каталога — «не зарегистрирован».
  writeFileSync(
    join(binDir, 'collab'),
    `const fs = require('node:fs');\nconst p = JSON.parse(fs.readFileSync(${JSON.stringify(payload)}, 'utf8'));\n` +
      `const inside = process.cwd() === p.codeRoot || process.cwd().startsWith(p.codeRoot + require('node:path').sep);\n` +
      `process.stdout.write(JSON.stringify(inside ? p : { projectId: null, registryDir: p.registryDir, codeRoot: null }));\n`
  );
  const bashAt = (command, cwd, extraEnv) => run({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd }, home, extraEnv);
  const bash = (command, extraEnv) => bashAt(command, root, extraEnv);
  return {
    root,
    writeProject,
    writeRaw,
    bash,
    bashAt,
    setCollabAnswer: (obj) => writeFileSync(payload, JSON.stringify(obj)),
    registry,
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

scenario('нет настройки gate — push проходит; объявленный gate без файла — блок', {}, (w) => {
  w.writeProject(null);
  assert.equal(w.bash('git push').code, 0);
  w.writeProject('no/such/gate.mjs');
  const r = w.bash('git push');
  assert.equal(r.code, 2);
  assert.match(r.err, /no\/such\/gate\.mjs/);
  assert.equal(w.gateRan(), false);
});

scenario('битый project.json зарегистрированного проекта блокирует push, не-строка в gate — тоже', {}, (w) => {
  w.writeRaw('{ not json');
  assert.equal(w.bash('git push').code, 2);
  w.writeRaw(JSON.stringify({ id: 'demo', gate: 42 }));
  assert.equal(w.bash('git push').code, 2);
  w.writeRaw(JSON.stringify({ id: 'demo' }));
  assert.equal(w.bash('git push').code, 0, 'нет ключа gate — защищаться нечем');
});

// Опасные слова собраны кусками: живой push-gate машины матчит текст любой Bash-команды, в том числе при записи тестов.
const P = ['gi', 't pu', 'sh'].join('');
const FORCE = ['--fo', 'rce'].join('');

scenario('кавычки, пробелы в пути, кластеры флагов и refspec не прячут обход', {}, (w) => {
  const blocked = [
    `git p""ush ${FORCE}`,
    `g'i't push -f`,
    `git -C "/tmp/a b" push ${FORCE}`,
    `git -C '/tmp/a b' push origin +main`,
    'git push -fu origin main',
    'git push origin "+main"',
    'git push --no-verif',
    `git push ${FORCE.slice(0, -1)}`,
    'git push --force-with-leas',
    `git -c core.hooksPath=/dev/null push`,
    `git -c alias.p='push -f' p`,
  ];
  for (const command of blocked) assert.equal(w.bash(command).code, 2, command);
  assert.equal(w.gateRan(), false);
  assert.equal(w.bash('git -c alias.p=push p').code, 0);
  assert.equal(w.gateRan(), true, 'алиас push — это push: гейт запущен');
});

scenario('вложенные оболочки: sh -c, $(...), бэктики, eval, bash <<EOF, цепочки', { gateExit: 1 }, (w) => {
  const heredoc = ['bash <<EOF', P, 'EOF'].join('\n');
  const blocked = [
    `sh -c "${P} origin main"`,
    `bash -lc '${P}'`,
    `echo $(${P})`,
    `echo \`${P}\``,
    `eval "${P}"`,
    `cd x && ${P}`,
    `false || ${P}`,
    `echo a\n${P}`,
    `(${P})`,
    heredoc,
  ];
  for (const command of blocked) assert.equal(w.bash(command).code, 2, command);
});

scenario('текст, в котором встречается push, — не push', {}, (w) => {
  const passed = [
    `echo ${P}`,
    `echo "${P} ${FORCE}"`,
    `git commit -m "${P} ${FORCE} later"`,
    `cat <<EOF\n${P} ${FORCE}\nEOF`,
    `grep -r "${P}" .`,
    'git pull --rebase',
  ];
  for (const command of passed) assert.equal(w.bash(command).code, 0, command);
  assert.equal(w.gateRan(), false);
});

scenario('незакрытая кавычка — запасной путь: push всё равно ловится', { gateExit: 1 }, (w) => {
  assert.equal(w.bash(`echo "oops; ${P}`).code, 2);
  assert.equal(w.bash(`echo "oops; git status`).code, 0);
});

scenario('проект выбирается по каталогу цели push, а не по cwd сессии', { gateExit: 1 }, (w) => {
  const away = dirname(w.root);
  const blocked = [
    `git -C "${w.root}" push`,
    `cd "${w.root}" && ${P}`,
    `env -C "${w.root}" ${P}`,
    `env --chdir="${w.root}" ${P}`,
    `git --git-dir="${w.root}/.git" push`,
    `GIT_DIR="${w.root}/.git" ${P}`,
    `git -C /somewhere/else push; git -C "${w.root}" push`,
  ];
  for (const command of blocked) assert.equal(w.bashAt(command, away).code, 2, command);
  assert.equal(w.bashAt(P, away).code, 0, 'push из чужого каталога — не наш проект');
  assert.equal(w.bashAt(`git -C /somewhere/else push`, away).code, 0);
});

scenario('--mirror, --delete, :ref и подмена конфигурации — обходы', {}, (w) => {
  const blocked = [
    `${P} --mirror`,
    `${P} --delete origin main`,
    `${P} origin :main`,
    `${P} -d origin main`,
    `git -c remote.origin.mirror=true push`,
    `git -c remote.origin.push=+HEAD:main push`,
    `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null ${P}`,
    `GIT_CONFIG_PARAMETERS="'core.hooksPath=/dev/null'" ${P}`,
  ];
  for (const command of blocked) assert.equal(w.bash(command).code, 2, command);
  assert.equal(w.gateRan(), false);
});

scenario('комментарий, редиректы, here-string и heredoc с цитированным разделителем', { gateExit: 1 }, (w) => {
  const passed = [
    `ls # ${P} ${FORCE}`,
    `echo '$(${P} -f)'`,
    `cat <<< "${P}"`,
    `cat <<\\EOF\n$(${P})\nEOF`,
    `bash script.sh <<EOF\n${P}\nEOF`,
  ];
  for (const command of passed) assert.equal(w.bash(command).code, 0, command);
  assert.equal(w.gateRan(), false);
  const blocked = [`${P} 2>&1`, `${P} > out.txt`, `${P} &> out.txt`, `cat <<EOF\n$(${P})\nEOF`, `echo "$(${P})"`];
  for (const command of blocked) assert.equal(w.bash(command).code, 2, command);
});

scenario('collab не узнал проект из-за битого project.json — запись находится по codeRoot', {}, (w) => {
  w.setCollabAnswer({ projectId: null, registryDir: w.registry, codeRoot: null });
  w.writeRaw(`{"id": "demo", "codeRoot": ${JSON.stringify(w.root)}, oops`);
  const r = w.bash(P);
  assert.equal(r.code, 2);
  assert.match(r.err, /не JSON/);
  w.writeRaw(`{"id": "demo", "codeRoot": "/somewhere/else", oops`);
  assert.equal(w.bash(P).code, 0, 'чужой проект с битым файлом не мешает');
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
