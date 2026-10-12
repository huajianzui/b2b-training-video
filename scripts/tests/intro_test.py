import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import intro


class VerificationTests(unittest.TestCase):
    def test_missing_node_is_failure(self):
        with patch.object(intro, "usable", return_value=False):
            self.assertFalse(intro.verify(Path("fixture.mp4")))

    def test_verification_timeout_is_failure(self):
        with patch.object(intro, "usable", return_value=True), patch.object(
            intro.subprocess, "run", side_effect=subprocess.TimeoutExpired("node", 60)
        ):
            self.assertFalse(intro.verify(Path("fixture.mp4")))

    def test_main_propagates_verifier_failure(self):
        with tempfile.TemporaryDirectory(prefix="training-intro-unit-") as temp:
            root = Path(temp)
            card = root / "card.mp4"
            card.write_bytes(b"unit-fixture")
            with patch.object(intro, "HERE", root), patch.object(intro, "usable", return_value=True), patch.object(
                intro, "check_fonts"
            ), patch.object(intro, "flow_stats", return_value=(0, 0)), patch.object(
                intro, "make_card", return_value=card
            ), patch.object(intro, "verify", return_value=False), patch.object(
                intro.sys, "argv", ["intro.py", "--narration", ""]
            ):
                with self.assertRaises(SystemExit):
                    intro.main()

    def test_partial_file_does_not_hide_ffmpeg_failure(self):
        with tempfile.TemporaryDirectory(prefix="training-intro-unit-") as temp:
            out = Path(temp) / "partial.mp4"

            def failed(*args, **kwargs):
                out.write_bytes(b"partial-unit-fixture")
                return subprocess.CompletedProcess([], 1, "fixture ffmpeg failure")

            with patch.object(intro, "concat_multi", side_effect=failed):
                with self.assertRaises(SystemExit):
                    intro.join([], out, "fade", 0.6)
