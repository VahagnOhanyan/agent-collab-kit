// claim-guard — PreToolUse-хук на Edit|Write|NotebookEdit для ЛЮБОЙ сессии Claude Code машины:
// в рабочей копии, привязанной к задаче журнала, правка допускается только внутри заявки этой задачи
// (`claim_files`) и только пока задача жива. Вне привязанной копии (основное дерево, чужой репозиторий,
// каталог без журнала) хук пропускает всё: он держит заявки, а не область агента — область держит
// `scope-guard`.
//
// Зачем. `claim_files` отказывал пересечению с чужой заявкой, но ничто не мешало агенту править файл,
// который он не заявил (ADR-0011 проекта-первоисточника это признавал). С копией на задачу
// (`collab worktree add`) привязка «копия → задача» известна, и заявку можно держать при правке.
//
// Как решает (без запуска `collab`: два чтения JSON и один вызов git):
//   1. событие → путь цели и cwd (как у scope-guard);
//   2. git: верхний уровень рабочего дерева цели и общий git-каталог → корень журнала
//      (родитель общего `.git`; для копии это основное дерево); не репозиторий — пропуск;
//   3. `<корень журнала>/.collab/worktrees.json` — есть ли запись о ЭТОЙ копии (по realpath верхнего
//      уровня); нет файла или записи — пропуск; запись-снимок (kind snapshot) — блок: снимок только читают;
//   4. `<корень журнала>/.collab/tasks/<id>.json` — задача: закрыта/нет/просрочена lease — блок с подсказкой
//      `claim_task`; путь цели относительно верхнего уровня не пересекается ни с одной заявкой (та же
//      префиксная логика, что в claimFiles) — блок с перечнем заявок и подсказкой `claim_files`.
//
// Привязанная копия — fail-closed: любой нештатный исход в ней (битый JSON, таймаут git, сторож) — блок.
// Непривязанное дерево — пропуск только после того, как выяснено, что оно не привязано; невозможность это
// выяснить (git не ответил) — тоже блок, иначе сбой git снимал бы границу.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { CapTimeout, cleanEnv, killActiveChildren, realpathLoose, runCapped } from './lib/paths.mjs';

export const failClosed = true;

const GIT_TIMEOUT_MS = 3000;
const WATCHDOG_MS = 10_000;
const TOOL_PATH_FIELD = { Edit: 'file_path', Write: 'file_path', NotebookEdit: 'notebook_path', MultiEdit: 'file_path' };
const NOT_A_REPO = 'not a git repository';
const TERMINAL = new Set(['completed', 'cancelled']);
const LEASED = new Set(['in_progress', 'assigned']);
const IS_WINDOWS = process.platform === 'win32';

export class Blocked extends Error {}

const toPosix = (p) => String(p).replace(/\\/g, '/');

// Та же проверка, что `overlaps()` в collab/src/domain/tasks.mjs: заявка на каталог покрывает файл в нём,
// заявка на файл — сам файл. Повторена, а не импортирована: хук не тянет сервер журнала.
export function overlaps(a, b) {
  if (a === b) return true;
  const dirA = a.endsWith('/') ? a : `${a}/`;
  const dirB = b.endsWith('/') ? b : `${b}/`;
  return a.startsWith(dirB) || b.startsWith(dirA);
}

function loadEvent(stdinBuffer) {
  let event;
  try {
    event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stdinBuffer));
  } catch {
    throw new Blocked('событие хука не JSON в UTF-8 — блокирую');
  }
  if (event === null || typeof event !== 'object' || Array.isArray(event)) throw new Blocked('событие хука — не объект, блокирую');
  return event;
}

export function safeRealpath(p) {
  try {
    return realpathSync.native(p).replace(/^\\\\\?\\(?=[A-Za-z]:)/, '');
  } catch {
    return realpathLoose(p);
  }
}

// Те же фиксированные пути, что у сервера журнала (collab/src/paths.mjs): никакого поиска по PATH.
function gitCandidates(env) {
  if (!IS_WINDOWS) {
    return [
      '/usr/bin/git',
      '/opt/homebrew/bin/git',
      '/usr/local/bin/git',
      '/Library/Developer/CommandLineTools/usr/bin/git',
      '/Applications/Xcode.app/Contents/Developer/usr/bin/git',
    ];
  }
  return [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')]
    .filter(Boolean)
    .flatMap((base) => [path.join(base, 'Git', 'cmd', 'git.exe'), path.join(base, 'Git', 'bin', 'git.exe')]);
}

export function existingParent(p) {
  let current = p;
  for (;;) {
    try {
      if (statSync(current).isDirectory()) return current;
    } catch {
      // выше
    }
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

// { toplevel, journalRoot } для каталога, или null вне git-репозитория.
export async function gitRoots(dir, home, env) {
  const git = gitCandidates(env).find((g) => {
    try {
      return statSync(g).isFile();
    } catch {
      return false;
    }
  });
  // Без git нет и копий: `collab worktree add` их создаёт через git. Блокировать здесь значило бы остановить
  // все правки во всех сессиях машины, у которой git лежит в неожиданном месте, — ради границы, которую на
  // такой машине нечем нарушить. Поэтому пропуск, а не блок (в отличие от сбоя найденного git ниже).
  if (!git) return null;
  const run = async (args) => {
    try {
      return await runCapped([git, ...args], { cwd: dir, env: { ...cleanEnv(home), LC_ALL: 'C', LANG: 'C' }, timeoutMs: GIT_TIMEOUT_MS });
    } catch (error) {
      if (error instanceof CapTimeout) throw new Blocked(`git не ответил за ${GIT_TIMEOUT_MS / 1000} с — блокирую`);
      throw new Blocked(`не удалось запустить git: ${error?.message ?? error} — блокирую`);
    }
  };
  const top = await run(['rev-parse', '--show-toplevel']);
  if (top.status !== 0) {
    if (top.status === 128 && top.stderr.toString('latin1').includes(NOT_A_REPO)) return null;
    throw new Blocked(`git rev-parse завершился с кодом ${top.status} — блокирую`);
  }
  const common = await run(['rev-parse', '--git-common-dir']);
  if (common.status !== 0) throw new Blocked(`git rev-parse --git-common-dir завершился с кодом ${common.status} — блокирую`);
  const toplevel = safeRealpath(top.stdout.toString('utf8').trim());
  const commonDir = path.resolve(dir, common.stdout.toString('utf8').trim());
  return { toplevel, journalRoot: safeRealpath(path.dirname(commonDir)) };
}

export function readJsonOrNull(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Blocked(`${file} не читается (${error?.code ?? error?.message}) — блокирую`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Blocked(`${file} — не JSON, блокирую`);
  }
}

async function decide({ stdinBuffer, env }) {
  const home = env.HOME || env.USERPROFILE;
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new Blocked('HOME не задан или не абсолютный — блокирую');
  const event = loadEvent(stdinBuffer);
  const tool = event.tool_name;
  if (typeof tool !== 'string' || !Object.hasOwn(TOOL_PATH_FIELD, tool)) {
    throw new Blocked(`неожиданный tool_name ${JSON.stringify(tool)} — хук подключён к Edit|Write|MultiEdit|NotebookEdit, блокирую`);
  }
  const input = event.tool_input;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Blocked('в событии нет объекта tool_input — блокирую');
  const target = input[TOOL_PATH_FIELD[tool]];
  if (typeof target !== 'string' || target === '' || target.includes('\0')) throw new Blocked(`поле ${TOOL_PATH_FIELD[tool]} пустое или некорректное — блокирую`);
  const cwd = event.cwd;
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Blocked('cwd события не абсолютный — блокирую');

  const real = realpathLoose(path.isAbsolute(target) ? target : path.join(cwd, target));
  const roots = await gitRoots(existingParent(real), home, env);
  if (!roots) return { pass: true, why: 'вне git-репозитория' };

  const mapFile = path.join(roots.journalRoot, '.collab', 'worktrees.json');
  const map = readJsonOrNull(mapFile);
  if (!map) return { pass: true, why: 'нет worktrees.json — копии не привязаны' };
  const entries = map && typeof map === 'object' && map.worktrees && typeof map.worktrees === 'object' ? map.worktrees : {};
  const key = Object.keys(entries).find((p) => safeRealpath(p) === roots.toplevel);
  if (!key) return { pass: true, why: 'это дерево не привязано к задаче' };
  const entry = entries[key];
  if (entry?.kind === 'snapshot') throw new Blocked(`${roots.toplevel} — снимок для аудита (только чтение); правки делаются в копии задачи — блокирую`);
  const taskId = entry?.task_id;
  if (typeof taskId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(taskId)) throw new Blocked(`${mapFile}: у записи ${key} нет корректного task_id — блокирую`);

  const task = readJsonOrNull(path.join(roots.journalRoot, '.collab', 'tasks', `${taskId}.json`));
  if (!task) throw new Blocked(`копия привязана к задаче ${taskId}, которой нет в журнале — блокирую (collab worktree gc)`);
  if (TERMINAL.has(task.status)) throw new Blocked(`задача ${taskId} уже ${task.status}: в её копии больше не правят — блокирую (collab worktree gc)`);
  const expires = task.lease?.expires_at ? Date.parse(task.lease.expires_at) : NaN;
  if (!LEASED.has(task.status) || !task.owner || Number.isNaN(expires) || expires < Date.now()) {
    throw new Blocked(`задача ${taskId} не в работе (${task.status}, владелец ${task.owner ?? 'нет'}, lease ${task.lease?.expires_at ?? 'нет'}): возьми её снова — claim_task ${taskId} — и правь дальше. Блокирую`);
  }

  const rel = toPosix(path.relative(roots.toplevel, real));
  if (rel === '' || rel.startsWith('../') || rel === '..' || path.isAbsolute(rel)) throw new Blocked(`${real} вне рабочего дерева ${roots.toplevel} — блокирую`);
  const claimed = Array.isArray(task.files) ? task.files.map(toPosix) : [];
  if (!claimed.some((c) => overlaps(rel, c))) {
    throw new Blocked(
      `${rel} не входит в заявку задачи ${taskId} (заявлено: ${claimed.join(', ') || 'ничего'}). ` +
        `Заяви путь — claim_files ${taskId} ["${rel}"] — или запроси расширение области у ведущей сессии. Блокирую`,
    );
  }
  return { pass: true, why: `в заявке ${taskId}` };
}

export async function main({ stdinBuffer, env, stderr }) {
  let timer;
  const watchdog = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Blocked(`сторож ${WATCHDOG_MS / 1000} с — блокирую`)), WATCHDOG_MS);
  });
  try {
    await Promise.race([decide({ stdinBuffer, env }), watchdog]);
    return 0;
  } catch (error) {
    const message = error instanceof Blocked ? error.message : `claim-guard: ${error?.stack ?? error}`;
    stderr(`claim-guard: ${message}\n`);
    return 2;
  } finally {
    clearTimeout(timer);
    killActiveChildren();
  }
}
