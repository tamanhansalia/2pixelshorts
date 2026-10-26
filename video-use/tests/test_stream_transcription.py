"""YouTube analysis continues when captions are absent, broken, or blocked."""
import contextlib
import io
import json
from pathlib import Path
import sys
import types
import tempfile
import unittest
import wave
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "helpers"))
import stream_clip
import transcribe

URL = "https://www.youtube.com/watch?v=abcdefghijk"
WORDS = [{"word": "Why", "start": 1., "end": 1.4},
         {"word": "this works.", "start": 1.4, "end": 3.}]


class StreamTranscriptionTests(unittest.TestCase):
    def test_caption_success_never_downloads_audio(self):
        with patch.object(stream_clip, "fetch_caption_words", return_value=(WORDS, "youtube-captions")), \
                patch.object(stream_clip, "transcribe_url_words") as audio:
            self.assertEqual(stream_clip.fetch_transcript_words(URL), (WORDS, "youtube-captions"))
        audio.assert_not_called()

    def test_missing_or_blocked_captions_use_local_transcription(self):
        for reason in ("no captions", "HTTP Error 429", "malformed captions"):
            with self.subTest(reason=reason), \
                    patch.object(stream_clip, "fetch_caption_words", side_effect=stream_clip.StreamClipError(reason)), \
                    patch.object(stream_clip, "transcribe_url_words", return_value=(WORDS, "local-whisper")) as audio:
                self.assertEqual(stream_clip.fetch_transcript_words(URL), (WORDS, "local-whisper"))
                audio.assert_called_once_with(URL)

    def test_main_passes_fallback_transcript_to_selected_agent(self):
        out = io.StringIO()
        with patch.object(stream_clip, "probe_url", return_value={"duration": 50, "title": "Demo"}), \
                patch.object(stream_clip, "fetch_caption_words", side_effect=stream_clip.StreamClipError("no captions")), \
                patch.object(stream_clip, "transcribe_url_words", return_value=(WORDS, "local-whisper")), \
                patch.object(stream_clip, "suggest_with_agent", return_value=[{"start": 1, "end": 3}]) as agent, \
                contextlib.redirect_stdout(out):
            self.assertEqual(stream_clip.main(["--url", URL, "--agent", "claude"]), 0)
        agent.assert_called_once()
        self.assertEqual(agent.call_args.args[:3], (WORDS, 50, "claude"))
        result = json.loads(out.getvalue())
        self.assertEqual(result["transcript_source"], "local-whisper")
        self.assertEqual(result["words_count"], 2)
        self.assertEqual(result["picker"], "agent:claude")

    def test_main_reports_transcription_failure_without_scoring(self):
        err = io.StringIO()
        with patch.object(stream_clip, "probe_url", return_value={"duration": 50}), \
                patch.object(stream_clip, "fetch_caption_words", side_effect=stream_clip.StreamClipError("no captions")), \
                patch.object(stream_clip, "transcribe_url_words", side_effect=stream_clip.StreamClipError("No speech detected")), \
                patch.object(stream_clip, "suggest_clips") as scorer, contextlib.redirect_stderr(err):
            self.assertEqual(stream_clip.main(["--url", URL]), 1)
        scorer.assert_not_called()
        self.assertIn("No speech detected", err.getvalue())

    def run_audio(self, doc=None, error=None, download_error=False):
        downloaded = []
        def download(cmd, timeout):
            target = Path(cmd[cmd.index("-o") + 1].replace("%(ext)s", "webm"))
            downloaded.append(target)
            target.write_bytes(b"audio fixture")
            return types.SimpleNamespace(returncode=1 if download_error else 0,
                                         stderr="ERROR: HTTP Error 403 https://signed.example/token", stdout="")
        def recognize(path):
            self.assertTrue(Path(path).is_file())
            if error:
                raise error
            return {"words": WORDS} if doc is None else doc
        try:
            with patch.object(transcribe, "local_available", return_value=True), \
                    patch.object(stream_clip.shutil, "which", return_value="ffmpeg"), \
                    patch.object(stream_clip, "_run", side_effect=download) as runner, \
                    patch.object(transcribe, "transcribe_local", side_effect=recognize) as local, \
                    contextlib.redirect_stderr(io.StringIO()):
                result = stream_clip.transcribe_url_words(URL)
            self.assertIn("bestaudio/best", runner.call_args.args[0])
            self.assertNotIn("--download-sections", runner.call_args.args[0])
            local.assert_called_once()
            return result
        finally:
            self.assertTrue(downloaded)
            self.assertTrue(all(not path.parent.exists() for path in downloaded))

    def test_audio_is_transcribed_and_temporary_media_is_deleted(self):
        self.assertEqual(self.run_audio(), (WORDS, "local-whisper"))

    def test_no_speech_is_an_error_and_media_is_deleted(self):
        with self.assertRaisesRegex(stream_clip.StreamClipError, "No speech was detected"):
            self.run_audio(doc={"words": []})

    def test_model_failure_is_actionable_and_media_is_deleted(self):
        with self.assertRaisesRegex(stream_clip.StreamClipError, "model missing.*Settings"):
            self.run_audio(error=transcribe.TranscribeError("model missing"))

    def test_download_failure_is_honest_and_media_is_deleted(self):
        with self.assertRaisesRegex(stream_clip.StreamClipError, "YouTube refused") as error:
            self.run_audio(download_error=True)
        self.assertNotIn("signed.example", str(error.exception))

    def test_missing_engine_fails_before_download_with_setup_instructions(self):
        with patch.object(transcribe, "local_available", return_value=False), \
                patch.object(stream_clip, "_run") as download:
            with self.assertRaisesRegex(stream_clip.StreamClipError, "setup_local_stt.sh"):
                stream_clip.transcribe_url_words(URL)
        download.assert_not_called()

    def test_missing_ffmpeg_fails_before_download(self):
        with patch.object(transcribe, "local_available", return_value=True), \
                patch.object(stream_clip.shutil, "which", return_value=None), \
                patch.object(stream_clip, "_run") as download:
            with self.assertRaisesRegex(stream_clip.StreamClipError, "install ffmpeg"):
                stream_clip.transcribe_url_words(URL)
        download.assert_not_called()

    def test_audio_extraction_timeout_is_an_error_and_media_is_deleted(self):
        with self.assertRaisesRegex(stream_clip.StreamClipError, "Local transcription failed"):
            self.run_audio(error=stream_clip.subprocess.TimeoutExpired("ffmpeg", 600))

    def test_audio_download_retries_discard_partial_media(self):
        targets = []
        def download(cmd, timeout):
            target = Path(cmd[cmd.index("-o") + 1].replace("%(ext)s", "webm"))
            targets.append(target)
            if len(targets) == 1:
                target.with_suffix(".webm.part").write_bytes(b"broken")
                return types.SimpleNamespace(returncode=1, stderr="ERROR: 403", stdout="")
            self.assertFalse(target.with_suffix(".webm.part").exists())
            target.write_bytes(b"complete")
            return types.SimpleNamespace(returncode=0, stderr="", stdout="")
        with patch.object(transcribe, "local_available", return_value=True), \
                patch.object(stream_clip.shutil, "which", return_value="ffmpeg"), \
                patch.object(stream_clip, "_run", side_effect=download), \
                patch.object(transcribe, "transcribe_local", return_value={"words": WORDS}), \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(stream_clip.transcribe_url_words(URL), (WORDS, "local-whisper"))
        self.assertEqual(len(targets), 2)
        self.assertFalse(targets[-1].parent.exists())

    def test_audio_download_rejects_unfinished_live(self):
        def download(cmd, timeout):
            self.assertIn("--match-filter", cmd)
            return types.SimpleNamespace(
                returncode=1, stdout="",
                stderr="[download] Skipping video because of match filter",
            )
        with patch.object(transcribe, "local_available", return_value=True), \
                patch.object(stream_clip.shutil, "which", return_value="ffmpeg"), \
                patch.object(stream_clip, "_run", side_effect=download), \
                contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaisesRegex(stream_clip.StreamClipError, "live right now"):
                stream_clip.transcribe_url_words(URL)

    def test_live_caption_refusal_does_not_fall_through_to_audio(self):
        with patch.object(stream_clip, "fetch_caption_words",
                          side_effect=stream_clip.StreamClipError(stream_clip.LIVE_REFUSAL)), \
                patch.object(stream_clip, "transcribe_url_words") as audio:
            with self.assertRaisesRegex(stream_clip.StreamClipError, "live right now"):
                stream_clip.fetch_transcript_words(URL)
        audio.assert_not_called()

    def test_caption_fetch_rejects_unfinished_live(self):
        def captions(cmd, timeout):
            self.assertIn("--match-filter", cmd)
            return types.SimpleNamespace(
                returncode=1, stdout="",
                stderr="[download] Skipping video because of match filter",
            )
        with patch.object(stream_clip, "_run", side_effect=captions):
            with self.assertRaisesRegex(stream_clip.StreamClipError, "live right now"):
                stream_clip.fetch_caption_words(URL)

    def test_successfully_written_captions_survive_later_track_failure(self):
        def captions(cmd, timeout):
            target = Path(cmd[cmd.index("-o") + 1].replace("%(ext)s", "en.json3"))
            target.write_text(json.dumps({"events": [{"tStartMs": 1000, "dDurationMs": 2000,
                                                       "segs": [{"utf8": "Hello world"}]}]}))
            return types.SimpleNamespace(returncode=1, stderr="later track failed", stdout="")
        with patch.object(stream_clip, "_run", side_effect=captions):
            words, _ = stream_clip.fetch_caption_words(URL)
        self.assertEqual([w["word"] for w in words], ["Hello", "world"])
        self.assertEqual(words[-1]["end"], 3.)

    def test_json3_uses_actual_word_offsets_and_event_end(self):
        words = stream_clip.parse_json3({"events": [{"tStartMs": 1000, "dDurationMs": 4000,
            "segs": [{"utf8": "Why", "tOffsetMs": 0}, {"utf8": "this works.", "tOffsetMs": 2500}]}]})
        self.assertEqual([w["word"] for w in words], ["Why", "this", "works."])
        self.assertEqual(words[0]["start"], 1.)
        self.assertEqual(words[1]["start"], 3.5)
        self.assertEqual(words[-1]["end"], 5.)

    def test_json3_manual_cue_is_split_inside_its_real_duration(self):
        words = stream_clip.parse_json3({"events": [{"tStartMs": 2000, "dDurationMs": 2000,
            "segs": [{"utf8": "Hello"}, {"utf8": "&amp; goodbye"}]}]})
        self.assertEqual([w["word"] for w in words], ["Hello", "&", "goodbye"])
        self.assertEqual(words[0]["start"], 2.)
        self.assertEqual(words[-1]["end"], 4.)


class LongAudioTests(unittest.TestCase):
    def make_wav(self, path, seconds=5):
        with wave.open(str(path), "wb") as wav:
            wav.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
            wav.writeframes(b"\0\0" * int(16000 * seconds))

    def test_overlapping_windows_keep_original_times_without_repeating_words(self):
        batches = [[("first", 1.8, 2.1)],
                   [("first", .3, .6), ("second", .7, 1.), ("third", 2.3, 2.6)],
                   [("third", .3, .6), ("last", .9, 1.3)]]
        lengths = []
        def recognize(path, **kwargs):
            with wave.open(path, "rb") as wav:
                lengths.append(wav.getnframes() / wav.getframerate())
            items = [types.SimpleNamespace(word=w, start=s, end=e) for w, s, e in batches[len(lengths) - 1]]
            return iter([types.SimpleNamespace(words=items)]), types.SimpleNamespace(language="en")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "audio.wav"
            self.make_wav(path)
            model = types.SimpleNamespace(transcribe=recognize)
            with contextlib.redirect_stderr(io.StringIO()):
                words, language = transcribe.transcribe_audio_windows(model, str(path), 2, .5)
            self.assertFalse((Path(directory) / "chunk.wav").exists())
        self.assertEqual(lengths, [2.5, 3., 1.5])
        self.assertEqual([w["word"] for w in words], ["first", "second", "third", "last"])
        for word, start in zip(words, [1.8, 2.2, 3.8, 4.4]):
            self.assertAlmostEqual(word["start"], start)
        self.assertEqual(language, "en")

    def test_failed_chunk_cleans_up_temporary_audio(self):
        def recognize(path, **kwargs):
            raise RuntimeError("decoder failed")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "audio.wav"
            self.make_wav(path)
            with self.assertRaisesRegex(RuntimeError, "decoder failed"):
                transcribe.transcribe_audio_windows(types.SimpleNamespace(transcribe=recognize), str(path), 2)
            self.assertFalse((Path(directory) / "chunk.wav").exists())

    def test_short_recordings_are_passed_directly_without_chunk_files(self):
        seen = []
        def recognize(path, **kwargs):
            seen.append(path)
            return [], types.SimpleNamespace(language="en")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "audio.wav"
            self.make_wav(path)
            result = transcribe.transcribe_audio_windows(types.SimpleNamespace(transcribe=recognize), str(path))
            self.assertEqual(seen, [str(path)])
            self.assertEqual(result, ([], "en"))
            self.assertFalse((Path(directory) / "chunk.wav").exists())


if __name__ == "__main__":
    unittest.main()
