"""Post-render review: ground the review report in measured output facts.

Reads the rendered short plus the pipeline sidecars (words.json, edl.json,
takes_packed.md — auto-discovered next to the output when not given) and
prints a ``VideoReviewReport`` JSON object to stdout (logs go to stderr).

The retention score is a documented heuristic, not a prediction: it is
computed from speech density, cut count, hook presence, and duration fit,
all measured from the actual render inputs.

Stdlib only (plus the sibling helpers for probing/packing).
"""

import argparse
import json
import os
import sys

try:
    from . import render as render_mod
    from . import pack_transcripts as pack_mod
except ImportError:  # running as `python helpers/review.py`
    import render as render_mod
    import pack_transcripts as pack_mod


def _sibling(input_path, name):
    directory = os.path.dirname(os.path.abspath(input_path)) or "."
    candidate = os.path.join(directory, name)
    return candidate if os.path.isfile(candidate) else None


def _load_json(path):
    if not path or not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (json.JSONDecodeError, ValueError, OSError):
        return None


def _transcript_source(words_doc):
    """Short label for the engine that produced words.json ("none" if none)."""
    model = ((words_doc or {}).get("model") or "").strip()
    return model or "none"


def _words_in_output(words, segments, output_duration):
    """Filter words to those actually present in the rendered output."""
    if segments:
        kept = []
        for w in words or []:
            try:
                ws = float(w.get("start", -1))
            except (TypeError, ValueError):
                continue
            if any(float(s["start"]) <= ws < float(s["end"]) for s in segments):
                kept.append(w)
        return kept
    if output_duration and output_duration > 0:
        return [w for w in (words or []) if _word_start(w) < output_duration]
    return list(words or [])


def _word_start(w):
    try:
        return float(w.get("start", 0.0))
    except (TypeError, ValueError):
        return 0.0


def _audience_from_context(context):
    for line in (context or "").splitlines():
        if line.strip().lower().startswith("audience:"):
            return line.split(":", 1)[1].strip() or None
    return None


def build_report(output_duration, words_in_output, segments, takes_count, context=None):
    """Build the review report dict from measured inputs (pure)."""
    words_in_output = words_in_output or []
    segments = segments or []
    word_count = len(words_in_output)
    segment_count = len(segments)
    duration = output_duration or 0.0

    wps = (word_count / duration) if duration > 0 else 0.0

    takes = pack_mod.pack_words(
        [{"word": w.get("word"), "start": _word_start(w),
          "end": float(w.get("end", _word_start(w)))}
         for w in words_in_output]
    ) if words_in_output else []
    hook = takes[0]["text"] if takes else ""
    if len(hook) > 140:
        hook = hook[:137].rstrip() + "..."

    if segments:
        by_score = sorted(segments, key=lambda s: float(s.get("score", 0.5)),
                          reverse=True)
        highlights = [str(s.get("reason") or "").strip() for s in by_score[:4]]
        highlights = [h for h in highlights if h]
    else:
        highlights = []
    if len(highlights) < 2:
        highlights += [t["text"] for t in takes[1:5] if t["text"]]
    highlights = highlights[:4]

    # Retention heuristic (documented estimate):
    # base 60 + speech density (0-15) + cut count (0-10) + hook (0-5)
    # + duration fit (0-5), clamped to 40..99.
    density = min(15.0, max(0.0, (wps / 2.5) * 15.0)) if word_count else 0.0
    cuts = min(10.0, max(0, segment_count - 1) * 3.0)
    hook_bonus = 5.0 if hook else 0.0
    if 20 <= duration <= 45:
        fit = 5.0
    elif 10 <= duration <= 60:
        fit = 3.0
    else:
        fit = 0.0
    retention = int(round(min(99.0, max(40.0, 60.0 + density + cuts + hook_bonus + fit))))

    cuts_per_10s = (segment_count / duration * 10.0) if duration > 0 else 0.0
    if segment_count <= 1:
        pacing = "Steady single-take pacing with 30ms anti-pop fades"
    elif cuts_per_10s >= 3:
        pacing = "Very fast multi-cut pacing with 30ms anti-pop crossfades"
    else:
        pacing = "Fast-paced punchy cuts with 30ms anti-pop crossfades"

    audience = _audience_from_context(context) or (
        "Engineers, developers, and tech builders aligned with your channel profile."
    )

    cuts = segment_count or 1
    summary = (
        f"Rendered {duration:.0f}s vertical short"
        + (f" from {takes_count} takes" if takes_count else "")
        + f" ({word_count} spoken words, {cuts} "
        + ("cuts" if cuts != 1 else "cut")
        + f", {wps:.1f} words/sec)."
        + (f" Hook opens on: {hook}" if hook else " No transcript hook detected.")
    )

    return {
        "overall_summary": summary,
        "hook_detected": hook,
        "content_highlights": highlights,
        "retention_score": retention,
        "target_audience": audience,
        "suggested_pacing": pacing,
        "word_count": word_count,
        "takes_count": takes_count or 0,
        "segment_count": segment_count,
        "output_duration": round(duration, 2),
        "speech_wps": round(wps, 2),
    }


def review_file(input_path, words_path=None, edl_path=None, takes_path=None,
                context=None):
    """Assemble inputs (with sibling auto-discovery) and build the report."""
    if not os.path.isfile(input_path):
        raise render_mod.RenderError(f"rendered video not found: {input_path}")

    info = render_mod.probe_media(input_path)

    words_doc = _load_json(words_path or (input_path + ".words.json" if os.path.isfile(input_path + ".words.json") else _sibling(input_path, "words.json")))
    words = (words_doc or {}).get("words", []) or []
    edl_doc = _load_json(edl_path or (input_path + ".edl.json" if os.path.isfile(input_path + ".edl.json") else _sibling(input_path, "edl.json")))
    segments = (edl_doc or {}).get("segments", []) or []

    takes_path = takes_path or (input_path + ".takes_packed.md" if os.path.isfile(input_path + ".takes_packed.md") else _sibling(input_path, "takes_packed.md"))
    takes_count = 0
    if takes_path and os.path.isfile(takes_path):
        try:
            with open(takes_path, "r", encoding="utf-8") as fh:
                for line in fh:
                    cells = [c.strip() for c in line.strip().strip("|").split("|")]
                    if cells and cells[0].isdigit():
                        takes_count += 1
        except OSError:
            takes_count = 0
    if not takes_count and words:
        takes_count = len(pack_mod.pack_words(words))

    in_output = _words_in_output(words, segments, info["duration"])
    report = build_report(info["duration"], in_output, segments, takes_count, context)
    report["transcript_source"] = _transcript_source(words_doc)
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description="Review a rendered short.")
    parser.add_argument("--input", required=True, help="Rendered short (.mp4).")
    parser.add_argument("--words", default=None, help="words.json (auto-discovered).")
    parser.add_argument("--edl", default=None, help="edl.json (auto-discovered).")
    parser.add_argument("--takes", default=None, help="takes_packed.md (auto-discovered).")
    parser.add_argument("--context", default=None, help="Channel context text.")
    parser.add_argument("--output", default=None, help="Write review JSON to file.")
    args = parser.parse_args(argv)

    try:
        report = review_file(
            args.input, words_path=args.words, edl_path=args.edl,
            takes_path=args.takes, context=args.context,
        )
    except render_mod.RenderError as exc:
        print(f"review.py: {exc}", file=sys.stderr)
        return 1

    payload = json.dumps(report, indent=2)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as fh:
            fh.write(payload)
        print(f"review.py: wrote review -> {args.output}", file=sys.stderr)
    else:
        print(payload)
    return 0


if __name__ == "__main__":
    sys.exit(main())
