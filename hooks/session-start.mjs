// SessionStart-хук ведущей сессии Claude Code: включить отслеживаемые git-хуки проекта в этом клоне.
// Каталог — `githooks_dir` в доверенном реестре проекта (относительно корня дерева). Идемпотентно:
// stdout хука попадает в контекст сессии, поэтому что-то печатается, только когда конфиг изменён.
// Нет настройки, git — молча проходит; объявленный, но не найденный каталог, битый реестр и сбой записи конфига
// печатаются в контекст сессии (stdout), а не теряются. Другой `core.hooksPath` в клоне заменяется на проектный.
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { cleanEnv, homeDir } from './lib/paths.mjs';
import { gitRoot, projectSettingStrict } from './lib/project.mjs';

const BUDGET_MS = 8000; // общий бюджет; таймаут хоста в settings.json — 15 с, лаунчер ждёт stdin до 4 с, убитый хостом хук считается пропуском

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
    const setting = projectSettingStrict(cwd, home, 'githooks_dir');
    if (setting.state === 'broken') {
      stdout(`agent-kit: настройки проекта не читаются (${setting.reason}) — git-хуки проекта не включены.\n`);
      return 0;
    }
    if (setting.state !== 'ok') return 0;
    const dir = typeof setting.value === 'string' ? setting.value.replace(/\\/g, '/').replace(/\/+$/, '') : '';
    if (!dir || path.isAbsolute(dir) || dir.split('/').includes('..')) {
      stdout('agent-kit: `githooks_dir` в реестре проекта задан неверно (нужен относительный путь без `..`) — git-хуки проекта не включены.\n');
      return 0;
    }

    const gitEnv = cleanEnv(home);
    const root = gitRoot(cwd, gitEnv);
    const full = path.join(root, dir);
    if (!existsSync(full) || !statSync(full).isDirectory()) {
      stdout(`agent-kit: каталог git-хуков ${dir} объявлен в реестре, но не найден в ${root} — git-хуки проекта не включены.\n`);
      return 0;
    }

    const git = (...args) => {
      const left = deadline - Date.now();
      if (left < 200) return { status: null, stdout: '' };
      return spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env: gitEnv, timeout: Math.min(5000, left) });
    };
    if (git('rev-parse', '--git-dir').status !== 0) return 0;
    const current = git('config', '--get', 'core.hooksPath');
    if (current.status === 0 && current.stdout.trim() === dir) return 0;
    if (git('config', 'core.hooksPath', dir).status === 0) stdout(`git core.hooksPath → ${dir}\n`);
    else stdout(`agent-kit: не удалось записать core.hooksPath → ${dir}; git-хуки проекта не включены.\n`);
    return 0;
  } catch (error) {
    stdout(`agent-kit: session-start не отработал (${error?.message ?? error}) — git-хуки проекта могли не включиться.\n`);
    return 0;
  }
}
