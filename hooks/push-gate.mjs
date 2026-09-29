// PreToolUse-хук ведущей сессии Claude Code (Bash): `git push` — только через зелёный гейт проекта и без
// обходов. Гейт — `gate` в доверенном реестре проекта (путь от корня рабочего дерева, например
// scripts/preflight.sh). Установщик вписывает хук в settings.json каждого конфига Claude.
//
//   1. Команда разбирается как оболочка (hooks/lib/shellparse.mjs): push — это запуск `git … push`
//      в одном из сегментов, а не строка `git push` внутри echo, комментария, heredoc или сообщения коммита.
//      Понимаются кавычки (`git p""ush`), `git -C "путь с пробелом"`, `-c alias.p=push`, `sh -c "…"`, `eval`,
//      обёртки (env, sudo, xargs…), heredoc и here-string в оболочку, `$(…)` в том числе в двойных кавычках.
//   2. Проект берётся по каталогу, в котором push исполнится: `git -C X`, `--git-dir`/`--work-tree`,
//      `GIT_DIR=`, `env -C`, предшествующий `cd X &&` — а не по каталогу сессии.
//   3. `--no-verify`, `--force`, `-f` (в т.ч. `-fu`), `--force-with-lease`, `--mirror`, `--delete`, `--prune`,
//      refspec `+ветка` и `:ветка`, `-c core.hooksPath=…` (и то же через GIT_CONFIG_*), `-c remote.*.push=+…`
//      → блок (код 2).
//   4. Иначе запускается `<гейт> --quiet`; красный или не уложившийся во время → блок с хвостом вывода.
//
// Ведущая сессия, не граница: косвенные вызовы (переменные, алиасы из конфигурации, функции, `| bash`,
// `git send-pack`) не гарантируются — см. SECURITY-hooks.md. Проход — только когда защищаться нечем: непонятный
// вход, набор collab не установлен или не ответил, проект не зарегистрирован, в его реестре нет ключа `gate`.
// Проект, у которого `gate` объявлен, fail-closed: битый реестр, неверный тип, нет файла гейта, гейт не
// запустился, неожиданное исключение — блок. Собственный бюджет времени меньше таймаута хоста (180 с) минус
// ожидание stdin лаунчером: убитый хостом хук считается пропуском.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { CapTimeout, cleanEnv, homeDir, runCapped } from './lib/paths.mjs';
import { gateArgv, gitRoot, projectSettingStrict } from './lib/project.mjs';
import { parseCommand } from './lib/shellparse.mjs';

export const failClosed = true;

// Запасной путь, когда команду разобрать нельзя (незакрытая кавычка): прежний поиск по сырой строке.
export const PUSH_RE = /\bgit\b(?:\s+(?:-C\s+\S+|-c\s+\S+|--?[\w-]+(?:=\S+)?))*\s+push\b/;
export const BYPASS_RE = /(?:^|\s)(--no-verify|--force|-f|--force-with-lease(?:=\S+)?|--mirror|--delete|-d|--prune|[+:]\S+)(?=\s|$)/;

const BUDGET_SECONDS_DEFAULT = 150; // таймаут хоста в settings.json — 180, лаунчер ждёт stdin до 4 с; PUSH_GATE_SECONDS — для тестов
const MIN_GATE_MS = 500;
const MAX_DEPTH = 4;

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const WRAPPERS = new Set(['env', 'sudo', 'doas', 'command', 'exec', 'nohup', 'time', 'nice', 'xargs', 'stdbuf', 'builtin', 'setsid', 'timeout']);
const KEYWORDS = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until']);
const GIT_GLOBALS_WITH_ARG = new Set(['-C', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env']);
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;

const programName = (word) => path.posix.basename(word.replace(/\\/g, '/')).replace(/\.exe$/i, '').toLowerCase();
const isLongOption = (name, full, minLength) => name.length >= minLength && full.startsWith(name);

// `git -c ключ=значение` и то же через окружение: что из этого отключает хуки или делает push принудительным.
function configOverride(rawKey, value) {
  const key = rawKey.toLowerCase();
  if (key === 'core.hookspath') return '-c core.hooksPath';
  if (/^remote\..+\.mirror$/.test(key)) return '-c remote.*.mirror';
  if (/^remote\..+\.push$/.test(key) && /^[+:]/.test(value)) return '-c remote.*.push';
  return null;
}

function envConfigOverride(env) {
  for (const [name, key] of Object.entries(env)) {
    const m = /^GIT_CONFIG_KEY_(\d+)$/.exec(name);
    if (!m) continue;
    const hit = configOverride(key, env[`GIT_CONFIG_VALUE_${m[1]}`] ?? '');
    if (hit) return hit;
  }
  const parameters = env.GIT_CONFIG_PARAMETERS ?? '';
  for (const m of parameters.matchAll(/'([^']+)'='([^']*)'/g)) {
    const hit = configOverride(m[1], m[2]);
    if (hit) return hit;
  }
  for (const m of parameters.matchAll(/'([^'=]+)=([^']*)'/g)) {
    const hit = configOverride(m[1], m[2]);
    if (hit) return hit;
  }
  return null;
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
      if (isLongOption(name, '--delete', 5)) return '--delete';
      if (isLongOption(name, '--prune', 5)) return '--prune';
    } else if (/^-[A-Za-z0-9]*[fd]/.test(word)) {
      return word.includes('f') ? '-f' : '-d';
    }
  }
  return null;
}

// Слова аргументов git после глобальных опций → { sub, rest, override, aliases, dirs }.
function parseGit(args) {
  const aliases = new Map();
  const dirs = { C: [], gitDir: null, workTree: null };
  let override = null;
  const note = (key, value) => {
    override ??= configOverride(key, value);
  };
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    const eq = a.indexOf('=');
    const [flag, inline] = a.startsWith('--') && eq !== -1 ? [a.slice(0, eq), a.slice(eq + 1)] : [a, null];
    if (a === '-c') {
      const kv = args[i + 1] ?? '';
      const at = kv.indexOf('=');
      const key = at === -1 ? kv : kv.slice(0, at);
      const value = at === -1 ? '' : kv.slice(at + 1);
      note(key, value);
      if (key.toLowerCase().startsWith('alias.')) aliases.set(key.toLowerCase().slice(6), value);
      i += 2;
    } else if (GIT_GLOBALS_WITH_ARG.has(flag)) {
      const value = inline ?? args[i + 1] ?? '';
      if (flag === '-C') dirs.C.push(value);
      else if (flag === '--git-dir') dirs.gitDir = value;
      else if (flag === '--work-tree') dirs.workTree = value;
      else if (flag === '--config-env') note(value.split('=')[0], '');
      i += inline === null ? 2 : 1;
    } else if (a.startsWith('-')) {
      i += 1;
    } else {
      break;
    }
  }
  return { sub: args[i], rest: args.slice(i + 1), override, aliases, dirs };
}

// Префикс команды: присваивания `NAME=v`, ключевые слова и обёртки. → { at, env, chdir }; at === -1, если программы нет.
function analyzePrefix(words) {
  const env = {};
  let chdir = null;
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    const assign = ASSIGNMENT.exec(w);
    if (assign) {
      env[assign[1]] = assign[2];
      i += 1;
    } else if (KEYWORDS.has(w)) {
      i += 1;
    } else if (WRAPPERS.has(programName(w))) {
      const isEnv = programName(w) === 'env';
      let j = i + 1;
      while (j < words.length && !(programName(words[j]) === 'git' || SHELLS.has(programName(words[j])) || programName(words[j]) === 'eval')) {
        const x = words[j];
        const a2 = ASSIGNMENT.exec(x);
        if (a2) env[a2[1]] = a2[2];
        else if (isEnv && (x === '-C' || x === '--chdir') && j + 1 < words.length) chdir = words[++j];
        else if (isEnv && x.startsWith('--chdir=')) chdir = x.slice(8);
        j += 1;
      }
      if (j >= words.length) return { at: -1, env, chdir };
      i = j;
    } else {
      return { at: i, env, chdir };
    }
  }
  return { at: -1, env, chdir };
}

// Каталог, полученный из слова пути; null — не определить (переменная, `cd -`, нет базового каталога).
function resolveDir(base, raw, home) {
  if (typeof raw !== 'string' || /[$`*?]/.test(raw)) return null;
  let d = raw;
  if (d === '~' || d.startsWith('~/')) {
    if (!home) return null;
    d = path.join(home, d.slice(1));
  }
  if (path.isAbsolute(d)) return path.resolve(d);
  return base ? path.resolve(base, d) : null;
}

// Каталог, в котором git push увидит репозиторий: cwd оболочки → `env -C` → `-C…` → --work-tree/--git-dir.
function pushDirectory(base, chdir, dirs, env, home) {
  let cur = base;
  const step = (raw) => {
    cur = resolveDir(cur, raw, home);
  };
  if (chdir) step(chdir);
  for (const c of dirs.C) step(c);
  const gitDir = dirs.gitDir ?? env.GIT_DIR ?? null;
  const workTree = dirs.workTree ?? env.GIT_WORK_TREE ?? null;
  if (workTree) step(workTree);
  else if (gitDir) {
    const g = resolveDir(cur, gitDir, home);
    cur = g === null ? null : path.basename(g) === '.git' ? path.dirname(g) : g;
  }
  return cur;
}

// Все запуски `git push` в команде: [{ bypass: string|null, dir: string|null }]; null — команду разобрать нельзя.
// `state` — { cwd, env, home }: каталог оболочки (его двигает `cd`) и присвоенные ранее переменные.
export function findPushes(command, state = { cwd: null, env: {}, home: null }, depth = 0) {
  if (depth > MAX_DEPTH) return [];
  const parsed = parseCommand(command);
  if (!parsed) return null;
  const pushes = [];
  const local = { cwd: state.cwd, env: { ...state.env }, home: state.home };
  const recurse = (text, inner = local) => {
    const found = findPushes(text, { cwd: inner.cwd, env: { ...inner.env }, home: inner.home }, depth + 1);
    if (found === null) return false;
    pushes.push(...found);
    return true;
  };
  for (const { words, heredocs, heredocSubs, subs } of parsed.segments) {
    for (const text of [...subs, ...heredocSubs]) if (!recurse(text)) return null;
    const { at, env: prefixEnv, chdir } = analyzePrefix(words);
    if (at === -1) {
      Object.assign(local.env, prefixEnv); // `NAME=v` без команды задаёт переменную оболочки
      continue;
    }
    const name = programName(words[at]);
    const args = words.slice(at + 1);
    const env = { ...local.env, ...prefixEnv };
    const cwdHere = chdir ? resolveDir(local.cwd, chdir, local.home) : local.cwd;
    if (name === 'cd' || name === 'pushd') {
      const target = args.find((a) => !a.startsWith('-'));
      local.cwd = target === undefined ? local.home : target === '-' ? null : resolveDir(local.cwd, target, local.home);
    } else if (name === 'git') {
      const { sub, rest, override, aliases, dirs } = parseGit(args);
      if (sub === undefined) continue;
      const alias = aliases.get(sub);
      const aliasWords = alias === undefined ? [] : alias.replace(/^!/, '').split(/\s+/).filter(Boolean);
      const isPush = sub === 'push' || (alias !== undefined && aliasWords.includes('push'));
      if (isPush) {
        const bypass = override ?? envConfigOverride(env) ?? pushBypass([...aliasWords.filter((w) => w !== 'push' && w !== 'git'), ...rest]);
        pushes.push({ bypass, dir: pushDirectory(cwdHere, null, dirs, env, local.home) });
      } else if (alias?.startsWith('!') && !recurse(`${alias.slice(1)} ${rest.join(' ')}`, { cwd: cwdHere, env, home: local.home })) return null;
    } else if (SHELLS.has(name)) {
      const inner = { cwd: cwdHere, env, home: local.home };
      const c = args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
      if (c !== -1 && args[c + 1] !== undefined) {
        if (!recurse(args[c + 1], inner)) return null;
      } else {
        // heredoc — код только если оболочка читает stdin: нет файла-скрипта (`bash script.sh <<EOF` — данные для него)
        const operands = args.filter((a, k) => !a.startsWith('-') && !a.startsWith('+') && !/^[-+]o$/.test(args[k - 1] ?? ''));
        if (operands.length === 0 || args.includes('-s')) for (const body of heredocs) if (!recurse(body, inner)) return null;
      }
    } else if (name === 'eval') {
      if (!recurse(args.join(' '), { cwd: cwdHere, env, home: local.home })) return null;
    }
  }
  return pushes;
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

  let pushes;
  try {
    pushes = findPushes(command, { cwd, env: {}, home });
  } catch {
    pushes = null;
  }
  if (pushes === null) {
    const raw = PUSH_RE.test(command);
    const bypass = raw ? BYPASS_RE.exec(command) : null;
    pushes = raw ? [{ bypass: bypass ? bypass[1] : null, dir: cwd }] : [];
  }
  if (pushes.length === 0) return 0;

  try {
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

    // Каталог push, которого нет на диске (или не определить), — каталог сессии: push оттуда всё равно упадёт сам.
    const dirs = [...new Set(pushes.map((p) => (p.dir && existsSync(p.dir) ? p.dir : cwd)))];
    const ran = new Set();
    for (const dir of dirs) {
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
