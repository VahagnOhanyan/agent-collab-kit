// Тесты hooks/context-watch.mjs — сторожа контекста ведущей сессии. Запуск — как у хоста, через
// bin/agent-collab-kit-hook; лог сессии — настоящий JSONL с ответами модели и записями сжатия, лежащий там, где его
// кладёт Claude Code (`<каталог конфига>/projects/<проект>/<сессия>.jsonl`); HOME — временный.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_LIMIT, LARGE_LIMIT, limitFor, median, scan } from '../hooks/context-watch.mjs';

const LAUNCHER = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agent-collab-kit-hook');

const answer = (used, { model = 'claude-test-1', sidechain = false } = {}) => JSON.stringify({
  type: 'assistant',
  isSidechain: sidechain,
  message: { model, usage: { input_tokens: 2, cache_read_input_tokens: used - 102, cache_creation_input_tokens: 100, output_tokens: 50 } },
});
let compactionId = 0;
const compaction = (pre, trigger = 'auto') => JSON.stringify({
  type: 'system', subtype: 'compact_boundary', uuid: `c-${(compactionId += 1)}`, compactMetadata: { trigger, preTokens: pre },
});

function world() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'context-watch-')));
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  const logs = {};
  const logOf = (account, session) => {
    const file = join(home, account, 'projects', '-demo', `${session}.jsonl`);
    logs[file] ??= [];
    return file;
  };
  const write = (file, line) => {
    mkdirSync(dirname(file), { recursive: true });
    logs[file].push(line);
    writeFileSync(file, logs[file].join('\n') + '\n');
  };
  const at = (account = '.claude', session = 'session-1') => {
    const file = logOf(account, session);
    return {
      turn: (used, opts) => write(file, answer(used, opts)),
      compacted: (pre, trigger) => write(file, compaction(pre, trigger)),
      run: (event = 'UserPromptSubmit') => {
        const input = JSON.stringify({ hook_event_name: event, session_id: session, transcript_path: file, cwd: base });
        const env = { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' };
        const proc = spawnSync(process.execPath, [LAUNCHER, 'context-watch'], { input, env, encoding: 'utf8', timeout: 30_000 });
        assert.equal(proc.status, 0, proc.stderr);
        return proc.stdout.trim() ? JSON.parse(proc.stdout).hookSpecificOutput : null;
      },
    };
  };
  const settings = (value) => {
    mkdirSync(join(home, '.agent-collab-kit'), { recursive: true });
    writeFileSync(join(home, '.agent-collab-kit', 'context-watch.json'), JSON.stringify(value));
  };
  const learned = () => {
    const file = join(home, '.agent-collab-kit', 'state', 'context-watch', 'limits.json');
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  };
  return { home, at, settings, learned, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function scenario(name, body) {
  test(name, async () => {
    const w = world();
    try {
      await body(w);
    } finally {
      w.cleanup();
    }
  });
}

// По умолчанию 100 % — 167 000: 70 % = 116 900, 85 % = 141 950.

scenario('ниже порога — молчит', (w) => {
  const s = w.at();
  s.turn(100_000);
  assert.equal(s.run(), null);
});

scenario('на 70 % — одна подсказка, повторно — молчит', (w) => {
  const s = w.at();
  s.turn(117_000);
  const first = s.run();
  assert.equal(first.hookEventName, 'UserPromptSubmit');
  assert.match(first.additionalContext, /заполнен на 70 %/);
  assert.match(first.additionalContext, /handoff/);
  s.turn(120_000);
  assert.equal(s.run(), null, 'тот же порог второй раз не срабатывает');
});

scenario('на 85 % — вторая подсказка, настойчивее; событие PostToolUse', (w) => {
  const s = w.at();
  s.turn(117_000);
  s.run();
  s.turn(143_000);
  const second = s.run('PostToolUse');
  assert.equal(second.hookEventName, 'PostToolUse');
  assert.match(second.additionalContext, /заполнен на 85 %/);
  assert.match(second.additionalContext, /Не начинай новый крупный шаг/);
});

scenario('перепрыгнув оба порога сразу — одна подсказка, настойчивая', (w) => {
  const s = w.at();
  s.turn(150_000);
  assert.match(s.run().additionalContext, /Не начинай новый крупный шаг/);
  s.turn(155_000);
  assert.equal(s.run(), null);
});

scenario('сессия выше точки окна в 200 000 считается миллионной', (w) => {
  const s = w.at();
  s.turn(300_000); // больше 167 000 — значит, окно больше: 300 000 из 967 000 = 31 %
  assert.equal(s.run(), null);
});

scenario('учится на автосжатиях своей пары «аккаунт + модель»: медиана, выброс не сдвигает', (w) => {
  const s = w.at('.claude', 'learn');
  for (const pre of [960_000, 300_000, 970_000]) {
    s.turn(pre - 1000, { model: 'claude-big' });
    s.compacted(pre);
  }
  s.turn(10_000, { model: 'claude-big' });
  assert.equal(s.run(), null);
  assert.deepEqual(w.learned()['.claude']['claude-big'].samples.map((x) => x.pre), [960_000, 300_000, 970_000]);
  // Медиана 960 000: 117 000 — это 12 %, без подсказки, хотя по умолчанию было бы 70 %.
  const fresh = w.at('.claude', 'next');
  fresh.turn(117_000, { model: 'claude-big' });
  assert.equal(fresh.run(), null);
  fresh.turn(680_000, { model: 'claude-big' });
  assert.match(fresh.run().additionalContext, /заполнен на 70 %/);
});

scenario('выученное одного аккаунта не переносится на другой', (w) => {
  const a = w.at('.claude', 'a');
  a.turn(965_000, { model: 'claude-big' });
  a.compacted(967_000);
  a.turn(5_000, { model: 'claude-big' });
  a.run();
  const b = w.at('.claude-account-2', 'b');
  b.turn(117_000, { model: 'claude-big' });
  assert.match(b.run().additionalContext, /заполнен на 70 %/, 'у второго аккаунта своя, ещё не выученная точка');
});

scenario('ручное сжатие (/compact) не учит', (w) => {
  const s = w.at();
  s.turn(50_000);
  s.compacted(50_000, 'manual');
  s.turn(5_000);
  s.run();
  assert.deepEqual(w.learned(), {});
});

scenario('одно и то же сжатие не учится дважды', (w) => {
  const s = w.at('.claude', 'twice');
  s.turn(166_000);
  s.compacted(167_000);
  s.turn(5_000);
  s.run();
  s.run('PostToolUse');
  assert.equal(w.learned()['.claude']['claude-test-1'].samples.length, 1);
});

scenario('после сжатия пороги сессии взводятся заново', (w) => {
  const s = w.at();
  s.turn(117_000);
  assert.ok(s.run());
  s.compacted(167_000);
  s.turn(20_000);
  assert.equal(s.run(), null);
  s.turn(118_000);
  assert.ok(s.run(), 'снова подходим к сжатию — снова подсказка');
});

scenario('ручная точка из настроек главнее выученной; пороги — тоже из настроек', (w) => {
  w.settings({ limits: { 'claude-big': 1_000_000 }, thresholds: [50] });
  const s = w.at();
  s.turn(400_000, { model: 'claude-big-5' });
  assert.equal(s.run(), null);
  s.turn(510_000, { model: 'claude-big-5' });
  assert.match(s.run().additionalContext, /заполнен на 51 %/);
});

scenario('ответы субагентов (isSidechain) не считаются', (w) => {
  const s = w.at();
  s.turn(50_000);
  s.turn(150_000, { sidechain: true });
  assert.equal(s.run(), null);
});

scenario('нет лога, битый вход, чужое событие — молча проходит', (w) => {
  assert.equal(w.at().run(), null, 'лога ещё нет');
  const env = { HOME: w.home, USERPROFILE: w.home, PATH: process.env.PATH ?? '' };
  for (const input of ['не json', JSON.stringify({ hook_event_name: 'Stop', session_id: 's', transcript_path: '/nope' })]) {
    const proc = spawnSync(process.execPath, [LAUNCHER, 'context-watch'], { input, env, encoding: 'utf8' });
    assert.equal(proc.status, 0);
    assert.equal(proc.stdout, '');
  }
});

test('limitFor: по умолчанию; выше точки — миллион; ручная по длинному префиксу; выученная — медианой', () => {
  assert.equal(limitFor({ account: 'a', model: 'x', used: 10 }), DEFAULT_LIMIT);
  assert.equal(limitFor({ account: 'a', model: 'x', used: 640_000 }), LARGE_LIMIT);
  assert.equal(limitFor({ account: 'a', model: 'claude-opus-5-5', used: 10, manual: { claude: 300_000, 'claude-opus': 900_000 } }), 900_000);
  const learned = { a: { x: { samples: [{ pre: 170_000 }, { pre: 900_000 }, { pre: 168_000 }] } } };
  assert.equal(limitFor({ account: 'a', model: 'x', used: 10, learned }), 170_000);
  assert.equal(median([3, 1, 2, 4]), 3);
});

test('scan: обрезанная первая строка хвоста; модель сжатия — ответа перед ним', () => {
  const text = '{"type":"assist\n' + [answer(5, { model: 'm1' }), compaction(900), answer(7, { model: 'm2' })].join('\n') + '\n';
  const { last, compactions } = scan(text);
  assert.deepEqual(last, { used: 7, model: 'm2' });
  assert.equal(compactions.length, 1);
  assert.equal(compactions[0].model, 'm1');
  assert.equal(compactions[0].pre, 900);
});
