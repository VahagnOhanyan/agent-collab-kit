// PreToolUse-хук ведущей сессии Claude Code (Bash): `git push` — только через зелёный гейт проекта и без
// обходов. Гейт — `gate` в доверенном реестре проекта (путь от корня рабочего дерева, например
// scripts/preflight.sh); нет настройки или файла — push проходит. Установщик вписывает хук в
// settings.json каждого конфига Claude.
//
//   1. `--no-verify`, `--force`, `-f`, `--force-with-lease`, refspec `+ветка` → блок (код 2).
//   2. Иначе запускается `<гейт> --quiet`; красный или не уложившийся во время → блок с хвостом вывода.
//
// Ведущая сессия, не граница: непонятный вход, нет collab, нет настройки, сбой самого хука — проход.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { CapTimeout, cleanEnv, homeDir, runCapped } from './lib/paths.mjs';
import { gateArgv, gitRoot, projectSetting } from './lib/project.mjs';

// Ищется ВЕЗДЕ в строке, без привязки к началу: `sh -c "git push …"`, `echo x\ngit push`, `&&`-цепочки —
// одна и та же попытка. Ложное срабатывание на `echo "git push"` стоит лишний прогон гейта, обратная
// ошибка — обход правила.
export const PUSH_RE = /\bgit\b(?:\s+(?:-C\s+\S+|-c\s+\S+|--?[\w-]+(?:=\S+)?))*\s+push\b/;
// `+main` в refspec — force-push без слова force.
export const BYPASS_RE = /(?:^|\s)(--no-verify|--force|-f|--force-with-lease(?:=\S+)?|\+\S+)(?=\s|$)/;

const GATE_SECONDS_DEFAULT = 170; // таймаут хоста в settings.json — 180; PUSH_GATE_SECONDS — только для тестов

export async function main({ stdinText, env, cwd: hostCwd, stderr }) {
  try {
    let event;
    try {
      event = JSON.parse(stdinText);
    } catch {
      return 0;
    }
    const command = event?.tool_input?.command;
    if (typeof command !== 'string' || !PUSH_RE.test(command)) return 0;

    const bypass = BYPASS_RE.exec(command);
    if (bypass) {
      stderr(
        `push-gate: \`${bypass[1]}\` в git push запрещён (никогда --force, никогда --no-verify). ` +
          'Почини то, на что ругается гейт, или отдай push владельцу.\n'
      );
      return 2;
    }

    const home = homeDir(env);
    const gateSeconds = Number(env.PUSH_GATE_SECONDS) > 0 ? Number(env.PUSH_GATE_SECONDS) : GATE_SECONDS_DEFAULT;
    const cwd = typeof event.cwd === 'string' && event.cwd ? event.cwd : hostCwd;
    const setting = projectSetting(cwd, home, 'gate');
    if (!setting || typeof setting.value !== 'string' || !setting.value) return 0;
    const root = gitRoot(cwd, cleanEnv(home));
    const gate = path.resolve(root, setting.value);
    if (!existsSync(gate)) return 0;

    let run;
    try {
      run = await runCapped(gateArgv(gate, ['--quiet']), { cwd: root, env: cleanEnv(home), timeoutMs: gateSeconds * 1000 });
    } catch (error) {
      if (error instanceof CapTimeout) {
        stderr(`push-gate: гейт ${setting.value} не уложился в ${gateSeconds} с — push заблокирован.\n`);
        return 2;
      }
      return 0;
    }
    if (run.status === 0) return 0;
    const tail = `${run.stdout}${run.stderr}`.trim().split(/\r?\n/).slice(-40).join('\n');
    stderr(`push-gate: гейт ${setting.value} красный — push заблокирован. Вывод:\n${tail}\n`);
    return 2;
  } catch {
    return 0;
  }
}
