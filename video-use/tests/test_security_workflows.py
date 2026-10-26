"""Security and evidence isolation regressions for the real pipeline."""
from pathlib import Path
import json
import os
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "helpers"))
import agent_edit
import short_pipeline
import review
import stream_clip


class SecurityWorkflowTests(unittest.TestCase):
    def test_windows_batch_agents_are_rejected_before_untrusted_text_can_execute(self):
        with patch.object(agent_edit.os, "name", "nt"), patch.object(agent_edit.shutil, "which", side_effect=lambda name: None if name.endswith(".exe") else "C:\\tools\\codex.cmd"), patch.object(agent_edit.subprocess, "run") as run:
            result = agent_edit.probe_agent("codex")
        self.assertFalse(result["available"])
        self.assertIn("native .exe", result["note"])
        run.assert_not_called()

    def test_stream_urls_cannot_carry_credentials_or_arbitrary_ports(self):
        for url in ("https://user:password@youtube.com/watch?v=abcdefghijk", "https://youtube.com:22/watch?v=abcdefghijk", "https://youtube.com:bad/watch?v=abcdefghijk"):
            self.assertFalse(stream_clip.is_supported_url(url))
        self.assertTrue(stream_clip.is_supported_url("https://www.youtube.com/watch?v=abcdefghijk"))

    def test_auto_without_an_agent_never_encodes_the_entire_long_recording(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = [os.path.join(directory, name) for name in ("long.mp4", "short.mp4")]
            with open(source, "wb") as handle:
                handle.write(b"fixture")
            args = short_pipeline.build_parser().parse_args(["--input", source, "--output", output, "--agent", "auto", "--duration", "0", "--subtitles", "none"])
            with patch.object(short_pipeline, "transcribe_isolated", return_value=1), patch.object(short_pipeline.render_mod, "probe_media", return_value={"duration": 3600}), patch.object(short_pipeline.render_mod, "render_short", side_effect=lambda _source, output, *args, **kwargs: Path(output).write_bytes(b"encoded")) as render_short:
                self.assertEqual(short_pipeline.run_render(args), 0)
            self.assertEqual(render_short.call_args.kwargs["cut_duration"], 30.0)
            with open(output + ".edl.json") as handle:
                self.assertEqual(json.load(handle)["segments"][0]["end"], 30.0)

    def test_refuses_source_overwrite_before_running_any_worker(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "original.mp4")
            with open(path, "wb") as handle:
                handle.write(b"original media")
            args = short_pipeline.build_parser().parse_args(["--input", path, "--output", path])
            with patch.object(short_pipeline.render_mod, "probe_media") as probe:
                self.assertEqual(short_pipeline.run_render(args), 1)
                probe.assert_not_called()
            with open(path, "rb") as handle:
                self.assertEqual(handle.read(), b"original media")

    def test_transcription_secret_is_not_on_worker_command_line(self):
        with patch.object(short_pipeline.subprocess, "run", return_value=types.SimpleNamespace(returncode=0)) as run:
            short_pipeline.transcribe_isolated(["--input", "source.mp4", "--elevenlabs-key", "test-secret"])
        argv = run.call_args.args[0]
        self.assertNotIn("test-secret", argv)
        self.assertNotIn("--elevenlabs-key", argv)
        self.assertEqual(run.call_args.kwargs["env"]["PIXEL_ELEVENLABS_KEY"], "test-secret")

    def test_editing_agent_does_not_inherit_other_service_keys(self):
        with patch.dict(os.environ, {"PIXEL_ELEVENLABS_KEY": "secret", "PIXEL_YOUTUBE_KEY": "secret", "ZERNIO_API_KEY": "secret"}):
            env = agent_edit.private_agent_env()
        for key in ("PIXEL_ELEVENLABS_KEY", "PIXEL_YOUTUBE_KEY", "ZERNIO_API_KEY"):
            self.assertNotIn(key, env)

    def test_nonfinite_agent_timestamps_are_rejected(self):
        for end in (float("inf"), float("nan")):
            with self.assertRaises(agent_edit.AgentError):
                agent_edit.validate_edl({"segments": [{"start": 1, "end": end}]}, 20)

    def test_each_output_keeps_its_own_transcript_and_edl(self):
        with tempfile.TemporaryDirectory() as directory:
            source = os.path.join(directory, "source.mp4")
            with open(source, "wb") as handle:
                handle.write(b"fixture")
            def transcript(argv):
                words_path = argv[argv.index("--output") + 1]
                with open(words_path, "w") as handle:
                    json.dump({"model": "fixture", "words": [{"word": os.path.basename(words_path), "start": 0, "end": .5}]}, handle)
                return 0
            with patch.object(short_pipeline, "transcribe_isolated", side_effect=transcript), patch.object(short_pipeline.render_mod, "probe_media", return_value={"duration": 5}), patch.object(short_pipeline.render_mod, "render_short", side_effect=lambda _source, output, *args, **kwargs: Path(output).write_bytes(b"encoded")):
                for name in ("first.mp4", "second.mp4"):
                    output = os.path.join(directory, name)
                    args = short_pipeline.build_parser().parse_args(["--input", source, "--output", output, "--agent", "auto", "--duration", "2"])
                    self.assertEqual(short_pipeline.run_render(args), 0)
                    with open(output + ".words.json") as handle:
                        self.assertEqual(json.load(handle)["words"][0]["word"], name + ".words.json")
                    self.assertTrue(os.path.isfile(output + ".edl.json"))
                self.assertFalse(os.path.exists(os.path.join(directory, "words.json")))
                self.assertFalse(os.path.exists(os.path.join(directory, "edl.json")))

    def test_agent_tool_restrictions_are_explicit(self):
        claude = agent_edit._claude_argv("claude", "prompt", None, None)
        self.assertEqual(claude[claude.index("--tools") + 1], "")
        codex = agent_edit._codex_argv("codex", "prompt", None, None)
        self.assertEqual(codex[codex.index("--sandbox") + 1], "read-only")
