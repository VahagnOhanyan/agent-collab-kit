// PreToolUse-хук ведущей сессии Claude Code (Edit|Write|MultiEdit|NotebookEdit): правка кода проекта —
// только когда в текущем плане есть строки «Маршрут:» и `ux_impact:`. Что считается кодом проекта и где
// лежат планы — `plan_gate` в доверенном реестре проекта; логика — hooks/lib/plan-gate.mjs, общая с
// codex-guard. Установщик вписывает хук в settings.json каждого конфига Claude.
//
// Ведущая сессия, не граница: непонятный вход, нет collab, нет настройки — правка проходит.
import { homeDir } from './lib/paths.mjs';
import { planProblem } from './lib/plan-gate.mjs';

export async function main({ stdinText, env, cwd: hostCwd, stderr }) {
  try {
    let event;
    try {
      event = JSON.parse(stdinText);
    } catch {
      return 0;
    }
    const input = event?.tool_input;
    if (!input || typeof input !== 'object') return 0;
    const target = input.file_path ?? input.notebook_path;
    if (typeof target !== 'string' || !target) return 0;
    const cwd = typeof event.cwd === 'string' ? event.cwd : hostCwd;
    const problem = planProblem([target], cwd, event.transcript_path, homeDir(env));
    if (!problem) return 0;
    stderr(`plan-gate: ${problem}\n`);
    return 2;
  } catch {
    return 0;
  }
}
