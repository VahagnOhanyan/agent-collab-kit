// The panel answers with `style-src 'self'`: an inline style (a `style` attribute, however it was set) is dropped by the
// browser WITHOUT an error, and nothing in a test that does not open a page would notice. The indented tree of tasks
// lost its indentation exactly that way (04.10.2026) while every test passed. What the panel script must do instead is
// use classes the stylesheet defines — and this checks both halves.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')
const script = readFileSync(join(PUBLIC, 'app.js'), 'utf8')
const sheet = readFileSync(join(PUBLIC, 'style.css'), 'utf8')

test('the panel script sets no inline style, which its CSP drops without a word', () => {
  assert.doesNotMatch(script, /\bstyle\s*:\s*[`'"]/, 'a `style:` property given to el() becomes a style attribute')
  assert.doesNotMatch(script, /setAttribute\(\s*['"]style['"]/, 'setAttribute("style", …) is an inline style')
  assert.doesNotMatch(script, /\.style\.cssText\s*=/, 'cssText is an inline style too')
})

test('every tree depth class the script can produce is defined by the stylesheet', () => {
  assert.match(script, /tree-\$\{Math\.min\(depthOf\.get\(t\.id\), (\d+)\)\}/, 'the tree classes are built from a capped depth')
  const cap = Number(/tree-\$\{Math\.min\(depthOf\.get\(t\.id\), (\d+)\)\}/.exec(script)[1])
  for (let depth = 1; depth <= cap; depth += 1) assert.match(sheet, new RegExp(`\\.tree-${depth}\\s*\\{[^}]*margin-left`), `.tree-${depth} has no margin-left in style.css`)
  assert.match(sheet, new RegExp(`\\.tree-2\\s*\\{[^}]*margin-left:\\s*[1-9]`), 'the second level is actually pushed in')
})
