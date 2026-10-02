// ⛔ Only an agent holding a READ-ONLY role reviews (owner, 02.10.2026). Such a role is held only by an agent whose
// catalog entry names a launch that cannot write, and the facts take it away otherwise (probe.mjs). Every way a review
// reaches an agent asks this one question: a request by role, by name or by capability, a hand-over when the reviewer
// left, and the answer itself (a review pending since before the agent lost the role).
//
// Asked for a read-only role → that role; otherwise → any read-only role. A suspended role does not count
// (registry.hasRole). A configuration with no read-only role at all lets NOBODY review: failing open there would let a
// project that replaced the roles route a review to an agent no launch keeps from writing.
// The journal still cannot see HOW the answering session was launched — that is the review skill's job, and a limit.

export function readOnlyRoles(config) {
  return Object.entries(config?.roles?.roles || {}).filter(([, role]) => role.read_only === true).map(([id]) => id)
}

export function holdsReviewerRole(ctx, agentId, role) {
  const readOnly = readOnlyRoles(ctx.config)
  if (!ctx.registry.has(agentId)) return false
  if (role && readOnly.includes(role)) return ctx.registry.hasRole(agentId, role)
  return readOnly.some((r) => ctx.registry.hasRole(agentId, r))
}
