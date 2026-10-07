// stash-guard — PreToolUse-хук на Bash для ЛЮБОЙ сессии Claude Code машины: в рабочей копии, привязанной к
// задаче журнала (`collab worktree add`), не выполняются команды git, которые стирают или прячут незакоммиченные
// правки: `git stash` (любая форма, кроме list/show), `git reset --hard`, `git checkout -- <путь>` /
// `git checkout <ref> -- <путь>` / `git checkout .`, `git restore` (кроме `--staged`), `git clean -f`.
// Вне привязанных копий хук пропускает всё — как claim-guard, он держит границу копии, а не область агента.
//
// Зачем. Копии задач делят один репозиторий, а значит и один `refs/stash`: `git stash pop` в одной копии
// достаёт запись, спрятанную в другой, и правки одной задачи оказываются в дереве другой. `reset --hard` и
// `checkout -- <путь>` стирают незакоммиченную работу без следа в журнале; claim-guard держит правки
// инструментами Edit/Write, но не эти команды. Что делать вместо — в сообщении блока.
//
// Как решает (без запуска `collab`: разбор команды, чтение двух JSON и вызов git, как у claim-guard):
//   1. быстрый путь: в команде нет ни слова stash/reset/checkout/restore/clean — пропуск без единого вызова git;
//   2. разбор команды (hooks/lib/shellparse.mjs): сегменты, `cd`, `git -C <каталог>`, `bash -c '…'`, подстановки
//      `$(…)`; для каждого опасного вызова git — каталог, в котором он исполнится;
//   3. каталог → верхний уровень рабочего дерева → запись в `<корень журнала>/.collab/worktrees.json`
//      (те же функции, что у claim-guard); нет записи — пропуск этого вызова; есть — блок.
//
// Команду, которую не разобрать (незакрытая кавычка), при опасных словах считаем вызовом в текущем каталоге:
// копия привязана — блок. Сбой git при выяснении, привязан ли каталог, — тоже блок (fail-closed, как у claim-guard).
import path from 'node:path';
import { Blocked, existingParent, gitRoots, readJsonOrNull, safeRealpath } from './claim-guard.mjs';
import { killActiveChildren, realpathLoose } from './lib/paths.mjs';
import { parseCommand } from './lib/shellparse.mjs';

export const failClosed = true;

const WATCHDOG_MS = 10_000;
const MAX_DEPTH = 3;
const MAYBE_DANGEROUS = /\b(stash|reset|checkout|restore|clean)\b/;
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const WRAPPERS = new Set(['env', 'command', 'sudo', 'xargs', 'time', 'nohup', 'exec', 'nice', 'timeout']);
const STASH_READ_ONLY = new Set(['list', 'show']);

const programName = (word) => path.basename(String(word)).replace(/\.exe$/i, '');
const isAbbrev = (word, full, min) => word.length >= min && full.startsWith(word);

const WIP_ADVICE =
  'Вместо этого: временный WIP-коммит в ветке задачи (`git add -A && git commit -m "WIP: …"`) — правки останутся в истории копии; ' +
  'нужна копия файла до эксперимента — `cp <файл> <файл>.orig`; вернуть файл к коммиту — `git show HEAD:<путь> > <путь>`; откатить сделанное — `git revert`.';

const REASONS = {
  stash:
    '`git stash` в копии задачи: стэш один на весь репозиторий, и `pop`/`apply` в другой копии достанет чужие правки. ',
  hard: '`git reset --hard` в копии задачи необратимо стирает незакоммиченную работу. ',
  checkout: '`git checkout -- <путь>` / `checkout .` / `checkout -f` в копии задачи необратимо стирает незакоммиченные правки. ',
  restore: '`git restore` (без --staged) в копии задачи необратимо стирает незакоммиченные правки. ',
  clean: '`git clean -f` в копии задачи необратимо удаляет неотслеживаемые файлы. ',
  unparsed: 'Команда не разбирается (незакрытая кавычка), а в ней git stash/reset/checkout/restore/clean; в копии задачи такие команды запрещены. '
};

// Разбор одного вызова git: слова после `git` → причина или null.
function classify(words) {
  let i = 1;
  let dirArg = null;
  while (i < words.length && words[i].startsWith('-')) {
    const w = words[i];
    if ((w === '-C' || w === '--work-tree') && i + 1 < words.length) {
      dirArg = words[i + 1];
      i += 2;
    } else if (w.startsWith('--work-tree=')) {
      dirArg = w.slice('--work-tree='.length);
      i += 1;
    } else if (w === '-c' || w === '--git-dir' || w === '--namespace' || w === '--exec-path') {
      i += 2;
    } else {
      i += 1;
    }
  }
  const sub = words[i];
  const rest = words.slice(i + 1);
  let reason = null;
  if (sub === 'stash') {
    if (!STASH_READ_ONLY.has(rest[0])) reason = REASONS.stash;
  } else if (sub === 'reset') {
    if (rest.some((w) => isAbbrev(w, '--hard', 4))) reason = REASONS.hard;
  } else if (sub === 'checkout') {
    if (rest.includes('--') || rest.includes('.') || rest.includes('-f') || rest.some((w) => isAbbrev(w, '--force', 4))) reason = REASONS.checkout;
  } else if (sub === 'restore') {
    const staged = rest.includes('--staged') || rest.includes('-S');
    const worktree = rest.includes('--worktree') || rest.includes('-W');
    if (!staged || worktree) reason = REASONS.restore;
  } else if (sub === 'clean') {
    const force = rest.some((w) => w === '--force' || /^-[A-Za-z]*f/.test(w));
    const dry = rest.some((w) => w === '--dry-run' || (!w.startsWith('--') && /^-[A-Za-z]*n/.test(w)));
    if (force && !dry) reason = REASONS.clean;
  }
  return { reason, dirArg };
}

// Все опасные вызовы git в команде → [{ dir, reason }]. Чистая функция: только пути, без обращений к диску.
export function dangerousGitCalls(command, cwd, home, depth = 0) {
  if (!MAYBE_DANGEROUS.test(command)) return [];
  const parsed = parseCommand(command);
  if (!parsed) return /\bgit\b/.test(command) ? [{ dir: cwd, reason: REASONS.unparsed }] : [];
  const found = [];
  const resolveDir = (base, p) => {
    const expanded = p === '~' || p.startsWith('~/') ? `${home}${p.slice(1)}` : p;
    return path.resolve(base, expanded);
  };
  let dir = cwd;
  for (const segment of parsed.segments) {
    if (depth < MAX_DEPTH) {
      for (const sub of [...segment.subs, ...segment.heredocSubs]) found.push(...dangerousGitCalls(sub, dir, home, depth + 1));
    }
    let words = segment.words;
    if (words.length === 0) continue;
    let name = programName(words[0]);
    if (WRAPPERS.has(name)) {
      const at = words.findIndex((w, k) => k > 0 && programName(w) === 'git');
      if (at > 0) {
        words = words.slice(at);
        name = 'git';
      }
    }
    if (name === 'cd') {
      const target = words.slice(1).find((w) => !w.startsWith('-'));
      if (target && target !== '-') dir = resolveDir(dir, target);
    } else if (SHELLS.has(name) && depth < MAX_DEPTH) {
      const c = words.findIndex((w) => /^-[A-Za-z]*c$/.test(w));
      if (c > 0 && words[c + 1]) found.push(...dangerousGitCalls(words[c + 1], dir, home, depth + 1));
      for (const body of segment.heredocs) found.push(...dangerousGitCalls(body, dir, home, depth + 1));
    } else if (name === 'git') {
      const { reason, dirArg } = classify(words);
      if (reason) found.push({ dir: dirArg ? resolveDir(dir, dirArg) : dir, reason });
    }
  }
  return found;
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

async function decide({ stdinBuffer, env, cwd: hostCwd }) {
  const home = env.HOME || env.USERPROFILE;
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new Blocked('HOME не задан или не абсолютный — блокирую');
  const event = loadEvent(stdinBuffer);
  if (event.tool_name !== 'Bash') return { pass: true, why: 'не Bash' };
  const command = event.tool_input?.command;
  if (typeof command !== 'string') throw new Blocked('в событии нет tool_input.command — блокирую');
  const cwd = typeof event.cwd === 'string' && path.isAbsolute(event.cwd) ? event.cwd : hostCwd;
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Blocked('cwd события не абсолютный — блокирую');

  const calls = dangerousGitCalls(command, cwd, home);
  if (calls.length === 0) return { pass: true, why: 'нет опасных вызовов git' };

  const maps = new Map(); // корень журнала → worktrees.json (читается один раз)
  for (const { dir, reason } of calls) {
    const real = realpathLoose(dir);
    const roots = await gitRoots(existingParent(real), home, env);
    if (!roots) continue;
    if (!maps.has(roots.journalRoot)) maps.set(roots.journalRoot, readJsonOrNull(path.join(roots.journalRoot, '.collab', 'worktrees.json')));
    const map = maps.get(roots.journalRoot);
    const entries = map && typeof map === 'object' && map.worktrees && typeof map.worktrees === 'object' ? map.worktrees : {};
    const key = Object.keys(entries).find((p) => safeRealpath(p) === roots.toplevel);
    if (!key) continue;
    const taskId = entries[key]?.task_id;
    throw new Blocked(`${reason}${taskId ? `Копия привязана к задаче ${taskId}. ` : 'Это снимок для аудита. '}${WIP_ADVICE} Блокирую`);
  }
  return { pass: true, why: 'вызовы вне привязанных копий' };
}

export async function main({ stdinBuffer, env, cwd, stderr }) {
  let timer;
  const watchdog = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Blocked(`сторож ${WATCHDOG_MS / 1000} с — блокирую`)), WATCHDOG_MS);
  });
  try {
    await Promise.race([decide({ stdinBuffer, env, cwd }), watchdog]);
    return 0;
  } catch (error) {
    const message = error instanceof Blocked ? error.message : `stash-guard: ${error?.stack ?? error}`;
    stderr(`stash-guard: ${message}\n`);
    return 2;
  } finally {
    clearTimeout(timer);
    killActiveChildren();
  }
}
