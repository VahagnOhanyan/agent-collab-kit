// SessionStart-хук ведущей сессии Claude Code: привести git-настройки этого клона к настройкам проекта.
// Две настройки из доверенного реестра проекта (`project.json`), обе относительно корня дерева:
//   `githooks_dir` — каталог отслеживаемых git-хуков → `core.hooksPath` (другой путь в клоне заменяется);
//   `git_config`   — список пар `[ключ, значение]` (например, merge-driver каталога строк) → `git config <ключ> <значение>`.
// Идемпотентно: stdout хука попадает в контекст сессии, поэтому что-то печатается, только когда конфиг изменён.
// Нет настройки, git — молча проходит; объявленный, но не найденный каталог, битый реестр и сбой записи конфига
// печатаются в контекст сессии (stdout), а не теряются.
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { cleanEnv, homeDir } from './lib/paths.mjs';
import { gitRoot, projectSettingStrict } from './lib/project.mjs';

const BUDGET_MS = 8000; // общий бюджет; таймаут хоста в settings.json — 15 с, лаунчер ждёт stdin до 4 с, убитый хостом хук считается пропуском
const GIT_KEY = /^[A-Za-z][A-Za-z0-9-]*(\.[^\s=]+)+$/; // section.key или section.subsection.key — без пробелов и «=»

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
    const hooksSetting = projectSettingStrict(cwd, home, 'githooks_dir');
    const configSetting = projectSettingStrict(cwd, home, 'git_config');
    if (hooksSetting.state === 'broken' || configSetting.state === 'broken') {
      const reason = hooksSetting.state === 'broken' ? hooksSetting.reason : configSetting.reason;
      stdout(`agent-collab-kit: настройки проекта не читаются (${reason}) — git-настройки проекта не применены.\n`);
      return 0;
    }
    if (hooksSetting.state !== 'ok' && configSetting.state !== 'ok') return 0;

    const gitEnv = cleanEnv(home);
    const root = gitRoot(cwd, gitEnv);
    const git = (...args) => {
      const left = deadline - Date.now();
      if (left < 200) return { status: null, stdout: '' };
      return spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env: gitEnv, timeout: Math.min(5000, left) });
    };
    if (git('rev-parse', '--git-dir').status !== 0) return 0;

    if (hooksSetting.state === 'ok') {
      const dir = typeof hooksSetting.value === 'string' ? hooksSetting.value.replace(/\\/g, '/').replace(/\/+$/, '') : '';
      if (!dir || path.isAbsolute(dir) || dir.split('/').includes('..')) {
        stdout('agent-collab-kit: `githooks_dir` в реестре проекта задан неверно (нужен относительный путь без `..`) — git-хуки проекта не включены.\n');
      } else {
        const full = path.join(root, dir);
        if (!existsSync(full) || !statSync(full).isDirectory()) {
          stdout(`agent-collab-kit: каталог git-хуков ${dir} объявлен в реестре, но не найден в ${root} — git-хуки проекта не включены.\n`);
        } else {
          const current = git('config', '--get', 'core.hooksPath');
          if (!(current.status === 0 && current.stdout.trim() === dir)) {
            if (git('config', 'core.hooksPath', dir).status === 0) stdout(`git core.hooksPath → ${dir}\n`);
            else stdout(`agent-collab-kit: не удалось записать core.hooksPath → ${dir}; git-хуки проекта не включены.\n`);
          }
        }
      }
    }

    if (configSetting.state === 'ok') {
      const pairs = configSetting.value;
      const wellFormed =
        Array.isArray(pairs) &&
        pairs.every((p) => Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === 'string' && x !== '') && GIT_KEY.test(p[0]));
      if (!wellFormed) {
        stdout('agent-collab-kit: `git_config` в реестре проекта задан неверно (нужен список пар [ключ, значение]) — git-настройки проекта не применены.\n');
      } else {
        for (const [key, value] of pairs) {
          // Только пространства имён, которые не исполняют произвольные команды сами по себе, кроме merge-driver'ов проекта:
          // core.hooksPath уже под `githooks_dir`; alias.*, credential.* и url.* из реестра не ставим.
          if (/^(alias|credential|url|include|includeIf)\./i.test(key)) {
            stdout(`agent-collab-kit: git_config: ключ ${key} не из разрешённых пространств (merge.*, diff.*, filter.*, core.* без hooksPath) — пропущен.\n`);
            continue;
          }
          if (/^core\.hooksPath$/i.test(key)) {
            stdout('agent-collab-kit: git_config: core.hooksPath задаётся через `githooks_dir` — пропущен.\n');
            continue;
          }
          const current = git('config', '--get', key);
          if (current.status === 0 && current.stdout.replace(/\n$/, '') === value) continue;
          if (git('config', key, value).status === 0) stdout(`git ${key} → ${value}\n`);
          else stdout(`agent-collab-kit: не удалось записать git ${key}; настройка проекта не применена.\n`);
        }
      }
    }
    return 0;
  } catch (error) {
    stdout(`agent-collab-kit: session-start не отработал (${error?.message ?? error}) — git-настройки проекта могли не примениться.\n`);
    return 0;
  }
}
