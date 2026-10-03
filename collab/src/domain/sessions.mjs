// The stretches of work on a task: who held it, from which session, from when to when (`task.sessions[]`).
//
// A stretch ends when the task loses its owner — released, handed over, swept after a lapsed lease, put back by the
// owner — because the next claim is then a NEW stretch, and what the session did between the two is not this task's.
// It does NOT end in review or changes_requested: the author goes on there without claiming again. Entries written
// before `to` existed have none, and are read as before: up to the next entry, or to the end of the task.

// For a put that takes the owner away: `{ ...task, ...closed(task, at) }`. A task that never recorded a session gets
// nothing added, so old tasks are not rewritten.
export function closed(task, at) {
  const sessions = task.sessions
  if (!Array.isArray(sessions) || !sessions.length) return {}
  const last = sessions[sessions.length - 1]
  if (last.to) return {}
  return { sessions: [...sessions.slice(0, -1), { ...last, to: at }] }
}
