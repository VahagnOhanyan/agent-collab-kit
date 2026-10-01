// Тесты hooks/model-guard.mjs через лаунчер bin/agent-collab-kit-hook — так же, как его запускает хост.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const LAUNCHER = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agent-collab-kit-hook');

function run(input, name = 'model-guard') {
  const proc = spawnSync(process.execPath, [LAUNCHER, name], { input, encoding: 'utf8', timeout: 30_000 });
  return { code: proc.status, err: proc.stderr };
}
const agent = (toolInput) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: toolInput });

test('вызов Agent без model блокируется', () => {
  for (const toolInput of [{}, { prompt: 'x' }, { model: '' }, { model: '   ' }, { model: 5 }, { model: null }]) {
    const { code, err } = run(agent(toolInput));
    assert.equal(code, 2, JSON.stringify(toolInput));
    assert.match(err, /model-guard: вызов Agent без явной `model`/);
  }
});

test('явная model и fork проходят', () => {
  for (const toolInput of [{ model: 'haiku' }, { model: 'opus', prompt: 'x' }, { subagent_type: 'fork' }, { subagent_type: 'fork', model: '' }]) {
    assert.equal(run(agent(toolInput)).code, 0, JSON.stringify(toolInput));
  }
});

test('мусор на входе — fail-open, tool_input не объект — пропуск', () => {
  for (const input of ['', 'not json', '[]', '{}', JSON.stringify({ tool_input: 'x' }), JSON.stringify({ tool_input: [] })]) {
    assert.equal(run(input).code, 0, JSON.stringify(input));
  }
});

test('лаунчер: неизвестное или сломанное имя хука блокирует, а не пропускает', () => {
  for (const name of ['no-such-hook', '../x', 'Model-Guard', '']) {
    const { code, err } = run(agent({}), name);
    assert.equal(code, 2, name);
    assert.match(err, /agent-collab-kit-hook:/);
  }
});
