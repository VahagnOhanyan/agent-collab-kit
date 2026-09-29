// Настройки проекта из доверенного реестра: `collab project --json` → `<registryDir>/<projectId>/project.json`.
// Не из репозитория: правка проекта не может ослабить хук. Нет collab, проекта, файла или ключа — null.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { IS_WINDOWS, collabProject, collabProjectAnswer, isInside, realpathLoose } from './paths.mjs';
import { readProjectEntry } from '../../collab/src/projects.mjs';

export function projectSetting(cwd, home, key) {
  const info = collabProject(cwd, home);
  if (!info) return null;
  const { projectId, registryDir, codeRoot } = info;
  if (![projectId, registryDir, codeRoot].every((v) => typeof v === 'string')) return null;
  try {
    const value = JSON.parse(readFileSync(path.join(registryDir, projectId, 'project.json'), 'utf8'))[key];
    return value === undefined ? null : { value, codeRoot };
  } catch {
    return null;
  }
}

// Корни записи из сырого текста нечитаемого project.json: строки массива `"roots"` (схема — collab/src/projects.mjs).
function rawRoots(text) {
  const array = /"roots"\s*:\s*\[([^\]]*)/.exec(text)?.[1];
  if (array === undefined) return [];
  const roots = [];
  for (const m of array.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    try {
      roots.push(JSON.parse(`"${m[1]}"`));
    } catch {
      roots.push(m[1]);
    }
  }
  return roots.filter((r) => path.isAbsolute(r));
}

// Запись реестра, чьи `roots` содержат cwd. По умолчанию — только та, которую collab отверг (нечитаемый JSON или
// схема не по его же `readProjectEntry`): это «проект, потерявший защиту». `anyEntry` — любая, когда сам collab не
// ответил. Запись, которую вообще не прочитать (права), к каталогу не привязать: она пропускается, а не блокирует
// все остальные (граница — SECURITY-hooks.md).
function claimingEntry(cwd, home, registryDir, { anyEntry = false } = {}) {
  // Оба места, которые collab выбирает по умолчанию (defaultRegistryDir): постоянный реестр и реестр релиза.
  const roots = [
    typeof registryDir === 'string' && registryDir,
    path.join(home, '.agent-kit', 'projects'),
    path.join(home, '.agent-kit', 'current', 'projects'),
  ].filter(Boolean);
  const here = realpathLoose(cwd);
  for (const root of new Set(roots)) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(root, entry.name, 'project.json');
      let text;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      let problem;
      let roots;
      try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          problem = 'не объект';
          roots = [];
        } else {
          problem = readProjectEntry(path.join(root, entry.name), entry.name, { home }).problems.join('; ') || null;
          roots = Array.isArray(parsed.roots) ? parsed.roots.filter((r) => typeof r === 'string' && path.isAbsolute(r)) : [];
        }
      } catch {
        problem = 'не JSON';
        roots = rawRoots(text);
      }
      if (problem === null && !anyEntry) continue; // валидная запись: если бы она подходила, collab её бы нашёл
      if (roots.some((r) => isInside(realpathLoose(r), here))) return { file, problem };
    }
  }
  return null;
}

// Строгое чтение для хуков, у которых настроенный проект не должен молча терять защиту.
//   { state: 'none' }                — защищаться нечем: набор collab не отвечает, проект не
//                                       зарегистрирован, нет project.json или в нём нет ключа;
//   { state: 'ok', value, codeRoot } — ключ есть;
//   { state: 'broken', reason }      — проект зарегистрирован, но реестр не читается (битый JSON, права,
//                                       ответ collab без путей): вызывающий блокирует.
export function projectSettingStrict(cwd, home, key, { timeoutMs = 5000 } = {}) {
  const answer = collabProjectAnswer(cwd, home, timeoutMs);
  if (answer.state === 'absent') return { state: 'none' };
  if (answer.state === 'failed') {
    // collab не ответил или не смог выбрать проект: если реестр заявляет этот каталог — защита не должна пропасть молча.
    const hit = claimingEntry(cwd, home, answer.info?.registryDir, { anyEntry: true });
    return hit ? { state: 'broken', reason: `${answer.reason}; каталог заявлен в ${hit.file}` } : { state: 'none' };
  }
  const info = answer.info;
  if (info.projectId === null || info.projectId === undefined) {
    // collab пропускает запись с битым project.json и отвечает «не зарегистрирован»: ищем такую запись сами.
    const hit = claimingEntry(cwd, home, info.registryDir);
    return hit ? { state: 'broken', reason: `${hit.file} — ${hit.problem}` } : { state: 'none' };
  }
  const { projectId, registryDir, codeRoot } = info;
  if (![projectId, registryDir, codeRoot].every((v) => typeof v === 'string' && v)) {
    return { state: 'broken', reason: 'collab project вернул неполный ответ' };
  }
  let text;
  try {
    text = readFileSync(path.join(registryDir, projectId, 'project.json'), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'none' };
    return { state: 'broken', reason: `project.json не читается: ${error?.code ?? error?.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { state: 'broken', reason: 'project.json — не JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { state: 'broken', reason: 'project.json — не объект' };
  if (parsed[key] === undefined) return { state: 'none' };
  return { state: 'ok', value: parsed[key], codeRoot };
}

// Корень рабочего дерева, в котором лежит cwd (на нём считаются пути гейтов проекта); вне git — сам cwd.
export function gitRoot(cwd, env, timeoutMs = 5000) {
  const out = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', env, timeout: timeoutMs });
  const top = out.status === 0 ? out.stdout.trim() : '';
  return top || cwd;
}

// Как запустить гейт проекта одинаково на macOS и Windows: .mjs/.js — тем же Node, .sh на Windows — через bash.
export function gateArgv(file, args = []) {
  if (/\.m?js$/.test(file)) return [process.execPath, file, ...args];
  if (IS_WINDOWS && file.endsWith('.sh')) return ['bash', file, ...args];
  return [file, ...args];
}
