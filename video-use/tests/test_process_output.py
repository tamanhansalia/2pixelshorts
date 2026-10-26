"""Regressions for truncated FFmpeg logs and a relocated video engine."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

HELPERS = Path(__file__).resolve().parents[1] / "helpers"
sys.path.insert(0, str(HELPERS))
import agent_edit
import render
import short_pipeline
import stream_clip
import transcribe


# Run a real child so subprocess performs decoding, rather than returning
# already-decoded mock strings that cannot reproduce the original failure.
REAL_RUN = subprocess.run


def child_output(stdout=b"", stderr=b"metadata: \xe2\x80\n", code=0):
    program = (f"import sys; sys.stdout.buffer.write({stdout!r}); "
               f"sys.stderr.buffer.write({stderr!r}); sys.exit({code})")

    def run(_argv, **kwargs):
        return REAL_RUN([sys.executable, "-c", program], **kwargs)

    return run


class ProcessOutputTests(unittest.TestCase):
    def test_probe_accepts_valid_json_with_malformed_diagnostics(self):
        payload = {"streams": [{"width": 320, "height": 240, "codec_type": "video"}],
                   "format": {"duration": "2.0"}}
        with patch.object(render, "_which_or_raise", return_value="ffprobe"), \
                patch.object(subprocess, "run", side_effect=child_output(json.dumps(payload).encode())):
            self.assertEqual(render.probe_media("source.mp4"),
                             {"width": 320, "height": 240, "duration": 2., "has_audio": False})

    def test_probe_failure_preserves_error_instead_of_decode_traceback(self):
        with patch.object(render, "_which_or_raise", return_value="ffprobe"), \
                patch.object(subprocess, "run", side_effect=child_output(
                    stderr=b"Invalid data: \xe2\x80\n", code=1)):
            with self.assertRaisesRegex(render.RenderError, "ffprobe failed.*Invalid data"):
                render.probe_media("source.mp4")

    def test_render_failure_preserves_error_instead_of_decode_traceback(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.mp4"
            source.write_bytes(b"fixture")
            info = {"width": 320, "height": 240, "duration": 2., "has_audio": False}
            with patch.object(render, "_which_or_raise", return_value="ffmpeg"), \
                    patch.object(render, "probe_media", return_value=info), \
                    patch.dict(sys.modules, cv2=None), \
                    patch.object(subprocess, "run", side_effect=child_output(
                        stderr=b"Error opening output: \xe2\x80\n", code=1)):
                with self.assertRaisesRegex(render.RenderError, "framed render failed.*Error opening output"):
                    render.render_short(str(source), str(Path(directory) / "short.mp4"), log=lambda _: None)

    def test_probe_launch_and_timeout_failures_are_render_errors(self):
        for error in (OSError("cannot launch"), subprocess.TimeoutExpired("ffprobe", 60)):
            with self.subTest(error=error), \
                    patch.object(render, "_which_or_raise", return_value="ffprobe"), \
                    patch.object(subprocess, "run", side_effect=error):
                with self.assertRaisesRegex(render.RenderError, "could not probe"):
                    render.probe_media("source.mp4")

    def test_audio_extraction_reports_actual_failure(self):
        fake_whisper = types.SimpleNamespace(WhisperModel=lambda *a, **k: None)
        with patch.dict(sys.modules, faster_whisper=fake_whisper), \
                patch.object(transcribe.shutil, "which", return_value="ffmpeg"), \
                patch.object(subprocess, "run", side_effect=child_output(
                    stderr=b"Invalid audio: \xe2\x80\n", code=1)):
            with self.assertRaisesRegex(transcribe.TranscribeError, "audio extraction failed.*Invalid audio"):
                transcribe.transcribe_local("source.mp4")

    def test_download_output_survives_malformed_diagnostics(self):
        with patch.object(subprocess, "run", side_effect=child_output(b'{"title": "caf\xc3\xa9"}')):
            result = stream_clip._run(["yt-dlp", "--dump-json"], 5)
        self.assertEqual(json.loads(result.stdout)["title"], "café")
        self.assertIn("\ufffd", result.stderr)

    def test_editing_agent_json_survives_malformed_diagnostics(self):
        payload = {"segments": [{"start": 0, "end": 1}]}
        with patch.object(agent_edit, "probe_agent", return_value={"available": True, "path": "codex"}), \
                patch.object(subprocess, "run", side_effect=child_output(json.dumps(payload).encode())):
            result = agent_edit.run_agent_cut("codex", "A short café demo", 2)
        self.assertEqual(result["segments"][0]["end"], 1)

    def test_seo_agent_json_survives_malformed_diagnostics(self):
        payload = {"title": "café demo", "title_alternatives": ["Coffee demo"],
                   "description": "A demo", "tags": ["coffee"], "hashtags": ["#coffee"],
                   "hook_detected": "café", "content_highlights": ["Demo"], "overall_summary": "A demo"}
        with patch.object(agent_edit, "probe_agent", return_value={"available": True, "path": "codex"}), \
                patch.object(subprocess, "run", side_effect=child_output(json.dumps(payload).encode())):
            result = short_pipeline.run_agent_seo("codex", "A short café demo", 2, 4)
        self.assertEqual(result["title"], "café demo")


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "requires FFmpeg")
class UnicodeRenderTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="moved engine café 🎬 ")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.source = self.root / "素材 – café 🎬.mp4"
        self.metadata = "a" + "–" * 1200 + "🎬" * 1200
        REAL_RUN(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
                  "color=blue:s=320x240:d=2:r=20", "-f", "lavfi", "-i",
                  "sine=frequency=440:duration=2", "-c:v", "libx264", "-pix_fmt",
                  "yuv420p", "-c:a", "aac", "-shortest", str(self.source)],
                 check=True, capture_output=True, timeout=30)

    def test_edl_with_long_unicode_metadata_and_burned_captions(self):
        output = self.root / "字幕 🎬.mp4"
        words = [{"word": "café", "start": .1, "end": .5},
                 {"word": "hello", "start": 1.3, "end": 1.7}]
        render.render_edl(str(self.source), str(output),
                          [{"start": 0., "end": .8}, {"start": 1.2, "end": 2.}],
                          words=words, subtitle_style="pop", meta_title=self.metadata,
                          meta_desc=self.metadata, log=lambda _: None)
        info = render.probe_media(str(output))
        self.assertEqual((info["width"], info["height"]), (1080, 1920))
        self.assertTrue(info["has_audio"])
        self.assertAlmostEqual(info["duration"], 1.57, delta=.15)
        report = json.loads(output.with_suffix(".framing.json").read_text())
        self.assertTrue(report["validation"]["passed"])
        # Tolerant log decoding must not alter Unicode metadata in the file.
        probe = REAL_RUN(["ffprobe", "-v", "error", "-show_entries", "format_tags=title,comment",
                          "-of", "json", str(output)], capture_output=True, check=True, timeout=30)
        self.assertEqual(json.loads(probe.stdout)["format"]["tags"]["comment"], self.metadata)

    def test_relocated_cli_runs_head_cut_and_manual_trim_from_unrelated_cwd(self):
        moved = self.root / "relocated video-use" / "helpers"
        shutil.copytree(HELPERS, moved, ignore=shutil.ignore_patterns("__pycache__"))
        work = self.root / "unrelated working directory"
        work.mkdir()
        env = dict(os.environ, PIXEL_ELEVENLABS_KEY="", PIXEL_YOUTUBE_KEY="")
        for mode, options, expected in (("head", ["--duration", "1"], 1.),
                                        ("manual", ["--cut-start", ".5", "--cut-end", "1.5"], 1.)):
            with self.subTest(mode=mode):
                output = self.root / f"{mode} 移動.mp4"
                result = REAL_RUN([sys.executable, str(moved / "short_pipeline.py"),
                                   "--input", str(self.source), "--output", str(output),
                                   "--engine", "auto", "--subtitles", "none",
                                   "--meta-desc", self.metadata, *options],
                                  cwd=work, env=env, capture_output=True, encoding="utf-8",
                                  errors="replace", timeout=60)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("[COMPLETE]", result.stdout)
                info = render.probe_media(str(output))
                self.assertTrue(info["has_audio"])
                self.assertAlmostEqual(info["duration"], expected, delta=.15)
                self.assertTrue(json.loads(output.with_suffix(".framing.json").read_text())
                                ["validation"]["passed"])


if __name__ == "__main__":
    unittest.main()
