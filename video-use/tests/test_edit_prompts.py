"""Custom prompts must reach planning with real references or fail explicitly."""

import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "helpers"))
import agent_edit
import edit_references
import short_pipeline
import stream_clip

URL = "https://www.youtube.com/watch?v=abcdefghijk"
WORDS = [{"word": "Show", "start": 0, "end": 1},
         {"word": "the result.", "start": 1, "end": 2}]


class ReferenceTests(unittest.TestCase):
    def test_extracts_links_from_prose_and_deduplicates_video_ids(self):
        prompt = ("Match (https://youtu.be/abcdefghijk?t=3), then "
                  "https://www.youtube.com/shorts/abcdefghijk.")
        self.assertEqual(edit_references.youtube_references(prompt), [URL])

    def test_rejects_channels_playlists_and_non_youtube_urls(self):
        for url in ("https://youtube.com/@channel", "https://youtube.com/playlist?list=x",
                    "https://youtube.com.evil.example/watch?v=abcdefghijk",
                    "https://example.com/reference"):
            with self.subTest(url=url), self.assertRaises(edit_references.ReferenceError):
                edit_references.youtube_references(url)

    def test_plain_prompt_needs_no_network(self):
        with patch.object(stream_clip, "probe_url") as probe:
            self.assertEqual(edit_references.resolve_references("Open on my demo."), [])
            probe.assert_not_called()

    def test_reference_evidence_reaches_agent_and_edl(self):
        with patch.object(stream_clip, "probe_url", return_value={
                "title": "Demo reference", "channel": "Creator", "duration": 10}), \
                patch.object(stream_clip, "fetch_caption_words", return_value=(WORDS, "youtube-captions")), \
                patch.object(agent_edit, "_invoke_agent", return_value={
                    "segments": [{"start": 6, "end": 9, "reason": "demo", "score": 1}]}) as agent:
            edl = agent_edit.run_agent_cut("claude", "SOURCE demo at 6-9s", 15, 10,
                                          hook=f"Open on my demo like {URL}")
        sent = agent.call_args.args[1]
        self.assertIn("Show the result.", sent)
        self.assertIn("Demo reference", sent)
        self.assertIn("SOURCE demo at 6-9s", sent)
        self.assertIn("Never copy their", sent)
        self.assertEqual(edl["edit_request"]["references"][0]["words_per_second"], 0.2)
        self.assertEqual(edl["segments"][0]["start"], 6)

    def test_unreadable_reference_prevents_agent_invocation(self):
        with patch.object(stream_clip, "probe_url", side_effect=stream_clip.StreamClipError("private video")), \
                patch.object(agent_edit, "_invoke_agent") as agent:
            with self.assertRaisesRegex(agent_edit.AgentError, "Could not read YouTube reference"):
                agent_edit.run_agent_cut("claude", "takes", 10, hook=URL)
            agent.assert_not_called()

    def test_reference_limit_and_prompt_budget(self):
        with self.assertRaises(edit_references.ReferenceError):
            edit_references.resolve_references("x" * 4001)
        with self.assertRaises(edit_references.ReferenceError):
            edit_references.youtube_references(" ".join(
                f"https://youtu.be/abcdefghij{i}" for i in range(4)))

    def test_multiclip_planning_uses_reference_evidence(self):
        with patch.object(stream_clip, "probe_url", return_value={"duration": 10}), \
                patch.object(stream_clip, "fetch_caption_words", return_value=(WORDS, "youtube-captions")), \
                patch.object(agent_edit, "_invoke_agent", return_value={
                    "segments": [{"start": 40, "end": 65, "score": 1, "reason": "demo"}]}) as agent:
            agent_edit.run_agent_multiclip("claude", "source takes", 100, hook=URL)
        self.assertIn("Show the result.", agent.call_args.args[1])


class StrictPromptTests(unittest.TestCase):
    def render_with_prompt(self, words, agent_error=None, agent="claude", **overrides):
        with tempfile.TemporaryDirectory() as directory:
            args = short_pipeline.build_parser().parse_args([
                "--input", "source.mp4", "--output", os.path.join(directory, "out.mp4"),
                "--agent", agent, "--prompt", "Open on my demo"])
            for key, value in overrides.items():
                setattr(args, key, value)
            def transcribe(argv):
                with open(argv[argv.index("--output") + 1], "w") as fh:
                    json.dump({"words": words}, fh)
                return 0
            with patch.object(short_pipeline.render_mod, "probe_media", return_value={"duration": 20}), \
                    patch.object(short_pipeline, "transcribe_isolated", side_effect=transcribe), \
                    patch.object(agent_edit, "run_agent_cut", side_effect=agent_error) as planner, \
                    patch.object(short_pipeline.render_mod, "render_short") as head, \
                    patch.object(short_pipeline.render_mod, "render_edl") as render_edl, \
                    contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()) as err:
                rc = short_pipeline.run_render(args)
            return rc, err.getvalue(), head.called, render_edl.called, planner.called

    def test_auto_cut_cannot_silently_ignore_custom_prompt(self):
        rc, error, head, edl, planner = self.render_with_prompt(WORDS, agent="auto")
        self.assertEqual(rc, 1)
        self.assertIn("require an editing agent", error)
        self.assertFalse(head or edl or planner)

    def test_no_transcript_fails_without_render(self):
        rc, error, head, edl, _ = self.render_with_prompt([])
        self.assertEqual(rc, 1)
        self.assertIn("no source transcript", error)
        self.assertFalse(head or edl)

    def test_agent_failure_fails_without_fallback(self):
        rc, error, head, edl, _ = self.render_with_prompt(
            WORDS, agent_error=agent_edit.AgentError("agent timed out"))
        self.assertEqual(rc, 1)
        self.assertIn("agent timed out", error)
        self.assertFalse(head or edl)

    def test_manual_trim_cannot_override_custom_prompt(self):
        rc, _, head, edl, planner = self.render_with_prompt(WORDS, cut_start=2)
        self.assertEqual(rc, 1)
        self.assertFalse(head or edl or planner)

    def test_stream_agent_failure_with_prompt_does_not_fall_back(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json") as fh:
            json.dump({"words": WORDS, "duration": 20}, fh)
            fh.flush()
            with patch.object(stream_clip, "suggest_with_agent", side_effect=stream_clip.StreamClipError("agent failed")), \
                    patch.object(stream_clip, "suggest_clips") as heuristic, \
                    contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()):
                rc = stream_clip.main(["--words", fh.name, "--agent", "claude", "--prompt", "Open on my demo"])
            self.assertEqual(rc, 1)
            self.assertEqual(out.getvalue(), "")
            heuristic.assert_not_called()


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "ffmpeg/ffprobe required")
class PromptRenderTests(unittest.TestCase):
    def test_prompt_reference_plan_produces_real_short_and_per_short_record(self):
        with tempfile.TemporaryDirectory() as directory:
            source = os.path.join(directory, "source.mp4")
            output = os.path.join(directory, "short.mp4")
            subprocess.run([
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-f", "lavfi", "-i", "color=c=red:s=320x180:r=24:d=4",
                "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=24:d=2",
                "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]",
                "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", source,
            ], check=True, capture_output=True)
            args = short_pipeline.build_parser().parse_args([
                "--input", source, "--output", output, "--agent", "claude",
                "--prompt", f"Open on the final demo like {URL}", "--subtitles", "none",
            ])
            def transcribe(argv):
                with open(argv[argv.index("--output") + 1], "w") as fh:
                    json.dump({"words": [{"word": "Final demo.", "start": 4, "end": 6}]}, fh)
                return 0
            with patch.object(short_pipeline, "transcribe_isolated", side_effect=transcribe), \
                    patch.object(stream_clip, "probe_url", return_value={"title": "Reference", "duration": 10}), \
                    patch.object(stream_clip, "fetch_caption_words", return_value=(WORDS, "youtube-captions")), \
                    patch.object(agent_edit, "_invoke_agent", return_value={
                        "segments": [{"start": 4, "end": 6, "score": 1, "reason": "final demo"}],
                        "source": "agent:claude"}), \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(short_pipeline.run_render(args), 0)
            probe = short_pipeline.render_mod.probe_media(output)
            self.assertAlmostEqual(probe["duration"], 2, delta=0.1)
            self.assertEqual((probe["width"], probe["height"]), (1080, 1920))
            pixel = subprocess.run([
                "ffmpeg", "-v", "error", "-i", output, "-frames:v", "1",
                "-vf", "crop=2:2:540:960,format=rgb24", "-f", "rawvideo", "-",
            ], check=True, capture_output=True).stdout
            # The planned final scene is blue; a fallback opening cut would be red.
            self.assertGreater(pixel[2], pixel[0] + 50)
            with open(output + ".edit.json") as fh:
                record = json.load(fh)
            self.assertEqual(record["segments"][0]["start"], 4)
            self.assertEqual(record["edit_request"]["references"][0]["url"], URL)


if __name__ == "__main__":
    unittest.main()
