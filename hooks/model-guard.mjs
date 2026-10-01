// PreToolUse-хук (Agent) ведущего сеанса: `model` в вызове Agent — обязателен.
//
// Правило rules/orchestration.md: «`model` указывается всегда явно (пропуск = модель ведущего
// сеанса, то есть самая дорогая)». Здесь оно — проверка перед самим вызовом.
//
// Исключение — `subagent_type: "fork"`: форк всегда наследует модель ведущей сессии, это осознанный
// дефолт самого инструмента.
//
// У хука нет проектных данных: он одинаков для всех проектов и подключается в `.claude/settings.json`
// ведущей сессии (PreToolUse, matcher `Agent`), командой:
//   node "<путь к ~/.agent-collab-kit/current>/bin/agent-collab-kit-hook" model-guard
//
// Сбой разбора stdin или отсутствие tool_input — fail-open: баг хука не должен ронять все делегирования.

export const MESSAGE =
  'вызов Agent без явной `model` (кроме subagent_type: "fork", который всегда наследует модель ведущей ' +
  'сессии). Правило rules/orchestration.md: пропуск model = наследование самой дорогой модели по умолчанию, ' +
  'а не умное распределение. Добавь model: "sonnet"/"opus"/"haiku" в вызов.';

export async function main({ stdinText, stderr }) {
  let event;
  try {
    event = JSON.parse(stdinText);
  } catch {
    return 0;
  }
  const toolInput = event?.tool_input;
  if (toolInput === null || typeof toolInput !== 'object' || Array.isArray(toolInput)) return 0;
  if (toolInput.subagent_type === 'fork') return 0;
  if (typeof toolInput.model === 'string' && toolInput.model.trim()) return 0;
  stderr(`model-guard: ${MESSAGE}\n`);
  return 2;
}
