# review-rounds.jq — была ли эскалация «вопроса формы» после двух раундов ревью с настоящими находками.
#
# Зачем. Правило оркестрации («Как решать», п. 3): два раунда ревью подряд с настоящими находками в
# одном механизме значат, что архитектурное решение принято на слишком низком уровне. Дальше —
# не следующая находка, а вопрос формы сильной модели или challenger'у. 17.09 (этап 4d) и 18.09
# (этап B Story Export) раунды шли дальше без этого. verifier (пункт «Маршрутизация») проверяет это
# этим фильтром, а не на слово ведущей.
#
# Запуск (оба read-only хука verifier пропускают):
#   collab reviews --task <id> --json | jq -f <kit>/agents/review-rounds.jq
#
# Определения:
# - раунд «настоящий», если в нём есть ревью `changes_requested` с доказанной находкой
#   (`confidence` не `hypothesis`) уровня `blocker` / `critical` / `major`;
# - «механизм» = задача: у одной задачи один механизм, раунды считаются внутри неё;
# - эскалация — ревью слота `challenger` или `architecture`, запрошенное и отвеченное (не pending,
#   не released) после второго настоящего раунда подряд. Следующее обычное ревью задачи допустимо только после
#   такого ответа. После пары счёт начинается заново: следующая пара — два новых настоящих раунда подряд.
# - отменить повторную эскалацию может только владелец — решением в журнале задачи; фильтр его не читает,
#   это сверяет verifier (fail здесь + решение владельца → не FAIL).
# Не проверяется: доклад владельцу с ценой вариантов — только факт эскалации.

def real_finding: (.confidence // "") != "hypothesis" and ((.severity // "") | IN("blocker", "critical", "major"));
def escalation: (.slot // "") | IN("challenger", "architecture");
def answered: (.verdict // "pending") | IN("pending", "released") | not;

(if type == "array" then . else [] end) as $all
| [ $all[] | select((.verdict // "") != "released") ] as $reviews
| [ $reviews[] | select(escalation | not) ] as $ordinary
| ( $ordinary | group_by(.round) | map({
      round: .[0].round,
      real: any(.[]; .verdict == "changes_requested" and any((.findings // [])[]; real_finding)),
      proven_major: ([ .[] | (.findings // [])[] | select(real_finding) ] | length),
      verdicts: map(.verdict),
      last_submitted: ([ .[] | .submitted_at // empty ] | max)
    }) | sort_by(.round) ) as $rounds
| [ $reviews[] | select(escalation) | {id, slot, verdict, created_at, submitted_at: (.submitted_at // null)} ] as $esc
# Пары настоящих раундов подряд — все, не только первая. После пары счёт начинается заново: раунды до
# эскалации не образуют пару с раундами после неё. Для каждой пары следующее обычное ревью допустимо
# только после эскалации, запрошенной и отвеченной после этой пары.
| ( reduce $rounds[] as $r ({streak: 0, prev: null, pairs: []};
      (if $r.real and .prev != null and $r.round == .prev + 1 and .streak >= 1 then .streak + 1
       elif $r.real then 1 else 0 end) as $streak
      | if $streak >= 2 then
          ($r.last_submitted // "") as $since
          | ([ $ordinary[] | select(.round > $r.round) ] | sort_by(.created_at) | first) as $next
          | ([ $esc[] | select(answered and (.created_at // "") > $since and (.submitted_at // "") > $since) ]
             | sort_by(.submitted_at) | first) as $ans
          | .pairs += [{second: $r.round, next: $next, escalation: $ans,
                        state: (if $next == null then (if $ans != null then "ok" else "due" end)
                                elif $ans != null and $ans.submitted_at < $next.created_at then "ok"
                                else "fail" end)}]
          | .streak = 0
        else .streak = $streak end
      | .prev = $r.round) | .pairs ) as $pairs
| ([ $pairs[] | select(.state == "fail") ] | first) as $failed
| ([ $pairs[] | select(.state == "due") ] | last) as $due
| {
    rounds: $rounds,
    pairs: [ $pairs[] | {second_real_round: .second, state, next_round: (.next.round // null), escalation: (.escalation.id // null)} ],
    second_real_round: ($pairs | first | .second // null),
    escalations: $esc,
    next_ordinary_review: (($failed // $due // ($pairs | first) // {}) | .next | if . == null then null else {id, round, created_at, verdict} end),
    checks: {
      escalation:
        (if ($reviews | length) == 0 then "n/a: ревью нет"
         elif ($pairs | length) == 0 then "ok: двух настоящих раундов подряд нет"
         elif $failed != null then "fail: раунд \($failed.next.round) запрошен после двух настоящих раундов (\($failed.second - 1), \($failed.second)) без эскалации вопроса формы"
         elif $due != null then "due: раунды \($due.second - 1) и \($due.second) с доказанными находками — до следующего ревью нужна эскалация (challenger / architecture)"
         else "ok: эскалация после раунда \([ $pairs[].second | tostring ] | join(", "))" end)
    }
  }
