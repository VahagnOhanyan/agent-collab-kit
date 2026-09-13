# Обновление auto-memory Tripix

Файл: `~/.claude/projects/-Users-vahagnohanyan-Tripix/memory/reference_codex_cli_auth_and_collab_registration.md`
Индекс: `~/.claude/projects/-Users-vahagnohanyan-Tripix/memory/MEMORY.md`, строка 11.

Меняются ровно два места в теле файла (регистрация collab, комментарий про адаптер) — остальное (логин, модели, флаги `codex exec`, `config.toml`) актуально и не трогается. `modified` в шапке — проставить временем реального коммита Ф5, ниже условно.

---

## Полная замена reference_codex_cli_auth_and_collab_registration.md

```markdown
---
name: reference_codex_cli_auth_and_collab_registration
description: "Codex CLI 0.154: логин ChatGPT Plus рабочий с 12.09.2026, дефолт gpt-6-astra; зарегистрирован в collab (машинный набор ~/agent-kit, ADR-0013); MCP-инструменты отложены за tool search; у exec нет --ask-for-approval"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 9f1e7a34-ac2b-4a01-be86-9ba51355438c
  modified: 2026-09-12T23:00:00.000Z
---

Состояние на 12.09.2026 — проверено реальными запусками, не по памяти:

- `npm install -g @openai/codex` → `codex-cli 0.154.0`, бинарь `/opt/homebrew/bin/codex`
  (устанавливается без sudo, префикс npm — `/opt/homebrew`).
- MCP-сервер collab зарегистрирован в `~/.codex/config.toml` блоком `[mcp_servers.collab]`
  (установщик — `~/agent-kit/bin/agent-kit-install`, идемпотентный, с бэкапом; сервер общий
  для всех проектов машины, не только Tripix — слой переехал из `tools/collab/` в машинный
  набор `~/agent-kit`, см. ADR-0013 и `docs/tooling/collab.md`).
  `codex mcp list` показывает его как `enabled`.
- ✅ **Авторизация работает.** 12.09 владелец перелогинил Codex во второй свой аккаунт
  ChatGPT, план **Plus**. Запись от 10.09 про протухший refresh-токен больше не актуальна.
  Если `codex exec` снова упадёт на авторизации — лечится только интерактивным
  `codex login` (браузерный OAuth); агент этого не делает.
- Модели (`~/.codex/models_cache.json`): `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`,
  `gpt-5.6-luna`, `gpt-5.5`. ⛔ `gpt-5.4` с ChatGPT-аккаунтом не поддерживается.
  Лимит Plus — в процентах (окно 5 ч + неделя): последний `rate_limits` в событиях
  `token_count` файлов `~/.codex/sessions/<гггг>/<мм>/<дд>/*.jsonl`.
- ⛔ **MCP-инструменты у Codex отложены** за tool search: без фразы «найди collab
  через tool search» в промпте он отвечает, что инструментов нет.

Флаги `codex exec` в 0.154 (сверено с `--help`, не по памяти): `-s/--sandbox
read-only|workspace-write|danger-full-access`, `-C/--cd`, `--skip-git-repo-check`,
`--json`, `-o/--output-last-message`, `--output-schema`, `-m`, `-i/--image`,
`--approve-for-me`.
⛔ **`--ask-for-approval` у `exec` НЕТ** — команда неинтерактивна сама по себе,
границу задаёт `--sandbox`. ⛔ `-i` вариадический — промпт ставить ДО `-i`, иначе
он будет прочитан как путь к картинке.

`~/.codex/config.toml` владельца: `model = "gpt-6-astra"`, `model_reasoning_effort =
"xhigh"`, `approval_policy = "never"`, `sandbox_mode = "danger-full-access"`,
`[mcp_servers.linear]` отключён (`enabled = false`), `~/Tripix` в `trust_level = "trusted"`.
Автозапуск Codex из collab выключен намеренно — флаг `adapter.enabled: false` для `codex`
живёт только во встроенном `~/agent-kit/collab/config/agents.json` (не в реестре Tripix:
адаптеры берутся исключительно из встроенного файла набора).
Как делить работу между Claude и Codex — `.claude/rules/orchestration.md` в репозитории
и `~/.claude/rules/orchestration.md` на уровне пользователя (там же — что в каждом
проекте появляется после `agent-kit-install`).
```

---

## Замена строки индекса в MEMORY.md (строка 11)

OLD:
```
- [⭐Codex CLI: Plus, Astra, collab](reference_codex_cli_auth_and_collab_registration.md) — логин рабочий с 12.09 (Plus, дефолт `gpt-6-astra`); MCP-инструменты отложены за tool search; ⛔`--ask-for-approval` у `exec` нет, промпт до `-i`
```

NEW:
```
- [⭐Codex CLI: Plus, Astra, collab](reference_codex_cli_auth_and_collab_registration.md) — логин рабочий с 12.09 (Plus, дефолт `gpt-6-astra`); collab — машинный набор `~/agent-kit` (ADR-0013), не `tools/collab/`; MCP-инструменты отложены за tool search; ⛔`--ask-for-approval` у `exec` нет, промпт до `-i`
```
