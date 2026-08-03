# -*- coding: utf-8 -*-
"""Regression tests for --workdir containment — the statement-leak bug.

`--workdir` comes from the MODEL. A mangled argument once produced a directory
literally named ",timeout:300}" inside the skill folder, and a customer's
statement PDF was downloaded into it. The agent workspace is persistent, so the
file outlived the job; the mandatory cleanup step never removed it, because
cleanup only deletes the path it is handed. Two such leaks were cleaned by hand.

Second hazard in the same argument: `cleanup` calls shutil.rmtree on it, so a
bad value does not merely leak — it deletes whatever it names.

    python3 -m unittest test_safe_workdir
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(_HERE), "vendor"))
sys.path.insert(0, _HERE)

from run_job import (  # noqa: E402
    SCRATCH_ROOT,
    UnsafeWorkdirError,
    safe_dest,
    safe_workdir,
)

# The REAL deployed locations, hardcoded on purpose. Deriving them from
# __file__ would make the test pass vacuously whenever the suite is run from a
# copy under /tmp — which is exactly how it is run in CI and on the box.
WORKSPACE = "/root/.openclaw/agents/onlyclaw/workspace"
SKILL_DIR = f"{WORKSPACE}/skills/plusim-reports"


class TestSafeWorkdir(unittest.TestCase):
    def test_accepts_the_documented_shape(self):
        """SKILL.md tells the agent to use /tmp/plusim-job-<jobId>."""
        wd = safe_workdir(os.path.join(SCRATCH_ROOT, "plusim-job-cmsc94wxh0007"))
        self.assertTrue(wd.startswith(SCRATCH_ROOT + os.sep))

    def test_rejects_the_exact_path_that_leaked(self):
        """The real incident: a mangled arg landed scratch inside the skill dir."""
        leaked = f"{SKILL_DIR}/,timeout:300}}"
        with self.assertRaises(UnsafeWorkdirError) as ctx:
            safe_workdir(leaked)
        self.assertIn(",timeout:300}", str(ctx.exception))

    def test_rejects_anywhere_in_the_agent_workspace(self):
        for bad in [
            WORKSPACE,
            SKILL_DIR,
            f"{SKILL_DIR}/scripts",
            f"{WORKSPACE}/memory",
        ]:
            with self.assertRaises(UnsafeWorkdirError):
                safe_workdir(bad)

    def test_rejects_a_relative_path(self):
        """Relative resolves against CWD, so safety would depend on where the
        agent was invoked. Refused outright, whatever the CWD happens to be."""
        for bad in ["scratch", "./scratch", "../scratch"]:
            with self.assertRaises(UnsafeWorkdirError):
                safe_workdir(bad)

    def test_rejects_the_scratch_root_itself(self):
        """cleanup rmtree's this path — /tmp itself must never be the target."""
        with self.assertRaises(UnsafeWorkdirError):
            safe_workdir(SCRATCH_ROOT)
        with self.assertRaises(UnsafeWorkdirError):
            safe_workdir(SCRATCH_ROOT + os.sep)

    def test_rejects_paths_that_only_look_like_scratch(self):
        """A prefix match on the string alone would let '/tmpfoo' through."""
        with self.assertRaises(UnsafeWorkdirError):
            safe_workdir(SCRATCH_ROOT + "-evil/job")

    def test_rejects_traversal_back_out_of_scratch(self):
        """Resolved, not just string-checked: .. must not escape the root."""
        for bad in [
            os.path.join(SCRATCH_ROOT, "..", "root", "job"),
            os.path.join(SCRATCH_ROOT, "job", "..", "..", "etc"),
        ]:
            with self.assertRaises(UnsafeWorkdirError):
                safe_workdir(bad)

    def test_rejects_a_symlink_out_of_scratch(self):
        """realpath, so a symlink under /tmp cannot point at the workspace."""
        with tempfile.TemporaryDirectory(dir=SCRATCH_ROOT) as tmp:
            link = os.path.join(tmp, "escape")
            os.symlink("/root", link)
            with self.assertRaises(UnsafeWorkdirError):
                safe_workdir(link)

    def test_root_and_dangerous_paths_are_refused(self):
        for bad in ["/", "/root", "/etc", "/opt/openclaw"]:
            with self.assertRaises(UnsafeWorkdirError):
                safe_workdir(bad)


class TestScratchRootIsPinned(unittest.TestCase):
    """Codex #42 P1: tempfile.gettempdir() honours $TMPDIR, so the model could
    have relocated the 'safe' root into the persistent workspace by prefixing
    one invocation with TMPDIR=<workspace>. The root must not be env-derived."""

    def test_root_is_literal_tmp_not_tmpdir(self):
        self.assertEqual(SCRATCH_ROOT, os.path.realpath("/tmp"))

    def test_tmpdir_cannot_move_the_root(self):
        import importlib

        old = os.environ.get("TMPDIR")
        os.environ["TMPDIR"] = WORKSPACE
        try:
            import run_job

            importlib.reload(run_job)
            self.assertEqual(run_job.SCRATCH_ROOT, os.path.realpath("/tmp"))
            with self.assertRaises(run_job.UnsafeWorkdirError):
                run_job.safe_workdir(f"{WORKSPACE}/plusim-job-x")
        finally:
            if old is None:
                os.environ.pop("TMPDIR", None)
            else:
                os.environ["TMPDIR"] = old
            importlib.reload(importlib.import_module("run_job"))


class TestSafeDest(unittest.TestCase):
    """The manifest filename is admin-supplied and NOT path-sanitised app-side
    (reportStatementUpload.ts stores f.name.slice(0, 200) verbatim), so the
    download path is a traversal sink — writing as root on the agent host."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(dir=SCRATCH_ROOT)
        self.files = os.path.join(self.tmp, "files")
        os.makedirs(self.files)

    def tearDown(self):
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_keeps_an_ordinary_name(self):
        self.assertEqual(safe_dest(self.files, "מקס אפריל.pdf"),
                         os.path.join(self.files, "מקס אפריל.pdf"))

    def test_strips_traversal(self):
        for bad in [
            "../../../root/.ssh/authorized_keys",
            "../escape.pdf",
            "/etc/passwd",
            "..\\..\\win.pdf",
        ]:
            dest = safe_dest(self.files, bad)
            self.assertEqual(os.path.dirname(dest), self.files, f"escaped for {bad!r}")

    def test_degenerate_names_get_a_placeholder(self):
        for weird in ["", ".", "..", "   ", "/"]:
            dest = safe_dest(self.files, weird)
            self.assertEqual(os.path.dirname(dest), self.files)
            self.assertNotEqual(os.path.basename(dest), "")


if __name__ == "__main__":
    unittest.main()
