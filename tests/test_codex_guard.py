#!/usr/bin/env python3
"""Тесты hooks/codex-guard.py — PreToolUse-хук ведущей сессии Codex.

Вход — как у codex-cli 0.154 (проверено вживую): Bash → tool_input.command — строка команды;
apply_patch → tool_input.command — текст патча со строками `*** Add|Update File: <путь>`.
Запуск: `PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -m unittest -v tests/test_codex_guard.py`.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

HOOK = Path(__file__).resolve().parent.parent / "hooks" / "codex-guard.py"
PYTHON = "/usr/bin/python3" if os.path.exists("/usr/bin/python3") else sys.executable


def run(event, home="/nonexistent"):
    proc = subprocess.run([PYTHON, str(HOOK)], input=json.dumps(event).encode(), capture_output=True,
                          env={"HOME": home, "PATH": "/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1"}, timeout=30)
    return proc.returncode, proc.stderr.decode("utf-8", "replace")


def bash(command, cwd="/"):
    return {"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": command}, "cwd": cwd}


class ModelTests(unittest.TestCase):
    def test_agent_calls_without_a_model_are_blocked(self):
        for command in ("codex exec 'review this'", "cd sub && codex exec hi </dev/null", "FOO=1 codex e hi",
                        "claude -p 'review this'", "ls | claude --print x"):
            with self.subTest(command=command):
                code, err = run(bash(command))
                self.assertEqual(code, 2, command)
                self.assertIn("без явной модели", err)

    def test_explicit_models_and_other_commands_pass(self):
        for command in ("codex exec -m gpt-5.6-luna hi", "codex exec --model=gpt-5.6-sol hi", "codex exec -p cheap hi",
                        "claude -p x --model sonnet", "claude --model=haiku -p x", "claude --version", "codex --version",
                        "ls -la", "echo 'codex exec hi'"):
            with self.subTest(command=command):
                self.assertEqual(run(bash(command))[0], 0, command)


class PlanGateTests(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix="codex-guard-"))
        self.root = self.base / "project"
        (self.root / "src").mkdir(parents=True)
        (self.root / "plans").mkdir()
        self.registry = self.base / "registry"
        self.write_project({"plans_dir": "plans", "paths": ["src/"]})
        self.home = self.base / "home"
        bin_dir = self.home / ".agent-kit" / "current" / "bin"
        bin_dir.mkdir(parents=True)
        payload = bin_dir / "collab.payload"
        payload.write_text(json.dumps({"projectId": "demo", "registryDir": str(self.registry), "codeRoot": str(self.root)}))
        collab = bin_dir / "collab"
        collab.write_text('#!/bin/sh\ncat "%s"\n' % payload)
        collab.chmod(0o755)

    def tearDown(self):
        shutil.rmtree(self.base, ignore_errors=True)

    def write_project(self, gate):
        (self.registry / "demo").mkdir(parents=True, exist_ok=True)
        project = {"id": "demo", "roots": [str(self.root)]}
        if gate is not None:
            project["plan_gate"] = gate
        (self.registry / "demo" / "project.json").write_text(json.dumps(project))

    def plan(self, name, text, age=0):
        path = self.root / "plans" / name
        path.write_text(text)
        stamp = time.time() - age
        os.utime(path, (stamp, stamp))
        return path

    def patch(self, target, transcript=None):
        event = {"hook_event_name": "PreToolUse", "tool_name": "apply_patch",
                 "tool_input": {"command": "*** Begin Patch\n*** Add File: %s\n+x\n*** End Patch" % target},
                 "cwd": str(self.root), "transcript_path": transcript}
        return run(event, home=str(self.home))

    def test_code_edit_needs_a_plan_with_route_and_ux_impact(self):
        code, err = self.patch(self.root / "src" / "a.js")
        self.assertEqual(code, 2)
        self.assertIn("нет плана", err)
        self.plan("p.md", "# p\nМаршрут: я\n")
        code, err = self.patch(self.root / "src" / "a.js")
        self.assertEqual(code, 2)
        self.assertIn("ux_impact", err)
        self.plan("p.md", "# p\nМаршрут: я\n- ux_impact: LOW\n")
        self.assertEqual(self.patch(self.root / "src" / "a.js")[0], 0)

    def test_relative_paths_are_resolved_against_cwd(self):
        self.assertEqual(self.patch("src/a.js")[0], 2)

    def test_ungated_paths_plans_and_projects_without_a_gate_pass(self):
        self.assertEqual(self.patch(self.root / "docs.md")[0], 0, "not under plan_gate paths")
        self.assertEqual(self.patch(self.root / "plans" / "new.md")[0], 0, "writing the plan itself")
        self.write_project(None)
        self.assertEqual(self.patch(self.root / "src" / "a.js")[0], 0, "no plan_gate: nothing to enforce")
        self.assertEqual(run({"tool_name": "apply_patch", "tool_input": {"command": "*** Add File: /x\n"}, "cwd": "/"})[0], 0,
                         "no collab here: the lead is not stopped")

    def test_this_session_plan_wins_over_a_newer_foreign_one(self):
        mine = self.plan("mine.md", "Маршрут: я\nux_impact: NONE\n", age=100)
        self.plan("theirs.md", "Маршрут: они\n", age=0)
        transcript = self.base / "rollout.jsonl"
        transcript.write_text(json.dumps({"patch": "*** Add File: %s\n" % mine}) + "\n")
        self.assertEqual(self.patch(self.root / "src" / "a.js", transcript=str(transcript))[0], 0)
        self.assertEqual(self.patch(self.root / "src" / "a.js")[0], 2, "without a transcript the newest plan decides")


if __name__ == "__main__":
    unittest.main()
