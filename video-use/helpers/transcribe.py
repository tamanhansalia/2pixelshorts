"""Word-level transcription: ElevenLabs Scribe (cloud) or local whisper.

Contract (per PROJECT_SPEC.md): ``transcribe.py`` outputs word-level JSON
that ``pack_transcripts.py`` and ``render.py`` consume for subtitle burning.

Engine selection (``--engine``):
- ``auto`` (default): ElevenLabs when ``--elevenlabs-key`` is set, else
  on-device faster-whisper when installed, else a placeholder document.
- ``elevenlabs``: cloud Scribe; needs ``--elevenlabs-key``.
- ``local``: on-device faster-whisper; needs ``video-use/.venv``
  (see ``video-use/setup_local_stt.sh``) — no API key, no uploads.
- Explicit provider failures return nonzero with a diagnostic document;
  the app stops instead of silently switching providers or losing captions.
- Legacy CLI ``auto`` retains placeholder behavior when unavailable.

Stdlib only, except the optional faster-whisper import (lazy, local only).
"""

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import urllib.error
import uuid
import wave

SCRIBE_URL = "https://api.elevenlabs.io/v1/speech-to-text"
SCRIBE_MODEL = "scribe_v1"

def default_local_model():
    """Prefer an accurate installed model; never download during a render."""
    try:
        from huggingface_hub import try_to_load_from_cache
        for name in ("small.en", "base.en", "tiny.en"):
            cached = try_to_load_from_cache(f"Systran/faster-whisper-{name}", "model.bin")
            if isinstance(cached, str) and os.path.isfile(cached):
                return name
    except ImportError:
        pass
    return "tiny.en"


FASTER_WHISPER_DEFAULT_MODEL = default_local_model()


class TranscribeError(Exception):
    pass


def transcribe_file(media_path, api_key, model_id=SCRIBE_MODEL, timeout=1800):
    """Upload extracted audio to Scribe with bounded multipart memory.

    One request, no automatic retries: an ambiguous timeout must not spend
    the user's allowance twice. Keys stay in the request header only.
    """
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise TranscribeError("Install ffmpeg to extract audio for ElevenLabs transcription")
    with tempfile.TemporaryDirectory(prefix="scribe_audio_") as directory:
        audio_path = os.path.join(directory, "audio.flac")
        try:
            proc = subprocess.run(
                [ffmpeg, "-y", "-v", "error", "-i", media_path,
                 "-vn", "-ac", "1", "-ar", "16000", "-c:a", "flac", audio_path],
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise TranscribeError(f"Audio extraction for ElevenLabs failed: {exc}") from exc
        if proc.returncode or not os.path.isfile(audio_path):
            raise TranscribeError(f"Audio extraction for ElevenLabs failed: {(proc.stderr or '').strip()[-300:]}")
        boundary = uuid.uuid4().hex
        fields = {"model_id": model_id, "timestamps_granularity": "word",
                  "diarize": "true", "tag_audio_events": "true"}
        # Spool multipart to disk instead of copying an entire VOD into RAM.
        with tempfile.TemporaryFile() as body:
            for key, value in fields.items():
                body.write(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())
            body.write(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.flac"\r\nContent-Type: audio/flac\r\n\r\n'.encode())
            with open(audio_path, "rb") as audio:
                shutil.copyfileobj(audio, body, length=1024 * 1024)
            body.write(f"\r\n--{boundary}--\r\n".encode())
            length = body.tell()
            body.seek(0)
            req = urllib.request.Request(
                SCRIBE_URL, data=body,
                headers={"xi-api-key": api_key, "Content-Length": str(length),
                         "Content-Type": f"multipart/form-data; boundary={boundary}"},
                method="POST",
            )
            try:
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    payload = json.loads(resp.read().decode("utf-8"))
                if not isinstance(payload, dict) or not isinstance(payload.get("words"), list):
                    raise TranscribeError("ElevenLabs returned an invalid word-timestamp transcript")
                return payload
            except urllib.error.HTTPError as exc:
                detail = exc.read(4096).decode("utf-8", errors="replace").lower()
                exc.close()
                if "quota" in detail or "credit" in detail or exc.code == 402:
                    reason = "account allowance or credits exhausted; check usage in your ElevenLabs dashboard"
                elif "missing_permissions" in detail:
                    reason = "key needs Speech-to-Text access; check its permissions in ElevenLabs"
                elif exc.code == 401:
                    reason = "API key is invalid or expired; update it in Settings → API keys"
                elif exc.code == 403:
                    reason = "key needs Speech-to-Text access; check its permissions in ElevenLabs"
                elif exc.code == 429:
                    reason = "rate or concurrency limit reached; wait and retry"
                else:
                    reason = "request rejected; check the audio format, account and service status"
                raise TranscribeError(f"ElevenLabs HTTP {exc.code}: {reason}") from exc
            except (urllib.error.URLError, OSError, ValueError) as exc:
                raise TranscribeError("Could not complete the ElevenLabs request. Check your connection and service status; the request was not retried automatically.") from exc


def normalize_words(scribe_payload):
    """Normalize a Scribe response to [{"word","start","end"}, ...]."""
    words = []
    for item in scribe_payload.get("words", []) or []:
        if not isinstance(item, dict) or item.get("type", "word") != "word":
            continue
        text = item.get("text") or item.get("word") or ""
        text = text.strip()
        if not text:
            continue
        try:
            start = float(item.get("start", 0.0))
            end = float(item.get("end", start))
        except (TypeError, ValueError):
            continue
        if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start:
            continue
        words.append({"word": text, "start": start, "end": end})
    return words


def placeholder_document(media_path, reason):
    return {
        "source": os.path.basename(media_path),
        "model": "none",
        "text": "",
        "words": [],
        "note": reason,
    }


def local_available():
    """True when faster-whisper is importable in this interpreter."""
    try:
        import faster_whisper  # noqa: F401
    except ImportError:
        return False
    return True


def words_from_faster_segments(segments, duration=None):
    """Normalize faster-whisper segments (duck-typed) to word dicts."""
    words = []
    for seg in segments or []:
        for item in getattr(seg, "words", None) or []:
            text = (getattr(item, "word", "") or "").strip()
            if not text:
                continue
            try:
                start = float(getattr(item, "start", 0.0))
                end = float(getattr(item, "end", start))
            except (TypeError, ValueError):
                continue
            if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start:
                continue
            if duration is not None:
                if start >= duration:
                    continue
                end = min(end, duration)
            words.append({"word": text, "start": start, "end": end})
    return words


def transcribe_audio_windows(model, wav_path, chunk_seconds=300, overlap_seconds=2):
    """Bound Whisper/VAD memory while retaining original-video word times.

    Neighbouring windows include context on both sides. A word belongs to
    the window containing its midpoint, so overlap is not repeated in captions.
    The same loaded model is reused for every window.
    """
    words, language = [], ""
    chunk_path = os.path.join(os.path.dirname(wav_path), "chunk.wav")
    try:
        with wave.open(wav_path, "rb") as audio:
            rate = audio.getframerate()
            total_frames = audio.getnframes()
            duration = total_frames / rate
            step = max(1, int(chunk_seconds * rate))
            context = max(0, int(overlap_seconds * rate))
            for first in range(0, total_frames, step):
                last = min(first + step, total_frames)
                start_frame = max(0, first - context)
                end_frame = min(total_frames, last + context)
                path = wav_path
                if total_frames > step:
                    audio.setpos(start_frame)
                    with wave.open(chunk_path, "wb") as chunk:
                        chunk.setparams(audio.getparams())
                        chunk.writeframes(audio.readframes(end_frame - start_frame))
                    path = chunk_path
                segments, info = model.transcribe(
                    path, word_timestamps=True, temperature=0.0,
                    vad_filter=True,
                    vad_parameters={"min_silence_duration_ms": 500, "speech_pad_ms": 200},
                    condition_on_previous_text=False,
                    hallucination_silence_threshold=1.0,
                )
                language = language or getattr(info, "language", "") or ""
                offset = start_frame / rate
                for word in words_from_faster_segments(segments, (end_frame - start_frame) / rate):
                    start, end = word["start"] + offset, word["end"] + offset
                    if first / rate <= (start + end) / 2 < last / rate:
                        words.append({"word": word["word"], "start": start, "end": min(end, duration)})
                if total_frames > step:
                    print(f"[TRANSCRIBE] Processed {last / rate:.0f}/{duration:.0f}s of source audio", file=sys.stderr)
    finally:
        if os.path.isfile(chunk_path):
            os.remove(chunk_path)
    return words, language


def transcribe_local(media_path, model_id=FASTER_WHISPER_DEFAULT_MODEL):
    """Transcribe on-device with faster-whisper. Returns a words doc.

    Raises TranscribeError on any failure (missing ffmpeg/library/model);
    callers convert that into a placeholder so renders never break.
    """
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        raise TranscribeError(
            "faster-whisper is not installed; run video-use/setup_local_stt.sh"
        )
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise TranscribeError("ffmpeg not found in PATH")
    tmpdir = tempfile.mkdtemp(prefix="local_stt_")
    wav_path = os.path.join(tmpdir, "audio_16k.wav")
    try:
        proc = subprocess.run(
            [ffmpeg, "-y", "-v", "error", "-i", media_path,
             "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav_path],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600,
        )
        if proc.returncode != 0 or not os.path.isfile(wav_path):
            raise TranscribeError(
                f"audio extraction failed: {(proc.stderr or '').strip()[-300:]}"
            )
        try:
            model = WhisperModel(model_id, device="cpu", compute_type="int8", local_files_only=True)
        except Exception as exc:
            raise TranscribeError(f"whisper model '{model_id}' failed: {exc}")
        try:
            words, language = transcribe_audio_windows(model, wav_path)
        except Exception as exc:
            raise TranscribeError(f"whisper transcription failed: {exc}")
        text = " ".join(w["word"] for w in words)
        return {
            "source": os.path.basename(media_path),
            "model": f"faster-whisper:{model_id}",
            "language": language,
            "text": text,
            "words": words,
        }
    finally:
        try:
            if os.path.isfile(wav_path):
                os.remove(wav_path)
            os.rmdir(tmpdir)
        except OSError:
            pass


def _write_placeholder(args, reason, stderr_note, return_code=0):
    doc = placeholder_document(args.input, reason)
    with open(args.output, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=2)
    print(stderr_note, file=sys.stderr)
    return return_code


def probe_report(elevenlabs_key="", local_model=FASTER_WHISPER_DEFAULT_MODEL, engine="auto"):
    """Report transcription-engine availability as a JSON-able dict.

    Never fails: this is a status readout so the UI can explain upfront
    why analysis would fail instead of failing blind after a long run.
    """
    key_configured = bool((elevenlabs_key or "").strip())
    local = local_available()
    ffmpeg = shutil.which("ffmpeg") is not None
    if engine in ("auto", "elevenlabs") and key_configured and ffmpeg:
        active = "elevenlabs"
    elif engine in ("auto", "local") and local and ffmpeg:
        active = "local"
    else:
        active = "none"
    return {
        "elevenlabs_key_configured": key_configured,
        "local_available": local,
        "local_model": local_model,
        "ffmpeg_available": ffmpeg,
        "active_engine": active,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description="Transcribe media to word-level JSON.")
    parser.add_argument("--input", required=False, default=None, help="Source audio/video file.")
    parser.add_argument("--output", required=False, default=None, help="Destination .json file.")
    parser.add_argument("--elevenlabs-key", default=os.environ.get("PIXEL_ELEVENLABS_KEY", ""), help="ElevenLabs API key (prefer PIXEL_ELEVENLABS_KEY).");
    parser.add_argument("--model", default=SCRIBE_MODEL, help="Scribe model id.")
    parser.add_argument("--engine", default="auto",
                        choices=("auto", "elevenlabs", "local"),
                        help="Transcription engine (default: auto).")
    parser.add_argument("--local-model", default=FASTER_WHISPER_DEFAULT_MODEL,
                        help="faster-whisper model id for --engine local.")
    parser.add_argument("--probe", action="store_true",
                        help="Print engine-availability JSON and exit 0.")
    args = parser.parse_args(argv)

    if args.probe:
        print(json.dumps(probe_report(args.elevenlabs_key, args.local_model, args.engine)))
        return 0

    if not args.input or not os.path.isfile(args.input):
        print(f"transcribe.py: input not found: {args.input}", file=sys.stderr)
        return 2

    key = args.elevenlabs_key.strip()
    engine = args.engine
    if engine == "auto":
        if key:
            engine = "elevenlabs"
        elif local_available():
            engine = "local"

    if engine == "elevenlabs":
        if not key:
            return _write_placeholder(
                args, "elevenlabs engine selected but no API key configured",
                "transcribe.py: ElevenLabs selected but no API key. Save it in Settings → API keys.",
                return_code=1,
            )
        try:
            payload = transcribe_file(args.input, key, args.model)
        except Exception as exc:
            print(f"transcribe.py: scribe request failed ({exc}); writing placeholder", file=sys.stderr)
            doc = placeholder_document(args.input, f"scribe request failed: {exc}")
            with open(args.output, "w", encoding="utf-8") as fh:
                json.dump(doc, fh, indent=2)
            return 1 if args.engine != "auto" else 0
        words = normalize_words(payload)
        doc = {
            "source": os.path.basename(args.input),
            "model": args.model,
            "text": payload.get("text", ""),
            "words": words,
        }
        with open(args.output, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, indent=2)
        print(f"transcribe.py: wrote {len(words)} words (elevenlabs) -> {args.output}")
        return 0

    if engine == "local":
        try:
            doc = transcribe_local(args.input, args.local_model)
        except TranscribeError as exc:
            return _write_placeholder(
                args, f"local transcription unavailable: {exc}",
                f"transcribe.py: local engine failed ({exc}); wrote placeholder",
                return_code=1 if args.engine != "auto" else 0,
            )
        with open(args.output, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, indent=2)
        print(f"transcribe.py: wrote {len(doc['words'])} words "
              f"(faster-whisper:{args.local_model}) -> {args.output}")
        return 0

    return _write_placeholder(
        args, "no ElevenLabs key configured; subtitles skipped",
        "transcribe.py: no API key, wrote placeholder word JSON",
    )


if __name__ == "__main__":
    sys.exit(main())
