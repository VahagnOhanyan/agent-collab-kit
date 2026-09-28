// Общие кирпичи хуков: пути, дом, чистое окружение, разбор командной строки.
// Один код для macOS и Windows; платформа берётся из process.platform или параметра (для тестов).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const IS_WINDOWS = process.platform === 'win32';

export function homeDir(env = process.env) {
  return env.HOME || env.USERPROFILE || homedir();
}

export function expandUser(p, home) {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
  return p;
}

// realpath, который не падает на несуществующем хвосте: разрешает самый глубокий существующий предок.
export function realpathLoose(p) {
  let current = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      // На Windows native-realpath иногда отдаёт `\\?\C:\…`: снимаем префикс, чтобы пути сравнивались.
      const real = realpathSync.native(current).replace(/^\\\\\?\\(?=[A-Za-z]:)/, '');
      return path.join(real, ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(p);
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

// `p` лежит в `root` или равен ему. path.win32.relative сравнивает без учёта регистра.
export function isInside(root, p) {
  const rel = path.relative(root, p);
  if (rel === '') return true;
  return !(rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel));
}

export function relativeSlashed(root, p) {
  return path.relative(root, p).split(path.sep).join('/');
}

// Окружение для дочерних процессов хука: без чужого PATH, но с тем же Node, что запустил хук.
export function cleanEnv(home, platform = process.platform) {
  const nodeDir = path.dirname(process.execPath);
  if (platform === 'win32') {
    const root = process.env.SystemRoot || 'C:\\Windows';
    return {
      PATH: [nodeDir, path.join(root, 'System32'), root].join(';'),
      HOME: home,
      USERPROFILE: home,
      SystemRoot: root,
    };
  }
  return { PATH: [nodeDir, '/usr/bin', '/bin', '/opt/homebrew/bin'].join(':'), HOME: home };
}

// ── дочерние процессы с потолком времени ─────────────────────────────────────

export class CapTimeout extends Error {}

const ACTIVE_CHILDREN = new Set();

function killTree(child) {
  try {
    if (IS_WINDOWS) {
      if (child.exitCode === null) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 3000 });
    } else {
      process.kill(-child.pid, 'SIGKILL'); // вся группа, включая внуков, что держат stdout
    }
  } catch {
    // уже завершился
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // уже завершился
  }
}

export function killActiveChildren() {
  for (const child of ACTIVE_CHILDREN) killTree(child);
  ACTIVE_CHILDREN.clear();
}

// Запуск без оболочки; по таймауту убивается всё дерево процессов. Ждёт закрытия stdout/stderr,
// как communicate() в Python: внук, держащий канал, — это таймаут, а не тихий пропуск.
export function runCapped(argv, { cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: !IS_WINDOWS, windowsHide: true });
    } catch (error) {
      reject(error);
      return;
    }
    ACTIVE_CHILDREN.add(child);
    const out = [];
    const err = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    let settled = false;
    const finish = (action) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree(child);
      ACTIVE_CHILDREN.delete(child);
      action();
    };
    const timer = setTimeout(() => finish(() => reject(new CapTimeout(`не ответил за ${timeoutMs} мс`))), timeoutMs);
    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (status) => finish(() => resolve({ status, stdout: Buffer.concat(out), stderr: Buffer.concat(err) })));
  });
}

// `collab project --json` в каталоге cwd; null, если набор не установлен или collab не ответил.
export function collabProject(cwd, home, timeoutMs = 5000) {
  if (!path.isAbsolute(home)) return null;
  const script = path.join(home, '.agent-kit', 'current', 'bin', 'collab');
  if (!existsSync(script)) return null;
  try {
    const out = spawnSync(process.execPath, [script, 'project', '--json'], {
      cwd,
      env: cleanEnv(home),
      encoding: 'utf8',
      timeout: timeoutMs,
    });
    if (out.error || out.status === null) return null;
    const info = JSON.parse(out.stdout);
    return info && typeof info === 'object' && !Array.isArray(info) && !info.error ? info : null;
  } catch {
    return null;
  }
}

// ── командная строка ──────────────────────────────────────────────────────────

export const SEGMENT_SPLIT = /\|\||&&|&|;|\||\r?\n/;

// Слова одного сегмента. POSIX: кавычки и обратный слеш-экранирование. Windows: обратный слеш — часть
// пути, кавычки '…' и "…" снимаются. Незакрытая кавычка → null (команда не понята, вызывающий решает).
export function shellWords(segment, windows = IS_WINDOWS) {
  const words = [];
  let word = null;
  let quote = null;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (!windows && quote === '"' && ch === '\\' && '"\\$`'.includes(segment[i + 1] ?? '')) word += segment[++i];
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      word ??= '';
    } else if (!windows && ch === '\\' && i + 1 < segment.length) {
      word = (word ?? '') + segment[++i];
    } else if (/\s/.test(ch)) {
      if (word !== null) words.push(word);
      word = null;
    } else {
      word = (word ?? '') + ch;
    }
  }
  if (quote) return null;
  if (word !== null) words.push(word);
  return words;
}

// Имя программы из первого слова: без каталога, на Windows — без .exe/.cmd/.bat/.ps1 и в нижнем регистре.
export function toolName(word, windows = IS_WINDOWS) {
  if (windows) return path.win32.basename(word).replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
  return path.posix.basename(word);
}
