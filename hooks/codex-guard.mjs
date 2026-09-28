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
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  IS_WINDOWS, SEGMENT_SPLIT, collabProject, expandUser, homeDir, isInside, realpathLoose, relativeSlashed,
  shellWords, toolName,
} from './lib/paths.mjs';

const PATCH_PATH = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;
const UX_IMPACT_LINE = /^[\s>*`|-]*ux_impact:\s*[*`]*\s*(NONE|LOW|MEDIUM|HIGH)\b/m;
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

// ── 2. план до правки ─────────────────────────────────────────────────────────

function planGateConfig(info, home) {
  const { projectId, registryDir, codeRoot } = info;
  if (![projectId, registryDir, codeRoot].every((v) => typeof v === 'string')) return null;
  let gate;
  try {
    gate = JSON.parse(readFileSync(path.join(registryDir, projectId, 'project.json'), 'utf8')).plan_gate;
  } catch {
    return null;
  }
  if (!gate || typeof gate !== 'object' || typeof gate.plans_dir !== 'string' || !Array.isArray(gate.paths)) return null;
  let plansDir = expandUser(gate.plans_dir, home);
  if (!path.isAbsolute(plansDir)) plansDir = path.join(codeRoot, plansDir);
  return {
    codeRoot: realpathLoose(codeRoot),
    plansDir: realpathLoose(plansDir),
    // Как агент мог написать путь в транскрипте: как настроено или уже разрешённый.
    plansSpellings: [...new Set([path.normalize(plansDir), realpathLoose(plansDir)])],
    paths: gate.paths.filter((p) => typeof p === 'string' && p),
  };
}

// Разделители в написании пути — любые (в JSON-транскрипте обратный слеш удвоен).
function spellingPattern(spelling) {
  return spelling
    .split(/[\\/]+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('(?:\\\\\\\\|\\\\|/)+');
}

function currentPlan(plansDir, transcriptPath, spellings) {
  let names;
  try {
    names = readdirSync(plansDir).filter((n) => n.endsWith('.md'));
  } catch {
    return null;
  }
  if (names.length === 0) return null;
  if (typeof transcriptPath === 'string' && transcriptPath) {
    try {
      const text = readFileSync(transcriptPath, 'utf8');
      const alternatives = (spellings.length ? spellings : [plansDir]).map(spellingPattern).join('|');
      const re = new RegExp(`(?:${alternatives})(?:\\\\\\\\|\\\\|/)+([^"'\\s\\\\/]+\\.md)`, IS_WINDOWS ? 'gi' : 'g');
      const mentioned = [...text.matchAll(re)].map((m) => m[1]);
      for (const name of mentioned.reverse()) {
        const hit = names.find((n) => (IS_WINDOWS ? n.toLowerCase() === name.toLowerCase() : n === name));
        if (hit) return hit;
      }
    } catch {
      // транскрипт недоступен — решает самый свежий план
    }
  }
  return names.reduce((best, n) => (statSync(path.join(plansDir, n)).mtimeMs > statSync(path.join(plansDir, best)).mtimeMs ? n : best));
}

function planProblem(patch, cwd, transcriptPath, home) {
  const targets = [...(patch ?? '').matchAll(PATCH_PATH)].map((m) => m[1].trim());
  if (targets.length === 0) return null;
  const info = collabProject(cwd, home);
  const gate = info ? planGateConfig(info, home) : null;
  if (!gate) return null;
  const gated = [];
  for (const target of targets) {
    const resolved = realpathLoose(path.isAbsolute(target) ? target : path.join(cwd, target));
    if (isInside(gate.plansDir, resolved)) continue;
    if (!isInside(gate.codeRoot, resolved)) continue;
    const rel = relativeSlashed(gate.codeRoot, resolved);
    if (gate.paths.some((p) => rel === p.replace(/\/+$/, '') || rel.startsWith(p.endsWith('/') ? p : `${p}/`))) gated.push(rel);
  }
  if (gated.length === 0) return null;
  const name = currentPlan(gate.plansDir, transcriptPath, gate.plansSpellings);
  if (!name) {
    return `правка ${gated[0]} — код проекта, а в ${gate.plansDir} нет плана. Запиши план (со строками «Маршрут:» и «ux_impact:») до первой правки.`;
  }
  const text = readFileSync(path.join(gate.plansDir, name), 'utf8');
  const missing = [
    ['«Маршрут:»', text.includes('Маршрут:')],
    ['«ux_impact:»', UX_IMPACT_LINE.test(text)],
  ].filter(([, ok]) => !ok).map(([label]) => label);
  if (missing.length > 0) {
    return `правка ${gated[0]} — код проекта, а в текущем плане ${name} нет строк ${missing.join(' и ')}. Допиши их в план до первой правки.`;
  }
  return null;
}

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
      problem = planProblem(command, cwd, event.transcript_path, homeDir(env));
    }
    if (!problem) return 0;
    stderr(`codex-guard: ${problem}\n`);
    return 2;
  } catch {
    // ведущая сессия, не граница: сбой хука не останавливает работу
    return 0;
  }
}
