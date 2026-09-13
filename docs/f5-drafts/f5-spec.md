# Ф5 — Tripix переходит на общий набор (одним коммитом в Tripix)

Предусловия: Ф2–Ф4 закоммичены в `~/agent-kit`; Ф3-установщик прогнан на машине (с согласия владельца), `current` указывает на релиз; `collab` MCP уровня пользователя и блок Codex указывают на `current`; в реестре `projects/tripix/project.json` есть `"legacy_journal": true`.

## Опись ссылок (git grep 12.09.2026, HEAD aecc22b1e)
| Где | Что | Действие |
|---|---|---|
| `.mcp.json:13-19` | сервер `collab` → `tools/collab/src/mcp/server.mjs` | удалить запись (иначе проект перекроет пользовательскую регистрацию и Tripix останется на старом коде) |
| `tools/collab/**` | старый код слоя | удалить каталог |
| `tools/ui-review/**` | старые скрипты | удалить каталог |
| `.claude/skills/ui-review/`, `.claude/skills/codex-review/` | копии скиллов | удалить (пользовательские с тем же именем побеждают — оставшиеся копии молча не работали бы) |
| `scripts/check-collab-config.mjs` | гейт импортирует `tools/collab/src` | удалить; проверку конфига делает набор (`collab check-config --project tripix`) |
| `scripts/preflight.sh:101` | вызов гейта | заменить: если `command -v collab` — `collab check-config --project tripix`, иначе строка «collab не установлен — проверка реестра пропущена» (не красный) |
| `.github/workflows/config-guards.yml:212` | шаг гейта в CI | удалить шаг (в CI нет машинного реестра); проверить, что preflight сверяет себя с workflow — поправить список, если он требует этот шаг |
| реестр `projects/tripix/collab/runners.json` (в `~/agent-kit`) | раннер `collab-tests` на `tools/collab/test/` | удалить раннер из реестра (тесты набора живут в `~/agent-kit`) — это правка набора, до Ф5 |
| `CLAUDE.md:85,122,125,133` | пути `tools/collab`, `tools/ui-review`, команды `node tools/collab/src/cli.mjs` | пути → общий набор (`~/agent-kit`, `collab <команда>`), конфиг агентов → `~/agent-kit/projects/tripix/collab/agents.json`, скиллы → уровень пользователя |
| `.claude/rules/orchestration.md:9,12,13,15` | `tools/collab/config/agents.json`, скиллы | пути → реестр набора; суть правил не меняется |
| `docs/tooling/collab.md` (много) | команды, расположение конфига, установщик Codex, тесты | переписать разделы «Команды владельца», «Добавить агента», «Codex», «Тесты» под `collab …`, реестр и `agent-kit-install`; ссылка на `~/agent-kit/collab/SECURITY.md`; раздел «Честная граница» оставить и дополнить новыми гарантиями |
| `docs/decisions/0011-*.md:15,19,51` | «слой в `tools/collab/`» | ADR не переписывать; добавить в шапку «Дополнено ADR-0013»; новый `docs/decisions/0013-collab-moves-to-machine-level-agent-kit.md` (почему, что изменилось в гарантиях, где конфиг, что остаётся в Tripix, как откатить) |
| `.gitignore:181-190` | комментарии про `tools/collab`, `.claude/skills/ui-review` | переформулировать; строки `.collab/` и `.ui-review/` оставить |
| `.claude/rules/workflow.md:22` | имена скиллов | без изменений (скиллы существуют на уровне пользователя) |

## Журнал Tripix
- Остаётся на месте `Tripix/.collab/` (старый формат, в git не отслеживается).
- Набор принимает его по флагу `legacy_journal` реестра.
- Владелец однажды выполняет `collab init --adopt` в интерактивном терминале (привязка маркера к корню), после чего флаг можно снять.

## Worktree на старых ветках
`.claude/worktrees/*` — свои ветки со старыми `.mcp.json` и `tools/collab`: сессии там работают на старом коде до ребейза на `main` (формат журнала совместим, проверено). Это указать в ADR-0013 и `docs/tooling/collab.md`.

## Проверка перед коммитом Tripix
1. `scripts/preflight.sh` зелёный (с установленным `collab` и в режиме «не установлен» — `PATH` без `collab`).
2. `node scripts/check-claude-md-paths.mjs` — все ссылки резолвятся.
3. Новая сессия Claude в `~/Tripix`: MCP `collab` — пользовательский (`~/.agent-kit/current/…`), `whoami` работает, задачи журнала те же, что до перехода (сверка списка задач до/после).
4. Сессия в worktree `map-pin-spatial-grouping`: тот же журнал.
5. `/ui-review` и `/codex-review` видны и приходят из `~/.claude/skills` (пользовательский уровень); `ui-review` в Tripix берёт `ui-review.json`/`ui-review.md` из реестра (`capture.sh --dry-run`).
6. Агенты Tripix `ios-implementer`/`backend-implementer`/`verifier` работают как раньше (проектные перекрывают общие).
7. Независимая проверка: субагент `verifier` + ревью диффа Codex `gpt-5.6-sol` (read-only, `mcp_servers.collab.enabled=false`).

## Память и правила вне репозитория
- Память Tripix: запись о переходе (где слой, реестр, установщик, откат) — обновить `reference_codex_cli_auth_and_collab_registration.md` и индекс.
- `~/.claude/rules/orchestration.md`: абзац «что есть в каждом проекте» — `collab` (после `collab init`), `/codex-review`, `/ui-review`, `implementer`, `verifier`; как включить новый проект (запись в реестре → `agent-kit-install` → `collab init`).
