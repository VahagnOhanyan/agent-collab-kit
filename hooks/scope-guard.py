#!/usr/bin/env python3
"""PreToolUse-хук (Edit|Write|NotebookEdit) для субагентов-исполнителей.

Правка файла вне области агента блокируется, а не «не рекомендуется»: словесное
«не трогай backend/» в промпте — контекст, а этот скрипт — ограничение. Exit 2
отменяет вызов инструмента, причина из stderr уходит агенту.

Настройка через окружение в строке команды хука (frontmatter агента):
  SCOPE_ALLOW="Tripix/ TripixTests/ Modules/"   префиксы относительно корня репо
  SCOPE_DENY="backend/test/contracts/"          запрещено даже внутри allow
Пути под /tmp и /private/tmp (scratchpad) разрешены всегда. Событие — JSON на stdin.
"""
import json
import os
import subprocess
import sys


def main() -> int:
    try:
        event = json.load(sys.stdin)
    except json.JSONDecodeError:
        return 0  # не наше событие — не мешаем
    tool_input = event.get("tool_input") or {}
    path = tool_input.get("file_path") or tool_input.get("notebook_path")
    if not path:
        return 0
    cwd = event.get("cwd") or os.getcwd()
    try:
        root = subprocess.run(
            ["git", "-C", cwd, "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, check=False,
        ).stdout.strip() or cwd
    except OSError:
        root = cwd
    abs_path = os.path.abspath(path if os.path.isabs(path) else os.path.join(cwd, path))
    if abs_path.startswith(("/tmp/", "/private/tmp/")):
        return 0
    rel = os.path.relpath(abs_path, root)
    allow = os.environ.get("SCOPE_ALLOW", "").split()
    deny = os.environ.get("SCOPE_DENY", "").split()

    def under(prefixes):
        return any(rel == p.rstrip("/") or rel.startswith(p) for p in prefixes)

    def block(message):
        print(f"scope-guard: {message}", file=sys.stderr)
        return 2

    if rel.startswith(".."):
        return block(f"{abs_path} вне репозитория — правки только внутри {allow or ['репозитория']}")
    if under(deny):
        return block(f"{rel} принадлежит ведущему сеансу (deny: {deny}) — не править, описать нужное изменение в отчёте")
    if allow and not under(allow):
        return block(f"{rel} вне области агента (allow: {allow}) — не править, описать нужное изменение в отчёте")
    return 0


if __name__ == "__main__":
    sys.exit(main())
