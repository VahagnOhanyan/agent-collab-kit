// Тесты hooks/readonly-guard.mjs (PreToolUse на Bash у субагента verifier). Хук запускается как у
// хоста — через bin/agent-kit-hook отдельным процессом. Хост блокирует ТОЛЬКО по коду 2; любой другой
// код, падение или таймаут — команда проходит, поэтому каждый нештатный путь обязан давать ровно 2.
// Опасные команды НЕ исполняются — проверяется только классификация.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCHER = join(ROOT, 'bin', 'agent-kit-hook');
const HOOK = join(ROOT, 'hooks', 'readonly-guard.mjs');
const WINDOWS = process.platform === 'win32';
const CYRILLIC = /[А-Яа-яЁё]/;
const skipPosix = WINDOWS ? 'проверки POSIX-путей и прав' : false;

const TEMP = [];
process.on('exit', () => TEMP.forEach((d) => rmSync(d, { recursive: true, force: true })));
function tempDir(prefix) {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  TEMP.push(d);
  return d;
}

// Временный HOME с заглушкой `collab project --json` по боевому пути и реестром проекта.
function makeWorld({ settings, rawSettings, info, exitCode = 0 } = {}) {
  const base = tempDir('ro-guard-');
  const registry = join(base, 'registry');
  mkdirSync(join(registry, 'demo'), { recursive: true });
  const file = join(registry, 'demo', 'readonly-guard.json');
  if (rawSettings !== undefined) writeFileSync(file, rawSettings);
  else if (settings !== undefined) writeFileSync(file, JSON.stringify(settings));
  const home = join(base, 'home');
  const binDir = join(home, '.agent-kit', 'current', 'bin');
  mkdirSync(binDir, { recursive: true });
  const payload = join(binDir, 'collab.payload');
  writeFileSync(payload, JSON.stringify(info ?? { projectId: 'demo', registryDir: registry }));
  writeFileSync(join(binDir, 'collab'),
    `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(payload)}));\nprocess.exitCode = ${exitCode};\n`);
  return envFor(home);
}

function envFor(home) {
  return { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' };
}

const ENV = makeWorld({ settings: { platforms: ['apple'] } });
const NO_COLLAB_ENV = envFor(WINDOWS ? 'C:\\nonexistent' : '/nonexistent');
const DEFAULT_CWD = WINDOWS ? 'C:\\' : '/';

function runGuard(stdin, { env = ENV, timeout = 25_000 } = {}) {
  const input = typeof stdin === 'string' || Buffer.isBuffer(stdin) ? stdin : JSON.stringify(stdin);
  const proc = spawnSync(process.execPath, [LAUNCHER, 'readonly-guard'], { input, env, cwd: tmpdir(), timeout });
  return { code: proc.status, err: (proc.stderr ?? Buffer.alloc(0)).toString('utf8') };
}

const bash = (command, { tool = 'Bash', cwd = DEFAULT_CWD } = {}) => ({ tool_name: tool, tool_input: { command }, cwd });

function assertAllowed(command, cwd = DEFAULT_CWD) {
  const r = runGuard(bash(command, { cwd }));
  assert.equal(r.code, 0, `${JSON.stringify(command)} должна пройти, stderr=${r.err}`);
  assert.equal(r.err, '');
}

function assertBlocked(command, cwd = DEFAULT_CWD, contains = []) {
  const r = runGuard(bash(command, { cwd }));
  assert.equal(r.code, 2, `${JSON.stringify(command)} должна блокироваться, stderr=${r.err}`);
  assertBlockMessage(r.err, command);
  assert.ok(r.err.includes('не проверено'), r.err);
  for (const fragment of contains) assert.ok(r.err.includes(fragment), `нет ${fragment} в ${r.err}`);
  return r.err;
}

function assertBlockMessage(err, what) {
  assert.ok(err.startsWith('readonly-guard: '), `${what}: ${err}`);
  assert.match(err, CYRILLIC);
  assert.doesNotMatch(err, /\n\s+at /, `${what}: стек в сообщении`);
}

const checkAll = (commands, expected, cwd) => {
  for (const c of commands) (expected === 0 ? assertAllowed : assertBlocked)(c, cwd);
};

// ── настройки проекта ────────────────────────────────────────────────────────

const XCODE = 'xcodebuild -list';
const codeIn = (command, env) => runGuard(bash(command), { env });

test('платформа, включённая проектом, проходит; политика аргументов остаётся', () => {
  const env = makeWorld({ settings: { platforms: ['apple'] } });
  for (const c of [XCODE, 'xcrun simctl list', 'swift test', 'plutil -p I.plist', ...(WINDOWS ? [] : ['/usr/bin/xcodebuild -list'])]) {
    assert.equal(codeIn(c, env).code, 0, c);
  }
  assert.equal(codeIn('xcodebuild archive', env).code, 2);
});

test('платформа не включена — блок «платформенная»', () => {
  for (const env of [makeWorld({ settings: { platforms: [] } }), makeWorld(), makeWorld({ info: { projectId: null } })]) {
    const r = codeIn(XCODE, env);
    assert.equal(r.code, 2);
    assert.ok(r.err.includes('платформенная'), r.err);
  }
});

test('неизвестный проект блокирует платформенные команды, но не читателей', () => {
  for (const env of [NO_COLLAB_ENV, makeWorld({ exitCode: 1 }), makeWorld({ info: { error: 'x' } })]) {
    assert.equal(codeIn(XCODE, env).code, 2, env.HOME);
    assert.equal(codeIn('ls -la', env).code, 0, env.HOME);
  }
});

test('битые настройки проекта — блок', () => {
  for (const env of [makeWorld({ settings: { platforms: ['android'] } }), makeWorld({ settings: { platforms: 'apple' } }),
    makeWorld({ settings: { extra: true } }), makeWorld({ settings: { deny_routing_audit: true } }),
    makeWorld({ rawSettings: '{not json' })]) {
    assert.equal(codeIn(XCODE, env).code, 2);
  }
});

test('jq — обычный читатель без поиска проекта', () => {
  for (const c of ['jq . f.json', 'jq -s -f /x/agents/any-filter.jq t.jsonl']) assert.equal(codeIn(c, NO_COLLAB_ENV).code, 0, c);
});

// ── нештатные входы ──────────────────────────────────────────────────────────

test('нештатный вход — код 2 и русское сообщение', () => {
  const cases = {
    'invalid json': 'not { valid json',
    'empty stdin': '',
    'whitespace stdin': '  \n',
    'non-utf8 bytes': Buffer.concat([Buffer.from('{"tool_name": "Bash", "tool_input": {"command": "ls '), Buffer.from([0xff]), Buffer.from('"}}')]),
    'escaped NUL': JSON.stringify(bash('ls\u0000')),
    'raw NUL': Buffer.from('{"tool_name": "Bash", "tool_input": {"command": "ls\u0000"}}'),
    'lone surrogate': JSON.stringify(bash('ls PLACEHOLDER')).replace('PLACEHOLDER', '\\ud800'),
    'array event': '[]',
    'null event': 'null',
    'string event': '"ls"',
    'no tool_input': '{"tool_name": "Bash"}',
    'tool_input not object': '{"tool_name": "Bash", "tool_input": "ls"}',
    'missing command': '{"tool_name": "Bash", "tool_input": {}}',
    'int command': '{"tool_name": "Bash", "tool_input": {"command": 42}}',
    'list command': '{"tool_name": "Bash", "tool_input": {"command": ["ls"]}}',
    'null command': '{"tool_name": "Bash", "tool_input": {"command": null}}',
    'empty command': '{"tool_name": "Bash", "tool_input": {"command": "  \\n"}}',
  };
  for (const [what, raw] of Object.entries(cases)) {
    const r = runGuard(raw);
    assert.equal(r.code, 2, `${what}: ${r.err}`);
    assertBlockMessage(r.err, what);
  }
});

test('неверный или отсутствующий tool_name — блок', () => {
  for (const tool of [undefined, '', 'bash', 'Edit', 'Write', 'Read', 1]) {
    const event = bash('git status');
    if (tool === undefined) delete event.tool_name;
    else event.tool_name = tool;
    const r = runGuard(event);
    assert.equal(r.code, 2, String(tool));
    assertBlockMessage(r.err, String(tool));
  }
});

// ── allow-set ────────────────────────────────────────────────────────────────

const COORDINATOR_SET = [
  'git status', 'git diff --stat', 'git log -3 --oneline', 'git show HEAD --stat', 'git branch',
  'git worktree list', 'git config --get user.name', 'ls -la', 'rg -n foo src', '/usr/bin/grep -rn x .',
  'cat README.md | head -20', 'node --test tests/', '/usr/bin/python3 -m unittest -v tests/test_x.py',
  'scripts/preflight.sh --quiet', 'xcodebuild -project X.xcodeproj -scheme S build-for-testing',
  'xcrun simctl list devices', 'git log --oneline | wc -l', "find . -name '*.swift' -type f",
  'jq . package.json',
];
const MORE_ALLOWED = [
  'git status --porcelain', 'git --no-pager diff --stat', 'git --no-pager log -5', 'git --version',
  'git log --grep commit', 'git log -p -- src/a.swift', "git log --format='%h %s' -3", 'git blame f',
  'git ls-files', 'git ls-tree HEAD', 'git cat-file -p HEAD:f', 'git rev-parse HEAD', 'git rev-list --count HEAD',
  'git describe --tags', 'git shortlog -sn', 'git grep foo', 'git merge-base main HEAD', 'git diff --no-index a b',
  'git branch --list', 'git branch -a', 'git branch -r', 'git branch -v', 'git branch -vv',
  'git branch --show-current', 'git branch 2>/dev/null', 'git worktree list --porcelain', 'git remote',
  'git remote -v', 'git config --list', 'git config -l', 'git config --global --get user.email',
  'git config --get-all remote.origin.url', 'git stash list', 'git stash show -p', "git stash show 'stash@{0}'",
  'git tag', "git tag -l 'v*'", 'git tag --list -n',
  'ls', 'cat file', 'head -5 file', 'tail -n +5 file', 'wc -l f', 'file f', 'file --mime-type f', 'stat f',
  'du -sh .', 'df -h', 'pwd', 'which rg', 'command -v rg', 'echo hi', "printf '%s\\n' x", 'date', 'date +%s',
  'date -u -r 0', 'uname -a', 'whoami', 'id -u', 'env', 'env | sort', 'grep -rn x .', 'egrep -n x f',
  'rg foo', "rg 'a -> b'", "rg '$HOME'", 'rg "\\$HOME"', "rg 'foo; rm x'", 'rg -e pre f',
  "find . -type f -name '*.o'", 'sort -rn f', 'sort -k2,2n -t, f', 'sort -u', 'uniq -c', 'uniq -f 1 f',
  'cut -d: -f1 f', 'tr a-z A-Z', "jq 'map(. + 1)' f", 'jq -r .name package.json', 'jq --rawfile x f .',
  'diff -u a b', 'cmp a b', 'comm -12 a b', 'basename /a/b', 'dirname /a/b', 'realpath .', 'readlink f',
  'shasum -a 256 f', 'md5 f', 'plutil -p Info.plist', 'plutil -lint Info.plist', 'sw_vers',
  'sw_vers -productVersion', 'xcode-select -p', 'cat tests/*.py', 'ls ./*.md', 'rg привет src',
  'node --test', 'node --test --test-reporter=spec tests/', 'node --test --test-name-pattern foo tests/',
  'node --check scripts/x.js', 'node --version', 'python3 -m unittest', 'python3 -m unittest -v',
  'python3 -m unittest tests.test_x', "python3 -m unittest discover -s tests -p 'test_*.py'",
  'python3 -m pytest -q tests/', 'python3 -m pytest -k foo -p no:cacheprovider tests/test_x.py::TestA',
  'python3 -m pytest -ra --tb=short', 'python3 --version', 'npm test', 'npm test -- --grep x', 'npm run',
  'npm run build', 'npm run lint -- --fix=false', 'pnpm test', 'yarn test', 'swift test', 'swift build',
  'swift test --filter Foo', 'swift build -c release', 'swift --version', 'xcodebuild -list',
  'xcodebuild build-for-testing -scheme X', 'xcodebuild -showBuildSettings -scheme X',
  "xcodebuild -workspace W.xcworkspace -scheme S -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max' build-for-testing CODE_SIGNING_ALLOWED=NO",
  'xcodebuild -scheme S -quiet build',
  'bash scripts/preflight.sh', 'sh scripts/preflight.sh --flag', './scripts/preflight.sh',
  '/bin/bash scripts/preflight.sh', '/bin/sh scripts/preflight.sh',
  'xcrun simctl list', 'xcrun simctl list devices available -j', 'xcrun --find swift', 'xcrun --show-sdk-path',
  'xcrun --sdk iphonesimulator --show-sdk-path', 'collab project --json', 'collab project',
  'collab reviews --task tsk_mu6xmxc2_d31d6b --json', 'collab reviews --json', 'collab reviews',
  'collab reviews --pending --reviewer codex --json',
  'ls >/dev/null 2>&1', 'ls > /dev/null', 'cat a 2>/dev/null', 'cat a 2> /dev/null', 'ls 2>&1 | head',
  'git status; git diff', 'git status\ngit diff --stat\n', 'git status && git diff', 'ls || pwd',
  'git log --oneline | head -20 | wc -l', 'git status\n',
];

function projectWithGate() {
  const cwd = tempDir('ro-proj-');
  mkdirSync(join(cwd, 'scripts'));
  writeFileSync(join(cwd, 'scripts', 'preflight.sh'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(cwd, 'scripts', 'preflight.sh'), 0o755);
  return cwd;
}

test('allow-set координатора проходит', { skip: skipPosix }, () => checkAll(COORDINATOR_SET, 0, projectWithGate()));
test('расширенный allow-set проходит', { skip: skipPosix }, () => checkAll(MORE_ALLOWED, 0, projectWithGate()));

// ── обходы старого denylist ──────────────────────────────────────────────────

test('обходы denylist блокируются', () => checkAll([
  'p=../../Users/x/victim; echo x > /private/tmp/$p', 'p=../..', 'git -c alias.x=commit x -m y',
  "git -c core.pager='rm victim' -p log", 'git -c core.pager=x log', 'git xx',
  'wipe(){ "$@"; }; wipe rm victim', 'function wipe { rm x; }',
  "vim -Nu NONE -n -es -c 'call delete(\"victim\")' -c qa", "arch -arm64 osascript -e 'do shell script \"rm victim\"'",
  'xcrun simctl --set /tmp/device_set erase all', 'xcrun simctl erase all',
], 2));

// ── токенизатор ──────────────────────────────────────────────────────────────

const REJECTED_SYNTAX = [
  'echo $HOME', 'echo $IFS', "echo $'\\x72m' x", 'echo $"x"', 'echo ${HOME}', 'echo $(rm x)', 'echo `rm x`',
  'echo "$HOME"', 'echo "`rm x`"', 'cat <(ls)', 'ls >(cat)', '{ rm x; }', '(rm x)', 'echo {a,b}',
  'ls \\\nrm x', 'ls\\\n', '\\rm x', 'ls &', 'ls & rm x', 'ls &>/dev/null', 'ls |& cat', 'cat <<EOF\nrm x\nEOF',
  'cat <<< x', 'cat < file', 'cat </dev/fd/0', 'cat </dev/stdin', 'eval ls', 'exec ls', 'source env.sh',
  '. ./env.sh', '. x', 'alias x=ls', 'ls*', 'l?', '[ -f x ]', 'VAR=x ls', 'FOO=1 git status', 'ls ~',
  'ls ~/x', 'ls !x', '! ls', 'ls # comment', '# comment\nls', '=ls', "'ls'", '"ls"', '"l"s', "'r'm x",
  'ls\r', 'ls\u0001', "ls 'unterminated", 'ls "unterminated', 'ls;;ls', '| ls', 'ls |', 'ls &&', 'ls ||',
  ';', 'ls; ; ls', 'ls | | ls', '>/dev/null', '2>/dev/null',
  'echo hi > file', 'echo hi >file', 'echo hi >> file', 'echo hi > /tmp/x', 'echo hi > /private/tmp/x',
  'ls > /dev/null/x', 'ls >/dev/nullx', 'ls 2>err', 'ls 1>out', 'echo err >&2', 'ls >&out', 'ls 2>&12',
  'ls 3>/dev/null', 'ls >| x', "ls > '/dev/null'", 'git status\nrm x', 'ls *.md', 'ls -*', 'ls ?x',
  'ls [a]*', "cat '-'*",
];

test('синтаксис, который shell истолкует иначе, — блок', () => checkAll(REJECTED_SYNTAX, 2));

test('метасимволы в кавычках — буквальные', () => checkAll([
  "rg '$(rm x)'", "rg '`rm x`'", "rg '{a,b}'", "rg '(x)'", "rg '<file'", "rg '~'", "rg 'a & b'", "rg 'a | b'",
  "rg 'a; rm x'", "rg '#x'", "rg 'x='", 'echo "a > b"', 'echo "\\$x"', "echo 'x\ny'", "printf '%s\\n' a",
], 0));

test('сообщение блока называет команду и путь эскалации', () => {
  const err = assertBlocked('osascript -e x', DEFAULT_CWD, ['`osascript`', 'не проверено', 'лид']);
  assert.ok(err.includes('allowlist'));
  assertBlocked('git commit -m x', DEFAULT_CWD, ['`git commit`', 'не проверено']);
  assertBlocked('echo $x', DEFAULT_CWD, ['`$`']);
});

// ── команды вне allowlist и опасные флаги ────────────────────────────────────

const UNKNOWN_COMMANDS = [
  'rm x', 'rm -rf build', 'mv a b', 'cp a b', 'mkdir d', 'touch f', 'chmod +x f', 'ln -s a b', 'sed -n 1p f',
  'sed -i s/a/b/ f', "awk '{print}' f", 'perl -e 1', 'ruby x.rb', 'tee out', 'tee /dev/null', 'xargs ls',
  'curl -s https://x', 'wget https://x', 'ssh host', 'scp a b', 'rsync a b', 'kill 1', 'killall x', 'open .',
  'osascript -e x', 'osascript s.scpt', 'arch -arm64 ls', 'nohup ls', 'timeout 5 ls', 'nice ls', 'nice -n 5 ls',
  'time ls', 'caffeinate ls', 'sudo ls', 'env ls', 'env FOO=1 ls', 'command ls', 'command -p ls', 'command -V ls',
  'builtin ls', 'cd x', 'cd x && ls', 'pushd x', 'export X=1', 'unset X', 'set -e', 'true', 'false', 'test -f x',
  'type ls', 'sleep 1', 'ps aux', 'lsof', 'vim f', 'vi f', 'nano f', 'less f', 'more f', 'make', 'make test',
  'brew install x', 'pip install x', 'pip3 list', 'npx tsc', 'npx -y x', 'zsh scripts/x.sh', 'dash x.sh',
  "psql -c 'DROP TABLE x'", 'sqlite3 db', 'docker ps', 'simctl list', 'devicectl list', 'xcrun devicectl list',
  'codesign -s x', 'security find-identity', 'defaults write x y z', 'launchctl list', 'say hi', 'pytest',
  'swift', 'node', 'python3', '/bin/rm x', '/usr/bin/touch f', '/usr/bin/vim f', '/usr/local/bin/rg x',
  '/opt/homebrew/bin/rg x', '/usr/bin/../bin/rm x', '/usr/bin/env ls', '/nonexistent/.agent-kit/current/bin/collab inbox',
  'collab inbox', 'collab init', 'collab project --json --x',
  'collab task tsk_x', 'collab claim tsk_x', 'collab release-review rev_x', 'collab reviews --task',
  "collab reviews --task 'a;b'", 'collab reviews --task x/y', 'collab reviews --all', 'collab reviews --json --x',
];
const GIT_DENIED = [
  'git commit -m x', 'git push', 'git push origin main', 'git pull', 'git fetch', 'git add .', 'git rm x',
  'git mv a b', 'git checkout main', 'git switch -c x', 'git restore f', 'git reset --hard', 'git rebase main',
  'git merge x', 'git cherry-pick abc', 'git revert abc', 'git clean -fd', 'git apply p.diff', 'git am x',
  'git init', 'git clone https://x/y.git', 'git gc', 'git prune', 'git bisect start', 'git update-ref x y',
  'git update-index --assume-unchanged f', 'git format-patch -1', 'git submodule status',
  'git submodule update --init', 'git help', 'git help --web log', 'git',
  'git -C . status', 'git -c user.name=x status', 'git --git-dir .git status', 'git --git-dir=.git status',
  'git --work-tree=. status', 'git --exec-path=/x status', 'git -p log', 'git --paginate log', 'git -P log',
  'git --no-pager -c x=y log', 'git --no-pager', 'git --no-pager --no-pager log',
  'git branch new', 'git branch -d x', 'git branch -D x', 'git branch -m a b', 'git branch -c a b',
  'git branch -f main HEAD', 'git branch -u origin/main', 'git branch --delete x', 'git branch --merged main',
  'git branch --merged', 'git branch --contains HEAD', 'git branch --list x', 'git branch --set-upstream-to=o/m',
  'git worktree add ../x', 'git worktree remove x', 'git worktree prune', 'git worktree list x',
  'git remote add o u', 'git remote remove o', 'git remote set-url o u', 'git remote show origin',
  'git remote -v show', 'git config user.name x', 'git config --global core.editor vim', 'git config --unset x',
  'git config --add x y', 'git config -e', 'git config --edit', 'git config', 'git config --global',
  'git config --get --file x y', 'git config -f x --get y', 'git config --blob x --get y',
  'git config --get x --list', 'git config set x y', 'git stash', 'git stash push -m x', 'git stash pop',
  'git stash drop', 'git stash apply', 'git stash save wip', 'git stash; ls', 'git tag v1', 'git tag -a v1',
  'git tag -d v1', 'git tag -l -d v1', 'git tag --list --sort=x', 'git tag -f v1',
  'git diff --output=x', 'git diff --output x', 'git log --output=x', 'git show --output=x', 'git diff --ext-diff',
  'git log --ext-diff', 'git show --textconv HEAD:f', 'git diff --textconv', 'git cat-file --textconv HEAD:f',
  'git cat-file --filters HEAD:f', 'git grep -Ovim x', 'git grep -O x', 'git grep --open-files-in-pager x',
  'git stash show --ext-diff', 'git stash list --output=x', 'git diff --output-indicator-new=+',
  "git 'commit' -m x", 'git "commit"',
];
const READER_FLAGS_DENIED = [
  'find . -delete', 'find . -name x -delete', "find . -exec rm '{}' ';'", "find . -execdir rm '{}' ';'",
  "find . -ok rm '{}' ';'", "find . -okdir rm '{}' ';'", 'find . -fprint out', 'find . -fprint0 out',
  "find . -fprintf out '%p'", 'find . -fls out', "find . -name '*.o' -exec rm {} \\;",
  "find . -name '*.swift' -exec grep -l foo {} +", 'rg --pre cat x', 'rg --pre=cat x', "rg --pre-glob '*' x",
  'rg -e --pre f',
  'sort -o out f', 'sort -no out f', 'sort -ro out', 'sort --output=out', 'sort --output out', 'sort --out out',
  'sort -T /tmp f', 'sort --compress-program=x', 'sort --temporary-directory=/x', 'uniq in out', 'uniq -c in out',
  'file -C -m magic', 'file -C', 'file --compile x', 'file --comp x', 'date 0912', 'date -f x y', 'date -s x',
  'date --set=x', 'plutil -convert xml1 x', 'plutil -replace k -string v x', 'plutil -p -o x f',
  'plutil -insert k -string v x', 'plutil f', 'xcode-select -s /x', 'xcode-select --install',
  'xcode-select -r', 'xcode-select', 'env -i', 'env X=1', 'command -v', 'command -v -p ls', 'date -f',
  'printf -v PATH /tmp; cat', 'printf -v PATH /tmp', 'printf -vPATH x', 'printf -v x y',
  'rg -z needle f', 'rg -nz x', 'rg -zn x', 'rg --search-zip x', 'rg --search-zip=true x',
];
const RUNNER_DENIED = [
  'node x.js', 'node scripts/check.js', 'node -e 1', 'node --eval 1', 'node -p 1', 'node -r x --test',
  'node --test -r x', 'node --test --require x tests/', 'node --test --watch', 'node --test /abs/tests',
  'node --test ../tests', 'node --test tests/../../x', 'node --test --test-reporter=./x.js',
  'node --test --test-reporter /abs/x.js', 'node --test --test-reporter-destination=/x tests/',
  'node --test --test-reporter', 'node --check /etc/passwd', 'node --check', 'node --check a b',
  'node --input-type=module', 'node -', 'node --test -e 1',
  "python3 -c 'print(1)'", 'python3 x.py', 'python3 -', 'python3 -m pip install x', 'python3 -m http.server',
  'python3 -m unittest.__main__', 'python3 -mpytest', 'python3 -B -m unittest', 'python3 -X dev -m unittest',
  'python3 -m', 'python3 -m pytest -c cfg', 'python3 -m pytest -o x=y', 'python3 -m pytest --rootdir=/x',
  'python3 -m pytest --basetemp=/x', 'python3 -m pytest --junitxml=out.xml', 'python3 -m pytest --log-file=x',
  'python3 -m pytest --cov', 'python3 -m pytest --cov-report=html:/x', 'python3 -m pytest -p evil',
  'python3 -m pytest -p', 'python3 -m pytest --pastebin=all', 'python3 -m pytest /abs/tests',
  'python3 -m pytest ../tests', 'python3 -m pytest --ignore=/x', 'python3 -m unittest -s /abs',
  'python3 -m unittest -t ../x', 'python3 -m unittest -c', 'python3 -m unittest --unknown',
  '/usr/bin/python3 -c 1', '/usr/bin/python3 x.py', 'python -c 1',
  'npm install', 'npm i', 'npm ci', 'npm update', 'npm uninstall x', 'npm link', 'npm publish', 'npm version patch',
  'npm ls', 'npm run build --prefix /x', 'npm run --prefix /x build', 'npm test --prefix /x', 'npm test -w x',
  'npm --prefix /x test', 'npm exec x', 'npm x', 'npm', 'pnpm add x', 'pnpm install', 'pnpm run build',
  'pnpm test --filter x', 'pnpm', 'yarn', 'yarn add x', 'yarn install', 'yarn run test', 'yarn test --cwd /x',
  'swift package update', 'swift package resolve', 'swift run', 'swift x.swift', 'swift -e 1',
  'swift build --package-path /x', 'swift build --scratch-path /x', 'swift build --build-path /x',
  'swift test --xunit-output /x', 'swift build -Xswiftc -o', 'swift build --update-baseline',
  'swift test --disable-sandbox', 'swift build -c', 'swift build --unknown',
  'xcodebuild test -scheme X', 'xcodebuild test', 'xcodebuild test-without-building', 'xcodebuild archive',
  'xcodebuild clean', 'xcodebuild clean build', 'xcodebuild analyze', 'xcodebuild install', 'xcodebuild docbuild',
  'xcodebuild -resolvePackageDependencies', 'xcodebuild -scheme X -resolvePackageDependencies build',
  'xcodebuild -derivedDataPath /x build', 'xcodebuild -resultBundlePath /x build', 'xcodebuild -archivePath /x',
  'xcodebuild -exportArchive', 'xcodebuild -allowProvisioningUpdates build', 'xcodebuild -xcconfig x build',
  'xcodebuild -clonedSourcePackagesDirPath /x build', 'xcodebuild -downloadAllPlatforms',
  'xcodebuild -runFirstLaunch', 'xcodebuild -create-xcframework', 'xcodebuild build SYMROOT=/x',
  'xcodebuild build CONFIGURATION_BUILD_DIR=/x', 'xcodebuild build OTHER_SWIFT_FLAGS=-x', 'xcodebuild -scheme',
  'xcodebuild -project', 'xcodebuild build-for-testing -destination', 'xcodebuild -skipUnavailableActions test',
  'xcrun simctl erase all', 'xcrun simctl delete unavailable', 'xcrun simctl boot X', 'xcrun simctl shutdown all',
  'xcrun simctl install booted x.app', 'xcrun simctl launch booted x', 'xcrun simctl uninstall booted x',
  'xcrun simctl spawn booted ls', 'xcrun simctl --set /x list', 'xcrun simctl --set /tmp/x erase all',
  'xcrun simctl list --set /x', 'xcrun simctl', 'xcrun simctl io booted screenshot x.png',
  'xcrun simctl openurl booted x', 'xcrun simctl privacy booted grant all x', 'xcrun --find',
  'xcrun --find -x', 'xcrun --run ls', 'xcrun -r ls', 'xcrun ls', 'xcrun swift build', 'xcrun xcodebuild build',
  'xcrun devicectl device install app x', 'xcrun --sdk iphoneos ls', 'xcrun --sdk', 'xcrun',
  'xcrun --show-sdk-path --find x',
  'bash -c ls', "bash -c 'ls'", 'bash -lc ls', 'sh -c ls', "sh -c 'ls'", 'bash', 'sh', 'bash -', 'bash -s',
  'bash -x scripts/x.sh', 'bash -e scripts/x.sh', 'echo ls | sh', 'echo ls | bash', 'cat x | bash',
  'bash /abs/x.sh', 'sh /etc/profile', 'bash ../x.sh', 'bash scripts/nope.sh', 'bash scripts/*.sh',
  '/bin/bash -c ls', '/bin/sh -c ls',
];

test('команды вне allowlist — блок', () => checkAll(UNKNOWN_COMMANDS, 2));
test('git: всё, кроме чтения, — блок', () => checkAll(GIT_DENIED, 2));
test('читатели: опасные флаги — блок', () => checkAll(READER_FLAGS_DENIED, 2));
test('раннеры и сборка: опасные формы — блок', () => checkAll(RUNNER_DENIED, 2));
test('проверяется каждый сегмент', () => checkAll([
  'ls && rm -rf x', 'ls; rm x', 'ls | rm x', 'ls || rm x', 'rm x && ls', 'rm x | head', 'ls\nrm x',
  'git status; git commit -m x', 'ls | git push', 'cat f | tee out', 'true; ls', 'ls; true', 'ls | sh',
  'ls && cd x', 'git status && git -c x=y log',
], 2));

// ── скрипты по пути ──────────────────────────────────────────────────────────

function scriptWorld() {
  const root = tempDir('ro-scripts-');
  const cwd = join(root, 'proj');
  mkdirSync(join(cwd, 'scripts'), { recursive: true });
  const gate = join(cwd, 'scripts', 'preflight.sh');
  writeFileSync(gate, '#!/bin/sh\nexit 0\n');
  chmodSync(gate, 0o755);
  writeFileSync(join(cwd, 'check.sh'), 'exit 0\n');
  chmodSync(join(cwd, 'check.sh'), 0o644);
  const outside = join(root, 'outside.sh');
  writeFileSync(outside, '#!/bin/sh\nexit 0\n');
  chmodSync(outside, 0o755);
  symlinkSync(outside, join(cwd, 'link.sh'));
  symlinkSync(gate, join(cwd, 'scripts', 'inner-link.sh'));
  return { root, cwd, gate };
}

test('исполняемый скрипт внутри cwd проходит', { skip: skipPosix }, () => {
  const { cwd } = scriptWorld();
  checkAll(['scripts/preflight.sh', 'scripts/preflight.sh --quiet', './scripts/preflight.sh', 'scripts/inner-link.sh',
    'bash scripts/preflight.sh', 'sh scripts/preflight.sh --flag', 'bash check.sh', 'sh ./check.sh',
    'bash scripts/inner-link.sh', 'scripts/preflight.sh && git status', 'scripts/preflight.sh -c anything'], 0, cwd);
});

test('скрипт снаружи, без прав, не файл или через `..` — блок', { skip: skipPosix }, () => {
  const { cwd, gate } = scriptWorld();
  checkAll(['./check.sh', 'check.sh', './link.sh', 'bash link.sh', 'sh link.sh', '../outside.sh',
    'bash ../outside.sh', 'scripts/../../outside.sh', 'scripts/../scripts/preflight.sh', 'bash scripts/../scripts/preflight.sh',
    'scripts/', 'scripts', 'bash scripts', 'bash scripts/', './scripts', 'scripts/missing.sh', 'bash scripts/missing.sh',
    `bash ${gate}`, gate, 'bash scripts/*.sh', 'scripts/pre*.sh', "'scripts/preflight.sh'", "scripts/pre'flight'.sh",
    'bash -c scripts/preflight.sh', 'bash -x scripts/preflight.sh', 'bash -- scripts/preflight.sh'], 2, cwd);
});

test('cwd обязателен только для путей', () => {
  for (const cwd of [undefined, '', 'relative/dir', '/nonexistent-dir-xyz', 42]) {
    const event = (command) => {
      const e = bash(command);
      if (cwd === undefined) delete e.cwd;
      else e.cwd = cwd;
      return e;
    };
    assert.equal(runGuard(event('scripts/preflight.sh')).code, 2, String(cwd));
    assert.equal(runGuard(event('bash scripts/preflight.sh')).code, 2, String(cwd));
    assert.equal(runGuard(event('git status')).code, 0, String(cwd));
  }
});

test('симлинк cwd разрешается', { skip: skipPosix }, () => {
  const { root, cwd } = scriptWorld();
  const link = join(root, 'proj-link');
  symlinkSync(cwd, link);
  assertAllowed('scripts/preflight.sh', link);
  assertBlocked('./link.sh', link);
});

// ── код для раннеров — внутри cwd после realpath ─────────────────────────────

function containmentWorld() {
  const root = tempDir('ro-contain-');
  const cwd = join(root, 'proj');
  mkdirSync(join(cwd, 'sub'), { recursive: true });
  mkdirSync(join(root, 'outside', 'Evil.xcodeproj'), { recursive: true });
  writeFileSync(join(root, 'outside', 'x.test.js'), '');
  symlinkSync(join(root, 'outside'), join(cwd, 'tests-link'));
  symlinkSync(join(root, 'outside', 'Evil.xcodeproj'), join(cwd, 'Evil.xcodeproj'));
  return cwd;
}

test('код раннера через симлинк наружу или чужой проект — блок', { skip: skipPosix }, () => {
  checkAll(['node --test tests-link/x.test.js', 'node --test tests-link', 'node --check tests-link/x.test.js',
    'python3 -m unittest discover -s tests-link', 'python3 -m unittest -s tests-link', 'python3 -m pytest tests-link',
    'python3 -m pytest --ignore=tests-link sub', 'xcodebuild -project /tmp/Evil.xcodeproj -scheme Evil build',
    'xcodebuild -project Evil.xcodeproj -scheme Evil build',
    'xcodebuild -workspace /tmp/W.xcworkspace -scheme S build-for-testing'], 2, containmentWorld());
});

test('пути внутри cwd проходят', { skip: skipPosix }, () => {
  checkAll(['node --test sub/', 'node --test sub/a.test.js', 'python3 -m unittest discover -s sub',
    'python3 -m unittest -v sub.test_x', 'python3 -m pytest sub',
    'xcodebuild -project App.xcodeproj -scheme App build-for-testing',
    'xcodebuild -workspace App.xcworkspace -scheme App build', "printf '%s\\n' x", 'rg -n needle sub'], 0, containmentWorld());
});

// ── устойчивость ─────────────────────────────────────────────────────────────

const timed = (fn) => {
  const start = Date.now();
  const result = fn();
  return { result, seconds: (Date.now() - start) / 1000 };
};

test('патологически длинная команда блокируется быстро', () => {
  const { result, seconds } = timed(() => runGuard(bash('psql '.repeat(40000))));
  assert.equal(result.code, 2, result.err);
  assert.ok(seconds < 8, `${seconds} с`);
});

test('длинная безобидная команда проходит быстро', () => {
  const { result, seconds } = timed(() => runGuard(bash(`ls ${'a'.repeat(500000)}`)));
  assert.equal(result.code, 0, result.err);
  assert.ok(seconds < 4, `${seconds} с`);
});

test('длинная цитата проходит быстро', () => {
  const { result, seconds } = timed(() => runGuard(bash(`rg '${'x; rm -rf / '.repeat(20000)}' src`)));
  assert.equal(result.code, 0, result.err);
  assert.ok(seconds < 4, `${seconds} с`);
});

test('незакрытый stdin — блок раньше таймаута хоста (10 с)', async () => {
  const start = Date.now();
  const child = spawn(process.execPath, [LAUNCHER, 'readonly-guard'], { env: ENV, stdio: ['pipe', 'ignore', 'pipe'] });
  const code = await new Promise((resolve) => {
    const killer = setTimeout(() => { child.kill('SIGKILL'); resolve('hang'); }, 12_000);
    child.on('exit', (c) => { clearTimeout(killer); resolve(c); });
  });
  child.stdin.destroy();
  assert.equal(code, 2);
  assert.ok((Date.now() - start) / 1000 < 8, 'хост с таймаутом 10 с пропустил бы команду');
});

async function callMain(context) {
  const { main } = await import(HOOK);
  const out = [];
  const code = await main({ stdinBuffer: Buffer.from(JSON.stringify(bash('git status'))), env: ENV, cwd: DEFAULT_CWD, stderr: (t) => out.push(t), ...context });
  return { code, err: out.join('') };
}

test('сбой внутри хука — блок, а не падение', async () => {
  const notBuffer = await callMain({ stdinBuffer: 42 });
  assert.equal(notBuffer.code, 2);
  assertBlockMessage(notBuffer.err, 'stdinBuffer=42');
  const brokenStderr = await callMain({ stdinBuffer: Buffer.from('rm x'), stderr: () => { throw new Error('x'); } });
  assert.equal(brokenStderr.code, 2);
  assert.equal((await callMain({})).code, 0);
});

test('исходник: failClosed, сторож, верхний перехват, без denylist', () => {
  const source = readFileSync(HOOK, 'utf8');
  assert.match(source, /export const failClosed = true/);
  assert.match(source, /Promise\.race\(\[verdict, watchdog\]\)/);
  assert.match(source, /killActiveChildren\(\)/);
  assert.doesNotMatch(source, /PATTERNS/);
});
