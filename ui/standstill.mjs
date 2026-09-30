// Why an unfinished task is still unfinished, gathered from the places that hold
// the answer: the status, blocked_reason, the reviews, the owner's approval
// requests and the completion gates. It is computed on every read and never
// stored: a stored reason goes stale the moment one of its sources changes.
//
// Pure on purpose (no api, no clock beyond what the approvals already carry), so
// each branch is tested without a journal.

import { uxGateProblem } from '../collab/src/domain/spec.mjs'

const TERMINAL = new Set(['completed', 'cancelled'])
const SEVERITY_ORDER = ['blocker', 'critical', 'major', 'minor', 'nit']

const ofTask = (list, task) => (list || []).filter((item) => item.task_id === task.id)

function latestSubmitted(reviews) {
  return reviews
    .filter((r) => r.submitted_at)
    .sort((a, b) => String(a.submitted_at).localeCompare(String(b.submitted_at)))
    .at(-1)
}

function findingsSummary(review) {
  const counts = {}
  for (const f of review.findings || []) {
    const key = f.severity || 'без оценки'
    counts[key] = (counts[key] || 0) + 1
  }
  const known = SEVERITY_ORDER.filter((s) => counts[s]).map((s) => `${s} ${counts[s]}`)
  const rest = Object.keys(counts).filter((s) => !SEVERITY_ORDER.includes(s)).map((s) => `${s} ${counts[s]}`)
  return [...known, ...rest].join(', ')
}

// `reviews` and `approvals` may be the whole journal's lists: only this task's are read.
export function standstillOf(task, { reviews = [], approvals = [] } = {}) {
  if (TERMINAL.has(task.status)) return null

  const myReviews = ofTask(reviews, task)
  const myApprovals = ofTask(approvals, task).filter((a) => a.status === 'pending')
  const obstacles = []
  const uxProblem = uxGateProblem(task, myReviews)
  if (uxProblem) obstacles.push(uxProblem)

  const result = (code, detail) => ({ code, detail, obstacles })

  switch (task.status) {
    case 'blocked':
      return result('blocked', task.blocked_reason ? String(task.blocked_reason) : 'причина блокировки не записана')

    case 'waiting_for_user': {
      const live = myApprovals.filter((a) => !a.expired)
      if (live.length) return result('awaiting_approval', `ждёт вашего ответа: ${live.map((a) => `${a.id} (${a.action || 'действие не указано'})`).join('; ')}`)
      if (myApprovals.length) return result('approval_expired', `запрос одобрения просрочен: ${myApprovals.map((a) => a.id).join(', ')} — нужен новый`)
      return result('awaiting_approval', task.waiting_on ? String(task.waiting_on) : 'ответ владельца ожидается, но запрос одобрения не найден')
    }

    case 'changes_requested': {
      const latest = latestSubmitted(myReviews)
      // A later round may have approved while the status never came back: the
      // findings of an older round are then not what holds the task.
      if (latest && latest.verdict === 'approved') {
        return result('review_changes', `последнее ревью ${latest.id} одобрило, но статус не возвращён из «нужны правки» — вероятно, работа сделана, задачу не закрыли`)
      }
      const review = latestSubmitted(myReviews.filter((r) => r.verdict === 'changes_requested'))
      const found = review ? `замечаний ревью ${review.id}: ${findingsSummary(review) || 'без деталей'}` : 'ревью вернуло задачу с правками'
      return result('review_changes', `${found}. Прямо закрыть нельзя: сначала вернуть в работу (для рискованного класса это новое одобрение)`)
    }

    case 'approved': {
      if (uxProblem) return result('ux_gate', uxProblem)
      if (myApprovals.length) return result('awaiting_approval', `ревью пройдено, но ждёт ответа владельца: ${myApprovals.map((a) => a.id).join(', ')}`)
      return result('ready_to_complete', 'ревью пройдено, ничто не мешает закрыть — задачу просто не завершили')
    }

    case 'review': {
      const pending = myReviews.filter((r) => !r.submitted_at)
      return result('in_review', pending.length ? `ждёт вердикта: ${pending.map((r) => `${r.id} (${r.requested_role || r.slot || 'ревьюер'})`).join(', ')}` : 'ревью запрошено, открытых заявок не видно')
    }

    case 'in_progress':
      return result('in_work', uxProblem ? `в работе; до закрытия: ${uxProblem}` : task.needs_review ? 'в работе; до закрытия нужно ревью' : 'в работе')

    case 'waiting_for_agent':
      return result('waiting_agent', task.waiting_on ? String(task.waiting_on) : 'ждёт другого агента')

    default:
      return result('not_started', task.owner ? `назначена ${task.owner}, работа не начата` : 'не взята никем')
  }
}
