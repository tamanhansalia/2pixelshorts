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
import re
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
    from . import transcript_edit as edit_mod
    from . import automatic_edit as auto_mod
except ImportError:  # running as `python helpers/short_pipeline.py`
    import render as render_mod
    import transcribe as transcribe_mod
    import pack_transcripts as pack_mod
    import agent_edit as agent_mod
    import review as review_mod
    import seo as seo_mod
    import trending as trending_mod
    import transcript_edit as edit_mod
    import automatic_edit as auto_mod

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


def format_upload_description(hook, overview, highlights, hashtags, cta=None):
    """Upload description with the hook + payoff above the fold and the
    hashtag line closing it out (see seo.build_description)."""
    return seo_mod.build_description(hook, overview, highlights, hashtags,
                                     cta=cta)


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
        "search_queries": {"type": "array", "items": {"type": "string"}},
        "pinned_comment": {"type": "string"},
        "hook_detected": {"type": "string"},
        "content_highlights": {
            "type": "array", "items": {"type": "string"},
        },
        "overall_summary": {"type": "string"},
    },
    "required": ["title", "title_alternatives", "description", "tags",
                 "hashtags", "search_queries", "pinned_comment",
                 "hook_detected", "content_highlights", "overall_summary"],
    "additionalProperties": False,
}

# Prompt-side caps for the optional market signals.
MAX_PROMPT_SIGNALS = 10


def _signal_lines(label, items, explain):
    items = [i.strip() for i in (items or []) if isinstance(i, str) and i.strip()]
    if not items:
        return []
    return [f"{label} ({explain}):"] + [
        f"- {i[:120]}" for i in items[:MAX_PROMPT_SIGNALS]
    ]


def build_seo_prompt(takes_text, duration, word_count, context=None,
                     search_queries=None, trend_terms=None,
                     winning_titles=None):
    """Build the SEO-review prompt, truncating takes to the prompt budget.

    ``search_queries`` are real autocomplete phrases, ``trend_terms`` come
    from fast-rising Shorts in the niche, and ``winning_titles`` are this
    channel's own best performers. All three are hints: the agent may only
    use one when the transcript actually covers it.
    """
    lines = [
        "You are a YouTube Shorts packaging strategist. Read the transcript",
        "takes from the source video below and write its upload package.",
        f"SOURCE DURATION: {duration:.1f} seconds.",
        f"SPOKEN WORDS: {word_count}.",
    ]
    if context and context.strip():
        lines.append(f"CHANNEL CONTEXT: {context.strip()}")
    lines += _signal_lines(
        "REAL SEARCH QUERIES", search_queries,
        "what people type into YouTube search; aim at one the video covers")
    lines += _signal_lines(
        "TRENDING TERMS", trend_terms,
        "words in fast-rising Shorts in this niche; use only if spoken")
    lines += _signal_lines(
        "TITLES THAT WORKED ON THIS CHANNEL", winning_titles,
        "match their style and specificity, never copy the topic")
    lines += [
        "RULES:",
        "- Output ONLY a JSON object, no markdown fences, no commentary.",
        '- Shape: {"title": "...", "title_alternatives": ["...", ...4],',
        '  "description": "...", "tags": ["...", ...],',
        '  "hashtags": ["#...", ...], "search_queries": ["...", ...3],',
        '  "pinned_comment": "...", "hook_detected": "opening spoken hook",',
        '  "content_highlights": ["...", ...4], "overall_summary": "..."}',
        "- Base EVERYTHING on words actually spoken in the takes: quote real",
        "  phrases for the hook, lift real topics for titles and tags. Never",
        "  invent topics, tools, numbers, or claims that are not in the",
        "  transcript.",
        "- search_queries: the 3 searches this short should win, written the",
        "  way a real person types them (lowercase, 2-5 words).",
        "- title: a complete thought, 40-60 characters (hard limit 100).",
        "  Never a cut-off spoken line or a trailing comma. Put the subject",
        "  in the first three words, carry the words of the top search query,",
        "  and prefer a concrete number, name or result over hype words",
        "  (insane, best, secret, ultimate). At most two ALL-CAPS words.",
        "  Plus exactly 4 alternatives ordered best-first, each a different",
        "  complete angle.",
        "- description: line 1 is the hook, line 2 says what the viewer gets",
        "  in the words of the search queries (these two lines are all most",
        "  people see). Then a blank line and up to 4 \u2022 bullets of what",
        "  is covered, then one call to action line, then a blank line and",
        "  the hashtag line. NO keyword lists and no 'Search Keywords' block.",
        "- tags: 5-15, most important first: tool names, spellings and",
        "  abbreviations people actually type. No unrelated or generic tags",
        "  (viral, trending, shorts).",
        "- hashtags: 3-5 specific ones, most important first.",
        "- pinned_comment: one short question that invites viewers to reply",
        "  about the topic (no links, no self-promotion).",
        "- content_highlights: exactly 4 short bullets of what is covered.",
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


def _finish_description(description, hashtags):
    """Strip any keyword-stuffing block and make sure hashtags close it."""
    text = seo_mod.strip_keyword_block(description)
    if hashtags and not any(h in text for h in hashtags[:3]):
        text = text.rstrip() + "\n\n" + " ".join(hashtags)
    return text.strip()


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
    description = _finish_description(description, hashtags)
    hook = doc.get("hook_detected")
    if not isinstance(hook, str) or not hook.strip():
        raise SeoError("SEO package needs a non-empty 'hook_detected'")
    highlights = _clean_str_list(doc.get("content_highlights"), 4)
    if not highlights:
        raise SeoError("SEO package needs at least one 'content_highlight'")
    summary = doc.get("overall_summary")
    if not isinstance(summary, str) or not summary.strip():
        raise SeoError("SEO package needs a non-empty 'overall_summary'")
    # Queries and the pinned comment are optional extras: older agents
    # (and non-strict CLIs) may omit them without failing the package.
    queries = seo_mod.clean_search_queries(doc.get("search_queries"))
    pinned = doc.get("pinned_comment")
    pinned = pinned.strip()[:500] if isinstance(pinned, str) else ""
    return {
        "title": seo_mod.trim_title(title.strip()),
        "title_alternatives": alternatives,
        "description": description,
        "tags": tags,
        "hashtags": hashtags,
        "search_queries": queries,
        "pinned_comment": pinned,
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
                  model=None, timeout=300, signals=None):
    """Ask the agent CLI for the SEO package. Returns the validated dict.

    ``signals`` optionally carries ``search_queries``, ``trend_terms`` and
    ``winning_titles`` for the prompt (see build_seo_prompt).
    """
    agent_id = (agent_id or "").strip().lower()
    spec = agent_mod.AGENTS.get(agent_id)
    if spec is None:
        raise agent_mod.AgentError(f"unknown agent '{agent_id}'")

    probe = agent_mod.probe_agent(agent_id)
    if not probe["available"]:
        raise agent_mod.AgentError(f"agent '{agent_id}' unavailable: {probe['note']}")

    signals = signals or {}
    prompt = build_seo_prompt(
        takes_text, duration, word_count, context,
        search_queries=signals.get("search_queries"),
        trend_terms=signals.get("trend_terms"),
        winning_titles=signals.get("winning_titles"),
    )

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
                argv, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
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


# Spoken filler that survives the stopword list but makes useless tags
# and hashtags (#end, #add). Topic words are never in here.
WEAK_SEO_TERMS = frozenset(
    """
    add end thing things stuff yeah yes okay gonna wanna want something kind lot
    put take care exist give need know think say said look going come
    right sure maybe guess mean basically literally actually start
    sir please hey hi um uh wait hmm huh yup yep
    """.split()
)

# Discourse leftovers that make a useless search ("open sir", "okay want")
# even when they survive the stopword list. A phrase still counts when it
# also carries a real topic word ("open terminal", "spawn muse").
QUERY_NOISE = frozenset(
    """
    sir okay please yeah yes hey hi um uh wait hmm huh yup yep oh ah
    """.split()
)


def _content_tokens(tokens):
    """Topic words a viewer might actually type (filler stripped)."""
    out = []
    for raw in tokens or []:
        tok = (raw or "").lower()
        if (len(tok) >= 3 and tok not in trending_mod.STOPWORDS
                and tok not in WEAK_SEO_TERMS and tok not in QUERY_NOISE):
            out.append(tok)
    return out


def _seo_tokens(words):
    text = " ".join((w.get("word") or "") for w in words or "")
    try:
        tokens = trending_mod.tokenize(text)
    except Exception:
        tokens = []
    return tokens


def _top_terms(words, top_n=8):
    """Rank transcript terms by frequency (stopwords + filler filtered)."""
    tokens = [t for t in _seo_tokens(words) if t not in WEAK_SEO_TERMS]
    return [term for term, _ in Counter(tokens).most_common(top_n)]


def _top_phrases(words, top_n=6):
    """Rank adjacent-token bigrams by frequency (transcript-only phrases).

    Both tokens of every phrase were actually spoken, so phrases stay as
    grounded as unigrams while giving tags the multi-word specificity
    Shorts search rewards ("connection pooling" beats "pooling").
    """
    tokens = _seo_tokens(words)
    counts = Counter()
    for first, second in zip(tokens, tokens[1:]):
        # Both tokens must be topic words: "open sir" / "end add" drop.
        if first == second or len(_content_tokens([first, second])) < 2:
            continue
        counts["%s %s" % (first, second)] += 1.5
    return [term for term, _ in counts.most_common(top_n)]


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


_SPOKEN_WORD = re.compile(r"[a-z0-9]+")


def _is_searchable_query(text):
    """True when every non-stopword is a real topic word (no 'open sir')."""
    tokens = _SPOKEN_WORD.findall((text or "").lower())
    topical = [t for t in tokens if t not in trending_mod.STOPWORDS]
    content = _content_tokens(tokens)
    return len(content) >= 1 and content == topical


def _grounded_queries(words, candidates, fallback):
    """Search queries the transcript can honestly win.

    External candidates (autocomplete) only survive when EVERY content
    word was spoken (the no-agent package has no judgement to add a word
    like "contribution"); the transcript's own phrases fill the rest.
    Filler bigrams ("open sir") are dropped even if they were spoken.
    """
    # Raw words, not tokenize(): it drops short words like "ai", which
    # would let an unspoken "ai" slip through unchecked.
    spoken = set(_SPOKEN_WORD.findall(
        " ".join((w.get("word") or "") for w in words or []).lower()))
    kept = []
    for q in seo_mod.clean_search_queries(candidates, limit=20):
        content = [w for w in _SPOKEN_WORD.findall(q)
                   if w not in trending_mod.STOPWORDS]
        if (content and all(w in spoken for w in content)
                and _is_searchable_query(q)):
            kept.append(q)
    rest = [q for q in (fallback or []) if _is_searchable_query(q)]
    return seo_mod.clean_search_queries(kept + rest)


def _demand_queries(queries, signals):
    """Searches that exist outside this transcript.

    Phrases composed from spoken words stay on the package so the user
    can see them, but they are not demand: scoring a title against the
    words it was built from always looks like a win. Autocomplete and
    caller-supplied search queries count once they were grounded.
    """
    external = set(seo_mod.clean_search_queries(
        list((signals or {}).get("search_queries") or []), limit=20))
    return [q for q in (queries or []) if q in external]


def _spoken_terms(words, terms):
    """Trend / signal phrases whose content words were actually spoken."""
    spoken = set(_SPOKEN_WORD.findall(
        " ".join((w.get("word") or "") for w in words or []).lower()))
    out = []
    for raw in terms or []:
        if not isinstance(raw, str) or not raw.strip():
            continue
        text = " ".join(raw.split())
        content = [w for w in _SPOKEN_WORD.findall(text.lower())
                   if w not in trending_mod.STOPWORDS]
        if content and all(w in spoken for w in content) and text not in out:
            out.append(text)
    return out


MIN_TITLE_WORDS = 3
_FRAGMENT_START = frozenset(
    "is are was were okay ok and but so well yeah oh um uh".split()
)


def _as_title(text, limit=seo_mod.TITLE_MAX_CHARS):
    """Collapse space, strip dangling punctuation, fit the post limit."""
    cleaned = re.sub(r"\s+", " ", (text or "").strip())
    keep_q = cleaned.endswith("?")
    cleaned = cleaned.strip(" \t.,;:!-")
    if keep_q and cleaned:
        cleaned = cleaned.rstrip("?") + "?"
    if not cleaned:
        return ""
    return _trim_title(cleaned, limit=limit)


def _title_case_words(text):
    """Light title case: first word and content words capitalized."""
    out = []
    for i, raw in enumerate((text or "").split()):
        low = raw.lower()
        if i > 0 and low in seo_mod.TITLE_FILLER:
            out.append(low)
        else:
            out.append(low[:1].upper() + low[1:])
    return " ".join(out)


def _is_fragment(text):
    """True for cut-off spoken lines (commas, 'is'/'okay' lead-ins)."""
    t = (text or "").strip()
    if not t or t.endswith((",", ";", ":")) or "," in t:
        return True
    first = _SPOKEN_WORD.findall(t.lower())
    return bool(first) and first[0] in _FRAGMENT_START


def _winner_target_len(winning_titles):
    """Aim titles at this channel's winning length; default a full mobile line."""
    lengths = [len(t.strip()) for t in (winning_titles or [])
               if isinstance(t, str) and t.strip()]
    if not lengths:
        return 42
    lengths.sort()
    return max(28, min(seo_mod.TITLE_SWEET_SPOT, lengths[len(lengths) // 2]))


def _title_rank(text, queries, target_len=42):
    """Best-first key: complete, wins a query, fits the feed, near target length."""
    lint = seo_mod.lint_title(text)
    return (
        1 if _is_fragment(text) else 0,
        0 if seo_mod.query_hit(text, queries) else 1,
        0 if lint["mobile_fit"] else 1 if lint["desktop_fit"] else 2,
        0 if lint["front_loaded"] else 1,
        0 if lint["concrete"] else 1,
        abs(len(text) - target_len),
    )


def _compose_titles(queries, phrases, terms, take_texts, target_len=42):
    """Complete titles from spoken topic words — never a pasted take."""
    seen = set()
    candidates = []

    def add(raw, from_speech=False):
        if from_speech:
            line = _as_title(raw)
            if line and not line.endswith("?"):
                line = line[:1].upper() + line[1:]
        else:
            line = _as_title(_title_case_words(raw))
        if not line or _is_fragment(line) or len(line.split()) < 2:
            return
        key = line.lower()
        if key in seen:
            return
        seen.add(key)
        candidates.append(line)

    for q in queries:
        add(q)
    for p in phrases:
        add(p)
    for take in take_texts:
        add(take, from_speech=True)
    if not candidates:
        fallback = _as_title(_title_case_words(" ".join(terms[:2])))
        if fallback:
            candidates.append(fallback)
    return sorted(candidates, key=lambda c: _title_rank(c, queries, target_len))


def _topic_query(title, queries, distinct):
    """Search phrase this package should win, matching the chosen title."""
    have = set(_SPOKEN_WORD.findall((title or "").lower()))

    def covers(query):
        content = _content_tokens(_SPOKEN_WORD.findall(query))
        return len(content) >= 2 and all(w in have for w in content)

    covering = [q for q in queries if covers(q)]
    covering.sort(key=lambda q: -len(q))
    if covering:
        return covering[0]
    for q in queries:
        if len((q or "").split()) >= 2:
            return q
    if queries:
        return queries[0]
    return " ".join(distinct[:2])


def generate_statistical_seo(input_video, words, duration, channel_context,
                             transcript_source, signals=None):
    """Content-grounded SEO fallback: real transcript stats, no agent.

    Used when no agent CLI is available. Titles are composed from spoken
    topic words and search queries as complete lines — never pasted
    transcript fragments. Raises SeoError when the transcript is too thin
    to ground a package (callers turn that into a refusal, not a template).
    """
    signals = signals or {}
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
    phrases = _top_phrases(words)
    trend_hits = _spoken_terms(words, signals.get("trend_terms"))
    queries = _grounded_queries(
        words,
        list(signals.get("search_queries") or []) + trend_hits,
        phrases + distinct[:3] + trend_hits,
    )
    target_len = _winner_target_len(signals.get("winning_titles"))

    def substantial(text):
        return len((text or "").split()) >= MIN_TITLE_WORDS

    highlights = [h for h in report["content_highlights"] if substantial(h)]
    take_texts = [t["text"] for t in takes
                  if t.get("text") and substantial(t["text"])]
    ordered = _compose_titles(
        queries, phrases, distinct, take_texts, target_len)
    if not ordered:
        raise SeoError("transcript too thin for SEO (no complete title)")
    title = ordered[0]
    alternatives = [t for t in ordered[1:5] if t.lower() != title.lower()]

    tags = _fit_tag_budget(list(dict.fromkeys(
        queries + trend_hits + phrases + list(distinct))))
    hashtags = seo_mod.normalize_hashtags(tags, limit=MAX_SEO_HASHTAGS)

    clean_highlights = []
    for raw in highlights + take_texts:
        line = _as_title(raw)
        if (not line or _is_fragment(line) or len(line.split()) < 3
                or line.lower() == title.lower()):
            continue
        line = line[:1].upper() + line[1:]
        if line not in clean_highlights:
            clean_highlights.append(line)
        if len(clean_highlights) >= 4:
            break

    seed = _topic_query(title, queries, distinct)
    lead = _title_case_words(seed) if seed else topic
    if clean_highlights:
        pay = clean_highlights[0]
        pay_rest = pay[:1].lower() + pay[1:]
        overview = f"{lead}: {pay_rest}."
        bullets = clean_highlights[1:4]
    else:
        overview = f"{lead}."
        bullets = []
    description = format_upload_description(
        title,
        overview,
        bullets,
        hashtags,
        cta=f"Follow for more on {lead}.",
    )
    pinned = ""
    for line in take_texts:
        if (line or "").strip().endswith("?"):
            pinned = _as_title(line)[:200]
            break
    if not pinned and seed:
        pinned = f"What's your take on {seed}?"
    # Spoken phrases are not searches someone typed. Only external
    # queries (and not the transcript's own terms) may raise the score.
    demand = _demand_queries(queries, signals)
    quality = seo_mod.score_seo(title, description, tags, hashtags,
                                distinct[:6] if demand else [],
                                retention=report["retention_score"],
                                hook=hook, queries=demand)
    return {
        "title": title,
        "title_alternatives": alternatives,
        "description": description,
        "tags": tags,
        "hashtags": hashtags,
        "search_queries": queries,
        "demand_queries": demand,
        "pinned_comment": pinned,
        "seo_score": report["retention_score"],
        "quality_score": quality["quality_score"],
        "quality_checks": quality["checks"],
        "hook_score": quality["hook"],
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
    queries = seo_mod.clean_search_queries(agent_seo.get("search_queries"))
    description = _finish_description(agent_seo["description"], hashtags)
    quality = seo_mod.score_seo(agent_seo["title"], description,
                                tags, hashtags, tags[:6],
                                retention=stats["retention_score"],
                                hook=agent_seo["hook_detected"],
                                queries=queries)
    return {
        "title": agent_seo["title"],
        "title_alternatives": agent_seo["title_alternatives"],
        "description": description,
        "tags": tags,
        "hashtags": hashtags,
        "search_queries": queries,
        "pinned_comment": agent_seo.get("pinned_comment") or "",
        "seo_score": stats["retention_score"],
        "quality_score": quality["quality_score"],
        "quality_checks": quality["checks"],
        "hook_score": quality["hook"],
        "keywords_analyzed": queries or tags[:6],
        # Named agent queries are real targets. An empty list would tell
        # the checklist to ignore the tag stand-in the scorer still uses.
        **({"demand_queries": queries} if queries else {}),
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


def split_signal_arg(value, limit=MAX_PROMPT_SIGNALS):
    """``a|b|c`` CLI list -> cleaned, deduped list (blank-safe)."""
    out = []
    for part in (value or "").split("|"):
        text = " ".join(part.split())[:120]
        if text and text not in out:
            out.append(text)
        if len(out) >= limit:
            break
    return out


def search_signals(words, trend_terms=None, winning_titles=None):
    """Market signals for the SEO prompt, seeded from the transcript.

    Autocomplete runs on the transcript's top phrase and top term (free,
    fail-soft, a few seconds at most), so the agent sees the searches real
    people type about what was actually said.
    """
    seeds = list(dict.fromkeys(_top_phrases(words, top_n=1)
                               + _top_terms(words, top_n=1)))
    queries = []
    for seed in seeds[:2]:
        for q in trending_mod.fetch_suggestions(seed):
            if q not in queries:
                queries.append(q)
    return {
        "search_queries": queries[:MAX_PROMPT_SIGNALS],
        "trend_terms": list(trend_terms or [])[:MAX_PROMPT_SIGNALS],
        "winning_titles": list(winning_titles or [])[:MAX_PROMPT_SIGNALS],
    }


def emit_seo_only(input_video, channel_context=None, agent_id=None,
                  elevenlabs_key=None, engine="auto", local_model=None,
                  model=None, trend_terms=None, winning_titles=None):
    """Transcript-grounded SEO review of the source video.

    Transcribes the input, then either asks the selected agent CLI for the
    upload package or builds the statistical fallback from the real words.
    Real search queries (autocomplete), niche trend terms and the
    channel's own best titles steer the package when available.
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
        signals = search_signals(words, trend_terms, winning_titles)
        if wants_agent_cut(agent_id):
            try:
                agent_seo = run_agent_seo(
                    agent_id, takes_text, duration, len(words),
                    context=channel_context, model=model, signals=signals,
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
                    transcript_source, signals=signals)
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
    parser.add_argument("--edit-plan", default=None, help="Approved transcript edit JSON; preserves exact selected ranges.")
    parser.add_argument("--edit-strategy", choices=("cleanup", "highlights", "full"), default=None,
                        help="Studio automation: clean recording, AI highlights, or full recording.")
    parser.add_argument("--keep-silence", action="store_true")
    parser.add_argument("--keep-retakes", action="store_true")
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
    parser.add_argument("--trend-terms", default=None,
                        help="SEO mode: pipe-separated niche trend terms.")
    parser.add_argument("--winning-titles", default=None,
                        help="SEO mode: pipe-separated best past titles.")
    return parser


def wants_subtitles(subtitle_style):
    return bool(subtitle_style) and subtitle_style.strip().lower() != "none"


def render_export(renderer, input_path, output_path, *args, **kwargs):
    """Publish only a validated encode; failed retries keep the prior video."""
    directory = os.path.dirname(os.path.abspath(output_path))
    fd, staged = tempfile.mkstemp(prefix=".pixel_render_", suffix=".mp4", dir=directory)
    os.close(fd)
    report = os.path.splitext(staged)[0] + ".framing.json"
    def log(line):
        if not line.startswith("[COMPLETE]"):
            print(line, flush=True)
    try:
        renderer(input_path, staged, *args, log=log, **kwargs)
        if not os.path.getsize(staged):
            raise render_mod.RenderError("Renderer produced an empty video")
        if os.path.isfile(report):
            os.replace(report, os.path.splitext(output_path)[0] + ".framing.json")
        os.replace(staged, output_path)
        print(f"[COMPLETE] {kwargs.get('aspect_ratio') or '9:16'} Short rendered: {output_path}", flush=True)
        return output_path
    except OSError as exc:
        raise render_mod.RenderError(f"Could not save edited video: {exc}") from exc
    finally:
        for path in (staged, report):
            if os.path.isfile(path):
                os.remove(path)


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
    if args.edit_strategy and (args.edit_plan or args.edl or args.cut_start is not None or args.cut_end is not None):
        print("short_pipeline.py: automation cannot be combined with manual edits", file=sys.stderr)
        return 1
    custom_prompt = bool(args.prompt and args.prompt.strip())
    if args.edit_plan and (args.edl or args.cut_start is not None or args.cut_end is not None):
        print("short_pipeline.py: transcript edits cannot be combined with an EDL or time trim", file=sys.stderr)
        return 1
    if custom_prompt and (not wants_agent_cut(args.agent) or args.edl or args.edit_plan
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
    edit_plan = None
    if args.edit_plan:
        try:
            with open(args.edit_plan, encoding="utf-8") as handle:
                edit_plan = edit_mod.validate_plan(json.load(handle), source_duration, args.input)
        except (OSError, ValueError, TypeError) as exc:
            print(f"short_pipeline.py: invalid transcript edit: {exc}", file=sys.stderr)
            return 1

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
        if edit_plan is not None and edit_plan["words"] is not None:
            with open(words_json, "w", encoding="utf-8") as fh:
                json.dump({"source": os.path.basename(args.input), "model": "transcript-edit",
                           "words": edit_plan["words"]}, fh, ensure_ascii=False)
            rc = 0
        elif args.edit_strategy and (not probe["has_audio"] or not auto_mod.needs_transcript(
                args.edit_strategy, captions=wants_subtitles(args.subtitles),
                remove_silence=not args.keep_silence, remove_retakes=not args.keep_retakes,
                prompt=args.prompt)):
            # Styling a full recording does not require a speech provider.
            # Replace any old transcript so a re-export cannot reuse stale words.
            with open(words_json, "w", encoding="utf-8") as fh:
                json.dump({"source": os.path.basename(args.input), "words": []}, fh)
            rc = 0
        else:
            rc = transcribe_isolated(targs)
        if rc and args.engine in ("local", "elevenlabs"):
            print(f"short_pipeline.py: selected {args.engine} transcription failed; no export was created. Check the provider error above and Settings → Engine.", file=sys.stderr)
            return 1
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
        if args.edit_strategy:
            try:
                with open(packed_path, encoding="utf-8") as fh:
                    automation = auto_mod.select_edit(args.edit_strategy, words, source_duration,
                        has_audio=probe["has_audio"], captions=wants_subtitles(args.subtitles),
                        remove_silence=not args.keep_silence, remove_retakes=not args.keep_retakes,
                        agent=args.agent, target=args.duration, takes_text=fh.read(),
                        context=args.channel_context, model=args.model, prompt=args.prompt)
            except (edit_mod.EditError, agent_mod.AgentError) as exc:
                print(f"short_pipeline.py: edit failed: {exc}", file=sys.stderr)
                return 1
            segments = automation["segments"]
            automation.update({"engine": os.path.realpath(__file__), "source_path": os.path.realpath(args.input),
                               "source_duration": source_duration, "word_count": len(words)})
            for suffix in (".edl.json", ".edit.json"):
                with open(args.output + suffix, "w", encoding="utf-8") as fh:
                    json.dump(automation, fh, indent=2)
            selected_seconds = render_mod.edl_output_seconds(segments, probe["has_audio"])
            cut_note = (f"video-use {args.edit_strategy}: {selected_seconds:.2f}s from {source_duration:.2f}s; "
                        f"{len(segments)} ranges; {len(automation['removals'])} repeated takes removed")
        elif edit_plan is not None:
            segments = edit_plan["segments"]
            with open(args.output + ".edl.json", "w", encoding="utf-8") as fh:
                json.dump({"source": edit_plan["source"], "segments": segments}, fh, indent=2)
            selected_seconds = render_mod.edl_output_seconds(segments, probe["has_audio"])
            cut_note = f"Your edit: {selected_seconds:.2f}s kept from {source_duration:.2f}s; {len(segments)} ranges"
        elif args.edl:
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
                render_export(render_mod.render_edl,
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
            if custom_prompt and not args.edit_strategy:
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
            render_export(render_mod.render_short,
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
            trend_terms=split_signal_arg(args.trend_terms),
            winning_titles=split_signal_arg(args.winning_titles),
        )

    if not os.path.isfile(args.input):
        print(f"short_pipeline.py: input video not found: {args.input}", file=sys.stderr)
        return 1

    return run_render(args)


if __name__ == "__main__":
    sys.exit(main())
