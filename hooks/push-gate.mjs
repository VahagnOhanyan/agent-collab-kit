// PreToolUse-хук ведущей сессии Claude Code (Bash): `git push` — только через зелёный гейт проекта и без
// обходов. Гейт — `gate` в доверенном реестре проекта (путь от корня рабочего дерева, например
// scripts/preflight.sh). Установщик вписывает хук в settings.json каждого конфига Claude.
//
//   1. Команда разбирается как оболочка (hooks/lib/shellparse.mjs): push — это запуск `git … push`
//      в одном из сегментов, а не строка `git push` внутри echo, heredoc или сообщения коммита.
//      Понимаются кавычки (`git p""ush`), `git -C "путь с пробелом"`, `-c alias.p=push`, `sh -c "…"`, `eval`,
//      обёртки (env, sudo, xargs…), heredoc в оболочку и `$(…)`.
//   2. `--no-verify`, `--force`, `-f` (в т.ч. `-fu`), `--force-with-lease`, сокращения длинных опций,
//      refspec `+ветка` (и `"+ветка"`), `-c core.hooksPath=…` → блок (код 2).
//   3. Иначе запускается `<гейт> --quiet`; красный или не уложившийся во время → блок с хвостом вывода.
//
// Ведущая сессия, не граница. Проход — только когда защищаться нечем: непонятный вход, набор collab не
// установлен или не ответил, проект не зарегистрирован, в его реестре нет ключа `gate`. Проект, у которого
// `gate` объявлен, fail-closed: битый реестр, неверный тип, нет файла гейта, гейт не запустился — блок.
// Собственный бюджет времени меньше таймаута хоста (180 с): убитый хостом хук считается пропуском.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { CapTimeout, cleanEnv, homeDir, runCapped } from './lib/paths.mjs';
import { gateArgv, gitRoot, projectSettingStrict } from './lib/project.mjs';
import { parseCommand } from './lib/shellparse.mjs';

// Запасной путь, когда команду разобрать нельзя (незакрытая кавычка): прежний поиск по сырой строке.
export const PUSH_RE = /\bgit\b(?:\s+(?:-C\s+\S+|-c\s+\S+|--?[\w-]+(?:=\S+)?))*\s+push\b/;
export const BYPASS_RE = /(?:^|\s)(--no-verify|--force|-f|--force-with-lease(?:=\S+)?|\+\S+)(?=\s|$)/;

const BUDGET_SECONDS_DEFAULT = 160; // таймаут хоста в settings.json — 180; PUSH_GATE_SECONDS — только для тестов
const MIN_GATE_MS = 500;
const MAX_DEPTH = 4;

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const WRAPPERS = new Set(['env', 'sudo', 'doas', 'command', 'exec', 'nohup', 'time', 'nice', 'xargs', 'stdbuf', 'builtin', 'setsid', 'timeout']);
const KEYWORDS = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until']);
const GIT_GLOBALS_WITH_ARG = new Set(['-C', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env']);

const programName = (word) => path.posix.basename(word.replace(/\\/g, '/')).replace(/\.exe$/i, '').toLowerCase();

// Нарушение в аргументах после `push` или null. Слова — уже без кавычек.
function pushBypass(args) {
  let optionsEnded = false;
  for (const word of args) {
    if (!optionsEnded && word === '--') {
      optionsEnded = true;
      continue;
    }
    if (word.startsWith('+')) return '+refspec';
    if (optionsEnded || !word.startsWith('-')) continue;
    if (word.startsWith('--')) {
      const name = word.split('=')[0];
      // git принимает однозначные сокращения длинных опций: `--no-ver`, `--forc`.
      if (name.length >= 3 && ('--force'.startsWith(name) || name.startsWith('--force'))) return '--force';
      if (name.length >= 6 && '--no-verify'.startsWith(name)) return '--no-verify';
    } else if (/^-[A-Za-z0-9]*f/.test(word)) {
      return '-f';
    }
  }
  return null;
}

// Слова аргументов git после глобальных опций → { sub, rest, hooksOff, aliases }.
function parseGit(args) {
  const aliases = new Map();
  let hooksOff = false;
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '-c') {
      const kv = args[i + 1] ?? '';
      const eq = kv.indexOf('=');
      const key = (eq === -1 ? kv : kv.slice(0, eq)).toLowerCase();
      if (key === 'core.hookspath') hooksOff = true;
      if (key.startsWith('alias.')) aliases.set(key.slice(6), eq === -1 ? '' : kv.slice(eq + 1));
      i += 2;
    } else if (GIT_GLOBALS_WITH_ARG.has(a)) {
      i += 2;
    } else if (a.startsWith('-')) {
      i += 1;
    } else {
      break;
    }
  }
  return { sub: args[i], rest: args.slice(i + 1), hooksOff, aliases };
}

function firstProgramIndex(words) {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || KEYWORDS.has(w)) {
      i += 1;
    } else if (WRAPPERS.has(programName(w))) {
      let j = i + 1;
      while (j < words.length && !(programName(words[j]) === 'git' || SHELLS.has(programName(words[j])) || programName(words[j]) === 'eval')) j += 1;
      if (j >= words.length) return -1;
      i = j;
    } else {
      return i;
    }
  }
  return -1;
}

// Все запуски `git push` в команде: [{ bypass: string|null }]; null — команду разобрать нельзя.
export function findPushes(command, depth = 0) {
  if (depth > MAX_DEPTH) return [];
  const parsed = parseCommand(command);
  if (!parsed) return null;
  const pushes = [];
  const recurse = (text) => {
    const inner = findPushes(text, depth + 1);
    if (inner === null) return false;
    pushes.push(...inner);
    return true;
  };
  for (const { words, heredocs } of parsed.segments) {
    for (const word of words) {
      if (word.includes('$(') || word.includes('`')) if (!recurse(word)) return null;
    }
    const at = firstProgramIndex(words);
    if (at === -1) continue;
    const name = programName(words[at]);
    const args = words.slice(at + 1);
    if (name === 'git') {
      const { sub, rest, hooksOff, aliases } = parseGit(args);
      if (sub === undefined) continue;
      const alias = aliases.get(sub);
      const aliasWords = alias === undefined ? [] : alias.replace(/^!/, '').split(/\s+/).filter(Boolean);
      const isPush = sub === 'push' || (alias !== undefined && aliasWords.includes('push'));
      if (isPush) pushes.push({ bypass: hooksOff ? '-c core.hooksPath' : pushBypass([...aliasWords.filter((w) => w !== 'push' && w !== 'git'), ...rest]) });
      else if (alias?.startsWith('!') && !recurse(`${alias.slice(1)} ${rest.join(' ')}`)) return null;
    } else if (SHELLS.has(name)) {
      const c = args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
      if (c !== -1 && args[c + 1] !== undefined) {
        if (!recurse(args[c + 1])) return null;
      } else {
        for (const body of heredocs) if (!recurse(body)) return null;
      }
    } else if (name === 'eval') {
      if (!recurse(args.join(' '))) return null;
    }
  }
  return pushes;
}

export async function main({ stdinText, env, cwd: hostCwd, stderr }) {
  try {
    const started = Date.now();
    let event;
    try {
      event = JSON.parse(stdinText);
    } catch {
      return 0;
    }
    const command = event?.tool_input?.command;
    if (typeof command !== 'string') return 0;

    let pushes = findPushes(command);
    if (pushes === null) {
      const raw = PUSH_RE.test(command);
      const bypass = raw ? BYPASS_RE.exec(command) : null;
      pushes = raw ? [{ bypass: bypass ? bypass[1] : null }] : [];
    }
    if (pushes.length === 0) return 0;

    const violation = pushes.find((p) => p.bypass);
    if (violation) {
      stderr(
        `push-gate: \`${violation.bypass}\` в git push запрещён (никогда --force, никогда --no-verify). ` +
          'Почини то, на что ругается гейт, или отдай push владельцу.\n'
      );
      return 2;
    }

    const home = homeDir(env);
    const budgetMs = (Number(env.PUSH_GATE_SECONDS) > 0 ? Number(env.PUSH_GATE_SECONDS) : BUDGET_SECONDS_DEFAULT) * 1000;
    const left = () => budgetMs - (Date.now() - started);
    const cwd = typeof event.cwd === 'string' && event.cwd ? event.cwd : hostCwd;

    const setting = projectSettingStrict(cwd, home, 'gate', { timeoutMs: Math.min(5000, Math.max(left(), MIN_GATE_MS)) });
    if (setting.state === 'none') return 0;
    if (setting.state === 'broken') {
      stderr(`push-gate: настройки проекта не читаются (${setting.reason}) — push заблокирован.\n`);
      return 2;
    }
    if (typeof setting.value !== 'string' || !setting.value) {
      stderr('push-gate: `gate` в реестре проекта — не непустая строка; push заблокирован.\n');
      return 2;
    }
    const root = gitRoot(cwd, cleanEnv(home), Math.min(5000, Math.max(left(), MIN_GATE_MS)));
    const gate = path.resolve(root, setting.value);
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
    if (run.status === 0) return 0;
    const tail = `${run.stdout}${run.stderr}`.trim().split(/\r?\n/).slice(-40).join('\n');
    stderr(`push-gate: гейт ${setting.value} красный — push заблокирован. Вывод:\n${tail}\n`);
    return 2;
  } catch {
    return 0;
  }
}
