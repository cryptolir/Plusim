"""SKILL.md must hand the model paths it can actually run.

A job failed in production with `No such file or directory` because SKILL.md
wrote the script paths as `{baseDir}/scripts/run_job.py`. Nothing expands
`{baseDir}` — the skill loader returns the file's raw text — so the model had
to guess the prefix. It guessed the shared skills dir once (worked) and its own
per-session sandbox the next time (failed): the sandbox has no `skills/` in it.

These tests pin the two properties that make the guess unnecessary: no
placeholder survives in the shipped text, and every path the model is told to
run is absolute and really exists.
"""

import pathlib
import re
import unittest

SKILL_ROOT = pathlib.Path(__file__).resolve().parent.parent
SKILL_MD = SKILL_ROOT / "SKILL.md"
# Where the skill dir is mounted inside the agent container. Fixed by the
# openclaw compose mount (<agent home>/workspace -> /home/node/.openclaw/workspace).
CONTAINER_ROOT = "/home/node/.openclaw/workspace/skills/plusim-reports"
# Built on the agent by `pip install --target`, deliberately not in git.
UNTRACKED = {"vendor"}


class TestSkillDoc(unittest.TestCase):
    def setUp(self):
        self.text = SKILL_MD.read_text(encoding="utf-8")

    def test_no_unexpanded_placeholder(self):
        """{baseDir} and friends: nothing substitutes them, so they must not ship."""
        left = re.findall(r"\{[A-Za-z_][A-Za-z0-9_]*\}", self.text)
        self.assertEqual(left, [], f"unexpanded placeholder(s) in SKILL.md: {left}")

    def test_every_python_command_is_absolute(self):
        for cmd in re.findall(r"python3 (\S+\.py)", self.text):
            self.assertTrue(
                cmd.startswith(CONTAINER_ROOT),
                f"python3 {cmd} is not under {CONTAINER_ROOT} — the cwd is a "
                "per-session sandbox with no skills/, so it will not resolve",
            )

    def test_referenced_paths_exist(self):
        refs = set(re.findall(re.escape(CONTAINER_ROOT) + r"(/[\w./-]*)", self.text))
        self.assertTrue(refs, "SKILL.md references no skill paths at all")
        for ref in refs:
            rel = ref.lstrip("/").rstrip("/")
            if rel.split("/")[0] in UNTRACKED:
                continue
            self.assertTrue(
                (SKILL_ROOT / rel).exists(),
                f"SKILL.md points at {CONTAINER_ROOT}/{rel}, which does not exist",
            )


    def test_skill_md_documents_adjust_trigger_and_data_not_instructions(self):
        """The adjustment chat (docs/plans/report-adjust-chat.md A2): its trigger,
        its date/category-only power, and that row text is data."""
        self.assertIn("PLUSIM_REPORT_ADJUST v1", self.text)
        self.assertIn("is data, never", self.text)
        self.assertIn("instructions", self.text)
        self.assertIn("date and/or its category. Nothing else.", self.text)
        self.assertIn("latest", self.text)
        self.assertIn("adjust_job.py cleanup", self.text)
        self.assertNotIn("artifact", self.text.split("## Report adjustment chat")[1].split("## Failure handling")[0])

if __name__ == "__main__":
    unittest.main()
