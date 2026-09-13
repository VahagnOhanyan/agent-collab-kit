# Патч для scripts/preflight.sh и .github/workflows/config-guards.yml

## 1. scripts/preflight.sh, строка 101

Строка подтверждена чтением (совпадает с оценкой задания «~101»).

OLD:
```
run "реестр агентов collab"      node scripts/check-collab-config.mjs
```

NEW:
```
if command -v collab >/dev/null 2>&1; then
  run "реестр агентов collab"    collab check-config --project tripix
else
  [ "$QUIET" -eq 1 ] || printf '  %s·%s collab не установлен — проверка реестра пропущена\n' "$DIM" "$OFF"
fi
```

Ветка «не установлен» не трогает `FAILED` — preflight остаётся зелёным осознанно, а не потому что проверка соврала.

---

## 2. .github/workflows/config-guards.yml — шаг целиком удаляется

Строки 205–212 (подтверждено чтением; задание называло «~212» — это начало шага, комментарий над ним начинается на 205).

OLD:
```yaml
      # The agent registry is routing configuration, and a typo in it fails
      # silently: a role spelled "code_review" instead of "code_reviewer" makes
      # request_review find nobody, so the work is simply never reviewed and
      # nothing errors. The same guard also asserts the safety property the
      # collaboration layer exists for — that no MCP tool lets an agent
      # authorise its own spending, deployment or deletion.
      - name: Collab agent registry and approval surface
        run: node scripts/check-collab-config.mjs
```

NEW: (шаг удаляется целиком, ничего не остаётся на его месте — это был последний шаг job'а, следующий блок `cloudflare-ranges:` идёт как раньше без изменений)

Резонно: машинного реестра `~/agent-kit` в раннере CI нет и не будет, проверять там нечего. Требование «в CI нет машинного реестра» — из `f5-spec.md`.

---

## 3. Сверяет ли preflight сам себя с workflow, и что ещё должно измениться

Да. Первый шаг `scripts/preflight.sh` (строка 81) — `node scripts/check-preflight-sync.mjs`, и он же первым делом объясняет, зачем: preflight обязан говорить ровно то же самое, что скажет CI, иначе зелёный локально и красный в CI после пуша. Он читает **три** workflow, не два (в `CLAUDE.md:93` они названы «оба» — это отдельная, более старая неточность самого CLAUDE.md, не связанная с переходом на набор, чинить не в рамках этой задачи):

```
.github/workflows/config-guards.yml
.github/workflows/backend-architecture-guards.yml
.github/workflows/secret-scan.yml
```

Алгоритм: регектом достаёт из preflight.sh и из этих трёх файлов токены вида `scripts/check-*.{sh,mjs}` (плюс `npm run …` и `node --test test/*.test.js`) и требует, чтобы множества совпали — с учётом объявленных `# preflight-exclude:` строк.

**Проверено: после обеих правок выше (п.1 и п.2) ничего третьего чинить не нужно.** И у CI-шага, и у старой строки preflight единственным совпадением был буквальный токен `scripts/check-collab-config.mjs`; он исчезает из ОБОИХ файлов одновременно (в preflight.sh новая ветка вызывает `collab check-config …` — это не совпадает с шаблоном `scripts/check-*.mjs`, так как не начинается с `scripts/`). Множества `missing`/`ghost` остаются пустыми без единой строки `preflight-exclude`.

Единственное, о чём стоит помнить при реализации: экстрактор снимает только строки, целиком являющиеся комментарием (`^\s*#` или `^\s*//`); хвостовой комментарий в той же строке, где есть код, не снимается. Значит в новой ветке preflight.sh нельзя писать, например, `# было scripts/check-collab-config.mjs` в конце строки с кодом — такой хвост попадёт в разбор и создаст ложный «ghost»-гейт. В патче выше такого текста нет.

---

## 4. Смежный риск, не решаемый этим патчем: `check-claude-md-paths.mjs`

Второй шаг preflight (строка 100) — `node scripts/check-claude-md-paths.mjs` — отдельно от синхронизации с CI проверяет, что каждое голое имя гейта (`check-foo` / `check-foo.mjs`), упомянутое в `CLAUDE.md`, `Tripix/CLAUDE.md`, `.claude/rules/*.md`, `.claude/agents/*.md`, `.claude/skills/*/SKILL.md` и **`docs/decisions/*.md`**, резолвится в отслеживаемый `scripts/check-foo.{sh,mjs}`.

После удаления `scripts/check-collab-config.mjs` в репозитории остаются **два** голых упоминания `check-collab-config.mjs`, которые эта проверка пометит как «гейт переименован или удалён»:

- `CLAUDE.md:111` — таблица гейтов; правка есть в `CLAUDE.md.patch.md`.
- `docs/decisions/0011-multi-agent-collaboration-layer.md:40,51` — то самое ADR, которое по заданию **не переписывается** (только шапка, см. `0011.header-note.md`).

Первое патчем решено. Второе — нет: `check-claude-md-paths.mjs` не отличает свежую инструкцию от замороженного исторического решения, и в скрипте нет механизма исключения по образцу `preflight-exclude`. Если ничего не сделать, preflight (и CI, тем же гейтом) станет красным на самом ADR-0011 сразу после того, как раннер удалит `scripts/check-collab-config.mjs`. Решение — за владельцем, до коммита Ф5:

- либо точечное исключение в `check-claude-md-paths.mjs` для `docs/decisions/*.md` (как `LOCAL_ONLY`, но для «упомянутый факт, а не текущая ссылка»),
- либо разовая мелкая правка двух голых упоминаний в 0011 — это имя гейта в скобках, а не текст решения, но задание прямо просило ADR не трогать, так что и это требует явного «да» владельца.
