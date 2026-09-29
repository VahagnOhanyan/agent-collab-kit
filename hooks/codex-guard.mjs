// PreToolUse-хук Codex CLI для ведущей сессии Codex: то, что у ведущего Claude Code держат
// model-guard и проектный plan-gate.
//
// Codex вызывает хук на Bash и на правки файлов (`apply_patch`); вход — JSON с `tool_name`,
// `tool_input.command`, `cwd`, `transcript_path` (формат проверен вживую на codex-cli 0.154:
// `apply_patch` приходит текстом патча со строками `*** Add|Update|Delete File: <путь>`,
// `*** Move to: <путь>`). Запрет — код 2, причина — в stderr.
//
// 1. Явная модель. `codex exec` без `-m/--model/--profile` и `claude -p/--print` без `--model`
//    запрещены: умолчание CLI вендора — обычно самая дорогая модель (правило оркестрации).
// 2. План до правки. Если в доверенном реестре проекта (`collab project --json` →
//    `<registryDir>/<projectId>/project.json`) есть `plan_gate: {"plans_dir": …, "paths": […]}`,
//    правка файла под `paths` без плана со строками «Маршрут:» и `ux_impact:` запрещена. План —
//    последний файл `plans_dir/*.md`, упомянутый в транскрипте этой сессии, иначе самый свежий.
//
// Это ведущая сессия, а не граница безопасности: непонятный вход, нет collab, нет проекта — действие
// проходит, запрещается только то, что хук точно распознал.
import { IS_WINDOWS, SEGMENT_SPLIT, homeDir, shellWords, toolName } from './lib/paths.mjs';
import { planProblem } from './lib/plan-gate.mjs';

const PATCH_PATH = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

// ── 1. явная модель ───────────────────────────────────────────────────────────

function hasFlag(args, { short = [], long = [] }) {
  return args.some((a) => short.includes(a) || long.includes(a) || long.some((name) => a.startsWith(`${name}=`)));
}

export function modelProblem(command, windows = IS_WINDOWS) {
  for (const segment of command.split(SEGMENT_SPLIT)) {
    let words = shellWords(segment.trim(), windows);
    if (!words || words.length === 0) continue;
    while (words.length > 0 && ENV_ASSIGN.test(words[0])) words = words.slice(1);
    if (words.length === 0) continue;
    const tool = toolName(words[0], windows);
    const args = words.slice(1);
    if (tool === 'codex' && args.length > 0 && (args[0] === 'exec' || args[0] === 'e')) {
      if (!hasFlag(args.slice(1), { short: ['-m', '-p'], long: ['--model', '--profile'] })) {
        return '`codex exec` без явной модели (-m <slug> из collab models): умолчание CLI — обычно самая дорогая модель';
      }
    }
    if (tool === 'claude' && hasFlag(args, { short: ['-p'], long: ['--print'] })) {
      if (!hasFlag(args, { long: ['--model'] })) {
        return '`claude -p` без явной модели (--model <алиас> из collab models): умолчание — модель аккаунта, обычно самая дорогая';
      }
    }
  }
  return null;
}

// ── 2. план до правки — hooks/lib/plan-gate.mjs ───────────────────────────────

const patchTargets = (patch) => [...(patch ?? '').matchAll(PATCH_PATH)].map((m) => m[1].trim());

export async function main({ stdinText, env, cwd: hostCwd, stderr }) {
  try {
    let event;
    try {
      event = JSON.parse(stdinText);
    } catch {
      return 0;
    }
    if (!event || typeof event !== 'object' || !event.tool_input || typeof event.tool_input !== 'object') return 0;
    const command = event.tool_input.command;
    if (typeof command !== 'string') return 0;
    const cwd = typeof event.cwd === 'string' ? event.cwd : hostCwd;
    let problem = null;
    if (event.tool_name === 'Bash') problem = modelProblem(command);
    else if (['apply_patch', 'Edit', 'Write'].includes(event.tool_name)) {
      problem = planProblem(patchTargets(command), cwd, event.transcript_path, homeDir(env));
    }
    if (!problem) return 0;
    stderr(`codex-guard: ${problem}\n`);
    return 2;
  } catch {
    // ведущая сессия, не граница: сбой хука не останавливает работу
    return 0;
  }
}
