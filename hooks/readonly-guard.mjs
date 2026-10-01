// PreToolUse-хук (Bash) для субагента verifier: allowlist с запретом по умолчанию.
//
// verifier проверяет чужую работу: читает файлы и историю git, запускает гейт проекта, тест-раннеры
// и сборку для тестов. Он не меняет файлы, git, зависимости, устройства и удалённые сервисы. Denylist
// по шаблонам не удерживается (подстановки, функции shell, `git -c alias.*`, `vim -es`, `arch …`,
// `simctl --set`), поэтому здесь наоборот: разрешено только то, что перечислено, всё остальное — блок.
//
//   1. Консервативный токенизатор. Всё, что он не может полностью объяснить, — блок: `$`, обратные
//      кавычки, `( )`, `{ }`, `<` в любой форме, `&` (фон, `&>`), `\` вне кавычек, `~`, `!`, `#`, слово
//      с `=` в начале, любое перенаправление, кроме `>/dev/null`, `2>/dev/null`, `2>&1`.
//   2. Команда делится по `;`, переводу строки, `&&`, `||`, `|` на простые команды; каждая
//      проверяется отдельно. Присваивания перед командой (`VAR=x cmd`) — блок.
//   3. Слово команды ищется в ALLOWLIST; у каждой команды своя политика аргументов. Путь с `/`
//      (`./x`, `scripts/x`) — только к существующему обычному файлу внутри cwd (realpath); любой
//      компонент `..` в пути — блок (лексическое сворачивание `link/..` отличается от realpath).
//   4. Тест-раннеры, сборка и гейт исполняют код проекта: это доверие к проекту, а не песочница.
//      Границы и остаточные риски — hooks/SECURITY-hooks.md.
//
// Семантика Claude Code: код 2 = блок (stderr уходит агенту); любой другой код, падение или таймаут —
// команда ПРОХОДИТ. Поэтому любой нештатный путь заканчивается кодом 2 (лаунчер тоже: сбой загрузки
// хука, падение main, незакрытый stdin у хука с failClosed).
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  CapTimeout, IS_WINDOWS, cleanEnv, killActiveChildren, realpathLoose, runCapped,
} from './lib/paths.mjs';

export const failClosed = true;

// Таймаут хука во frontmatter — 10 с; сработать надо раньше хоста.
const WATCHDOG_MS = 5000;
const COLLAB_TIMEOUT_MS = 3000;
const ADVICE = 'verifier не обходит блок: отметь шаг как «не проверено» или попроси лида выполнить его.';

class Blocked extends Error {}

// ── токенизатор ───────────────────────────────────────────────────────────────

class Word {
  constructor(text, quoted, glob) {
    this.text = text;
    this.quoted = quoted; // часть слова была в кавычках
    this.glob = glob; // в слове есть незакавыченные `*`, `?`, `[`
  }
}

class Redirect {
  constructor(fd, target) {
    this.fd = fd;
    this.target = target;
  }
}

const OPERATORS = [';', '&&', '||', '|'];
const GLOB_CHARS = '*?[';
const META_UNQUOTED = {
  $: 'подстановка `$` (переменные, `$(…)`, `$\'…\'`)',
  '`': 'подстановка в обратных кавычках',
  '(': 'скобка `(` (подоболочка, функция, `<(…)`)',
  ')': 'скобка `)`',
  '{': 'фигурная скобка `{` (группа, brace expansion)',
  '}': 'фигурная скобка `}`',
  '<': 'перенаправление ввода `<` (heredoc, here-string, `<(…)`, `< файл`)',
  '~': 'тильда `~` (раскрытие домашнего каталога)',
  '!': 'символ `!`',
  '\\': 'обратный слеш вне кавычек (экранирование, перенос строки)',
};
const WORD_BREAK = ' \t\n;|&';

function isControl(ch) {
  const code = ch.charCodeAt(0);
  return code < 32 || code === 0x7f;
}

export function tokenize(command) {
  const tokens = [];
  const n = command.length;
  let buf = '';
  let inWord = false;
  let quoted = false;
  let glob = false;

  const flush = () => {
    if (inWord) tokens.push(new Word(buf, quoted, glob));
    buf = '';
    inWord = false;
    quoted = false;
    glob = false;
  };
  const followedByBreak = (pos) => pos >= n || WORD_BREAK.includes(command[pos]);

  let i = 0;
  while (i < n) {
    const ch = command[i];
    if (ch === "'") {
      const j = command.indexOf("'", i + 1);
      if (j < 0) throw new Blocked('незакрытая одинарная кавычка');
      buf += command.slice(i + 1, j);
      inWord = true;
      quoted = true;
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      i += 1;
      inWord = true;
      quoted = true;
      for (;;) {
        if (i >= n) throw new Blocked('незакрытая двойная кавычка');
        const c = command[i];
        if (c === '"') {
          i += 1;
          break;
        }
        if (c === '\\') {
          if (i + 1 >= n) throw new Blocked('обратный слеш в конце строки');
          const next = command[i + 1];
          if (next === '\n') throw new Blocked('перенос строки через `\\` внутри кавычек');
          if ('$`"\\'.includes(next)) {
            buf += next;
            i += 2;
            continue;
          }
          buf += c;
          i += 1;
          continue;
        }
        if (c === '$' || c === '`') throw new Blocked(`подстановка \`${c}\` внутри двойных кавычек`);
        if (c !== '\t' && c !== '\n' && isControl(c)) throw new Blocked('управляющий символ внутри кавычек');
        buf += c;
        i += 1;
      }
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      flush();
      i += 1;
      continue;
    }
    if (ch === '\n') {
      flush();
      tokens.push(';');
      i += 1;
      continue;
    }
    if (Object.hasOwn(META_UNQUOTED, ch)) throw new Blocked(META_UNQUOTED[ch]);
    if (ch === '#' && !inWord) throw new Blocked('комментарий `#` — убери его из команды');
    if (ch === '=' && !inWord) throw new Blocked('слово начинается с `=`');
    if (ch === '&') {
      if (command.startsWith('&&', i)) {
        flush();
        tokens.push('&&');
        i += 2;
        continue;
      }
      throw new Blocked('символ `&` (фоновый запуск, `&>`, `|&`)');
    }
    if (ch === '|') {
      flush();
      if (command.startsWith('||', i)) {
        tokens.push('||');
        i += 2;
      } else if (command.startsWith('|&', i)) {
        throw new Blocked('оператор `|&`');
      } else {
        tokens.push('|');
        i += 1;
      }
      continue;
    }
    if (ch === ';') {
      if (command.startsWith(';;', i)) throw new Blocked('оператор `;;`');
      flush();
      tokens.push(';');
      i += 1;
      continue;
    }
    if (ch === '>') {
      let fd = 1;
      if (inWord) {
        if (buf !== '' && !quoted && !glob && /^[0-9]+$/.test(buf)) {
          fd = Number(buf);
          buf = '';
          inWord = false;
        } else {
          flush();
        }
      }
      i += 1;
      if (i < n && '>|('.includes(command[i])) throw new Blocked(`перенаправление \`>${command[i]}\``);
      if (i < n && command[i] === '&') {
        if (fd === 2 && command.startsWith('&1', i) && followedByBreak(i + 2)) {
          tokens.push(new Redirect(2, '&1'));
          i += 2;
          continue;
        }
        throw new Blocked('перенаправление дескриптора `>&` (разрешено только `2>&1`)');
      }
      while (i < n && (command[i] === ' ' || command[i] === '\t')) i += 1;
      if ((fd === 1 || fd === 2) && command.startsWith('/dev/null', i) && followedByBreak(i + 9)) {
        tokens.push(new Redirect(fd, '/dev/null'));
        i += 9;
        continue;
      }
      throw new Blocked('перенаправление вывода в файл (разрешены только `>/dev/null`, `2>/dev/null`, `2>&1`)');
    }
    if (isControl(ch)) throw new Blocked('управляющий символ в команде');
    if (GLOB_CHARS.includes(ch)) glob = true;
    buf += ch;
    inWord = true;
    i += 1;
  }
  flush();
  return tokens;
}

export function splitSimpleCommands(tokens) {
  const commands = [];
  let current = [];
  for (const tok of tokens) {
    if (typeof tok === 'string' && OPERATORS.includes(tok)) {
      if (!current.some((t) => t instanceof Word)) throw new Blocked(`пустая команда рядом с оператором \`${tok}\``);
      commands.push(current);
      current = [];
    } else {
      current.push(tok);
    }
  }
  const last = tokens[tokens.length - 1];
  if (current.some((t) => t instanceof Word)) commands.push(current);
  else if (current.length > 0) throw new Blocked('перенаправление без команды');
  else if (last === '&&' || last === '||' || last === '|') throw new Blocked(`команда обрывается на операторе \`${last}\``);
  if (commands.length === 0) throw new Blocked('пустая команда');
  return commands;
}

// ── политики аргументов ───────────────────────────────────────────────────────

const texts = (args) => args.map((a) => a.text);
const same = (list, other) => list.length === other.length && list.every((v, i) => v === other[i]);
const partition = (s) => {
  const idx = s.indexOf('=');
  return idx < 0 ? [s, '', ''] : [s.slice(0, idx), '=', s.slice(idx + 1)];
};

function rejectArgs(cmd, args, { exact = [], prefixes = [], shortLetters = '' } = {}) {
  for (const a of texts(args)) {
    if (exact.includes(a) || prefixes.some((p) => a.startsWith(p))) {
      throw new Blocked(`\`${cmd} ${a}\` не разрешён (флаг может писать или запускать код)`);
    }
    if (shortLetters && a.length > 1 && a[0] === '-' && a[1] !== '-') {
      for (const letter of shortLetters) {
        if (a.slice(1).includes(letter)) throw new Blocked(`\`${cmd} -${letter}\` не разрешён`);
      }
    }
  }
}

const isAbsoluteAnywhere = (p) => p.startsWith('/') || path.isAbsolute(p);
const PATH_SPLIT = IS_WINDOWS ? /[\\/]/ : /\//;

// Компонент `..` (на Windows — и любая «точечная» форма) блокируется: лексическое сворачивание
// `link/..` расходится с realpath, а проверять надо то, что реально откроет раннер.
function hasParentComponent(value) {
  return value.split(PATH_SPLIT).some((part) => part === '..' || (IS_WINDOWS && part !== '.' && /^[. ]+$/.test(part)));
}

function requireAbsoluteCwd(cmd, value, cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
    throw new Blocked(`\`${cmd}\`: в событии нет абсолютного cwd — путь \`${value}\` нельзя проверить`);
  }
}

function checkInsideCwd(cmd, value, cwd) {
  requireAbsoluteCwd(cmd, value, cwd);
  if (hasParentComponent(value)) throw new Blocked(`\`${cmd}\`: путь \`${value}\` выходит из cwd через \`..\``);
  const root = realpathLoose(cwd);
  const real = realpathLoose(path.join(cwd, value));
  if (path.relative(root, real).split(path.sep)[0] === '..' || path.isAbsolute(path.relative(root, real))) {
    throw new Blocked(`\`${cmd}\`: путь \`${value}\` после разрешения симлинков ведёт за пределы cwd`);
  }
}

function checkRelativePath(cmd, value, cwd) {
  if (!value || value.startsWith('-')) throw new Blocked(`\`${cmd}\`: неизвестный флаг \`${value}\``);
  if (isAbsoluteAnywhere(value)) throw new Blocked(`\`${cmd}\`: абсолютный путь \`${value}\` — можно только относительно cwd`);
  const head = value.split('::')[0];
  if (hasParentComponent(head)) throw new Blocked(`\`${cmd}\`: путь \`${value}\` выходит из cwd через \`..\``);
  if (IS_WINDOWS && head.includes(':')) throw new Blocked(`\`${cmd}\`: путь \`${value}\` содержит \`:\` (диск или поток) — нельзя проверить`);
  checkInsideCwd(cmd, head, cwd);
}

function resolveInsideCwd(cwd, value, needExec) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
    throw new Blocked('в событии нет абсолютного cwd — запуск скрипта по пути нельзя проверить');
  }
  if (isAbsoluteAnywhere(value)) throw new Blocked(`путь \`${value}\` абсолютный — скрипт должен лежать внутри cwd`);
  if (hasParentComponent(value)) throw new Blocked(`путь \`${value}\` содержит \`..\` — скрипт должен лежать внутри cwd без обходов`);
  if (IS_WINDOWS && value.includes(':')) throw new Blocked(`путь \`${value}\` содержит \`:\` — нельзя проверить`);
  const root = realpathLoose(cwd);
  const real = realpathLoose(path.join(cwd, value));
  const rel = path.relative(root, real);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Blocked(`путь \`${value}\` ведёт за пределы cwd`);
  }
  let st;
  try {
    st = statSync(real);
  } catch {
    throw new Blocked(`файл \`${value}\` не найден внутри cwd`);
  }
  if (!st.isFile()) throw new Blocked(`\`${value}\` — не обычный файл`);
  if (needExec && !IS_WINDOWS) {
    try {
      accessSync(real, constants.X_OK);
    } catch {
      throw new Blocked(`\`${value}\` не исполняемый`);
    }
  }
}

const anyArgs = () => {};

function noArgs(cmd, args) {
  if (args.length > 0) throw new Blocked(`\`${cmd}\` разрешён только без аргументов`);
}

function policyCommand(cmd, args) {
  const t = texts(args);
  if (t.length < 2 || t[0] !== '-v' || t.slice(1).some((a) => a.startsWith('-'))) {
    throw new Blocked('`command` разрешён только в форме `command -v имя`');
  }
}

function policyDate(cmd, args) {
  const t = texts(args);
  t.forEach((a, i) => {
    if (a === '-f' || a === '-s' || a === '--set' || a.startsWith('--set=')) throw new Blocked(`\`date ${a}\` может менять системное время`);
    if (a.startsWith('-') || a.startsWith('+')) return;
    if (i > 0 && (t[i - 1] === '-r' || t[i - 1] === '-v')) return;
    throw new Blocked('`date` с позиционным аргументом может менять системное время');
  });
}

const FILE_LONG = ['--mime', '--mime-type', '--mime-encoding', '--brief', '--version', '--help', '--dereference',
  '--no-dereference', '--separator', '--files-from'];

function policyFile(cmd, args) {
  for (const a of texts(args)) {
    if (a.startsWith('--') && !FILE_LONG.includes(a) && !a.startsWith('--separator=')) throw new Blocked(`\`file ${a}\` не разрешён`);
  }
  rejectArgs(cmd, args, { shortLetters: 'C' });
}

// --pre запускает произвольную программу; -z/--search-zip — внешние распаковщики.
function policyRg(cmd, args) {
  rejectArgs(cmd, args, {
    exact: ['--pre', '--pre-glob', '--search-zip'],
    prefixes: ['--pre=', '--pre-glob=', '--search-zip='],
    shortLetters: 'z',
  });
}

// `printf -v NAME` присваивает переменную оболочки — `printf -v PATH /tmp; cat` подменяет PATH.
function policyPrintf(cmd, args) {
  for (const a of texts(args)) {
    if (a.startsWith('-v')) throw new Blocked(`\`printf ${a}\` присваивает переменную оболочки (например PATH) — запрещено`);
  }
}

function policyFind(cmd, args) {
  rejectArgs(cmd, args, { exact: ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fls'], prefixes: ['-fprint'] });
}

const SORT_LONG = ['--reverse', '--numeric-sort', '--unique', '--ignore-case', '--stable', '--version-sort',
  '--human-numeric-sort', '--month-sort', '--general-numeric-sort', '--zero-terminated', '--check',
  '--dictionary-order', '--ignore-leading-blanks', '--ignore-nonprinting', '--random-sort', '--debug', '--help',
  '--version'];
const SORT_LONG_PREFIXES = ['--key=', '--field-separator=', '--parallel=', '--buffer-size='];

function policySort(cmd, args) {
  for (const a of texts(args)) {
    if (a.startsWith('--') && !SORT_LONG.includes(a) && !SORT_LONG_PREFIXES.some((p) => a.startsWith(p))) {
      throw new Blocked(`\`sort ${a}\` не разрешён (длинные опции — только из известного списка)`);
    }
  }
  rejectArgs(cmd, args, { shortLetters: 'oT' });
}

function policyUniq(cmd, args) {
  let positional = 0;
  let skip = false;
  for (const a of texts(args)) {
    if (skip) {
      skip = false;
      continue;
    }
    if (a === '-f' || a === '-s' || a === '-w') {
      skip = true;
      continue;
    }
    if (a.startsWith('-')) continue;
    positional += 1;
  }
  if (positional > 1) throw new Blocked('`uniq` со вторым позиционным аргументом пишет в выходной файл');
}

function policyPlutil(cmd, args) {
  const t = texts(args);
  if (t.length === 0 || !['-p', '-lint'].includes(t[0]) || t.slice(1).some((a) => a.startsWith('-'))) {
    throw new Blocked('`plutil` разрешён только как `plutil -p …` или `plutil -lint …`');
  }
}

function policyXcodeSelect(cmd, args) {
  const t = texts(args);
  if (t.length === 0 || t.some((a) => !['-p', '--print-path', '-v', '--version'].includes(a))) {
    throw new Blocked('`xcode-select` разрешён только с `-p`/`--print-path`/`--version`');
  }
}

// ── git ───────────────────────────────────────────────────────────────────────

const GIT_DIFF_LIKE_REJECT = ['--output', '--ext-diff', '--textconv', '--filters'];
const GIT_DIFF_LIKE_PREFIX = ['--output=', '--output-'];
const GIT_BRANCH_FLAGS = ['--list', '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '--show-current',
  '--no-color', '--color=never'];
const GIT_CONFIG_SCOPES = ['--global', '--local', '--system', '--worktree', '--show-origin', '--show-scope',
  '--name-only', '-z', '--null'];
const GIT_CONFIG_ACTIONS = ['--get', '--get-all', '--get-regexp', '--list', '-l', 'get', 'list'];

function gitReader(sub, args) {
  rejectArgs(`git ${sub}`, args, { exact: GIT_DIFF_LIKE_REJECT, prefixes: GIT_DIFF_LIKE_PREFIX });
  if (sub === 'grep') rejectArgs('git grep', args, { prefixes: ['-O', '--open-files-in-pager'] });
}

function gitBranch(sub, args) {
  for (const a of texts(args)) {
    if (!GIT_BRANCH_FLAGS.includes(a)) {
      throw new Blocked(`\`git branch ${a}\` не разрешён (только список: без аргументов, --list, -a, -r, -v, --show-current)`);
    }
  }
}

function gitWorktree(sub, args) {
  const t = texts(args);
  if (t.length === 0 || t[0] !== 'list' || t.slice(1).some((a) => !a.startsWith('-'))) {
    throw new Blocked('`git worktree` разрешён только как `git worktree list [опции]`');
  }
}

function gitRemote(sub, args) {
  if (texts(args).some((a) => a !== '-v' && a !== '--verbose')) throw new Blocked('`git remote` разрешён только без аргументов или с `-v`');
}

function gitConfig(sub, args) {
  let actions = 0;
  for (const a of texts(args)) {
    if (GIT_CONFIG_ACTIONS.includes(a)) actions += 1;
    else if (GIT_CONFIG_SCOPES.includes(a)) continue;
    else if (a.startsWith('-')) throw new Blocked(`\`git config ${a}\` не разрешён`);
  }
  if (actions !== 1) throw new Blocked('`git config` разрешён только для чтения: `--get`, `--get-all`, `--get-regexp`, `--list`/`-l`');
}

function gitStash(sub, args) {
  const t = texts(args);
  if (t.length === 0 || !['list', 'show'].includes(t[0])) throw new Blocked('`git stash` разрешён только как `git stash list` / `git stash show`');
  gitReader(`stash ${t[0]}`, args.slice(1));
}

function gitTag(sub, args) {
  const t = texts(args);
  if (t.length === 0) return;
  if (!t.some((a) => a === '-l' || a === '--list')) throw new Blocked('`git tag` разрешён только без аргументов или с `-l`/`--list`');
  for (const a of t) {
    if (a.startsWith('-') && a !== '-l' && a !== '--list' && !/^-n[0-9]*$/.test(a)) throw new Blocked(`\`git tag ${a}\` не разрешён`);
  }
}

const GIT_SUBCOMMANDS = new Map([
  ...['status', 'diff', 'log', 'show', 'blame', 'ls-files', 'ls-tree', 'cat-file', 'rev-parse', 'rev-list',
    'describe', 'shortlog', 'grep', 'merge-base'].map((name) => [name, gitReader]),
  ['branch', gitBranch], ['worktree', gitWorktree], ['remote', gitRemote], ['config', gitConfig],
  ['stash', gitStash], ['tag', gitTag],
]);

function policyGit(cmd, args) {
  let rest = args;
  let t = texts(rest);
  if (t.length > 0 && t[0] === '--no-pager') { // единственная разрешённая глобальная опция: влияет лишь на вывод
    rest = rest.slice(1);
    t = t.slice(1);
  }
  if (t.length === 0) throw new Blocked('`git` без подкоманды');
  if (same(t, ['--version'])) return;
  const sub = t[0];
  if (sub.startsWith('-')) {
    throw new Blocked(`глобальные опции git (\`${sub}\`) запрещены: \`-c\`, \`-C\`, \`--git-dir\`, \`-p\` и др. меняют, что исполняется`);
  }
  const handler = GIT_SUBCOMMANDS.get(sub);
  if (!handler) throw new Blocked(`подкоманда \`git ${sub}\` не входит в allowlist (алиасы тоже)`);
  handler(sub, rest.slice(1));
}

// ── тест-раннеры и сборка ─────────────────────────────────────────────────────

const NODE_TEST_FLAGS = ['--test-only', '--test-force-exit', '--test-coverage', '--experimental-test-coverage',
  '--test-update-snapshots'];
const NODE_TEST_VALUE = ['--test-name-pattern', '--test-skip-pattern', '--test-concurrency', '--test-timeout',
  '--test-reporter', '--test-isolation', '--test-shard'];
const NODE_REPORTERS = ['spec', 'tap', 'dot', 'junit', 'lcov'];

function policyNode(cmd, args, cwd) {
  const t = texts(args);
  if (same(t, ['--version']) || same(t, ['-v'])) return;
  if (t.length === 2 && (t[0] === '--check' || t[0] === '-c')) {
    checkRelativePath('node --check', t[1], cwd);
    return;
  }
  if (t.length === 0 || t[0] !== '--test') throw new Blocked('`node` разрешён только как `node --test …` или `node --check <файл>`');
  let i = 1;
  while (i < t.length) {
    const a = t[i];
    if (NODE_TEST_FLAGS.includes(a)) {
      i += 1;
      continue;
    }
    const [name, eq, inline] = partition(a);
    if (NODE_TEST_VALUE.includes(name)) {
      let value = inline;
      if (!eq) {
        i += 1;
        if (i >= t.length) throw new Blocked(`\`node ${name}\` без значения`);
        value = t[i];
      }
      if (name === '--test-reporter' && !NODE_REPORTERS.includes(value)) {
        throw new Blocked(`\`node --test-reporter=${value}\` загружает модуль — разрешены только ${NODE_REPORTERS.join(', ')}`);
      }
      i += 1;
      continue;
    }
    checkRelativePath('node --test', a, cwd);
    i += 1;
  }
}

const PYTEST_FLAGS = ['-v', '-vv', '-vvv', '-q', '-qq', '-x', '-s', '-l', '--showlocals', '--co', '--collect-only',
  '--lf', '--last-failed', '--ff', '--failed-first', '--no-header', '--no-summary', '--strict-markers',
  '--disable-warnings', '--verbose', '--quiet', '--exitfirst', '--version', '--fixtures', '--markers', '-h', '--help'];
const PYTEST_VALUE = ['-k', '-m', '-W', '-p', '--tb', '--maxfail', '--durations', '--durations-min', '--timeout',
  '--color', '--capture', '--ignore', '--deselect'];
const UNITTEST_FLAGS = ['-v', '--verbose', '-q', '--quiet', '-f', '--failfast', '-b', '--buffer', '--catch', '--locals',
  '-h', '--help', 'discover'];
const UNITTEST_VALUE = ['-k', '--durations', '-s', '--start-directory', '-t', '--top-level-directory', '-p', '--pattern'];

function checkRunnerOptions(runner, t, flags, valueOpts, pathValueOpts, cwd) {
  let i = 0;
  while (i < t.length) {
    const a = t[i];
    if (flags.includes(a) || (runner === 'pytest' && /^-r[a-zA-Z]+$/.test(a))) {
      i += 1;
      continue;
    }
    const [name, eq, inline] = partition(a);
    if (valueOpts.includes(name)) {
      let value = inline;
      if (!eq) {
        i += 1;
        if (i >= t.length) throw new Blocked(`\`${runner} ${name}\` без значения`);
        value = t[i];
      }
      if (runner === 'pytest' && name === '-p' && !value.startsWith('no:')) {
        throw new Blocked(`\`pytest -p ${value}\` загружает плагин — разрешено только \`-p no:<имя>\``);
      }
      if (pathValueOpts.includes(name)) checkRelativePath(`${runner} ${name}`, value, cwd);
      i += 1;
      continue;
    }
    if (a.startsWith('-')) throw new Blocked(`\`${runner} ${a}\` не входит в allowlist опций`);
    checkRelativePath(runner, a, cwd);
    i += 1;
  }
}

function policyPython(cmd, args, cwd) {
  const t = texts(args);
  if (same(t, ['--version']) || same(t, ['-V'])) return;
  if (t.length < 2 || t[0] !== '-m' || !['unittest', 'pytest'].includes(t[1])) {
    throw new Blocked('`python3` разрешён только как `python3 -m unittest …` или `python3 -m pytest …`');
  }
  if (t[1] === 'unittest') {
    checkRunnerOptions('unittest', t.slice(2), UNITTEST_FLAGS, UNITTEST_VALUE,
      ['-s', '--start-directory', '-t', '--top-level-directory'], cwd);
  } else {
    checkRunnerOptions('pytest', t.slice(2), PYTEST_FLAGS, PYTEST_VALUE, ['--ignore'], cwd);
  }
}

function npmLike(cmd, t, allowRun) {
  if (same(t, ['--version']) || same(t, ['-v'])) return;
  if (t.length === 0) throw new Blocked(`\`${cmd}\` без аргументов ставит зависимости`);
  let rest;
  if (t[0] === 'test') {
    rest = t.slice(1);
  } else if (allowRun && t[0] === 'run') {
    rest = t.slice(1);
    if (rest.length > 0 && !rest[0].startsWith('-')) rest = rest.slice(1);
  } else {
    throw new Blocked(`\`${cmd} ${t[0]}\` не разрешён (только \`${cmd} test\`${allowRun ? ' и `npm run <script>`' : ''})`);
  }
  for (const a of rest) {
    if (a === '--') break;
    if (a.startsWith('-')) throw new Blocked(`\`${cmd}\`: флаг \`${a}\` перед \`--\` меняет поведение менеджера пакетов`);
  }
}

const policyNpm = (cmd, args) => npmLike('npm', texts(args), true);
const policyPnpm = (cmd, args) => npmLike('pnpm', texts(args), false);
const policyYarn = (cmd, args) => npmLike('yarn', texts(args), false);

const SWIFT_FLAGS = ['-v', '--verbose', '-q', '--quiet', '--parallel', '--skip-build', '--skip-update',
  '--disable-automatic-resolution', '--enable-code-coverage', '--show-bin-path', '--list-tests', '-l', '--build-tests',
  '--very-verbose', '--vv'];
const SWIFT_VALUE = ['-c', '--configuration', '--filter', '--skip', '--target', '--product', '-j', '--jobs', '--num-workers'];

function policySwift(cmd, args) {
  const t = texts(args);
  if (same(t, ['--version'])) return;
  if (t.length === 0 || !['build', 'test'].includes(t[0])) throw new Blocked('`swift` разрешён только как `swift build …` / `swift test …`');
  let i = 1;
  while (i < t.length) {
    const a = t[i];
    if (SWIFT_FLAGS.includes(a)) {
      i += 1;
      continue;
    }
    const [name, eq] = partition(a);
    if (SWIFT_VALUE.includes(name)) {
      if (!eq) {
        i += 1;
        if (i >= t.length) throw new Blocked(`\`swift ${t[0]} ${name}\` без значения`);
      }
      i += 1;
      continue;
    }
    throw new Blocked(`\`swift ${t[0]} ${a}\` не входит в allowlist опций`);
  }
}

const XCB_VALUE = ['-project', '-workspace', '-scheme', '-target', '-configuration', '-destination', '-sdk', '-arch',
  '-toolchain', '-jobs', '-testPlan', '-destination-timeout'];
const XCB_FLAGS = ['-list', '-showBuildSettings', '-showdestinations', '-showsdks', '-version', '-usage', '-help',
  '-json', '-quiet', '-verbose', '-parallelizeTargets', '-alltargets', '-skipUnavailableActions',
  '-disableAutomaticPackageResolution', '-skipPackageUpdates', '-onlyUsePackageVersionsFromResolvedFile',
  '-hideShellScriptEnvironment', '-showBuildTimingSummary', '-skipMacroValidation', '-skipPackagePluginValidation'];
const XCB_ACTIONS = ['build', 'build-for-testing'];
const XCB_SETTINGS = ['CODE_SIGNING_ALLOWED', 'CODE_SIGNING_REQUIRED', 'CODE_SIGN_IDENTITY', 'ONLY_ACTIVE_ARCH'];

function policyXcodebuild(cmd, args, cwd) {
  const t = texts(args);
  let i = 0;
  while (i < t.length) {
    const a = t[i];
    if (XCB_VALUE.includes(a)) {
      i += 1;
      if (i >= t.length) throw new Blocked(`\`xcodebuild ${a}\` без значения`);
      if (a === '-project' || a === '-workspace') {
        if (isAbsoluteAnywhere(t[i])) throw new Blocked(`\`xcodebuild ${a} ${t[i]}\`: проект вне cwd — его фазы сборки выполнят чужой код`);
        checkInsideCwd(`xcodebuild ${a}`, t[i], cwd);
      }
      i += 1;
      continue;
    }
    if (XCB_FLAGS.includes(a) || XCB_ACTIONS.includes(a)) {
      i += 1;
      continue;
    }
    const [key, eq] = partition(a);
    if (eq && XCB_SETTINGS.includes(key)) {
      i += 1;
      continue;
    }
    if (a.startsWith('-')) {
      throw new Blocked(`\`xcodebuild ${a}\` не входит в allowlist (в частности \`-resolvePackageDependencies\`, `
        + '`-derivedDataPath`, `-resultBundlePath`, `-allowProvisioningUpdates`)');
    }
    throw new Blocked(`действие \`xcodebuild ${a}\` запрещено: разрешены только \`build\` и \`build-for-testing\``);
  }
}

const XCRUN_SDK_QUERIES = ['--show-sdk-path', '--show-sdk-version', '--show-sdk-platform-path', '--show-sdk-build-version', '--version'];

function policyXcrun(cmd, args) {
  const t = texts(args);
  if (t.length >= 2 && t[0] === 'simctl' && t[1] === 'list') {
    for (const a of t.slice(2)) {
      if (a.startsWith('-') && !['-j', '--json', '-v'].includes(a)) throw new Blocked(`\`xcrun simctl list ${a}\` не разрешён`);
    }
    return;
  }
  if (t.length === 2 && t[0] === '--find' && !t[1].startsWith('-')) return;
  if (t.length > 0 && t.every((a) => XCRUN_SDK_QUERIES.includes(a))) return;
  if (t.length === 3 && t[0] === '--sdk' && !t[1].startsWith('-') && ['--show-sdk-path', '--show-sdk-version'].includes(t[2])) return;
  throw new Blocked('`xcrun` разрешён только как `xcrun simctl list …`, `xcrun --find <tool>`, `xcrun --show-sdk-path`');
}

function policyShellScript(cmd, args, cwd) {
  const t = texts(args);
  if (t.length === 0) throw new Blocked(`\`${cmd}\` без пути к скрипту читает команды со stdin`);
  if (t[0].startsWith('-')) throw new Blocked(`\`${cmd} ${t[0]}\` не разрешён: интерпретатору можно передать только путь к скрипту внутри cwd`);
  if (args[0].glob) throw new Blocked('путь к скрипту не должен содержать глоб-символы');
  resolveInsideCwd(cwd, t[0], false);
}

const COLLAB_REF = /^[A-Za-z0-9_-]+$/;

function policyCollab(cmd, args) {
  const t = texts(args);
  if (same(t, ['project']) || same(t, ['project', '--json'])) return;
  // `collab reviews` — только чтение: вердикты, слоты и сила находок ревью задачи.
  if (t.length > 0 && t[0] === 'reviews') {
    const rest = t.slice(1);
    let i = 0;
    while (i < rest.length) {
      if (rest[i] === '--json' || rest[i] === '--pending') i += 1;
      else if ((rest[i] === '--task' || rest[i] === '--reviewer') && i + 1 < rest.length && COLLAB_REF.test(rest[i + 1])) i += 2;
      else throw new Blocked(`\`collab reviews\`: аргумент \`${rest[i]}\` не разрешён`);
    }
    return;
  }
  throw new Blocked('`collab` разрешён только как `collab project [--json]` и `collab reviews [--task <id>] [--reviewer <агент>] [--pending] [--json]`');
}

const ALLOWLIST = new Map([
  ...['ls', 'cat', 'head', 'tail', 'wc', 'stat', 'du', 'df', 'pwd', 'which', 'echo', 'uname', 'whoami', 'id', 'grep',
    'egrep', 'fgrep', 'cut', 'tr', 'jq', 'diff', 'cmp', 'comm', 'basename', 'dirname', 'realpath', 'readlink',
    'shasum', 'md5', 'sw_vers'].map((name) => [name, anyArgs]),
  ['printf', policyPrintf], ['env', noArgs], ['command', policyCommand], ['date', policyDate], ['file', policyFile],
  ['rg', policyRg], ['find', policyFind], ['sort', policySort], ['uniq', policyUniq],
  ['git', policyGit],
  ['node', policyNode], ['python3', policyPython], ['python', policyPython], ['npm', policyNpm], ['pnpm', policyPnpm],
  ['yarn', policyYarn], ['bash', policyShellScript], ['sh', policyShellScript],
  ['collab', policyCollab],
]);

// ── платформенные команды и настройки проекта ─────────────────────────────────
// Ядро ставится во все проекты машины, поэтому сборка и симулятор конкретной платформы — не общий
// allowlist, а группа, которую проект включает сам. Политики аргументов остаются здесь (проверенная
// логика границы), в проект уходит только «включено или нет». Настройки читаются из ДОВЕРЕННОГО
// реестра — <registryDir>/<projectId>/readonly-guard.json, найденного через `collab project --json`:
// не из репозитория и не из окружения. Не удалось узнать — блок, а не разрешение.

const PLATFORM_POLICIES = {
  apple: new Map([
    ['swift', policySwift], ['xcodebuild', policyXcodebuild], ['xcrun', policyXcrun],
    ['xcode-select', policyXcodeSelect], ['plutil', policyPlutil],
  ]),
};
const PLATFORM_COMMANDS = new Set(Object.values(PLATFORM_POLICIES).flatMap((group) => [...group.keys()]));
const SETTINGS_KEYS = ['platforms'];
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function decodeUtf8(buffer) {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
}

async function collabProjectStrict(cwd, home) {
  const script = path.join(home, '.agent-collab-kit', 'current', 'bin', 'collab');
  let out;
  try {
    out = await runCapped([process.execPath, script, 'project', '--json'], { cwd, env: cleanEnv(home), timeoutMs: COLLAB_TIMEOUT_MS });
  } catch (error) {
    if (error instanceof CapTimeout) throw new Blocked(`collab project --json не ответил за ${COLLAB_TIMEOUT_MS / 1000} с — проект не узнать`);
    throw new Blocked(`не удалось запустить collab, чтобы узнать проект (${error?.message ?? error})`);
  }
  if (out.status !== 0) throw new Blocked(`collab project --json завершился с кодом ${out.status} — проект не узнать`);
  let info;
  try {
    info = JSON.parse(decodeUtf8(out.stdout));
  } catch {
    throw new Blocked('collab project --json вернул не JSON — проект не узнать');
  }
  if (info === null || typeof info !== 'object' || Array.isArray(info) || info.error) {
    throw new Blocked('collab project --json не сообщил проект');
  }
  return info;
}

async function loadProjectSettings(cwd, env) {
  const home = env.HOME || env.USERPROFILE || '';
  if (!path.isAbsolute(home)) throw new Blocked('HOME не задан — настройки проекта не прочитать');
  let isDir = false;
  try {
    isDir = typeof cwd === 'string' && path.isAbsolute(cwd) && statSync(cwd).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw new Blocked('нет рабочего каталога — настройки проекта не прочитать');
  const info = await collabProjectStrict(cwd, home);
  const projectId = info.projectId ?? null;
  if (projectId === null) return {};
  const registry = info.registryDir;
  if (typeof projectId !== 'string' || !PROJECT_ID_RE.test(projectId)) throw new Blocked('collab вернул некорректный projectId');
  if (typeof registry !== 'string' || !path.isAbsolute(registry)) throw new Blocked('collab не сообщил абсолютный registryDir');
  const file = path.join(registry, projectId, 'readonly-guard.json');
  let settings;
  try {
    settings = JSON.parse(decodeUtf8(readFileSync(file)));
  } catch (error) {
    if (error?.code === 'ENOENT') settings = {};
    else throw new Blocked(`не удалось прочитать ${file} (${error?.message ?? error})`);
  }
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings) || Object.keys(settings).some((k) => !SETTINGS_KEYS.includes(k))) {
    throw new Blocked(`${file}: ожидается объект с ключами ${SETTINGS_KEYS.join(', ')}`);
  }
  const platforms = settings.platforms ?? [];
  if (!Array.isArray(platforms) || platforms.some((p) => typeof p !== 'string' || !Object.hasOwn(PLATFORM_POLICIES, p))) {
    throw new Blocked(`${file}: platforms — список из ${Object.keys(PLATFORM_POLICIES).sort().join(', ')}`);
  }
  return settings;
}

const COMMAND_WORD = /^[A-Za-z0-9_./+-]+$/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const ABSOLUTE_DIRS = ['/bin/', '/usr/bin/'];

async function checkSimpleCommand(items, context) {
  const { cwd, env } = context;
  const words = items.filter((t) => t instanceof Word);
  const head = words[0];
  const args = words.slice(1);
  if (head.quoted) throw new Blocked('слово команды в кавычках — так маскируют имя команды');
  if (head.glob) throw new Blocked('глоб-символы в слове команды');
  if (ASSIGNMENT.test(head.text)) throw new Blocked(`присваивание \`${head.text.split('=')[0]}=…\` перед командой (или само по себе) запрещено`);
  if (!COMMAND_WORD.test(head.text)) throw new Blocked(`недопустимые символы в слове команды ${JSON.stringify(head.text.slice(0, 40))}`);
  for (const a of args) {
    if (a.glob && '-*?['.includes(a.text[0] ?? '\0')) {
      throw new Blocked(`аргумент \`${a.text.slice(0, 40)}\` начинается с глоб-символа или \`-\` и может раскрыться во флаг — начни его с \`./\` или возьми в кавычки`);
    }
  }
  const text = head.text;
  let name;
  if (text.startsWith('/')) {
    const home = env.HOME || '';
    const collabPaths = IS_WINDOWS ? [] : ['/opt/homebrew/bin/collab', ...(home.startsWith('/') ? [path.join(home, '.agent-collab-kit', 'current', 'bin', 'collab')] : [])];
    if (collabPaths.includes(text)) {
      name = 'collab';
    } else {
      const idx = text.lastIndexOf('/');
      const directory = text.slice(0, idx);
      name = text.slice(idx + 1);
      if (IS_WINDOWS || !ABSOLUTE_DIRS.includes(`${directory}/`) || (!ALLOWLIST.has(name) && !PLATFORM_COMMANDS.has(name))) {
        throw new Blocked(`команда \`${text}\` не входит в allowlist verifier (абсолютные пути — только /bin, /usr/bin для разрешённых команд)`);
      }
    }
  } else if (text.includes('/')) {
    resolveInsideCwd(cwd, text, true);
    return; // гейт проекта или скрипт проекта: аргументы уходят коду проекта
  } else {
    name = text;
  }
  let policy = ALLOWLIST.get(name);
  if (!policy && PLATFORM_COMMANDS.has(name)) {
    context.settings ??= loadProjectSettings(cwd, env);
    const settings = await context.settings;
    for (const group of settings.platforms ?? []) {
      if (PLATFORM_POLICIES[group].has(name)) policy = PLATFORM_POLICIES[group].get(name);
    }
    if (!policy) {
      throw new Blocked(`команда \`${name}\` — платформенная; проект не включил её группу в реестре (~/agent-collab-kit/projects/<id>/readonly-guard.json, "platforms")`);
    }
  }
  if (!policy) throw new Blocked(`команда \`${text}\` не входит в allowlist verifier`);
  policy(name, args, cwd);
}

export async function checkCommand(command, context) {
  const tokens = tokenize(command);
  for (const simple of splitSimpleCommands(tokens)) await checkSimpleCommand(simple, context);
}

// ── событие хука и обвязка ────────────────────────────────────────────────────

async function decide({ stdinBuffer, env }) {
  let text;
  try {
    text = decodeUtf8(stdinBuffer);
  } catch {
    throw new Blocked('событие хука не является JSON в UTF-8 — команда заблокирована на всякий случай');
  }
  if (text.trim() === '') throw new Blocked('пустое событие хука — команда заблокирована на всякий случай');
  let event;
  try {
    event = JSON.parse(text);
  } catch {
    throw new Blocked('событие хука не является JSON в UTF-8 — команда заблокирована на всякий случай');
  }
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    throw new Blocked('событие хука имеет неожиданный формат (не объект) — команда заблокирована');
  }
  if (event.tool_name !== 'Bash') {
    throw new Blocked(`неожиданный tool_name ${JSON.stringify(event.tool_name ?? null)} — хук подключён только к Bash, команда заблокирована`);
  }
  const toolInput = event.tool_input;
  if (toolInput === null || typeof toolInput !== 'object' || Array.isArray(toolInput)) {
    throw new Blocked('в событии нет объекта tool_input — команда заблокирована');
  }
  const command = toolInput.command;
  if (typeof command !== 'string' || command.trim() === '') throw new Blocked('в событии нет строки tool_input.command — команда заблокирована');
  if (command.includes('\0')) throw new Blocked('команда содержит NUL-байт — заблокирована');
  if (!command.isWellFormed()) throw new Blocked('команда содержит символы, непредставимые в UTF-8 — заблокирована');
  try {
    await checkCommand(command, { cwd: event.cwd, env });
  } catch (error) {
    if (error instanceof Blocked) throw new Blocked(`${error.message} — команда заблокирована. ${ADVICE}`);
    throw error;
  }
  return 0;
}

export async function main(context) {
  const { stderr } = context;
  const emit = (message) => {
    try {
      stderr(`readonly-guard: ${message}\n`);
    } catch {
      // сообщение не критично, код выхода — да
    }
  };
  let timer;
  const watchdog = new Promise((resolve) => {
    timer = setTimeout(() => {
      emit(`проверка не уложилась в ${WATCHDOG_MS / 1000} с — команда заблокирована на всякий случай`);
      resolve(2);
    }, WATCHDOG_MS);
  });
  try {
    const verdict = decide(context).then(
      (result) => (result === 0 ? 0 : 2),
      (error) => {
        if (error instanceof Blocked) emit(error.message);
        else emit(`внутренняя ошибка хука (${error?.name ?? typeof error}) — команда заблокирована на всякий случай`);
        return 2;
      },
    );
    return await Promise.race([verdict, watchdog]);
  } catch {
    emit('внутренняя ошибка хука — команда заблокирована на всякий случай');
    return 2;
  } finally {
    clearTimeout(timer);
    killActiveChildren();
  }
}
