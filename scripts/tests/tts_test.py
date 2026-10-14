import subprocess
import unittest
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, patch
from tts import synth


class HandshakeTests(unittest.IsolatedAsyncioTestCase):
    async def test_forbidden_stops_without_retries_or_partial_audio(self):
        error = Exception("private query must not appear")
        error.status = 403
        fake = AsyncMock()
        fake.save.side_effect = error
        with tempfile.TemporaryDirectory(prefix="training-tts-unit-") as directory:
            target = Path(directory) / "voice.mp3"
            with patch("speech.communicator", return_value=fake):
                with self.assertRaisesRegex(RuntimeError, "拒绝握手"):
                    await synth("固定测试", target, "voice", "-6%")
            self.assertEqual(fake.save.await_count, 1)
            self.assertFalse(target.exists())
            self.assertFalse(target.with_suffix(".part").exists())
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
