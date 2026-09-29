// SessionStart-хук ведущей сессии Claude Code: включить отслеживаемые git-хуки проекта в этом клоне.
// Каталог — `githooks_dir` в доверенном реестре проекта (относительно корня дерева). Идемпотентно:
// stdout хука попадает в контекст сессии, поэтому что-то печатается, только когда конфиг изменён.
// Нет настройки, каталога, git — молча проходит; другой `core.hooksPath` в клоне заменяется на проектный.
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { cleanEnv, homeDir } from './lib/paths.mjs';
import { gitRoot, projectSetting } from './lib/project.mjs';

const BUDGET_MS = 12000; // общий бюджет; таймаут хоста в settings.json — 15 с, убитый хостом хук считается пропуском

export async function main({ stdinText, env, cwd: hostCwd, stdout }) {
  try {
    const deadline = Date.now() + BUDGET_MS;
    let event = null;
    try {
      event = JSON.parse(stdinText);
    } catch {
      // SessionStart без JSON — берём cwd процесса
    }
    const home = homeDir(env);
    const cwd = typeof event?.cwd === 'string' && event.cwd ? event.cwd : hostCwd;
    const setting = projectSetting(cwd, home, 'githooks_dir');
    if (!setting || typeof setting.value !== 'string' || !setting.value) return 0;
    const dir = setting.value.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!dir || path.isAbsolute(dir) || dir.split('/').includes('..')) return 0;

    const gitEnv = cleanEnv(home);
    const root = gitRoot(cwd, gitEnv);
    const full = path.join(root, dir);
    if (!existsSync(full) || !statSync(full).isDirectory()) return 0;

    const git = (...args) => {
      const left = deadline - Date.now();
      if (left < 200) return { status: null, stdout: '' };
      return spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env: gitEnv, timeout: Math.min(5000, left) });
    };
    if (git('rev-parse', '--git-dir').status !== 0) return 0;
    const current = git('config', '--get', 'core.hooksPath');
    if (current.status === 0 && current.stdout.trim() === dir) return 0;
    if (git('config', 'core.hooksPath', dir).status === 0) stdout(`git core.hooksPath → ${dir}\n`);
    return 0;
  } catch {
    return 0;
  }
}
