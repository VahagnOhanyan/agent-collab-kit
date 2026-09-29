// План до правки — общая проверка для ведущих сессий (Claude Code: hooks/plan-gate.mjs, Codex:
// hooks/codex-guard.mjs). Настройка — только из доверенного реестра проекта (`collab project --json` →
// `<registryDir>/<projectId>/project.json`, ключ `plan_gate: {"plans_dir": …, "paths": […]}`), не из
// репозитория. Правка файла под `paths` без плана со строками «Маршрут:» и `ux_impact:` — запрет.
// Текущий план — последний файл `plans_dir/*.md`, упомянутый в транскрипте этой сессии (каталог планов
// общий у параллельных сессий), иначе самый свежий. Правки в самом каталоге планов не проверяются.
//
// Это ведущая сессия, а не граница безопасности: нет collab, нет проекта, нет настройки — null (проход).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { IS_WINDOWS, collabProject, expandUser, isInside, realpathLoose, relativeSlashed } from './paths.mjs';

const UX_IMPACT_LINE = /^[\s>*`|-]*ux_impact:\s*[*`]*\s*(NONE|LOW|MEDIUM|HIGH)\b/m;

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

// targets — пути правки как пришли от хоста (абсолютные или от cwd). Возвращает текст запрета или null.
export function planProblem(targets, cwd, transcriptPath, home) {
  if (targets.length === 0 || typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
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
    return `правка ${gated[0]} — код проекта, а в текущем плане ${name} нет строк ${missing.join(' и ')}. Допиши их в план до первой правки — в файл, не в реплику.`;
  }
  return null;
}
