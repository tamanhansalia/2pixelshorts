"""YouTube stream/VOD clip finder: probe, captions, auto moment selection.

Contract: paste a public YouTube (or Twitch VOD) link, get back a
variable-length list of the best clip windows — no fixed clip count.
Selection is fully automatic: every sliding window over the transcript
is scored (hook, density, clean close, length fit, variety, position)
and everything above ``--threshold`` survives, subject to an overlap /
min-gap merge and a ``--max-clips`` safety cap.

Transcript source order (first win):
1. Explicit ``--words words.json`` (a transcript produced by ``transcribe.py``).
2. YouTube/Twitch captions via ``yt-dlp`` (free, timestamped, fast).
3. Download audio and transcribe it locally when the platform did not publish captions.

A full replay is never sent to ElevenLabs. That provider is for short local
footage. A live replay is hours long, and a missing caption track must not
spend account credits.

Stdlib only; ``yt-dlp`` and ``ffmpeg`` are shelled out to (never imported).
"""

import argparse
import glob
import html
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.parse

try:
    from . import agent_edit as agent_mod
    from . import pack_transcripts as pack_mod
except ImportError:  # running as `python helpers/stream_clip.py`
    import agent_edit as agent_mod
    import pack_transcripts as pack_mod

DEFAULT_THRESHOLD = 0.65
DEFAULT_MIN_LENGTH = 20.0
DEFAULT_MAX_LENGTH = 45.0
DEFAULT_MAX_CLIPS = 12
DEFAULT_MIN_GAP = 30.0
WINDOW_START_STRIDE = 5.0
MAX_TAKES_PER_WINDOW = 14
MAX_WORDS_PER_TAKE = 14
SENTENCE_ENDS = (".", "!", "?", "\u2026")
GAP_SPLIT_SECONDS = 1.5

HOOK_QUESTION_OPENERS = (
    "who", "what", "why", "how", "when", "where", "which",
    "did you know", "stop", "never", "nobody", "everyone",
)
POWER_WORDS = (
    "secret", "mistake", "truth", "free", "best", "worst", "hack",
    "proven", "insane", "crazy", "warning", "stop", "never", "always",
    "nobody", "everyone", "million", "billion", "first", "last",
)

YOUTUBE_HOSTS = (
    "youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be",
    "www.youtu.be", "youtube-nocookie.com", "www.youtube-nocookie.com",
)
TWITCH_HOSTS = (
    "twitch.tv", "www.twitch.tv", "m.twitch.tv", "go.twitch.tv",
)


class StreamClipError(Exception):
    pass


UNFINISHED_LIVE_STATUSES = frozenset({"is_live", "is_upcoming", "post_live"})
LIVE_REFUSAL = (
    "that stream is live right now: "
    "clip finding needs the finished VOD — "
    "watch this link and retry after it ends"
)
# Reject in-progress lives at download time so a missed probe cannot
# record HLS until the 1-hour audio timeout (the 30–40 minute hang).
LIVE_REJECT_FILTER = (
    "!is_live & live_status!=is_live & "
    "live_status!=is_upcoming & live_status!=post_live"
)
LIVE_REJECT_ARGS = ["--match-filter", LIVE_REJECT_FILTER]


def is_unfinished_live(doc):
    """True when clip finding cannot run yet (live, upcoming, or VOD processing).

    yt-dlp often omits ``is_live`` or sets it to None while ``live_status``
    is ``is_live`` / ``post_live``. A just-ended ``was_live`` with no
    duration is still processing. All of those must fail fast — never
    download or transcribe.
    """
    if not isinstance(doc, dict):
        return False
    if doc.get("is_live"):
        return True
    status = str(doc.get("live_status") or "").strip().lower()
    if status in UNFINISHED_LIVE_STATUSES:
        return True
    if doc.get("was_live"):
        try:
            duration = float(doc.get("duration") or 0.0)
        except (TypeError, ValueError):
            duration = 0.0
        if duration <= 0:
            return True
    return False


def _rejected_unfinished_live(stderr):
    return "match filter" in (stderr or "").lower()


def is_supported_url(url):
    """True for public YouTube links (live or VOD) / Twitch VOD links.

    YouTube live URLs probe fine — the probe reports ``is_live`` so the
    caller can watch until the VOD lands. Twitch live channels are still
    excluded (only completed ``/videos/`` VODs section-download reliably).
    """
    try:
        parts = urllib.parse.urlparse((url or "").strip())
        port = parts.port
    except ValueError:
        return False
    if parts.scheme not in ("http", "https"):
        return False
    if parts.username or parts.password or port not in (None, 80, 443):
        return False
    host = (parts.hostname or "").lower()
    if host in YOUTUBE_HOSTS:
        return True
    if host in TWITCH_HOSTS:
        # Only completed VODs (/videos/<id>); live channels and clips
        # cannot be section-downloaded reliably.
        return "/videos/" in (parts.path or "")
    return False


def _run(cmd, timeout):
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
        )
    except FileNotFoundError:
        raise StreamClipError(
            f"required binary not found: {cmd[0]} (install it and make sure it is in PATH)"
        )
    except subprocess.TimeoutExpired:
        raise StreamClipError(f"timed out running: {' '.join(cmd[:3])} ...")
    return proc


def probe_url(url, timeout=60):
    """Return metadata dict for a stream URL via ``yt-dlp --dump-json``."""
    if not is_supported_url(url):
        raise StreamClipError(
            "unsupported link: paste a public YouTube link or a "
            "completed Twitch VOD (twitch.tv/videos/<id>)"
        )
    proc = _run(
        ["yt-dlp", "--no-playlist", "--skip-download", "--dump-json", url],
        timeout,
    )
    if proc.returncode != 0:
        detail = (proc.stderr or "").strip()[-400:]
        raise StreamClipError(f"could not read that link ({detail})")
    try:
        doc = json.loads(proc.stdout or "{}")
    except ValueError:
        raise StreamClipError("could not parse video metadata for that link")
    thumbs = doc.get("thumbnails") or []
    thumb = thumbs[-1].get("url") if thumbs and isinstance(thumbs[-1], dict) else None
    if is_unfinished_live(doc):
        # Live, upcoming, or VOD still processing: report is_live so the
        # caller can watch until the replay lands. Duration is meaningless
        # until then; the VOD re-probe fills it in.
        return {
            "url": url,
            "title": doc.get("title") or "Untitled live stream",
            "channel": doc.get("channel") or doc.get("uploader") or "",
            "thumbnail": thumb,
            "duration": 0.0,
            "view_count": doc.get("view_count"),
            "upload_date": doc.get("upload_date"),
            "is_live": True,
        }
    return {
        "url": url,
        "title": doc.get("title") or "Untitled video",
        "channel": doc.get("channel") or doc.get("uploader") or "",
        "thumbnail": thumb,
        "duration": float(doc.get("duration") or 0.0),
        "view_count": doc.get("view_count"),
        "upload_date": doc.get("upload_date"),
        "is_live": False,
    }


def parse_vtt_time(stamp):
    """Parse a WebVTT/SRT timestamp to seconds."""
    m = re.match(r"(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})", stamp.strip())
    if not m:
        raise StreamClipError(f"bad caption timestamp: {stamp!r}")
    hours = int(m.group(1) or 0)
    return hours * 3600 + int(m.group(2)) * 60 + int(m.group(3)) + int(m.group(4)) / 1000.0


def _clean_cue_text(raw):
    text = html.unescape(re.sub(r"<[^>]+>", "", raw or ""))
    text = re.sub(r"\s+", " ", text).strip()
    return text


def parse_vtt(text):
    """Parse WebVTT/SRT captions to word dicts (even split per cue)."""
    words = []
    blocks = re.split(r"\n\s*\n", (text or "").strip())
    for block in blocks:
        lines = [ln.strip() for ln in block.splitlines() if ln.strip()]
        if not lines:
            continue
        if lines[0].upper().startswith("WEBVTT") or lines[0].upper().startswith("NOTE"):
            lines = lines[1:]
        if not lines:
            continue
        if lines[0][0].isdigit() and "-->" not in lines[0]:
            lines = lines[1:]
        if not lines or "-->" not in lines[0]:
            continue
        span, _, _ = lines[0].partition("-->")
        try:
            start = parse_vtt_time(span.split("-->")[0] if "-->" in span else span)
            end = parse_vtt_time(lines[0].split("-->")[1])
        except StreamClipError:
            continue
        if end <= start:
            continue
        cue = _clean_cue_text(" ".join(lines[1:]))
        if not cue:
            continue
        tokens = cue.split(" ")
        span_len = end - start
        for i, token in enumerate(tokens):
            w_start = start + span_len * i / len(tokens)
            w_end = start + span_len * (i + 1) / len(tokens)
            words.append({"word": token, "start": w_start, "end": w_end})
    return words


def parse_json3(doc):
    """Parse YouTube json3 timedtext to word dicts."""
    words = []
    events = (doc or {}).get("events") or []
    for event in events:
        if not isinstance(event, dict):
            continue
        try:
            base = float(event.get("tStartMs", 0) or 0) / 1000.0
            event_end = base + float(event.get("dDurationMs", 0) or 0) / 1000.0
        except (TypeError, ValueError):
            continue
        segs = event.get("segs") or []
        if event_end > base and segs and all(isinstance(s, dict) and not
                ("tOffsetMs" in s or "tDurationMs" in s) for s in segs):
            segs = [{"utf8": " ".join(s.get("utf8") or "" for s in segs)}]
        cursor = base
        for i, seg in enumerate(segs):
            if not isinstance(seg, dict):
                continue
            token = _clean_cue_text(seg.get("utf8") or "")
            if not token:
                continue
            try:
                start = base + float(seg["tOffsetMs"]) / 1000.0 if "tOffsetMs" in seg else cursor
                dur = float(seg.get("tDurationMs", 0) or 0) / 1000.0
                next_start = next((base + float(s["tOffsetMs"]) / 1000.0
                                   for s in segs[i + 1:] if isinstance(s, dict) and "tOffsetMs" in s), event_end)
            except (TypeError, ValueError):
                continue
            end = start + dur if dur > 0 else next_start
            if end <= start:
                end = start + max(0.2, 0.06 * len(token))
            if not all(math.isfinite(v) for v in (start, end)) or start < 0:
                continue
            tokens = token.split()
            for j, word in enumerate(tokens):
                words.append({"word": word, "start": start + (end - start) * j / len(tokens),
                              "end": start + (end - start) * (j + 1) / len(tokens)})
            cursor = end
    return [w for w in words if w["word"]]


def fetch_caption_words(url, timeout=300):
    """Download captions via yt-dlp; return (words, source_label)."""
    tmpdir = tempfile.mkdtemp(prefix="stream_caps_")
    try:
        attempts = [
            (["--sub-format", "json3"], ".json3", None),
            (["--sub-format", "vtt"], ".vtt", parse_vtt),
        ]
        for extra, ext, parser in attempts:
            cmd = [
                "yt-dlp", "--ignore-config", "--no-playlist", "--skip-download",
                "--write-auto-subs", "--write-subs",
                "--sub-langs", "en.*",
                *LIVE_REJECT_ARGS,
                *extra, "-o", os.path.join(tmpdir, f"cap.%(ext)s"), url,
            ]
            proc = _run(cmd, timeout)
            if _rejected_unfinished_live(proc.stderr):
                raise StreamClipError(LIVE_REFUSAL)
            # A later track can fail after a usable one has been written.
            paths = sorted(glob.glob(os.path.join(tmpdir, f"*{ext}")), key=lambda path: (
                0 if path.endswith(f".en{ext}") else 1 if path.endswith(f".en-orig{ext}") else 2,
                path,
            ))
            if not paths:
                continue
            for path in paths:
                try:
                    with open(path, "r", encoding="utf-8", errors="replace") as fh:
                        raw = fh.read()
                    words = parser(raw) if parser else parse_json3(json.loads(raw))
                except (OSError, ValueError, TypeError, AttributeError):
                    continue
                if words:
                    auto = "orig" in os.path.basename(path).lower() or "auto" in (proc.stdout or "").lower()
                    return words, "youtube-auto-captions" if auto else "youtube-captions"
        raise StreamClipError("English captions are unavailable or could not be downloaded")
    finally:
        for path in glob.glob(os.path.join(tmpdir, "*")):
            try:
                os.remove(path)
            except OSError:
                pass
        try:
            os.rmdir(tmpdir)
        except OSError:
            pass


def transcribe_url_words(url, timeout=3600, engine="local", api_key=""):
    """Fetch audio, use the chosen provider, and discard temporary media."""
    if not is_supported_url(url):
        raise StreamClipError("unsupported video link")
    try:
        from . import transcribe as transcribe_mod
    except ImportError:
        import transcribe as transcribe_mod
    if engine not in ("local", "elevenlabs"):
        raise StreamClipError("Choose Local Whisper or ElevenLabs in Settings → Engine")
    if engine == "elevenlabs" and not api_key.strip():
        raise StreamClipError("ElevenLabs is selected. Save a key with Speech-to-Text access in Settings → API keys.")
    if engine == "local" and not transcribe_mod.local_available():
        raise StreamClipError(
            "Captions unavailable and local speech recognition is not installed. "
            "Run video-use/setup_local_stt.sh (installed app: add --managed), then retry."
        )
    if not shutil.which("ffmpeg"):
        raise StreamClipError("Captions unavailable; install ffmpeg to extract this video's audio for transcription.")
    print(f"[STREAM] Captions unavailable; downloading audio for {engine} transcription", file=sys.stderr)
    with tempfile.TemporaryDirectory(prefix="stream_audio_") as tmpdir:
        last_error = "audio download produced no media"
        for extra in ([], ["--extractor-args", "youtube:player_client=android"],
                      ["--extractor-args", "youtube:player_client=ios"]):
            proc = _run([
                "yt-dlp", "--ignore-config", "--no-playlist", "--no-progress",
                "--socket-timeout", "30", "--retries", "3", "--fragment-retries", "3",
                *LIVE_REJECT_ARGS,
                "-f", "bestaudio/best", *extra,
                "-o", os.path.join(tmpdir, "audio.%(ext)s"), url,
            ], timeout)
            if _rejected_unfinished_live(proc.stderr):
                raise StreamClipError(LIVE_REFUSAL)
            media = [p for p in glob.glob(os.path.join(tmpdir, "audio.*"))
                     if not p.endswith((".part", ".ytdl", ".temp")) and os.path.getsize(p) > 0]
            if proc.returncode == 0 and media:
                break
            last_error = _clean_download_error(proc.stderr).replace("clip download failed", "audio download failed")
            for path in glob.glob(os.path.join(tmpdir, "*")):
                if os.path.isfile(path):
                    os.remove(path)
        else:
            raise StreamClipError(last_error)
        print(f"[STREAM] Transcribing source audio with {engine}; long videos may take several minutes", file=sys.stderr)
        try:
            if engine == "local":
                doc = transcribe_mod.transcribe_local(media[0])
            else:
                doc = transcribe_mod.transcribe_file(media[0], api_key)
        except (transcribe_mod.TranscribeError, OSError, subprocess.TimeoutExpired) as exc:
            label = "Local" if engine == "local" else "ElevenLabs"
            raise StreamClipError(f"{label} transcription failed: {exc}. Check transcription setup in Settings and retry.") from exc
        words = transcribe_mod.normalize_words(doc)
        if not words:
            raise StreamClipError("No speech was detected in this video's audio; clip suggestions need spoken content.")
        return words, "local-whisper" if engine == "local" else f"elevenlabs:{transcribe_mod.SCRIBE_MODEL}"


def fetch_transcript_words(url, engine="local", api_key=""):
    """Prefer published captions, then listen locally.

    ``engine`` and ``api_key`` stay in the signature because the clip command
    still receives the Settings provider. They are not used here. ElevenLabs
    is for a short file the user dropped. A replay with no YouTube or Twitch
    captions is transcribed on this computer, including when Settings is
    ElevenLabs and that account is out of credits.
    """
    del engine, api_key
    try:
        return fetch_caption_words(url)
    except StreamClipError as exc:
        if LIVE_REFUSAL in str(exc):
            raise
        return transcribe_url_words(url)


def _word_start(item):
    try:
        return float(item.get("start", 0.0))
    except (TypeError, ValueError):
        return 0.0


def group_takes(words, max_words=MAX_WORDS_PER_TAKE):
    """Group word dicts into sentence-ish takes (mirrors pack_transcripts)."""
    takes = []
    current = []
    for item in words or []:
        if current and _word_start(item) - _word_start(current[-1]) > GAP_SPLIT_SECONDS:
            takes.append(_make_take(current))
            current = []
        current.append(item)
        text = (item.get("word") or "").strip()
        if text.endswith(SENTENCE_ENDS) or len(current) >= max_words:
            takes.append(_make_take(current))
            current = []
    if current:
        takes.append(_make_take(current))
    return takes


def _make_take(items):
    text = " ".join((w.get("word") or "").strip() for w in items).strip()
    return {
        "start": float(items[0].get("start", 0.0)),
        "end": float(items[-1].get("end", items[-1].get("start", 0.0))),
        "text": text,
        "word_count": len(items),
    }


def _hook_score(text):
    lowered = (text or "").lower().strip()
    if not lowered:
        return 0.0, ""
    score = 0.2
    why = ""
    if "?" in text:
        score += 0.35
        why = "asks a question"
    elif lowered.split(" ")[:3] and lowered.split(" ")[0] in HOOK_QUESTION_OPENERS:
        score += 0.3
        why = "opens with a hook"
    hits = [w for w in POWER_WORDS if w in lowered]
    if hits:
        score += min(0.3, 0.12 + 0.06 * len(hits))
        why = why or f"power word: '{hits[0]}'"
    if re.search(r"\d", text):
        score += 0.12
        why = why or "names a concrete number"
    if "!" in text:
        score += 0.1
        why = why or "high-energy opener"
    return min(1.0, score), why


def score_window(window, global_wps, ideal_len, full_range):
    """Score one candidate window 0..1; returns (score, reason)."""
    text = " ".join(t["text"] for t in window).strip()
    start = window[0]["start"]
    length = window[-1]["end"] - start
    if length <= 0:
        return 0.0, ""
    words = text.split(" ")
    total = len(words) or 1

    hook, hook_why = _hook_score(window[0]["text"])

    wps = total / length
    density = 0.5
    if global_wps > 0:
        density = max(0.0, min(1.0, ((wps / global_wps) - 0.5)))
    dense = density >= 0.6

    last = window[-1]["text"].strip()
    complete = 1.0 if last.endswith(SENTENCE_ENDS) else 0.4

    half = max(1.0, full_range / 2.0)
    length_fit = max(0.0, 1.0 - min(1.0, abs(length - ideal_len) / half))

    variety = len(set(w.lower() for w in words)) / total

    if start < 30:
        position = 0.3  # intros ramble; the hook must earn it
    elif start < 120:
        position = 0.7
    else:
        position = 1.0

    score = (
        0.30 * hook + 0.20 * density + 0.15 * complete
        + 0.15 * length_fit + 0.10 * variety + 0.10 * position
    )
    score = max(0.0, min(1.0, score))

    if hook >= 0.55 and hook_why:
        reason = f"Strong hook — {hook_why}"
    elif dense:
        reason = "Fast-paced delivery worth clipping"
    elif complete >= 1.0:
        reason = "Self-contained point with a clean close"
    elif variety > 0.85:
        reason = "Dense, novel point — no filler"
    else:
        reason = "High-energy moment"
    return round(score, 3), reason


def _overlaps(a_start, a_end, b_start, b_end):
    return max(a_start, b_start) < min(a_end, b_end)


def suggest_clips(words, duration=0.0,
                  threshold=DEFAULT_THRESHOLD,
                  min_length=DEFAULT_MIN_LENGTH,
                  max_length=DEFAULT_MAX_LENGTH,
                  max_clips=DEFAULT_MAX_CLIPS,
                  min_gap=DEFAULT_MIN_GAP):
    """Pick the best clip windows. Count is quality-driven, never fixed."""
    takes = group_takes(words)
    if not takes:
        return []
    if not duration or duration <= 0:
        duration = max(t["end"] for t in takes)
    total_words = sum(t["word_count"] for t in takes)
    span = max(1.0, takes[-1]["end"] - takes[0]["start"])
    global_wps = total_words / span
    ideal_len = (min_length + max_length) / 2.0
    full_range = max(1.0, max_length - min_length)

    candidates = []
    last_start = -1e9
    for i, first in enumerate(takes):
        if first["start"] - last_start < WINDOW_START_STRIDE:
            continue
        last_start = first["start"]
        length = 0.0
        for j in range(i, min(len(takes), i + MAX_TAKES_PER_WINDOW)):
            length = takes[j]["end"] - first["start"]
            if length > max_length:
                break
            if length >= min_length:
                window = takes[i:j + 1]
                score, reason = score_window(window, global_wps, ideal_len, full_range)
                if score >= threshold:
                    candidates.append({
                        "start": round(first["start"], 3),
                        "end": round(takes[j]["end"], 3),
                        "score": score,
                        "reason": reason,
                        "text": " ".join(t["text"] for t in window)[:280],
                    })

    # Greedy by score: an accepted clip suppresses overlapping or
    # too-close neighbours, so the count follows quality, not a quota.
    candidates.sort(key=lambda c: (-c["score"], c["start"]))
    accepted = []
    for cand in candidates:
        clash = False
        for kept in accepted:
            if _overlaps(cand["start"], cand["end"], kept["start"], kept["end"]):
                clash = True
                break
            gap = max(cand["start"], kept["start"]) - min(cand["end"], kept["end"])
            if gap < min_gap:
                clash = True
                break
        if not clash:
            accepted.append(cand)
        if len(accepted) >= max_clips:
            break
    accepted.sort(key=lambda c: c["start"])
    return accepted


def wants_agent_clips(agent_id):
    """True when an agent CLI should plan the clips (mirrors short_pipeline)."""
    return (
        bool(agent_id)
        and agent_id.strip().lower() not in ("none", "off", "auto", "")
    )


def clips_with_text(segments, words, limit=280):
    """Attach a transcript snippet to each agent-planned segment."""
    clips = []
    for seg in segments:
        bits = [
            (w.get("word") or "").strip()
            for w in words or []
            if float(w.get("start", 0) or 0) < seg["end"]
            and float(w.get("end", 0) or 0) > seg["start"]
        ]
        clips.append({
            "start": seg["start"], "end": seg["end"],
            "score": seg.get("score", 0.5),
            "reason": seg.get("reason") or "Agent pick",
            "text": " ".join(b for b in bits if b)[:limit],
        })
    return clips


def suggest_with_agent(words, duration, agent_id,
                       min_length=DEFAULT_MIN_LENGTH,
                       max_length=DEFAULT_MAX_LENGTH,
                       max_clips=DEFAULT_MAX_CLIPS,
                       min_gap=DEFAULT_MIN_GAP,
                       context=None, hook=None, model=None):
    """Plan clips with the same agent EDL path the file pipeline uses.

    Takes come from the stream captions via pack_transcripts, so the
    agent sees the identical cut-sheet shape as a local-file render.
    Raises StreamClipError when the agent cannot deliver.
    """
    takes = pack_mod.pack_words(words)
    if not takes:
        raise StreamClipError("empty transcript: nothing for the agent to cut")
    takes_text = pack_mod.render_markdown(takes, "stream")
    if not duration or duration <= 0:
        duration = max(float(w.get("end", 0) or 0) for w in words)
    try:
        edl = agent_mod.run_agent_multiclip(
            agent_id, takes_text, duration,
            min_length=min_length, max_length=max_length,
            max_clips=max_clips, min_gap=min_gap,
            context=context, hook=hook, model=model,
        )
    except agent_mod.AgentError as exc:
        raise StreamClipError(f"agent cut failed ({exc})")
    return clips_with_text(edl["segments"], words)


def format_section_time(seconds):
    """Format seconds as HH:MM:SS for ``yt-dlp --download-sections``."""
    seconds = max(0, int(float(seconds)))
    return f"{seconds // 3600:02d}:{(seconds % 3600) // 60:02d}:{seconds % 60:02d}"


def _clean_download_error(stderr):
    """Turn yt-dlp stderr into a short, URL-free human message."""
    lines = [
        ln.strip() for ln in (stderr or "").splitlines()
        if ln.strip().startswith("ERROR")
    ]
    detail = " ".join(lines)[-300:] if lines else (stderr or "").strip()[-300:]
    # Never leak signed googlevideo URLs into UI/errors.
    detail = re.sub(r"https?://\S+", "[url]", detail)
    lowered = detail.lower()
    if "403" in lowered or "forbidden" in lowered or "confirm you" in lowered:
        return (
            "YouTube refused the download (bot check). "
            "Update yt-dlp to the latest nightly and retry; "
            "private, age-gated, or members-only videos may need cookies."
        )
    if "private" in lowered:
        return "That video is private — only the owner can download it."
    if "ffmpeg" in lowered and "section" in lowered:
        return "ffmpeg is required to cut clip windows and was not found in PATH."
    if "unsupported url" in lowered or "no video formats" in lowered:
        return "No downloadable formats found for that link."
    return f"clip download failed ({detail or 'unknown error'})"


def _write_source_marker(output, url, start, end):
    """Mark ``output`` as an app download so Settings > Storage can clean it up."""
    try:
        with open(output + ".source.json", "w", encoding="utf-8") as fh:
            json.dump({"kind": "stream_clip", "url": url, "start": start, "end": end}, fh)
    except OSError:
        pass  # The clip itself is fine; it just won't be listed for cleanup.


def download_section(url, start, end, output, timeout=3600):
    """Download one ``start``–``end`` window via yt-dlp sections.

    Retries with alternate player clients: YouTube regularly rejects
    the default web client with 403/signature errors while the android
    client still serves the same video.
    """
    if end <= start:
        raise StreamClipError("clip end must be after clip start")
    output = os.path.abspath(output)
    parent = os.path.dirname(output)
    if parent:
        try:
            os.makedirs(parent, exist_ok=True)
        except OSError as exc:
            raise StreamClipError(f"Cannot create clip folder: {exc}")
    section = f"*{format_section_time(start)}-{format_section_time(end)}"
    client_attempts = [
        [],
        ["--extractor-args", "youtube:player_client=android"],
        ["--extractor-args", "youtube:player_client=ios"],
    ]
    last_error = "clip download failed (unknown error)"
    for extra in client_attempts:
        # A partial file from a failed client must not poison the retry.
        try:
            if os.path.isfile(output):
                os.remove(output)
        except OSError:
            pass
        proc = _run(
            ["yt-dlp", "--no-playlist",
             "--retries", "3", "--fragment-retries", "3",
             "--download-sections", section,
             "--force-keyframes-at-cuts",
             # Restrict neither the source video nor audio container: forcing
             # M4A made YouTube fall back to a 360p combined format when its
             # HD video was paired with Opus audio. FFmpeg writes the MP4.
             "-f", "bv*+ba/b", "-S", "res:1080", "--merge-output-format", "mp4",
             *extra, "-o", output, url],
            timeout,
        )
        if proc.returncode == 0 and os.path.isfile(output):
            _write_source_marker(output, url, start, end)
            return output
        last_error = _clean_download_error(proc.stderr)
    raise StreamClipError(last_error)


def load_words_file(path):
    with open(path, "r", encoding="utf-8") as fh:
        doc = json.load(fh)
    words = doc.get("words") or []
    if isinstance(doc.get("duration"), (int, float)):
        duration = float(doc["duration"])
    elif words:
        duration = max(float(w.get("end", 0) or 0) for w in words)
    else:
        duration = 0.0
    return words, duration


def build_parser():
    parser = argparse.ArgumentParser(description="YouTube stream clip finder.")
    parser.add_argument("--url", default=None, help="Public YouTube / Twitch VOD link.")
    parser.add_argument("--probe", action="store_true",
                        help="Print link metadata JSON and exit.")
    parser.add_argument("--suggest", action="store_true",
                        help="Print suggested-clips JSON and exit.")
    parser.add_argument("--download", action="store_true",
                        help="Download one --start/--end window to --output.")
    parser.add_argument("--start", type=float, default=None, help="Window start (seconds).")
    parser.add_argument("--end", type=float, default=None, help="Window end (seconds).")
    parser.add_argument("--output", default=None, help="Download destination file.")
    parser.add_argument("--words", default=None,
                        help="Local transcript JSON (transcribe.py shape); skips caption fetch.")
    parser.add_argument("--engine", choices=("local", "elevenlabs"), default="local")
    parser.add_argument("--elevenlabs-key", default=os.environ.get("PIXEL_ELEVENLABS_KEY", ""))
    parser.add_argument("--duration", type=float, default=0.0, help="Source duration override.")
    parser.add_argument("--agent", default=None,
                        help="Editing agent for cut selection (claude|codex|agy|grok); "
                             "auto|none|off = heuristic scoring.")
    parser.add_argument("--model", default=None, help="Optional model override for the agent CLI.")
    parser.add_argument("--channel-context", default=None)
    parser.add_argument("--prompt", default=None, help="Custom edit prompt; YouTube links are caption-based references.")
    parser.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD)
    parser.add_argument("--min-length", type=float, default=DEFAULT_MIN_LENGTH)
    parser.add_argument("--max-length", type=float, default=DEFAULT_MAX_LENGTH)
    parser.add_argument("--max-clips", type=int, default=DEFAULT_MAX_CLIPS)
    parser.add_argument("--min-gap", type=float, default=DEFAULT_MIN_GAP)
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)

    custom_prompt = bool(args.prompt and args.prompt.strip())
    if custom_prompt and not args.probe and not args.download:
        try:
            if not wants_agent_clips(args.agent):
                raise agent_mod.reference_mod.ReferenceError("Custom prompts require an editing agent; choose one in Style.")
            agent_mod.reference_mod.youtube_references(args.prompt)
        except (agent_mod.reference_mod.ReferenceError, ValueError) as exc:
            print(f"stream_clip.py: {exc}", file=sys.stderr)
            return 1

    if args.probe:
        if not args.url:
            print("stream_clip.py: --url is required with --probe", file=sys.stderr)
            return 2
        try:
            print(json.dumps(probe_url(args.url)))
        except StreamClipError as exc:
            print(f"stream_clip.py: {exc}", file=sys.stderr)
            return 1
        return 0

    if args.download:
        if not args.url or args.start is None or args.end is None or not args.output:
            print("stream_clip.py: --download needs --url --start --end --output",
                  file=sys.stderr)
            return 2
        try:
            saved = download_section(args.url, args.start, args.end, args.output)
        except StreamClipError as exc:
            print(f"stream_clip.py: {exc}", file=sys.stderr)
            return 1
        print(json.dumps({"output": saved, "start": args.start, "end": args.end}))
        return 0

    # Default / --suggest: find the best windows.
    words, duration, source = [], args.duration or 0.0, "none"
    meta = {"title": "", "channel": ""}
    if args.words:
        if not os.path.isfile(args.words):
            print(f"stream_clip.py: words file not found: {args.words}", file=sys.stderr)
            return 2
        words, file_duration = load_words_file(args.words)
        if not duration:
            duration = file_duration
        source = "transcript-file"
    elif args.url:
        try:
            meta = probe_url(args.url)
        except StreamClipError as exc:
            print(f"stream_clip.py: {exc}", file=sys.stderr)
            return 1
        if meta.get("is_live"):
            print(f"stream_clip.py: {LIVE_REFUSAL}", file=sys.stderr)
            return 1
        duration = duration or meta.get("duration", 0.0)
        try:
            words, source = fetch_transcript_words(args.url, args.engine, args.elevenlabs_key)
        except StreamClipError as exc:
            print(f"stream_clip.py: {exc}", file=sys.stderr)
            return 1
    else:
        print("stream_clip.py: give --url or --words", file=sys.stderr)
        return 2

    # A selected editing model must actually plan the clips. Local scoring
    # is used only when Auto was explicitly selected.
    picker = "heuristic"
    picker_note = ""
    if wants_agent_clips(args.agent):
        print(f"[STREAM] Agent ({args.agent.upper()}) planning clips from transcript",
              file=sys.stderr)
        try:
            clips = suggest_with_agent(
                words, duration, args.agent,
                min_length=args.min_length, max_length=args.max_length,
                max_clips=args.max_clips, min_gap=args.min_gap,
                context=args.channel_context, hook=args.prompt,
                model=args.model,
            )
            picker = f"agent:{args.agent.strip().lower()}"
        except StreamClipError as exc:
            print(f"stream_clip.py: {exc}; choose an available model or Auto and retry", file=sys.stderr)
            return 1
    else:
        clips = suggest_clips(
            words, duration,
            threshold=args.threshold, min_length=args.min_length,
            max_length=args.max_length, max_clips=args.max_clips,
            min_gap=args.min_gap,
        )
    print(json.dumps({
        "url": args.url or "",
        "title": meta.get("title", ""),
        "channel": meta.get("channel", ""),
        "duration": duration,
        "transcript_source": source,
        "words_count": len(words),
        "picker": picker,
        "picker_note": picker_note,
        "clips": clips,
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
