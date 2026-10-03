# MiniMax и Grok в наборе

Оба клиента есть во встроенном каталоге (`collab/config/agents.json`, `models.json`) как **ручные** агенты:
набор их не запускает, работа приходит во входящие, процесс стартует человек или ведущий агент своей командой.
Предлагаемый состав для машины, где есть Codex, MiniMax и Grok, — `docs/minimax-grok-composition.proposed.json`.

## Кто что делает в предлагаемом составе

| Агент | Роли | Почему |
|---|---|---|
| Codex (ведущий) | `code_reviewer`, `security_reviewer`, `ux_reviewer`, `researcher` | Единственный из троих с проверенным запуском на ревью без права записи (`codex exec -s read-only`). Ролей исполнителя нет: его собственную работу некому было бы проверить |
| MiniMax | реализация, тесты, исследование | Лаунчер правит файлы и запускает оболочку — ревьюером быть не может |
| Grok | реализация, архитектура, тесты, исследование | `--sandbox read-only` есть в справке, но не проверен пробой — роли ревьюера появятся после пробы |

Правила набора, которые это определяют: роль ревьюера (`read_only` в `roles.json`) держит только агент с
`adapter.review_launch` в каталоге; работу проверяет не её автор (`reviewed_by`, проверка независимости в мастере).
Выбор исполнителя для конкретной задачи по-прежнему делает ведущий.

## Подключение на своей машине

**MiniMax.** Нужна команда `minimax-dev` в `PATH` — лаунчер с закреплённым маршрутом модели. Запуск задания:

```
minimax-dev --dir /absolute/path/to/project --task-file /absolute/path/to/task.md
```

Модель одна (`minimax-worker`, preview, потолок L1) и без запасной: `fallback_policy: "stop"` — при сбое работа
останавливается и владельцу сообщают. Журнал это держит: делегирование с `fallback_from: minimax-worker` отклоняется.
Подключение MiniMax к журналу `collab` через MCP не проверено.

**Grok.** Официальный CLI `@xai-official/grok`, команда `grok` в `PATH`. Задание:

```
grok --model MODEL_ID --cwd /absolute/path/to/project --prompt-file /absolute/path/to/task.md
```

Регистрация журнала: секция `[mcp_servers.collab]` с `COLLAB_AGENT_ID=grok` в `config.toml` профиля Grok
(`grok mcp add`, проверка — `grok mcp list --json`). Установщик набора пишет её для Claude, Codex и Cursor, но
не для Grok — один раз руками.

`MODEL_ID` — id из `collab models`: `grok-basic` (L1, потолок L2) или `grok-review` (L2, потолок L2). Оба не
проверены живым вызовом.

## Что не проверено

- Живой вызов Grok и то, что `--sandbox read-only` действительно не даёт писать. Когда проба пройдёт (попытка
  записать файл не удаётся), запуск записывается в каталог как `adapter.review_launch` с датой, версией CLI и
  доказательством — и Grok получает роли ревьюера.
- MiniMax: доступ к журналу `collab` через MCP и режим без права записи.
- Доступность id моделей у поставщиков: оба взяты из локальных данных, каталога для сверки нет.

## Проверки

```
node collab/src/cli.mjs check-config
node --test collab/test/minimax-grok.test.mjs
```
