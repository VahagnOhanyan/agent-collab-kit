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
// accepted answer (see reviews.mjs). Those gaps are NOTES then, not problems.

const holders = (agents, role) => agents.filter((agent) => (agent.roles || []).includes(role))

export function independenceReport({ agents = [], roleDefs = {} }) {
  // An agent that names no provider counts as a vendor of its own: an unknown family must never make a gap look
  // like the accepted one-vendor case.
  const providers = new Set(agents.map((agent) => agent.provider || `unknown:${agent.id}`))
  const singleVendor = agents.length <= 1 || providers.size <= 1
  const problems = []
  const notes = []
  for (const [role, definition] of Object.entries(roleDefs)) {
    for (const author of holders(agents, role)) {
      for (const reviewerRole of definition.reviewed_by || []) {
        if (holders(agents, reviewerRole).some((other) => other.id !== author.id)) continue
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
        ;(singleVendor ? notes : problems).push(gap)
      }
    }
  }
  return { single_vendor: singleVendor, problems, notes }
}
