"""Trending keyword signals from recent fast-rising YouTube Shorts.

Queries the YouTube Data API ``search.list`` for ``type=video`` +
``videoDuration=short`` ordered by ``order=viewCount`` within the last N
days, reads each hit's live view count (``videos.list``, 1 quota unit),
and ranks title/description terms weighted by views-per-hour, so a
rising small channel counts more than an old giant. Also returns the
free YouTube autocomplete phrases for the niche — the searches people
actually type. Results cache per niche for 24h (search calls cost quota).

Keyword trends need a YouTube Data API key (Settings → API keys).
Autocomplete needs none. Without a key — or on any API failure — it exits
0 with whatever it could gather and a note, so trending never breaks the
render/SEO flow. Set ``PIXEL_DISABLE_SUGGEST=1`` to skip autocomplete.

Stdlib only (urllib).
"""

import argparse
import json
import math
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

SEARCH_URL = "https://www.googleapis.com/youtube/v3/search"
VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos"
SUGGEST_URL = "https://suggestqueries.google.com/complete/search"
MAX_SUGGESTIONS = 10
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


def velocity_weight(video):
    """1.0 for unknown stats, growing with log10(views per hour)."""
    vph = video.get("views_per_hour")
    if not isinstance(vph, (int, float)) or vph <= 0:
        return 1.0
    return 1.0 + math.log10(1.0 + vph)


def extract_keywords(videos, top_n=20):
    """Rank terms from video titles/descriptions.

    Unigrams plus adjacent-token bigrams; score = occurrence count with
    bigrams weighted 1.5x, scaled by each video's view velocity when
    known. Returns [{term, score, sources}].
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
        speed = velocity_weight(video)
        for term in terms:
            weight = (1.5 if " " in term else 1.0) * speed
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


def _get_json(url, timeout):
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", errors="replace"))


def fetch_video_stats(video_ids, api_key, timeout=30):
    """Live view counts for search hits: {video_id: views}. 1 quota unit.

    Returns {} on any failure; velocity then falls back to plain counts.
    """
    ids = [v for v in (video_ids or []) if v][:50]
    if not ids or not (api_key or "").strip():
        return {}
    params = {"part": "statistics", "id": ",".join(ids), "key": api_key}
    try:
        payload = _get_json(f"{VIDEOS_URL}?{urllib.parse.urlencode(params)}",
                            timeout)
    except Exception as exc:
        print(f"trending.py: stats fetch failed ({exc})", file=sys.stderr)
        return {}
    out = {}
    for item in payload.get("items", []) or []:
        stats = item.get("statistics", {}) or {}
        try:
            out[item.get("id", "")] = int(stats.get("viewCount", 0))
        except (TypeError, ValueError):
            continue
    return out


def apply_velocity(videos, views_by_id, now=None):
    """Attach views + views_per_hour (since publish) to each video."""
    now = now or datetime.now(timezone.utc)
    for video in videos or []:
        views = views_by_id.get(video.get("video_id", ""))
        if views is None:
            continue
        video["views"] = views
        try:
            published = datetime.fromisoformat(
                (video.get("published_at") or "").replace("Z", "+00:00"))
        except ValueError:
            continue
        hours = max(1.0, (now - published).total_seconds() / 3600.0)
        video["views_per_hour"] = round(views / hours, 1)
    return videos


def suggest_enabled():
    return os.environ.get("PIXEL_DISABLE_SUGGEST", "").strip() != "1"


def fetch_suggestions(seed, timeout=4, limit=MAX_SUGGESTIONS):
    """YouTube autocomplete phrases for ``seed`` (free, no key).

    These are the searches people actually type. Fail-soft: any network
    or parse problem returns [] so SEO never waits on it.
    """
    seed = " ".join((seed or "").split())[:100]
    if not seed or not suggest_enabled():
        return []
    params = {"client": "firefox", "ds": "yt", "hl": "en", "q": seed}
    try:
        payload = _get_json(f"{SUGGEST_URL}?{urllib.parse.urlencode(params)}",
                            timeout)
    except Exception as exc:
        print(f"trending.py: autocomplete failed ({exc})", file=sys.stderr)
        return []
    if not (isinstance(payload, list) and len(payload) > 1
            and isinstance(payload[1], list)):
        return []
    out = []
    for item in payload[1]:
        text = " ".join(str(item).lower().split())
        if text and text not in out:
            out.append(text)
        if len(out) >= limit:
            break
    return out


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

    queries = fetch_suggestions(niche)

    if not (api_key or "").strip():
        return {"niche": niche, "keywords": [], "videos": [],
                "queries": queries, "fetched_at": None, "cached": False,
                "note": "no YouTube API key configured"}

    try:
        videos = fetch_trending(niche, api_key.strip(), region=region,
                                days=days, max_results=max_results)
    except Exception as exc:
        print(f"trending.py: fetch failed ({exc})", file=sys.stderr)
        return {"niche": niche, "keywords": [], "videos": [],
                "queries": queries, "fetched_at": None, "cached": False,
                "error": str(exc)}

    apply_velocity(videos, fetch_video_stats(
        [v["video_id"] for v in videos], api_key.strip()))
    rising = sorted(videos, key=lambda v: -(v.get("views_per_hour") or 0))
    doc = {
        "niche": niche,
        "keywords": extract_keywords(videos, top_n=top_n),
        "videos": [{"title": v["title"], "channel": v["channel"],
                    "views": v.get("views"),
                    "views_per_hour": v.get("views_per_hour")}
                   for v in rising],
        "queries": queries,
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
