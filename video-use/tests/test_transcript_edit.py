"""User-approved transcript ranges must not go through the AI cut budget."""

import copy
import io
from contextlib import redirect_stdout
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HELPERS = Path(__file__).resolve().parents[1] / "helpers"
sys.path.insert(0, str(HELPERS))
import render
import short_pipeline
import transcript_edit


def plan(path, duration=57):
    return {"version": 1, "source_path": str(path), "source_duration": duration,
            "segments": [{"start": 0, "end": duration}], "words": []}


class EditPlanTests(unittest.TestCase):
    def test_cleanup_removes_silence_without_losing_spoken_word_boundaries(self):
        words = [{"word": "First", "start": 2, "end": 3}, {"word": "sentence.", "start": 3, "end": 4},
                 {"word": "Last", "start": 10, "end": 11}, {"word": "sentence.", "start": 11, "end": 12}]
        spans, reasons = transcript_edit.cleanup_plan(words, 15)
        self.assertEqual(reasons, [])
        self.assertEqual(spans, [{"start": 1.88, "end": 4.12}, {"start": 9.88, "end": 12.12}])

    def test_cleanup_keeps_later_repeated_take_and_explains_removal(self):
        words = [{"word": word, "start": offset+i*.4, "end": offset+(i+1)*.4}
                 for offset in (1, 5, 9) for i, word in enumerate("Here is a useful demo.".split())]
        spans, reasons = transcript_edit.cleanup_plan(words, 15)
        self.assertEqual(len(reasons), 2)
        self.assertTrue(all(s["start"] >= 8.8 for s in spans))
        self.assertEqual(reasons[-1]["later_start"], 9)

    def test_cleanup_retains_distinct_numbers_and_negated_claims(self):
        for first, second in (("This price is 2 dollars.", "This price is 10 dollars."),
                              ("This model is recommended today.", "This model is not recommended today.")):
            words = [{"word": word, "start": offset+i*.3, "end": offset+(i+1)*.3}
                     for offset, text in ((1, first), (5, second)) for i, word in enumerate(text.split())]
            _, reasons = transcript_edit.cleanup_plan(words, 10)
            self.assertEqual(reasons, [])

    def test_cleanup_keeps_later_inline_restart_without_sentence_punctuation(self):
        words = [{"word": word, "start": 1+i*.3, "end": 1+(i+1)*.3}
                 for i, word in enumerate("Here is the demo Here is the demo with the final results.".split())]
        spans, reasons = transcript_edit.cleanup_plan(words, 8)
        self.assertTrue(any("repeated phrase" in r["reason"] for r in reasons))
        self.assertGreaterEqual(spans[0]["start"], words[3]["end"])

    def test_ai_preparation_uses_whole_story_budget_and_returns_reviewable_ranges(self):
        words = [{"word": "one", "start": 1, "end": 1.5}, {"word": "two", "start": 2, "end": 2.5}]
        def transcribe(argv):
            Path(argv[argv.index("--output") + 1]).write_text(json.dumps({"words": words, "model": "fixture"}))
            return 0
        stdout = io.StringIO()
        with patch.object(transcript_edit.render, "probe_media", return_value={"duration": 57, "has_audio": True}), \
                patch.object(transcript_edit.transcribe, "main", side_effect=transcribe), \
                patch.object(transcript_edit.agent_edit, "run_agent_cut", return_value={"segments": [{"start": 1.2, "end": 2.2}]}) as agent, \
                redirect_stdout(stdout):
            self.assertEqual(transcript_edit.main(["--input", "source.mov", "--prepare", "--agent", "claude"]), 0)
        self.assertEqual(agent.call_args.kwargs["target_duration"], 57)
        self.assertIn("later complete take", agent.call_args.kwargs["hook"])
        doc = json.loads(stdout.getvalue().split("__TRANSCRIPT_START__")[1].split("__TRANSCRIPT_END__")[0])
        self.assertEqual(doc["words"], words)
        self.assertLess(doc["suggested_segments"][0]["start"], 1)
        self.assertGreater(doc["suggested_segments"][0]["end"], 2.5)

    def test_ai_boundaries_do_not_split_a_spoken_word(self):
        spans = transcript_edit.safe_agent_ranges([{"start": 1.2, "end": 2.2}],
                    [{"word": "one", "start": 1, "end": 1.5}, {"word": "two", "start": 2, "end": 2.5}], 3)
        self.assertLess(spans[0]["start"], 1)
        self.assertGreater(spans[0]["end"], 2.5)

    def test_full_57_second_selection_has_no_30_second_budget(self):
        edit = transcript_edit.validate_plan(plan("source.mov"), 57, "source.mov")
        self.assertEqual(edit["segments"], [{"start": 0, "end": 57}])

    def test_merges_adjacent_ranges_to_avoid_crossfading_unbroken_speech(self):
        doc = plan("source.mov")
        doc["segments"] = [{"start": 0, "end": 20}, {"start": 20, "end": 57}]
        self.assertEqual(transcript_edit.validate_plan(doc, 57, "source.mov")["segments"],
                         [{"start": 0, "end": 57}])

    def test_invalid_or_stale_edits_fail_without_falling_back_to_an_auto_cut(self):
        invalid = [dict(source_path="other.mov"), dict(source_duration=100), dict(segments=[]),
                   dict(segments=[{"start": 0, "end": float("nan")}]),
                   dict(segments=[{"start": 0, "end": 100}]),
                   dict(segments=[{"start": 10, "end": 20}, {"start": 0, "end": 15}]),
                   dict(words=[{"word": "bad", "start": 0, "end": float("inf")}])]
        for replacement in invalid:
            with self.subTest(replacement=replacement), self.assertRaises(transcript_edit.EditError):
                transcript_edit.validate_plan(dict(plan("source.mov"), **replacement), 57, "source.mov")

    def test_corrected_words_skip_retranscription_and_agent_cuts(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.mov"
            source.write_bytes(b"fixture")
            output = Path(directory) / "short.mp4"
            edit = plan(source)
            edit["segments"] = [{"start": 0, "end": 20}, {"start": 50, "end": 57}]
            edit["words"] = [{"word": "corrected", "start": 52, "end": 53}]
            edit_file = Path(directory) / "edit.json"
            edit_file.write_text(json.dumps(edit))
            args = short_pipeline.build_parser().parse_args([
                "--input", str(source), "--output", str(output), "--edit-plan", str(edit_file),
                "--agent", "codex", "--duration", "30", "--subtitles", "pop"])
            info = {"duration": 57, "width": 320, "height": 240, "has_audio": True}
            with patch.object(short_pipeline.render_mod, "probe_media", return_value=info), \
                    patch.object(short_pipeline, "transcribe_isolated") as transcribe, \
                    patch.object(short_pipeline.agent_mod, "run_agent_cut") as agent, \
                    patch.object(short_pipeline.render_mod, "render_edl", side_effect=lambda _source, output, *args, **kwargs: Path(output).write_bytes(b"encoded")) as render_edl:
                self.assertEqual(short_pipeline.run_render(args), 0)
                transcribe.assert_not_called()
                agent.assert_not_called()
                self.assertEqual(render_edl.call_args.args[2], edit["segments"])
                self.assertEqual(render_edl.call_args.kwargs["words"], edit["words"])
            self.assertEqual(json.loads(Path(str(output) + ".words.json").read_text())["words"], edit["words"])

    def test_empty_selection_returns_failure_before_any_worker_runs(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.mov"
            source.write_bytes(b"fixture")
            edit = plan(source)
            edit["segments"] = []
            edit_file = Path(directory) / "edit.json"
            edit_file.write_text(json.dumps(edit))
            args = short_pipeline.build_parser().parse_args([
                "--input", str(source), "--output", str(Path(directory) / "short.mp4"),
                "--edit-plan", str(edit_file)])
            with patch.object(short_pipeline.render_mod, "probe_media", return_value={"duration": 57}), \
                    patch.object(short_pipeline, "transcribe_isolated") as worker:
                self.assertEqual(short_pipeline.run_render(args), 1)
                worker.assert_not_called()


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "requires FFmpeg")
class ApprovedRenderTests(unittest.TestCase):
    def test_real_57_second_export_and_an_explicit_removed_line(self):
        with tempfile.TemporaryDirectory(prefix="transcript_keep_test_") as directory:
            root = Path(directory)
            source = root / "source.mp4"
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
                            "color=blue:s=320x240:d=57:r=10", "-f", "lavfi", "-i",
                            "sine=frequency=440:duration=57", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                            "-c:a", "aac", "-shortest", str(source)], check=True, timeout=30)
            full = plan(source)
            cut = copy.deepcopy(full)
            cut["segments"] = [{"start": 0, "end": 20}, {"start": 50, "end": 57}]
            cut["words"] = [{"word": "corrected", "start": 51, "end": 52}]
            for name, edit, expected in (("full", full, 57), ("cut", cut, 26.97)):
                with self.subTest(name=name):
                    edit_file, output = root / f"{name}.json", root / f"{name}.mp4"
                    edit_file.write_text(json.dumps(edit))
                    result = subprocess.run([sys.executable, str(HELPERS / "short_pipeline.py"),
                                             "--input", str(source), "--output", str(output),
                                             "--edit-plan", str(edit_file), "--agent", "codex", "--duration", "30",
                                             "--subtitles", "pop"],
                                            capture_output=True, encoding="utf-8", errors="replace", timeout=90,
                                            env=dict(os.environ, PIXEL_ELEVENLABS_KEY="", PIXEL_YOUTUBE_KEY=""))
                    self.assertEqual(result.returncode, 0, result.stderr)
                    info = render.probe_media(str(output))
                    self.assertAlmostEqual(info["duration"], expected, delta=.15)
                    self.assertEqual((info["width"], info["height"]), (1080, 1920))
                    self.assertTrue(info["has_audio"])
                    self.assertEqual(json.loads(Path(str(output) + ".edl.json").read_text())["segments"], edit["segments"])
                    self.assertTrue(json.loads(output.with_suffix(".framing.json").read_text())["validation"]["passed"])


if __name__ == "__main__":
    unittest.main()
