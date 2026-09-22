#!/usr/bin/env python3
"""PreToolUse-хук (Agent) ведущего сеанса: `model` в вызове Agent — обязателен.

Правило rules/orchestration.md: «`model` указывается всегда явно (пропуск =
модель ведущего сеанса, то есть самая дорогая)». Без этого хука это была
только память verifier'а, разбирающего транскрипт постфактум фильтром
routing-audit.jq, — здесь оно становится проверкой перед самим вызовом.

Исключение — `subagent_type: "fork"`: форк всегда наследует модель ведущей
сессии, это не пропуск, а осознанный дефолт самого инструмента.

В отличие от scope-guard/readonly-guard, у этого хука нет проектных данных
(нет `scopes.json`, не нужен `KIT_AGENT`) — он одинаков для всех проектов и
подключается не во фронтматтере субагента, а в `.claude/settings.json`
ведущей сессии:
  "PreToolUse": [{
    "matcher": "Agent",
    "hooks": [{"type": "command",
               "command": "/usr/bin/python3 \"$HOME/.agent-kit/current/hooks/model-guard.py\" || exit 2",
               "timeout": 10}]
  }]

Сбой парсинга stdin или отсутствие tool_input — fail-open (return 0): баг
хука не должен ронять вообще все делегирования.
"""
import json
import sys


def block(message: str) -> int:
    print(f"model-guard: {message}", file=sys.stderr)
    return 2


def main() -> int:
    try:
        event = json.load(sys.stdin)
    except json.JSONDecodeError:
        return 0
    tool_input = event.get("tool_input")
    if not isinstance(tool_input, dict):
        return 0

    if tool_input.get("subagent_type") == "fork":
        return 0

    model = tool_input.get("model")
    if isinstance(model, str) and model.strip():
        return 0

    return block(
        "вызов Agent без явной `model` (кроме subagent_type: \"fork\", который всегда наследует "
        "модель ведущей сессии). Правило rules/orchestration.md: пропуск model = наследование "
        "самой дорогой модели по умолчанию, а не умное распределение. "
        "Добавь model: \"sonnet\"/\"opus\"/\"haiku\" в вызов."
    )


if __name__ == "__main__":
    sys.exit(main())
