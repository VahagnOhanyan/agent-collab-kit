// Тесты hooks/claim-guard.mjs. Запуск как у хоста — через bin/agent-collab-kit-hook отдельным процессом:
// важны код выхода (2 = блок, 0 = пропуск) и сообщение в stderr. Журнал не поднимается: хук читает
// `.collab/worktrees.json` и `.collab/tasks/<id>.json` с диска, и тест кладёт их туда сам — ровно в той форме,
// в какой их пишет collab (domain/worktrees.mjs, store.mjs).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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
  const input = typeof stdin === 'string' ? stdin : JSON.stringify(stdin);
  const env = { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' };
  const proc = spawnSync(process.execPath, [LAUNCHER, 'claim-guard'], { input, env, cwd, encoding: 'utf8', timeout: 25_000 });
  return { code: proc.status, err: proc.stderr ?? '' };
}

const soon = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();

// Репозиторий с одним коммитом, журналом и копией задачи. Копия и основное дерево делят один `.collab/`.
function world() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'claim-guard-')));
  const home = join(base, 'home');
  const repo = join(base, 'repo');
  mkdirSync(home);
  mkdirSync(repo);
  git(repo, 'init', '-q');
  mkdirSync(join(repo, 'App', 'Album'), { recursive: true });
  mkdirSync(join(repo, 'App', 'Shared'), { recursive: true });
  writeFileSync(join(repo, 'App', 'Album', 'View.swift'), 'a\n');
  writeFileSync(join(repo, 'App', 'Shared', 'Theme.swift'), 't\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  const sha = git(repo, 'rev-parse', 'HEAD');
  const stateDir = join(repo, '.collab');
  mkdirSync(join(stateDir, 'tasks'), { recursive: true });
  const copy = join(repo, '.claude', 'worktrees', 'tsk_1-album');
  mkdirSync(dirname(copy), { recursive: true });
  git(repo, 'worktree', 'add', '-q', copy, '-b', 'agent/tsk_1-album', sha);
  const w = {
    base,
    home,
    repo,
    copy: realpathSync(copy),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
    map(worktrees) {
      writeFileSync(join(stateDir, 'worktrees.json'), JSON.stringify({ version: 1, worktrees }));
    },
    rawMap(text) {
      writeFileSync(join(stateDir, 'worktrees.json'), text);
    },
    task(id, fields) {
      writeFileSync(
        join(stateDir, 'tasks', `${id}.json`),
        JSON.stringify({ id, status: 'in_progress', owner: 'claude', files: ['App/Album/'], lease: { holder: 'claude', expires_at: soon(30) }, ...fields }),
      );
    },
    event(root, rel, tool = 'Edit') {
      const field = tool === 'NotebookEdit' ? 'notebook_path' : 'file_path';
      return { tool_name: tool, tool_input: { [field]: join(root, rel) }, cwd: root };
    },
    run(stdin, cwd) {
      return runHook(stdin, { home, cwd });
    },
  };
  w.bind = () => w.map({ [w.copy]: { kind: 'task', task_id: 'tsk_1', branch: 'agent/tsk_1-album' } });
  return w;
}

const withWorld = (name, body, options = {}) =>
  test(name, { skip: skipNoGit, ...options }, async () => {
    const w = world();
    try {
      await body(w);
    } finally {
      w.cleanup();
    }
  });

withWorld('основное дерево без привязки — пропуск, даже если копии привязаны', (w) => {
  w.bind();
  w.task('tsk_1');
  const r = w.run(w.event(w.repo, 'App/Shared/Theme.swift'), w.repo);
  assert.equal(r.code, 0, r.err);
});

withWorld('нет worktrees.json — пропуск везде', (w) => {
  const r = w.run(w.event(w.copy, 'App/Shared/Theme.swift'), w.copy);
  assert.equal(r.code, 0, r.err);
});

withWorld('в привязанной копии правка внутри заявки проходит, вне заявки — блок с подсказкой claim_files', (w) => {
  w.bind();
  w.task('tsk_1');
  const inside = w.run(w.event(w.copy, 'App/Album/View.swift'), w.copy);
  assert.equal(inside.code, 0, inside.err);
  const newFile = w.run(w.event(w.copy, 'App/Album/New.swift', 'Write'), w.copy);
  assert.equal(newFile.code, 0, newFile.err);
  const outside = w.run(w.event(w.copy, 'App/Shared/Theme.swift'), w.copy);
  assert.equal(outside.code, 2);
  assert.match(outside.err, /claim_files tsk_1 \["App\/Shared\/Theme\.swift"\]/);
  assert.match(outside.err, /App\/Album\//);
  // относительный путь в событии считается от cwd копии
  const relative = w.run({ tool_name: 'Edit', tool_input: { file_path: 'App/Shared/Theme.swift' }, cwd: w.copy }, w.copy);
  assert.equal(relative.code, 2);
});

withWorld('заявка на файл покрывает только этот файл', (w) => {
  w.bind();
  w.task('tsk_1', { files: ['App/Shared/Theme.swift'] });
  assert.equal(w.run(w.event(w.copy, 'App/Shared/Theme.swift'), w.copy).code, 0);
  assert.equal(w.run(w.event(w.copy, 'App/Shared/Other.swift', 'Write'), w.copy).code, 2);
  assert.equal(w.run(w.event(w.copy, 'App/Album/View.swift'), w.copy).code, 2);
});

withWorld('закрытая задача, пустая заявка, истёкшая lease, чужой статус — блок с подсказкой claim_task', (w) => {
  w.bind();
  w.task('tsk_1', { status: 'completed' });
  let r = w.run(w.event(w.copy, 'App/Album/View.swift'), w.copy);
  assert.equal(r.code, 2);
  assert.match(r.err, /completed/);

  w.task('tsk_1', { lease: { holder: 'claude', expires_at: soon(-5) } });
  r = w.run(w.event(w.copy, 'App/Album/View.swift'), w.copy);
  assert.equal(r.code, 2);
  assert.match(r.err, /claim_task tsk_1/);

  w.task('tsk_1', { status: 'review' });
  r = w.run(w.event(w.copy, 'App/Album/View.swift'), w.copy);
  assert.equal(r.code, 2);

  w.task('tsk_1', { files: [] });
  r = w.run(w.event(w.copy, 'App/Album/View.swift'), w.copy);
  assert.equal(r.code, 2);
  assert.match(r.err, /ничего/);
});

withWorld('копия привязана к задаче, которой нет в журнале — блок', (w) => {
  w.bind();
  const r = w.run(w.event(w.copy, 'App/Album/View.swift'), w.copy);
  assert.equal(r.code, 2);
  assert.match(r.err, /tsk_1/);
});

withWorld('снимок для аудита — только чтение', (w) => {
  w.map({ [w.copy]: { kind: 'snapshot', task_id: null } });
  const r = w.run(w.event(w.copy, 'App/Album/View.swift'), w.copy);
  assert.equal(r.code, 2);
  assert.match(r.err, /снимок/);
});

withWorld('битый worktrees.json — блок с именем файла (нельзя выяснить, привязана ли копия)', (w) => {
  w.rawMap('{not json');
  const r = w.run(w.event(w.copy, 'App/Album/View.swift'), w.copy);
  assert.equal(r.code, 2);
  assert.match(r.err, /worktrees\.json/);
});

withWorld('путь вне git-репозитория — пропуск', (w) => {
  const outside = join(w.base, 'plain');
  mkdirSync(outside);
  const r = w.run(w.event(outside, 'notes.txt', 'Write'), outside);
  assert.equal(r.code, 0, r.err);
});

withWorld('мусор на входе — блок', (w) => {
  assert.equal(w.run('not json', w.copy).code, 2);
  assert.equal(w.run({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: w.copy }, w.copy).code, 2);
  assert.equal(w.run({ tool_name: 'Edit', tool_input: {}, cwd: w.copy }, w.copy).code, 2);
  assert.equal(w.run({ tool_name: 'Edit', tool_input: { file_path: 'x' }, cwd: 'relative' }, w.copy).code, 2);
});
