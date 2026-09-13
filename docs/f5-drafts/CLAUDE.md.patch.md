# Патч для CLAUDE.md (корень монорепы)

Строки даны по текущему `CLAUDE.md` (проверено чтением 12.09.2026, HEAD `aecc22b1e`). Задание называло приблизительно 85, 122, 125, 133, 135 — по факту правки нужны на строках **36, 85, 111, 122, 125, 133**; строка **135** (абзац про субагентов `.claude/agents/`, хуки `scripts/claude-hooks/` и скиллы `api-change`/`db-migration`/`verify`/`handoff`/`adversarial-audit`) ни `tools/collab`, ни `tools/ui-review`, ни местоположение скиллов `ui-review`/`codex-review` не упоминает — путей, требующих правки, там нет.

Строка **111** — не из задания, но обязательна: таблица гейтов перечисляет `check-collab-config` по имени, а `scripts/check-collab-config.mjs` удаляется. `scripts/check-claude-md-paths.mjs` проверяет ГОЛЫЕ имена гейтов (`check-foo` / `check-foo.mjs`) на то, что `scripts/check-foo.{sh,mjs}` отслеживается git — без этой правки preflight (его же шаг «пути в инструкциях агентов») станет красным.

---

## Строка 36 (карта репозитория, строка `tools/`)

OLD:
```
| [tools/](tools/) | `place-data/` — подготовка гео-датасетов; `collab/` — слой совместной работы агентов (общие задачи, сообщения, ревью, решения, одобрения) | [docs/tooling/place-boundaries.md](docs/tooling/place-boundaries.md), [docs/tooling/collab.md](docs/tooling/collab.md) |
```

NEW:
```
| [tools/](tools/) | `place-data/` — подготовка гео-датасетов | [docs/tooling/place-boundaries.md](docs/tooling/place-boundaries.md) |
```

`collab/` и `ui-review/` в `tools/` больше нет — оба переехали в машинный набор `~/agent-kit`. Ссылка на `docs/tooling/collab.md` не теряется: она остаётся в строке 122 (раздел «Агенты и порядок работы»).

---

## Строка 85 (сборка и тесты — скиллы `ui-shot`/`device-run`/`ui-review`/`codex-review`)

OLD:
```
Для запуска приложения на симуляторе со скриншотом есть скилл `ui-shot`, на физическом устройстве с логами — `device-run`. Визуальное улучшение экрана с Codex (скриншот → варианты → одобрение владельца → реализация → сравнение) — скилл `ui-review`, скрипты в [tools/ui-review/](tools/ui-review/). Ручной запуск ревью Codex из инбокса collab — скилл `codex-review`. Не поднимай симулятор руками для тестов. Процедуры — скиллы `verify` (проверка перед «готово»), `api-change` (форма API по трём реестрам), `db-migration`, `handoff`, `adversarial-audit`.
```

NEW:
```
Для запуска приложения на симуляторе со скриншотом есть скилл `ui-shot`, на физическом устройстве с логами — `device-run`. Визуальное улучшение экрана с Codex (скриншот → варианты → одобрение владельца → реализация → сравнение) — скилл `ui-review`, теперь уровня пользователя (`~/agent-kit`, скрипты в `~/agent-kit/ui-review/`); настройки этого проекта — `~/agent-kit/projects/tripix/ui-review.json` и `ui-review.md`. Ручной запуск ревью Codex из инбокса collab — скилл `codex-review`, тоже уровня пользователя. Не поднимай симулятор руками для тестов. Процедуры — скиллы `verify` (проверка перед «готово»), `api-change` (форма API по трём реестрам), `db-migration`, `handoff`, `adversarial-audit`.
```

---

## Строка 111 (таблица гейтов, строка `config-guards.yml`)

OLD:
```
| `config-guards.yml` | `check-cross-side-constants` · `check-enum-parity` · `check-design-system` · `check-design-tokens` · `check-ios-architecture` · `check-ios-cache-namespaces` · `check-ios-contracts` · `check-ios-debug-leaks` · `check-ios-session-purge` · `check-ios-viewer-identity` · `check-mapbox-sdk-pin` · `check-release-app-config` · `check-tracked-secrets` · `check-claude-md-paths` · `check-collab-config` · `check-cloudflare-ranges` |
```

NEW:
```
| `config-guards.yml` | `check-cross-side-constants` · `check-enum-parity` · `check-design-system` · `check-design-tokens` · `check-ios-architecture` · `check-ios-cache-namespaces` · `check-ios-contracts` · `check-ios-debug-leaks` · `check-ios-session-purge` · `check-ios-viewer-identity` · `check-mapbox-sdk-pin` · `check-release-app-config` · `check-tracked-secrets` · `check-claude-md-paths` · `check-cloudflare-ranges` |
```

---

## Строка 122 (агенты и порядок работы — вводное предложение)

OLD:
```
**Общее состояние агентов — MCP-сервер `collab`** ([tools/collab/](tools/collab/), документация — [docs/tooling/collab.md](docs/tooling/collab.md), решение — [ADR-0011](docs/decisions/0011-multi-agent-collaboration-layer.md)). Он есть у каждого зарегистрированного агента, включая Codex, и хранит задачи, сообщения, ревью, решения и запросы одобрения в файлах, а не в чьём-то контексте. Правила поведения, а не реализация:
```

NEW:
```
**Общее состояние агентов — MCP-сервер `collab`** (машинный набор `~/agent-kit`, установленный релиз `~/.agent-kit/current`; документация — [docs/tooling/collab.md](docs/tooling/collab.md), решения — [ADR-0011](docs/decisions/0011-multi-agent-collaboration-layer.md) и [ADR-0013](docs/decisions/0013-collab-moves-to-machine-level-agent-kit.md)). Он есть у каждого зарегистрированного агента, включая Codex, и хранит задачи, сообщения, ревью, решения и запросы одобрения в файлах, а не в чьём-то контексте. Правила поведения, а не реализация:
```

---

## Строка 125 (поиск коллеги по роли — реестр агентов)

OLD:
```
- **Ищи коллегу по роли и способности, не по имени** (`find_agents`). Пиши «нужен `code_reviewer`», не «спросить Codex»: реестр меняется, роли — интерфейс. Реестр — `tools/collab/config/agents.json`, третий агент добавляется записью в нём.
```

NEW:
```
- **Ищи коллегу по роли и способности, не по имени** (`find_agents`). Пиши «нужен `code_reviewer`», не «спросить Codex»: реестр меняется, роли — интерфейс. Реестр Tripix — `~/agent-kit/projects/tripix/collab/agents.json` (переопределяет встроенный `~/agent-kit/collab/config/agents.json`), третий агент добавляется записью в нём.
```

---

## Строка 133 (наблюдаемость для владельца)

OLD:
```
Наблюдаемость для владельца — `node tools/collab/src/cli.mjs status | task <id> | inbox <agent> | approvals | doctor | log`. Одобрения отвечаются только оттуда и только с интерактивного терминала.
```

NEW:
```
Наблюдаемость для владельца — `collab status | task <id> | inbox <agent> | approvals | doctor | log`. Одобрения отвечаются только оттуда и только с интерактивного терминала.
```

---

## Открытый риск, не решаемый этим патчем

`docs/decisions/0011-multi-agent-collaboration-layer.md` (не переписывается, см. `0011.header-note.md`) дважды называет `check-collab-config.mjs` голым именем (строки 40 и 51). После удаления `scripts/check-collab-config.mjs` `check-claude-md-paths.mjs` будет считать оба упоминания сломанной ссылкой на несуществующий гейт — ADR попадёт в красный preflight, притом что переписывать его не просят. Разрешить это может либо точечное исключение в `check-claude-md-paths.mjs` для замороженных ADR, либо разовая мелкая правка этих двух голых упоминаний в 0011 (не решение, а имя гейта) — решение за владельцем. Подробнее — `preflight-and-ci.patch.md`.
