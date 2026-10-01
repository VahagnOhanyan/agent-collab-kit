// Команды, которые панель предлагает скопировать в терминал, собираются из id журнала, а журнал пишут агенты.
// app.js — браузерный скрипт без модулей, поэтому функции берутся из его текста.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app.js'), 'utf8')
const fn = (name) => {
  const match = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`).exec(SOURCE)
  assert.ok(match, `${name} is in app.js`)
  return match[0]
}
const { shellArg, commandLine } = new Function(`${fn('shellArg')}\n${fn('commandLine')}\nreturn { shellArg, commandLine }`)()

test('a plain id stays readable; anything else is one shell word', () => {
  assert.equal(shellArg('dec_mulx1_ab'), 'dec_mulx1_ab')
  assert.equal(shellArg('opt-a.1'), 'opt-a.1')
  assert.equal(shellArg("ok; touch /tmp/x"), "'ok; touch /tmp/x'")
  assert.equal(shellArg("it's"), `'it'\\''s'`)
})

test('the pasted command passes the agent-written id as one argument and runs nothing else', { skip: process.platform === 'win32' }, () => {
  for (const hostile of ['ok; echo PWNED', 'ok && echo PWNED', '$(echo PWNED)', '`echo PWNED`', "x'; echo PWNED; '", 'a b']) {
    const line = commandLine(['printf', "'%s\\n'", shellArg(hostile)])
    const out = spawnSync('bash', ['-c', line], { encoding: 'utf8' })
    assert.equal(out.stdout, `${hostile}\n`, line)
  }
})

test('an id with a control character gets no command at all', () => {
  assert.equal(commandLine(['collab', 'decide', shellArg('dec_1'), shellArg('ok\necho PWNED')]), null)
  assert.equal(commandLine(['collab', 'approve', shellArg('apr\u0007')]), null)
  assert.equal(commandLine(['collab', 'approve', shellArg('apr_1')]), 'collab approve apr_1')
})

test('every copyable collab command in the panel goes through shellArg', () => {
  // A new card that interpolates a journal id straight into a command line would reopen the hole.
  assert.doesNotMatch(SOURCE, /`collab [a-z]+ \$\{/)
})

const { unledWithoutCli } = new Function(`${fn('unledWithoutCli')}\nreturn { unledWithoutCli }`)()

test('the wizard warns about a chosen agent the lead cannot start, never about the lead itself', () => {
  const chosen = new Set(['a', 'b', 'c'])
  // b has no command to start it with: warned while it is a subordinate, silent once it leads.
  assert.deepEqual(unledWithoutCli(chosen, 'a', ['a', 'c']), ['b'])
  assert.deepEqual(unledWithoutCli(chosen, 'b', ['a', 'c']), [])
  // A server that does not send `launchable` gives no warning rather than a false one.
  assert.deepEqual(unledWithoutCli(chosen, 'a', undefined), [])
})
