// Тесты hooks/push-gate.mjs — push только через зелёный гейт проекта и без обходов. Запуск — как у хоста,
// через bin/agent-collab-kit-hook; вход — событие Claude: Bash → tool_input.command. Гейт в тестах — .mjs-скрипт
// (одинаково запускается на macOS и Windows); он пишет метку в файл, чтобы видеть, что его вызывали.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const LAUNCHER = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agent-collab-kit-hook');

function run(stdin, home = join(tmpdir(), 'agent-collab-kit-no-such-home'), extraEnv = {}) {
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
  const binDir = join(home, '.agent-collab-kit', 'current', 'bin');
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
    home,
    writeProject,
    writeRaw,
    bash,
    bashAt,
    setCollabAnswer: (obj) => writeFileSync(payload, JSON.stringify(obj)),
    setCollabScript: (text) => writeFileSync(join(binDir, 'collab'), text),
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

// Опасные слова собраны кусками: живой push-gate машины матчит текст любой Bash-команды, в том числе при записи тестов.
const P = ['gi', 't pu', 'sh'].join('');
const FORCE = ['--fo', 'rce'].join('');

scenario('обходы блокируются до запуска гейта', {}, (w) => {
  const cases = [
    `${P} ${FORCE} origin main`,
    `${P} -f`,
    `${P} -uf origin main`,
    `${P} -fu origin main`,
    `${P} --no-verify`,
    `${P} --no-verif`,
    `${P} ${FORCE.slice(0, -1)}`,
    `${P} --force-with-lease`,
    `${P} --force-with-leas`,
    `${P} --force-with-lease=main:abc`,
    `${P} origin +main`,
    `${P} origin "+main"`,
    `${P} --mirror`,
    `${P} --delete origin main`,
    `${P} -d origin main`,
    `${P} origin :main`,
    `git -C /tmp push ${FORCE}`,
    `git p""ush ${FORCE}`,
    `${P} --de origin main`,
  ];
  for (const command of cases) {
    const r = w.bash(command);
    assert.equal(r.code, 2, command);
    assert.match(r.err, /^push-gate: `/, command);
  }
  assert.equal(w.gateRan(), false, 'обход отсекается раньше гейта');
});

scenario('простой push проходит через гейт: обычные формы не страдают', { gateExit: 1 }, (w) => {
  const away = dirname(w.root);
  const viaGate = [
    [P, w.root],
    [`${P} -u origin main`, w.root],
    [`${P} origin HEAD:main`, w.root],
    [`${P} --tags`, w.root],
    [`${P} -o ci.skip origin main`, w.root],
    [`${P} origin main 2>&1 | tail -5`, w.root],
    [`${P} origin main |& tail -5`, w.root],
    [`git --no-pager push`, w.root],
    [`${P} -ofoo origin main`, w.root],
    [`${P} -uoci.skip origin main`, w.root],
    [`g\\\nit push origin main`, w.root],
    [`${P} > out.txt`, w.root],
    [`git commit -m "fix (x) #1" && ${P}`, w.root],
    [`scripts/preflight.sh && ${P}`, w.root],
    [`echo ok\n${P}`, w.root],
    [`${P} || echo failed`, w.root],
    [`cd "${w.root}" && ${P}`, away],
    [`cd "${w.root}"; ${P}`, away],
    [`cd project && ${P}`, away],
    [`git -C "${w.root}" push`, away],
    [`git -C project push`, away],
  ];
  for (const [command, cwd] of viaGate) {
    const r = w.bashAt(command, cwd);
    assert.equal(r.code, 2, command);
    assert.match(r.err, /гейт gate\.mjs красный/, command);
  }
  assert.equal(w.bashAt(P, away).code, 0, 'push из чужого каталога — не наш проект');
});

scenario('не push проходит и гейт не запускается', {}, (w) => {
  const passed = [
    'git status',
    'git pull --rebase',
    'git commit -m "push later"',
    `git commit -m "${P} ${FORCE} later"`,
    `git log --grep push`,
    'echo pushing',
    `echo ${P}`,
    `echo "${P} ${FORCE}"`,
    `grep -r "${P}" .`,
    `ls # ${P} ${FORCE}`,
    'npm run push-assets',
    'git stash push -m wip',
    'git checkout fix/push-retry',
    `git log --oneline | grep push`,
  ];
  for (const command of passed) assert.equal(w.bash(command).code, 0, command);
  assert.equal(w.gateRan(), false);
});

// Всё, что хук не может доказать простым, — блок без запуска гейта, даже при зелёном гейте.
scenario('сомнение — блок: подстановки, heredoc, вложенные оболочки, обёртки', {}, (w) => {
  const blocked = [
    `sh -c "${P} origin main"`,
    `bash -lc '${P}'`,
    `echo $(${P})`,
    `echo \`${P}\``,
    `eval "${P}"`,
    `(${P})`,
    `{ ${P}; }`,
    `${P} &\necho done`,
    ['bash <<EOF', P, 'EOF'].join('\n'),
    `cat <<EOF\n${P} ${FORCE}\nEOF`,
    `cat <<< "${P}"`,
    `echo '$(${P} -f)'`,
    `echo "oops; ${P}`,
    `echo ${P} | sh`,
    `echo ${FORCE} | xargs ${P} origin main`,
    `${P} origin main $(echo ${FORCE})`,
    `F=${FORCE}; ${P} origin main $F`,
    `export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null; ${P}`,
    `GIT_DIR=/tmp/.git ${P}`,
    `env -C /tmp ${P}`,
    `arch -arm64 ${P} -f`,
    `xcrun ${P}`,
    `caffeinate ${P}`,
    `sudo ${P}`,
    `git -c core.hooksPath=/dev/null push`,
    `git -c alias.p='push -f' p`,
    `git -c alias.p=push -c alias.q='p -f' q`,
    `git -c alias.q='-c core.hooksPath=/dev/null push' q`,
    `git --git-dir=/tmp/.git push`,
    `git --work-tree=/tmp push`,
    `git-push origin main`,
    // Ревью R5: слово push спрятано или исполняется другой подкомандой/программой.
    `git pu\\\nsh ${FORCE}`,
    `g\\\nit push ${FORCE} origin main`,
    `git $'\\x70ush' ${FORCE}`,
    `git $'\\160ush' origin main`,
    `git -c help.autocorrect=immediate puhs ${FORCE}`,
    `git rebase -x '${P} ${FORCE}' HEAD~1`,
    `git submodule foreach '${P} ${FORCE}'`,
    `git bisect run ${P} -f`,
    `git config alias.fp 'push ${FORCE}' && git fp`,
    `echo '${P} ${FORCE}' | tcsh`,
    `echo '${P} ${FORCE}' | csh`,
    `echo 'import os; os.system("${P} ${FORCE}")' | python3`,
    `echo '${P}' | tee x | sh`,
    // Ревью R6 (Codex).
    `g$''it push ${FORCE}`,
    `git p$""ush ${FORCE}`,
    `g$@it push ${FORCE}`,
    `git grep --open-files-in-pager="${P} ${FORCE} #" x -- README.md`,
    `git grep -O"${P}" x`,
    `git fetch --upload-pack='${P} ${FORCE}' origin`,
    `${P} &`,
    `${P} 2>&1 &`,
    // Ревью R7 (Codex): слово git спрятано escape-последовательностями.
    `$'\\x67it' push -f`,
    `printf '\\147it push -f\\n' | sh`,
    `printf '\\147it \\160ush -f\\n' | sh`,
    `echo -e '\\x67it push -f' | bash`,
  ];
  for (const command of blocked) {
    const r = w.bash(command);
    assert.equal(r.code, 2, command);
    assert.doesNotMatch(r.err, /гейт gate\.mjs красный/, command);
  }
  assert.equal(w.gateRan(), false);
});

scenario('находки ревью R4: разбор, расходящийся с bash, больше не пропускает', {}, (w) => {
  const blocked = [
    `echo "$(echo '"')"; ${P} -f origin main #'`,
    `echo $((1<<2))\n${P} -f origin main`,
    `cd "${w.root}" && ${P}; echo "$(echo '"')"`,
  ];
  for (const command of blocked) assert.equal(w.bashAt(command, dirname(w.root)).code, 2, command);
  assert.equal(w.gateRan(), false);
});

scenario('git -C разрешает `..` после симлинка физически, как chdir; cd — логически, как bash', { gateExit: 1 }, (w) => {
  if (process.platform === 'win32') return;
  const away = dirname(w.root);
  mkdirSync(join(w.root, 'inner'), { recursive: true });
  symlinkSync(join(w.root, 'inner'), join(away, 'lnk'));
  const physical = w.bashAt('git -C lnk/.. push', away);
  assert.equal(physical.code, 2, 'lnk/.. для git — это проект, гейт запускается');
  assert.match(physical.err, /гейт gate\.mjs красный/);
  assert.equal(w.bashAt(`cd lnk/.. && ${P}`, away).code, 0, 'cd lnk/.. в bash — лексически обратно в чужой каталог');
  assert.equal(w.bashAt(`cd -P lnk/.. && ${P}`, away).code, 2, 'cd -P — физически, в проект');
});

scenario('каталог push не определить — блок, а не каталог сессии', {}, (w) => {
  const away = dirname(w.root);
  const blocked = [
    `f() { cd /tmp; }; ${P}`,
    `case x in y) cd /tmp;; esac; ${P}`,
    `pushd /tmp; popd; ${P}`,
    `cd "$D" && ${P}`,
    `cd - && ${P}`,
    `cd /no/such/dir && ${P}`,
    `git -C /no/such/dir push`,
    `false && cd "${w.root}"; ${P}`,
    `true && cd /tmp; ${P}`,
    `cd /tmp || cd "${w.root}"; ${P}`,
    `cd /tmp | cat; ${P}`,
    `cd -Z /tmp; ${P}`,
    `cd -e /tmp; ${P}`,
    `cd /tmp extra; ${P}`,
  ];
  for (const command of blocked) {
    const r = w.bashAt(command, away);
    assert.equal(r.code, 2, command);
    assert.doesNotMatch(r.err, /гейт gate\.mjs красный/, command);
  }
  assert.equal(w.gateRan(), false);
});

scenario('гейт, не уложившийся во время, блокирует push', { gate: 'slow.mjs' }, (w) => {
  writeFileSync(join(w.root, 'slow.mjs'), 'setTimeout(() => {}, 30000);\n');
  const r = w.bash(P, { PUSH_GATE_SECONDS: '1' });
  assert.equal(r.code, 2);
  assert.match(r.err, /не уложился в 1 с/);
});

scenario('нет настройки gate — push проходит; объявленный gate без файла — блок', {}, (w) => {
  w.writeProject(null);
  assert.equal(w.bash(P).code, 0);
  w.writeProject('no/such/gate.mjs');
  const r = w.bash(P);
  assert.equal(r.code, 2);
  assert.match(r.err, /no\/such\/gate\.mjs/);
  assert.equal(w.gateRan(), false);
});

scenario('битый project.json зарегистрированного проекта блокирует push, не-строка в gate — тоже', {}, (w) => {
  w.writeRaw('{ not json');
  assert.equal(w.bash(P).code, 2);
  w.writeRaw(JSON.stringify({ id: 'demo', gate: 42 }));
  assert.equal(w.bash(P).code, 2);
  w.writeRaw(JSON.stringify({ id: 'demo' }));
  assert.equal(w.bash(P).code, 0, 'нет ключа gate — защищаться нечем');
});

scenario('collab не узнал проект из-за битого project.json — запись находится по roots', {}, (w) => {
  w.setCollabAnswer({ projectId: null, registryDir: w.registry, codeRoot: null });
  w.writeRaw(`{"id": "demo", "roots": [${JSON.stringify(w.root)}], "gate": "gate.mjs", oops`);
  const r = w.bash(P);
  assert.equal(r.code, 2);
  assert.match(r.err, /не JSON/);
  w.writeRaw(`{"id": "demo", "roots": ["/somewhere/else"], "gate": "gate.mjs", oops`);
  assert.equal(w.bash(P).code, 0, 'чужой проект с битым файлом не мешает');
});

scenario('схема реестра проверяется правилами самого collab', {}, (w) => {
  w.setCollabAnswer({ projectId: null, registryDir: w.registry, codeRoot: null });
  w.writeRaw(JSON.stringify({ id: 'other', roots: [w.root], gate: 'gate.mjs' }));
  const wrongId = w.bash(P);
  assert.equal(wrongId.code, 2);
  assert.match(wrongId.err, /must equal its directory name/);
  w.writeRaw(JSON.stringify({ id: 'demo', roots: [w.root], gate: 'gate.mjs', legacy_journal: 'yes' }));
  assert.match(w.bash(P).err, /legacy_journal must be true or false/);
  w.writeRaw(JSON.stringify({ id: 'demo', roots: [w.root, '/'], gate: 'gate.mjs' }));
  assert.match(w.bash(P).err, /filesystem root or the home directory/);
  w.writeRaw(JSON.stringify({ id: 'demo', roots: 'oops', gate: 'gate.mjs' }));
  assert.equal(w.bash(P).code, 0, 'roots не массив — к каталогу запись не привязать');
  w.writeRaw(JSON.stringify({ id: 'other', roots: ['/somewhere/else'], gate: 'gate.mjs' }));
  assert.equal(w.bash(P).code, 0, 'неверная схема у чужого проекта не мешает');
});

scenario('collab ответил ошибкой или не ответил — блок, если реестр заявляет каталог', {}, (w) => {
  w.setCollabAnswer({ error: { code: 'CONFIG', message: 'claimed by more than one registry project' }, registryDir: w.registry, codeRoot: w.root });
  const r = w.bash(P);
  assert.equal(r.code, 2);
  assert.match(r.err, /claimed by more than one/);
  assert.equal(w.bashAt(P, dirname(w.root)).code, 0, 'чужой каталог не заявлен — защищаться нечем');
  // Не ответивший collab не называет реестр: хук ищет запись там, где её держит collab по умолчанию.
  mkdirSync(join(w.home, '.agent-collab-kit', 'projects', 'demo'), { recursive: true });
  writeFileSync(join(w.home, '.agent-collab-kit', 'projects', 'demo', 'project.json'), JSON.stringify({ id: 'demo', roots: [w.root], gate: 'gate.mjs' }));
  w.setCollabScript('setTimeout(() => {}, 30000);\n');
  const hung = w.bash(P, { PUSH_GATE_SECONDS: '1' });
  assert.equal(hung.code, 2);
  assert.match(hung.err, /не ответил/);
  assert.equal(w.bashAt(P, dirname(w.root), { PUSH_GATE_SECONDS: '1' }).code, 0);
  // Ненулевой код collab — сбой, даже если в stdout валидный ответ «не зарегистрирован».
  w.setCollabScript(`process.stdout.write(${JSON.stringify(JSON.stringify({ projectId: null, registryDir: w.registry, codeRoot: null }))}); process.exit(1);\n`);
  const crashed = w.bash(P);
  assert.equal(crashed.code, 2);
  assert.match(crashed.err, /завершился с кодом 1/);
  assert.equal(w.gateRan(), false);
});

scenario('нечитаемая чужая запись реестра не блокирует незарегистрированный каталог', {}, (w) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) return;
  w.setCollabAnswer({ projectId: null, registryDir: w.registry, codeRoot: null });
  mkdirSync(join(w.registry, 'old'), { recursive: true });
  const file = join(w.registry, 'old', 'project.json');
  writeFileSync(file, JSON.stringify({ id: 'old', roots: ['/somewhere/else'], gate: 'gate.mjs' }));
  chmodSync(file, 0o000);
  try {
    assert.equal(w.bashAt(P, dirname(w.root)).code, 0);
  } finally {
    chmodSync(file, 0o600);
  }
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
