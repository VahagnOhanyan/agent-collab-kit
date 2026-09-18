# routing-audit.jq — что на самом деле делала ведущая сессия Claude Code, по её транскрипту.
#
# Зачем. Правило оркестрации (rules/orchestration.md) требует маршрутную строку до первой правки,
# смету машинного времени до сборок, разведку сверх порога — субагенту, явную модель у каждого
# делегирования. 16.09 и 18.09.2026 правило было загружено весь день и не сработало ни разу:
# правило, которое ничем не принуждается, не выполняется. verifier (пункт «Маршрутизация») не видит
# работу ведущей — он видит план и diff. Этот фильтр даёт ему факты, а не пересказ ведущей.
#
# Запуск (оба read-only хука verifier пропускают jq):
#   jq -s -f <kit>/agents/routing-audit.jq --arg plan <абс. путь плана> \
#      [--arg since <ISO>] [--arg until <ISO>] <транскрипт.jsonl>
# Транскрипт — ~/.claude/projects/<проект>/<session-id>.jsonl, в нём только ведущая сессия
# (субагенты пишутся в <session-id>/subagents/). since / until — границы задачи, если сессия вела
# и другие; без них окно — весь транскрипт (перебор в сторону FAIL, а не PASS).
#
# Порядок событий — по номеру строки и блока в транскрипте, не по времени: два блока одного
# сообщения могут нести одно время. Время — только для длительностей.
#
# Маркер `Маршрут:` засчитывается только из записи ФАЙЛА ПЛАНА (Write/Edit с путём --arg plan), и «вовремя» —
# значит к первому показу плана владельцу (ExitPlanMode), а без показа — в первой записи плана:
# реплика в чате в транскрипте ненадёжна (18.09.2026 записалась блоком thinking в пересказе), а
# маркер в промпте субагенту или в плане прошлой задачи — не маршрут этой задачи. `Смета:` — из
# записи плана или текста реплики.
#
# Что НЕ ловится, честно (verifier пишет это в «не проверено», а не в PASS):
# - правка скриптом (python/node, пишущие файл изнутри), cp/mv — не видна;
#   sed -i, perl -i, `>`/`>>` и tee в файл — видны;
# - путь в Bash через переменную раскрывается, только если она присвоена в той же команде;
#   нераспознанная ссылка ($1, $(…)) даёт строки разведки без файла;
# - порог правила — на подзадачу, фильтр считает по окну задачи целиком;
# - мутации видны только по соглашению правила (`--label mut-<id>`, скрипт `*controls*.sh` /
#   `*mutation*.sh`); чем скрипт проверяет каждую мутацию — не видно (mutation_own_test = unknown);
# - реплика владельца — строка с `origin.kind == "human"`, ответ AskUserQuestion, решение ExitPlanMode;
# - формат транскрипта внутренний у Claude Code: нет ни одного tool_use в окне → format
#   "unrecognized"; результат Read без разбора → recon "unknown".

def arg($k): ($ARGS.named[$k] // "");
def str: if type == "string" then . elif . == null then "" else tojson end;
def epoch: try (sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) catch null;
def mins($a; $b):
  ($a | epoch) as $x | ($b | epoch) as $y
  | if $x == null or $y == null then null else (($y - $x) / 60 * 10 | round / 10) end;
def clip($n): if length > $n then .[0:$n] + "…" else . end;
def outlines: if . == null or . == "" then 0 else (rtrimstr("\n") | split("\n") | length) end;
def oneline: str | gsub("\\s+"; " ") | clip(160);

# Строка-маркер: «Маршрут:» / «Смета:» в начале строки, допускаются маркдаун-обёртки (**, -, >).
def marker($word): test("(^|\\n)[ \\t>*_-]*" + $word + "(\\*\\*)?:"; "i");
# Объявленная в плане разведка силами ведущей: «разведка — ведущая сессия, потому что …».
def recon_declared: test("разведка\\s*[—–|-]+\\s*ведущая сессия"; "i");

def excluded_edit($plan):
  . == $plan
  or test("/\\.claude/plans/") or test("/\\.claude/projects/")
  or test("^/(private/)?tmp/") or test("^/var/folders/") or test("^/dev/");

# Сегменты команды: кавычки сняты, `;` `&` `|` и перевод строки — границы, префиксы env/VAR=/nohup/time сняты.
def run_segments:
  gsub("[\"']"; "")
  | [ splits("[;&|\\n]+") | sub("^[\\s(]+"; "")
      | sub("^((env|command|exec|nohup|time|sudo)\\s+|[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*"; "") ];
# Сегмент запускает сборку или тесты, а не упоминает их (echo, grep, строка в heredoc).
def runner_start: sub("^(bash|sh|zsh)\\s+"; "") | test("^\\S*(\\.sh|xcodebuild|swift|node|npm|pnpm|yarn|npx|pytest|python3?|go|cargo|gradlew?)(\\s|$)");
def is_build: [ run_segments[] | select(runner_start)
                | select(test("xcodebuild|ios-test\\.sh|\\bswift\\s+(build|test)\\b|\\b(npm|pnpm|yarn)\\s+(test|run\\s+(build|test))|\\bnode\\s+--test\\b|\\bpytest\\b|unittest|gradlew?\\s|\\bcargo\\s+(build|test)\\b|\\bgo\\s+test\\b")) ]
              | length > 0;
def is_read_cmd: test("(^|[;&|(]\\s*|\\s)(cat|head|tail|sed|nl|less|more|awk|grep|egrep|fgrep|rg|jq|/usr/bin/grep)\\s");

# Имя файла с известным расширением: отсекает sed-выражения (s/a/b/), ветки (origin/main),
# числа и выражения из шаблонов поиска (json.loads, draft?.id, StoryStatus.DRAFT).
def has_ext: test("(^|[/=:])[A-Za-z0-9_][^/]*\\.(swift|mm?|h|kt|java|m?js|cjs|tsx?|jsx|py|rb|go|rs|sh|zsh|bash|jq|json|jsonl|ya?ml|toml|plist|xml|html?|css|scss|sql|prisma|log|txt|out|output|csv|strings|xcstrings|pbxproj|xcscheme|entitlements|gradle|c|cc|cpp|env|conf|ini|lock|graphql|proto|vue|svelte|md)['\"]?$");

def norm_path($cwd; $home):
  sub("^[A-Za-z_][A-Za-z0-9_]*="; "")
  | gsub("^['\"]+|['\";)]+$"; "")
  | if startswith("~/") then $home + .[1:]
    elif startswith("/") then .
    else ($cwd + "/" + ltrimstr("./")) end;

# NAME=value в той же команде → подставить в $NAME / ${NAME}. Два прохода: F=$P/x.jsonl.
def expand_vars:
  def pass:
    . as $c
    | ([ $c | scan("(?:^|[;&|\\s(])([A-Za-z_][A-Za-z0-9_]*)=([^\\s;&|)]+)")
         | {key: .[0], value: (.[1] | gsub("^['\"]|['\"]$"; ""))} ] | from_entries) as $vars
    | reduce ($vars | to_entries[]) as $v ($c;
        gsub("\\$\\{" + $v.key + "\\}|\\$" + $v.key + "(?![A-Za-z0-9_])"; $v.value));
  pass | pass;

def base_dir($cwd0; $home):
  ([ scan("(?:^|[;&|(]\\s*)cd\\s+([^\\s;&|)]+)") | .[0] ] | first // null) as $cd
  | if $cd == null or ($cd | test("\\$")) then $cwd0 else ($cd | norm_path($cwd0; $home)) end;

def cmd_paths($cwd0; $home):
  base_dir($cwd0; $home) as $cwd
  | [ splits("[\\s|;&()<>`]+")
      | select(length > 0) | select(startswith("-") | not) | select(test("\\$") | not)
      # шаблоны поиска и глоба (ios-test\.sh, run-stage[A-Z]*\.sh, *.md) — не пути к файлам
      | select(test("[\\\\\\[\\]*?{}^|]") | not)
      | select(has_ext) | norm_path($cwd; $home)
      | select(test("^/(dev|usr|bin|sbin|opt/homebrew|System)/") | not)
      | select(endswith("/") | not) ];

# Тело heredoc — данные, не команды: `cat > f <<'EOF' … EOF` пишет f, а строки внутри не исполняются
# (18.09.2026 текст тестов с `ios-test.sh --iterations 20` в heredoc давал ложный FAIL).
def strip_heredocs:
  gsub("<<-?[ \\t]*[\"']?(?<t>[A-Za-z_][A-Za-z0-9_]*)[\"']?[^\\n]*\\n[\\s\\S]*?\\n[ \\t]*\\k<t>[ \\t]*(?=\\n|$)"; "<<HEREDOC");
def str_cmd: str | strip_heredocs;

# Путь не раскрыть: переменная ($1, $(…)) или глоб без кавычек (./*.swift). Такие строки идут в разведку
# без файла. Шаблон поиска (с `\` или в кавычках) — не путь и не глоб.
def unresolved_refs:
  [ splits("[\\s|;&()<>`]+")
    | select(test("\\$")
             or (test("[*?\\[]") and (test("\\\\") | not) and (test("^['\"]|['\"]$") | not))) ]
  | length > 0;

# Правки через Bash: sed -i / perl -i (все файлы команды), `>`/`>>` и tee в файл.
def bash_edit_paths($cwd0; $home):
  base_dir($cwd0; $home) as $cwd
  | . as $c
  | ( (if test("\\bsed\\s+(-[A-Za-z]*i|--in-place)|\\bperl\\s+-[A-Za-z]*i") then cmd_paths($cwd0; $home)[] else empty end),
      ( $c | gsub("'[^']*'"; "''") | gsub("\"[^\"]*\""; "\"\"")
        | ( (scan("(?:^|[^0-9&<>])>>?\\s*([^\\s;&|)]+)") | .[0]),
            (scan("\\btee\\s+(?:-a\\s+)?([^\\s;&|)]+)") | .[0]) )
        | select(test("^&|\\$") | not) | select(length > 0) | norm_path($cwd; $home) ) )
  | select(test("^/dev/") | not);

. as $raw
| arg("plan") as $plan
| arg("since") as $since
| arg("until") as $until
| [ $raw | to_entries[] | select(.value | type == "object") | .value + {_i: .key} ] as $all
| ([ $all[] | select((.cwd | type) == "string") | .cwd ] | first // "") as $cwd0
| ((($cwd0 | capture("^(?<h>/(Users|home)/[^/]+)") | .h)) // "") as $home
| def inwin: (.timestamp | type) == "string"
    and ($since == "" or .timestamp >= $since) and ($until == "" or .timestamp <= $until);

# Все блоки ведущей сессии: ord — порядок в транскрипте.
  [ $all[] | select(.type == "assistant" and .isSidechain != true) | . as $l
    | ((.message.content // []) | if type == "array" then to_entries[] else empty end)
    | .key as $b | .value | select(type == "object")
    | {kind: .type, id: (.id // null), name: (.name // null), input: (.input // {}),
       text: (.text // null | if . == null then null else str end),
       ts: ($l.timestamp // null), ord: ($l._i * 1000 + $b),
       cwd: (if ($l.cwd | type) == "string" then $l.cwd else $cwd0 end),
       win: ($l | inwin)} ] as $blocks
| [ $blocks[] | select(.kind == "tool_use") ] as $uses_all
| [ $uses_all[] | select(.win) ] as $uses
| [ $blocks[] | select(.kind == "text" and .win) ] as $texts

# Результаты по tool_use_id: время, текст вывода, id фоновой задачи.
| def result_text:
    if (.content | type) == "string" then .content
    elif (.content | type) == "array" then [ .content[]? | select(type == "object" and .type == "text") | .text | str ] | join("\n")
    else "" end;
  ( [ $all[] | select(.type == "user") | . as $l
      | (.message.content // []) | if type == "array" then .[] else empty end
      | select(type == "object" and .type == "tool_result")
      | {key: (.tool_use_id | str),
         value: {ts: $l.timestamp, ord: ($l._i * 1000), text: result_text,
                 bg: (if ($l.toolUseResult | type) == "object" then ($l.toolUseResult.backgroundTaskId // null) else null end)}} ]
    | from_entries ) as $results

# Уведомления о завершении фоновых команд: <tool-use-id>…</tool-use-id>, самое раннее время.
| ( [ $all[] | select((.timestamp | type) == "string") | . as $l
      | ( (.content | select(type == "string")),
          ((.message.content // null) | if type == "string" then . elif type == "array" then (.[]? | select(type == "object") | .text | select(type == "string")) else empty end) )
      | select(test("<task-notification>"))
      | scan("<tool-use-id>([^<]+)</tool-use-id>") | .[0]
      | {id: ., ts: $l.timestamp, ord: ($l._i * 1000)} ]
    | group_by(.id) | map({key: .[0].id, value: (sort_by(.ord) | first | {ts, ord})}) | from_entries ) as $done

# Реплики владельца: настоящая реплика (`origin.kind == "human"`; в старых транскриптах без origin —
# строка не из служебного тега), ответ на AskUserQuestion, решение по ExitPlanMode.
| def human_line:
    .type == "user" and .isMeta != true
    and (((.origin | type) == "object" and .origin.kind == "human")
         or (.origin == null and (.message.content | type) == "string" and (.message.content | startswith("<") | not)));
  [ $all[] | select(human_line) | ._i * 1000 ] as $human_ords
| [ $uses_all[] | select(.name == "AskUserQuestion" or .name == "ExitPlanMode") | $results[.id // ""].ord // empty ] as $decision_ords
| ($human_ords + $decision_ords) as $owner_ords

# Правки: инструментами и через Bash. Все — чтобы исключить из разведки; первая вне плана и /tmp —
# точка отсчёта для маршрута.
| def edit_tool: .name == "Edit" or .name == "Write" or .name == "NotebookEdit" or .name == "MultiEdit";
  ( [ $uses_all[] | select(edit_tool) | {path: ((.input.file_path // .input.notebook_path) | str), ts, ord, via: .name, win} ]
    + [ $uses_all[] | select(.name == "Bash") | . as $u
        | ($u.input.command | str_cmd | expand_vars | bash_edit_paths($u.cwd; $home))
        | {path: ., ts: $u.ts, ord: $u.ord, via: "Bash", win: $u.win} ] ) as $edits_all
| [ $edits_all[].path ] as $edited_all
| ([ $edits_all[] | select(.win) | select(.path | excluded_edit($plan) | not) ] | sort_by(.ord) | first) as $first_edit

# Записи файла плана: откуда берутся маршрут, смета и объявление разведки.
| [ $uses_all[] | select(edit_tool and $plan != "" and ((.input.file_path // .input.notebook_path // "") | str) == $plan)
    # только то, что запись оставляет в файле: удалённая строка (old_string) — не маршрут
    | {ord, ts, win, strings: [ .input.content, .input.new_string, (.input.edits // [] | .[]? | .new_string), .input.new_source
                           | select(type == "string") ]} ] as $plan_writes
# Записи плана этого захода: если задано начало (since) и план в нём переписывался — только они;
# иначе все (план могли записать до since).
| ([ $plan_writes[] | select(.win) ] | if length > 0 then . else $plan_writes end) as $pw_scope
| def first_mark(f): [ .[] | . as $w | select(any($w.strings[]; f)) ] | sort_by(.ord) | first;
  ($pw_scope | first_mark(marker("Маршрут"))) as $route
# Смета — только этого захода: запись плана в окне или реплика в окне. Старая смета из прошлой задачи
# той же сессии новую работу не покрывает.
| ([ ([ $plan_writes[] | select(.win) ] | first_mark(marker("Смета")) | select(. != null) | {ord, ts, via: "plan"}),
     ($texts[] | select(.text | marker("Смета")) | {ord, ts, via: "text"}),
     ($uses[] | select(.name == "AskUserQuestion") | select(any(.input | .. | strings; marker("Смета"))) | {ord, ts, via: "question"})
   ] | sort_by(.ord) | first) as $smeta
| ($pw_scope | first_mark(recon_declared)) as $recon_decl
# Якорь «до работы» — сам план, а не первая правка: правку скриптом (python, node) фильтр не видит, а
# запись плана видит всегда. План показан владельцу (ExitPlanMode) — строка должна быть в нём к первому показу;
# без показа — в первой записи плана. Первая видимая правка — дополнительная сверка там, где она видна.
| ($pw_scope | sort_by(.ord) | first) as $pw0
| (if $pw0 == null then null else [ $uses_all[] | select(.name == "ExitPlanMode" and .ord > $pw0.ord) | .ord ] | first end) as $shown_ord
| def in_time($w): $w != null and $pw0 != null
    and (if $shown_ord != null then $w.ord < $shown_ord else $w.ord == $pw0.ord end)
    and ($first_edit == null or $w.ord < $first_edit.ord);
  .

# Разведка: Read + читающие Bash-команды, кроме .md и файлов, которые сессия правила.
| def recon_path: (test("\\.md$") | not) and (. as $p | $edited_all | index([$p]) | not);
  [ $uses[] | select(.name == "Read") | . as $u
    | ($u.input.file_path | str) as $p
    | select($p | recon_path)
    | {paths: [$p], lines: ($results[$u.id // ""].text // null | outlines),
       parsed: ($results[$u.id // ""] != null), ts: $u.ts, via: "Read", cmd: $p} ] as $read_recon
| [ $uses[] | select(.name == "Bash") | . as $u
    | ($u.input.command | str_cmd) as $c
    | select(($c | is_read_cmd) and ($c | is_build | not))
    | ($c | expand_vars) as $x
    | ($x | cmd_paths($u.cwd; $home)) as $all_ps
    | ($all_ps | map(select(recon_path))) as $ps
    # команда в разведку: есть путь-кандидат, или путь не раскрылся вовсе ($1, $(…))
    | select(($ps | length) > 0 or (($all_ps | length) == 0 and ($x | unresolved_refs)))
    | {paths: $ps, lines: ($results[$u.id // ""].text // null | outlines), parsed: true,
       ts: $u.ts, via: "Bash", cmd: ($c | oneline)} ] as $bash_recon
| [ $uses[] | select(.name == "Grep") | . as $u
    | {paths: [], lines: ($results[$u.id // ""].text // null | outlines), parsed: true, ts: $u.ts, via: "Grep",
       cmd: ($u.input.pattern | str | clip(80))} ] as $grep_recon
| ($read_recon + $bash_recon + $grep_recon) as $recon_all
# Файл «прочитан», если один вызов вернул из него от 20 строк; grep-подглядывание — строки, не файл.
| ( [ $recon_all[] | select(.lines >= 20) | .paths[] ] | unique ) as $recon_files
| ( [ $recon_all[].lines ] | add // 0 ) as $recon_lines
| ( [ $read_recon[] | select(.parsed | not) ] | length ) as $unparsed

# Делегирования.
| [ $uses[] | select(.name == "Agent" or .name == "Task")
    | {type: (.input.subagent_type // "general-purpose" | str), model: (.input.model // null),
       description: (.input.description | str), ts} ] as $agents
# Внешние агенты: сегмент команды, который НАЧИНАЕТСЯ с `codex exec` или `agy … -p` (после env,
# VAR=…, nohup, time, command, exec и пути к бинарю), без явной модели. Кавычки убираются до
# разбиения: `|` внутри шаблона pgrep — не граница команды.
| def ext_no_model:
    gsub("'[^']*'"; "''") | gsub("\"[^\"]*\""; "\"\"")
    | [ splits("[;&|\\n]+") | sub("^[\\s(]+"; "")
        | sub("^((env|command|exec|nohup|time|sudo)\\s+|[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*"; "")
        | select(test("\\s(--help|-h|--version)\\b") | not)
        | select((test("^(\\S*/)?codex\\s+exec\\b") and (test("\\s(-m|--model)[\\s=]") | not))
                 or (test("^(\\S*/)?agy\\s") and test("\\s(-p|--print|--prompt)\\b") and (test("\\s--model[\\s=]") | not))) ]
    | length > 0;
  [ $uses[] | select(.name == "Bash") | .input.command | str_cmd | select(ext_no_model) | oneline ] as $external_without_model

# Машинное время: сборки и тесты плюс любая команда ≥ 3 мин, кроме внешних агентов и ожидания —
# иначе обёртка вроде run-stageB-controls.sh прячет часы прогонов (18.09.2026). Порог сметы —
# команда, на которой сумма переваливает 15 мин; потолок этапа — 60 мин.
| def is_wait: test("(^|[;&|(]\\s*|\\s)sleep(\\s|$)|gh\\s+run\\s+watch");
  def is_external: test("(^|[;&|(]\\s*|\\s|/)(codex|agy|claude)(\\s|$)");
  ( [ $uses[] | select(.name == "Bash") | . as $u | ($u.input.command | str_cmd) as $c
      | ($u.input.run_in_background == true or ($results[$u.id // ""].bg // null) != null) as $bg
      | (if $bg then $done[$u.id // ""] else $results[$u.id // ""] end) as $endrec
      | (if $endrec == null then null else mins($u.ts; $endrec.ts) end) as $m
      | select(($c | is_build) or ($m != null and $m >= 3 and ($c | is_wait | not)))
      | {cmd: ($c | oneline), start: $u.ts, ord: $u.ord, end_ord: ($endrec.ord // null), background: $bg,
         kind: (if $c | is_build then "build" elif $c | is_external then "external" else "long" end),
         minutes: $m} ] | sort_by(.ord) ) as $builds
| ([ $builds[] | .minutes // empty ] | add // 0 | . * 10 | round / 10) as $build_minutes
| ([ foreach $builds[] as $b (0; . + ($b.minutes // 0); {b: $b, cum: (. * 10 | round / 10)}) ]) as $cum
| ([ $cum[] | select(.cum > 15) | .b ] | first) as $crossing
| ([ $builds[] | select(.minutes == null) ] | length) as $unmeasured

# Потолок 60 мин: после команды, на которой сумма перевалила 60, следующая машинная команда —
# только после реплики владельца (доклад → его решение).
| ([ $cum[] | select(.cum > 60) ] | first) as $c60
| (if $c60 == null then null else ($c60.b.end_ord // $c60.b.ord) end) as $c60_end
| (if $c60 == null then null else [ $builds[] | select(.ord > $c60_end) ] | first end) as $after60
| (if $after60 == null then 0 else [ $owner_ords[] | select(. > $c60_end and . < $after60.ord) ] | length end) as $owner_between
# Доклад = строка `Смета:` с новой ценой — в реплике, в записи плана или в тексте вопроса AskUserQuestion,
# и после неё ответ владельца (реплика, ответ на вопрос, решение по плану). Реплика или вопрос не про цену
# («а тесты зелёные?», выбор варианта дизайна) — не доклад: так 18.09.2026 работа шла до 410 минут.
| ( [ $texts[] | select(.text | marker("Смета")) | .ord ]
    + [ $plan_writes[] | select(.win) | select(any(.strings[]; marker("Смета"))) | .ord ]
    + [ $uses[] | select(.name == "AskUserQuestion") | select(any(.input | .. | strings; marker("Смета"))) | .ord ]
  ) as $smeta_ords
| ( if $after60 == null then false
    else ([ $smeta_ords[] | select(. > $c60_end and . < $after60.ord) ] | min) as $rep
      | ($rep != null and ([ $owner_ords[] | select(. > $rep and . < $after60.ord) ] | length > 0))
    end ) as $reported

# Мутации и итерации. Цели прогона — имена тест-классов (`FooTests`, `FooTests/testBar`).
# Соглашение правила: мутационный прогон — `--label mut-<id>` или скрипт `*controls*.sh` /
# `*mutation*.sh` с id мутаций аргументами; скрипт без id — полный набор.
| def test_targets: [ splits("\\s+") | select(test("^[A-Z][A-Za-z0-9_]*Tests?(/[A-Za-z0-9_]+)?$")) ];
  def one_test: (length == 1) and (.[0] | test("/"));
  [ $uses[] | select(.name == "Bash") | . as $u | ($u.input.command | str_cmd | run_segments[])
    | select(runner_start and test("--(iterations|repeat)[\\s=]+[0-9]+"))
    | (capture("--(iterations|repeat)[\\s=]+(?<n>[0-9]+)").n | tonumber) as $n
    | select($n > 1)
    | test_targets as $t
    | {n: $n, targets: $t, ok: ($t | one_test), ts: $u.ts, cmd: oneline} ] as $iter_runs
| [ $uses[] | select(.name == "Bash") | . as $u | ($u.input.command | str_cmd | run_segments[])
    | select(runner_start and test("--label[\\s=]+mut-"))
    | (capture("--label[\\s=]+mut-(?<id>[A-Za-z0-9_.-]+)").id) as $id
    | test_targets as $t
    | {id: $id, targets: $t, own_test: ($t | one_test), ts: $u.ts, cmd: oneline} ] as $mut_labeled
| [ $uses[] | select(.name == "Bash") | . as $u | ($u.input.command | str_cmd | run_segments[])
    | sub("^(bash|sh|zsh)\\s+"; "")
    | select(test("^\\S*(controls|mutation|mutations|mutants)[^/\\s]*\\.sh(\\s|$)"))
    | [ splits("\\s+") ] as $tok
    | [ $tok[1:][] | select(test("^([A-Z]+[0-9]+[a-z]?|mut-[A-Za-z0-9_.-]+)$")) ] as $ids
    | {ids: $ids, full: (($ids | length) == 0), ts: $u.ts, cmd: oneline} ] as $mut_wrapped
| ([ $mut_wrapped[] | select(.full) ] | length) as $full_runs
| ([ $mut_labeled[].id, $mut_wrapped[].ids[] ] | group_by(.) | map({id: .[0], runs: length})) as $mut_ids
| (($mut_ids | length) >= 3 and ([ $mut_ids[].runs ] | min) >= 2) as $all_rerun

| ([ $agents[] | select(.model == null and .type != "fork") ] | length) as $no_model
| ([ $agents[] | select(.type == "fork") ] | length) as $forks
| ($uses | length) as $n_uses
| def excerpt($word): [ splits("\\n") | select(marker($word)) ] | first // "" | clip(200);

{
  format: (if $n_uses == 0 then "unrecognized" else "claude-code-jsonl" end),
  window: {since: (if $since == "" then ([ $all[] | select(inwin) ] | first | .timestamp) else $since end),
           until: (if $until == "" then ([ $all[] | select(inwin) ] | last | .timestamp) else $until end),
           plan: $plan, plan_writes: ($plan_writes | length)},
  first_edit: (if $first_edit == null then null else ($first_edit | {path, ts, via}) end),
  plan_shown_to_owner: ($shown_ord != null),
  route_marker: (if $route == null then null
                 else {ts: $route.ts, line: ([ $route.strings[] | excerpt("Маршрут") | select(. != "") ] | first)} end),
  route_said_in_chat: ([ $texts[] | select(.text | marker("Маршрут")) | .ts ] | first),
  smeta_marker: (if $smeta == null then null else ($smeta | {ts, via}) end),
  recon: {files: ($recon_files | length), lines: $recon_lines, unparsed_reads: $unparsed,
          declared_in_plan_in_time: in_time($recon_decl),
          paths: $recon_files,
          heaviest: ($recon_all | sort_by(-.lines) | .[0:10] | map({lines, via, cmd}))},
  agents: {total: ($agents | length), without_model: $no_model, forks: $forks, list: $agents},
  external_without_model: $external_without_model,
  builds: {count: ($builds | length), measured_minutes: $build_minutes, unmeasured: $unmeasured,
           threshold_build: ($crossing | if . == null then null else {cmd, start} end),
           list: ($builds | map(del(.ord, .end_ord)))},
  ceiling: {crossing_60: (if $c60 == null then null else ($c60.b | {cmd, start}) + {cum: $c60.cum} end),
            next_after: (if $after60 == null then null else ($after60 | {cmd, start}) end),
            owner_inputs_between: $owner_between, reported: $reported, owner_inputs_total: ($owner_ords | length)},
  mutations: {iteration_runs: $iter_runs, labeled: $mut_labeled, wrapped: $mut_wrapped,
              ids: $mut_ids, full_set_runs: $full_runs},
  checks: {
    route_in_time:
      (if $plan == "" then "unknown: план не передан (--arg plan)"
       elif $pw0 == null then "unknown: запись плана вне транскрипта — строку «Маршрут:» проверь в файле плана, время не проверено"
       elif $route == null then "fail: в плане нет строки «Маршрут:»"
       elif $shown_ord != null and $route.ord > $shown_ord then "fail: «Маршрут:» дописан в план после показа владельцу"
       elif $shown_ord == null and $route.ord != $pw0.ord then "fail: «Маршрут:» дописан в план позже первой записи"
       elif $first_edit != null and $route.ord > $first_edit.ord then "fail: «Маршрут:» записан в план после первой правки"
       else "ok" end),
    recon_under_threshold:
      (if ($recon_files | length) > 3 or $recon_lines > 500
       then "fail: \($recon_files | length) файлов, \($recon_lines) строк (порог 3 / 500)"
       elif $unparsed > 0 then "unknown: \($unparsed) результатов Read без разбора"
       else "ok" end),
    smeta_before_builds:
      (if $crossing == null and $unmeasured == 0 then "n/a: сборок ≤ 15 мин"
       elif $crossing != null and $smeta != null and $smeta.ord < $crossing.ord then "ok"
       elif $crossing != null then "fail: \($build_minutes) мин машинного времени, сметы до команды, перевалившей 15 мин, нет"
       elif $smeta != null and ($builds | first) != null and $smeta.ord < ($builds | first).ord then "ok"
       else "unknown: \($unmeasured) сборок без измеренной длительности, сметы до них нет" end),
    delegation_models:
      (if $no_model > 0 or ($external_without_model | length) > 0
       then "fail: делегирование без явной модели" else "ok" end),
    forks:
      (if $forks == 0 then "n/a" else "declare: \($forks) fork — работа на модели ведущей; нужна строка в «Назначениях»" end),
    ceiling_60:
      (if $c60 == null then "n/a: машинного времени ≤ 60 мин"
       elif $after60 == null then "ok: после 60 мин машинных команд не было"
       elif $reported then "ok: после 60 мин доклад и решение владельца до продолжения"
       elif $owner_between > 0 then "fail: после \($c60.cum) мин владелец отвечал, но доклада с ценой (строки `Смета:`) не было: \($after60.cmd)"
       else "fail: после \($c60.cum) мин машинного времени продолжено без доклада владельцу: \($after60.cmd)" end),
    mutation_iterations:
      ([ $iter_runs[] | select((.ok | not) and (.targets | length) > 0) ] as $bad
       | [ $iter_runs[] | select((.targets | length) == 0) ] as $blind
       | if ($iter_runs | length) == 0 then "n/a"
         elif ($bad | length) > 0 then "fail: \($bad | length) прогонов с --iterations на целом классе или нескольких целях (итерации — только на один тест Класс/тест)"
         elif ($blind | length) > 0 then "unknown: \($blind | length) прогонов с --iterations без распознанной цели"
         else "ok" end),
    mutation_full_set:
      (if $full_runs == 0 and ($mut_ids | length) == 0 then "n/a: мутационных прогонов по соглашению нет"
       elif $full_runs > 1 then "fail: полный набор мутаций прогнан \($full_runs) раз (допустимо один раз за этап)"
       elif $all_rerun then "fail: все \($mut_ids | length) мутаций перегнаны повторно — это второй полный набор"
       else "ok" end),
    mutation_own_test:
      # цель не распознана (класс назван не по шаблону …Tests) — это «не видно», а не нарушение
      ([ $mut_labeled[] | select((.own_test | not) and (.targets | length) > 0) | .id ] as $bad
       | [ $mut_labeled[] | select((.targets | length) == 0) | .id ] as $blind
       | if ($mut_labeled | length) == 0 and ($mut_wrapped | length) == 0 then "n/a"
         elif ($bad | length) > 0 then "fail: мутация не своим тестом (не один Класс/тест): \($bad | unique | join(", "))"
         elif ($blind | length) > 0 then "unknown: цель мутации не распознана (\($blind | unique | join(", "))) — сверь с планом"
         elif ($mut_wrapped | length) > 0 then "unknown: мутации через скрипт — чем проверяется каждая, фильтр не видит"
         else "ok" end)
  }
}
