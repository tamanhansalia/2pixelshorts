"""Word-level transcription: ElevenLabs Scribe (cloud) or local whisper.

Contract (per PROJECT_SPEC.md): ``transcribe.py`` outputs word-level JSON
that ``pack_transcripts.py`` and ``render.py`` consume for subtitle burning.

Engine selection (``--engine``):
- ``auto`` (default): ElevenLabs when ``--elevenlabs-key`` is set, else
  on-device faster-whisper when installed, else a placeholder document.
- ``elevenlabs``: cloud Scribe; needs ``--elevenlabs-key``.
- ``local``: on-device faster-whisper; needs ``video-use/.venv``
  (see ``video-use/setup_local_stt.sh``) — no API key, no uploads.
- Without any engine: writes a placeholder ``{"words": [], ...}`` and
  exits 0 with a warning on stderr, so the render pipeline degrades to
  clean video instead of failing.

Stdlib only, except the optional faster-whisper import (lazy, local only).
"""

import argparse
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import uuid

SCRIBE_URL = "https://api.elevenlabs.io/v1/speech-to-text"
SCRIBE_MODEL = "scribe_v1"

FASTER_WHISPER_DEFAULT_MODEL = "tiny.en"


class TranscribeError(Exception):
    pass


def _multipart_body(fields, file_field, filename, file_bytes, boundary):
    buf = io.BytesIO()
    for key, value in fields.items():
        buf.write(f"--{boundary}\r\n".encode())
        buf.write(f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode())
        buf.write(f"{value}\r\n".encode())
    buf.write(f"--{boundary}\r\n".encode())
    buf.write(
        f'Content-Disposition: form-data; name="{file_field}"; filename="{filename}"\r\n'.encode()
    )
    buf.write(b"Content-Type: application/octet-stream\r\n\r\n")
    buf.write(file_bytes)
    buf.write(b"\r\n")
    buf.write(f"--{boundary}--\r\n".encode())
    return buf.getvalue()


def transcribe_file(media_path, api_key, model_id=SCRIBE_MODEL, timeout=120):
    """Transcribe via ElevenLabs Scribe. Returns the raw parsed JSON dict."""
    with open(media_path, "rb") as fh:
        file_bytes = fh.read()
    boundary = uuid.uuid4().hex
    body = _multipart_body(
        {"model_id": model_id},
        "file",
        os.path.basename(media_path),
        file_bytes,
        boundary,
    )
    req = urllib.request.Request(
        SCRIBE_URL,
        data=body,
        headers={
            "xi-api-key": api_key,
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def normalize_words(scribe_payload):
    """Normalize a Scribe response to [{"word","start","end"}, ...]."""
    words = []
    for item in scribe_payload.get("words", []) or []:
        text = item.get("text") or item.get("word") or ""
        text = text.strip()
        if not text:
            continue
        try:
            start = float(item.get("start", 0.0))
            end = float(item.get("end", start))
        except (TypeError, ValueError):
            start, end = 0.0, 0.0
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


def words_from_faster_segments(segments):
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
                start, end = 0.0, 0.0
            words.append({"word": text, "start": start, "end": end})
    return words


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
            capture_output=True, text=True, timeout=600,
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
            segments, info = model.transcribe(
                wav_path, word_timestamps=True, temperature=0.0
            )
            segments = list(segments)
        except Exception as exc:
            raise TranscribeError(f"whisper transcription failed: {exc}")
        words = words_from_faster_segments(segments)
        text = " ".join(w["word"] for w in words)
        return {
            "source": os.path.basename(media_path),
            "model": f"faster-whisper:{model_id}",
            "language": getattr(info, "language", "") or "",
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


def _write_placeholder(args, reason, stderr_note):
    doc = placeholder_document(args.input, reason)
    with open(args.output, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=2)
    print(stderr_note, file=sys.stderr)
    return 0


def probe_report(elevenlabs_key="", local_model=FASTER_WHISPER_DEFAULT_MODEL):
    """Report transcription-engine availability as a JSON-able dict.

    Never fails: this is a status readout so the UI can explain upfront
    why analysis would fail instead of failing blind after a long run.
    """
    key_configured = bool((elevenlabs_key or "").strip())
    local = local_available()
    ffmpeg = shutil.which("ffmpeg") is not None
    if key_configured:
        active = "elevenlabs"
    elif local and ffmpeg:
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
        print(json.dumps(probe_report(args.elevenlabs_key, args.local_model)))
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
                "transcribe.py: no API key, wrote placeholder word JSON",
            )
        try:
            payload = transcribe_file(args.input, key, args.model)
        except Exception as exc:  # network/API failure must not kill the render
            print(f"transcribe.py: scribe request failed ({exc}); writing placeholder", file=sys.stderr)
            doc = placeholder_document(args.input, f"scribe request failed: {exc}")
            with open(args.output, "w", encoding="utf-8") as fh:
                json.dump(doc, fh, indent=2)
            return 0
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
