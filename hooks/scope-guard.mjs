// PreToolUse-хук (Edit|Write|NotebookEdit) для агентов-исполнителей комплекта.
//
// Правка файла вне области агента блокируется, а не «не рекомендуется»: словесная инструкция в
// промпте — контекст, а этот хук — проверка перед записью. Семантика хоста: код 2 отменяет вызов,
// stderr уходит агенту; ЛЮБОЙ другой код, падение или таймаут — «неблокирующая ошибка», запись
// проходит. Поэтому каждый нештатный путь здесь обязан закончиться кодом 2 (fail-closed):
// `failClosed = true` говорит лаунчеру блокировать и при незакрытом stdin. Модель угроз и остаточные
// риски (TOCTOU, Bash, таймаут хоста, Windows) — в hooks/SECURITY-hooks.md.
//
// Область не задаётся окружением. Корень кода и id проекта — из `collab project --json` набора
// (cwd — из события), допустимые пути — из доверенного реестра `<registryDir>/<projectId>/scopes.json`
// по имени агента (`KIT_AGENT` из frontmatter). Переопределений пути к collab нет.
//
// Порядок проверок:
//   0. Событие: tool_name ∈ {Edit, Write, NotebookEdit}; поле пути соответствует инструменту и не
//      задано дважды; cwd есть и абсолютный; в строках нет NUL и непредставимых в UTF-8 символов.
//   1. Жёсткий запрет по лексическому абсолютному пути И по realpath: ~/agent-kit, ~/.agent-kit,
//      ~/.claude, ~/.codex (от $HOME/$USERPROFILE и от домашнего каталога ОС).
//   1б. Цель — обычный файл с единственным именем или ещё не существует.
//   2. Временный каталог ОС — разрешён, только если оба пути под ним, в пути нет .git/.claude/
//      .collab/.mcp.json и цель НЕ внутри git-репозитория. Иначе — обычные правила проекта.
//   3. collab project --json (таймаут 5 с, дерево процессов убивается) — любая ошибка блокирует.
//   4. Цель (realpath) внутри realpath(codeRoot).
//   5. .git, .claude, .collab, .mcp.json как компонент где угодно внутри корня.
//   6–7. projectId/registryDir валидны, scopes.json читается, есть запись агента, allow/deny —
//      списки непустых строк без `..`.
//   8. deny по границе компонента — блок; 9. нет allow — блок.
//
// Все компоненты путей и шаблонов сравниваются в свёрнутом виде (NFC + регистр): том нечувствителен
// к регистру и нормализации, а realpath сохраняет написание вызывающего. На Windows дополнительно
// отбрасываются хвостовые точки/пробелы и суффикс потока `:…` (`.git.` и `.git::$INDEX_ALLOCATION` —
// это `.git`).
import { existsSync, lstatSync, readFileSync, statSync, accessSync, constants } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import {
  CapTimeout, IS_WINDOWS, cleanEnv, killActiveChildren, realpathLoose, runCapped,
} from './lib/paths.mjs';

export const failClosed = true;

const COLLAB_TIMEOUT_MS = 5000;
const GIT_TIMEOUT_MS = 3000;
// Сторож на весь хук: collab (5 с) + git (3 с) укладываются, таймаут хоста — 15 с. Сработал сторож —
// код 2, а не убийство хостом (= пропуск).
const WATCHDOG_MS = 10_000;

const NOT_A_REPO = 'not a git repository (or any of the parent directories)';
const TOOL_PATH_FIELD = { Edit: 'file_path', Write: 'file_path', NotebookEdit: 'notebook_path' };
const PATH_FIELDS = ['file_path', 'notebook_path'];
const PROTECTED_HOME_DIRS = ['agent-kit', '.agent-kit', '.claude', '.codex'];
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

class Blocked extends Error {}

// ── свёртка путей ─────────────────────────────────────────────────────────────

export function foldPart(part, windows = IS_WINDOWS) {
  let folded = part.normalize('NFD').toUpperCase().toLowerCase().normalize('NFC');
  if (windows) folded = folded.split(':')[0].replace(/[. ]+$/, '');
  return folded;
}

const HARD_DENY_NAMES = new Set(['.git', '.claude', '.collab', '.mcp.json']);

export function rawParts(p, windows = IS_WINDOWS) {
  return p.split(windows ? /[\\/]/ : /\//).filter((x) => x !== '' && x !== '.');
}

export const foldedParts = (p, windows = IS_WINDOWS) => rawParts(p, windows).map((x) => foldPart(x, windows));

export const isUnder = (parts, rootParts) => rootParts.length <= parts.length && rootParts.every((x, i) => parts[i] === x);

// ── проверки значений ─────────────────────────────────────────────────────────

function safeStr(value, what) {
  if (typeof value !== 'string' || value === '') throw new Blocked(`${what}: ожидалась непустая строка — блокирую`);
  if (value.includes('\0')) throw new Blocked(`${what} содержит NUL-байт — блокирую`);
  if (LONE_SURROGATE.test(value)) throw new Blocked(`${what} содержит символы, непредставимые в UTF-8 — блокирую`);
  return value;
}

function safeAbs(value, what) {
  safeStr(value, what);
  if (!path.isAbsolute(value)) throw new Blocked(`${what} должен быть абсолютным путём, получено ${JSON.stringify(value)} — блокирую`);
  return value;
}

function loadEvent(stdinBuffer) {
  if (stdinBuffer.toString('utf8').trim() === '') throw new Blocked('пустое событие хука — блокирую на всякий случай');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(stdinBuffer);
  } catch {
    throw new Blocked('событие хука не в UTF-8 — блокирую на всякий случай');
  }
  let event;
  try {
    event = JSON.parse(text);
  } catch {
    throw new Blocked('событие хука пришло не в формате JSON — блокирую на всякий случай');
  }
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    throw new Blocked('событие хука имеет неожиданный формат (не объект) — блокирую на всякий случай');
  }
  return event;
}

function parsePatterns(value, key, scopesPath) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Blocked(`${scopesPath}: «${key}» должен быть списком строк — блокирую`);
  return value.map((item) => {
    if (typeof item !== 'string' || item.includes('\0')) {
      throw new Blocked(`${scopesPath}: в «${key}» некорректный элемент ${JSON.stringify(item)} — блокирую`);
    }
    const raw = rawParts(item);
    const parts = raw.map((x) => foldPart(x));
    if (parts.length === 0 || raw.includes('..') || parts.some((x) => x === '')) {
      throw new Blocked(`${scopesPath}: в «${key}» некорректный шаблон ${JSON.stringify(item)} — блокирую`);
    }
    return parts;
  });
}

// ── git ───────────────────────────────────────────────────────────────────────

function gitCandidates(env) {
  if (!IS_WINDOWS) return ['/usr/bin/git', '/opt/homebrew/bin/git'];
  return [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')]
    .filter(Boolean)
    .flatMap((base) => [path.join(base, 'Git', 'cmd', 'git.exe'), path.join(base, 'Git', 'bin', 'git.exe')]);
}

function isExecutableFile(file) {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function existingParent(p) {
  let current = path.dirname(p);
  for (;;) {
    try {
      if (statSync(current).isDirectory()) return current;
    } catch {
      // поднимаемся выше
    }
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

// true — внутри репозитория ИЛИ не удалось надёжно выяснить.
async function maybeInsideGitRepo(realTarget, home, env) {
  const git = gitCandidates(env).find(isExecutableFile);
  if (!git) return true;
  try {
    const out = await runCapped([git, 'rev-parse', '--absolute-git-dir'], {
      cwd: existingParent(realTarget),
      env: { ...cleanEnv(home), LC_ALL: 'C', LANG: 'C' },
      timeoutMs: GIT_TIMEOUT_MS,
    });
    return !(out.status === 128 && out.stderr.toString('latin1').includes(NOT_A_REPO));
  } catch {
    return true;
  }
}

function tmpRoots() {
  if (!IS_WINDOWS) return ['/tmp', '/private/tmp'];
  return [...new Set([tmpdir(), realpathLoose(tmpdir())])];
}

// ── collab ────────────────────────────────────────────────────────────────────

async function collabInfo(cwd, home) {
  const script = path.join(home, '.agent-kit', 'current', 'bin', 'collab');
  if (!existsSync(script)) throw new Blocked(`не найден ${script} — набор не установлен, блокирую`);
  let out;
  try {
    out = await runCapped([process.execPath, script, 'project', '--json'], { cwd, env: cleanEnv(home), timeoutMs: COLLAB_TIMEOUT_MS });
  } catch (error) {
    if (error instanceof CapTimeout) throw new Blocked(`collab project --json не ответил за ${COLLAB_TIMEOUT_MS / 1000} с — блокирую`);
    throw new Blocked(`не удалось запустить ${script}: ${error?.message ?? error} — блокирую`);
  }
  if (out.status !== 0) {
    const detail = out.stderr.toString('utf8').trim().slice(0, 300);
    throw new Blocked(`collab project --json завершился с кодом ${out.status} — блокирую (${detail})`);
  }
  let info;
  try {
    info = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(out.stdout));
  } catch {
    throw new Blocked('collab project --json вернул не JSON в UTF-8 — блокирую');
  }
  if (info === null || typeof info !== 'object' || Array.isArray(info)) {
    throw new Blocked('collab project --json вернул неожиданный формат (не объект) — блокирую');
  }
  if (info.error) throw new Blocked(`collab project --json сообщил об ошибке: ${info.error} — блокирую`);
  return info;
}

// ── решение ───────────────────────────────────────────────────────────────────

async function decide({ stdinBuffer, env }) {
  const home = safeAbs(env.HOME || env.USERPROFILE, 'HOME');
  const event = loadEvent(stdinBuffer);

  // 0. Событие.
  const tool = event.tool_name;
  if (typeof tool !== 'string' || !Object.hasOwn(TOOL_PATH_FIELD, tool)) {
    throw new Blocked(`неожиданный tool_name ${JSON.stringify(tool)} — хук подключён только к Edit|Write|NotebookEdit, блокирую`);
  }
  const toolInput = event.tool_input;
  if (toolInput === null || typeof toolInput !== 'object' || Array.isArray(toolInput)) throw new Blocked('в событии нет объекта tool_input — блокирую');
  const present = PATH_FIELDS.filter((f) => Object.hasOwn(toolInput, f));
  if (present.length > 1) throw new Blocked('в событии одновременно file_path и notebook_path — неоднозначно, блокирую');
  const field = TOOL_PATH_FIELD[tool];
  if (present.length !== 1 || present[0] !== field) {
    throw new Blocked(`для ${tool} ожидалось поле ${field}, получено ${present.length ? present : 'ничего'} — блокирую`);
  }
  const target = safeStr(toolInput[field], field);
  const cwd = safeAbs(event.cwd, 'cwd события');

  const joined = path.isAbsolute(target) ? target : path.join(cwd, target);
  const lexical = path.resolve(joined);
  const real = realpathLoose(joined);
  const candidates = [foldedParts(lexical), foldedParts(real)];

  // 1. Защищённые каталоги — по обоим путям и по обоим написаниям корня.
  const bases = new Set([home]);
  try {
    bases.add(userInfo().homedir);
  } catch {
    // нет записи о пользователе — остаётся $HOME
  }
  for (const base of [...bases].sort()) {
    for (const name of PROTECTED_HOME_DIRS) {
      const rootLex = path.resolve(base, name);
      for (const root of new Set([rootLex, realpathLoose(rootLex)])) {
        const rootParts = foldedParts(root);
        if (candidates.some((c) => isUnder(c, rootParts))) {
          throw new Blocked(`${real} внутри защищённого каталога (${root}) — эти файлы не редактируются агентами ни при каком scopes.json`);
        }
      }
    }
  }

  // 1б. Жёсткая ссылка — второе имя того же inode: правка по «разрешённому» имени меняет и файл вне
  //     области, а имена и realpath этого не видят. Доказать, что второе имя тоже в области, дёшево
  //     нельзя — блокируем всегда.
  let st = null;
  try {
    st = lstatSync(real);
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw new Blocked(`не удалось проверить ${real}: ${error.message} — блокирую`);
    let joinedExists = true;
    try {
      lstatSync(joined);
    } catch (inner) {
      if (inner.code !== 'ENOENT' && inner.code !== 'ENOTDIR') throw new Blocked(`не удалось проверить ${joined}: ${inner.message} — блокирую`);
      joinedExists = false; // новый файл
    }
    if (joinedExists) throw new Blocked(`${joined} — висячая символическая ссылка, неясно, что будет создано — блокирую`);
  }
  if (st !== null) {
    if (!st.isFile()) throw new Blocked(`${real} — не обычный файл (каталог, FIFO, устройство, сокет или ссылка) — блокирую`);
    if (st.nlink > 1) {
      throw new Blocked(`${real}: у файла ${st.nlink} имени (жёсткие ссылки) — правка изменила бы и другие имена того же файла, возможно вне области; блокирую`);
    }
  }

  // 2. Исключение для временного каталога — только вне git-репозиториев и без служебных имён.
  const tmps = tmpRoots().flatMap((t) => [t, realpathLoose(t)]).map((t) => foldedParts(t));
  const bothInTmp = candidates.every((c) => tmps.some((t) => isUnder(c, t)));
  const hasServiceName = candidates.some((c) => c.some((part) => HARD_DENY_NAMES.has(part)));
  if (bothInTmp && !hasServiceName && !(await maybeInsideGitRepo(real, home, env))) return 0;

  // 3. collab project --json — единственный путь, без переопределений.
  const info = await collabInfo(cwd, home);
  if (info.codeRoot === undefined || info.codeRoot === null) throw new Blocked('collab project --json не сообщил codeRoot — блокирую');
  const codeRoot = safeAbs(info.codeRoot, 'codeRoot');
  const rootReal = realpathLoose(codeRoot);
  const rootRealParts = foldedParts(rootReal);

  // 4. Цель внутри корня кода (по realpath).
  const realParts = candidates[1];
  if (!isUnder(realParts, rootRealParts)) throw new Blocked(`${real} вне корня кода проекта (${rootReal}) — блокирую`);
  const relForms = [realParts.slice(rootRealParts.length)];
  const display = rawParts(real).slice(rootRealParts.length).join('/');
  for (const root of new Set([path.resolve(codeRoot), rootReal])) {
    const rootParts = foldedParts(root);
    if (isUnder(candidates[0], rootParts)) {
      relForms.push(candidates[0].slice(rootParts.length));
      break;
    }
  }
  if (relForms.some((rel) => rel.length === 0)) throw new Blocked(`${real} совпадает с корнем кода — блокирую`);

  // 5. Служебные имена где угодно внутри корня.
  if (relForms.some((rel) => rel.some((part) => HARD_DENY_NAMES.has(part)))) {
    throw new Blocked(`${display} — служебный путь (.git/.claude/.collab/.mcp.json), агенты его не трогают ни при каком allow`);
  }

  // 6. Проект в реестре.
  const projectId = info.projectId;
  if (!projectId) {
    throw new Blocked('проект не описан в реестре — владелец должен зарегистрировать его в ~/agent-kit/projects/<id>/project.json');
  }
  if (typeof projectId !== 'string' || !PROJECT_ID_RE.test(projectId)) {
    throw new Blocked(`collab project --json вернул некорректный projectId ${JSON.stringify(projectId)} — блокирую`);
  }
  if (info.registryDir === undefined || info.registryDir === null) throw new Blocked('collab project --json не сообщил registryDir — блокирую');
  const registryDir = safeAbs(info.registryDir, 'registryDir');

  // 7. scopes.json.
  const scopesPath = path.join(registryDir, projectId, 'scopes.json');
  let scopes;
  try {
    scopes = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(scopesPath)));
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Blocked(`нет ${scopesPath} — владелец должен описать области в ~/agent-kit/projects/${projectId}/scopes.json`);
    }
    throw new Blocked(`не удалось прочитать ${scopesPath}: ${error.message} — блокирую`);
  }
  if (scopes === null || typeof scopes !== 'object' || Array.isArray(scopes)) {
    throw new Blocked(`${scopesPath} имеет неожиданный формат (не объект) — блокирую`);
  }

  const agent = env.KIT_AGENT;
  if (!agent) throw new Blocked('не задан KIT_AGENT в команде хука — не знаю, чьи области проверять, блокирую');
  const agentScopes = Object.hasOwn(scopes, agent) ? scopes[agent] : undefined;
  if (agentScopes === null || typeof agentScopes !== 'object' || Array.isArray(agentScopes)) {
    throw new Blocked(`для агента «${agent}» нет описанных областей в ${scopesPath} — владелец должен их добавить`);
  }
  const allow = parsePatterns(agentScopes.allow, 'allow', scopesPath);
  const deny = parsePatterns(agentScopes.deny, 'deny', scopesPath);

  // 8. deny — по границе компонента, по любой форме пути.
  if (relForms.some((rel) => deny.some((p) => isUnder(rel, p)))) {
    throw new Blocked(`${display} запрещён явно для «${agent}» (deny в ${scopesPath})`);
  }

  // 9. allow — каждая форма пути обязана попасть под allow.
  if (!relForms.every((rel) => allow.some((p) => isUnder(rel, p)))) {
    const shown = JSON.stringify(agentScopes.allow ?? []);
    throw new Blocked(`${display} вне разрешённых областей «${agent}» (allow: ${shown})`);
  }
  return 0;
}

export async function main(context) {
  const { stderr } = context;
  const emit = (message) => {
    try {
      stderr(`scope-guard: ${message}\n`);
    } catch {
      // сообщение не критично, код выхода — да
    }
  };
  let timer;
  const watchdog = new Promise((resolve) => {
    timer = setTimeout(() => {
      emit(`проверка не уложилась в ${WATCHDOG_MS / 1000} с — правка заблокирована на всякий случай`);
      resolve(2);
    }, WATCHDOG_MS);
  });
  try {
    const verdict = decide(context).then(
      (result) => (result === 0 ? 0 : 2),
      (error) => {
        if (error instanceof Blocked) emit(error.message);
        else emit(`внутренняя ошибка хука (${error?.name ?? typeof error}) — правка заблокирована на всякий случай`);
        return 2;
      },
    );
    return await Promise.race([verdict, watchdog]);
  } catch {
    emit('внутренняя ошибка хука — правка заблокирована на всякий случай');
    return 2;
  } finally {
    clearTimeout(timer);
    killActiveChildren();
  }
}
