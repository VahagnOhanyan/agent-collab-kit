// UserPromptSubmit- и PostToolUse-хук ведущей сессии Claude Code: сторож контекста.
// Считает, насколько сессия приблизилась к автоматическому сжатию контекста, и на пороге (по умолчанию 70 % и 85 %)
// один раз подсказывает модели предложить владельцу передачу работы следующей сессии (скилл `handoff`) — пока задача
// в понятной точке, а не когда сжатие уже съело подробности.
//
// Заполнение — `usage` последнего ответа модели главной ветки в логе сессии (`transcript_path`):
// input_tokens + cache_read_input_tokens + cache_creation_input_tokens.
//
// 100 % — не формальное окно модели, а точка, где Claude Code сам сжимает разговор. Она зависит от модели, тарифа
// и машины, во входе хука её нет, поэтому хук ей учится: каждая запись `compact_boundary` (trigger "auto") в логе —
// образец `preTokens` для пары «аккаунт (каталог конфига) + модель». Точка — медиана последних образцов: выброс
// (раннее сжатие) её не сдвигает, смена тарифа подтягивается за несколько сжатий. Выученное — в
// `~/.agent-collab-kit/state/context-watch/limits.json`; ручная запись `limits` в `~/.agent-collab-kit/context-watch.json`
// (префикс id модели → токены) главнее выученной. Ничего не выучено — точка окна в 200 000 (≈ 167 000); сессия,
// перешедшая её, — точка миллионного окна (≈ 967 000). Обе цифры — медианы автосжатий, измеренные 09.10.2026.
//
// Не граница: любой сбой — пропуск (`return 0`). Хендофф хук не пишет — только просит модель предложить его владельцу.
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { homeDir } from './lib/paths.mjs';

export const DEFAULT_LIMIT = 167_000;
export const LARGE_LIMIT = 967_000;
export const DEFAULT_THRESHOLDS = Object.freeze([70, 85]);
const SAMPLES_KEPT = 7;
const SEEN_KEPT = 50;
const TAIL_BYTES = 2 * 1024 * 1024; // последний ответ и свежие сжатия всегда в хвосте; весь лог бывает в десятки МБ
const STATE_TTL_MS = 14 * 24 * 3600 * 1000;

export async function main({ stdinText, env, stdout }) {
  try {
    let event;
    try {
      event = JSON.parse(stdinText);
    } catch {
      return 0;
    }
    const eventName = event?.hook_event_name;
    if (eventName !== 'UserPromptSubmit' && eventName !== 'PostToolUse') return 0;
    const transcript = typeof event?.transcript_path === 'string' ? event.transcript_path : '';
    const session = typeof event?.session_id === 'string' ? event.session_id.replace(/[^A-Za-z0-9_-]/g, '') : '';
    if (!transcript || !session) return 0;

    const home = homeDir(env);
    const stateDir = path.join(home, '.agent-collab-kit', 'state', 'context-watch');
    const settings = readSettings(home);
    const tail = readTail(transcript);
    if (tail == null) return 0;
    const { last, compactions } = scan(tail);

    const account = accountOf(transcript);
    const limitsFile = path.join(stateDir, 'limits.json');
    const learned = readJson(limitsFile, {});
    if (learn(learned, account, compactions)) writeJson(stateDir, limitsFile, learned);
    if (!last) return 0;

    const limit = limitFor({ account, model: last.model, used: last.used, manual: settings.limits, learned });
    const percent = Math.floor((last.used / limit) * 100);

    const stateFile = path.join(stateDir, `${session}.json`);
    let fired = readJson(stateFile, {}).fired;
    fired = Array.isArray(fired) ? fired.filter(Number.isInteger) : [];
    // После сжатия контекст снова мал: пороги этой сессии взводятся заново.
    const rearmed = fired.length > 0 && percent < Math.min(...fired) - 10;
    if (rearmed) fired = [];
    const crossed = settings.thresholds.filter((t) => percent >= t && !fired.includes(t));
    if (!crossed.length) {
      if (rearmed) writeJson(stateDir, stateFile, { fired });
      return 0;
    }

    const strong = Math.max(...crossed) >= settings.thresholds[settings.thresholds.length - 1];
    writeJson(stateDir, stateFile, { fired: [...new Set([...fired, ...crossed])].sort((a, b) => a - b) });
    sweepOld(stateDir);

    stdout(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: eventName,
        additionalContext: message({ percent, used: last.used, limit, strong }),
      },
    }) + '\n');
    return 0;
  } catch {
    return 0;
  }
}

export function message({ percent, used, limit, strong }) {
  const amount = `${percent} % (${Math.round(used / 1000)} тыс. из ≈ ${Math.round(limit / 1000)} тыс. токенов до автосжатия)`;
  if (strong) {
    return `[context-watch] Контекст сессии заполнен на ${amount}. Скоро начнётся сжатие, и подробности задачи потеряются. ` +
      'Не начинай новый крупный шаг: доведи текущий до понятной точки и предложи владельцу прямо сейчас передать работу ' +
      'следующей сессии — скилл `handoff` (документ передачи, решения, память). Писать хендофф — после его согласия.';
  }
  return `[context-watch] Контекст сессии заполнен на ${amount}. В ближайшем ответе коротко скажи владельцу об этом и ` +
    'предложи передать работу следующей сессии через скилл `handoff`, когда текущий шаг дойдёт до понятной точки. ' +
    'Писать хендофф — только после его согласия.';
}

/** Аккаунт — каталог конфига Claude Code, в котором лежит лог: `<конфиг>/projects/<проект>/<сессия>.jsonl`. */
export function accountOf(transcript) {
  return path.basename(path.dirname(path.dirname(path.dirname(transcript)))) || 'default';
}

/**
 * Точка автосжатия: ручная запись по самому длинному префиксу id модели → выученная медиана для пары
 * «аккаунт + модель» → 167 000. Сессия, уже перешедшая точку, работает в большем окне — значит, точка выше.
 */
export function limitFor({ account, model, used, manual = {}, learned = {} }) {
  const id = typeof model === 'string' ? model : '';
  let best = null;
  for (const [prefix, size] of Object.entries(manual)) {
    if (id.startsWith(prefix) && Number.isFinite(size) && size > 0 && (!best || prefix.length > best.prefix.length)) {
      best = { prefix, size };
    }
  }
  const samples = learned?.[account]?.[id]?.samples;
  const base = best ? best.size : (Array.isArray(samples) && samples.length ? median(samples.map((s) => s.pre)) : DEFAULT_LIMIT);
  return used > base ? Math.max(LARGE_LIMIT, used) : base;
}

/** Добавляет к выученному новые автосжатия; true — если что-то изменилось. */
export function learn(learned, account, compactions) {
  let changed = false;
  for (const { id, pre, model } of compactions) {
    if (!model) continue;
    const entry = ((learned[account] ??= {})[model] ??= { samples: [], seen: [] });
    if (entry.seen.includes(id)) continue;
    entry.seen = [...entry.seen, id].slice(-SEEN_KEPT);
    entry.samples = [...entry.samples, { pre, at: new Date().toISOString() }].slice(-SAMPLES_KEPT);
    changed = true;
  }
  return changed;
}

export function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return DEFAULT_LIMIT;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/**
 * Из хвоста лога: последний ответ модели главной ветки `{ used, model }` и автосжатия `{ id, pre, model }`,
 * у каждого — модель последнего ответа перед ним (нет такого в хвосте — модель последнего ответа вообще).
 */
export function scan(text) {
  let last = null;
  let model = null;
  const compactions = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const isAnswer = line.includes('"usage"');
    const isCompaction = line.includes('"compact_boundary"');
    if (!isAnswer && !isCompaction) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // первая строка хвоста обрезана
    }
    if (isCompaction) {
      const meta = entry?.compactMetadata;
      if (entry?.subtype === 'compact_boundary' && meta?.trigger === 'auto' && Number.isFinite(meta.preTokens) && entry.uuid) {
        compactions.push({ id: String(entry.uuid), pre: meta.preTokens, model });
      }
      continue;
    }
    if (entry?.type !== 'assistant' || entry.isSidechain === true) continue;
    const usage = entry.message?.usage;
    if (!usage) continue;
    const used = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
      .reduce((sum, key) => sum + (Number.isFinite(usage[key]) ? usage[key] : 0), 0);
    if (used <= 0) continue;
    model = typeof entry.message?.model === 'string' ? entry.message.model : model;
    last = { used, model };
  }
  for (const c of compactions) c.model ??= last?.model ?? null;
  return { last, compactions };
}

export function readTail(file) {
  try {
    const size = statSync(file).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const fd = openSync(file, 'r');
    try {
      readSync(fd, buffer, 0, length, size - length);
    } finally {
      closeSync(fd);
    }
    return buffer.toString('utf8');
  } catch {
    return null;
  }
}

/** Машинные настройки; битый файл — значения по умолчанию. */
export function readSettings(home) {
  const raw = readJson(path.join(home, '.agent-collab-kit', 'context-watch.json'), {});
  const thresholds = Array.isArray(raw.thresholds)
    ? [...new Set(raw.thresholds.filter((t) => Number.isInteger(t) && t > 0 && t < 100))].sort((a, b) => a - b)
    : [];
  const limits = raw.limits && typeof raw.limits === 'object' && !Array.isArray(raw.limits) ? raw.limits : {};
  return { thresholds: thresholds.length ? thresholds : [...DEFAULT_THRESHOLDS], limits };
}

function readJson(file, fallback) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? value : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(dir, file, value) {
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, file);
}

/** Состояние закончившихся сессий не копится вечно; выученное — не трогается. */
function sweepOld(dir) {
  const now = Date.now();
  for (const name of readdirSync(dir)) {
    if (name === 'limits.json') continue;
    const file = path.join(dir, name);
    try {
      if (now - statSync(file).mtimeMs > STATE_TTL_MS) unlinkSync(file);
    } catch {
      // чужая гонка за тот же файл — не наша забота
    }
  }
}
