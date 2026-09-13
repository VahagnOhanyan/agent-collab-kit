// The inbox adapter: delivery is that the record exists.
//
// This is not a degraded mode. A file on disk is the delivery mechanism that
// survives both agents having independent session lifetimes, and it is the only
// one that works when the recipient is not running — which, for two humans'
// worth of AI sessions on one laptop, is most of the time.

export function manualAdapter(agentView, adapter) {
  return {
    kind: 'manual',
    describe: () => ({ kind: 'manual', how: 'messages wait in the inbox until the agent session reads them' }),
    probe: () => ({
      reachable: true,
      how: 'inbox',
      note:
        agentView.runtime?.effective_status === 'offline'
          ? 'not seen recently — work queued for it will wait until its session runs'
          : 'seen recently',
      launch_hint: adapter.launch_hint || null
    }),
    deliver: () => ({ delivered: 'queued', detail: 'the message is in the inbox' })
  }
}
