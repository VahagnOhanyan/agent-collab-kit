// Тесты hooks/stash-guard.mjs. Разбор команды — юнит-тестами чистой функции dangerousGitCalls; решение хука —
// отдельным процессом через bin/agent-collab-kit-hook (важны код выхода: 2 = блок, 0 = пропуск, и сообщение в
// stderr). Журнал не поднимается: хук читает `.collab/worktrees.json`, тест кладёт его сам — в той форме, в какой
// его пишет collab (domain/worktrees.mjs).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dangerousGitCalls } from '../hooks/stash-guard.mjs';

const LAUNCHER = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agent-collab-kit-hook');
const WINDOWS = process.platform === 'win32';
const GIT = ['/usr/bin/git', '/opt/homebrew/bin/git'].find((g) => !WINDOWS && spawnSync(g, ['--version']).status === 0) ?? (WINDOWS ? 'git' : null);
const skipNoGit = GIT ? false : 'git не найден';

const gitEnv = { PATH: process.env.PATH, HOME: '/nonexistent', LC_ALL: 'C', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...args) => {
  const r = spawnSync(GIT, args, { cwd, env: gitEnv, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
};

function runHook(stdin, { home, cwd }) {
  const env = { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' };
  const proc = spawnSync(process.execPath, [LAUNCHER, 'stash-guard'], { input: typeof stdin === 'string' ? stdin : JSON.stringify(stdin), env, cwd, encoding: 'utf8', timeout: 25_000 });
  return { code: proc.status, err: proc.stderr ?? '' };
}

// Репозиторий с коммитом, копией задачи tsk_1 (привязана в worktrees.json) и снимком для аудита.
function world() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'stash-guard-')));
  const home = join(base, 'home');
  const repo = join(base, 'repo');
  mkdirSync(home);
  mkdirSync(repo);
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  const sha = git(repo, 'rev-parse', 'HEAD');
  const stateDir = join(repo, '.collab');
  mkdirSync(stateDir, { recursive: true });
  const copy = join(repo, '.claude', 'worktrees', 'tsk_1-work');
  mkdirSync(dirname(copy), { recursive: true });
  git(repo, 'worktree', 'add', '-q', copy, '-b', 'agent/tsk_1-work', sha);
  const snapshot = join(repo, '.claude', 'worktrees', 'audit-snap');
  git(repo, 'worktree', 'add', '-q', '--detach', snapshot, sha);
  const w = {
    base,
    home,
    repo,
    copy: realpathSync(copy),
    snapshot: realpathSync(snapshot),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
    bind() {
      writeFileSync(
        join(stateDir, 'worktrees.json'),
        JSON.stringify({ version: 1, worktrees: { [w.copy]: { kind: 'task', task_id: 'tsk_1' }, [w.snapshot]: { kind: 'snapshot', task_id: null } } }),
      );
    },
    bash(command, cwd) {
      return runHook({ tool_name: 'Bash', tool_input: { command }, cwd }, { home, cwd });
    },
  };
  return w;
}

const withWorld = (name, body) =>
  test(name, { skip: skipNoGit }, async () => {
    const w = world();
    try {
      await body(w);
    } finally {
      w.cleanup();
    }
  });

// ── разбор команды ─────────────────────────────────────────────────────────

const HOME = '/home/u';
const CWD = '/w/copy';
const blocked = (command) => dangerousGitCalls(command, CWD, HOME);

test('разбор: опасные формы git находятся', () => {
  for (const command of [
    'git stash',
    'git stash push -m x',
    'git stash save wip',
    'git stash pop',
    'git stash apply stash@{0}',
    'git stash drop',
    'git stash clear',
    'git stash -u',
    'git reset --hard',
    'git reset --hard HEAD~1',
    'git reset --ha',
    'git checkout -- src/a.js',
    'git checkout HEAD -- src/a.js',
    'git checkout .',
    'git checkout -f',
    'git restore src/a.js',
    'git restore --worktree --staged a.js',
    'git clean -f',
    'git clean -fd',
    'git clean -xdf',
    'git -C /other stash pop',
    'git -c core.editor=true stash',
    'cd /x && git stash pop',
    'echo hi; git reset --hard',
    'bash -c "git stash"',
    'echo "$(git stash pop)"',
    'sudo git reset --hard',
    'env FOO=1 git clean -f',
  ]) {
    assert.ok(blocked(command).length > 0, `должно находиться: ${command}`);
  }
});

test('разбор: безопасные формы и текст, где слова лишь упоминаются, не находятся', () => {
  for (const command of [
    'git stash list',
    'git stash show -p stash@{0}',
    'git restore --staged a.js',
    'git restore -S a.js',
    'git reset --soft HEAD~1',
    'git reset HEAD a.js',
    'git reset --mixed',
    'git checkout main',
    'git checkout -b feature',
    'git clean -n',
    'git clean -nfd',
    'git clean --dry-run -f',
    'git status',
    'git commit -m "git stash pop and git reset --hard are blocked"',
    'echo "git stash"',
    'grep -rn "stash" src',
    'npm run clean',
    "cat <<'EOF'\ngit reset --hard\nEOF",
  ]) {
    assert.deepEqual(blocked(command), [], `не должно находиться: ${command}`);
  }
});

test('разбор: каталог вызова учитывает cd и git -C', () => {
  assert.equal(dangerousGitCalls('git stash', '/w/copy', HOME)[0].dir, '/w/copy');
  assert.equal(dangerousGitCalls('cd ../other && git stash', '/w/copy', HOME)[0].dir, '/w/other');
  assert.equal(dangerousGitCalls('git -C /abs/dir stash pop', '/w/copy', HOME)[0].dir, '/abs/dir');
  assert.equal(dangerousGitCalls('git -C rel stash pop', '/w/copy', HOME)[0].dir, '/w/copy/rel');
  assert.equal(dangerousGitCalls('cd ~/x && git reset --hard', '/w/copy', HOME)[0].dir, '/home/u/x');
});

test('разбор: команда с незакрытой кавычкой и опасным словом считается вызовом в текущем каталоге', () => {
  const calls = blocked('git stash "oops');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].dir, CWD);
  assert.deepEqual(blocked('echo "oops'), []);
});

// ── решение хука ───────────────────────────────────────────────────────────

withWorld('в привязанной копии stash push/pop/голый stash, reset --hard, checkout --, restore, clean -f — блок с советом', (w) => {
  w.bind();
  for (const command of ['git stash', 'git stash push -m x', 'git stash pop', 'git reset --hard', 'git checkout -- a.txt', 'git checkout HEAD -- a.txt', 'git restore a.txt', 'git clean -fd']) {
    const r = w.bash(command, w.copy);
    assert.equal(r.code, 2, `${command}: ${r.err}`);
    assert.match(r.err, /tsk_1/);
    assert.match(r.err, /WIP-коммит/);
    assert.match(r.err, /cp <файл>/);
  }
});

withWorld('в привязанной копии git stash list/show, restore --staged и обычная работа с git проходят', (w) => {
  w.bind();
  for (const command of ['git stash list', 'git stash show', 'git restore --staged a.txt', 'git status', 'git commit -m wip --allow-empty', 'git checkout -b other', 'ls -la']) {
    const r = w.bash(command, w.copy);
    assert.equal(r.code, 0, `${command}: ${r.err}`);
  }
});

withWorld('вне копий — основное дерево и каталог без репозитория — всё проходит', (w) => {
  w.bind();
  assert.equal(w.bash('git stash', w.repo).code, 0);
  assert.equal(w.bash('git reset --hard', w.repo).code, 0);
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'stash-guard-out-')));
  try {
    assert.equal(w.bash('git stash pop', outside).code, 0);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

withWorld('нет worktrees.json — копии не привязаны, пропуск', (w) => {
  assert.equal(w.bash('git stash', w.copy).code, 0);
});

withWorld('вызов из основного дерева в копию (git -C, cd) тоже блокируется', (w) => {
  w.bind();
  assert.equal(w.bash(`git -C ${w.copy} stash pop`, w.repo).code, 2);
  assert.equal(w.bash(`cd ${w.copy} && git reset --hard`, w.repo).code, 2);
  assert.equal(w.bash(`bash -c 'git stash'`, w.copy).code, 2);
  // и наоборот: git -C в основное дерево из копии не блокируется — граница держит копию, а не сессию
  assert.equal(w.bash(`git -C ${w.repo} stash`, w.copy).code, 0);
});

withWorld('снимок для аудита — тоже под запретом', (w) => {
  w.bind();
  const r = w.bash('git reset --hard', w.snapshot);
  assert.equal(r.code, 2);
  assert.match(r.err, /снимок/);
});

withWorld('не Bash пропускается, не JSON и не объект — блок', (w) => {
  w.bind();
  assert.equal(runHook({ tool_name: 'Read', tool_input: {}, cwd: w.copy }, { home: w.home, cwd: w.copy }).code, 0);
  assert.equal(runHook('not json', { home: w.home, cwd: w.copy }).code, 2);
  assert.equal(runHook('[]', { home: w.home, cwd: w.copy }).code, 2);
  assert.equal(runHook({ tool_name: 'Bash', tool_input: {}, cwd: w.copy }, { home: w.home, cwd: w.copy }).code, 2);
});
