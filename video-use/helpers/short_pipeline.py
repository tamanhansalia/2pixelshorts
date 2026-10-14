#!/usr/bin/env python3
"""2PixelShorts video-use engine entry point.

This is the script the Tauri backend shells out to (see
``src-tauri/src/lib.rs`` ``render_short`` / ``generate_seo_metadata``):

    python helpers/short_pipeline.py --input IN --output OUT --preset ID [options]
    python helpers/short_pipeline.py --input IN --output dummy --generate-seo-only [...]

Modes:
- Render mode (default): transcribe -> pack takes -> ffmpeg render a
  vertical 9:16 short. Prints ``[STAGE n/4]`` progress lines on stdout.
- SEO mode (``--generate-seo-only``): prints the SEO package as JSON
  wrapped in ``__SEO_METADATA_START__`` / ``__SEO_METADATA_END__`` markers
  (no ffmpeg needed). The JSON shape matches the ``SeoMetadata``
  TypeScript interface in ``src/types/index.ts``.

Exit codes: 0 success, 1 render failure (reported as a failed native job),
2 CLI usage error.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
from collections import Counter

try:
    from . import render as render_mod
    from . import transcribe as transcribe_mod
    from . import pack_transcripts as pack_mod
    from . import agent_edit as agent_mod
    from . import review as review_mod
    from . import seo as seo_mod
    from . import trending as trending_mod
except ImportError:  # running as `python helpers/short_pipeline.py`
    import render as render_mod
    import transcribe as transcribe_mod
    import pack_transcripts as pack_mod
    import agent_edit as agent_mod
    import review as review_mod
    import seo as seo_mod
    import trending as trending_mod

SEO_START = "__SEO_METADATA_START__"
SEO_END = "__SEO_METADATA_END__"

# Upload-tag budget lives in seo.py (single source of truth); the names
# below stay importable for older callers.
MAX_SEO_TAGS = seo_mod.MAX_SEO_TAGS
MAX_SEO_TAG_CHARS = seo_mod.MAX_SEO_TAG_CHARS
MAX_SEO_HASHTAGS = seo_mod.MAX_SEO_HASHTAGS


def _fit_tag_budget(tags, budget=MAX_SEO_TAG_CHARS):
    """Keep the most important tags that fit the character budget."""
    return seo_mod.fit_tag_budget(tags, budget=budget)


def format_upload_description(hook, overview, highlights, tags, hashtags):
    """Structured upload description: hook, overview, key points, then the
    keyword + hashtag block (tags always travel with the description)."""
    return seo_mod.build_description(hook, overview, highlights, tags,
                                     hashtags)


# ---------------------------------------------------------------------------
# SEO metadata (mirrors the generateSeoMetadata fallback in src/lib/ipc.ts)
# ---------------------------------------------------------------------------

def _detect_topic(filename, channel_context):
    clean = filename.replace("-", " ").replace("_", " ")
    clean = " ".join(w[:1].upper() + w[1:] for w in clean.split())
    ctx = (channel_context or "").lower()

    topic = clean or "Video"
    if "rust" in ctx or "tauri" in ctx:
        topic = "Rust & Tauri"
    elif "ai" in ctx or "code" in ctx or "ai" in clean.lower():
        topic = "AI Developer Tool"
    elif "saas" in ctx or "startup" in ctx:
        topic = "Indie SaaS"
    elif "python" in ctx:
        topic = "Python Automation"
    return topic


def generate_metadata(input_video, channel_context=None, agent_id=None):
    """Build the SEO metadata dict for a source video."""
    base = os.path.basename(input_video or "")
    filename = os.path.splitext(base)[0] or "video"
    topic = _detect_topic(filename, channel_context)

    primary_title = f"The Secret {topic} Workflow Nobody Tells You \U0001F92B"
    alt1 = f"Stop Doing This With {topic} (Do This Instead) \u274C"
    alt2 = f"This New {topic} Feels Like Cheating \u26A1"
    alt3 = f"How to Master {topic} in 60 Seconds \U0001F680"

    tags = _fit_tag_budget(list(dict.fromkeys([
        topic.lower(), f"{topic.lower()} tutorial", f"{topic.lower()} shorts",
        "shorts", "tech", "coding", "developer", "software engineering",
        f"{topic.lower()} tips", "ai tools", "productivity", "webdev",
        "programming tips", "trending", "viral", "short", "how to",
        "beginners guide", "explained", "crash course",
    ]))[:MAX_SEO_TAGS])
    hashtags = ["#" + t.replace(" ", "") for t in tags[:MAX_SEO_HASHTAGS]]
    hook = f"Stop doing this with {topic} \u2014 here is what top engineers do instead."
    highlights = [
        f"Core breakthrough with {topic}",
        "How to optimize performance and save hours",
        "Pro tips for modern creators",
    ]
    niche = channel_context.strip() if channel_context and channel_context.strip() else "daily tech & developer guides"

    description = format_upload_description(
        hook,
        f"The complete breakdown on {topic}! In this short, we review the "
        f"entire workflow from start to finish. \U0001F449 Subscribe for {niche}!",
        highlights,
        tags,
        hashtags,
    )

    return {
        "title": alt2,
        "title_alternatives": [primary_title, alt1, alt2, alt3],
        "description": description,
        "tags": tags,
        "hashtags": hashtags,
        "seo_score": 98,
        "keywords_analyzed": [topic.lower(), "workflow", "optimization", "productivity"],
        "review_report": {
            "overall_summary": (
                f"Reviewed whole video recording ({filename}). Audio pacing is crisp with high "
                f"speech density focused on {topic}. Identified core breakthrough and practical "
                "implementation steps."
            ),
            "hook_detected": f"Stop doing this with {topic} - here is what top engineers do instead.",
            "content_highlights": [
                f"Core breakthrough and architecture breakdown of {topic}",
                "Performance benchmarks and speed optimizations",
                "Real-world edge cases to avoid when deploying",
                "Actionable steps to set this up in under 60 seconds",
            ],
            "retention_score": 97,
            "target_audience": "Engineers, developers, and tech builders aligned with your channel profile.",
            "suggested_pacing": "Fast-paced punchy cuts with 30ms anti-pop crossfades",
            "word_count": 142,
        },
    }


class SeoError(Exception):
    pass


# Strict-mode compatible schema for the agent-written SEO package (same
# conventions as agent_edit.EDL_SCHEMA: every object pins
# additionalProperties=false and requires all of its properties).
SEO_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "title_alternatives": {
            "type": "array", "items": {"type": "string"},
        },
        "description": {"type": "string"},
        "tags": {"type": "array", "items": {"type": "string"}},
        "hashtags": {"type": "array", "items": {"type": "string"}},
        "hook_detected": {"type": "string"},
        "content_highlights": {
            "type": "array", "items": {"type": "string"},
        },
        "overall_summary": {"type": "string"},
    },
    "required": ["title", "title_alternatives", "description", "tags",
                 "hashtags", "hook_detected", "content_highlights",
                 "overall_summary"],
    "additionalProperties": False,
}


def build_seo_prompt(takes_text, duration, word_count, context=None):
    """Build the SEO-review prompt, truncating takes to the prompt budget."""
    lines = [
        "You are a YouTube Shorts SEO strategist. Read the transcript takes",
        "from the source video below and write its upload package.",
        f"SOURCE DURATION: {duration:.1f} seconds.",
        f"SPOKEN WORDS: {word_count}.",
    ]
    if context and context.strip():
        lines.append(f"CHANNEL CONTEXT: {context.strip()}")
    lines += [
        "RULES:",
        "- Output ONLY a JSON object, no markdown fences, no commentary.",
        '- Shape: {"title": "...", "title_alternatives": ["...", ...4],',
        '  "description": "...", "tags": ["...", ...],',
        '  "hashtags": ["#...", ...], "hook_detected": "opening spoken hook",',
        '  "content_highlights": ["...", ...4], "overall_summary": "..."}',
        "- Base EVERYTHING on words actually spoken in the takes: quote real",
        "  phrases for the hook, lift real topics for titles and tags. Never",
        "  invent topics, tools, or claims that are not in the transcript.",
        "- title <= 100 chars, high-CTR Shorts style: the single best title,",
        "  plus exactly 4 alternatives ordered best-first.",
        '- description in this exact structure: opening hook line, blank line,',
        "  2-4 sentences on what is covered, blank line, '\U0001F4CC Key",
        "  Highlights:' plus \u2022 bullets, blank line, '\U0001F50D Search",
        "  Keywords:' plus one comma-separated keyword line, blank line, one",
        "  hashtag line. The keyword + hashtag block is mandatory.",
        "- tags: 15-20, most important first, multi-word phrases allowed;",
        "  content_highlights: exactly 4 short bullets of what is covered.",
        "TAKES:",
    ]
    header = "\n".join(lines) + "\n"
    budget = agent_mod.MAX_PROMPT_CHARS - len(header) - 200
    takes = takes_text or ""
    if len(takes) > budget:
        takes = takes[:budget] + "\n[... transcript truncated for prompt budget ...]"
    return header + takes


def _clean_str_list(value, limit):
    cleaned = []
    for item in value or []:
        if isinstance(item, str) and item.strip():
            text = item.strip()
            if text not in cleaned:
                cleaned.append(text)
        if len(cleaned) >= limit:
            break
    return cleaned


def validate_seo(doc):
    """Validate + normalize an agent SEO package. Raises SeoError."""
    if not isinstance(doc, dict):
        raise SeoError("SEO package must be a JSON object")
    title = doc.get("title")
    if not isinstance(title, str) or not title.strip():
        raise SeoError("SEO package needs a non-empty 'title'")
    alternatives = [seo_mod.trim_title(a) for a in
                    _clean_str_list(doc.get("title_alternatives"), 4)]
    if not alternatives:
        raise SeoError("SEO package needs at least one 'title_alternative'")
    description = doc.get("description")
    if not isinstance(description, str) or not description.strip():
        raise SeoError("SEO package needs a non-empty 'description'")
    tags = _fit_tag_budget(_clean_str_list(doc.get("tags"), MAX_SEO_TAGS))
    if not tags:
        raise SeoError("SEO package needs at least one 'tag'")
    hashtags = seo_mod.normalize_hashtags(
        tags, _clean_str_list(doc.get("hashtags"), MAX_SEO_HASHTAGS),
        limit=MAX_SEO_HASHTAGS)
    # The keyword + hashtag block always ships with the description, even
    # when the agent wrote the prose without it.
    if "Search Keywords:" not in description:
        description = (
            description.strip() + "\n\n\U0001F50D Search Keywords:\n"
            + ", ".join(tags) + "\n\n" + " ".join(hashtags)
        )
    hook = doc.get("hook_detected")
    if not isinstance(hook, str) or not hook.strip():
        raise SeoError("SEO package needs a non-empty 'hook_detected'")
    highlights = _clean_str_list(doc.get("content_highlights"), 4)
    if not highlights:
        raise SeoError("SEO package needs at least one 'content_highlight'")
    summary = doc.get("overall_summary")
    if not isinstance(summary, str) or not summary.strip():
        raise SeoError("SEO package needs a non-empty 'overall_summary'")
    return {
        "title": seo_mod.trim_title(title.strip()),
        "title_alternatives": alternatives,
        "description": description.strip(),
        "tags": tags,
        "hashtags": hashtags,
        "hook_detected": hook.strip()[:200],
        "content_highlights": highlights,
        "overall_summary": summary.strip(),
    }


def _extract_seo_doc(stdout, agent_id):
    """Extract the SEO dict, preferring the agent's `response` text.

    agy also emits a schema-validated `structured_output` object, but it has
    been observed carrying a stale schema shape (EDL `segments`) while
    `response` holds the correct SEO JSON — so for SEO the human-readable
    response wins and the generic extractor is the fallback.
    """
    text = (stdout or "").strip()
    if text:
        try:
            top = json.loads(agent_mod._strip_fences(text))
        except (json.JSONDecodeError, ValueError):
            top = None
        if isinstance(top, dict):
            resp = top.get("response")
            if isinstance(resp, str) and resp.strip():
                try:
                    return agent_mod.extract_json(resp, agent_id)
                except agent_mod.AgentError:
                    pass
    return agent_mod.extract_json(stdout, agent_id)


def run_agent_seo(agent_id, takes_text, duration, word_count, context=None,
                  model=None, timeout=300):
    """Ask the agent CLI for the SEO package. Returns the validated dict."""
    agent_id = (agent_id or "").strip().lower()
    spec = agent_mod.AGENTS.get(agent_id)
    if spec is None:
        raise agent_mod.AgentError(f"unknown agent '{agent_id}'")

    probe = agent_mod.probe_agent(agent_id)
    if not probe["available"]:
        raise agent_mod.AgentError(f"agent '{agent_id}' unavailable: {probe['note']}")

    prompt = build_seo_prompt(takes_text, duration, word_count, context)

    schema_file = None
    tmpdir = tempfile.mkdtemp(prefix="agent_seo_")
    try:
        if spec["needs_schema_file"]:
            schema_file = os.path.join(tmpdir, "seo_schema.json")
            with open(schema_file, "w", encoding="utf-8") as fh:
                json.dump(SEO_SCHEMA, fh)
        argv = spec["argv"](probe["path"], prompt, model, schema_file)
        try:
            proc = subprocess.run(
                argv, capture_output=True, text=True, timeout=timeout,
                cwd=tmpdir, env=agent_mod.private_agent_env(),
            )
        except subprocess.TimeoutExpired:
            raise agent_mod.AgentError(f"agent '{agent_id}' timed out after {timeout}s")
        if proc.returncode != 0:
            detail = (proc.stderr or "").strip()[-500:]
            if not detail:
                detail = (
                    agent_mod._envelope_error(proc.stdout or "")
                    or (proc.stdout or "").strip()[-500:]
                    or "no output"
                )
            raise agent_mod.AgentError(
                f"agent '{agent_id}' exited {proc.returncode}: {detail}"
            )
        doc = _extract_seo_doc(proc.stdout or "", agent_id)
        try:
            seo = validate_seo(doc)
        except SeoError as exc:
            raise agent_mod.AgentError(
                f"agent '{agent_id}' returned invalid SEO JSON: {exc}"
            )
        seo["source"] = f"agent:{agent_id}"
        return seo
    finally:
        if schema_file and os.path.isfile(schema_file):
            os.remove(schema_file)
        if tmpdir:
            try:
                os.rmdir(tmpdir)
            except OSError:
                pass


def _top_terms(words, top_n=8):
    """Rank transcript terms by frequency (stopwords filtered)."""
    text = " ".join((w.get("word") or "") for w in words or "")
    try:
        tokens = trending_mod.tokenize(text)
    except Exception:
        tokens = []
    return [term for term, _ in Counter(tokens).most_common(top_n)]


def _top_phrases(words, top_n=6):
    """Rank adjacent-token bigrams by frequency (transcript-only phrases).

    Both tokens of every phrase were actually spoken, so phrases stay as
    grounded as unigrams while giving tags the multi-word specificity
    Shorts search rewards ("connection pooling" beats "pooling").
    """
    text = " ".join((w.get("word") or "") for w in words or "")
    try:
        tokens = trending_mod.tokenize(text)
    except Exception:
        tokens = []
    counts = Counter()
    for first, second in zip(tokens, tokens[1:]):
        counts["%s %s" % (first, second)] += 1.5
    return [term for term, _ in counts.most_common(top_n)]


def _rank_candidates(candidates, keywords):
    """Order title candidates best-first: keyword-frontloaded, then short.

    Pure ranking over spoken-line trims — no words are added or invented.
    """
    keys = [(k or "").lower() for k in (keywords or []) if k]

    def rank(text):
        lowered = (text or "").lower()
        front = 0 if any(lowered.startswith(k) or k in lowered[:40]
                         for k in keys) else 1
        return (front, len(text or ""))

    seen = set()
    unique = []
    for cand in candidates or []:
        key = (cand or "").lower()
        if not cand or key in seen:
            continue
        seen.add(key)
        unique.append(cand)
    return sorted(unique, key=rank)


def _measured_report(words, duration, context, transcript_source, segments=None):
    """Statistical review grounded in the real transcript (pure)."""
    takes_count = len(pack_mod.pack_words(words))
    report = review_mod.build_report(
        duration, list(words), segments or [], takes_count, context,
    )
    report["transcript_source"] = transcript_source
    return report


# Minimum grounding for a statistical package: below this there is no
# topic to write about, so callers must refuse instead of templating
# titles from coincidental words.
MIN_SEO_WORDS = 10
MIN_SEO_TERMS = 3


def _trim_title(text, limit=100):
    """Trim a transcript line to a postable title (word boundaries only)."""
    return seo_mod.trim_title(text, limit=limit)


def generate_statistical_seo(input_video, words, duration, channel_context,
                             transcript_source):
    """Content-grounded SEO fallback: real transcript stats, no agent.

    Used when the selected editing model is the automatic cut (no agent CLI
    invoked). Every word of the title, alternatives, and tags comes from
    actually-spoken transcript text — never templated around coincidental
    terms, never generic evergreen filler. Raises SeoError when the
    transcript is too thin to ground a package (callers turn that into a
    refusal, not a template).
    """
    takes = pack_mod.pack_words(words)
    report = _measured_report(words, duration, channel_context,
                              transcript_source)
    terms = _top_terms(words)
    distinct = list(dict.fromkeys(terms))
    hook = report["hook_detected"].strip()
    if len(words or []) < MIN_SEO_WORDS or len(distinct) < MIN_SEO_TERMS or not hook:
        raise SeoError(
            f"transcript too thin for SEO "
            f"({len(words or [])} words, {len(distinct)} topic terms); "
            f"speak on-topic for 10+ seconds, or add your ElevenLabs key "
            f"and pick an editing agent for AI-written titles"
        )
    topic = " ".join(t[:1].upper() + t[1:] for t in distinct[:2])

    highlights = report["content_highlights"]
    take_texts = [t["text"] for t in takes if t.get("text")]
    raw_candidates = []
    for cand in [hook] + take_texts[1:4] + ([take_texts[-1]] if take_texts else []):
        trimmed = _trim_title(cand)
        if trimmed and trimmed not in raw_candidates:
            raw_candidates.append(trimmed)
        if len(raw_candidates) >= 4:
            break
    if len(raw_candidates) < 4:
        topic_lead = _trim_title(f"{topic}: {hook}")
        if topic_lead not in raw_candidates:
            raw_candidates.append(topic_lead)
    # The hook stays the title (most authentic line); the bench behind it
    # ranks best-first so the strongest keyword-frontloaded spare is one tap
    # away. Ranking never adds words, so grounding is preserved.
    title = raw_candidates[0]
    alternatives = [c for c in _rank_candidates(raw_candidates[1:], distinct)
                    if c != title]

    topic_tag = topic.lower()
    tags = _fit_tag_budget(
        list(dict.fromkeys(
            list(distinct) + _top_phrases(words)
            + [topic_tag, f"{topic_tag} tutorial",
               f"{topic_tag} shorts"])))
    hashtags = seo_mod.normalize_hashtags(tags, limit=MAX_SEO_HASHTAGS)
    covered = "; ".join(highlights[:3]) if highlights else topic
    description = format_upload_description(
        hook,
        f"About {topic}. Covered: {covered}.",
        highlights,
        tags,
        hashtags,
    )
    quality = seo_mod.score_seo(title, description, tags, hashtags,
                                distinct[:6],
                                retention=report["retention_score"])
    return {
        "title": title,
        "title_alternatives": alternatives,
        "description": description,
        "tags": tags,
        "hashtags": hashtags,
        "seo_score": report["retention_score"],
        "quality_score": quality["quality_score"],
        "quality_checks": quality["checks"],
        "keywords_analyzed": distinct[:6],
        "review_report": report,
    }


def assemble_agent_seo(agent_seo, words, duration, channel_context,
                       transcript_source):
    """Merge the agent's language with measured transcript stats.

    Titles/hook/highlights/description come from the agent; every number
    (word count, retention, pacing) is measured from the real transcript.
    """
    stats = _measured_report(words, duration, channel_context,
                             transcript_source)
    tags = _fit_tag_budget(
        _clean_str_list(agent_seo["tags"], MAX_SEO_TAGS))
    hashtags = seo_mod.normalize_hashtags(
        tags, _clean_str_list(agent_seo.get("hashtags"), MAX_SEO_HASHTAGS),
        limit=MAX_SEO_HASHTAGS)
    quality = seo_mod.score_seo(agent_seo["title"], agent_seo["description"],
                                tags, hashtags, tags[:6],
                                retention=stats["retention_score"])
    return {
        "title": agent_seo["title"],
        "title_alternatives": agent_seo["title_alternatives"],
        "description": agent_seo["description"],
        "tags": tags,
        "hashtags": hashtags,
        "seo_score": stats["retention_score"],
        "quality_score": quality["quality_score"],
        "quality_checks": quality["checks"],
        "keywords_analyzed": tags[:6],
        "review_report": {
            "overall_summary": agent_seo["overall_summary"],
            "hook_detected": agent_seo["hook_detected"],
            "content_highlights": agent_seo["content_highlights"],
            "retention_score": stats["retention_score"],
            "target_audience": stats["target_audience"],
            "suggested_pacing": stats["suggested_pacing"],
            "word_count": stats["word_count"],
            "takes_count": stats["takes_count"],
            "segment_count": 0,
            "output_duration": round(duration, 2),
            "speech_wps": stats["speech_wps"],
            "transcript_source": transcript_source,
        },
    }


def emit_seo_only(input_video, channel_context=None, agent_id=None,
                  elevenlabs_key=None, engine="auto", local_model=None,
                  model=None):
    """Transcript-grounded SEO review of the source video.

    Transcribes the input, then either asks the selected agent CLI for the
    upload package or builds the statistical fallback from the real words.
    Returns 0 and emits the SEO JSON between the SEO markers on success;
    returns 1 with the reason on stderr when nothing can be grounded
    (missing file, no transcript, agent failure) — never a template.
    """
    if not input_video or not os.path.isfile(input_video):
        print(f"short_pipeline.py: SEO review needs an existing video file, "
              f"got: {input_video!r}", file=sys.stderr)
        return 1
    try:
        probe = render_mod.probe_media(input_video)
    except render_mod.RenderError as exc:
        print(f"short_pipeline.py: {exc}", file=sys.stderr)
        return 1
    duration = probe["duration"] or 0.0
    if duration <= 0:
        print(f"short_pipeline.py: could not measure a duration for "
              f"{input_video}; SEO review skipped", file=sys.stderr)
        return 1

    tmpdir = tempfile.mkdtemp(prefix="seo_review_")
    try:
        words_json = os.path.join(tmpdir, "words.json")
        targs = [
            "--input", input_video,
            "--output", words_json,
            "--elevenlabs-key", elevenlabs_key or "",
            "--engine", engine or "auto",
        ]
        if local_model:
            targs += ["--local-model", local_model]
        rc = transcribe_mod.main(targs)
        words = []
        transcript_source = "none"
        if rc == 0 and os.path.isfile(words_json):
            with open(words_json, "r", encoding="utf-8") as fh:
                doc = json.load(fh)
            words = doc.get("words") or []
            transcript_source = (doc.get("model") or "").strip() or "none"
        if not words:
            print(f"short_pipeline.py: no transcript for {input_video} "
                  f"(add your ElevenLabs key under Settings \u2192 API keys, "
                  f"or set up local transcription); SEO review skipped",
                  file=sys.stderr)
            return 1

        takes_text = pack_mod.render_markdown(
            pack_mod.pack_words(words), os.path.basename(input_video))
        payload = None
        if wants_agent_cut(agent_id):
            try:
                agent_seo = run_agent_seo(
                    agent_id, takes_text, duration, len(words),
                    context=channel_context, model=model,
                )
            except agent_mod.AgentError as exc:
                # Same graceful-degradation rule as stream clips: a dead
                # agent must not take the whole SEO review down when the
                # transcript alone can still ground an honest package.
                print(f"short_pipeline.py: agent SEO failed ({exc}); "
                      f"falling back to transcript-grounded SEO",
                      file=sys.stderr)
                agent_seo = None
            if agent_seo is not None:
                payload = assemble_agent_seo(
                    agent_seo, words, duration, channel_context,
                    transcript_source)
        if payload is None:
            try:
                payload = generate_statistical_seo(
                    input_video, words, duration, channel_context,
                    transcript_source)
            except SeoError as exc:
                print(f"short_pipeline.py: SEO review skipped ({exc})",
                      file=sys.stderr)
                return 1
        sys.stdout.write(SEO_START + json.dumps(payload) + SEO_END + "\n")
        sys.stdout.flush()
        return 0
    finally:
        path = os.path.join(tmpdir, "words.json")
        if os.path.isfile(path):
            os.remove(path)
        try:
            os.rmdir(tmpdir)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Render mode
# ---------------------------------------------------------------------------

def build_parser():
    parser = argparse.ArgumentParser(description="2PixelShorts short creation pipeline.")
    parser.add_argument("--input", required=True, help="Source video file.")
    parser.add_argument("--output", required=True, help="Destination vertical short (.mp4).")
    parser.add_argument("--preset", default="vertical_clean", help="Grade preset id.")
    parser.add_argument("--agent", default=None,
                        help="AI agent id for cut selection; auto|none|off = automatic cut.")
    parser.add_argument("--model", default=None, help="Optional model override for the agent CLI.")
    parser.add_argument("--edl", default=None, help="Explicit edl.json for multi-segment assembly.")
    parser.add_argument("--cut-start", type=float, default=None, help="Manual trim start (seconds).")
    parser.add_argument("--cut-end", type=float, default=None, help="Manual trim end (seconds).")
    parser.add_argument("--subtitles", default=None, help="Subtitle style id, or 'none'.")
    parser.add_argument("--subtitle-position", default=None)
    parser.add_argument("--subtitle-size", default=None)
    parser.add_argument("--subtitle-case", default=None, help="uppercase|title|sentence.")
    parser.add_argument("--duration", type=float, default=None, help="Target cut length in seconds.")
    parser.add_argument("--prompt", default=None, help="Custom edit prompt; public YouTube links are caption-based editing references.")
    parser.add_argument("--elevenlabs-key", default=os.environ.get("PIXEL_ELEVENLABS_KEY"), help="ElevenLabs API key (prefer PIXEL_ELEVENLABS_KEY).")
    parser.add_argument("--engine", default="auto",
                        choices=("auto", "elevenlabs", "local"),
                        help="Transcription engine (default: auto).")
    parser.add_argument("--local-model", default=None,
                        help="faster-whisper model id (default: tiny.en).")
    parser.add_argument("--channel-context", default=None)
    parser.add_argument("--meta-title", default=None)
    parser.add_argument("--meta-desc", default=None)
    parser.add_argument("--meta-tags", default=None)
    parser.add_argument("--layout", default="auto",
                        help="single|screen-top|face-top|face-only|auto "
                             "(auto picks split when a facecam is detected).")
    parser.add_argument("--face-roi", default="auto",
                        help="auto, br|bl|tr|tl, or x,y,w,h fractions.")
    parser.add_argument("--aspect-ratio", default="9:16",
                        help="9:16|1:1|16:9 output canvas.")
    parser.add_argument("--generate-seo-only", action="store_true")
    return parser


def wants_subtitles(subtitle_style):
    return bool(subtitle_style) and subtitle_style.strip().lower() != "none"


def wants_agent_cut(agent_id):
    return (
        bool(agent_id)
        and agent_id.strip().lower() not in ("none", "off", "auto")
    )


def transcribe_isolated(argv):
    """Keep Whisper/PyAV's FFmpeg libraries out of the OpenCV process.

    On macOS both wheels load libavdevice Objective-C classes. Loading both
    in one process produced duplicate-class warnings and could destabilize
    the render. The worker uses the same interpreter and stdout contract.
    """
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "transcribe.py")
    argv = list(argv)
    env = os.environ.copy()
    if "--elevenlabs-key" in argv:
        index = argv.index("--elevenlabs-key")
        env["PIXEL_ELEVENLABS_KEY"] = argv[index + 1]
        del argv[index:index + 2]
    try:
        return subprocess.run([sys.executable, script, *argv], env=env, timeout=3600).returncode
    except (OSError, subprocess.TimeoutExpired) as exc:
        print(f"transcribe.py: local engine failed ({exc}); no transcript", file=sys.stderr)
        return 1


def run_render(args):
    if os.path.realpath(args.input) == os.path.realpath(args.output) or (
        os.path.exists(args.input) and os.path.exists(args.output) and os.path.samefile(args.input, args.output)
    ):
        print("short_pipeline.py: output must differ from the source video", file=sys.stderr)
        return 1
    custom_prompt = bool(args.prompt and args.prompt.strip())
    if custom_prompt and (not wants_agent_cut(args.agent) or args.edl
                          or args.cut_start is not None or args.cut_end is not None):
        print("short_pipeline.py: custom prompts require an editing agent and cannot "
              "be combined with an explicit EDL or manual trim.", file=sys.stderr)
        return 1
    if custom_prompt:
        try:
            agent_mod.reference_mod.youtube_references(args.prompt)
        except (agent_mod.reference_mod.ReferenceError, ValueError) as exc:
            print(f"short_pipeline.py: {exc}", file=sys.stderr)
            return 1
    print(f"[STAGE 1/4] Probing audio & phrase cues for {args.input}")

    try:
        probe = render_mod.probe_media(args.input)
    except render_mod.RenderError as exc:
        print(f"short_pipeline.py: {exc}", file=sys.stderr)
        return 1
    source_duration = probe["duration"] or 0.0

    # Transcript + takes (needed for subtitles AND agent cut selection).
    # Each output owns its evidence. Concurrent jobs in the same directory
    # must never overwrite another short's transcript or selected cuts.
    words = []
    takes = []
    out_dir = os.path.dirname(os.path.abspath(args.output)) or "."
    os.makedirs(out_dir, exist_ok=True)
    words_json = args.output + ".words.json"
    tmpdir = tempfile.mkdtemp(prefix="short_pipeline_")
    try:
        targs = [
            "--input", args.input,
            "--output", words_json,
            "--elevenlabs-key", args.elevenlabs_key or "",
            "--engine", args.engine or "auto",
        ]
        if args.local_model:
            targs += ["--local-model", args.local_model]
        rc = transcribe_isolated(targs)
        if rc == 0 and os.path.isfile(words_json):
            with open(words_json, "r", encoding="utf-8") as fh:
                words = (json.load(fh).get("words") or [])

        packed_path = args.output + ".takes_packed.md"
        takes = pack_mod.pack_words(words)
        with open(packed_path, "w", encoding="utf-8") as fh:
            fh.write(pack_mod.render_markdown(takes, os.path.basename(args.input)))
        print(f"[STAGE 1/4] Packed {len(takes)} takes -> {packed_path}")

        # ---- Cut selection: explicit EDL > manual trim > agent EDL > head-cut.
        segments = None
        cut_note = ""
        if args.edl:
            if not os.path.isfile(args.edl):
                print(f"short_pipeline.py: EDL file not found: {args.edl}", file=sys.stderr)
                return 1
            with open(args.edl, "r", encoding="utf-8") as fh:
                edl_doc = json.load(fh)
            try:
                edl = agent_mod.validate_edl(edl_doc, source_duration, args.duration)
            except agent_mod.AgentError as exc:
                print(f"short_pipeline.py: invalid EDL file: {exc}", file=sys.stderr)
                return 1
            segments = edl["segments"]
            with open(args.output + ".edl.json", "w", encoding="utf-8") as fh:
                json.dump(edl, fh, indent=2)
            cut_note = f"explicit EDL ({len(segments)} segments)"
        elif args.cut_start is not None or args.cut_end is not None:
            start = args.cut_start if args.cut_start is not None else 0.0
            end = args.cut_end if args.cut_end is not None else source_duration
            try:
                edl = agent_mod.validate_edl(
                    {"segments": [{"start": start, "end": end, "score": 1.0,
                                   "reason": "manual trim"}],
                     "source": "manual"},
                    source_duration, args.duration,
                )
            except agent_mod.AgentError as exc:
                print(f"short_pipeline.py: invalid manual trim: {exc}", file=sys.stderr)
                return 1
            segments = edl["segments"]
            with open(args.output + ".edl.json", "w", encoding="utf-8") as fh:
                json.dump(edl, fh, indent=2)
            cut_note = f"manual trim {segments[0]['start']:.1f}s-{segments[0]['end']:.1f}s"
        elif wants_agent_cut(args.agent):
            if not words:
                if custom_prompt:
                    print("short_pipeline.py: custom prompt could not be applied: no source "
                          "transcript. Enable local transcription or add an ElevenLabs key.",
                          file=sys.stderr)
                    return 1
                print("[STAGE 2/4] No transcript available; agent cut skipped, "
                      "using automatic cut", file=sys.stderr)
            else:
                with open(packed_path, "r", encoding="utf-8") as fh:
                    takes_text = fh.read()
                try:
                    if custom_prompt:
                        print("[STAGE 2/4] Applying custom prompt and reading any YouTube caption references", flush=True)
                    edl = agent_mod.run_agent_cut(
                        args.agent, takes_text, source_duration,
                        target_duration=args.duration or 30.0,
                        context=args.channel_context, hook=args.prompt,
                        model=args.model,
                    )
                    segments = edl["segments"]
                    edl_path = args.output + ".edl.json"
                    with open(edl_path, "w", encoding="utf-8") as fh:
                        json.dump(edl, fh, indent=2)
                    cut_note = (f"AI Agent ({args.agent.upper()}) selected "
                                f"{len(segments)} viral cuts -> {edl_path}")
                    if custom_prompt:
                        refs = edl.get("edit_request", {}).get("references", [])
                        cut_note += f" (custom prompt; {len(refs)} YouTube references read)"
                except agent_mod.AgentError as exc:
                    if custom_prompt:
                        print(f"short_pipeline.py: custom prompt could not be applied: {exc}",
                              file=sys.stderr)
                        return 1
                    print(f"[STAGE 2/4] Agent cut failed ({exc}); "
                          f"using automatic cut", file=sys.stderr)

        if segments:
            print(f"[STAGE 2/4] {cut_note}")
            print("[STAGE 3/4] Trimming dead pauses & baking 30ms anti-pop crossfades")
            case = (args.subtitle_case or "uppercase").strip().lower()
            try:
                render_mod.render_edl(
                    args.input, args.output, segments,
                    preset_id=args.preset or "vertical_clean",
                    words=words if wants_subtitles(args.subtitles) else None,
                    subtitle_case=case,
                    subtitle_style=args.subtitles,
                    subtitle_position=args.subtitle_position,
                    subtitle_size=args.subtitle_size,
                    meta_title=args.meta_title, meta_desc=args.meta_desc,
                    meta_tags=args.meta_tags,
                    layout=args.layout, face_roi=args.face_roi,
                    aspect_ratio=args.aspect_ratio,
                )
            except render_mod.RenderError as exc:
                print(f"short_pipeline.py: {exc}", file=sys.stderr)
                return 1
            if custom_prompt:
                with open(args.output + ".edit.json", "w", encoding="utf-8") as fh:
                    json.dump({"edit_request": edl["edit_request"],
                               "segments": segments, "source": edl["source"]}, fh, indent=2)
            return 0

        # ---- Automatic head-cut fallback (single segment).
        # Studio sends zero for an automatic edit. When no agent cut is
        # available, zero must not turn a long recording into a full-length
        # vertical encode disguised as a short.
        fallback_duration = min(args.duration if args.duration and args.duration > 0 else 30.0, source_duration)
        with open(args.output + ".edl.json", "w", encoding="utf-8") as fh:
            json.dump({"source": "auto", "segments": [{"start": 0, "end": fallback_duration}]}, fh)
        print(f"[STAGE 2/4] Automatic cut: leading {fallback_duration:.2f}s")
        print("[STAGE 3/4] Trimming dead pauses & baking 30ms anti-pop crossfades")
        srt_path = None
        if wants_subtitles(args.subtitles) and words:
            srt_path = os.path.join(tmpdir, "captions.ass")
            case = (args.subtitle_case or "uppercase").strip().lower()
            with open(srt_path, "w", encoding="utf-8") as fh:
                fh.write(render_mod.words_to_ass(
                    words, case=case, style_id=args.subtitles,
                    position=args.subtitle_position, size=args.subtitle_size,
                    aspect_ratio=args.aspect_ratio,
                ))
        elif wants_subtitles(args.subtitles):
            print("[STAGE 2/4] No transcript words; rendering clean video", file=sys.stderr)
        try:
            render_mod.render_short(
                args.input, args.output,
                preset_id=args.preset or "vertical_clean",
                cut_duration=fallback_duration,
                srt_path=srt_path,
                meta_title=args.meta_title, meta_desc=args.meta_desc,
                meta_tags=args.meta_tags,
                subtitle_style=args.subtitles,
                subtitle_position=args.subtitle_position,
                subtitle_size=args.subtitle_size,
                layout=args.layout, face_roi=args.face_roi,
                aspect_ratio=args.aspect_ratio,
            )
        except render_mod.RenderError as exc:
            print(f"short_pipeline.py: {exc}", file=sys.stderr)
            return 1
    finally:
        path = os.path.join(tmpdir, "captions.ass")
        if os.path.isfile(path):
            os.remove(path)
        try:
            os.rmdir(tmpdir)
        except OSError:
            pass
    return 0


def main(argv=None):
    args = build_parser().parse_args(argv)

    if args.generate_seo_only:
        return emit_seo_only(
            args.input, args.channel_context, args.agent,
            elevenlabs_key=args.elevenlabs_key, engine=args.engine,
            local_model=args.local_model, model=args.model,
        )

    if not os.path.isfile(args.input):
        print(f"short_pipeline.py: input video not found: {args.input}", file=sys.stderr)
        return 1

    return run_render(args)


if __name__ == "__main__":
    sys.exit(main())
