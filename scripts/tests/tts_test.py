import subprocess
import unittest
from unittest.mock import patch

import tts


class AudioProbeTests(unittest.TestCase):
    def test_partial_decoding_failure_cannot_be_a_usable_clip(self):
        result = subprocess.CompletedProcess([], 1, "time=00:00:01.200\nfixture decoder failure")
        with patch.object(tts.subprocess, "run", return_value=result):
            self.assertIsNone(tts.duration_of("fixture.mp3"))

    def test_zero_duration_is_rejected(self):
        with patch.object(tts.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "time=00:00:00.000")):
            self.assertIsNone(tts.duration_of("fixture.mp3"))

    def test_valid_duration_is_preserved(self):
        with patch.object(tts.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "time=00:00:01.200")):
            self.assertEqual(tts.duration_of("fixture.mp3"), 1.2)
