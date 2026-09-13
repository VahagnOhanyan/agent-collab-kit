#!/usr/bin/env python3
"""Тесты для hooks/scope-guard.py (и строк запуска хуков во frontmatter агентов).

Хук запускается как настоящий subprocess тем же интерпретатором, что указан во
frontmatter (`/usr/bin/python3`, если он есть): важно поведение процесса —
exit code (2 = блок, всё остальное Claude Code пропускает) и русское сообщение
в stderr, а не внутренности функций.

Тестового «чёрного хода» в хуке нет: фейковый `collab` кладётся по боевому пути
`<HOME>/.agent-kit/current/bin/collab` во временном HOME, и хук запускается с
этим HOME.

Большинство фикстур живёт в системном временном каталоге (на этой машине —
/private/var/folders/...), то есть НЕ под /tmp: хук даёт /tmp особое исключение,
и фикстуры под ним проверяли бы не то. Тесты самого исключения явно создают
каталоги под /private/tmp и убирают их за собой.

Запуск: `python3 -m unittest -v tests/test_scope_guard.py` из каталога черновиков
(или `python3 -m unittest -v test_scope_guard` из tests/).
"""
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unicodedata
import unittest
from pathlib import Path

DRAFTS = Path(__file__).resolve().parent.parent
HOOK_PATH = DRAFTS / "hooks" / "scope-guard.py"
READONLY_GUARD_PATH = DRAFTS / "hooks" / "readonly-guard.py"
IMPLEMENTER_MD = DRAFTS / "agents" / "implementer.md"
VERIFIER_MD = DRAFTS / "agents" / "verifier.md"
CODEX_REVIEW_SKILL = DRAFTS / "skills" / "codex-review" / "SKILL.md"

FRONTMATTER_PYTHON = "/usr/bin/python3"
PYTHON = FRONTMATTER_PYTHON if os.path.exists(FRONTMATTER_PYTHON) else sys.executable
GIT = next((g for g in ("/usr/bin/git", "/opt/homebrew/bin/git") if os.path.exists(g)), None)

_MISSING = object()


def run_hook(stdin, *, home, agent="implementer", cwd=None, extra_env=None, timeout=20):
    env = {"HOME": str(home), "PATH": "/usr/bin:/bin"}
    if agent is not None:
        env["KIT_AGENT"] = agent
    if extra_env:
        env.update(extra_env)
    if isinstance(stdin, dict):
        stdin = json.dumps(stdin)
    if isinstance(stdin, str):
        stdin = stdin.encode("utf-8", "surrogatepass")
    proc = subprocess.run(
        [PYTHON, str(HOOK_PATH)],
        input=stdin,
        capture_output=True,
        cwd=str(cwd or home),
        env=env,
        timeout=timeout,
    )
    proc.stderr = proc.stderr.decode("utf-8", "replace")
    return proc


def frontmatter_command(md_path):
    text = md_path.read_text(encoding="utf-8")
    front = text.split("---", 2)[1]
    m = re.search(r'^\s*command:\s*(".*")\s*$', front, re.M)
    assert m, f"no command in {md_path}"
    return json.loads(m.group(1)), front


def sanitized_git_env():
    return {"PATH": "/usr/bin:/bin", "HOME": "/nonexistent", "LC_ALL": "C"}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        assert not str(self.base).startswith(("/tmp/", "/private/tmp/")), self.base

        self.home = self.base / "home"
        self.home.mkdir()
        self.code_root = self.base / "code"
        self.code_root.mkdir()
        self.registry = self.base / "registry"
        self.registry.mkdir()
        self.project_id = "demo"
        self.project_dir = self.registry / self.project_id
        self.project_dir.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    # -- fixtures ---------------------------------------------------------
    def write_scopes(self, scopes, raw=None):
        path = self.project_dir / "scopes.json"
        if raw is not None:
            path.write_bytes(raw)
        else:
            path.write_text(json.dumps(scopes, ensure_ascii=False), encoding="utf-8")

    def install_collab(self, json_output=None, raw_output=None, exit_code=0, sleep_bg=None, home=None):
        """Фейковый `collab project --json` по боевому пути в HOME."""
        home = Path(home or self.home)
        bin_dir = home / ".agent-kit" / "current" / "bin"
        bin_dir.mkdir(parents=True, exist_ok=True)
        payload = bin_dir / "collab.payload"
        if raw_output is not None:
            payload.write_bytes(raw_output)
        else:
            payload.write_text(json.dumps(json_output or {}), encoding="utf-8")
        script = bin_dir / "collab"
        lines = ["#!/bin/sh"]
        if sleep_bg:
            # Фоновый внук держит stdout открытым: убить только sh недостаточно.
            lines.append(f"sleep {int(sleep_bg)} &")
            lines.append("wait")
        lines.append(f'cat "{payload}"')
        lines.append(f"exit {int(exit_code)}")
        script.write_text("\n".join(lines) + "\n")
        script.chmod(0o755)
        return str(script)

    def collab_ok(self, project_id=_MISSING, code_root=None, registry_dir=None, home=None):
        pid = self.project_id if project_id is _MISSING else project_id
        return self.install_collab(
            json_output={
                "codeRoot": str(code_root or self.code_root),
                "projectId": pid,
                "registryDir": str(registry_dir or self.registry),
                "initialized": True,
                "error": None,
            },
            home=home,
        )

    def event_for(self, rel_path, tool="Edit", root=None):
        root = Path(root or self.code_root)
        field = "notebook_path" if tool == "NotebookEdit" else "file_path"
        return {"tool_name": tool, "tool_input": {field: str(root / rel_path)}, "cwd": str(root)}

    def tmp_dir(self):
        d = tempfile.mkdtemp(prefix="scope-guard-test-", dir="/private/tmp")
        self.addCleanup(shutil.rmtree, d, True)
        return Path(d)


class ScopeRulesTests(Base):
    def test_allow_inside_scope(self):
        self.write_scopes({"implementer": {"allow": ["Tripix/"], "deny": []}})
        self.collab_ok()
        proc = run_hook(self.event_for("Tripix/Foo.swift"), home=self.home)
        self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_write_and_notebook_edit_allowed_inside_scope(self):
        self.write_scopes({"implementer": {"allow": ["Tripix/"], "deny": []}})
        self.collab_ok()
        for tool, rel in (("Write", "Tripix/New.swift"), ("NotebookEdit", "Tripix/a.ipynb")):
            with self.subTest(tool=tool):
                proc = run_hook(self.event_for(rel, tool=tool), home=self.home)
                self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_component_boundary_tripix_vs_tripixtests(self):
        self.write_scopes({"implementer": {"allow": ["Tripix/"], "deny": []}})
        self.collab_ok()
        blocked = run_hook(self.event_for("TripixTests/FooTests.swift"), home=self.home)
        self.assertEqual(blocked.returncode, 2)
        self.assertIn("вне разрешённых областей", blocked.stderr)
        allowed = run_hook(self.event_for("Tripix/Foo.swift"), home=self.home)
        self.assertEqual(allowed.returncode, 0, allowed.stderr)

    def test_deny_prefix_blocks_inside_allow(self):
        self.write_scopes({"implementer": {"allow": ["Tripix/"], "deny": ["Tripix/Secrets/"]}})
        self.collab_ok()
        proc = run_hook(self.event_for("Tripix/Secrets/keys.swift"), home=self.home)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("запрещён явно", proc.stderr)

    def test_outside_code_root(self):
        self.write_scopes({"implementer": {"allow": ["Tripix/"], "deny": []}})
        self.collab_ok()
        event = {
            "tool_name": "Write",
            "tool_input": {"file_path": str(self.base / "elsewhere" / "file.txt")},
            "cwd": str(self.code_root),
        }
        proc = run_hook(event, home=self.home)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("вне корня кода", proc.stderr)

    def test_hard_denied_paths_win_over_allow(self):
        self.write_scopes(
            {"implementer": {"allow": [".claude/", ".mcp.json", ".git/", ".collab/", "Tripix/"], "deny": []}}
        )
        self.collab_ok()
        for rel in (".claude/settings.json", ".mcp.json", ".git/config", ".collab/tasks/t1.json"):
            with self.subTest(rel=rel):
                proc = run_hook(self.event_for(rel), home=self.home)
                self.assertEqual(proc.returncode, 2, f"{rel} should be blocked, stderr={proc.stderr!r}")

    def test_hard_denied_components_anywhere_inside_code_root(self):
        self.write_scopes({"implementer": {"allow": ["Tripix/", "Modules/"], "deny": []}})
        self.collab_ok()
        for rel in ("Tripix/.git/config", "Modules/Sub/.claude/settings.json", "Tripix/.collab/x", "Modules/.mcp.json"):
            with self.subTest(rel=rel):
                proc = run_hook(self.event_for(rel), home=self.home)
                self.assertEqual(proc.returncode, 2, f"{rel} should be blocked, stderr={proc.stderr!r}")
                self.assertIn("служебн", proc.stderr)

    def test_code_root_may_itself_live_under_a_dot_claude_worktree(self):
        # Claude Code кладёт worktree в <repo>/.claude/worktrees/<name>; сам корень
        # кода там — не повод блокировать всё: служебные имена ищутся ВНУТРИ корня.
        wt = self.base / "repo" / ".claude" / "worktrees" / "feat"
        wt.mkdir(parents=True)
        self.write_scopes({"implementer": {"allow": ["Tripix/"], "deny": []}})
        self.collab_ok(code_root=wt)
        proc = run_hook(self.event_for("Tripix/Foo.swift", root=wt), home=self.home)
        self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_protected_home_dirs_blocked_before_collab_runs(self):
        # collab не установлен: блок обязан наступить раньше попытки его запустить.
        for name in ("agent-kit", ".agent-kit", ".claude", ".codex"):
            with self.subTest(name=name):
                event = {
                    "tool_name": "Edit",
                    "tool_input": {"file_path": str(self.home / name / "secret.py")},
                    "cwd": str(self.home),
                }
                proc = run_hook(event, home=self.home)
                self.assertEqual(proc.returncode, 2, f"{name} should be blocked, stderr={proc.stderr!r}")
                self.assertIn("защищённого каталога", proc.stderr)

    def test_symlink_inside_code_root_escaping_it_is_blocked(self):
        self.write_scopes({"implementer": {"allow": ["Tripix/"], "deny": []}})
        self.collab_ok()
        outside_dir = self.base / "outside"
        outside_dir.mkdir()
        (outside_dir / "secret.swift").write_text("// outside the code root")
        (self.code_root / "Tripix").symlink_to(outside_dir)
        proc = run_hook(self.event_for("Tripix/secret.swift"), home=self.home)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("вне корня кода", proc.stderr)

    def test_symlink_from_allowed_dir_into_denied_dir_is_blocked(self):
        self.write_scopes({"implementer": {"allow": ["Tripix/"], "deny": ["shared/"]}})
        self.collab_ok()
        (self.code_root / "shared").mkdir()
        (self.code_root / "Tripix").mkdir()
        (self.code_root / "Tripix" / "link").symlink_to(self.code_root / "shared")
        proc = run_hook(self.event_for("Tripix/link/x.swift"), home=self.home)
        self.assertEqual(proc.returncode, 2, proc.stderr)

    def test_no_project_id(self):
        self.write_scopes({"implementer": {"allow": ["Tripix/"], "deny": []}})
        self.collab_ok(project_id=None)
        proc = run_hook(self.event_for("Tripix/Foo.swift"), home=self.home)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("не описан в реестре", proc.stderr)

    def test_missing_scopes_json(self):
        self.collab_ok()
        proc = run_hook(self.event_for("Tripix/Foo.swift"), home=self.home)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("scopes.json", proc.stderr)

    def test_unknown_agent(self):
        self.write_scopes({"someone-else": {"allow": ["Tripix/"], "deny": []}})
        self.collab_ok()
        proc = run_hook(self.event_for("Tripix/Foo.swift"), home=self.home, agent="implementer")
        self.assertEqual(proc.returncode, 2)
        self.assertIn("нет описанных областей", proc.stderr)

    def test_missing_kit_agent(self):
        self.write_scopes({"implementer": {"allow": ["Tripix/"], "deny": []}})
        self.collab_ok()
        proc = run_hook(self.event_for("Tripix/Foo.swift"), home=self.home, agent=None)
        self.assertEqual(proc.returncode, 2)

    # -- collab failures ----------------------------------------------------
    def test_collab_missing_blocks(self):
        self.write_scopes({"implementer": {"allow": ["Tripix/"], "deny": []}})
        proc = run_hook(self.event_for("Tripix/Foo.swift"), home=self.home)
        self.assertEqual(proc.returncode, 2)

    def test_collab_nonzero_exit_blocks(self):
        self.install_collab(json_output={}, exit_code=1)
        proc = run_hook(self.event_for("Tripix/Foo.swift"), home=self.home)
        self.assertEqual(proc.returncode, 2)

    def test_collab_garbage_output_blocks(self):
        self.install_collab(raw_output=b"not json at all {{{")
        proc = run_hook(self.event_for("Tripix/Foo.swift"), home=self.home)
        self.assertEqual(proc.returncode, 2)

    def test_collab_reports_error_blocks(self):
        self.write_scopes({"implementer": {"allow": ["Tripix/"], "deny": []}})
        self.install_collab(
            json_output={
                "codeRoot": str(self.code_root),
                "projectId": self.project_id,
                "registryDir": str(self.registry),
                "error": {"code": "AMBIGUOUS_PROJECT", "message": "boom"},
            }
        )
        proc = run_hook(self.event_for("Tripix/Foo.swift"), home=self.home)
        self.assertEqual(proc.returncode, 2)


class InodeAliasTests(Base):
    """Жёсткие ссылки и не-обычные файлы: имя и realpath не говорят, какой inode правится."""

    def setUp(self):
        super().setUp()
        self.write_scopes({"implementer": {"allow": ["Tripix/"], "deny": []}})
        self.collab_ok()
        (self.code_root / "Tripix").mkdir()

    def link_or_skip(self, src, dst):
        try:
            os.link(src, dst)
        except OSError as exc:
            self.skipTest(f"hard link not possible here: {exc}")

    def test_hard_link_to_out_of_scope_file_blocks(self):
        outside = self.base / "outside.txt"
        outside.write_text("out of scope")
        self.link_or_skip(outside, self.code_root / "Tripix" / "link.swift")
        proc = run_hook(self.event_for("Tripix/link.swift"), home=self.home)
        self.assertEqual(proc.returncode, 2, proc.stderr)
        self.assertIn("жёстк", proc.stderr)

    def test_hard_link_with_both_names_in_scope_still_blocks(self):
        first = self.code_root / "Tripix" / "a.swift"
        first.write_text("// a")
        self.link_or_skip(first, self.code_root / "Tripix" / "b.swift")
        for rel in ("Tripix/a.swift", "Tripix/b.swift"):
            with self.subTest(rel=rel):
                proc = run_hook(self.event_for(rel), home=self.home)
                self.assertEqual(proc.returncode, 2, proc.stderr)

    def test_hard_link_under_tmp_blocks(self):
        outside = self.base / "outside.txt"
        outside.write_text("out of scope")
        target = self.tmp_dir() / "alias.txt"
        self.link_or_skip(outside, target)
        event = {"tool_name": "Edit", "tool_input": {"file_path": str(target)}, "cwd": str(target.parent)}
        proc = run_hook(event, home=self.home)
        self.assertEqual(proc.returncode, 2, proc.stderr)

    def test_normal_existing_file_allowed(self):
        (self.code_root / "Tripix" / "Foo.swift").write_text("// single link")
        proc = run_hook(self.event_for("Tripix/Foo.swift"), home=self.home)
        self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_new_file_allowed(self):
        for rel in ("Tripix/New.swift", "Tripix/NewDir/Deeper/New.swift"):
            with self.subTest(rel=rel):
                proc = run_hook(self.event_for(rel, tool="Write"), home=self.home)
                self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_dangling_symlink_blocks(self):
        (self.code_root / "Tripix" / "dangling.swift").symlink_to(self.code_root / "Tripix" / "missing.swift")
        proc = run_hook(self.event_for("Tripix/dangling.swift", tool="Write"), home=self.home)
        self.assertEqual(proc.returncode, 2, proc.stderr)

    def test_special_files_block(self):
        os.mkfifo(self.code_root / "Tripix" / "pipe")
        (self.code_root / "Tripix" / "Sub").mkdir()
        for rel in ("Tripix/pipe", "Tripix/Sub"):
            with self.subTest(rel=rel):
                proc = run_hook(self.event_for(rel, tool="Write"), home=self.home, timeout=20)
                self.assertEqual(proc.returncode, 2, proc.stderr)


class HardDenyBeforeTmpTests(Base):
    """П.1: жёсткие запреты — раньше исключения для /tmp."""

    def git_init(self, path):
        if GIT is None:
            self.skipTest("git not available")
        subprocess.run([GIT, "init", "-q", str(path)], check=True, env=sanitized_git_env(), capture_output=True)

    def test_tmp_non_repo_still_allowed_without_collab(self):
        d = self.tmp_dir()
        for target in (d / "notes.txt", d / "deeper" / "not-yet-created" / "file.txt", Path("/tmp") / d.name / "x.txt"):
            with self.subTest(target=str(target)):
                event = {"tool_name": "Write", "tool_input": {"file_path": str(target)}, "cwd": str(self.code_root)}
                proc = run_hook(event, home=self.home)
                self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_tmp_git_checkout_hard_denies_apply(self):
        repo = self.tmp_dir() / "repo"
        repo.mkdir()
        self.git_init(repo)
        # collab не установлен; allow бы и не помог.
        for rel in (".git/config", ".claude/settings.json", ".mcp.json", ".collab/t.json"):
            with self.subTest(rel=rel):
                proc = run_hook(self.event_for(rel, root=repo), home=self.home)
                self.assertEqual(proc.returncode, 2, f"{rel}: {proc.stderr!r}")

    def test_tmp_git_checkout_goes_through_project_rules(self):
        repo = self.tmp_dir() / "repo"
        repo.mkdir()
        self.git_init(repo)
        self.write_scopes({"implementer": {"allow": ["Tripix/"], "deny": ["shared/"]}})
        self.collab_ok(code_root=repo)
        allowed = run_hook(self.event_for("Tripix/Foo.swift", root=repo), home=self.home)
        self.assertEqual(allowed.returncode, 0, allowed.stderr)
        for rel in ("shared/x.swift", "README.md"):
            with self.subTest(rel=rel):
                proc = run_hook(self.event_for(rel, root=repo), home=self.home)
                self.assertEqual(proc.returncode, 2, proc.stderr)

    def test_tmp_git_checkout_without_collab_blocks(self):
        repo = self.tmp_dir() / "repo"
        (repo / "Tripix").mkdir(parents=True)
        self.git_init(repo)
        proc = run_hook(self.event_for("Tripix/Foo.swift", root=repo), home=self.home)
        self.assertEqual(proc.returncode, 2)

    def test_tmp_hard_deny_component_without_repo_blocks(self):
        d = self.tmp_dir()
        event = {"tool_name": "Write", "tool_input": {"file_path": str(d / ".claude" / "settings.json")}, "cwd": str(d)}
        proc = run_hook(event, home=self.home)
        self.assertEqual(proc.returncode, 2)

    def test_protected_home_dir_symlinked_into_tmp_is_blocked(self):
        d = self.tmp_dir()
        (self.home / ".claude").symlink_to(d)
        event = {
            "tool_name": "Write",
            "tool_input": {"file_path": str(self.home / ".claude" / "settings.json")},
            "cwd": str(self.home),
        }
        proc = run_hook(event, home=self.home)
        self.assertEqual(proc.returncode, 2, proc.stderr)
        self.assertIn("защищённого каталога", proc.stderr)

    def test_symlink_in_code_root_into_protected_home_is_blocked(self):
        self.write_scopes({"implementer": {"allow": ["Tripix/"], "deny": []}})
        self.collab_ok()
        (self.home / ".codex").mkdir()
        (self.code_root / "Tripix").mkdir()
        (self.code_root / "Tripix" / "cfg").symlink_to(self.home / ".codex")
        proc = run_hook(self.event_for("Tripix/cfg/config.toml"), home=self.home)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("защищённого каталога", proc.stderr)


class CaseAndUnicodeAliasTests(Base):
    """П.2: сравнение после NFC + casefold (APFS нечувствительна к регистру и нормализации)."""

    def test_case_alias_of_denied_file(self):
        self.write_scopes({"implementer": {"allow": ["Tripix/"], "deny": ["Tripix/CLAUDE.md"]}})
        self.collab_ok()
        proc = run_hook(self.event_for("Tripix/claude.md"), home=self.home)
        self.assertEqual(proc.returncode, 2, proc.stderr)
        self.assertIn("запрещён явно", proc.stderr)

    def test_case_alias_of_denied_dir(self):
        self.write_scopes({"implementer": {"allow": ["backend/"], "deny": ["backend/test/contracts/"]}})
        self.collab_ok()
        proc = run_hook(self.event_for("backend/Test/contracts/x.ts"), home=self.home)
        self.assertEqual(proc.returncode, 2, proc.stderr)

    def test_case_alias_of_hard_denied_dirs(self):
        self.write_scopes({"implementer": {"allow": [".CLAUDE/", "Tripix/", ".Git/"], "deny": []}})
        self.collab_ok()
        for rel in (".CLAUDE/x", ".Git/config", "Tripix/.MCP.json", ".Collab/t.json"):
            with self.subTest(rel=rel):
                proc = run_hook(self.event_for(rel), home=self.home)
                self.assertEqual(proc.returncode, 2, proc.stderr)

    def test_case_alias_of_protected_home_dir(self):
        event = {
            "tool_name": "Edit",
            "tool_input": {"file_path": str(self.home / ".CLAUDE" / "settings.json")},
            "cwd": str(self.home),
        }
        proc = run_hook(event, home=self.home)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("защищённого каталога", proc.stderr)

    def test_unicode_decomposed_alias_of_denied_dir(self):
        composed = unicodedata.normalize("NFC", "Café")
        decomposed = unicodedata.normalize("NFD", "Café")
        self.assertNotEqual(composed, decomposed)
        self.write_scopes({"implementer": {"allow": ["Tripix/"], "deny": [f"Tripix/{composed}/"]}})
        self.collab_ok()
        proc = run_hook(self.event_for(f"Tripix/{decomposed}/menu.swift"), home=self.home)
        self.assertEqual(proc.returncode, 2, proc.stderr)

    def test_unicode_and_case_aliases_match_allow(self):
        composed = unicodedata.normalize("NFC", "Café")
        decomposed = unicodedata.normalize("NFD", "café")
        self.write_scopes({"implementer": {"allow": [f"Tripix/{composed}/"], "deny": []}})
        self.collab_ok()
        proc = run_hook(self.event_for(f"tripix/{decomposed}/menu.swift"), home=self.home)
        self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_folded_prefix_keeps_component_boundary(self):
        self.write_scopes({"implementer": {"allow": ["tripix/"], "deny": []}})
        self.collab_ok()
        proc = run_hook(self.event_for("TripixTests/FooTests.swift"), home=self.home)
        self.assertEqual(proc.returncode, 2)


class FailClosedTests(Base):
    """П.3: любой нештатный путь заканчивается exit 2."""

    def setUp(self):
        super().setUp()
        self.write_scopes({"implementer": {"allow": ["Tripix/"], "deny": []}})
        self.collab_ok()

    def test_nul_byte_in_path_blocks(self):
        event = self.event_for("Tripix/a\x00b.swift")
        proc = run_hook(event, home=self.home)
        self.assertEqual(proc.returncode, 2, proc.stderr)
        self.assertNotIn("Traceback", proc.stderr)

    def test_lone_surrogate_in_path_blocks(self):
        raw = json.dumps(self.event_for("Tripix/x.swift")).replace("x.swift", "\\ud800.swift")
        proc = run_hook(raw, home=self.home)
        self.assertEqual(proc.returncode, 2, proc.stderr)

    def test_non_utf8_event_blocks(self):
        raw = json.dumps(self.event_for("Tripix/PLACEHOLDER.swift")).encode("utf-8").replace(b"PLACEHOLDER", b"\xff\xfe")
        proc = run_hook(raw, home=self.home)
        self.assertEqual(proc.returncode, 2, proc.stderr)

    def test_empty_and_invalid_events_block(self):
        for raw in (b"", b"not { valid json", b"null", b"[]", b'"Edit"', b'{"tool_name": "Edit"}',
                    b'{"tool_name": "Edit", "tool_input": [], "cwd": "/"}',
                    json.dumps({"tool_name": "Edit", "tool_input": {"file_path": 42}, "cwd": str(self.code_root)}).encode()):
            with self.subTest(raw=raw):
                proc = run_hook(raw, home=self.home)
                self.assertEqual(proc.returncode, 2, proc.stderr)

    def test_non_utf8_scopes_json_blocks(self):
        self.write_scopes(None, raw=b'{"implementer": {"allow": ["Tripix/\xff"]}}')
        proc = run_hook(self.event_for("Tripix/Foo.swift"), home=self.home)
        self.assertEqual(proc.returncode, 2, proc.stderr)
        self.assertNotIn("Traceback", proc.stderr)

    def test_malformed_scope_entries_block(self):
        for scopes in (
            {"implementer": {"allow": ["Tripix/"], "deny": [42, "shared/"]}},
            {"implementer": {"allow": ["Tripix/"], "deny": "shared/"}},
            {"implementer": {"allow": ["/"], "deny": []}},
            {"implementer": {"allow": ["Tripix/../"], "deny": []}},
        ):
            with self.subTest(scopes=scopes):
                self.write_scopes(scopes)
                proc = run_hook(self.event_for("Tripix/Foo.swift"), home=self.home)
                self.assertEqual(proc.returncode, 2, proc.stderr)

    def test_non_utf8_collab_output_blocks(self):
        self.install_collab(raw_output=b'{"codeRoot": "\xff"}')
        proc = run_hook(self.event_for("Tripix/Foo.swift"), home=self.home)
        self.assertEqual(proc.returncode, 2, proc.stderr)
        self.assertNotIn("Traceback", proc.stderr)

    def test_project_id_path_traversal_blocks(self):
        evil = self.base / "evil"
        evil.mkdir()
        (evil / "scopes.json").write_text(json.dumps({"implementer": {"allow": ["Tripix/", "shared/"], "deny": []}}))
        self.collab_ok(project_id="../evil")
        proc = run_hook(self.event_for("shared/x.swift"), home=self.home)
        self.assertEqual(proc.returncode, 2, proc.stderr)

    def test_relative_code_root_blocks(self):
        self.collab_ok(code_root="code")
        proc = run_hook(self.event_for("Tripix/Foo.swift"), home=self.home, cwd=self.base)
        self.assertEqual(proc.returncode, 2, proc.stderr)

    def test_collab_hang_with_grandchild_blocks_well_before_hook_timeout(self):
        self.install_collab(
            json_output={"codeRoot": str(self.code_root), "projectId": self.project_id, "registryDir": str(self.registry)},
            sleep_bg=30,
        )
        start = time.monotonic()
        proc = run_hook(self.event_for("Tripix/Foo.swift"), home=self.home, timeout=20)
        elapsed = time.monotonic() - start
        self.assertEqual(proc.returncode, 2, proc.stderr)
        self.assertLess(elapsed, 8.0, "collab timeout must be ~5 s, well below the 15 s hook timeout")

    def test_watchdog_blocks_when_stdin_never_closes(self):
        env = {"HOME": str(self.home), "PATH": "/usr/bin:/bin", "KIT_AGENT": "implementer"}
        start = time.monotonic()
        proc = subprocess.Popen([PYTHON, str(HOOK_PATH)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, env=env, cwd=str(self.home))
        try:
            rc = proc.wait(timeout=14)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
            self.fail("hook hung past the 15 s host timeout (host would let the write through)")
        finally:
            proc.stdin.close()
            proc.stdout.close()
            proc.stderr.close()
        self.assertEqual(rc, 2)
        self.assertLess(time.monotonic() - start, 13.0)


class NoBackdoorTests(Base):
    """П.4: KIT_COLLAB_BIN больше ничего не значит."""

    def test_kit_collab_bin_is_ignored(self):
        self.write_scopes({"implementer": {"allow": ["Tripix/", "shared/"], "deny": []}})
        other_home = self.base / "other-home"
        forged = self.collab_ok(home=other_home)  # «разрешающий» collab вне HOME
        proc = run_hook(self.event_for("shared/x.swift"), home=self.home, extra_env={"KIT_COLLAB_BIN": forged})
        self.assertEqual(proc.returncode, 2, "KIT_COLLAB_BIN must not be honoured")

    def test_hook_source_has_no_env_override(self):
        self.assertNotIn("KIT_COLLAB_BIN", HOOK_PATH.read_text(encoding="utf-8"))


class EventValidationTests(Base):
    """П.5: tool_name, cwd, неоднозначные поля пути."""

    def setUp(self):
        super().setUp()
        self.write_scopes({"implementer": {"allow": ["Tripix/"], "deny": ["shared/"]}})
        self.collab_ok()

    def test_unexpected_or_missing_tool_name_blocks(self):
        for tool in ("Bash", "MultiEdit", "edit", "", None, 7):
            with self.subTest(tool=tool):
                event = self.event_for("Tripix/Foo.swift")
                if tool is None:
                    del event["tool_name"]
                else:
                    event["tool_name"] = tool
                proc = run_hook(event, home=self.home)
                self.assertEqual(proc.returncode, 2, proc.stderr)

    def test_missing_cwd_does_not_fall_back_to_process_cwd(self):
        event = {"tool_name": "Edit", "tool_input": {"file_path": "Tripix/Foo.swift"}}
        proc = run_hook(event, home=self.home, cwd=self.code_root)
        self.assertEqual(proc.returncode, 2, proc.stderr)

    def test_relative_cwd_blocks(self):
        event = {"tool_name": "Edit", "tool_input": {"file_path": "Tripix/Foo.swift"}, "cwd": "code"}
        proc = run_hook(event, home=self.home, cwd=self.base)
        self.assertEqual(proc.returncode, 2, proc.stderr)

    def test_both_file_path_and_notebook_path_block(self):
        event = {
            "tool_name": "NotebookEdit",
            "tool_input": {
                "file_path": str(self.code_root / "Tripix" / "ok.ipynb"),
                "notebook_path": str(self.code_root / "shared" / "bad.ipynb"),
            },
            "cwd": str(self.code_root),
        }
        proc = run_hook(event, home=self.home)
        self.assertEqual(proc.returncode, 2, proc.stderr)

    def test_path_field_must_match_tool(self):
        event = {"tool_name": "Edit", "tool_input": {"notebook_path": str(self.code_root / "Tripix" / "a.ipynb")},
                 "cwd": str(self.code_root)}
        proc = run_hook(event, home=self.home)
        self.assertEqual(proc.returncode, 2, proc.stderr)

    def test_relative_path_resolves_against_event_cwd_only(self):
        decoy = self.base / "decoy"
        (decoy / "shared").mkdir(parents=True)
        event = {"tool_name": "Edit", "tool_input": {"file_path": "shared/x.swift"}, "cwd": str(self.code_root)}
        proc = run_hook(event, home=self.home, cwd=decoy)
        self.assertEqual(proc.returncode, 2, proc.stderr)
        event["tool_input"]["file_path"] = "Tripix/x.swift"
        proc = run_hook(event, home=self.home, cwd=decoy)
        self.assertEqual(proc.returncode, 0, proc.stderr)


class FrontmatterLauncherTests(Base):
    """П.3: точные строки запуска хуков через `sh -c`, включая отсутствующий интерпретатор."""

    def setUp(self):
        super().setUp()
        hooks = self.home / ".agent-kit" / "current" / "hooks"
        hooks.mkdir(parents=True)
        (hooks / "scope-guard.py").symlink_to(HOOK_PATH)
        (hooks / "readonly-guard.py").symlink_to(READONLY_GUARD_PATH)
        self.write_scopes({"implementer": {"allow": ["Tripix/"], "deny": []}})
        self.collab_ok()

    def sh(self, command, event):
        proc = subprocess.run(["/bin/sh", "-c", command], input=json.dumps(event).encode(), capture_output=True,
                              env={"HOME": str(self.home), "PATH": "/usr/bin:/bin"}, cwd=str(self.code_root), timeout=20)
        return proc

    def missing_interpreter(self, command):
        self.assertIn(FRONTMATTER_PYTHON, command)
        return command.replace(FRONTMATTER_PYTHON, str(self.base / "no-such-dir" / "python3"))

    def test_implementer_command(self):
        command, front = frontmatter_command(IMPLEMENTER_MD)
        self.assertIn(f'{FRONTMATTER_PYTHON} "$HOME/.agent-kit/current/hooks/scope-guard.py"', command)
        self.assertRegex(front, r"timeout:\s*15\b")
        allow = self.sh(command, self.event_for("Tripix/Foo.swift"))
        self.assertEqual(allow.returncode, 0, allow.stderr)
        block = self.sh(command, self.event_for("shared/x.swift"))
        self.assertEqual(block.returncode, 2, block.stderr)
        self.assertIn("scope-guard", block.stderr.decode())
        missing = self.sh(self.missing_interpreter(command), self.event_for("Tripix/Foo.swift"))
        self.assertEqual(missing.returncode, 2, missing.stderr)

    def test_implementer_command_blocks_when_hook_file_missing(self):
        command, _ = frontmatter_command(IMPLEMENTER_MD)
        (self.home / ".agent-kit" / "current" / "hooks" / "scope-guard.py").unlink()
        proc = self.sh(command, self.event_for("Tripix/Foo.swift"))
        self.assertEqual(proc.returncode, 2)

    def test_verifier_command(self):
        command, _ = frontmatter_command(VERIFIER_MD)
        self.assertIn(f'{FRONTMATTER_PYTHON} "$HOME/.agent-kit/current/hooks/readonly-guard.py"', command)
        read_only = {"tool_name": "Bash", "tool_input": {"command": "git status --porcelain"}, "cwd": str(self.code_root)}
        self.assertEqual(self.sh(command, read_only).returncode, 0)
        mutating = {"tool_name": "Bash", "tool_input": {"command": "rm -rf build"}, "cwd": str(self.code_root)}
        self.assertEqual(self.sh(command, mutating).returncode, 2)
        missing = self.sh(self.missing_interpreter(command), mutating)
        self.assertEqual(missing.returncode, 2, missing.stderr)
        missing_ro = self.sh(self.missing_interpreter(command), read_only)
        self.assertEqual(missing_ro.returncode, 2, "a broken guard must block even read-only commands")


class CodexReviewSkillTests(unittest.TestCase):
    """П.7: вывод Codex — в приватный каталог, collab отключается там, где не нужен."""

    def test_no_predictable_tmp_output(self):
        text = CODEX_REVIEW_SKILL.read_text(encoding="utf-8")
        self.assertNotIn("/tmp/codex-review-", text)
        self.assertIn("mktemp -d", text)
        self.assertIn("mcp_servers.collab.enabled=false", text)


if __name__ == "__main__":
    unittest.main()
