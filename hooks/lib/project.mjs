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

// Корень рабочего дерева, в котором лежит cwd (на нём считаются пути гейтов проекта); вне git — сам cwd.
export function gitRoot(cwd, env) {
  const out = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', env, timeout: 5000 });
  const top = out.status === 0 ? out.stdout.trim() : '';
  return top || cwd;
}

// Как запустить гейт проекта одинаково на macOS и Windows: .mjs/.js — тем же Node, .sh на Windows — через bash.
export function gateArgv(file, args = []) {
  if (/\.m?js$/.test(file)) return [process.execPath, file, ...args];
  if (IS_WINDOWS && file.endsWith('.sh')) return ['bash', file, ...args];
  return [file, ...args];
}
