"""Explicit provider routing and the actual Scribe HTTP upload contract."""
import contextlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import types
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "helpers"))
import transcribe
import stream_clip
import short_pipeline

WORDS = [{"word": "Hello", "start": 0., "end": .5}]
PAYLOAD = {"text": "Hello", "language_code": "en", "words": [
    {"text": "Hello", "start": 0., "end": .5, "type": "word", "speaker_id": "speaker_0"},
    {"text": " ", "start": .5, "end": .6, "type": "spacing"},
    {"text": "(music)", "start": .6, "end": 1., "type": "audio_event"}]}


class ProviderTests(unittest.TestCase):
    def run_main(self, provider, *, key="saved-key", cloud_error=None):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / "source.mp4", Path(directory) / "words.json"
            source.write_bytes(b"fixture")
            with patch.object(transcribe, "transcribe_local", return_value={"words": WORDS, "model": "faster-whisper:small.en"}) as local, \
                    patch.object(transcribe, "transcribe_file", return_value=PAYLOAD, side_effect=cloud_error) as cloud, \
                    contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                code = transcribe.main(["--input", str(source), "--output", str(output),
                                        "--engine", provider, "--elevenlabs-key", key])
            return code, json.loads(output.read_text()), local.call_count, cloud.call_count

    def test_local_stays_local_when_a_cloud_key_is_present(self):
        code, doc, local, cloud = self.run_main("local")
        self.assertEqual((code, local, cloud), (0, 1, 0))
        self.assertEqual(doc["model"], "faster-whisper:small.en")

    def test_cloud_uses_scribe_and_filters_nonspoken_events(self):
        code, doc, local, cloud = self.run_main("elevenlabs")
        self.assertEqual((code, local, cloud), (0, 0, 1))
        self.assertEqual(doc["model"], "scribe_v1")
        self.assertEqual(doc["words"], WORDS)

    def test_cloud_missing_key_and_quota_errors_never_switch_to_local(self):
        for kwargs in ({"key": ""}, {"cloud_error": transcribe.TranscribeError("quota exhausted")}):
            with self.subTest(kwargs=kwargs):
                code, doc, local, _ = self.run_main("elevenlabs", **kwargs)
                self.assertEqual((code, local), (1, 0))
                self.assertEqual(doc["model"], "none")

    def test_readiness_honors_the_selection_even_when_both_engines_exist(self):
        with patch.object(transcribe, "local_available", return_value=True), \
                patch.object(transcribe.shutil, "which", return_value="ffmpeg"):
            self.assertEqual(transcribe.probe_report("key", engine="local")["active_engine"], "local")
            self.assertEqual(transcribe.probe_report("key", engine="elevenlabs")["active_engine"], "elevenlabs")
            self.assertEqual(transcribe.probe_report("", engine="elevenlabs")["active_engine"], "none")

    def test_captioned_youtube_needs_no_cloud_request_or_key(self):
        with patch.object(stream_clip, "fetch_caption_words", return_value=(WORDS, "youtube-captions")), \
                patch.object(stream_clip, "transcribe_url_words") as audio:
            self.assertEqual(stream_clip.fetch_transcript_words("url", "elevenlabs", ""), (WORDS, "youtube-captions"))
        audio.assert_not_called()

    def test_caption_failure_stays_local_even_when_elevenlabs_is_selected(self):
        with patch.object(stream_clip, "fetch_caption_words", side_effect=stream_clip.StreamClipError("no captions")), \
                patch.object(stream_clip, "transcribe_url_words", return_value=(WORDS, "local-whisper")) as audio:
            self.assertEqual(stream_clip.fetch_transcript_words("url", "elevenlabs", "key"),
                             (WORDS, "local-whisper"))
        audio.assert_called_once_with("url")

    def test_youtube_cloud_path_does_not_require_or_invoke_local_whisper(self):
        def download(cmd, timeout):
            Path(cmd[cmd.index("-o") + 1].replace("%(ext)s", "webm")).write_bytes(b"fixture")
            return types.SimpleNamespace(returncode=0, stdout="", stderr="")
        with patch.object(stream_clip, "_run", side_effect=download), \
                patch.object(stream_clip.shutil, "which", return_value="ffmpeg"), \
                patch.object(transcribe, "local_available", side_effect=AssertionError("cloud must not probe local")), \
                patch.object(transcribe, "transcribe_local") as local, \
                patch.object(transcribe, "transcribe_file", return_value=PAYLOAD) as cloud, \
                contextlib.redirect_stderr(io.StringIO()):
            result = stream_clip.transcribe_url_words("https://youtu.be/abcdefghijk", engine="elevenlabs", api_key="key")
        self.assertEqual(result, (WORDS, "elevenlabs:scribe_v1"))
        cloud.assert_called_once()
        local.assert_not_called()
        self.assertFalse(Path(cloud.call_args.args[0]).exists())

    def test_render_does_not_export_after_explicit_provider_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            output = str(Path(directory) / "short.mp4")
            args = short_pipeline.build_parser().parse_args(["--input", "source.mp4", "--output", output,
                                                              "--engine", "elevenlabs", "--subtitles", "none"])
            with patch.object(short_pipeline.render_mod, "probe_media", return_value={"duration": 3, "has_audio": True}), \
                    patch.object(short_pipeline, "transcribe_isolated", return_value=1), \
                    patch.object(short_pipeline.render_mod, "render_short") as render, \
                    contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(short_pipeline.run_render(args), 1)
            render.assert_not_called()
            self.assertFalse(Path(output).exists())


@unittest.skipUnless(shutil.which("ffmpeg"), "requires FFmpeg")
class ScribeHttpTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.source = Path(self.directory.name) / "source.wav"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
                        "sine=frequency=440:duration=0.2", str(self.source)], check=True, capture_output=True)
        self.requests = []
        self.status, self.response = 200, PAYLOAD
        owner = self
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                owner.requests.append((dict(self.headers), body))
                response = json.dumps(owner.response).encode()
                self.send_response(owner.status)
                self.send_header("Content-Length", str(len(response)))
                self.end_headers()
                self.wfile.write(response)
            def log_message(self, *args):
                pass
        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def call(self):
        with patch.object(transcribe, "SCRIBE_URL", f"http://127.0.0.1:{self.server.server_port}/v1/speech-to-text"):
            return transcribe.transcribe_file(str(self.source), "test-secret-key")

    def test_real_http_upload_streams_extracted_audio_and_upstream_fields(self):
        self.assertEqual(self.call(), PAYLOAD)
        headers, body = self.requests[0]
        headers = {key.lower(): value for key, value in headers.items()}
        self.assertEqual(headers["xi-api-key"], "test-secret-key")
        self.assertEqual(int(headers["content-length"]), len(body))
        self.assertNotIn("transfer-encoding", headers)
        self.assertNotIn(b"test-secret-key", body)
        for value in (b"scribe_v1", b'name="timestamps_granularity"\r\n\r\nword',
                      b'name="diarize"\r\n\r\ntrue', b'name="tag_audio_events"\r\n\r\ntrue',
                      b'filename="audio.flac"', b"fLaC"):
            self.assertIn(value, body)

    def test_auth_quota_and_rate_errors_are_actionable_without_retries(self):
        for status, message, expected in ((401, "invalid", "invalid or expired"),
                                          (401, "missing_permissions", "Speech-to-Text access"),
                                          (403, "denied", "Speech-to-Text access"),
                                          (402, "quota_exceeded", "credits exhausted"),
                                          (429, "limit", "concurrency limit")):
            with self.subTest(status=status):
                self.status, self.response = status, {"detail": {"status": message}}
                before = len(self.requests)
                with self.assertRaisesRegex(transcribe.TranscribeError, expected) as error:
                    self.call()
                self.assertNotIn("test-secret-key", str(error.exception))
                self.assertEqual(len(self.requests), before + 1)


if __name__ == "__main__":
    unittest.main()
