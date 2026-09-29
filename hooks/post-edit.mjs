// PostToolUse-хук ведущей сессии Claude Code (Edit|Write|MultiEdit): правка файла, за которым стоит гейт проекта,
// сразу прогоняет этот гейт. Файл уже записан — хук ничего не отменяет: красный гейт возвращается агенту
// (код 2, stderr попадает в контекст) в тот же ход, а не из preflight перед пушем.
//
// Что за чем стоит — `post_edit` в доверенном реестре проекта (project.json): массив правил
//   { gate, paths: [префикс на «/» или точный путь], registries: [{ file, keys: { <ключ>: <префикс значения> } }] }
// Правило срабатывает, если путь правки: совпал с `paths`, равен `registries[].file` или назван в реестре
// значением под одним из `keys` (на любой глубине; к значению дописывается префикс). Так карта «файл → гейт»
// читается из тех же реестров, что и сами гейты, а новый файл вне реестра ловится по `paths`.
//
// Ведущая сессия, не граница: нет collab, настройки, гейта, непонятный вход — правка проходит.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CapTimeout, cleanEnv, homeDir, isInside, realpathLoose, relativeSlashed, runCapped } from './lib/paths.mjs';
import { gateArgv, gitRoot, projectSetting } from './lib/project.mjs';

const BUDGET_SECONDS_DEFAULT = 55; // таймаут хоста в settings.json — 60; POST_EDIT_SECONDS — только для тестов

function registryValues(data, keys) {
  const found = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (Object.hasOwn(keys, k) && typeof v === 'string') found.add(`${keys[k] ?? ''}${v}`);
        else walk(v);
      }
    }
  };
  walk(data);
  return found;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function ruleMatches(rule, root, rel) {
  const paths = Array.isArray(rule.paths) ? rule.paths.filter((p) => typeof p === 'string' && p) : [];
  if (paths.some((p) => (p.endsWith('/') ? rel.startsWith(p) : rel === p))) return true;
  for (const reg of Array.isArray(rule.registries) ? rule.registries : []) {
    if (typeof reg?.file !== 'string' || !reg.file) continue;
    if (rel === reg.file) return true;
    const keys = reg.keys && typeof reg.keys === 'object' && !Array.isArray(reg.keys) ? reg.keys : {};
    const data = readJson(path.join(root, reg.file));
    if (data && registryValues(data, keys).has(rel)) return true;
  }
  return false;
}

export async function main({ stdinText, env, cwd: hostCwd, stderr }) {
  try {
    const started = Date.now();
    let event;
    try {
      event = JSON.parse(stdinText);
    } catch {
      return 0;
    }
    const target = event?.tool_input?.file_path;
    if (typeof target !== 'string' || !target) return 0;
    const home = homeDir(env);
    const cwd = typeof event.cwd === 'string' && event.cwd ? event.cwd : hostCwd;
    const setting = projectSetting(cwd, home, 'post_edit');
    if (!setting || !Array.isArray(setting.value)) return 0;

    const root = realpathLoose(gitRoot(cwd, cleanEnv(home)));
    const abs = realpathLoose(path.isAbsolute(target) ? target : path.join(cwd, target));
    if (!isInside(root, abs)) return 0;
    const rel = relativeSlashed(root, abs);

    const gates = [];
    for (const rule of setting.value) {
      if (typeof rule?.gate !== 'string' || !rule.gate || gates.includes(rule.gate)) continue;
      if (ruleMatches(rule, root, rel)) gates.push(rule.gate);
    }

    const budgetMs = (Number(env.POST_EDIT_SECONDS) > 0 ? Number(env.POST_EDIT_SECONDS) : BUDGET_SECONDS_DEFAULT) * 1000;
    const deadline = started + budgetMs; // бюджет общий: чтение реестра и git входят в него
    const failed = [];
    for (const gate of gates) {
      const file = path.resolve(root, gate);
      if (!existsSync(file)) continue;
      const left = deadline - Date.now();
      if (left <= 0) {
        failed.push(`${gate} — не запущен: бюджет времени хука исчерпан. Прогони его сам.`);
        continue;
      }
      let run;
      try {
        run = await runCapped(gateArgv(file), { cwd: root, env: cleanEnv(home), timeoutMs: left });
      } catch (error) {
        if (error instanceof CapTimeout) failed.push(`${gate} — не уложился во время после правки ${rel}. Прогони его сам.`);
        continue;
      }
      if (run.status === 0) continue;
      const tail = `${run.stdout}${run.stderr}`.trim().split(/\r?\n/).slice(-40).join('\n');
      failed.push(`${gate} — провал после правки ${rel}:\n${tail}`);
    }
    if (!failed.length) return 0;
    stderr(
      `${failed.join('\n\n')}\n\nГейт красный. Если в выводе чужой файл (дерево общее) — назови это в отчёте, не чини. ` +
        'Baseline рэтчета (--update-baseline) не перезамораживать ради зелёного.\n'
    );
    return 2;
  } catch {
    return 0;
  }
}
