import { request } from 'node:http'

export function get(panel, path, { host, token, headers = {}, method = 'GET' } = {}) {
  const address = panel.server.address()
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1',
      port: address.port,
      path,
      method,
      headers: {
        Host: host || `127.0.0.1:${address.port}`,
        ...(token ? { 'x-panel-token': token } : {}),
        ...headers
      }
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

export const inertApi = () => ({
  status: async () => ({ journal_root: '/tmp/my-app', tasks: {} }),
  doctor: () => ({ agents: [], unheld_roles: [], models: [] }),
  listTasks: async () => [],
  getTask: () => null,
  listReviews: () => [],
  getMessages: async () => [],
  listApprovals: () => [],
  listDecisions: () => [],
  listAgents: () => [],
  listModels: () => [],
  events: () => [],
  config: { agents: {} },
  registry: { roles: () => ({}) },
  store: { paths: { events: '/tmp/my-app/.collab/events.jsonl' } }
})
