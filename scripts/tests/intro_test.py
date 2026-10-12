import subprocess
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import intro


class VerificationTests(unittest.TestCase):
    def test_colors_cannot_insert_filter_syntax(self):
        with tempfile.TemporaryDirectory(prefix="training-card-color-") as temp:
            root = Path(temp)
            for key in ("accent", "bg1", "bg2"):
                values = {"accent": "0x2f7fd0", "bg1": "0x0b1622", "bg2": "0x17324f"}
                values[key] = "red:t=fill,drawbox=x=0:y=0:w=160:h=160:color=white"
                with self.subTest(key=key), patch.object(intro, "HERE", root), patch.object(intro, "ff") as ff:
                    with self.assertRaisesRegex(ValueError, key + ".*颜色"):
                        intro.build_card_video(1, "标题", "", "", values["accent"], values["bg1"], values["bg2"], "", root / "card.mp4")
                    ff.assert_not_called()
            self.assertEqual(list(root.iterdir()), [])

    def test_card_text_is_literal_and_temporary_files_are_cleaned(self):
        with tempfile.TemporaryDirectory(prefix="training-card-text-") as temp:
            root = Path(temp)
            expected = {"title": "采购: O'Reilly 100%{n}", "subtitle": "状态: [完成]\\路径",
                        "footer": "批次, A; B", "watermark": "公司: 100%"}

            def rendered(args, **kwargs):
                graph = args[args.index("-vf") + 1]
                paths = re.findall(r"textfile=([^:]+):expansion=none", graph)
                self.assertEqual(len(paths), 4)
                self.assertEqual({Path(p).stem: (root / p).read_text("utf-8") for p in paths}, expected)
                self.assertNotIn(":text=", graph)
                return subprocess.CompletedProcess([], 0, "")

            with patch.object(intro, "HERE", root), patch.object(intro, "ff", side_effect=rendered):
                intro.build_card_video(3, expected["title"], expected["subtitle"], expected["footer"],
                                       "0x2f7fd0", "0x0b1622", "0x17324f", expected["watermark"], root / "card.mp4")
            self.assertEqual(list(root.iterdir()), [])

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
