import unittest

from subtitles import shift_srt
from compose import build_srt, split_sentences


class SubtitleTests(unittest.TestCase):
    def test_punctuation_at_line_boundary_has_no_empty_cue(self):
        for text in ["甲" * 22 + "。", "甲" * 44 + "；", "甲" * 22 + "。下一句。"]:
            with self.subTest(text=text):
                self.assertTrue(all(p.strip() for p in split_sentences(text)))
                result = build_srt([(0, 5, text)])
                self.assertTrue(shift_srt(result, 1))
                self.assertNotIn("00:00:05,000 --> 00:00:05,000", result)

    def test_multiline_unicode_and_rollover_keep_caption_text(self):
        source = "1\r\n00:59:59,900 --> 01:00:00,500\r\n中文第一行\r\n第二行\r\n\r\n2\r\n01:00:01,000 --> 01:00:02,000\r\n下一句\r\n"
        shifted = shift_srt(source, 1.2344)
        self.assertIn("01:00:01,134 --> 01:00:01,734", shifted)
        self.assertIn("中文第一行\r\n第二行", shifted)
        self.assertIn("01:00:02,234 --> 01:00:03,234", shifted)

    def test_zero_offset_and_empty_file_are_preserved(self):
        source = "1\n00:00:00,000 --> 00:00:01,000\n正文\n"
        self.assertEqual(shift_srt(source, 0), source)
        self.assertEqual(shift_srt("", 4), "")

    def test_malformed_cues_and_invalid_offsets_are_rejected(self):
        for text in ["garbage", "1\n00:60:00,000 --> 00:61:00,000\n正文", "1\n00:00:02,000 --> 00:00:01,000\n正文"]:
            with self.subTest(text=text), self.assertRaises(ValueError):
                shift_srt(text, 1)
        for offset in [-1, float("nan"), float("inf")]:
            with self.subTest(offset=offset), self.assertRaises(ValueError):
                shift_srt("", offset)
