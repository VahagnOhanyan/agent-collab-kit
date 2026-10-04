// The theme button: the panel follows the system unless the person picked light or dark. Three things can rot silently —
// the two copies of the light palette drifting apart, the markup and the script disagreeing on ids, and the script's
// own logic — and none of them fails a test that does not open a page, so each is checked here.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')
const sheet = readFileSync(join(PUBLIC, 'style.css'), 'utf8')
const html = readFileSync(join(PUBLIC, 'index.html'), 'utf8')
const source = readFileSync(join(PUBLIC, 'theme.js'), 'utf8')

// The custom properties declared in the first block that follows `selector`.
function tokens(css, selector) {
  const start = css.indexOf(selector)
  assert.ok(start >= 0, `${selector} is in style.css`)
  const open = css.indexOf('{', start)
  const close = css.indexOf('}', open)
  const map = {}
  for (const [, name, value] of css.slice(open + 1, close).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) map[name] = value.trim()
  return map
}

test('the light palette is written twice and both copies are the same list', () => {
  const forced = tokens(sheet, ':root.theme-light {\n  --bg')
  const system = tokens(sheet, ':root:not(.theme-dark) {')
  assert.ok(Object.keys(forced).length >= 15, 'the explicit light block carries the whole palette')
  assert.deepEqual(system, forced, 'a token changed in one copy of the light palette and not in the other')
  const dark = tokens(sheet, ':root {\n  color-scheme')
  assert.deepEqual(Object.keys(dark).filter((k) => k.startsWith('--') && !['--radius', '--radius-sm', '--mono', '--sans'].includes(k)).sort(), Object.keys(forced).sort(), 'dark and light define the same colour tokens')
})

test('an explicit dark choice beats a light system, and an explicit light choice beats a dark one', () => {
  assert.match(sheet, /@media \(prefers-color-scheme: light\)\s*\{\s*:root:not\(\.theme-dark\)/, 'the system-light block steps aside for an explicit dark')
  assert.match(sheet, /:root\.theme-dark\s*\{\s*color-scheme:\s*dark/, 'form controls follow an explicit dark')
  assert.match(sheet, /:root\.theme-light\s*\{\s*color-scheme:\s*light/, 'form controls follow an explicit light')
})

test('the markup carries what the script looks for, and loads it before the first paint', () => {
  const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'))
  assert.match(head, /<script src="\/theme\.js"><\/script>/, 'theme.js is loaded from <head>, so the page does not flash the wrong theme')
  assert.match(html, /id="theme-toggle"/)
  assert.match(html, /id="theme-label"/)
  assert.doesNotMatch(source, /\bstyle\s*[:=]|setAttribute\(\s*['"]style/, 'no inline style: the panel CSP drops it')
})

// A document just big enough for theme.js: a cookie jar, the root's class list, two elements and the listeners.
function page({ cookie = '', failCookieWrite = false } = {}) {
  const classes = new Set()
  const listeners = {}
  const clicks = []
  const jar = new Map()
  for (const pair of cookie.split(';').map((s) => s.trim()).filter(Boolean)) jar.set(pair.split('=')[0], pair)
  const button = { setAttribute: (k, v) => (button[k] = v), addEventListener: (type, fn) => type === 'click' && clicks.push(fn) }
  const label = { textContent: '' }
  const document = {
    get cookie() {
      return [...jar.values()].join('; ')
    },
    set cookie(value) {
      if (failCookieWrite) throw new Error('cookies are off')
      const pair = String(value).split(';')[0].trim()
      jar.set(pair.split('=')[0], pair)
    },
    documentElement: { classList: { add: (c) => classes.add(c), remove: (...cs) => cs.forEach((c) => classes.delete(c)), has: (c) => classes.has(c) } },
    getElementById: (id) => ({ 'theme-toggle': button, 'theme-label': label })[id] || null,
    addEventListener: (type, fn) => (listeners[type] = fn)
  }
  vm.runInNewContext(source, { document })
  return { document, classes, label, button, ready: () => listeners.DOMContentLoaded(), click: () => clicks[0](), cookieValue: () => jar.get('collab-theme') }
}

test('with no choice the page follows the system: no class on <html>', () => {
  const p = page()
  assert.deepEqual([...p.classes], [])
  p.ready()
  assert.equal(p.label.textContent, 'Тема: как в системе')
})

test('a kept choice is applied at load, before anything is painted', () => {
  assert.deepEqual([...page({ cookie: 'collab-theme=dark' }).classes], ['theme-dark'])
  assert.deepEqual([...page({ cookie: 'x=1; collab-theme=light; y=2' }).classes], ['theme-light'])
})

test('the button cycles system, light, dark and keeps each choice', () => {
  const p = page()
  p.ready()
  const seen = []
  for (let i = 0; i < 4; i += 1) {
    p.click()
    seen.push({ classes: [...p.classes], cookie: p.cookieValue(), label: p.label.textContent })
  }
  assert.deepEqual(seen, [
    { classes: ['theme-light'], cookie: 'collab-theme=light', label: 'Тема: светлая' },
    { classes: ['theme-dark'], cookie: 'collab-theme=dark', label: 'Тема: тёмная' },
    { classes: [], cookie: 'collab-theme=auto', label: 'Тема: как в системе' },
    { classes: ['theme-light'], cookie: 'collab-theme=light', label: 'Тема: светлая' }
  ])
  assert.match(p.button['aria-label'], /Нажмите, чтобы сменить/)
})

test('a cookie that is not one of the three words is ignored, and a browser without cookies still switches', () => {
  assert.deepEqual([...page({ cookie: 'collab-theme=evil' }).classes], [])
  assert.deepEqual([...page({ cookie: 'collab-theme=dark;x' }).classes], ['theme-dark'])
  const p = page({ failCookieWrite: true })
  p.ready()
  p.click()
  assert.deepEqual([...p.classes], ['theme-light'], 'the choice holds for this page even if it cannot be kept')
})
