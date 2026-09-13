#!/usr/bin/python3
"""PreToolUse-хук (Bash) для субагента verifier: allowlist с запретом по умолчанию.

verifier проверяет чужую работу: читает файлы и историю git, запускает гейт проекта,
тест-раннеры и сборку для тестов. Он не меняет файлы, git, зависимости, устройства и
удалённые сервисы. Два независимых ревью показали, что denylist по шаблонам не
удерживается (подстановки, функции shell, `git -c alias.*`, `vim -es`, `arch …`,
`simctl --set`). Поэтому здесь наоборот: разрешено только то, что перечислено, всё
остальное — блок.

Как это устроено:
  1. Консервативный токенизатор. Всё, что он не может полностью объяснить, — блок:
     `$`, обратные кавычки, `( )`, `{ }`, `<` в любой форме (heredoc, here-string,
     `<(…)`, `< файл`), `&` (фон, `&>`), `\\` вне кавычек, `~`, `!`, `#`, слово с `=`
     в начале, любое перенаправление, кроме `>/dev/null`, `2>/dev/null`, `2>&1`.
  2. Команда делится по `;`, переводу строки, `&&`, `||`, `|` на простые команды;
     каждая проверяется отдельно. Присваивания перед командой (`VAR=x cmd`) — блок.
  3. Слово команды ищется в ALLOWLIST (точное имя или `/bin/`, `/usr/bin/` + имя);
     у каждой команды своя политика аргументов. Относительный путь (`./x`,
     `scripts/x`) — только к существующему исполняемому обычному файлу внутри
     cwd (realpath). Неизвестное слово — блок с подсказкой «не проверено».
  4. Тест-раннеры, сборка и гейт исполняют код проекта: это доверие к проекту,
     а не песочница. Границы и остаточные риски — hooks/SECURITY-hooks.md.

Семантика Claude Code: exit 2 = блок (stderr уходит агенту); любой другой код,
падение или таймаут — команда ПРОХОДИТ. Поэтому любой нештатный путь (мусор на
stdin, не тот tool_name, нет строки command, исключение, зависание) — exit 2, а
строка запуска во frontmatter добавляет `|| exit 2`.
"""
import json
import os
import re
import signal
import stat
import sys

# Сторож: таймаут хука во frontmatter — 10 с; сработать надо раньше хоста.
WATCHDOG_SECONDS = 5

ADVICE = "verifier не обходит блок: отметь шаг как «не проверено» или попроси лида выполнить его."


class Blocked(Exception):
    pass


class WatchdogFired(BaseException):
    pass


# --- токенизатор ---------------------------------------------------------------


class Word(object):
    __slots__ = ("text", "quoted", "glob")

    def __init__(self, text, quoted, glob):
        self.text = text
        self.quoted = quoted  # часть слова была в кавычках
        self.glob = glob  # в слове есть незакавыченные `*`, `?`, `[`


class Redirect(object):
    __slots__ = ("fd", "target")

    def __init__(self, fd, target):
        self.fd = fd
        self.target = target


OPERATORS = (";", "&&", "||", "|")
_GLOB_CHARS = "*?["
_META_UNQUOTED = {
    "$": "подстановка `$` (переменные, `$(…)`, `$'…'`)",
    "`": "подстановка в обратных кавычках",
    "(": "скобка `(` (подоболочка, функция, `<(…)`)",
    ")": "скобка `)`",
    "{": "фигурная скобка `{` (группа, brace expansion)",
    "}": "фигурная скобка `}`",
    "<": "перенаправление ввода `<` (heredoc, here-string, `<(…)`, `< файл`)",
    "~": "тильда `~` (раскрытие домашнего каталога)",
    "!": "символ `!`",
    "\\": "обратный слеш вне кавычек (экранирование, перенос строки)",
}
_WORD_BREAK = " \t\n;|&"


def tokenize(command):
    """Разбирает строку на Word / Redirect / оператор. Всё сомнительное — Blocked."""
    tokens = []
    buf = []
    state = {"in_word": False, "quoted": False, "glob": False}

    def flush():
        if state["in_word"]:
            tokens.append(Word("".join(buf), state["quoted"], state["glob"]))
        del buf[:]
        state["in_word"] = state["quoted"] = state["glob"] = False

    def followed_by_break(pos):
        return pos >= n or command[pos] in _WORD_BREAK

    i = 0
    n = len(command)
    while i < n:
        ch = command[i]
        if ch == "'":
            j = command.find("'", i + 1)
            if j < 0:
                raise Blocked("незакрытая одинарная кавычка")
            buf.append(command[i + 1:j])
            state["in_word"] = state["quoted"] = True
            i = j + 1
            continue
        if ch == '"':
            i += 1
            state["in_word"] = state["quoted"] = True
            while True:
                if i >= n:
                    raise Blocked("незакрытая двойная кавычка")
                c = command[i]
                if c == '"':
                    i += 1
                    break
                if c == "\\":
                    if i + 1 >= n:
                        raise Blocked("обратный слеш в конце строки")
                    nxt = command[i + 1]
                    if nxt == "\n":
                        raise Blocked("перенос строки через `\\` внутри кавычек")
                    if nxt in '$`"\\':
                        buf.append(nxt)
                        i += 2
                        continue
                    buf.append(c)
                    i += 1
                    continue
                if c in "$`":
                    raise Blocked("подстановка `%s` внутри двойных кавычек" % c)
                if c != "\t" and (ord(c) < 32 or c == "\x7f") and c != "\n":
                    raise Blocked("управляющий символ внутри кавычек")
                buf.append(c)
                i += 1
            continue
        if ch in " \t":
            flush()
            i += 1
            continue
        if ch == "\n":
            flush()
            tokens.append(";")
            i += 1
            continue
        if ch in _META_UNQUOTED:
            raise Blocked(_META_UNQUOTED[ch])
        if ch == "#" and not state["in_word"]:
            raise Blocked("комментарий `#` — убери его из команды")
        if ch == "=" and not state["in_word"]:
            raise Blocked("слово начинается с `=`")
        if ch == "&":
            if command.startswith("&&", i):
                flush()
                tokens.append("&&")
                i += 2
                continue
            raise Blocked("символ `&` (фоновый запуск, `&>`, `|&`)")
        if ch == "|":
            flush()
            if command.startswith("||", i):
                tokens.append("||")
                i += 2
            elif command.startswith("|&", i):
                raise Blocked("оператор `|&`")
            else:
                tokens.append("|")
                i += 1
            continue
        if ch == ";":
            if command.startswith(";;", i):
                raise Blocked("оператор `;;`")
            flush()
            tokens.append(";")
            i += 1
            continue
        if ch == ">":
            fd = 1
            if state["in_word"]:
                if buf and not state["quoted"] and not state["glob"] and "".join(buf).isdigit():
                    fd = int("".join(buf))
                    del buf[:]
                    state["in_word"] = False
                else:
                    flush()
            i += 1
            if i < n and command[i] in ">|(":
                raise Blocked("перенаправление `>%s`" % command[i])
            if i < n and command[i] == "&":
                if fd == 2 and command.startswith("&1", i) and followed_by_break(i + 2):
                    tokens.append(Redirect(2, "&1"))
                    i += 2
                    continue
                raise Blocked("перенаправление дескриптора `>&` (разрешено только `2>&1`)")
            while i < n and command[i] in " \t":
                i += 1
            if fd in (1, 2) and command.startswith("/dev/null", i) and followed_by_break(i + 9):
                tokens.append(Redirect(fd, "/dev/null"))
                i += 9
                continue
            raise Blocked("перенаправление вывода в файл (разрешены только `>/dev/null`, `2>/dev/null`, `2>&1`)")
        if ord(ch) < 32 or ch == "\x7f":
            raise Blocked("управляющий символ в команде")
        if ch in _GLOB_CHARS:
            state["glob"] = True
        buf.append(ch)
        state["in_word"] = True
        i += 1
    flush()
    return tokens


def split_simple_commands(tokens):
    """Делит поток токенов по `;` `&&` `||` `|`; каждая простая команда — список Word/Redirect."""
    commands = []
    current = []
    for tok in tokens:
        if isinstance(tok, str) and tok in OPERATORS:
            if not any(isinstance(t, Word) for t in current):
                raise Blocked("пустая команда рядом с оператором `%s`" % tok)
            commands.append(current)
            current = []
        else:
            current.append(tok)
    if any(isinstance(t, Word) for t in current):
        commands.append(current)
    elif current:
        raise Blocked("перенаправление без команды")
    elif tokens and tokens[-1] in ("&&", "||", "|"):
        raise Blocked("команда обрывается на операторе `%s`" % tokens[-1])
    if not commands:
        raise Blocked("пустая команда")
    return commands


# --- политики аргументов ---------------------------------------------------------


def texts(args):
    return [a.text for a in args]


def reject_args(cmd, args, exact=(), prefixes=(), short_letters=""):
    for a in texts(args):
        if a in exact or any(a.startswith(p) for p in prefixes):
            raise Blocked("`%s %s` не разрешён (флаг может писать или запускать код)" % (cmd, a))
        if short_letters and len(a) > 1 and a[0] == "-" and a[1] != "-":
            for letter in short_letters:
                if letter in a[1:]:
                    raise Blocked("`%s -%s` не разрешён" % (cmd, letter))


def check_relative_path(cmd, value):
    """Аргумент-путь тест-раннера: относительный, без `..`, не флаг."""
    if not value or value.startswith("-"):
        raise Blocked("`%s`: неизвестный флаг `%s`" % (cmd, value))
    if value.startswith("/"):
        raise Blocked("`%s`: абсолютный путь `%s` — можно только относительно cwd" % (cmd, value))
    head = value.split("::", 1)[0]
    if ".." in head.split("/"):
        raise Blocked("`%s`: путь `%s` выходит из cwd через `..`" % (cmd, value))


def resolve_inside_cwd(cwd, path, need_exec):
    """Файл существует, обычный, лежит внутри cwd (после realpath), при необходимости исполняемый."""
    if not isinstance(cwd, str) or not cwd.startswith("/"):
        raise Blocked("в событии нет абсолютного cwd — запуск скрипта по пути нельзя проверить")
    if path.startswith("/"):
        raise Blocked("путь `%s` абсолютный — скрипт должен лежать внутри cwd" % path)
    root = os.path.realpath(cwd)
    real = os.path.realpath(os.path.join(cwd, path))
    if not real.startswith(root.rstrip("/") + "/"):
        raise Blocked("путь `%s` ведёт за пределы cwd" % path)
    try:
        st = os.stat(real)
    except OSError:
        raise Blocked("файл `%s` не найден внутри cwd" % path)
    if not stat.S_ISREG(st.st_mode):
        raise Blocked("`%s` — не обычный файл" % path)
    if need_exec and not os.access(real, os.X_OK):
        raise Blocked("`%s` не исполняемый" % path)


def any_args(cmd, args, cwd):
    return None


def no_args(cmd, args, cwd):
    if args:
        raise Blocked("`%s` разрешён только без аргументов" % cmd)


def policy_command(cmd, args, cwd):
    t = texts(args)
    if len(t) < 2 or t[0] != "-v" or any(a.startswith("-") for a in t[1:]):
        raise Blocked("`command` разрешён только в форме `command -v имя`")


def policy_date(cmd, args, cwd):
    t = texts(args)
    for i, a in enumerate(t):
        if a in ("-f", "-s", "--set") or a.startswith("--set="):
            raise Blocked("`date %s` может менять системное время" % a)
        if a.startswith("-") or a.startswith("+"):
            continue
        if i > 0 and t[i - 1] in ("-r", "-v"):
            continue
        raise Blocked("`date` с позиционным аргументом может менять системное время")


def policy_file(cmd, args, cwd):
    allowed_long = ("--mime", "--mime-type", "--mime-encoding", "--brief", "--version", "--help",
                    "--dereference", "--no-dereference", "--separator", "--files-from")
    for a in texts(args):
        if a.startswith("--") and a not in allowed_long and not a.startswith("--separator="):
            raise Blocked("`file %s` не разрешён" % a)
    reject_args(cmd, args, short_letters="C")


def policy_rg(cmd, args, cwd):
    reject_args(cmd, args, exact=("--pre", "--pre-glob"), prefixes=("--pre=", "--pre-glob="))


def policy_find(cmd, args, cwd):
    reject_args(cmd, args, exact=("-delete", "-exec", "-execdir", "-ok", "-okdir", "-fls"),
                prefixes=("-fprint",))


_SORT_LONG = ("--reverse", "--numeric-sort", "--unique", "--ignore-case", "--stable", "--version-sort",
              "--human-numeric-sort", "--month-sort", "--general-numeric-sort", "--zero-terminated",
              "--check", "--dictionary-order", "--ignore-leading-blanks", "--ignore-nonprinting",
              "--random-sort", "--debug", "--help", "--version")


def policy_sort(cmd, args, cwd):
    for a in texts(args):
        if a.startswith("--") and a not in _SORT_LONG and not a.startswith(("--key=", "--field-separator=",
                                                                              "--parallel=", "--buffer-size=")):
            raise Blocked("`sort %s` не разрешён (длинные опции — только из известного списка)" % a)
    reject_args(cmd, args, short_letters="oT")


def policy_uniq(cmd, args, cwd):
    t = texts(args)
    positional = 0
    skip = False
    for a in t:
        if skip:
            skip = False
            continue
        if a in ("-f", "-s", "-w"):
            skip = True
            continue
        if a.startswith("-"):
            continue
        positional += 1
    if positional > 1:
        raise Blocked("`uniq` со вторым позиционным аргументом пишет в выходной файл")


def policy_plutil(cmd, args, cwd):
    t = texts(args)
    if not t or t[0] not in ("-p", "-lint") or any(a.startswith("-") for a in t[1:]):
        raise Blocked("`plutil` разрешён только как `plutil -p …` или `plutil -lint …`")


def policy_xcode_select(cmd, args, cwd):
    t = texts(args)
    if not t or any(a not in ("-p", "--print-path", "-v", "--version") for a in t):
        raise Blocked("`xcode-select` разрешён только с `-p`/`--print-path`/`--version`")


# --- git ---------------------------------------------------------------------------

_GIT_DIFF_LIKE_REJECT = ("--output", "--ext-diff", "--textconv", "--filters")
_GIT_DIFF_LIKE_PREFIX = ("--output=", "--output-")
_GIT_BRANCH_FLAGS = ("--list", "-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--show-current",
                     "--no-color", "--color=never")
_GIT_CONFIG_SCOPES = ("--global", "--local", "--system", "--worktree", "--show-origin", "--show-scope",
                      "--name-only", "-z", "--null")
_GIT_CONFIG_ACTIONS = ("--get", "--get-all", "--get-regexp", "--list", "-l", "get", "list")


def git_reader(sub, args):
    reject_args("git " + sub, args, exact=_GIT_DIFF_LIKE_REJECT, prefixes=_GIT_DIFF_LIKE_PREFIX)
    if sub == "grep":
        reject_args("git grep", args, prefixes=("-O", "--open-files-in-pager"))


def git_branch(sub, args):
    for a in texts(args):
        if a not in _GIT_BRANCH_FLAGS:
            raise Blocked("`git branch %s` не разрешён (только список: без аргументов, --list, -a, -r, -v, --show-current)" % a)


def git_worktree(sub, args):
    t = texts(args)
    if not t or t[0] != "list" or any(not a.startswith("-") for a in t[1:]):
        raise Blocked("`git worktree` разрешён только как `git worktree list [опции]`")


def git_remote(sub, args):
    if any(a not in ("-v", "--verbose") for a in texts(args)):
        raise Blocked("`git remote` разрешён только без аргументов или с `-v`")


def git_config(sub, args):
    actions = 0
    for a in texts(args):
        if a in _GIT_CONFIG_ACTIONS:
            actions += 1
        elif a in _GIT_CONFIG_SCOPES:
            continue
        elif a.startswith("-"):
            raise Blocked("`git config %s` не разрешён" % a)
    if actions != 1:
        raise Blocked("`git config` разрешён только для чтения: `--get`, `--get-all`, `--get-regexp`, `--list`/`-l`")


def git_stash(sub, args):
    t = texts(args)
    if not t or t[0] not in ("list", "show"):
        raise Blocked("`git stash` разрешён только как `git stash list` / `git stash show`")
    git_reader("stash " + t[0], args[1:])


def git_tag(sub, args):
    t = texts(args)
    if not t:
        return
    if not any(a in ("-l", "--list") for a in t):
        raise Blocked("`git tag` разрешён только без аргументов или с `-l`/`--list`")
    for a in t:
        if a.startswith("-") and a not in ("-l", "--list") and not re.match(r"^-n\d*$", a):
            raise Blocked("`git tag %s` не разрешён" % a)


GIT_SUBCOMMANDS = {
    "status": git_reader, "diff": git_reader, "log": git_reader, "show": git_reader, "blame": git_reader,
    "ls-files": git_reader, "ls-tree": git_reader, "cat-file": git_reader, "rev-parse": git_reader,
    "rev-list": git_reader, "describe": git_reader, "shortlog": git_reader, "grep": git_reader,
    "merge-base": git_reader,
    "branch": git_branch, "worktree": git_worktree, "remote": git_remote, "config": git_config,
    "stash": git_stash, "tag": git_tag,
}


def policy_git(cmd, args, cwd):
    t = texts(args)
    if t and t[0] == "--no-pager":  # единственная разрешённая глобальная опция: влияет лишь на вывод
        args = args[1:]
        t = t[1:]
    if not t:
        raise Blocked("`git` без подкоманды")
    if t == ["--version"]:
        return
    sub = t[0]
    if sub.startswith("-"):
        raise Blocked("глобальные опции git (`%s`) запрещены: `-c`, `-C`, `--git-dir`, `-p` и др. меняют, что исполняется" % sub)
    handler = GIT_SUBCOMMANDS.get(sub)
    if handler is None:
        raise Blocked("подкоманда `git %s` не входит в allowlist (алиасы тоже)" % sub)
    handler(sub, args[1:])


# --- тест-раннеры и сборка -----------------------------------------------------

_NODE_TEST_FLAGS = ("--test-only", "--test-force-exit", "--test-coverage", "--experimental-test-coverage",
                    "--test-update-snapshots")
_NODE_TEST_VALUE = ("--test-name-pattern", "--test-skip-pattern", "--test-concurrency", "--test-timeout",
                    "--test-reporter", "--test-isolation", "--test-shard")
_NODE_REPORTERS = ("spec", "tap", "dot", "junit", "lcov")


def policy_node(cmd, args, cwd):
    t = texts(args)
    if t in (["--version"], ["-v"]):
        return
    if len(t) == 2 and t[0] in ("--check", "-c"):
        check_relative_path("node --check", t[1])
        return
    if not t or t[0] != "--test":
        raise Blocked("`node` разрешён только как `node --test …` или `node --check <файл>`")
    i = 1
    while i < len(t):
        a = t[i]
        if a in _NODE_TEST_FLAGS:
            i += 1
            continue
        name, eq, value = a.partition("=")
        if name in _NODE_TEST_VALUE:
            if not eq:
                i += 1
                if i >= len(t):
                    raise Blocked("`node %s` без значения" % name)
                value = t[i]
            if name == "--test-reporter" and value not in _NODE_REPORTERS:
                raise Blocked("`node --test-reporter=%s` загружает модуль — разрешены только %s"
                              % (value, ", ".join(_NODE_REPORTERS)))
            i += 1
            continue
        check_relative_path("node --test", a)
        i += 1


_PYTEST_FLAGS = ("-v", "-vv", "-vvv", "-q", "-qq", "-x", "-s", "-l", "--showlocals", "--co", "--collect-only",
                 "--lf", "--last-failed", "--ff", "--failed-first", "--no-header", "--no-summary",
                 "--strict-markers", "--disable-warnings", "--verbose", "--quiet", "--exitfirst", "--version",
                 "--fixtures", "--markers", "-h", "--help")
_PYTEST_VALUE = ("-k", "-m", "-W", "-p", "--tb", "--maxfail", "--durations", "--durations-min", "--timeout",
                 "--color", "--capture", "--ignore", "--deselect")
_UNITTEST_FLAGS = ("-v", "--verbose", "-q", "--quiet", "-f", "--failfast", "-b", "--buffer", "--catch",
                   "--locals", "-h", "--help", "discover")
_UNITTEST_VALUE = ("-k", "--durations", "-s", "--start-directory", "-t", "--top-level-directory", "-p",
                   "--pattern")


def _check_runner_options(runner, t, flags, value_opts, path_value_opts=()):
    i = 0
    while i < len(t):
        a = t[i]
        if a in flags or (runner == "pytest" and re.match(r"^-r[a-zA-Z]+$", a)):
            i += 1
            continue
        name, eq, value = a.partition("=")
        if name in value_opts:
            if not eq:
                i += 1
                if i >= len(t):
                    raise Blocked("`%s %s` без значения" % (runner, name))
                value = t[i]
            if runner == "pytest" and name == "-p" and not value.startswith("no:"):
                raise Blocked("`pytest -p %s` загружает плагин — разрешено только `-p no:<имя>`" % value)
            if name in path_value_opts:
                check_relative_path(runner + " " + name, value)
            i += 1
            continue
        if a.startswith("-"):
            raise Blocked("`%s %s` не входит в allowlist опций" % (runner, a))
        check_relative_path(runner, a)
        i += 1


def policy_python(cmd, args, cwd):
    t = texts(args)
    if t in (["--version"], ["-V"]):
        return
    if len(t) < 2 or t[0] != "-m" or t[1] not in ("unittest", "pytest"):
        raise Blocked("`python3` разрешён только как `python3 -m unittest …` или `python3 -m pytest …`")
    if t[1] == "unittest":
        _check_runner_options("unittest", t[2:], _UNITTEST_FLAGS, _UNITTEST_VALUE,
                              path_value_opts=("-s", "--start-directory", "-t", "--top-level-directory"))
    else:
        _check_runner_options("pytest", t[2:], _PYTEST_FLAGS, _PYTEST_VALUE, path_value_opts=("--ignore",))


def _npm_like(cmd, t, allow_run):
    if t in (["--version"], ["-v"]):
        return
    if not t:
        raise Blocked("`%s` без аргументов ставит зависимости" % cmd)
    if t[0] == "test":
        rest = t[1:]
    elif allow_run and t[0] == "run":
        rest = t[1:]
        if rest and not rest[0].startswith("-"):
            rest = rest[1:]
    else:
        raise Blocked("`%s %s` не разрешён (только `%s test`%s)" % (cmd, t[0], cmd, " и `npm run <script>`" if allow_run else ""))
    for a in rest:
        if a == "--":
            break
        if a.startswith("-"):
            raise Blocked("`%s`: флаг `%s` перед `--` меняет поведение менеджера пакетов" % (cmd, a))


def policy_npm(cmd, args, cwd):
    _npm_like("npm", texts(args), allow_run=True)


def policy_pnpm(cmd, args, cwd):
    _npm_like("pnpm", texts(args), allow_run=False)


def policy_yarn(cmd, args, cwd):
    _npm_like("yarn", texts(args), allow_run=False)


_SWIFT_FLAGS = ("-v", "--verbose", "-q", "--quiet", "--parallel", "--skip-build", "--skip-update",
                "--disable-automatic-resolution", "--enable-code-coverage", "--show-bin-path",
                "--list-tests", "-l", "--build-tests", "--very-verbose", "--vv")
_SWIFT_VALUE = ("-c", "--configuration", "--filter", "--skip", "--target", "--product", "-j", "--jobs",
                "--num-workers")


def policy_swift(cmd, args, cwd):
    t = texts(args)
    if t == ["--version"]:
        return
    if not t or t[0] not in ("build", "test"):
        raise Blocked("`swift` разрешён только как `swift build …` / `swift test …`")
    i = 1
    while i < len(t):
        a = t[i]
        if a in _SWIFT_FLAGS:
            i += 1
            continue
        name, eq, value = a.partition("=")
        if name in _SWIFT_VALUE:
            if not eq:
                i += 1
                if i >= len(t):
                    raise Blocked("`swift %s %s` без значения" % (t[0], name))
            i += 1
            continue
        raise Blocked("`swift %s %s` не входит в allowlist опций" % (t[0], a))


_XCB_VALUE = ("-project", "-workspace", "-scheme", "-target", "-configuration", "-destination", "-sdk", "-arch",
              "-toolchain", "-jobs", "-testPlan", "-destination-timeout")
_XCB_FLAGS = ("-list", "-showBuildSettings", "-showdestinations", "-showsdks", "-version", "-usage", "-help",
              "-json", "-quiet", "-verbose", "-parallelizeTargets", "-alltargets", "-skipUnavailableActions",
              "-disableAutomaticPackageResolution", "-skipPackageUpdates", "-onlyUsePackageVersionsFromResolvedFile",
              "-hideShellScriptEnvironment", "-showBuildTimingSummary", "-skipMacroValidation",
              "-skipPackagePluginValidation")
_XCB_ACTIONS = ("build", "build-for-testing")
_XCB_SETTINGS = ("CODE_SIGNING_ALLOWED", "CODE_SIGNING_REQUIRED", "CODE_SIGN_IDENTITY", "ONLY_ACTIVE_ARCH")


def policy_xcodebuild(cmd, args, cwd):
    t = texts(args)
    i = 0
    while i < len(t):
        a = t[i]
        if a in _XCB_VALUE:
            i += 1
            if i >= len(t):
                raise Blocked("`xcodebuild %s` без значения" % a)
            i += 1
            continue
        if a in _XCB_FLAGS or a in _XCB_ACTIONS:
            i += 1
            continue
        key, eq, _ = a.partition("=")
        if eq and key in _XCB_SETTINGS:
            i += 1
            continue
        if a.startswith("-"):
            raise Blocked("`xcodebuild %s` не входит в allowlist (в частности `-resolvePackageDependencies`, "
                          "`-derivedDataPath`, `-resultBundlePath`, `-allowProvisioningUpdates`)" % a)
        raise Blocked("действие `xcodebuild %s` запрещено: разрешены только `build` и `build-for-testing`" % a)


def policy_xcrun(cmd, args, cwd):
    t = texts(args)
    if len(t) >= 2 and t[0] == "simctl" and t[1] == "list":
        for a in t[2:]:
            if a.startswith("-") and a not in ("-j", "--json", "-v"):
                raise Blocked("`xcrun simctl list %s` не разрешён" % a)
        return
    if len(t) == 2 and t[0] == "--find" and not t[1].startswith("-"):
        return
    if t and all(a in ("--show-sdk-path", "--show-sdk-version", "--show-sdk-platform-path",
                       "--show-sdk-build-version", "--version") for a in t):
        return
    if len(t) == 3 and t[0] == "--sdk" and not t[1].startswith("-") and t[2] in ("--show-sdk-path", "--show-sdk-version"):
        return
    raise Blocked("`xcrun` разрешён только как `xcrun simctl list …`, `xcrun --find <tool>`, `xcrun --show-sdk-path`")


def policy_shell_script(cmd, args, cwd):
    t = texts(args)
    if not t:
        raise Blocked("`%s` без пути к скрипту читает команды со stdin" % cmd)
    if t[0].startswith("-"):
        raise Blocked("`%s %s` не разрешён: интерпретатору можно передать только путь к скрипту внутри cwd" % (cmd, t[0]))
    if args[0].glob:
        raise Blocked("путь к скрипту не должен содержать глоб-символы")
    resolve_inside_cwd(cwd, t[0], need_exec=False)


def policy_collab(cmd, args, cwd):
    if texts(args) not in (["project"], ["project", "--json"]):
        raise Blocked("`collab` разрешён только как `collab project [--json]`")


ALLOWLIST = {
    # чистые читатели
    "ls": any_args, "cat": any_args, "head": any_args, "tail": any_args, "wc": any_args, "stat": any_args,
    "du": any_args, "df": any_args, "pwd": any_args, "which": any_args, "echo": any_args, "printf": any_args,
    "uname": any_args, "whoami": any_args, "id": any_args, "grep": any_args, "egrep": any_args,
    "fgrep": any_args, "cut": any_args, "tr": any_args, "jq": any_args, "diff": any_args, "cmp": any_args,
    "comm": any_args, "basename": any_args, "dirname": any_args, "realpath": any_args, "readlink": any_args,
    "shasum": any_args, "md5": any_args, "sw_vers": any_args,
    "env": no_args, "command": policy_command, "date": policy_date, "file": policy_file, "rg": policy_rg,
    "find": policy_find, "sort": policy_sort, "uniq": policy_uniq, "plutil": policy_plutil,
    "xcode-select": policy_xcode_select,
    # git
    "git": policy_git,
    # тест-раннеры, сборка, гейт
    "node": policy_node, "python3": policy_python, "python": policy_python, "npm": policy_npm,
    "pnpm": policy_pnpm, "yarn": policy_yarn, "swift": policy_swift, "xcodebuild": policy_xcodebuild,
    "bash": policy_shell_script, "sh": policy_shell_script,
    # симулятор (чтение) и реестр проекта
    "xcrun": policy_xcrun, "collab": policy_collab,
}
ABSOLUTE_DIRS = ("/bin/", "/usr/bin/")
_COMMAND_WORD = re.compile(r"^[A-Za-z0-9_./+-]+$")
_ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")


def collab_binary_paths():
    paths = ["/opt/homebrew/bin/collab"]
    home = os.environ.get("HOME", "")
    if home.startswith("/"):
        paths.append(os.path.join(home, ".agent-kit", "current", "bin", "collab"))
    return paths


def check_simple_command(items, cwd):
    words = [t for t in items if isinstance(t, Word)]
    head = words[0]
    args = words[1:]
    if head.quoted:
        raise Blocked("слово команды в кавычках — так маскируют имя команды")
    if head.glob:
        raise Blocked("глоб-символы в слове команды")
    if _ASSIGNMENT.match(head.text):
        raise Blocked("присваивание `%s=…` перед командой (или само по себе) запрещено" % head.text.split("=", 1)[0])
    if not _COMMAND_WORD.match(head.text):
        raise Blocked("недопустимые символы в слове команды %r" % head.text[:40])
    for a in args:
        if a.glob and a.text[:1] in "-*?[":
            raise Blocked("аргумент `%s` начинается с глоб-символа или `-` и может раскрыться во флаг — "
                          "начни его с `./` или возьми в кавычки" % a.text[:40])
    text = head.text
    if text.startswith("/"):
        if text in collab_binary_paths():
            name = "collab"
        else:
            directory, name = os.path.split(text)
            if directory + "/" not in ABSOLUTE_DIRS or name not in ALLOWLIST:
                raise Blocked("команда `%s` не входит в allowlist verifier (абсолютные пути — только /bin, /usr/bin для "
                              "разрешённых команд)" % text)
    elif "/" in text:
        resolve_inside_cwd(cwd, text, need_exec=True)
        return  # гейт проекта или скрипт проекта: аргументы уходят коду проекта
    else:
        name = text
    policy = ALLOWLIST.get(name)
    if policy is None:
        raise Blocked("команда `%s` не входит в allowlist verifier" % text)
    policy(name, args, cwd)


def check_command(command, cwd):
    """Возвращает None, если команда разрешена; иначе бросает Blocked."""
    tokens = tokenize(command)
    for simple in split_simple_commands(tokens):
        check_simple_command(simple, cwd)


# --- событие хука и обвязка ----------------------------------------------------


def emit(message):
    try:
        sys.stderr.buffer.write(("readonly-guard: %s\n" % message).encode("utf-8", "backslashreplace"))
        sys.stderr.buffer.flush()
    except BaseException:  # noqa: BLE001 - сообщение не критично, код выхода — да
        pass


def decide():
    try:
        raw = sys.stdin.buffer.read()
    except OSError as exc:
        raise Blocked("не удалось прочитать событие хука (%s) — команда заблокирована на всякий случай" % exc)
    if not raw.strip():
        raise Blocked("пустое событие хука — команда заблокирована на всякий случай")
    try:
        event = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise Blocked("событие хука не является JSON в UTF-8 — команда заблокирована на всякий случай")
    if not isinstance(event, dict):
        raise Blocked("событие хука имеет неожиданный формат (не объект) — команда заблокирована")
    if event.get("tool_name") != "Bash":
        raise Blocked("неожиданный tool_name %r — хук подключён только к Bash, команда заблокирована"
                      % (event.get("tool_name"),))
    tool_input = event.get("tool_input")
    if not isinstance(tool_input, dict):
        raise Blocked("в событии нет объекта tool_input — команда заблокирована")
    command = tool_input.get("command")
    if not isinstance(command, str) or not command.strip():
        raise Blocked("в событии нет строки tool_input.command — команда заблокирована")
    if "\x00" in command:
        raise Blocked("команда содержит NUL-байт — заблокирована")
    try:
        command.encode("utf-8")
    except UnicodeEncodeError:
        raise Blocked("команда содержит символы, непредставимые в UTF-8 — заблокирована")

    try:
        check_command(command, event.get("cwd"))
    except Blocked as exc:
        raise Blocked("%s — команда заблокирована. %s" % (exc, ADVICE))
    return 0


def _on_alarm(signum, frame):
    raise WatchdogFired()


def entrypoint():
    code = 2
    try:
        signal.signal(signal.SIGALRM, _on_alarm)
        signal.alarm(WATCHDOG_SECONDS)
        try:
            result = decide()
            code = 0 if (type(result) is int and result == 0) else 2
        except Blocked as exc:
            emit(str(exc))
            code = 2
        finally:
            signal.alarm(0)
    except WatchdogFired:
        emit("проверка не уложилась в %d с — команда заблокирована на всякий случай" % WATCHDOG_SECONDS)
        code = 2
    except BaseException as exc:  # noqa: BLE001 - любой сбой = блок
        emit("внутренняя ошибка хука (%s) — команда заблокирована на всякий случай" % type(exc).__name__)
        code = 2
    os._exit(code)


if __name__ == "__main__":
    entrypoint()
