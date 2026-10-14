"""Pack word-level transcripts into fast editorial cut sheets.

Reads the word JSON produced by ``transcribe.py`` and writes
``takes_packed.md``: timestamped takes (one sentence-ish chunk per line)
that editors and AI agents use to pick viral cuts.
"""

import argparse
import json
import os
import sys

DEFAULT_MAX_WORDS_PER_TAKE = 14
SENTENCE_ENDS = (".", "!", "?", "\u2026")
# A silence gap this long (seconds) always starts a new take, so takes
# never span dead air or segment boundaries.
GAP_SPLIT_SECONDS = 1.5


def _fmt_ts(seconds):
    seconds = max(0.0, float(seconds))
    mins = int(seconds // 60)
    secs = seconds - mins * 60
    return f"{mins:02d}:{secs:05.2f}"


def _start(item):
    try:
        return float(item.get("start", 0.0))
    except (TypeError, ValueError):
        return 0.0


def pack_words(words, max_words=DEFAULT_MAX_WORDS_PER_TAKE):
    """Group word dicts into takes. Returns a list of take dicts."""
    takes = []
    current = []
    for item in words or []:
        if current and _start(item) - _start(current[-1]) > GAP_SPLIT_SECONDS:
            takes.append(_make_take(len(takes) + 1, current))
            current = []
        current.append(item)
        text = (item.get("word") or "").strip()
        boundary = text.endswith(SENTENCE_ENDS)
        if boundary or len(current) >= max_words:
            takes.append(_make_take(len(takes) + 1, current))
            current = []
    if current:
        takes.append(_make_take(len(takes) + 1, current))
    return takes


def _make_take(number, items):
    text = " ".join((w.get("word") or "").strip() for w in items).strip()
    return {
        "take": number,
        "start": float(items[0].get("start", 0.0)),
        "end": float(items[-1].get("end", items[-1].get("start", 0.0))),
        "text": text,
        "word_count": len(items),
    }


def render_markdown(takes, source_name):
    lines = [
        f"# Packed Takes — {source_name}",
        "",
        f"_Takes: {len(takes)}_",
        "",
        "| # | Start | End | Words | Text |",
        "|---|-------|-----|-------|------|",
    ]
    for take in takes:
        text = take["text"].replace("|", "\\|")
        lines.append(
            f"| {take['take']} | {_fmt_ts(take['start'])} | {_fmt_ts(take['end'])} "
            f"| {take['word_count']} | {text} |"
        )
    lines.append("")
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Pack word JSON into takes_packed.md.")
    parser.add_argument("--input", required=True, help="Word-level transcript .json.")
    parser.add_argument("--output", required=True, help="Destination .md file.")
    parser.add_argument("--max-words", type=int, default=DEFAULT_MAX_WORDS_PER_TAKE)
    args = parser.parse_args(argv)

    if not os.path.isfile(args.input):
        print(f"pack_transcripts.py: input not found: {args.input}", file=sys.stderr)
        return 2

    with open(args.input, "r", encoding="utf-8") as fh:
        doc = json.load(fh)

    takes = pack_words(doc.get("words", []), max_words=args.max_words)
    markdown = render_markdown(takes, doc.get("source", os.path.basename(args.input)))
    with open(args.output, "w", encoding="utf-8") as fh:
        fh.write(markdown)
    print(f"pack_transcripts.py: wrote {len(takes)} takes -> {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
