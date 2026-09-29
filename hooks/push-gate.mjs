// PreToolUse-хук ведущей сессии Claude Code (Bash): `git push` — только через зелёный гейт проекта и без
// обходов. Гейт — `gate` в доверенном реестре проекта (путь от корня рабочего дерева, например
// scripts/preflight.sh). Установщик вписывает хук в settings.json каждого конфига Claude.
//
// Модель — «блок при сомнении», а не разбор оболочки. Если в команде (без кавычек и `\`) есть слово `git` и
// `push`, она пропускается, только если доказуемо проста:
//   - нет `$`, обратных кавычек, `<<`; нет скобок, блоков, фона и ключевых слов оболочки;
//   - операторы между командами — только `&&`, `||`, `;`, перевод строки, `|`;
//   - push — это `git [-C <каталог>] push <аргументы>`: без `-c`, `--git-dir`, `--work-tree`, присваиваний;
//   - другие команды, упоминающие push, — только echo/printf/grep/rg; оболочки, eval, xargs, обёртки,
//     export/alias/set — блок;
//   - `cd` — в существующий каталог и безусловно (в начале цепочки `&&` или перед push в той же цепочке).
// Всё остальное — блок с просьбой запустить push отдельной простой командой: разбирать оболочку целиком этот хук
// не берётся (четыре раунда ревью подряд находили расхождения самописного разбора с bash).
//
// Дальше: `--no-verify`, `--force`, `-f` (в т.ч. `-uf`), `--force-with-lease`, `--mirror`, `--delete`, `--prune`,
// refspec `+ветка` и `:ветка` → блок. Иначе в каталоге push запускается `<гейт> --quiet`; красный или не
// уложившийся во время → блок с хвостом вывода. Проект, у которого `gate` объявлен, fail-closed: битый реестр,
// collab не ответил при записи, заявляющей каталог, нет файла гейта, неожиданное исключение — блок. Собственный
// бюджет времени меньше таймаута хоста (180 с) минус ожидание stdin лаунчером: убитый хостом хук — пропуск.
// Границы (алиасы из конфигурации git, команда, собранная из переменных без слова push) — SECURITY-hooks.md.
import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { CapTimeout, cleanEnv, homeDir, runCapped } from './lib/paths.mjs';
import { gateArgv, gitRoot, projectSettingStrict } from './lib/project.mjs';
import { parseCommand } from './lib/shellparse.mjs';

export const failClosed = true;

const BUDGET_SECONDS_DEFAULT = 150; // таймаут хоста в settings.json — 180, лаунчер ждёт stdin до 4 с; PUSH_GATE_SECONDS — для тестов
const MIN_GATE_MS = 500;

const OPERATORS = new Set(['&&', '||', ';', '\n', '|', '|&']);
const PIPES = new Set(['|', '|&']);
// Подкоманды git, которые могут упоминать push в тексте (сообщение, поиск, `git stash push`), но сами ничего не
// исполняют. Остальные (rebase -x, submodule foreach, bisect run, config alias.*) — блок рядом со словом push.
const GIT_TEXT_SUBCOMMANDS = new Set([
  'commit', 'log', 'show', 'tag', 'notes', 'stash', 'shortlog', 'describe', 'status', 'diff', 'add',
  'checkout', 'switch', 'branch', 'merge', 'reset', 'restore', 'rm', 'mv', 'blame', 'cherry-pick', 'revert', 'remote',
]); // не в списке: grep (-O/--open-files-in-pager), fetch/pull (--upload-pack) — исполняют аргумент
const GIT_HARMLESS_GLOBALS = new Set(['--no-pager', '-P']);
// Куда можно отдать вывод команды, упоминающей push: читатели, не исполняющие вход.
const PIPE_READERS = new Set(['head', 'tail', 'cat', 'tee', 'grep', 'egrep', 'fgrep', 'rg', 'wc', 'sort', 'uniq', 'less', 'more']);
const STRUCTURE = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'for', 'case', 'esac', 'select', 'function', 'in', '[[', ']]', 'coproc']);
const MAY_MENTION_PUSH = new Set(['echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg']);
const FORBIDDEN = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'eval', 'source', '.', 'exec', 'xargs', 'env', 'sudo', 'doas', 'command',
  'builtin', 'nohup', 'time', 'nice', 'stdbuf', 'setsid', 'timeout', 'arch', 'xcrun', 'caffeinate', 'export', 'alias',
  'unalias', 'set', 'declare', 'typeset', 'local', 'readonly', 'unset', 'pushd', 'popd', 'trap', 'hash', 'git-push',
]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SIMPLE_HINT = 'Запусти push отдельной простой командой: `git push …` или `cd <каталог> && git push …`.';

const programName = (word) => path.posix.basename(word.replace(/\\/g, '/')).replace(/\.exe$/i, '').toLowerCase();
const isLongOption = (name, full, minLength) => name.length >= minLength && full.startsWith(name);
const mentionsPush = (word) => /push/i.test(word);

// Есть ли в команде push вообще: слово `git` и `push` после склейки `\`+перевод строки и снятия кавычек и `\`
// (`git p""ush`, `git pu\⏎sh` — тоже push). `$'…'` (`$'\x70ush'`) и автоисправление подкоманды git
// (`help.autocorrect`) прячут слово push — с `git` они сами по себе повод для разбора (и блока).
// Склейки через пустые `$''`, `$""`, `${…}` и спецпеременные (`g$''it`, `p$@ush`) тоже снимаются: bash собирает
// из них то же слово. Переменная с непустым значением (`g$x`) — объявленная граница.
export function mayPush(command) {
  return [command, decodeEscapes(command)].some(mentionsGitPush);
}

// Escape-последовательности, которые раскрывают `$'…'`, `printf` и `echo -e`: `\147it`, `\x67it`, `git` → `git`.
function decodeEscapes(text) {
  return text
    .replace(/\\x([0-9a-fA-F]{1,2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u\{?([0-9a-fA-F]{1,6})\}?/g, (_, h) => String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)))
    .replace(/\\0?([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8) & 0xff));
}

function mentionsGitPush(command) {
  const plain = command
    .replace(/\\\r?\n/g, '')
    .replace(/\$\{[^}]*\}/g, '')
    .replace(/\$(?=["'])/g, '')
    .replace(/\$[@*#?$!0-9-]/g, '')
    .replace(/["'\\]/g, '');
  if (!/\bgit\b/i.test(plain)) return false;
  return /push/i.test(plain) || command.includes("$'") || /autocorrect/i.test(plain);
}

// Нарушение в аргументах после `push` или null. Слова — уже без кавычек.
function pushBypass(args) {
  let optionsEnded = false;
  for (const word of args) {
    if (!optionsEnded && word === '--') {
      optionsEnded = true;
      continue;
    }
    if (word.startsWith('+')) return '+refspec';
    if (word.startsWith(':') && word.length > 1) return ':refspec (удаление ветки)';
    if (optionsEnded || !word.startsWith('-')) continue;
    if (word.startsWith('--')) {
      const name = word.split('=')[0];
      // git принимает однозначные сокращения длинных опций: `--no-ver`, `--forc`.
      if (isLongOption(name, '--force', 3) || name.startsWith('--force')) return '--force';
      if (isLongOption(name, '--no-verify', 6)) return '--no-verify';
      if (isLongOption(name, '--mirror', 4)) return '--mirror';
      if (isLongOption(name, '--delete', 4)) return '--delete';
      if (isLongOption(name, '--prune', 5)) return '--prune';
    } else {
      // Кластер коротких флагов до `-o`: всё после `o` — значение push-option (`-ofoo`), а не флаги.
      for (const ch of word.slice(1)) {
        if (ch === 'o') break;
        if (ch === 'f') return '-f';
        if (ch === 'd') return '-d';
      }
    }
  }
  return null;
}

// Существующий каталог из буквального слова пути; null — не определить или его нет. `physical` — как chdir(2)
// (`git -C`, `cd -P`): `..` после симлинка ведёт в родителя цели, а не лексически назад; иначе — как `cd` в bash.
function existingDir(base, raw, home, { physical = false } = {}) {
  let d = raw;
  if (d === '~' || d.startsWith('~/')) d = `${home}${d.slice(1)}`;
  if (!path.isAbsolute(d)) {
    if (!base) return null;
    d = physical ? `${base}${path.sep}${d}` : path.resolve(base, d);
  }
  try {
    if (!statSync(d).isDirectory()) return null;
    return physical ? realpathSync.native(d) : path.resolve(d);
  } catch {
    return null;
  }
}

// Все push в команде → { pushes: [{ bypass, dir }] } или { reject: причина }. Пустой список — push нет.
export function analyzePushes(command, cwd, home) {
  if (!mayPush(command)) return { pushes: [] };
  if (/[$`]/.test(command)) return { reject: 'подстановка (`$`, обратные кавычки) в команде с push' };
  if (/autocorrect/i.test(command)) return { reject: 'автоисправление подкоманд git в команде с push' };
  if (/(^|[^&|>])&\s*$/.test(command)) return { reject: '`&` (фон) в команде с push' }; // разбор теряет конечный оператор
  if (command.includes('<<')) return { reject: 'heredoc в команде с push' };
  const parsed = parseCommand(command);
  if (!parsed) return { reject: 'команду не разобрать' };
  const segments = parsed.segments;
  const ops = segments.flatMap((s) => s.pre);
  const odd = ops.find((op) => !OPERATORS.has(op));
  if (odd !== undefined) return { reject: `\`${odd === '\n' ? '\\n' : odd}\` (скобки, блок или фон) в команде с push` };

  const pushes = [];
  let dir = cwd; // null — каталог неизвестен
  let listMovedConditionally = false; // в текущей цепочке `&&` был cd не в её начале
  const hasOr = ops.includes('||');
  let carriesPush = false; // левая часть текущего конвейера упоминает push
  for (let k = 0; k < segments.length; k += 1) {
    const { words, heredocs, heredocSubs, subs, pre } = segments[k];
    if (heredocs.length || heredocSubs.length || subs.length) return { reject: 'подстановка или heredoc в команде с push' };
    const op = pre.at(-1) ?? null;
    const startsList = op === null || op === ';' || op === '\n';
    if (startsList && listMovedConditionally) {
      dir = null; // предыдущая цепочка могла оборваться до своего cd
      listMovedConditionally = false;
    }
    if (words.length === 0) continue;
    if (ASSIGNMENT.test(words[0])) return { reject: 'присваивание переменных в команде с push' };
    if (STRUCTURE.has(words[0])) return { reject: `\`${words[0]}\` в команде с push` };
    const name = programName(words[0]);
    if (FORBIDDEN.has(name)) return { reject: `\`${name}\` в команде с push` };
    const piped = PIPES.has(op);
    if (piped && carriesPush && !PIPE_READERS.has(name)) return { reject: `вывод со словом push уходит в \`${name}\`` };
    carriesPush = words.some(mentionsPush) || (piped && carriesPush);
    const inPipe = piped || segments[k + 1]?.pre.some((p) => PIPES.has(p));

    if (name === 'cd') {
      if (inPipe || hasOr) return { reject: '`cd` в конвейере или рядом с `||` в команде с push' };
      // bash отвергает незнакомую опцию и остаётся на месте (`cd -Z /tmp; git push` пушит отсюда): только -P, -L, --.
      const options = [];
      let at = 1;
      while (at < words.length && words[at].startsWith('-') && words[at] !== '-') {
        if (words[at] === '--') {
          at += 1;
          break;
        }
        options.push(words[at]);
        at += 1;
      }
      const odd = options.find((o) => !/^-[PL]+$/.test(o));
      if (odd !== undefined) return { reject: `\`cd ${odd}\` — опция, с которой каталог не определить` };
      if (words.length > at + 1) return { reject: '`cd` с несколькими аргументами в команде с push' };
      const target = words[at] ?? '~';
      const moved = target === '-' ? null : existingDir(dir, target, home, { physical: options.join('').lastIndexOf('P') > options.join('').lastIndexOf('L') }); // последняя из -P/-L
      if (moved === null) return { reject: `каталог \`cd ${target}\` не определить или его нет` };
      dir = moved;
      if (!startsList) listMovedConditionally = true;
      continue;
    }

    if (name === 'git') {
      let i = 1;
      let pushDir = dir;
      const otherGlobals = [];
      while (i < words.length && words[i].startsWith('-')) {
        if (words[i] === '-C' && i + 1 < words.length) {
          pushDir = pushDir === null ? null : existingDir(pushDir, words[i + 1], home, { physical: true });
          i += 2;
        } else {
          if (!GIT_HARMLESS_GLOBALS.has(words[i])) otherGlobals.push(words[i]);
          i += 1;
        }
      }
      const sub = words[i];
      if (sub === 'push') {
        if (otherGlobals.length) return { reject: `глобальные опции git (${otherGlobals.join(' ')}) перед push` };
        if (pushDir === null) return { reject: 'не определить, в каком каталоге исполнится push' };
        pushes.push({ bypass: pushBypass(words.slice(i + 1)), dir: pushDir });
      } else if (words.some(mentionsPush) && (otherGlobals.length || !GIT_TEXT_SUBCOMMANDS.has(sub))) {
        return { reject: `\`git ${[...otherGlobals, sub ?? ''].join(' ').trim()}\` рядом со словом push` };
      }
      continue;
    }

    if (words.some(mentionsPush) && !MAY_MENTION_PUSH.has(name)) return { reject: `push внутри \`${name}\`` };
  }
  return { pushes };
}

export async function main({ stdinText, env, cwd: hostCwd, stderr }) {
  const started = Date.now();
  let event;
  try {
    event = JSON.parse(stdinText);
  } catch {
    return 0;
  }
  const command = event?.tool_input?.command;
  if (typeof command !== 'string') return 0;
  const home = homeDir(env);
  const cwd = typeof event.cwd === 'string' && event.cwd ? event.cwd : hostCwd;

  try {
    const result = analyzePushes(command, cwd, home);
    if (result.reject) {
      stderr(`push-gate: ${result.reject} — push заблокирован. ${SIMPLE_HINT}\n`);
      return 2;
    }
    const pushes = result.pushes;
    if (pushes.length === 0) return 0;

    const violation = pushes.find((p) => p.bypass);
    if (violation) {
      stderr(
        `push-gate: \`${violation.bypass}\` в git push запрещён (никогда --force, никогда --no-verify). ` +
          'Почини то, на что ругается гейт, или отдай push владельцу.\n'
      );
      return 2;
    }

    const budgetMs = (Number(env.PUSH_GATE_SECONDS) > 0 ? Number(env.PUSH_GATE_SECONDS) : BUDGET_SECONDS_DEFAULT) * 1000;
    const left = () => budgetMs - (Date.now() - started);
    const limited = () => Math.min(5000, Math.max(left(), MIN_GATE_MS));

    const ran = new Set();
    for (const dir of new Set(pushes.map((p) => p.dir))) {
      const setting = projectSettingStrict(dir, home, 'gate', { timeoutMs: limited() });
      if (setting.state === 'none') continue;
      if (setting.state === 'broken') {
        stderr(`push-gate: настройки проекта не читаются (${setting.reason}) — push заблокирован.\n`);
        return 2;
      }
      if (typeof setting.value !== 'string' || !setting.value) {
        stderr('push-gate: `gate` в реестре проекта — не непустая строка; push заблокирован.\n');
        return 2;
      }
      const root = gitRoot(dir, cleanEnv(home), limited());
      const gate = path.resolve(root, setting.value);
      if (ran.has(gate)) continue;
      if (!existsSync(gate)) {
        stderr(`push-gate: гейт ${setting.value} объявлен в реестре, но файла нет (${gate}) — push заблокирован.\n`);
        return 2;
      }

      const gateMs = Math.max(left(), MIN_GATE_MS);
      let run;
      try {
        run = await runCapped(gateArgv(gate, ['--quiet']), { cwd: root, env: cleanEnv(home), timeoutMs: gateMs });
      } catch (error) {
        if (error instanceof CapTimeout) {
          stderr(`push-gate: гейт ${setting.value} не уложился в ${Math.round(gateMs / 1000)} с — push заблокирован.\n`);
          return 2;
        }
        stderr(`push-gate: гейт ${setting.value} не запустился (${error?.message ?? error}) — push заблокирован.\n`);
        return 2;
      }
      ran.add(gate);
      if (run.status === 0) continue;
      const tail = `${run.stdout}${run.stderr}`.trim().split(/\r?\n/).slice(-40).join('\n');
      stderr(`push-gate: гейт ${setting.value} красный — push заблокирован. Вывод:\n${tail}\n`);
      return 2;
    }
    return 0;
  } catch (error) {
    stderr(`push-gate: неожиданная ошибка (${error?.message ?? error}) — push заблокирован.\n`);
    return 2;
  }
}
