import type { SeoMetadata } from "../types/index.ts";

/**
 * Shared frontend SEO core (mirrors `video-use/helpers/seo.py`).
 *
 * Single source of truth for every rule the UI applies to an SEO package:
 * tag budgets, hashtag normalization, per-platform limits, the hook and
 * title linters, and the honest 0-100 package-quality score. The Metadata
 * step, the Queue re-analyze flow, and the browser fallback in `ipc.ts`
 * all build through here so a rule fixed here holds everywhere the user
 * sees SEO.
 *
 * The hook scorer and title linter are adapted from the MIT-licensed
 * youtube-agent-skill by Jake Schincariol
 * (https://github.com/Jakeschincariol/youtube-agent-skill).
 */

export const MAX_SEO_TAGS = 15;
export const MAX_SEO_TAG_CHARS = 500;
export const MAX_SEO_HASHTAGS = 5;
export const TITLE_MAX_CHARS = 100;
export const TITLE_SWEET_SPOT = 60;
export const TITLE_MOBILE_CHARS = 40;
export const DESCRIPTION_FOLD_CHARS = 150;

/** What a phone / desktop feed actually shows for this title. */
export function feedTruncation(title: string): {
  chars: number;
  mobile: string;
  desktop: string;
  mobileFits: boolean;
  desktopFits: boolean;
} {
  const text = title ?? "";
  const cut = (value: string, limit: number) =>
    value.length <= limit ? value : `${value.slice(0, limit).trimEnd()}…`;
  return {
    chars: text.length,
    mobile: cut(text, TITLE_MOBILE_CHARS),
    desktop: cut(text, TITLE_SWEET_SPOT),
    mobileFits: text.length <= TITLE_MOBILE_CHARS,
    desktopFits: text.length <= TITLE_SWEET_SPOT,
  };
}

/** Per-platform packaging limits (YouTube is the superset). */
export const PLATFORM_LIMITS: Record<
  string,
  { title: number; description: number; hashtags: number }
> = {
  youtube: { title: 100, description: 5000, hashtags: 5 },
  tiktok: { title: 150, description: 2200, hashtags: 5 },
  instagram: { title: 100, description: 2200, hashtags: 5 },
  twitter: { title: 100, description: 280, hashtags: 2 },
  linkedin: { title: 100, description: 3000, hashtags: 3 },
  facebook: { title: 100, description: 5000, hashtags: 3 },
};

export function platformLimits(platformId: string): {
  title: number;
  description: number;
  hashtags: number;
} {
  return (
    PLATFORM_LIMITS[platformId.toLowerCase()] ?? {
      title: TITLE_MAX_CHARS,
      description: 5000,
      hashtags: MAX_SEO_HASHTAGS,
    }
  );
}

/** Normalize one tag into a postable hashtag (`#rustasync` style). */
export function normalizeHashtag(tag: string, limit = 30): string {
  let text = (tag ?? "").trim().toLowerCase().replace(/_/g, " ");
  text = text.replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, "");
  if (!text) return "";
  if (/^[0-9]/.test(text)) text = `t${text}`;
  return `#${text.slice(0, limit)}`;
}

/**
 * Derive a clean, deduped hashtag list. Explicit hashtags win; anything
 * missing is backfilled from the tags so a package never ships without a
 * hashtag line.
 */
export function normalizeHashtags(
  tags: string[],
  hashtags: string[] = [],
  limit: number = MAX_SEO_HASHTAGS,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const candidates = [
    ...hashtags,
    ...(tags ?? []).map((t) => `#${t ?? ""}`),
  ];
  for (const raw of candidates) {
    let text = (raw ?? "").trim();
    if (!text) continue;
    if (!text.startsWith("#")) text = `#${text}`;
    const norm = normalizeHashtag(text.slice(1));
    if (!norm || seen.has(norm.toLowerCase())) continue;
    seen.add(norm.toLowerCase());
    out.push(norm);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Keep the most important tags that fit the character budget.
 * Case-insensitive dedupe, blanks dropped, order preserved (callers pass
 * most-important-first). The ", " separator counts against the budget.
 */
export function fitTagBudget(
  tags: string[],
  budget: number = MAX_SEO_TAG_CHARS,
  limit: number = MAX_SEO_TAGS,
): string[] {
  const kept: string[] = [];
  const seen = new Set<string>();
  let used = 0;
  for (const raw of tags ?? []) {
    const tag = (raw ?? "").trim();
    if (!tag || seen.has(tag.toLowerCase())) continue;
    const need = tag.length + (kept.length > 0 ? 2 : 0);
    if (used + need > budget || kept.length >= limit) break;
    seen.add(tag.toLowerCase());
    kept.push(tag);
    used += need;
  }
  return kept;
}

/** Trim a title on word boundaries (ellipsis when cut). */
export function trimTitle(text: string, limit: number = TITLE_MAX_CHARS): string {
  const clean = (text ?? "").trim();
  if (clean.length <= limit) return clean;
  let cut = clean.slice(0, Math.max(0, limit - 3)).trimEnd();
  const space = cut.lastIndexOf(" ");
  if (space > 0) cut = cut.slice(0, space);
  return `${cut.trimEnd()}...`;
}

export interface SeoCheck {
  id: string;
  got: number;
  of: number;
}

export interface HookPanel {
  verdict: number;
  band: "STRONG" | "WORKABLE" | "WEAK";
  properties: Record<HookProperty, number>;
  weakest: HookProperty;
  fix: string;
}

export interface SeoQuality {
  /** Package quality 0-100 (before retention blending). */
  qualityScore: number;
  /** Headline 0-100 (50/50 quality + retention when retention > 0). */
  score: number;
  retention: number;
  hook: HookPanel;
  checks: SeoCheck[];
}

const VAGUE_WORDS = new Set(
  "amazing incredible insane crazy huge massive ultimate best powerful secret revolutionary mindblowing epic perfect complete everything unbelievable".split(
    " ",
  ),
);
const TITLE_FILLER = new Set(
  "the a an of for to in on and or is are with your you my i this that it how what why".split(
    " ",
  ),
);
const HOOK_FILLER = new Set(
  "basically actually literally just really very so kind sort like guys hey welcome today video subscribe channel".split(
    " ",
  ),
);
const CONCRETE =
  /\b(\d[\d,.]*\s?(%|k|m|x|s|h)?|\$\d|\d+\s?(second|minute|hour|day|week|month|year)s?)\b/gi;
const YOU = /\b(you|your|you're|youre|yourself)\b/gi;
const STAKE =
  /\b(lose|lost|wasting|waste|quit|fail|broke|cost|risk|before|stop|never|die|dying|dead|wrong|mistake)\b/gi;
const CURIOSITY =
  /\b(why|how|what|which|until|before|but|nobody|almost|except|reason|actually)\b/gi;
const KEYWORD_BLOCK = /search keywords\s*:/i;

function words(text: string): string[] {
  return (text ?? "").toLowerCase().match(/[a-z0-9']+/g) ?? [];
}

function countMatches(re: RegExp, text: string): number {
  return (text.match(re) ?? []).length;
}

const clamp = (n: number) => Math.max(0, Math.min(100, n));

/**
 * True when `text` carries the words of at least one query: at least half
 * of a query's content words (and at least one) must appear.
 */
export function queryHit(text: string, queries: string[]): boolean {
  const have = new Set(words(text));
  for (const query of queries ?? []) {
    const content = words(query).filter((w) => !TITLE_FILLER.has(w));
    if (content.length === 0) continue;
    const hits = content.filter((w) => have.has(w)).length;
    if (hits >= Math.max(1, Math.floor((content.length + 1) / 2))) return true;
  }
  return false;
}

export type HookProperty =
  | "specificity"
  | "address"
  | "stakes"
  | "curiosity"
  | "brevity";

export const HOOK_FIXES: Record<HookProperty, string> = {
  specificity: "swap an adjective for a number, a name or a date",
  address: "say 'you' in the first six words",
  stakes: "name what it costs them to keep doing it the current way",
  curiosity: "cut the half of the sentence that answers itself",
  brevity: "9 to 24 words; stop where you run out of breath",
};

/** Five-property hook panel; verdict = 60% mean + 40% weakest. */
export function scoreHook(raw: string): HookPanel {
  const text = (raw ?? "").trim();
  const w = words(text);
  const nums = countMatches(CONCRETE, text);
  const specificity = w.length
    ? clamp(
        34 +
          nums * 22 -
          w.filter((x) => VAGUE_WORDS.has(x)).length * 16 -
          w.filter((x) => HOOK_FILLER.has(x)).length * 5 +
          Math.min(
            18,
            6 *
              text
                .split(/\s+/)
                .slice(1)
                .filter((x) => /^[A-Z]/.test(x)).length,
          ),
      )
    : 0;
  const address = clamp(
    26 +
      countMatches(YOU, text) * 20 +
      (new RegExp(YOU.source, "i").test(text.split(/\s+/).slice(0, 6).join(" "))
        ? 30
        : 0),
  );
  const stakes = clamp(22 + countMatches(STAKE, text) * 26 + (nums > 0 ? 14 : 0));
  const curiosity = clamp(
    24 +
      countMatches(CURIOSITY, text) * 17 +
      (text.endsWith("?") ? 18 : 0) -
      (/\b(because|so that|which means)\b/i.test(text) ? 18 : 0),
  );
  const n = w.length;
  const brevity =
    n === 0
      ? 0
      : n >= 9 && n <= 24
        ? 100
        : n < 9
          ? Math.max(30, 100 - (9 - n) * 11)
          : Math.max(10, 100 - (n - 24) * 7);
  const properties: Record<HookProperty, number> = {
    specificity,
    address,
    stakes,
    curiosity,
    brevity,
  };
  if (!text) {
    return {
      verdict: 0,
      band: "WEAK",
      properties,
      weakest: "brevity",
      fix: HOOK_FIXES.brevity,
    };
  }
  const values = Object.values(properties);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  // Python rounds half to even; the 0.5 tie is rare enough to ignore here.
  const verdict = Math.round(0.6 * mean + 0.4 * Math.min(...values));
  let weakest: HookProperty = "specificity";
  for (const key of Object.keys(properties) as HookProperty[]) {
    if (properties[key] < properties[weakest]) weakest = key;
  }
  return {
    verdict,
    band: verdict >= 72 ? "STRONG" : verdict >= 55 ? "WORKABLE" : "WEAK",
    properties,
    weakest,
    fix: HOOK_FIXES[weakest],
  };
}

export interface TitleLint {
  chars: number;
  mobileFit: boolean;
  desktopFit: boolean;
  shouting: boolean;
  vague: string[];
  concrete: boolean;
  frontLoaded: boolean;
}

/** Title issues a viewer would feel: truncation, shouting, vagueness. */
export function lintTitle(title: string): TitleLint {
  const text = (title ?? "").trim();
  const w = words(text);
  const tokens = text.split(/\s+/).filter(Boolean);
  const caps = tokens.filter((t) => t.length > 2 && t === t.toUpperCase() && /[A-Z]/.test(t));
  return {
    chars: text.length,
    mobileFit: text.length <= TITLE_MOBILE_CHARS,
    desktopFit: text.length <= TITLE_SWEET_SPOT,
    shouting: caps.length > 2,
    vague: [...new Set(w.filter((x) => VAGUE_WORDS.has(x)))].sort(),
    concrete:
      /\d/.test(text) ||
      text.endsWith("?") ||
      tokens
        .slice(1)
        .some((t) => /^[A-Z]/.test(t) && t !== t.toUpperCase()),
    frontLoaded: w.slice(0, 3).some((x) => !TITLE_FILLER.has(x)),
  };
}

function firstLine(text: string): string {
  return (
    (text ?? "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? ""
  );
}

/**
 * Honest 0-100 package-quality score with a per-check breakdown.
 * Same weights as the engine (`seo.py:score_seo`): title 40, hook 15,
 * description 30, hashtags 10, tags 5. `queries` are the searches this
 * short should win; `keywords` stand in when none are known. The UI runs
 * this live over the edited fields so the checklist always reflects what
 * will actually upload.
 */
export function scoreSeoPackage(
  title: string,
  description: string,
  tags: string[],
  hashtags: string[],
  keywords: string[],
  retention = 0,
  opts: { hook?: string; queries?: string[] } = {},
): SeoQuality {
  const cleanTitle = title ?? "";
  const cleanDesc = description ?? "";
  const cleanTags = [...(tags ?? [])];
  const cleanHashes = [...(hashtags ?? [])];
  const queries = (opts.queries ?? []).filter(Boolean);
  const targets = queries.length ? queries : (keywords ?? []).filter(Boolean);
  const checks: SeoCheck[] = [];
  const add = (id: string, got: number, of: number) => {
    checks.push({ id, got, of });
    return got;
  };

  // Title (40).
  const lint = lintTitle(cleanTitle);
  const present = cleanTitle.trim().length > 0;
  let titleScore = add("title_present", present ? 5 : 0, 5);
  const fit = !present
    ? 0
    : lint.mobileFit
      ? 8
      : lint.desktopFit
        ? 5
        : lint.chars <= TITLE_MAX_CHARS
          ? 2
          : 0;
  titleScore += add("title_mobile_fit", fit, 8);
  titleScore += add(
    "title_query_match",
    present && queryHit(cleanTitle, targets) ? 12 : 0,
    12,
  );
  const concrete = !present
    ? 0
    : lint.concrete && lint.vague.length === 0
      ? 8
      : lint.concrete || lint.vague.length === 0
        ? 4
        : 0;
  titleScore += add("title_concrete", concrete, 8);
  titleScore += add("title_not_shouting", present && !lint.shouting ? 4 : 0, 4);
  titleScore += add("title_front_loaded", present && lint.frontLoaded ? 3 : 0, 3);
  if (lint.chars > TITLE_MAX_CHARS) {
    titleScore = Math.max(0, titleScore - 5);
    add("title_over_limit", -5, 0);
  } else add("title_over_limit", 0, 0);

  // Hook (15): the spoken opener, else the description's first line.
  const hook = scoreHook((opts.hook ?? "").trim() || firstLine(cleanDesc));
  const hookScore = add("hook_strength", Math.round((15 * hook.verdict) / 100), 15);

  // Description (30).
  const body = cleanDesc.trim();
  const fold = body.slice(0, DESCRIPTION_FOLD_CHARS);
  let descScore = add(
    "description_above_fold",
    fold && queryHit(fold, targets) ? 15 : 0,
    15,
  );
  descScore += add("description_length", body.length >= 100 ? 5 : body ? 2 : 0, 5);
  descScore += add(
    "description_hashtags",
    cleanHashes.slice(0, 3).some((h) => cleanDesc.includes(h)) ? 5 : 0,
    5,
  );
  const stuffed =
    KEYWORD_BLOCK.test(cleanDesc) ||
    cleanDesc.split(/\r?\n/).some((l) => (l.match(/,/g) ?? []).length >= 8);
  descScore += add("description_no_stuffing", body && !stuffed ? 5 : 0, 5);

  // Hashtags (10).
  const count =
    cleanHashes.length >= 3 && cleanHashes.length <= MAX_SEO_HASHTAGS
      ? 7
      : cleanHashes.length > 0 && cleanHashes.length <= 8
        ? 4
        : cleanHashes.length > 0
          ? 1
          : 0;
  let hashScore = add("hashtags_count", count, 7);
  hashScore += add(
    "hashtags_postable",
    cleanHashes.length > 0 && cleanHashes.every((h) => h.startsWith("#")) ? 3 : 0,
    3,
  );

  // Tags (5).
  const tagScore = add(
    "tags_present",
    cleanTags.length >= 5 && cleanTags.length <= MAX_SEO_TAGS
      ? 5
      : cleanTags.length > 0
        ? 3
        : 0,
    5,
  );

  const qualityScore = Math.min(
    100,
    Math.max(0, titleScore + hookScore + descScore + hashScore + tagScore),
  );
  const safeRetention = Math.min(100, Math.max(0, Math.round(retention) || 0));
  return {
    qualityScore,
    score:
      safeRetention > 0
        ? Math.round(qualityScore * 0.5 + safeRetention * 0.5)
        : qualityScore,
    retention: safeRetention,
    hook,
    checks,
  };
}

/**
 * Queries the live checklist may treat as search demand.
 *
 * `demand_queries` present, even when empty, means the engine already
 * decided which phrases are real searches. Spoken keywords must not
 * stand in for them. Older packages omit the field and keep the
 * previous keyword fallback.
 */
export function packageQueryTargets(
  meta: {
    demand_queries?: string[] | null;
    search_queries?: string[] | null;
    keywords_analyzed?: string[] | null;
  } | null | undefined,
): { queries: string[]; keywords: string[] } {
  if (!meta) return { queries: [], keywords: [] };
  if (Array.isArray(meta.demand_queries)) {
    return {
      queries: meta.demand_queries.filter(Boolean),
      keywords: [],
    };
  }
  return {
    queries: (meta.search_queries ?? []).filter(Boolean),
    keywords: (meta.keywords_analyzed ?? []).filter(Boolean),
  };
}

/** Full SEO payload carried from analysis to upload (nothing dropped). */
export interface FullSeoPatch {
  title: string;
  description: string;
  tags: string[];
  hashtags: string[];
  titleAlternatives: string[];
  keywords: string[];
  /** The 3 searches this short should win (engine `search_queries`). */
  searchQueries: string[];
  /** Pinned first comment suggestion (YouTube). */
  pinnedComment: string;
  /** Measured retention figure from the engine (`seo_score`). */
  retentionScore: number | null;
  /** Package-quality figure from the engine (`quality_score`). */
  qualityScore: number | null;
}

/**
 * Map a fresh SEO review onto the full patch (platforms/schedule
 * untouched). Hashtags and alternates survive the trip now — they used
 * to be dropped here, so background completions silently lost the AI's
 * best spares.
 */
export function buildFullSeoPatch(
  seo: Pick<
    SeoMetadata,
    | "title"
    | "description"
    | "tags"
    | "hashtags"
    | "title_alternatives"
    | "keywords_analyzed"
    | "seo_score"
    | "search_queries"
    | "pinned_comment"
  > & { quality_score?: number | null },
): FullSeoPatch {
  const tags = [...(seo.tags ?? [])];
  return {
    title: seo.title,
    description: seo.description,
    tags,
    hashtags: normalizeHashtags(tags, seo.hashtags ?? []),
    titleAlternatives: [...(seo.title_alternatives ?? [])],
    keywords: [...(seo.keywords_analyzed ?? [])],
    searchQueries: [...(seo.search_queries ?? [])],
    pinnedComment: seo.pinned_comment ?? "",
    retentionScore: typeof seo.seo_score === "number" ? seo.seo_score : null,
    qualityScore:
      typeof seo.quality_score === "number" ? seo.quality_score : null,
  };
}

/**
 * Merge trending terms into a tag bench without flooding it: missing
 * terms only (case-insensitive), most important first, budget-capped.
 */
export function mergeTrendingTerms(
  tags: string[],
  trendingTerms: string[],
  maxNew = 3,
): string[] {
  const existing = new Set((tags ?? []).map((t) => t.trim().toLowerCase()));
  const merged = [...(tags ?? [])];
  let added = 0;
  for (const raw of trendingTerms ?? []) {
    const term = (raw ?? "").trim();
    if (!term || existing.has(term.toLowerCase())) continue;
    merged.push(term);
    existing.add(term.toLowerCase());
    added += 1;
    if (added >= maxNew) break;
  }
  return fitTagBudget(merged);
}
