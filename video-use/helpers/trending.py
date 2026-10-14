"""Trending keyword signals from recent high-view YouTube Shorts.

Queries the YouTube Data API ``search.list`` for ``type=video`` +
``videoDuration=short`` ordered by ``order=viewCount`` within the last N
days, then extracts keyword terms from the returned titles/descriptions.
Results cache per niche for 24h (search calls cost quota).

Needs a YouTube Data API key (Settings → API keys). Without one — or on
any API failure — it exits 0 with an empty keyword list and a note, so
trending never breaks the render/SEO flow.

Stdlib only (urllib).
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

SEARCH_URL = "https://www.googleapis.com/youtube/v3/search"
CACHE_TTL_SECONDS = 24 * 3600

STOPWORDS = frozenset(
    """
    a about actually after again against all almost also always an and any are
    around as at be because been before being between both but by can cannot
    could did do does doing done down during each every everyone everything
    few for from further get getting goes going gone got had has have having
    he her here hers herself him himself his how however into is it its itself
    just keep like made make many me more most much must my new no not now of
    off often on once one only onto or other ought our out over own same see
    she should so some such than that the their them then there these they
    this those through to too under until up upon use used using very via vs
    want was way we well were what when where which while who whom why will
    with within without would you your yours get got lets let im ive dont
    cant wont really best top free new official video short shorts youtube
    """.split()
)

TOKEN_RE = re.compile(r"[a-z0-9]+")
CACHE_DIRNAME = ".cache"


def _helpers_dir():
    return os.path.dirname(os.path.abspath(__file__))


def default_cache_dir():
    path = os.path.join(_helpers_dir(), "..", CACHE_DIRNAME)
    return os.path.normpath(path)


def slugify(niche):
    slug = re.sub(r"[^a-z0-9]+", "_", (niche or "").lower()).strip("_")
    return slug[:40] or "general"


def cache_path(cache_dir, niche, region=None):
    name = f"trending_{slugify(niche)}_{(region or 'any').lower()}.json"
    return os.path.join(cache_dir, name)


def tokenize(text):
    """Lowercase alphanumeric tokens minus stopwords/shorts/numbers."""
    out = []
    for tok in TOKEN_RE.findall((text or "").lower()):
        if len(tok) < 3 or tok.isdigit() or tok in STOPWORDS:
            continue
        out.append(tok)
    return out


def extract_keywords(videos, top_n=20):
    """Rank terms from video titles/descriptions.

    Unigrams plus adjacent-token bigrams; score = occurrence count with
    bigrams weighted 1.5x. Returns [{term, score, sources}].
    """
    counts = {}
    sources = {}
    for index, video in enumerate(videos or []):
        text = f"{video.get('title', '')} {video.get('description', '')}"
        tokens = tokenize(text)
        seen = set()
        terms = list(tokens)
        for a, b in zip(tokens, tokens[1:]):
            terms.append(f"{a} {b}")
        for term in terms:
            weight = 1.5 if " " in term else 1.0
            counts[term] = counts.get(term, 0.0) + weight
            if term not in seen:
                seen.add(term)
                sources[term] = sources.get(term, 0) + 1
    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    return [
        {"term": term, "score": round(score, 1), "sources": sources.get(term, 0)}
        for term, score in ranked[:top_n]
    ]


def fetch_trending(niche, api_key, region=None, days=7, max_results=25,
                   timeout=30):
    """Call search.list. Returns the raw items list. Raises on API errors."""
    since = (datetime.now(timezone.utc) - timedelta(days=days)).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )
    params = {
        "part": "snippet",
        "q": niche,
        "type": "video",
        "videoDuration": "short",
        "order": "viewCount",
        "publishedAfter": since,
        "maxResults": max(1, min(50, max_results)),
        "key": api_key,
    }
    if region:
        params["regionCode"] = region
    url = f"{SEARCH_URL}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        try:
            message = json.loads(detail).get("error", {}).get("message", detail)
        except (json.JSONDecodeError, ValueError, AttributeError):
            message = detail
        raise RuntimeError(f"YouTube API HTTP {exc.code}: {message}")
    videos = []
    for item in payload.get("items", []) or []:
        snippet = item.get("snippet", {}) or {}
        videos.append({
            "video_id": (item.get("id", {}) or {}).get("videoId", ""),
            "title": snippet.get("title", ""),
            "channel": snippet.get("channelTitle", ""),
            "description": (snippet.get("description", "") or "")[:500],
            "published_at": snippet.get("publishedAt", ""),
        })
    return videos


def load_cache(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            doc = json.load(fh)
    except (OSError, json.JSONDecodeError, ValueError):
        return None
    try:
        fetched = datetime.fromisoformat(doc.get("fetched_at", ""))
    except (ValueError, TypeError):
        return None
    if fetched.tzinfo is None:
        fetched = fetched.replace(tzinfo=timezone.utc)
    age = (datetime.now(timezone.utc) - fetched).total_seconds()
    if age < 0 or age > CACHE_TTL_SECONDS:
        return None
    return doc


def save_cache(path, doc):
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, indent=2)
    except OSError as exc:
        print(f"trending.py: cache write failed ({exc})", file=sys.stderr)


def get_trending(niche, api_key=None, region=None, days=7, max_results=25,
                 cache_dir=None, top_n=20):
    """Fetch (or load cached) trending keywords. Never raises for API
    issues — those come back as {"keywords": [], "error": ...}."""
    niche = (niche or "").strip()
    if not niche:
        return {"niche": "", "keywords": [], "videos": [], "fetched_at": None,
                "cached": False, "error": "empty niche query"}

    cache_dir = cache_dir or default_cache_dir()
    path = cache_path(cache_dir, niche, region)
    cached = load_cache(path)
    if cached is not None:
        cached["cached"] = True
        return cached

    if not (api_key or "").strip():
        return {"niche": niche, "keywords": [], "videos": [],
                "fetched_at": None, "cached": False,
                "note": "no YouTube API key configured"}

    try:
        videos = fetch_trending(niche, api_key.strip(), region=region,
                                days=days, max_results=max_results)
    except Exception as exc:
        print(f"trending.py: fetch failed ({exc})", file=sys.stderr)
        return {"niche": niche, "keywords": [], "videos": [],
                "fetched_at": None, "cached": False, "error": str(exc)}

    doc = {
        "niche": niche,
        "keywords": extract_keywords(videos, top_n=top_n),
        "videos": [{"title": v["title"], "channel": v["channel"]} for v in videos],
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "cached": False,
    }
    save_cache(path, doc)
    return doc


def main(argv=None):
    parser = argparse.ArgumentParser(description="Fetch trending Shorts keywords.")
    parser.add_argument("--niche", required=True, help="Topic query, e.g. 'rust programming'.")
    parser.add_argument("--api-key", default=os.environ.get("PIXEL_YOUTUBE_KEY", ""), help="YouTube Data API key (prefer PIXEL_YOUTUBE_KEY).")
    parser.add_argument("--region", default=None, help="regionCode, e.g. US.")
    parser.add_argument("--days", type=int, default=7)
    parser.add_argument("--max", type=int, default=25)
    parser.add_argument("--cache-dir", default=None)
    parser.add_argument("--output", default=None, help="Write result JSON to file.")
    args = parser.parse_args(argv)

    doc = get_trending(
        args.niche, api_key=args.api_key, region=args.region,
        days=args.days, max_results=args.max, cache_dir=args.cache_dir,
    )
    payload = json.dumps(doc, indent=2)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as fh:
            fh.write(payload)
    else:
        print(payload)
    return 0


if __name__ == "__main__":
    sys.exit(main())
