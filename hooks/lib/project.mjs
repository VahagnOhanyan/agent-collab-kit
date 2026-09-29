// Настройки проекта из доверенного реестра: `collab project --json` → `<registryDir>/<projectId>/project.json`.
// Не из репозитория: правка проекта не может ослабить хук. Нет collab, проекта, файла или ключа — null.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { IS_WINDOWS, collabProject } from './paths.mjs';

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

// Строгое чтение для хуков, у которых настроенный проект не должен молча терять защиту.
//   { state: 'none' }                — защищаться нечем: набор collab не отвечает, проект не
//                                       зарегистрирован, нет project.json или в нём нет ключа;
//   { state: 'ok', value, codeRoot } — ключ есть;
//   { state: 'broken', reason }      — проект зарегистрирован, но реестр не читается (битый JSON, права,
//                                       ответ collab без путей): вызывающий блокирует.
export function projectSettingStrict(cwd, home, key, { timeoutMs = 5000 } = {}) {
  const info = collabProject(cwd, home, timeoutMs);
  if (!info || info.projectId === null || info.projectId === undefined) return { state: 'none' };
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
