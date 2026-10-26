"""Transcript extraction and validation of user-approved source edits."""

import argparse
import json
import math
import os
import sys
import tempfile
import re
from difflib import SequenceMatcher

try:
    from . import render, transcribe, agent_edit, pack_transcripts
except ImportError:
    import render
    import transcribe
    import agent_edit
    import pack_transcripts


class EditError(ValueError):
    pass


def speech_ranges(words, duration, padding=.12, max_pause=.65):
    """Remove long silence with room around every spoken word."""
    ranges = []
    for word in sorted(words, key=lambda w: w["start"]):
        start, end = max(0., float(word["start"]) - padding), min(duration, float(word["end"]) + padding)
        if end <= start:
            continue
        if ranges and start - ranges[-1]["end"] <= max_pause:
            ranges[-1]["end"] = max(ranges[-1]["end"], end)
        else:
            ranges.append({"start": start, "end": end})
    if not ranges:
        raise EditError("No timed speech available to prepare an edit")
    return ranges


def cleanup_plan(words, duration, remove_silence=True, remove_retakes=True):
    """Conservative repeated-take matching; always retain the later version.

    Compare nearby utterances rather than deleting recurring topic words.
    Different numbers are meaningful facts, not an interchangeable retake.
    """
    utterances, current = [], []
    for index, word in enumerate(words):
        current.append(index)
        following = words[index + 1] if index + 1 < len(words) else None
        if (not following or re.search(r"[.!?]$", word["word"])
                or following["start"] - word["end"] > .9 or len(current) >= 40):
            utterances.append(current)
            current = []
    def tokens(indices):
        return [re.sub(r"[^\w]+", "", words[i]["word"].lower()) for i in indices]
    removed, reasons = set(), []
    for i, earlier in enumerate(utterances):
        first = tokens(earlier)
        if len(first) < 4:
            continue
        for later in utterances[i + 1:i + 9]:
            gap = words[later[0]]["start"] - words[earlier[-1]]["end"]
            if gap > 30:
                break
            second = tokens(later)
            if len(second) < 4:
                continue
            numbers_a = re.findall(r"\d+(?:\.\d+)?", " ".join(words[k]["word"] for k in earlier))
            numbers_b = re.findall(r"\d+(?:\.\d+)?", " ".join(words[k]["word"] for k in later))
            if numbers_a != numbers_b:
                continue
            negations = {"not", "never", "no", "without", "cant", "cannot", "dont", "doesnt"}
            if set(first) & negations != set(second) & negations:
                continue
            ratio = SequenceMatcher(None, first, second, autojunk=False).ratio()
            partial = (gap <= 5 and len(first) < len(second)
                       and not re.search(r"[.!?]$", words[earlier[-1]]["word"])
                       and SequenceMatcher(None, first, second[:len(first)], autojunk=False).ratio() >= .9)
            if ratio >= .87 or partial:
                removed.update(earlier)
                reasons.append({"start": words[earlier[0]]["start"], "end": words[earlier[-1]]["end"],
                                "reason": "Earlier repeated take; later version kept", "later_start": words[later[0]]["start"]})
                break
    ranges, run = [], []
    # Catch an immediate restart even when ASR writes both attempts as one
    # sentence. Four words avoids treating ordinary single-word emphasis as
    # a failed take.
    normalized = tokens(list(range(len(words))))
    for start in range(len(words)):
        for size in range(min(12, (len(words) - start) // 2), 3, -1):
            first, second = list(range(start, start + size)), list(range(start + size, start + size * 2))
            if (not set(first).issubset(removed)
                    and words[second[0]]["start"] - words[first[-1]]["end"] <= 2
                    and normalized[start:start + size] == normalized[start + size:start + size * 2]):
                removed.update(first)
                reasons.append({"start": words[first[0]]["start"], "end": words[first[-1]]["end"],
                                "reason": "Earlier repeated phrase; later version kept", "later_start": words[second[0]]["start"]})
                break
    if not remove_retakes:
        removed, reasons = set(), []
    for i in range(len(words) + 1):
        if i < len(words) and i not in removed:
            run.append(i)
            continue
        if run:
            spans = (speech_ranges([words[k] for k in run], duration) if remove_silence
                     else [{"start": words[run[0] - 1]["end"] if run[0] else 0.,
                            "end": words[run[-1] + 1]["start"] if run[-1] + 1 < len(words) else duration}])
            if run[0] > 0:
                spans[0]["start"] = max(spans[0]["start"], words[run[0] - 1]["end"])
            if run[-1] < len(words) - 1:
                spans[-1]["end"] = min(spans[-1]["end"], words[run[-1] + 1]["start"])
            ranges.extend(s for s in spans if s["end"] - s["start"] > render.FADE_SECONDS)
            run = []
    if not ranges:
        raise EditError("No usable speech remains in the prepared edit")
    return ranges, reasons


def safe_agent_ranges(segments, words, duration):
    """Move cut boundaries outside words before exposing the edit to Studio."""
    spans = []
    for segment in segments:
        start, end = segment["start"], segment["end"]
        for word in words:
            if word["start"] < start < word["end"]:
                start = max(0., word["start"] - .06)
            if word["start"] < end < word["end"]:
                end = min(duration, word["end"] + .06)
        if spans and start <= spans[-1]["end"]:
            spans[-1]["end"] = max(spans[-1]["end"], end)
        else:
            spans.append({"start": start, "end": end})
    return spans


def _seconds(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise EditError("Edit timestamps must be finite numbers")
    return float(value)


def validate_plan(doc, source_duration, source_path):
    """Keep explicit user ranges exactly; never apply the AI duration budget."""
    if not isinstance(doc, dict) or doc.get("version") != 1:
        raise EditError("Unsupported transcript edit; reload the source")
    if os.path.realpath(doc.get("source_path") or "") != os.path.realpath(source_path):
        raise EditError("Transcript edit belongs to another source video")
    if abs(_seconds(doc.get("source_duration")) - source_duration) > .25:
        raise EditError("Source duration changed; generate the transcript again")
    spans = doc.get("segments")
    if not isinstance(spans, list) or not spans:
        raise EditError("Keep at least one transcript line before rendering")
    segments = []
    for span in spans:
        if not isinstance(span, dict):
            raise EditError("Invalid source range")
        start, end = _seconds(span.get("start")), _seconds(span.get("end"))
        if start < 0 or end > source_duration + .05 or end <= start:
            raise EditError("Transcript cut is outside the source video")
        if segments and start < segments[-1]["end"]:
            raise EditError("Transcript cuts must be ordered and must not overlap")
        if segments and abs(start - segments[-1]["end"]) < .000001:
            segments[-1]["end"] = end
        else:
            segments.append({"start": start, "end": min(end, source_duration)})
    if len(segments) > 1 and any(s["end"] - s["start"] <= render.FADE_SECONDS for s in segments):
        raise EditError("Transcript cuts are too short to join safely")
    words = doc.get("words")
    if words is not None:
        if not isinstance(words, list):
            raise EditError("Invalid caption words")
        clean = []
        for word in words:
            if not isinstance(word, dict) or not isinstance(word.get("word"), str):
                raise EditError("Invalid caption word")
            start, end = _seconds(word.get("start")), _seconds(word.get("end"))
            if start < 0 or end < start or end > source_duration + .05:
                raise EditError("Caption timestamp is outside the source video")
            if word["word"].strip():
                clean.append({"word": word["word"].strip(), "start": start, "end": end})
        words = sorted(clean, key=lambda w: w["start"])
    return {"source": "transcript-edit", "segments": segments, "words": words}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Read the complete source transcript for editing.")
    parser.add_argument("--input", required=True)
    parser.add_argument("--elevenlabs-key", default=os.environ.get("PIXEL_ELEVENLABS_KEY", ""))
    parser.add_argument("--engine", choices=("local", "elevenlabs", "auto"), default="local")
    parser.add_argument("--prepare", action="store_true")
    parser.add_argument("--agent", default="auto")
    parser.add_argument("--duration", type=float, default=None)
    parser.add_argument("--prompt", default="")
    parser.add_argument("--channel-context", default="")
    args = parser.parse_args(argv)
    try:
        info = render.probe_media(args.input)
        if not info["has_audio"]:
            raise EditError("This source has no audio to transcribe. You can still keep the full video.")
        # Whisper/PyAV stays in this worker, separate from OpenCV framing.
        with tempfile.TemporaryDirectory(prefix="transcript_editor_") as directory:
            output = os.path.join(directory, "words.json")
            rc = transcribe.main(["--input", args.input, "--output", output,
                                  "--elevenlabs-key", args.elevenlabs_key, "--engine", args.engine])
            if rc or not os.path.isfile(output):
                raise EditError("Could not transcribe this video")
            with open(output, encoding="utf-8") as handle:
                doc = json.load(handle)
        if not doc.get("words"):
            raise EditError(doc.get("note") or "No speech detected. Check local transcription in Settings.")
        result = {"source_path": os.path.abspath(args.input), "source_duration": info["duration"],
                  "words": doc["words"], "engine": doc.get("model", "local")}
        if args.prepare:
            if args.agent in ("", "auto"):
                if args.prompt.strip():
                    raise EditError("Choose an editing model to apply your custom prompt")
                result["suggested_segments"], result["removals"] = cleanup_plan(doc["words"], info["duration"])
                result["edit_method"] = "Silence & retake cleanup"
            else:
                takes = pack_transcripts.render_markdown(pack_transcripts.pack_words(doc["words"]),
                                                         os.path.basename(args.input))
                target = args.duration if args.duration and args.duration > 0 else info["duration"]
                guidance = ("Make a clean professional edit. Remove empty silence and failed or repeated takes; "
                            "prefer the later complete take. Preserve complete spoken words and sentences. "
                            "Preserve the whole story within the target length. " + args.prompt)
                edit = agent_edit.run_agent_cut(args.agent, takes, info["duration"], target_duration=target,
                                               context=args.channel_context, hook=guidance)
                result["suggested_segments"] = safe_agent_ranges(edit["segments"], doc["words"], info["duration"])
                result["edit_method"] = f"AI edit ({args.agent})"
        print("__TRANSCRIPT_START__")
        print(json.dumps(result, ensure_ascii=True))
        print("__TRANSCRIPT_END__")
        return 0
    except (EditError, render.RenderError, agent_edit.AgentError, OSError, ValueError) as exc:
        print(f"Transcript: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
