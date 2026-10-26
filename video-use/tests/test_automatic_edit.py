"""The Studio options must produce real, word-safe edits or fail visibly."""
import io
import json
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path
import sys
import tempfile
import shutil
import subprocess
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "helpers"))
import automatic_edit
import short_pipeline
import agent_edit
import transcript_edit


def words_at(text, offset):
    return [{"word": word, "start": offset + i * .4, "end": offset + (i + 1) * .4}
            for i, word in enumerate(text.split())]


class AutomationTests(unittest.TestCase):
    def test_full_source_highlight_is_rejected_and_replanned(self):
        words = words_at("Here is a useful conclusion.", 90)
        with patch.object(agent_edit, "_invoke_agent", side_effect=[
            {"segments": [{"start": 0, "end": 120}]},
            {"segments": [{"start": 89, "end": 96}]},
        ]) as planner:
            doc = automatic_edit.select_edit("highlights", words, 120,
                agent="codex", target=30, remove_silence=False, remove_retakes=False)
        self.assertEqual(planner.call_count, 2)
        self.assertIn("previous edit was rejected", planner.call_args.args[1])
        self.assertEqual(doc["segments"], [{"start": 89, "end": 96}])

    def test_repeated_over_budget_plans_fail_instead_of_exporting_cleanup(self):
        with patch.object(agent_edit, "_invoke_agent", return_value={
                "segments": [{"start": 0, "end": 120}]}) as planner:
            with self.assertRaisesRegex(agent_edit.AgentError, "30s target"):
                automatic_edit.select_edit("highlights", words_at("Actual spoken content.", 1),
                    120, agent="codex", target=30)
        self.assertEqual(planner.call_count, 2)

    def test_oversized_top_scored_segment_does_not_hide_a_valid_highlight(self):
        doc = agent_edit.validate_edl({"segments": [
            {"start": 0, "end": 70, "score": 1},
            {"start": 80, "end": 100, "score": .8},
        ]}, 120, 30)
        self.assertEqual(doc["total_selected"], 20)
        self.assertEqual(doc["segments"][0]["start"], 80)

    def test_word_protection_cannot_expand_highlight_past_budget(self):
        with patch.object(agent_edit, "run_agent_cut", return_value={
                "segments": [{"start": 0, "end": 30}]}):
            with self.assertRaisesRegex(transcript_edit.EditError, "exceeds"):
                automatic_edit.select_edit("highlights", [{"word": "long", "start": 29, "end": 35}],
                    120, agent="codex", target=30, remove_silence=False)

    def test_full_user_prompt_allowance_excludes_internal_mode_guidance(self):
        with patch.object(agent_edit, "_invoke_agent", return_value={"segments": [{"start": 0, "end": 57}]}):
            doc = automatic_edit.select_edit("cleanup", words_at("Keep the final result.", 50), 57,
                agent="codex", prompt="x" * 4000, remove_silence=False, remove_retakes=False)
        self.assertEqual(len(doc["edit_request"]["prompt"]), 4000)
        self.assertGreater(doc["segments"][-1]["end"], 50)

    def test_optional_instructions_keep_mode_controls_and_forward_model(self):
        words = words_at("Here is the opening.", 1) + words_at("Now the final result.", 50)
        for strategy in ("cleanup", "highlights", "full"):
            with self.subTest(strategy=strategy), patch.object(agent_edit, "run_agent_cut", return_value={
                "segments": [{"start": 49, "end": 57}] if strategy == "highlights" else [{"start": 0, "end": 57}],
                "edit_request": {"references": [{"url": "https://youtu.be/abcdefghijk"}]},
            }) as planner:
                doc = automatic_edit.select_edit(strategy, words, 57, agent="codex", model="chosen-model",
                    target=30, prompt="Keep the conclusion. Use https://youtu.be/abcdefghijk for pacing.",
                    remove_silence=False, remove_retakes=False, takes_text="actual source transcript")
                self.assertEqual(planner.call_args.kwargs["model"], "chosen-model")
                self.assertEqual(planner.call_args.kwargs["target_duration"], 30 if strategy == "highlights" else 57)
                self.assertIn("Keep the conclusion", planner.call_args.kwargs["hook"])
                self.assertEqual(doc["strategy"], strategy)
                self.assertFalse(doc["remove_silence"])
                self.assertGreater(doc["segments"][-1]["end"], 50)
                self.assertEqual(doc["edit_request"]["references"][0]["url"], "https://youtu.be/abcdefghijk")

    def test_optional_instructions_never_silently_fall_back(self):
        with self.assertRaisesRegex(transcript_edit.EditError, "editing model"):
            automatic_edit.select_edit("cleanup", words_at("spoken words", 1), 57, agent="auto", prompt="Keep the ending")
        with self.assertRaisesRegex(transcript_edit.EditError, "spoken audio"):
            automatic_edit.select_edit("full", [], 57, agent="codex", prompt="Keep the ending", has_audio=False)
        with patch.object(agent_edit, "run_agent_cut", side_effect=agent_edit.AgentError("CLI unavailable")):
            with self.assertRaisesRegex(agent_edit.AgentError, "CLI unavailable"):
                automatic_edit.select_edit("cleanup", words_at("spoken words", 1), 57, agent="codex", prompt="Keep the ending")

    def test_pipeline_accepts_optional_youtube_instructions_and_records_them(self):
        with tempfile.TemporaryDirectory() as folder:
            source, output = Path(folder) / "source.mov", Path(folder) / "result.mp4"
            source.touch()
            words = words_at("Keep the complete explanation.", 1) + words_at("Here is the final result.", 50)
            prompt = "Keep the conclusion. Use https://youtu.be/abcdefghijk for pacing."
            def transcribe(argv):
                Path(argv[argv.index("--output") + 1]).write_text(json.dumps({"words": words}))
                return 0
            args = short_pipeline.build_parser().parse_args(["--input", str(source), "--output", str(output),
                "--edit-strategy", "cleanup", "--agent", "codex", "--model", "chosen-model", "--prompt", prompt,
                "--subtitles", "none", "--keep-silence", "--keep-retakes"])
            with patch.object(short_pipeline.render_mod, "probe_media", return_value={"duration": 57, "has_audio": True}), \
                    patch.object(short_pipeline, "transcribe_isolated", side_effect=transcribe), \
                    patch.object(agent_edit, "run_agent_cut", return_value={"segments": [{"start": 0, "end": 57}],
                        "edit_request": {"references": [{"url": "https://youtu.be/abcdefghijk"}]}}) as planner, \
                    patch.object(short_pipeline.render_mod, "render_edl", side_effect=lambda _source, path, *args, **kwargs: Path(path).write_bytes(b"encoded")), \
                    redirect_stdout(io.StringIO()):
                self.assertEqual(short_pipeline.run_render(args), 0)
            self.assertEqual(planner.call_args.kwargs["model"], "chosen-model")
            evidence = json.loads(Path(str(output) + ".edit.json").read_text())
            self.assertEqual(evidence["strategy"], "cleanup")
            self.assertEqual(evidence["edit_request"]["prompt"], prompt)
            self.assertEqual(evidence["edit_request"]["references"][0]["url"], "https://youtu.be/abcdefghijk")

    def test_failed_retry_preserves_the_previous_export(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "short.mp4"
            output.write_bytes(b"previous successful video")
            def failing_encoder(_input, stage, **kwargs):
                Path(stage).write_bytes(b"partial failed encode")
                raise short_pipeline.render_mod.RenderError("encoder failed")
            with self.assertRaisesRegex(short_pipeline.render_mod.RenderError, "encoder failed"):
                short_pipeline.render_export(failing_encoder, "source.mov", str(output))
            self.assertEqual(output.read_bytes(), b"previous successful video")
            self.assertEqual(list(Path(folder).glob(".pixel_render_*")), [])

    def test_successful_retry_publishes_video_and_framing_report(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "short.mp4"
            output.write_bytes(b"old video")
            def encoder(_input, stage, **kwargs):
                Path(stage).write_bytes(b"new edited video")
                Path(stage).with_suffix(".framing.json").write_text('{"verified": true}')
            with redirect_stdout(io.StringIO()):
                short_pipeline.render_export(encoder, "source.mov", str(output))
            self.assertEqual(output.read_bytes(), b"new edited video")
            self.assertTrue(json.loads(output.with_suffix(".framing.json").read_text())["verified"])
            self.assertEqual(list(Path(folder).glob(".pixel_render_*")), [])

    def test_empty_encode_cannot_replace_a_valid_export(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "short.mp4"
            output.write_bytes(b"valid video")
            with self.assertRaisesRegex(short_pipeline.render_mod.RenderError, "empty video"):
                short_pipeline.render_export(lambda *args, **kwargs: None, "source.mov", str(output))
            self.assertEqual(output.read_bytes(), b"valid video")

    def test_cleanup_has_no_30_second_limit_and_preserves_every_complete_word(self):
        words = words_at("Here is the opening.", 1) + words_at("Now the final result.", 48)
        doc = automatic_edit.select_edit("cleanup", words, 57)
        self.assertGreater(doc["segments"][-1]["end"], 49)
        for word in words:
            self.assertTrue(any(s["start"] <= word["start"] and s["end"] >= word["end"] for s in doc["segments"]))

    def test_cleanup_retains_later_take_and_can_disable_either_control(self):
        words = words_at("Here is a useful demo.", 1) + words_at("Here is a useful demo.", 9)
        doc = automatic_edit.select_edit("cleanup", words, 15)
        self.assertTrue(doc["removals"])
        self.assertGreater(doc["segments"][0]["start"], 8)
        doc = automatic_edit.select_edit("cleanup", words, 15, remove_retakes=False)
        self.assertEqual(doc["removals"], [])
        self.assertLess(doc["segments"][0]["start"], 1)
        doc = automatic_edit.select_edit("cleanup", words, 15, remove_retakes=False, remove_silence=False)
        self.assertEqual(doc["segments"], [{"start": 0, "end": 15}])
        doc = automatic_edit.select_edit("cleanup", words, 15, remove_silence=False)
        self.assertEqual(doc["segments"][0]["end"], 15)
        self.assertTrue(doc["removals"])

    def test_full_mode_ignores_highlight_budget_and_keeps_silent_footage(self):
        doc = automatic_edit.select_edit("full", [], 57, has_audio=False, target=30)
        self.assertEqual(doc["segments"], [{"start": 0, "end": 57}])

    def test_highlight_invokes_selected_model_and_protects_words(self):
        words = words_at("This is the final result.", 4)
        with patch.object(agent_edit, "run_agent_cut", return_value={"segments": [{"start": 4.2, "end": 5.9}]}) as agent:
            doc = automatic_edit.select_edit("highlights", words, 57, agent="codex", target=60, takes_text="actual takes")
        self.assertEqual(agent.call_args.args, ("codex", "actual takes", 57))
        self.assertEqual(agent.call_args.kwargs["target_duration"], 57)
        self.assertLess(doc["segments"][0]["start"], 4)
        self.assertGreater(doc["segments"][0]["end"], 6)

    def test_failed_agent_or_speech_detection_never_creates_substitute_cut(self):
        with self.assertRaisesRegex(transcript_edit.EditError, "Speech detection failed"):
            automatic_edit.select_edit("cleanup", [], 57)
        with self.assertRaisesRegex(transcript_edit.EditError, "editing model"):
            automatic_edit.select_edit("highlights", words_at("actual speech", 1), 57, agent="auto", target=30)
        with patch.object(agent_edit, "run_agent_cut", side_effect=agent_edit.AgentError("model unavailable")):
            with self.assertRaisesRegex(agent_edit.AgentError, "model unavailable"):
                automatic_edit.select_edit("highlights", words_at("actual speech", 1), 57, agent="claude", target=30)

    def test_pipeline_forwards_all_style_options_and_writes_actual_engine_evidence(self):
        with tempfile.TemporaryDirectory() as folder:
            source, output = Path(folder) / "source.mov", Path(folder) / "result.mp4"
            source.touch()
            words = words_at("Opening words remain here.", 1) + words_at("Closing words remain too.", 50)
            def transcribe(argv):
                Path(argv[argv.index("--output") + 1]).write_text(json.dumps({"words": words}))
                return 0
            args = short_pipeline.build_parser().parse_args(["--input", str(source), "--output", str(output),
                "--edit-strategy", "cleanup", "--agent", "auto", "--preset", "warm_cinematic",
                "--subtitles", "hype", "--subtitle-position", "center", "--subtitle-size", "large",
                "--subtitle-case", "sentence", "--aspect-ratio", "9:16", "--layout", "auto", "--face-roi", "auto"])
            with patch.object(short_pipeline.render_mod, "probe_media", return_value={"duration": 57, "has_audio": True}), \
                    patch.object(short_pipeline, "transcribe_isolated", side_effect=transcribe), \
                    patch.object(short_pipeline.render_mod, "render_edl", side_effect=lambda _source, output, *args, **kwargs: Path(output).write_bytes(b"encoded")) as render, \
                    patch.object(short_pipeline.render_mod, "render_short", side_effect=lambda _source, output, *args, **kwargs: Path(output).write_bytes(b"encoded")) as head, redirect_stdout(io.StringIO()):
                self.assertEqual(short_pipeline.run_render(args), 0)
            head.assert_not_called()
            self.assertEqual(render.call_args.kwargs["words"], words)
            for key, value in {"preset_id": "warm_cinematic", "subtitle_style": "hype", "subtitle_position": "center",
                               "subtitle_size": "large", "subtitle_case": "sentence", "aspect_ratio": "9:16", "layout": "auto", "face_roi": "auto"}.items():
                self.assertEqual(render.call_args.kwargs[key], value)
            self.assertGreater(render.call_args.args[2][-1]["end"], 50)
            evidence = json.loads(Path(str(output) + ".edit.json").read_text())
            self.assertEqual(evidence["strategy"], "cleanup")
            self.assertEqual(evidence["engine"], str(Path(short_pipeline.__file__).resolve()))
            self.assertEqual(evidence["word_count"], 8)

    def test_pipeline_does_not_render_when_transcriber_returns_placeholder(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "source.mov"
            source.touch()
            args = short_pipeline.build_parser().parse_args(["--input", str(source), "--output", str(Path(folder) / "out.mp4"), "--edit-strategy", "cleanup"])
            with patch.object(short_pipeline.render_mod, "probe_media", return_value={"duration": 57, "has_audio": True}), \
                    patch.object(short_pipeline, "transcribe_isolated", return_value=1), \
                    patch.object(short_pipeline.render_mod, "render_edl", side_effect=lambda _source, output, *args, **kwargs: Path(output).write_bytes(b"encoded")) as render, redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                self.assertEqual(short_pipeline.run_render(args), 1)
            render.assert_not_called()


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "requires FFmpeg")
class ModeRenderTests(unittest.TestCase):
    def test_three_modes_export_different_real_timelines(self):
        # Deterministic speech/planner fixtures; encoding and duration checks are real.
        with tempfile.TemporaryDirectory(prefix="pixel_modes_") as folder:
            root = Path(folder)
            source = root / "source.mp4"
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
                            "testsrc2=s=160x120:d=12:r=10", "-f", "lavfi", "-i",
                            "sine=frequency=440:duration=12", "-c:v", "libx264",
                            "-c:a", "aac", "-shortest", str(source)], check=True, timeout=30)
            words = (words_at("Here is the opening.", 1)
                     + words_at("A different useful explanation.", 5)
                     + words_at("Finally see the result.", 9))

            def transcribe(argv):
                Path(argv[argv.index("--output") + 1]).write_text(json.dumps({"words": words}))
                return 0

            durations = {}
            for mode in ("cleanup", "highlights", "full"):
                output = root / f"{mode}.mp4"
                args = short_pipeline.build_parser().parse_args([
                    "--input", str(source), "--output", str(output), "--edit-strategy", mode,
                    "--agent", "codex", "--duration", "3", "--subtitles", "none",
                    "--engine", "local", "--layout", "single"])
                with patch.object(short_pipeline, "transcribe_isolated", side_effect=transcribe) as worker, \
                        patch.object(agent_edit, "_invoke_agent", return_value={
                            "segments": [{"start": 8.8, "end": 11}]} ) as planner, \
                        redirect_stdout(io.StringIO()):
                    self.assertEqual(short_pipeline.run_render(args), 0)
                if mode == "full":
                    worker.assert_not_called()
                if mode != "highlights":
                    planner.assert_not_called()
                evidence = json.loads(Path(str(output) + ".edit.json").read_text())
                self.assertEqual(evidence["strategy"], mode)
                durations[mode] = short_pipeline.render_mod.probe_media(str(output))["duration"]
            self.assertAlmostEqual(durations["full"], 12, delta=.15)
            self.assertLess(durations["cleanup"], 8)
            self.assertGreater(durations["cleanup"], 5)
            self.assertLessEqual(durations["highlights"], 3.15)
            self.assertLess(durations["highlights"], durations["cleanup"])


if __name__ == "__main__":
    unittest.main()
