#!/usr/bin/python3
"""PreToolUse-хук Codex CLI для ведущей сессии Codex: то, что у ведущего Claude Code держат
model-guard и проектный plan-gate.

Codex вызывает хук на Bash и на правки файлов (`apply_patch`); вход — JSON с `tool_name`,
`tool_input.command`, `cwd`, `transcript_path` (формат проверен вживую на codex-cli 0.154:
`apply_patch` приходит текстом патча со строками `*** Add|Update|Delete File: <путь>`,
`*** Move to: <путь>`). Запрет — код 2, причина — в stderr.

1. Явная модель. `codex exec` без `-m/--model/--profile` и `claude -p/--print` без `--model`
   запрещены: умолчание CLI вендора — обычно самая дорогая модель (правило оркестрации).
2. План до правки. Если в доверенном реестре проекта (`collab project --json` →
   `<registryDir>/<projectId>/project.json`) есть `plan_gate: {"plans_dir": …, "paths": […]}`,
   правка файла под `paths` без плана со строками «Маршрут:» и `ux_impact:` запрещена. План —
   последний файл `plans_dir/*.md`, упомянутый в транскрипте этой сессии, иначе самый свежий.

Это ведущая сессия, а не граница безопасности: непонятный вход, нет collab, нет проекта —
действие проходит (как у plan-gate), запрещается только то, что хук точно распознал.
"""
import json
import os
import re
import shlex
import subprocess
import sys

FIXED_PATH = "/usr/bin:/bin:/opt/homebrew/bin"
COLLAB_TIMEOUT_SECONDS = 5
PATCH_PATH = re.compile(r"^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$", re.M)
UX_IMPACT_LINE = re.compile(r"(?m)^[\s>*`|-]*ux_impact:\s*[*`]*\s*(NONE|LOW|MEDIUM|HIGH)\b")
SEGMENT_SPLIT = re.compile(r"\|\||&&|;|\||\n")


def block(message):
    sys.stderr.write("codex-guard: %s\n" % message)
    return 2


# ── 1. явная модель ───────────────────────────────────────────────────────────


def _words(segment):
    try:
        return shlex.split(segment, posix=True)
    except ValueError:
        return None


def _has_flag(args, short=(), long=()):
    return any(a in short or a in long or any(a.startswith(name + "=") for name in long) for a in args)


def model_problem(command):
    for segment in SEGMENT_SPLIT.split(command):
        words = _words(segment.strip())
        if not words:
            continue
        while words and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", words[0]):
            words = words[1:]
        if not words:
            continue
        tool = os.path.basename(words[0])
        args = words[1:]
        if tool == "codex" and args and args[0] in ("exec", "e"):
            if not _has_flag(args[1:], short=("-m", "-p"), long=("--model", "--profile")):
                return "`codex exec` без явной модели (-m <slug> из collab models): умолчание CLI — обычно самая дорогая модель"
        if tool == "claude" and _has_flag(args, short=("-p",), long=("--print",)):
            if not _has_flag(args, long=("--model",)):
                return "`claude -p` без явной модели (--model <алиас> из collab models): умолчание — модель аккаунта, обычно самая дорогая"
    return None


# ── 2. план до правки ─────────────────────────────────────────────────────────


def collab_project(cwd):
    home = os.environ.get("HOME", "")
    collab = os.path.join(home, ".agent-kit", "current", "bin", "collab")
    if not home.startswith("/") or not os.path.exists(collab):
        return None
    try:
        out = subprocess.run(
            [collab, "project", "--json"], cwd=cwd, env={"PATH": FIXED_PATH, "HOME": home},
            capture_output=True, timeout=COLLAB_TIMEOUT_SECONDS, check=False,
        )
        info = json.loads(out.stdout.decode("utf-8"))
    except (OSError, subprocess.TimeoutExpired, ValueError, UnicodeDecodeError):
        return None
    return info if isinstance(info, dict) and not info.get("error") else None


def plan_gate_config(info):
    project_id, registry, code_root = info.get("projectId"), info.get("registryDir"), info.get("codeRoot")
    if not (isinstance(project_id, str) and isinstance(registry, str) and isinstance(code_root, str)):
        return None
    try:
        with open(os.path.join(registry, project_id, "project.json"), "r", encoding="utf-8") as fh:
            gate = json.load(fh).get("plan_gate")
    except (OSError, ValueError):
        return None
    if not isinstance(gate, dict) or not isinstance(gate.get("plans_dir"), str) or not isinstance(gate.get("paths"), list):
        return None
    plans_dir = os.path.expanduser(gate["plans_dir"])
    if not os.path.isabs(plans_dir):
        plans_dir = os.path.join(code_root, plans_dir)
    paths = [p for p in gate["paths"] if isinstance(p, str) and p]
    return {
        "code_root": os.path.realpath(code_root),
        "plans_dir": os.path.realpath(plans_dir),
        # How the agent may have written it in the transcript: as configured, or resolved.
        "plans_spellings": sorted({os.path.normpath(plans_dir), os.path.realpath(plans_dir)}),
        "paths": paths,
    }


def current_plan(plans_dir, transcript_path, spellings=()):
    try:
        names = [n for n in os.listdir(plans_dir) if n.endswith(".md")]
    except OSError:
        return None
    if not names:
        return None
    if isinstance(transcript_path, str) and transcript_path:
        try:
            with open(transcript_path, "r", encoding="utf-8", errors="replace") as fh:
                text = fh.read()
            alternatives = "|".join(re.escape(s) for s in (spellings or [plans_dir]))
            mentioned = re.findall(r"(?:%s)/([^\"'\s\\/]+\.md)" % alternatives, text)
            for name in reversed(mentioned):
                if name in names:
                    return name
        except OSError:
            pass
    return max(names, key=lambda n: os.stat(os.path.join(plans_dir, n)).st_mtime)


def plan_problem(patch, cwd, transcript_path):
    targets = PATCH_PATH.findall(patch or "")
    if not targets:
        return None
    info = collab_project(cwd)
    gate = plan_gate_config(info) if info else None
    if not gate:
        return None
    root = gate["code_root"]
    gated = []
    for target in targets:
        path = os.path.realpath(target if os.path.isabs(target) else os.path.join(cwd, target))
        if path == gate["plans_dir"] or path.startswith(gate["plans_dir"] + os.sep):
            continue
        rel = os.path.relpath(path, root)
        if rel.startswith(".."):
            continue
        if any(rel == p.rstrip("/") or rel.startswith(p if p.endswith("/") else p + "/") for p in gate["paths"]):
            gated.append(rel)
    if not gated:
        return None
    name = current_plan(gate["plans_dir"], transcript_path, gate["plans_spellings"])
    if not name:
        return "правка %s — код проекта, а в %s нет плана. Запиши план (со строками «Маршрут:» и «ux_impact:») до первой правки." % (gated[0], gate["plans_dir"])
    with open(os.path.join(gate["plans_dir"], name), "r", encoding="utf-8", errors="replace") as fh:
        text = fh.read()
    missing = [label for label, ok in (("«Маршрут:»", "Маршрут:" in text), ("«ux_impact:»", bool(UX_IMPACT_LINE.search(text)))) if not ok]
    if missing:
        return "правка %s — код проекта, а в текущем плане %s нет строк %s. Допиши их в план до первой правки." % (gated[0], name, " и ".join(missing))
    return None


def main():
    try:
        event = json.loads(sys.stdin.read())
    except ValueError:
        return 0
    if not isinstance(event, dict) or not isinstance(event.get("tool_input"), dict):
        return 0
    command = event["tool_input"].get("command")
    if not isinstance(command, str):
        return 0
    cwd = event.get("cwd") if isinstance(event.get("cwd"), str) else os.getcwd()
    tool = event.get("tool_name")
    if tool == "Bash":
        problem = model_problem(command)
    elif tool in ("apply_patch", "Edit", "Write"):
        problem = plan_problem(command, cwd, event.get("transcript_path"))
    else:
        problem = None
    return block(problem) if problem else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # noqa: BLE001 - ведущая сессия, не граница: сбой хука не останавливает работу
        sys.exit(0)
