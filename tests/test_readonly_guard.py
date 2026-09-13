#!/usr/bin/env python3
"""Тесты для hooks/readonly-guard.py (PreToolUse на Bash у субагента verifier).

Хук — allowlist с запретом по умолчанию. Запускается как процесс тем же
интерпретатором, что во frontmatter (`/usr/bin/python3`, если есть). Claude Code
блокирует ТОЛЬКО по exit 2; любой другой код, падение или таймаут — команда
проходит. Поэтому каждый нештатный путь обязан давать ровно 2.

Разделы:
  * нештатные входы и tool_name — fail-closed;
  * allow-set: команды, которые verifier должен уметь запускать, проходят;
  * обходы старого denylist из ревью — блокируются;
  * токенизатор: всё, что shell мог бы истолковать иначе, — блок;
  * политики аргументов по семействам (git, читатели, раннеры, xcode, simctl);
  * скрипты по пути: только обычный файл внутри cwd (realpath);
  * сторож, сбой внутри хука, длинные команды;
  * точная строка запуска из agents/verifier.md через `sh -c`.

Опасные команды в тестах НЕ исполняются — проверяется только классификация.
Запуск: `PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -m unittest -v tests/test_readonly_guard.py`
из каталога черновиков.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

DRAFTS = Path(__file__).resolve().parent.parent
HOOK_PATH = DRAFTS / "hooks" / "readonly-guard.py"
VERIFIER_MD = DRAFTS / "agents" / "verifier.md"

FRONTMATTER_PYTHON = "/usr/bin/python3"
PYTHON = FRONTMATTER_PYTHON if os.path.exists(FRONTMATTER_PYTHON) else sys.executable
CYRILLIC = re.compile(r"[А-Яа-яЁё]")
ENV = {"HOME": "/nonexistent", "PATH": "/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1"}


def run_guard(stdin, timeout=20):
    if isinstance(stdin, dict):
        stdin = json.dumps(stdin)
    if isinstance(stdin, str):
        stdin = stdin.encode("utf-8", "surrogatepass")
    proc = subprocess.run([PYTHON, str(HOOK_PATH)], input=stdin, capture_output=True, env=ENV, timeout=timeout)
    proc.stderr = proc.stderr.decode("utf-8", "replace")
    return proc


def bash(command, tool="Bash", cwd="/"):
    return {"tool_name": tool, "tool_input": {"command": command}, "cwd": cwd}


class GuardCase(unittest.TestCase):
    cwd = "/"

    def assertAllowed(self, command, cwd=None):
        proc = run_guard(bash(command, cwd=cwd or self.cwd))
        self.assertEqual(proc.returncode, 0, "%r must pass, stderr=%r" % (command, proc.stderr))
        self.assertEqual(proc.stderr, "")

    def assertBlocked(self, command, cwd=None, contains=()):
        proc = run_guard(bash(command, cwd=cwd or self.cwd))
        self.assertEqual(proc.returncode, 2, "%r must block, stderr=%r" % (command, proc.stderr))
        self.assertTrue(proc.stderr.startswith("readonly-guard: "), proc.stderr)
        self.assertRegex(proc.stderr, CYRILLIC)
        self.assertNotIn("Traceback", proc.stderr)
        self.assertIn("не проверено", proc.stderr)
        for fragment in contains:
            self.assertIn(fragment, proc.stderr)
        return proc.stderr

    def check_all(self, commands, expected):
        for command in commands:
            with self.subTest(command=command):
                if expected == 0:
                    self.assertAllowed(command)
                else:
                    self.assertBlocked(command)


class AbnormalInputTests(unittest.TestCase):
    """Любой нештатный вход — exit 2 и русское сообщение."""

    def assertBlocked(self, proc, what):
        self.assertEqual(proc.returncode, 2, "%s: rc=%s stderr=%r" % (what, proc.returncode, proc.stderr))
        self.assertRegex(proc.stderr, CYRILLIC, "%s: stderr must be a Russian message" % what)
        self.assertNotIn("Traceback", proc.stderr)

    def test_abnormal_inputs_block(self):
        cases = {
            "invalid json": b"not { valid json",
            "empty stdin": b"",
            "whitespace stdin": b"  \n",
            "non-utf8 bytes": b'{"tool_name": "Bash", "tool_input": {"command": "ls \xff"}}',
            "escaped NUL": json.dumps(bash("ls\x00")).encode(),
            "raw NUL": b'{"tool_name": "Bash", "tool_input": {"command": "ls\x00"}}',
            "lone surrogate": json.dumps(bash("ls PLACEHOLDER")).replace("PLACEHOLDER", "\\ud800").encode(),
            "array event": b"[]",
            "null event": b"null",
            "string event": b'"ls"',
            "no tool_input": b'{"tool_name": "Bash"}',
            "tool_input not object": b'{"tool_name": "Bash", "tool_input": "ls"}',
            "missing command": b'{"tool_name": "Bash", "tool_input": {}}',
            "int command": b'{"tool_name": "Bash", "tool_input": {"command": 42}}',
            "list command": b'{"tool_name": "Bash", "tool_input": {"command": ["ls"]}}',
            "null command": b'{"tool_name": "Bash", "tool_input": {"command": null}}',
            "empty command": b'{"tool_name": "Bash", "tool_input": {"command": "  \\n"}}',
        }
        for what, raw in cases.items():
            with self.subTest(what=what):
                self.assertBlocked(run_guard(raw), what)

    def test_missing_or_wrong_tool_name_blocks(self):
        for tool in (None, "", "bash", "Edit", "Write", "Read", 1):
            with self.subTest(tool=tool):
                event = bash("git status")
                if tool is None:
                    del event["tool_name"]
                else:
                    event["tool_name"] = tool
                self.assertBlocked(run_guard(event), "tool_name=%r" % (tool,))


class AllowSetTests(GuardCase):
    """Регрессия: то, что verifier должен уметь, проходит (exit 0, пустой stderr)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cwd = self.tmp.name
        scripts = Path(self.cwd) / "scripts"
        scripts.mkdir()
        gate = scripts / "preflight.sh"
        gate.write_text("#!/bin/sh\nexit 0\n")
        gate.chmod(0o755)

    def tearDown(self):
        self.tmp.cleanup()

    COORDINATOR_SET = (
        "git status", "git diff --stat", "git log -3 --oneline", "git show HEAD --stat", "git branch",
        "git worktree list", "git config --get user.name", "ls -la", "rg -n foo src", "/usr/bin/grep -rn x .",
        "cat README.md | head -20", "node --test tests/", "/usr/bin/python3 -m unittest -v tests/test_x.py",
        "scripts/preflight.sh --quiet", "xcodebuild -project X.xcodeproj -scheme S build-for-testing",
        "xcrun simctl list devices", "git log --oneline | wc -l", "find . -name '*.swift' -type f",
        "jq . package.json",
    )
    MORE_ALLOWED = (
        # git: чтение
        "git status --porcelain", "git --no-pager diff --stat", "git --no-pager log -5", "git --version",
        "git log --grep commit", "git log -p -- src/a.swift", "git log --format='%h %s' -3", "git blame f",
        "git ls-files", "git ls-tree HEAD", "git cat-file -p HEAD:f", "git rev-parse HEAD", "git rev-list --count HEAD",
        "git describe --tags", "git shortlog -sn", "git grep foo", "git merge-base main HEAD", "git diff --no-index a b",
        "git branch --list", "git branch -a", "git branch -r", "git branch -v", "git branch -vv",
        "git branch --show-current", "git branch 2>/dev/null", "git worktree list --porcelain", "git remote",
        "git remote -v", "git config --list", "git config -l", "git config --global --get user.email",
        "git config --get-all remote.origin.url", "git stash list", "git stash show -p", "git stash show 'stash@{0}'",
        "git tag", "git tag -l 'v*'", "git tag --list -n",
        # читатели
        "ls", "cat file", "head -5 file", "tail -n +5 file", "wc -l f", "file f", "file --mime-type f", "stat f",
        "du -sh .", "df -h", "pwd", "which rg", "command -v rg", "echo hi", "printf '%s\\n' x", "date", "date +%s",
        "date -u -r 0", "uname -a", "whoami", "id -u", "env", "env | sort", "grep -rn x .", "egrep -n x f",
        "rg foo", "rg 'a -> b'", "rg '$HOME'", "rg \"\\$HOME\"", "rg 'foo; rm x'", "rg -e pre f",
        "find . -type f -name '*.o'", "sort -rn f", "sort -k2,2n -t, f", "sort -u", "uniq -c", "uniq -f 1 f",
        "cut -d: -f1 f", "tr a-z A-Z", "jq 'map(. + 1)' f", "jq -r .name package.json", "jq --rawfile x f .",
        "diff -u a b", "cmp a b", "comm -12 a b", "basename /a/b", "dirname /a/b", "realpath .", "readlink f",
        "shasum -a 256 f", "md5 f", "plutil -p Info.plist", "plutil -lint Info.plist", "sw_vers",
        "sw_vers -productVersion", "xcode-select -p", "cat tests/*.py", "ls ./*.md", "rg привет src",
        # раннеры и сборка
        "node --test", "node --test --test-reporter=spec tests/", "node --test --test-name-pattern foo tests/",
        "node --check scripts/x.js", "node --version", "python3 -m unittest", "python3 -m unittest -v",
        "python3 -m unittest tests.test_x", "python3 -m unittest discover -s tests -p 'test_*.py'",
        "python3 -m pytest -q tests/", "python3 -m pytest -k foo -p no:cacheprovider tests/test_x.py::TestA",
        "python3 -m pytest -ra --tb=short", "python3 --version", "npm test", "npm test -- --grep x", "npm run",
        "npm run build", "npm run lint -- --fix=false", "pnpm test", "yarn test", "swift test", "swift build",
        "swift test --filter Foo", "swift build -c release", "swift --version", "xcodebuild -list",
        "xcodebuild build-for-testing -scheme X", "xcodebuild -showBuildSettings -scheme X",
        "xcodebuild -workspace W.xcworkspace -scheme S -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max'"
        " build-for-testing CODE_SIGNING_ALLOWED=NO", "xcodebuild -scheme S -quiet build",
        "bash scripts/preflight.sh", "sh scripts/preflight.sh --flag", "./scripts/preflight.sh",
        "/bin/bash scripts/preflight.sh", "/bin/sh scripts/preflight.sh",
        # симулятор и реестр
        "xcrun simctl list", "xcrun simctl list devices available -j", "xcrun --find swift", "xcrun --show-sdk-path",
        "xcrun --sdk iphonesimulator --show-sdk-path", "collab project --json", "collab project",
        # составные и перенаправления
        "ls >/dev/null 2>&1", "ls > /dev/null", "cat a 2>/dev/null", "cat a 2> /dev/null", "ls 2>&1 | head",
        "git status; git diff", "git status\ngit diff --stat\n", "git status && git diff", "ls || pwd",
        "git log --oneline | head -20 | wc -l", "git status\n",
    )

    def test_coordinator_allow_set(self):
        self.check_all(self.COORDINATOR_SET, 0)

    def test_more_allowed(self):
        self.check_all(self.MORE_ALLOWED, 0)


class DenylistBypassTests(GuardCase):
    """Обходы старого denylist из двух ревью — теперь блок."""

    BYPASSES = (
        "p=../../Users/x/victim; echo x > /private/tmp/$p",
        "p=../..",
        "git -c alias.x=commit x -m y",
        "git -c core.pager='rm victim' -p log",
        "git -c core.pager=x log",
        "git xx",  # пользовательский алиас
        "wipe(){ \"$@\"; }; wipe rm victim",
        "function wipe { rm x; }",
        "vim -Nu NONE -n -es -c 'call delete(\"victim\")' -c qa",
        "arch -arm64 osascript -e 'do shell script \"rm victim\"'",
        "xcrun simctl --set /tmp/device_set erase all",
        "xcrun simctl erase all",
    )

    def test_bypasses_block(self):
        self.check_all(self.BYPASSES, 2)


class TokenizerTests(GuardCase):
    """Всё, что shell мог бы истолковать иначе, чем видит хук, — блок."""

    REJECTED_SYNTAX = (
        "echo $HOME", "echo $IFS", "echo $'\\x72m' x", "echo $\"x\"", "echo ${HOME}", "echo $(rm x)", "echo `rm x`",
        "echo \"$HOME\"", "echo \"`rm x`\"", "cat <(ls)", "ls >(cat)", "{ rm x; }", "(rm x)", "echo {a,b}",
        "ls \\\nrm x", "ls\\\n", "\\rm x", "ls &", "ls & rm x", "ls &>/dev/null", "ls |& cat", "cat <<EOF\nrm x\nEOF",
        "cat <<< x", "cat < file", "cat </dev/fd/0", "cat </dev/stdin", "eval ls", "exec ls", "source env.sh",
        ". ./env.sh", ". x", "alias x=ls", "ls*", "l?", "[ -f x ]", "VAR=x ls", "FOO=1 git status", "ls ~",
        "ls ~/x", "ls !x", "! ls", "ls # comment", "# comment\nls", "=ls", "'ls'", "\"ls\"", "\"l\"s", "'r'm x",
        "ls\r", "ls\x01", "ls 'unterminated", "ls \"unterminated", "ls;;ls", "| ls", "ls |", "ls &&", "ls ||",
        ";", "ls; ; ls", "ls | | ls", ">/dev/null", "2>/dev/null",
        "echo hi > file", "echo hi >file", "echo hi >> file", "echo hi > /tmp/x", "echo hi > /private/tmp/x",
        "ls > /dev/null/x", "ls >/dev/nullx", "ls 2>err", "ls 1>out", "echo err >&2", "ls >&out", "ls 2>&12",
        "ls 3>/dev/null", "ls >| x", "ls > '/dev/null'", "git status\nrm x", "ls *.md", "ls -*", "ls ?x",
        "ls [a]*", "cat '-'*",
    )

    def test_rejected_syntax(self):
        self.check_all(self.REJECTED_SYNTAX, 2)

    def test_quoted_metacharacters_are_literal(self):
        self.check_all(("rg '$(rm x)'", "rg '`rm x`'", "rg '{a,b}'", "rg '(x)'", "rg '<file'", "rg '~'",
                        "rg 'a & b'", "rg 'a | b'", "rg 'a; rm x'", "rg '#x'", "rg 'x='", "echo \"a > b\"",
                        "echo \"\\$x\"", "echo 'x\ny'", "printf '%s\\n' a"), 0)

    def test_block_message_names_command_and_escalation(self):
        stderr = self.assertBlocked("osascript -e x", contains=("`osascript`", "не проверено", "лид"))
        self.assertIn("allowlist", stderr)
        self.assertBlocked("git commit -m x", contains=("`git commit`", "не проверено"))
        self.assertBlocked("echo $x", contains=("`$`",))


class DeniedCommandTests(GuardCase):
    """Всё вне allowlist — блок; у разрешённых команд опасные флаги — блок."""

    UNKNOWN_COMMANDS = (
        "rm x", "rm -rf build", "mv a b", "cp a b", "mkdir d", "touch f", "chmod +x f", "ln -s a b", "sed -n 1p f",
        "sed -i s/a/b/ f", "awk '{print}' f", "perl -e 1", "ruby x.rb", "tee out", "tee /dev/null", "xargs ls",
        "curl -s https://x", "wget https://x", "ssh host", "scp a b", "rsync a b", "kill 1", "killall x", "open .",
        "osascript -e x", "osascript s.scpt", "arch -arm64 ls", "nohup ls", "timeout 5 ls", "nice ls", "nice -n 5 ls",
        "time ls", "caffeinate ls", "sudo ls", "env ls", "env FOO=1 ls", "command ls", "command -p ls", "command -V ls",
        "builtin ls", "cd x", "cd x && ls", "pushd x", "export X=1", "unset X", "set -e", "true", "false", "test -f x",
        "type ls", "sleep 1", "ps aux", "lsof", "vim f", "vi f", "nano f", "less f", "more f", "make", "make test",
        "brew install x", "pip install x", "pip3 list", "npx tsc", "npx -y x", "zsh scripts/x.sh", "dash x.sh",
        "psql -c 'DROP TABLE x'", "sqlite3 db", "docker ps", "simctl list", "devicectl list", "xcrun devicectl list",
        "codesign -s x", "security find-identity", "defaults write x y z", "launchctl list", "say hi", "pytest",
        "swift", "node", "python3", "/bin/rm x", "/usr/bin/touch f", "/usr/bin/vim f", "/usr/local/bin/rg x",
        "/opt/homebrew/bin/rg x", "/usr/bin/../bin/rm x", "/usr/bin/env ls", "/nonexistent/.agent-kit/current/bin/collab inbox",
        "collab inbox", "collab init", "collab project --json --x",
    )
    GIT_DENIED = (
        "git commit -m x", "git push", "git push origin main", "git pull", "git fetch", "git add .", "git rm x",
        "git mv a b", "git checkout main", "git switch -c x", "git restore f", "git reset --hard", "git rebase main",
        "git merge x", "git cherry-pick abc", "git revert abc", "git clean -fd", "git apply p.diff", "git am x",
        "git init", "git clone https://x/y.git", "git gc", "git prune", "git bisect start", "git update-ref x y",
        "git update-index --assume-unchanged f", "git format-patch -1", "git submodule status",
        "git submodule update --init", "git help", "git help --web log", "git",
        # глобальные опции
        "git -C . status", "git -c user.name=x status", "git --git-dir .git status", "git --git-dir=.git status",
        "git --work-tree=. status", "git --exec-path=/x status", "git -p log", "git --paginate log", "git -P log",
        "git --no-pager -c x=y log", "git --no-pager", "git --no-pager --no-pager log",
        # branch / worktree / remote / config / stash / tag
        "git branch new", "git branch -d x", "git branch -D x", "git branch -m a b", "git branch -c a b",
        "git branch -f main HEAD", "git branch -u origin/main", "git branch --delete x", "git branch --merged main",
        "git branch --merged", "git branch --contains HEAD", "git branch --list x", "git branch --set-upstream-to=o/m",
        "git worktree add ../x", "git worktree remove x", "git worktree prune", "git worktree list x",
        "git remote add o u", "git remote remove o", "git remote set-url o u", "git remote show origin",
        "git remote -v show", "git config user.name x", "git config --global core.editor vim", "git config --unset x",
        "git config --add x y", "git config -e", "git config --edit", "git config", "git config --global",
        "git config --get --file x y", "git config -f x --get y", "git config --blob x --get y",
        "git config --get x --list", "git config set x y", "git stash", "git stash push -m x", "git stash pop",
        "git stash drop", "git stash apply", "git stash save wip", "git stash; ls", "git tag v1", "git tag -a v1",
        "git tag -d v1", "git tag -l -d v1", "git tag --list --sort=x", "git tag -f v1",
        # диффоподобные опции, пишущие или запускающие внешние программы
        "git diff --output=x", "git diff --output x", "git log --output=x", "git show --output=x", "git diff --ext-diff",
        "git log --ext-diff", "git show --textconv HEAD:f", "git diff --textconv", "git cat-file --textconv HEAD:f",
        "git cat-file --filters HEAD:f", "git grep -Ovim x", "git grep -O x", "git grep --open-files-in-pager x",
        "git stash show --ext-diff", "git stash list --output=x", "git diff --output-indicator-new=+",
        "git 'commit' -m x", "git \"commit\"",
    )
    READER_FLAGS_DENIED = (
        "find . -delete", "find . -name x -delete", "find . -exec rm '{}' ';'", "find . -execdir rm '{}' ';'",
        "find . -ok rm '{}' ';'", "find . -okdir rm '{}' ';'", "find . -fprint out", "find . -fprint0 out",
        "find . -fprintf out '%p'", "find . -fls out", "find . -name '*.o' -exec rm {} \\;",
        "find . -name '*.swift' -exec grep -l foo {} +", "rg --pre cat x", "rg --pre=cat x", "rg --pre-glob '*' x",
        "rg -e --pre f",  # `--pre` как значение `-e` безобиден, но хук не разбирает значения опций — блок
        "sort -o out f", "sort -no out f", "sort -ro out", "sort --output=out", "sort --output out", "sort --out out",
        "sort -T /tmp f", "sort --compress-program=x", "sort --temporary-directory=/x", "uniq in out", "uniq -c in out",
        "file -C -m magic", "file -C", "file --compile x", "file --comp x", "date 0912", "date -f x y", "date -s x",
        "date --set=x", "plutil -convert xml1 x", "plutil -replace k -string v x", "plutil -p -o x f",
        "plutil -insert k -string v x", "plutil f", "xcode-select -s /x", "xcode-select --install",
        "xcode-select -r", "xcode-select", "env -i", "env X=1", "command -v", "command -v -p ls", "date -f",
    )
    RUNNER_DENIED = (
        # node
        "node x.js", "node scripts/check.js", "node -e 1", "node --eval 1", "node -p 1", "node -r x --test",
        "node --test -r x", "node --test --require x tests/", "node --test --watch", "node --test /abs/tests",
        "node --test ../tests", "node --test tests/../../x", "node --test --test-reporter=./x.js",
        "node --test --test-reporter /abs/x.js", "node --test --test-reporter-destination=/x tests/",
        "node --test --test-reporter", "node --check /etc/passwd", "node --check", "node --check a b",
        "node --input-type=module", "node -", "node --test -e 1",
        # python
        "python3 -c 'print(1)'", "python3 x.py", "python3 -", "python3 -m pip install x", "python3 -m http.server",
        "python3 -m unittest.__main__", "python3 -mpytest", "python3 -B -m unittest", "python3 -X dev -m unittest",
        "python3 -m", "python3 -m pytest -c cfg", "python3 -m pytest -o x=y", "python3 -m pytest --rootdir=/x",
        "python3 -m pytest --basetemp=/x", "python3 -m pytest --junitxml=out.xml", "python3 -m pytest --log-file=x",
        "python3 -m pytest --cov", "python3 -m pytest --cov-report=html:/x", "python3 -m pytest -p evil",
        "python3 -m pytest -p", "python3 -m pytest --pastebin=all", "python3 -m pytest /abs/tests",
        "python3 -m pytest ../tests", "python3 -m pytest --ignore=/x", "python3 -m unittest -s /abs",
        "python3 -m unittest -t ../x", "python3 -m unittest -c", "python3 -m unittest --unknown",
        "/usr/bin/python3 -c 1", "/usr/bin/python3 x.py", "python -c 1",
        # менеджеры пакетов
        "npm install", "npm i", "npm ci", "npm update", "npm uninstall x", "npm link", "npm publish", "npm version patch",
        "npm ls", "npm run build --prefix /x", "npm run --prefix /x build", "npm test --prefix /x", "npm test -w x",
        "npm --prefix /x test", "npm exec x", "npm x", "npm", "pnpm add x", "pnpm install", "pnpm run build",
        "pnpm test --filter x", "pnpm", "yarn", "yarn add x", "yarn install", "yarn run test", "yarn test --cwd /x",
        # swift
        "swift package update", "swift package resolve", "swift run", "swift x.swift", "swift -e 1",
        "swift build --package-path /x", "swift build --scratch-path /x", "swift build --build-path /x",
        "swift test --xunit-output /x", "swift build -Xswiftc -o", "swift build --update-baseline",
        "swift test --disable-sandbox", "swift build -c", "swift build --unknown",
        # xcodebuild
        "xcodebuild test -scheme X", "xcodebuild test", "xcodebuild test-without-building", "xcodebuild archive",
        "xcodebuild clean", "xcodebuild clean build", "xcodebuild analyze", "xcodebuild install", "xcodebuild docbuild",
        "xcodebuild -resolvePackageDependencies", "xcodebuild -scheme X -resolvePackageDependencies build",
        "xcodebuild -derivedDataPath /x build", "xcodebuild -resultBundlePath /x build", "xcodebuild -archivePath /x",
        "xcodebuild -exportArchive", "xcodebuild -allowProvisioningUpdates build", "xcodebuild -xcconfig x build",
        "xcodebuild -clonedSourcePackagesDirPath /x build", "xcodebuild -downloadAllPlatforms",
        "xcodebuild -runFirstLaunch", "xcodebuild -create-xcframework", "xcodebuild build SYMROOT=/x",
        "xcodebuild build CONFIGURATION_BUILD_DIR=/x", "xcodebuild build OTHER_SWIFT_FLAGS=-x", "xcodebuild -scheme",
        "xcodebuild -project", "xcodebuild build-for-testing -destination", "xcodebuild -skipUnavailableActions test",
        # xcrun / simctl
        "xcrun simctl erase all", "xcrun simctl delete unavailable", "xcrun simctl boot X", "xcrun simctl shutdown all",
        "xcrun simctl install booted x.app", "xcrun simctl launch booted x", "xcrun simctl uninstall booted x",
        "xcrun simctl spawn booted ls", "xcrun simctl --set /x list", "xcrun simctl --set /tmp/x erase all",
        "xcrun simctl list --set /x", "xcrun simctl", "xcrun simctl io booted screenshot x.png",
        "xcrun simctl openurl booted x", "xcrun simctl privacy booted grant all x", "xcrun --find",
        "xcrun --find -x", "xcrun --run ls", "xcrun -r ls", "xcrun ls", "xcrun swift build", "xcrun xcodebuild build",
        "xcrun devicectl device install app x", "xcrun --sdk iphoneos ls", "xcrun --sdk", "xcrun",
        "xcrun --show-sdk-path --find x",
        # shell-интерпретаторы
        "bash -c ls", "bash -c 'ls'", "bash -lc ls", "sh -c ls", "sh -c 'ls'", "bash", "sh", "bash -", "bash -s",
        "bash -x scripts/x.sh", "bash -e scripts/x.sh", "echo ls | sh", "echo ls | bash", "cat x | bash",
        "bash /abs/x.sh", "sh /etc/profile", "bash ../x.sh", "bash scripts/nope.sh", "bash scripts/*.sh",
        "/bin/bash -c ls", "/bin/sh -c ls",
    )

    def test_unknown_commands_block(self):
        self.check_all(self.UNKNOWN_COMMANDS, 2)

    def test_git_denied(self):
        self.check_all(self.GIT_DENIED, 2)

    def test_reader_flags_denied(self):
        self.check_all(self.READER_FLAGS_DENIED, 2)

    def test_runner_denied(self):
        self.check_all(self.RUNNER_DENIED, 2)

    def test_every_segment_is_checked(self):
        for command in ("ls && rm -rf x", "ls; rm x", "ls | rm x", "ls || rm x", "rm x && ls", "rm x | head",
                        "ls\nrm x", "git status; git commit -m x", "ls | git push", "cat f | tee out",
                        "true; ls", "ls; true", "ls | sh", "ls && cd x", "git status && git -c x=y log"):
            with self.subTest(command=command):
                self.assertBlocked(command)


class ScriptPathTests(GuardCase):
    """Скрипт по пути: обычный файл внутри cwd после realpath; для `./x` — исполняемый."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.cwd = str(self.root / "proj")
        (self.root / "proj" / "scripts").mkdir(parents=True)
        self.gate = self.root / "proj" / "scripts" / "preflight.sh"
        self.gate.write_text("#!/bin/sh\nexit 0\n")
        self.gate.chmod(0o755)
        self.plain = self.root / "proj" / "check.sh"
        self.plain.write_text("exit 0\n")
        self.plain.chmod(0o644)
        self.outside = self.root / "outside.sh"
        self.outside.write_text("#!/bin/sh\nexit 0\n")
        self.outside.chmod(0o755)
        (self.root / "proj" / "link.sh").symlink_to(self.outside)
        (self.root / "proj" / "scripts" / "inner-link.sh").symlink_to(self.gate)

    def tearDown(self):
        self.tmp.cleanup()

    def test_executable_inside_cwd_passes(self):
        for command in ("scripts/preflight.sh", "scripts/preflight.sh --quiet", "./scripts/preflight.sh",
                        "scripts/../scripts/preflight.sh", "scripts/inner-link.sh", "bash scripts/preflight.sh",
                        "sh scripts/preflight.sh --flag", "bash check.sh", "sh ./check.sh", "bash scripts/inner-link.sh",
                        "scripts/preflight.sh && git status", "scripts/preflight.sh -c anything"):
            with self.subTest(command=command):
                self.assertAllowed(command)

    def test_outside_missing_or_wrong_type_blocks(self):
        for command in ("./check.sh", "check.sh", "./link.sh", "bash link.sh", "sh link.sh", "../outside.sh",
                        "bash ../outside.sh", "scripts/../../outside.sh", "scripts/", "scripts", "bash scripts",
                        "bash scripts/", "./scripts", "scripts/missing.sh", "bash scripts/missing.sh",
                        "bash " + str(self.gate), str(self.gate), "bash scripts/*.sh", "scripts/pre*.sh",
                        "'scripts/preflight.sh'", "scripts/pre'flight'.sh", "bash -c scripts/preflight.sh",
                        "bash -x scripts/preflight.sh", "bash -- scripts/preflight.sh"):
            with self.subTest(command=command):
                self.assertBlocked(command)

    def test_cwd_required_for_paths_only(self):
        for cwd in (None, "", "relative/dir", "/nonexistent-dir-xyz", 42):
            with self.subTest(cwd=cwd):
                event = bash("scripts/preflight.sh")
                if cwd is None:
                    del event["cwd"]
                else:
                    event["cwd"] = cwd
                proc = run_guard(event)
                self.assertEqual(proc.returncode, 2, proc.stderr)
                event = bash("bash scripts/preflight.sh")
                if cwd is None:
                    del event["cwd"]
                else:
                    event["cwd"] = cwd
                self.assertEqual(run_guard(event).returncode, 2)
                event = bash("git status")
                if cwd is None:
                    del event["cwd"]
                else:
                    event["cwd"] = cwd
                self.assertEqual(run_guard(event).returncode, 0)

    def test_cwd_symlink_is_resolved(self):
        link = self.root / "proj-link"
        link.symlink_to(self.root / "proj")
        self.assertAllowed("scripts/preflight.sh", cwd=str(link))
        self.assertBlocked("./link.sh", cwd=str(link))


class RobustnessTests(unittest.TestCase):
    """Сторож, сбой внутри хука, очень длинные команды."""

    def test_pathological_long_command_blocks_quickly(self):
        start = time.monotonic()
        proc = run_guard(bash("psql " * 40000), timeout=25)
        self.assertEqual(proc.returncode, 2, proc.stderr)
        self.assertLess(time.monotonic() - start, 8.0)

    def test_long_benign_command_still_passes_quickly(self):
        start = time.monotonic()
        proc = run_guard(bash("ls " + "a" * 500000))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertLess(time.monotonic() - start, 4.0)

    def test_long_quoted_command_passes_quickly(self):
        start = time.monotonic()
        proc = run_guard(bash("rg '" + "x; rm -rf / " * 20000 + "' src"))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertLess(time.monotonic() - start, 4.0)

    def test_watchdog_blocks_when_stdin_never_closes(self):
        start = time.monotonic()
        proc = subprocess.Popen([PYTHON, str(HOOK_PATH)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, env=ENV)
        try:
            rc = proc.wait(timeout=12)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
            self.fail("guard hung past the 10 s hook timeout (host would let the command through)")
        finally:
            proc.stdin.close()
            proc.stdout.close()
            proc.stderr.close()
        self.assertEqual(rc, 2)
        self.assertLess(time.monotonic() - start, 8.0)

    def _run_with_patch(self, patch, command="git status"):
        script = (
            "import importlib.util\n"
            "spec = importlib.util.spec_from_file_location('readonly_guard', %r)\n"
            "m = importlib.util.module_from_spec(spec)\n"
            "spec.loader.exec_module(m)\n"
            "%s\n"
            "m.entrypoint()\n" % (str(HOOK_PATH), patch)
        )
        proc = subprocess.run([PYTHON, "-c", script], input=json.dumps(bash(command)).encode(),
                              capture_output=True, env=ENV, timeout=20)
        return proc.returncode, proc.stderr.decode("utf-8", "replace")

    def test_broken_policy_blocks_instead_of_crashing(self):
        for patch in ("m.ALLOWLIST['git'] = lambda *a: 1 / 0",
                      "m.tokenize = None",
                      "m.ALLOWLIST['git'] = lambda *a: (_ for _ in ()).throw(KeyboardInterrupt())"):
            with self.subTest(patch=patch):
                rc, stderr = self._run_with_patch(patch)
                self.assertEqual(rc, 2, stderr)
                self.assertRegex(stderr, CYRILLIC)
                self.assertNotIn("Traceback", stderr)

    def test_policy_returning_non_zero_or_raising_system_exit_blocks(self):
        for patch in ("m.decide = lambda: 1", "m.decide = lambda: None", "m.decide = lambda: True",
                      "import sys\nm.decide = lambda: sys.exit(0)"):
            with self.subTest(patch=patch):
                rc, _ = self._run_with_patch(patch)
                self.assertEqual(rc, 2)

    def test_guard_source_exits_via_os_exit_with_top_level_handler(self):
        source = HOOK_PATH.read_text(encoding="utf-8")
        self.assertIn("except BaseException", source)
        self.assertIn("os._exit(", source)
        self.assertIn("signal.alarm(", source)
        self.assertNotIn("PATTERNS", source)


class VerifierLauncherTests(unittest.TestCase):
    """Точная строка из agents/verifier.md через `sh -c`."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name) / "home"
        hooks = self.home / ".agent-kit" / "current" / "hooks"
        hooks.mkdir(parents=True)
        (hooks / "readonly-guard.py").symlink_to(HOOK_PATH)
        text = VERIFIER_MD.read_text(encoding="utf-8")
        self.front = text.split("---", 2)[1]
        m = re.search(r'^\s*command:\s*(".*")\s*$', self.front, re.M)
        self.assertIsNotNone(m)
        self.command = json.loads(m.group(1))

    def tearDown(self):
        self.tmp.cleanup()

    def sh(self, command, stdin):
        if isinstance(stdin, dict):
            stdin = json.dumps(stdin).encode()
        return subprocess.run(["/bin/sh", "-c", command], input=stdin, capture_output=True,
                              env={"HOME": str(self.home), "PATH": "/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1"},
                              timeout=20)

    def test_exact_command_string(self):
        self.assertIn('%s "$HOME/.agent-kit/current/hooks/readonly-guard.py"' % FRONTMATTER_PYTHON, self.command)
        self.assertTrue(self.command.rstrip().endswith("|| exit 2"), self.command)
        self.assertRegex(self.front, r'matcher:\s*"Bash"')
        self.assertRegex(self.front, r"disallowedTools:.*\bEdit\b.*\bWrite\b")
        timeout = int(re.search(r"timeout:\s*(\d+)", self.front).group(1))
        self.assertGreater(timeout, 5, "watchdog (5 s) must fire before the host timeout")

        self.assertEqual(self.sh(self.command, bash("git status")).returncode, 0)
        self.assertEqual(self.sh(self.command, bash("rm -rf build")).returncode, 2)
        self.assertEqual(self.sh(self.command, bash("git -c alias.x=commit x")).returncode, 2)
        self.assertEqual(self.sh(self.command, b"not json").returncode, 2)
        self.assertEqual(self.sh(self.command, bash("git status", tool="Edit")).returncode, 2)

    def test_missing_interpreter_blocks(self):
        self.assertIn(FRONTMATTER_PYTHON, self.command)
        broken = self.command.replace(FRONTMATTER_PYTHON, str(Path(self.tmp.name) / "no-such-dir" / "python3"))
        for stdin in (bash("git status"), bash("rm x")):
            with self.subTest(stdin=stdin):
                self.assertEqual(self.sh(broken, stdin).returncode, 2)

    def test_missing_guard_file_blocks(self):
        (self.home / ".agent-kit" / "current" / "hooks" / "readonly-guard.py").unlink()
        self.assertEqual(self.sh(self.command, bash("git status")).returncode, 2)

    def test_verifier_doc_explains_allowlist_and_escalation(self):
        body = VERIFIER_MD.read_text(encoding="utf-8").split("---", 2)[2]
        self.assertIn("не проверено", body)
        self.assertIn("allowlist", body.lower())
        for fragment in ("git status", "node --test", "python3 -m unittest", "xcodebuild", "xcrun simctl list"):
            self.assertIn(fragment, body)


if __name__ == "__main__":
    unittest.main()
