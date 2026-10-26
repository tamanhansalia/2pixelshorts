#!/usr/bin/env python3
"""Shared SEO core for the 2PixelShorts video-use engine.

Single responsibility: every rule that decides what a *good* Shorts upload
package looks like lives here — tag budgets, hashtag normalization, the
hook and title linters, description structure, and honest 0-100 scoring.
Both the agent path (``assemble_agent_seo``) and the statistical fallback
(``generate_statistical_seo``) in ``short_pipeline.py`` build through this
module, so fixing a rule here fixes it for every video.

What the score rewards (and why): Shorts reach is driven by the hook and
the title a viewer sees in the feed, then by the first lines of the
description that double as the search snippet. Tags are a weak signal
(YouTube says so) and keyword-list descriptions read as stuffing, so they
earn little or nothing here.

The hook scorer and title linter are adapted from the MIT-licensed
youtube-agent-skill by Jake Schincariol
(https://github.com/Jakeschincariol/youtube-agent-skill):
``skills/yt-script/hookscore.py`` and ``skills/yt-package/title.py``.

Stdlib only.
"""

import re

# Upload-tag budget: YouTube accepts ~500 characters of tags total. Tags
# mostly disambiguate (tool names, spellings), so 5-15 is plenty.
MAX_SEO_TAGS = 15
MAX_SEO_TAG_CHARS = 500
# 3-5 hashtags: YouTube shows the first three above the title; Instagram
# and TikTok perform best with a handful of specific ones.
MAX_SEO_HASHTAGS = 5
TITLE_MAX_CHARS = 100
# Desktop search cuts near 60 characters, a mobile feed near 40.
TITLE_SWEET_SPOT = 60
TITLE_MOBILE_CHARS = 40
# The part of a description shown above "...more" and in search snippets.
DESCRIPTION_FOLD_CHARS = 150
MAX_SEARCH_QUERIES = 3

# Per-platform packaging limits (mirrors src/lib/seo.ts PLATFORM_LIMITS).
PLATFORM_LIMITS = {
    "youtube": {"title": 100, "description": 5000, "hashtags": 5},
    "tiktok": {"title": 150, "description": 2200, "hashtags": 5},
    "instagram": {"title": 100, "description": 2200, "hashtags": 5},
    "twitter": {"title": 100, "description": 280, "hashtags": 2},
    "linkedin": {"title": 100, "description": 3000, "hashtags": 3},
    "facebook": {"title": 100, "description": 5000, "hashtags": 3},
    "default": {"title": 100, "description": 5000, "hashtags": 5},
}

_HASHTAG_CLEAN = re.compile(r"[^a-z0-9]")

# --- Linter vocab (adapted from youtube-agent-skill, MIT) ----------------

VAGUE_WORDS = frozenset(
    "amazing incredible insane crazy huge massive ultimate best powerful "
    "secret revolutionary mindblowing epic perfect complete everything "
    "unbelievable".split()
)
TITLE_FILLER = frozenset(
    "the a an of for to in on and or is are with your you my i this that "
    "it how what why".split()
)
HOOK_FILLER = frozenset(
    "basically actually literally just really very so kind sort like guys "
    "hey welcome today video subscribe channel".split()
)
_CONCRETE = re.compile(
    r"\b(\d[\d,.]*\s?(%|k|m|x|s|h)?|\$\d|\d+\s?(second|minute|hour|day|"
    r"week|month|year)s?)\b", re.I)
_YOU = re.compile(r"\b(you|your|you're|youre|yourself)\b", re.I)
_STAKE = re.compile(
    r"\b(lose|lost|wasting|waste|quit|fail|broke|cost|risk|before|stop|"
    r"never|die|dying|dead|wrong|mistake)\b", re.I)
_CURIOSITY = re.compile(
    r"\b(why|how|what|which|until|before|but|nobody|almost|except|reason|"
    r"actually)\b", re.I)
_WORD = re.compile(r"[a-z0-9']+")
_KEYWORD_BLOCK = re.compile(r"search keywords\s*:", re.I)


def _words(text):
    return _WORD.findall((text or "").lower())


def normalize_hashtag(tag, limit=30):
    """Normalize one tag into a postable hashtag (``#rustasync`` style)."""
    text = (tag or "").strip()
    # Split camelCase before lowercasing so "RustAsync" and "rust async"
    # converge on the same hashtag.
    text = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", text).lower()
    alnum = _HASHTAG_CLEAN.sub("", text.replace(" ", "").replace("_", ""))
    if not alnum:
        return ""
    if alnum[0].isdigit():
        alnum = "t" + alnum
    return "#" + alnum[:limit]


def normalize_hashtags(tags, hashtags=None, limit=MAX_SEO_HASHTAGS):
    """Derive a clean, deduped hashtag list.

    Explicit agent hashtags win; anything missing is backfilled from the
    tags so the package never ships without a hashtag line. Case-insensitive
    dedupe keeps ``#Rust`` and ``#rust`` from colliding on upload.
    """
    out = []
    seen = set()
    for raw in list(hashtags or []) + ["#" + (t or "") for t in (tags or [])]:
        text = (raw or "").strip()
        if text and not text.startswith("#"):
            text = "#" + text
        norm = normalize_hashtag(text.lstrip("#"))
        if not norm or norm.lower() in seen:
            continue
        seen.add(norm.lower())
        out.append(norm)
        if len(out) >= limit:
            break
    return out


def fit_tag_budget(tags, budget=MAX_SEO_TAG_CHARS, limit=MAX_SEO_TAGS):
    """Keep the most important tags that fit the character budget.

    Case-insensitive dedupe, blanks dropped, order preserved (callers pass
    most-important-first). The ", " separator counts against the budget so
    the joined string never exceeds it.
    """
    kept = []
    seen = set()
    used = 0
    for raw in tags or []:
        tag = (raw or "").strip()
        if not tag or tag.lower() in seen:
            continue
        need = len(tag) + (2 if kept else 0)
        if used + need > budget or len(kept) >= limit:
            break
        seen.add(tag.lower())
        kept.append(tag)
        used += need
    return kept


def trim_title(text, limit=TITLE_MAX_CHARS):
    """Trim to a postable title on word boundaries (ellipsis when cut)."""
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    cut = text[:max(0, limit - 3)].rstrip()
    space = cut.rfind(" ")
    if space > 0:
        cut = cut[:space]
    return cut.rstrip() + "..."


def clean_search_queries(queries, limit=MAX_SEARCH_QUERIES):
    """Lowercase, single-spaced, deduped search phrases (most important first)."""
    out = []
    for raw in queries or []:
        if not isinstance(raw, str):
            continue
        text = " ".join(re.sub(r"[^\w\s'+#.-]", " ", raw.lower()).split())
        if text and text not in out:
            out.append(text[:80])
        if len(out) >= limit:
            break
    return out


def query_hit(text, queries):
    """True when ``text`` carries the words of at least one query.

    A query counts when at least half of its content words (and at least
    one) appear in the text, so "rust connection pooling" is won by a title
    saying "Connection pooling in Rust" without demanding exact order.
    """
    have = set(_words(text))
    for query in queries or []:
        content = [w for w in _words(query) if w not in TITLE_FILLER]
        if not content:
            continue
        hits = sum(1 for w in content if w in have)
        if hits >= max(1, (len(content) + 1) // 2):
            return True
    return False


# --- Hook + title linters (adapted from youtube-agent-skill, MIT) ---------

def _hook_specificity(text):
    words = _words(text)
    if not words:
        return 0
    nums = len(_CONCRETE.findall(text))
    vague = sum(1 for w in words if w in VAGUE_WORDS)
    filler = sum(1 for w in words if w in HOOK_FILLER)
    score = 34 + nums * 22 - vague * 16 - filler * 5
    # Proper nouns that are not sentence-initial read as named things.
    score += min(18, 6 * sum(1 for w in text.split()[1:] if w[:1].isupper()))
    return max(0, min(100, score))


def _hook_address(text):
    count = len(_YOU.findall(text))
    first = 30 if _YOU.search(" ".join(text.split()[:6])) else 0
    return max(0, min(100, 26 + count * 20 + first))


def _hook_stakes(text):
    count = len(_STAKE.findall(text))
    return max(0, min(100, 22 + count * 26
                      + (14 if _CONCRETE.search(text) else 0)))


def _hook_curiosity(text):
    count = len(_CURIOSITY.findall(text))
    question = 18 if text.strip().endswith("?") else 0
    # A hook that resolves itself has no gap left.
    closed = -18 if re.search(r"\b(because|so that|which means)\b",
                              text, re.I) else 0
    return max(0, min(100, 24 + count * 17 + question + closed))


def _hook_brevity(text):
    count = len(_words(text))
    if count == 0:
        return 0
    # 9-24 words is the band a spoken hook lands in inside ~10 seconds.
    if 9 <= count <= 24:
        return 100
    if count < 9:
        return max(30, 100 - (9 - count) * 11)
    return max(10, 100 - (count - 24) * 7)


HOOK_FIXES = {
    "specificity": "swap an adjective for a number, a name or a date",
    "address": "say 'you' in the first six words",
    "stakes": "name what it costs them to keep doing it the current way",
    "curiosity": "cut the half of the sentence that answers itself",
    "brevity": "9 to 24 words; stop where you run out of breath",
}


def score_hook(text):
    """Five-property hook panel; verdict = 60% mean + 40% weakest.

    The weakest-link weighting is deliberate: a hook with one dead property
    leaks there and averaging hides it. Treat a low score as a reason to
    look again, never a high score as a promise.
    """
    text = (text or "").strip()
    parts = {
        "specificity": _hook_specificity(text),
        "address": _hook_address(text),
        "stakes": _hook_stakes(text),
        "curiosity": _hook_curiosity(text),
        "brevity": _hook_brevity(text),
    }
    if not text:
        return {"verdict": 0, "band": "WEAK", "properties": parts,
                "weakest": "brevity", "fix": HOOK_FIXES["brevity"]}
    values = list(parts.values())
    verdict = round(0.6 * (sum(values) / len(values)) + 0.4 * min(values))
    weakest = min(parts, key=parts.get)
    band = "STRONG" if verdict >= 72 else "WORKABLE" if verdict >= 55 else "WEAK"
    return {"verdict": verdict, "band": band, "properties": parts,
            "weakest": weakest, "fix": HOOK_FIXES[weakest]}


def lint_title(title):
    """Title issues a viewer would feel: truncation, shouting, vagueness."""
    text = (title or "").strip()
    words = _words(text)
    caps = [w for w in text.split() if len(w) > 2 and w.isupper()]
    return {
        "chars": len(text),
        "mobile_fit": len(text) <= TITLE_MOBILE_CHARS,
        "desktop_fit": len(text) <= TITLE_SWEET_SPOT,
        "shouting": len(caps) > 2,
        "vague": sorted({w for w in words if w in VAGUE_WORDS}),
        "concrete": bool(re.search(r"\d", text)) or text.endswith("?")
        or any(w[:1].isupper() and not w.isupper()
               for w in text.split()[1:]),
        "front_loaded": any(w not in TITLE_FILLER for w in words[:3]),
    }


def first_line(text):
    for line in (text or "").splitlines():
        if line.strip():
            return line.strip()
    return ""


def strip_keyword_block(description):
    """Drop a legacy "Search Keywords:" block (heading + its keyword line)."""
    lines = (description or "").splitlines()
    out = []
    skip = 0
    for line in lines:
        if skip:
            if line.strip():
                skip -= 1
            continue
        if _KEYWORD_BLOCK.search(line):
            # The keyword list is either on this line or the next one.
            rest = _KEYWORD_BLOCK.split(line, maxsplit=1)[-1].strip()
            skip = 0 if rest else 1
            continue
        out.append(line)
    text = "\n".join(out)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def build_description(hook, overview, highlights, hashtags, cta=None):
    """Upload description: hook + payoff above the fold, then detail.

    The first two lines are the only ones most viewers (and the search
    snippet) see, so they carry the hook and what the short gives them.
    Hashtags close it out; no keyword list (it reads as stuffing).
    """
    lines = [(hook or "").strip()]
    if (overview or "").strip():
        lines.append((overview or "").strip())
    bullets = [(h or "").strip() for h in (highlights or [])[:4]
               if (h or "").strip()]
    if bullets:
        lines += [""] + ["• " + b for b in bullets]
    if cta and cta.strip():
        lines += ["", cta.strip()]
    if hashtags:
        lines += ["", " ".join(hashtags[:MAX_SEO_HASHTAGS])]
    return "\n".join(lines).strip()


def score_seo(title, description, tags, hashtags, keywords, retention=0,
              hook=None, queries=None):
    """Honest 0-100 SEO quality score with a per-check breakdown.

    Weighted: title 40 (present, fits the mobile feed, wins a target query,
    concrete, not shouting, front-loaded), hook 15 (weakest-link hook
    panel), description 30 (query words above the fold, enough body,
    hashtags present, no keyword stuffing), hashtags 10 (3-5 postable),
    tags 5 (a light disambiguation bench). ``queries`` are the searches
    this short should win; ``keywords`` stand in when none are known.
    ``retention`` (the measured watchability score) blends 50/50 with
    package quality so a great package on a weak cut never reports 98.
    """
    title = (title or "")
    description = (description or "")
    tags = list(tags or [])
    hashtags = list(hashtags or [])
    targets = [q for q in (queries or []) if q] or \
        [k for k in (keywords or []) if k]
    checks = []

    def add(cid, got, of):
        checks.append((cid, got, of))
        return got

    # Title (40).
    lint = lint_title(title)
    present = bool(title.strip())
    title_score = add("title_present", 5 if present else 0, 5)
    if present and lint["mobile_fit"]:
        fit = 8
    elif present and lint["desktop_fit"]:
        fit = 5
    elif present and lint["chars"] <= TITLE_MAX_CHARS:
        fit = 2
    else:
        fit = 0
    title_score += add("title_mobile_fit", fit, 8)
    title_score += add("title_query_match",
                       12 if present and query_hit(title, targets) else 0, 12)
    if present and lint["concrete"] and not lint["vague"]:
        concrete = 8
    elif present and (lint["concrete"] or not lint["vague"]):
        concrete = 4
    else:
        concrete = 0
    title_score += add("title_concrete", concrete, 8)
    title_score += add("title_not_shouting",
                       4 if present and not lint["shouting"] else 0, 4)
    title_score += add("title_front_loaded",
                       3 if present and lint["front_loaded"] else 0, 3)
    if lint["chars"] > TITLE_MAX_CHARS:
        title_score = max(0, title_score - 5)
        add("title_over_limit", -5, 0)
    else:
        add("title_over_limit", 0, 0)

    # Hook (15): the spoken opener, else the description's first line.
    hook_text = (hook or "").strip() or first_line(description)
    panel = score_hook(hook_text)
    hook_score = add("hook_strength", round(15 * panel["verdict"] / 100), 15)

    # Description (30).
    fold = description.strip()[:DESCRIPTION_FOLD_CHARS]
    desc_score = add("description_above_fold",
                     15 if fold and query_hit(fold, targets) else 0, 15)
    body = len(description.strip())
    desc_score += add("description_length",
                      5 if body >= 100 else 2 if body else 0, 5)
    desc_score += add("description_hashtags",
                      5 if any(h in description for h in hashtags[:3]) else 0,
                      5)
    stuffed = bool(_KEYWORD_BLOCK.search(description)) or any(
        line.count(",") >= 8 for line in description.splitlines())
    desc_score += add("description_no_stuffing",
                      5 if body and not stuffed else 0, 5)

    # Hashtags (10).
    if 3 <= len(hashtags) <= MAX_SEO_HASHTAGS:
        count = 7
    elif hashtags and len(hashtags) <= 8:
        count = 4
    elif hashtags:
        count = 1
    else:
        count = 0
    hash_score = add("hashtags_count", count, 7)
    hash_score += add("hashtags_postable",
                      3 if hashtags and all((h or "").startswith("#")
                                            for h in hashtags) else 0, 3)

    # Tags (5).
    if 5 <= len(tags) <= MAX_SEO_TAGS:
        tag_points = 5
    elif tags:
        tag_points = 3
    else:
        tag_points = 0
    tag_score = add("tags_present", tag_points, 5)

    quality = min(100, max(0, title_score + hook_score + desc_score
                           + hash_score + tag_score))
    try:
        retention = max(0, min(100, int(retention or 0)))
    except (TypeError, ValueError):
        retention = 0
    if retention:
        final = int(round(quality * 0.5 + retention * 0.5))
    else:
        final = quality
    return {
        "seo_score": final,
        "quality_score": quality,
        "retention": retention,
        "hook": panel,
        "checks": [{"id": cid, "got": got, "of": of}
                   for cid, got, of in checks],
    }
