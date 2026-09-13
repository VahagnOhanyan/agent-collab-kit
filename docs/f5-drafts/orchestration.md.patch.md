# Патч для .claude/rules/orchestration.md (Tripix)

Задание называло строки 9, 12, 13, 15. По факту, при чтении файла, пути `tools/collab/...` встречаются только на строках **12** и **13**. Строки 9 и 15 упоминают имена скиллов (`codex-review`, `ui-review`) и `.claude/rules/design-system.md` в прозе, без пути внутрь `tools/`, — их резолвинг не меняется, править нечего.

---

## Строка 12 (границы Tripix — запись в дерево)

OLD:
```
- **Запись в дерево — по `.claude/rules/workflow.md`.** Codex, пишущий код, — только в выделенном worktree с разрешения владельца, и промпт обязан требовать `claim_task` / `claim_files` в collab до первой правки (`tools/collab/codex/briefing.md`). Хуков-границ, как у `ios-implementer`, у Codex нет — collab «не граница безопасности» (`docs/tooling/collab.md`, раздел «Честная граница»).
```

NEW:
```
- **Запись в дерево — по `.claude/rules/workflow.md`.** Codex, пишущий код, — только в выделенном worktree с разрешения владельца, и промпт обязан требовать `claim_task` / `claim_files` в collab до первой правки (`~/agent-kit/projects/tripix/collab/briefings/codex.md`). Хуков-границ, как у `ios-implementer`, у Codex нет — collab «не граница безопасности» (`docs/tooling/collab.md`, раздел «Честная граница»).
```

---

## Строка 13 (границы Tripix — запуск Codex)

OLD:
```
- **Запуск Codex.** Никогда — сам по событию collab (автозапуск выключен решением владельца 10.09.2026, `tools/collab/config/agents.json`). Внутри задачи владельца — read-only на эффективной модели. Один `/ui-review` на `gpt-6-astra` ≈ половина 5-часового окна Plus — перед таким запуском назвать цену и дождаться согласия.
```

NEW:
```
- **Запуск Codex.** Никогда — сам по событию collab (автозапуск выключен решением владельца 10.09.2026, `~/agent-kit/collab/config/agents.json`). Внутри задачи владельца — read-only на эффективной модели. Один `/ui-review` на `gpt-6-astra` ≈ половина 5-часового окна Plus — перед таким запуском назвать цену и дождаться согласия.
```

**Важно:** это встроенный файл набора, а не переопределение Tripix (`~/agent-kit/projects/tripix/collab/agents.json`). Флаг `adapter.enabled` для `codex` объявлен только во встроенном `agents.json` — `~/agent-kit/README.md` прямо говорит, что адаптеры берутся исключительно оттуда и запись в реестре проекта была бы проигнорирована (см. `//adapter` в самом файле). Указывать здесь путь к файлу реестра Tripix было бы неверно.
