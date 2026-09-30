// Whether a composition leaves every kind of work somebody to check it.
//
// A role that does work names the roles that check it (`reviewed_by` in
// roles.json). For every agent holding such a role, another agent must hold
// each of its reviewing roles: the per-task rule "the author never reviews its
// own task" can only be kept when somebody else is there to review. The check
// looks at the composition — who holds what — before anything is written, so
// the panel and `collab setup` refuse a composition that could only ever answer
// "no reviewer but the author".
//
// With one vendor there is no second model family to lean on, and the same
// agent reviewing in a separate session on a different, not weaker model is the
// accepted answer (see reviews.mjs) — when that agent holds the reviewing role.
// Those gaps are NOTES then; a reviewing role nobody holds is always a problem.

const holders = (agents, role) => agents.filter((agent) => (agent.roles || []).includes(role))

export function independenceReport({ agents = [], roleDefs = {} }) {
  // An agent that names no provider counts as a vendor of its own: an unknown family must never make a gap look
  // like the accepted one-vendor case. A fresh object per such agent cannot collide with any provider string.
  const providers = new Set(agents.map((agent) => agent.provider || {}))
  const singleVendor = agents.length <= 1 || providers.size <= 1
  const problems = []
  const notes = []
  for (const [role, definition] of Object.entries(roleDefs)) {
    for (const author of holders(agents, role)) {
      for (const reviewerRole of definition.reviewed_by || []) {
        if (holders(agents, reviewerRole).some((other) => other.id !== author.id)) {
          // Another agent will review — but of the same vendor, it is no second model family: a note, and the review
          // itself asks for a different, not weaker model (reviews.mjs).
          if (singleVendor) {
            notes.push({ role, author: author.id, reviewer_role: reviewerRole, only_the_author: false, same_vendor: true, message: `${role} work done by ${author.id} is reviewed as ${reviewerRole} by another agent of the same vendor` })
          }
          continue
        }
        const gap = {
          role,
          author: author.id,
          reviewer_role: reviewerRole,
          // Nobody else holds the reviewing role: either the author alone does, or nobody at all.
          only_the_author: (author.roles || []).includes(reviewerRole),
          message: `${role} work done by ${author.id} can only be reviewed as ${reviewerRole} by ${
            (author.roles || []).includes(reviewerRole) ? `${author.id} itself` : 'nobody'
          }`
        }
        // One vendor is answered by the author reviewing on a different, not weaker model — which needs the author
        // to HOLD the reviewing role (reviews.mjs routes by role). Nobody holding it is a problem with any vendors.
        ;(singleVendor && gap.only_the_author ? notes : problems).push(gap)
      }
    }
  }
  return { single_vendor: singleVendor, problems, notes }
}
