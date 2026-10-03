// The developer guide is one static page of the kit (ui/public/guide.html), read before the kit is installed and
// served by the panel afterwards. These tests keep it a page that works: every contents link has its section, the
// panel serves it without a token, and nothing in it needs more than the panel's own CSP allows.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const HTML = read('ui/public/guide.html')

test('every contents link points at a section that is there, and every section is in the contents', () => {
  const ids = new Set([...HTML.matchAll(/<section id="([^"]+)"/g)].map((m) => m[1]))
  const links = [...HTML.matchAll(/<nav class="toc"[\s\S]*?<\/nav>/g)][0][0].match(/href="#([^"]+)"/g).map((h) => h.slice(7, -1))
  assert.ok(ids.size >= 17, `the guide has its sections (${ids.size})`)
  for (const link of links) assert.ok(ids.has(link), `contents link #${link} has no section`)
  for (const id of ids) assert.ok(links.includes(id), `section #${id} is not in the contents`)
})

test('the page asks nothing of the panel but its own files: no inline style or script, no remote resources', () => {
  assert.doesNotMatch(HTML, /<style[\s>]/i, 'a <style> block would be refused by the CSP')
  assert.doesNotMatch(HTML, /\sstyle\s*=/i, 'a style attribute would be refused by the CSP')
  assert.doesNotMatch(HTML, /<script[\s>]/i)
  assert.doesNotMatch(HTML, /(?:src|href)="https?:\/\/(?!claude\.ai\/artifact\/)/i, 'only the Docs copy is linked out')
  assert.match(HTML, /href="style\.css"/, 'relative, so it also opens straight from a clone')
  assert.match(HTML, /href="guide\.css"/)
})

test('the guide names itself as the kit\'s page and the Docs copy as the shared one, and the README says the same', () => {
  const readme = read('README.md')
  assert.match(HTML, /ui\/public\/guide\.html/)
  assert.match(HTML, /claude\.ai\/artifact\/LoJSoenDUJwy7BT4hwXeqi/)
  assert.match(readme, /ui\/public\/guide\.html/)
  assert.match(readme, /claude\.ai\/artifact\/LoJSoenDUJwy7BT4hwXeqi/)
})

test('the panel menu opens the guide page of the kit', () => {
  const index = read('ui/public/index.html')
  assert.match(index, /href="\/guide\.html"/)
})
