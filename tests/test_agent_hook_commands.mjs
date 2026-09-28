// Точная строка хука из frontmatter agents/*.md, запущенная через `sh -c`, как её запускает хост.
// Проверяется, что граница закрыта при любом сбое запуска: нет node, нет лаунчера — код 2.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const skip = process.platform === 'win32' ? 'на Windows хост запускает команду не через /bin/sh — проверяется вручную' : false;

function frontmatter(agent) {
  const text = readFileSync(join(ROOT, 'agents', `${agent}.md`), 'utf8');
  const front = text.split('---')[1];
  const m = front.match(/^\s*command:\s*(".*")\s*$/m);
  assert.ok(m, `${agent}: нет строки command`);
  return { front, body: text.split('---').slice(2).join('---'), command: JSON.parse(m[1]) };
}

function withHome(body, { link = true } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-cmd-')));
  try {
    const home = join(base, 'home');
    mkdirSync(join(home, '.agent-kit'), { recursive: true });
    if (link) symlinkSync(ROOT, join(home, '.agent-kit', 'current'));
    return body(home, base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function sh(command, stdin, home) {
  const input = typeof stdin === 'string' ? stdin : JSON.stringify(stdin);
  const nodeDir = dirname(process.execPath);
  return spawnSync('/bin/sh', ['-c', command], { input, env: { HOME: home, PATH: `${nodeDir}:/usr/bin:/bin` }, encoding: 'utf8', timeout: 25_000 }).status;
}

const bash = (command, tool = 'Bash') => ({ tool_name: tool, tool_input: { command }, cwd: '/' });

for (const [agent, hook, matcher] of [['verifier', 'readonly-guard', 'Bash'], ['implementer', 'scope-guard', 'Edit|Write|NotebookEdit']]) {
  test(`${agent}: строка хука — node + лаунчер, без python, с || exit 2 и таймаутом больше сторожа`, () => {
    const { front, command } = frontmatter(agent);
    assert.ok(command.includes(`node "$HOME/.agent-kit/current/bin/agent-kit-hook" ${hook}`), command);
    assert.doesNotMatch(command, /python/);
    assert.ok(command.trimEnd().endsWith('|| exit 2'), command);
    assert.ok(front.includes(`matcher: "${matcher}"`));
    assert.ok(Number(front.match(/timeout:\s*(\d+)/)[1]) >= 10, 'лаунчер ждёт stdin 4 с + сторож хука 5 с');
  });

  test(`${agent}: нет node или нет лаунчера — блок`, { skip }, () => {
    const { command } = frontmatter(agent);
    const event = agent === 'verifier' ? bash('git status') : { tool_name: 'Edit', tool_input: { file_path: '/x/y' }, cwd: '/' };
    withHome((home, base) => {
      assert.equal(sh(command.replace(/\bnode /, `${join(base, 'no-such-dir', 'node')} `), event, home), 2);
    });
    withHome((home) => assert.equal(sh(command, event, home), 2), { link: false });
  });
}

test('verifier: строка хука через sh различает разрешённое и запрещённое', { skip }, () => {
  const { command } = frontmatter('verifier');
  withHome((home) => {
    assert.equal(sh(command, bash('git status'), home), 0);
    assert.equal(sh(command, bash('rm -rf build'), home), 2);
    assert.equal(sh(command, bash('git -c alias.x=commit x'), home), 2);
    assert.equal(sh(command, 'not json', home), 2);
    assert.equal(sh(command, bash('git status', 'Edit'), home), 2);
  });
});

test('verifier: тело объясняет allowlist и эскалацию', () => {
  const { front, body } = frontmatter('verifier');
  assert.match(front, /disallowedTools:.*\bEdit\b.*\bWrite\b/);
  assert.ok(body.includes('не проверено'));
  assert.ok(body.toLowerCase().includes('allowlist'));
  for (const fragment of ['git status', 'node --test', 'python3 -m unittest', 'xcodebuild', 'xcrun simctl list']) assert.ok(body.includes(fragment), fragment);
});
