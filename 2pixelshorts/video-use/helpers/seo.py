#!/usr/bin/env python3
"""Shared SEO core for the 2PixelShorts video-use engine.

Single responsibility: every rule that decides what a *good* Shorts upload
package looks like lives here — tag budgets, hashtag normalization, CTR
title variants, description structure, and honest 0-100 scoring. Both the
agent path (``assemble_agent_seo``) and the statistical fallback
(``generate_statistical_seo``) in ``short_pipeline.py`` build through this
module, so fixing a rule here fixes it for every video.

Stdlib only.
"""

import re

# Upload-tag budget: YouTube accepts ~500 characters of tags total, and
# Shorts discovery works best with a full bench of specific phrases.
MAX_SEO_TAGS = 20
MAX_SEO_TAG_CHARS = 500
MAX_SEO_HASHTAGS = 8
TITLE_MAX_CHARS = 100
# Shorts titles that convert cluster well under the hard limit.
TITLE_SWEET_SPOT = 60

# Per-platform packaging limits. YouTube is the superset; TikTok/Reels
# descriptions truncate earlier and lean harder on hashtags.
PLATFORM_LIMITS = {
    "youtube": {"title": 100, "description": 5000, "tags": 20,
                "tag_chars": 500, "hashtags": 8},
    "tiktok": {"title": 150, "description": 2200, "tags": 20,
               "tag_chars": 500, "hashtags": 8},
    "instagram": {"title": 100, "description": 2200, "tags": 20,
                  "tag_chars": 500, "hashtags": 10},
    "default": {"title": 100, "description": 5000, "tags": 20,
                "tag_chars": 500, "hashtags": 8},
}

_HASHTAG_CLEAN = re.compile(r"[^a-z0-9]")


def normalize_hashtag(tag, limit=30):
    """Normalize one tag into a postable hashtag (``#RustAsync`` style)."""
    text = (tag or "").strip().lower()
    # Split camelCase so "RustAsync" and "rust async" converge.
    text = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", text)
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


def _frontloads_keyword(title, keywords):
    first = (title or "").strip().lower()
    return any(first.startswith((k or "").lower()) or
               (k or "").lower() in first[:40]
               for k in (keywords or []) if k)


def build_description(hook, overview, highlights, tags, hashtags, cta=None):
    """Structured upload description with mandatory keyword + hashtag block."""
    lines = [(hook or "").strip(), "", (overview or "").strip(), "",
             "\U0001F4CC Key Highlights:"]
    lines += ["\u2022 " + (h or "").strip() for h in (highlights or [])[:4]]
    if cta and cta.strip():
        lines += ["", cta.strip()]
    lines += ["", "\U0001F50D Search Keywords:", ", ".join(tags or []),
              "", " ".join(hashtags or [])]
    return "\n".join(lines).strip()


def score_seo(title, description, tags, hashtags, keywords, retention=0):
    """Honest 0-100 SEO quality score with a per-check breakdown.

    Weighted: title 30 (keyword frontload, sweet-spot length, CTR shape,
    hard-limit fit), description 30 (hook present, keyword block, hashtag
    line, CTA/length), tags 25 (bench depth, budget fill, keyword
    coverage), hashtags 15 (3-8 postable tags). ``retention`` (the
    measured watchability score) blends 50/50 with package quality so a
    great package on a weak cut — or vice versa — never reports 98.
    """
    title = (title or "")
    description = (description or "")
    tags = list(tags or [])
    hashtags = list(hashtags or [])
    keywords = [k.lower() for k in (keywords or []) if k]

    checks = []

    # Title (30).
    title_score = 0
    if title.strip():
        title_score += 7
        checks.append(("title_present", 7, 7))
    else:
        checks.append(("title_present", 0, 7))
    if _frontloads_keyword(title, keywords):
        title_score += 10
        checks.append(("title_keyword_frontload", 10, 10))
    else:
        checks.append(("title_keyword_frontload", 0, 10))
    if 20 <= len(title) <= TITLE_SWEET_SPOT:
        title_score += 8
        checks.append(("title_length", 8, 8))
    elif title and len(title) <= TITLE_MAX_CHARS:
        title_score += 4
        checks.append(("title_length", 4, 8))
    else:
        checks.append(("title_length", 0, 8))
    lowered = title.lower()
    if title and (lowered.startswith(("how", "why", "stop", "this",
                                       "the", "what"))
                  or "?" in title or "(" in title
                  or any(ch.isdigit() for ch in title)):
        title_score += 5
        checks.append(("title_ctr_shape", 5, 5))
    else:
        checks.append(("title_ctr_shape", 0, 5))
    if len(title) > TITLE_MAX_CHARS:
        title_score = max(0, title_score - 5)
        checks.append(("title_over_limit", -5, 0))
    else:
        checks.append(("title_over_limit", 0, 0))

    # Description (30).
    desc_score = 0
    if len(description.strip()) >= 100:
        desc_score += 8
        checks.append(("description_length", 8, 8))
    elif description.strip():
        desc_score += 3
        checks.append(("description_length", 3, 8))
    else:
        checks.append(("description_length", 0, 8))
    if "Search Keywords:" in description:
        desc_score += 10
        checks.append(("description_keyword_block", 10, 10))
    else:
        checks.append(("description_keyword_block", 0, 10))
    if any(h in description for h in hashtags[:3]):
        desc_score += 7
        checks.append(("description_hashtag_line", 7, 7))
    else:
        checks.append(("description_hashtag_line", 0, 7))
    upper = description.upper()
    if "SUBSCRIBE" in upper or "FOLLOW" in upper or "CTA" in upper \
            or "\U0001F449" in description or "👉" in description:
        desc_score += 5
        checks.append(("description_cta", 5, 5))
    else:
        checks.append(("description_cta", 0, 5))

    # Tags (25).
    tag_score = 0
    if len(tags) >= 15:
        tag_score += 10
        checks.append(("tags_depth", 10, 10))
    elif len(tags) >= 8:
        tag_score += 6
        checks.append(("tags_depth", 6, 10))
    elif tags:
        tag_score += 2
        checks.append(("tags_depth", 2, 10))
    else:
        checks.append(("tags_depth", 0, 10))
    joined = ", ".join(tags)
    if len(joined) >= 200:
        tag_score += 5
        checks.append(("tags_budget_fill", 5, 5))
    elif tags:
        tag_score += 2
        checks.append(("tags_budget_fill", 2, 5))
    else:
        checks.append(("tags_budget_fill", 0, 5))
    covered = sum(1 for k in keywords
                  if k and any(k in (t or "").lower() for t in tags))
    if keywords:
        coverage = round(10 * covered / max(1, len(keywords)))
        tag_score += coverage
        checks.append(("tags_keyword_coverage", coverage, 10))
    else:
        checks.append(("tags_keyword_coverage", 0, 10))

    # Hashtags (15).
    hash_score = 0
    if 3 <= len(hashtags) <= MAX_SEO_HASHTAGS:
        hash_score += 10
        checks.append(("hashtags_count", 10, 10))
    elif hashtags:
        hash_score += 4
        checks.append(("hashtags_count", 4, 10))
    else:
        checks.append(("hashtags_count", 0, 10))
    if hashtags and all((h or "").startswith("#") for h in hashtags):
        hash_score += 5
        checks.append(("hashtags_postable", 5, 5))
    else:
        checks.append(("hashtags_postable", 0, 5))

    quality = min(100, max(0, title_score + desc_score + tag_score
                           + hash_score))
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
        "checks": [{"id": cid, "got": got, "of": of}
                   for cid, got, of in checks],
    }
