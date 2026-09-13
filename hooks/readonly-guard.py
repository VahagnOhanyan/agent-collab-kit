#!/usr/bin/env python3
"""PreToolUse-хук (Bash) для субагента verifier: проверяющий не меняет состояние.

verifier получает Bash ради preflight, сборки и точечных тестов. Тот же Bash умеет
`git commit`, `sed -i` и `--update-baseline` — то есть «починить» то, что должен был
только измерить, и перезаморозить рэтчет под свой вердикт. Список ниже режет мутации
дерева, git, серверов, БД и телефона; чтение проходит. Событие — JSON на stdin, exit 2 = блок.
"""
import json
import re
import sys

PATTERNS = [
    r"\bgit\s+(commit|push|add|rm|mv|checkout|switch|restore|reset|rebase|merge|cherry-pick|revert|clean|tag)\b",
    r"\bgit\s+stash\s+(push|pop|drop|clear|apply)\b",
    r"\bgit\s+branch\s+-[dDmM]\b",
    r"\bgit\s+worktree\s+(add|remove|prune)\b",
    r"\bgit\s+config\s+(?!--get)",
    r"^\s*(rm|mv|cp|mkdir|touch|chmod|chown|ln)\s",
    r"[;&|]\s*(rm|mv|cp|mkdir|touch|chmod|chown|ln)\s",
    r"\bsed\s+-i",
    r"\btee\b",
    r"(^|[^<>&0-9])>\s*(?!/tmp/|/private/tmp/|/dev/null)\S",
    r"--update-baseline",
    r"\b(npm|pnpm|yarn)\s+(install|i|add|remove|uninstall|update|publish|version)\b",
    r"\bnpx\s+prisma\s+(migrate|db\s+push|db\s+seed)",
    r"\bpsql\b.*\b(DROP|DELETE|UPDATE|INSERT|TRUNCATE|ALTER|CREATE)\b",
    r"\bxcodebuild\b.*\b(test|test-without-building|archive)\b",
    r"\bxcrun\s+devicectl\s+device\s+(install|launch|uninstall|process)",
    r"\bxcrun\s+simctl\s+(install|launch|erase|delete|boot|shutdown|uninstall)",
    r"\b(ssh|scp|rsync)\b",
    r"\bdocker(-compose)?\b.*\b(down|rm|prune|exec|run|push|build)\b",
    r"\b(kill|killall|pkill)\b",
]


def main() -> int:
    try:
        event = json.load(sys.stdin)
    except json.JSONDecodeError:
        return 0
    command = (event.get("tool_input") or {}).get("command", "")
    for pattern in PATTERNS:
        if re.search(pattern, command, re.I | re.S):
            print(
                "readonly-guard: verifier не меняет состояние дерева, git, БД, серверов и телефона — "
                f"команда заблокирована (правило: {pattern}). Опиши, что хотел проверить, в отчёте.",
                file=sys.stderr,
            )
            return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
