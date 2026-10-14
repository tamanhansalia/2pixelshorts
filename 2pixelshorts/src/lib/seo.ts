import type { SeoMetadata } from "../types/index.ts";

/**
 * Shared frontend SEO core (mirrors `video-use/helpers/seo.py`).
 *
 * Single source of truth for every rule the UI applies to an SEO package:
 * tag budgets, hashtag normalization, per-platform limits, and the honest
 * 0-100 package-quality score. The Metadata step, the Queue re-analyze
 * flow, and the browser fallback in `ipc.ts` all build through here so a
 * rule fixed here holds everywhere the user sees SEO.
 */

export const MAX_SEO_TAGS = 20;
export const MAX_SEO_TAG_CHARS = 500;
export const MAX_SEO_HASHTAGS = 8;
export const TITLE_MAX_CHARS = 100;
export const TITLE_SWEET_SPOT = 60;

/** Per-platform packaging limits (YouTube is the superset). */
export const PLATFORM_LIMITS: Record<
  string,
  { title: number; description: number; hashtags: number }
> = {
  youtube: { title: 100, description: 5000, hashtags: 8 },
  tiktok: { title: 150, description: 2200, hashtags: 8 },
  instagram: { title: 100, description: 2200, hashtags: 10 },
  twitter: { title: 100, description: 280, hashtags: 4 },
  linkedin: { title: 100, description: 3000, hashtags: 5 },
  facebook: { title: 100, description: 5000, hashtags: 5 },
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

/** Normalize one tag into a postable hashtag (`#RustAsync` style). */
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

export interface SeoQuality {
  /** Package quality 0-100 (before retention blending). */
  qualityScore: number;
  /** Headline 0-100 (50/50 quality + retention when retention > 0). */
  score: number;
  retention: number;
  checks: SeoCheck[];
}

function frontloadsKeyword(title: string, keywords: string[]): boolean {
  const first = (title ?? "").trim().toLowerCase();
  return (keywords ?? []).some(
    (k) =>
      k &&
      (first.startsWith(k.toLowerCase()) ||
        first.slice(0, 40).includes(k.toLowerCase())),
  );
}

/**
 * Honest 0-100 package-quality score with a per-check breakdown.
 * Same weights as the engine (`seo.py:score_seo`): title 30, description
 * 30, tags 25, hashtags 15. The UI runs this live over the edited fields
 * so the checklist always reflects what will actually upload.
 */
export function scoreSeoPackage(
  title: string,
  description: string,
  tags: string[],
  hashtags: string[],
  keywords: string[],
  retention = 0,
): SeoQuality {
  const cleanTitle = title ?? "";
  const cleanDesc = description ?? "";
  const cleanTags = [...(tags ?? [])];
  const cleanHashes = [...(hashtags ?? [])];
  const keys = (keywords ?? []).filter(Boolean).map((k) => k.toLowerCase());
  const checks: SeoCheck[] = [];

  // Title (30).
  let titleScore = 0;
  const push = (id: string, got: number, of: number) => {
    checks.push({ id, got, of });
  };
  if (cleanTitle.trim()) {
    titleScore += 7;
    push("title_present", 7, 7);
  } else push("title_present", 0, 7);
  if (frontloadsKeyword(cleanTitle, keys)) {
    titleScore += 10;
    push("title_keyword_frontload", 10, 10);
  } else push("title_keyword_frontload", 0, 10);
  if (cleanTitle.length >= 20 && cleanTitle.length <= TITLE_SWEET_SPOT) {
    titleScore += 8;
    push("title_length", 8, 8);
  } else if (cleanTitle && cleanTitle.length <= TITLE_MAX_CHARS) {
    titleScore += 4;
    push("title_length", 4, 8);
  } else push("title_length", 0, 8);
  const lowered = cleanTitle.toLowerCase();
  if (
    cleanTitle &&
    (/^(how|why|stop|this|the|what)/.test(lowered) ||
      cleanTitle.includes("?") ||
      cleanTitle.includes("(") ||
      /\d/.test(cleanTitle))
  ) {
    titleScore += 5;
    push("title_ctr_shape", 5, 5);
  } else push("title_ctr_shape", 0, 5);
  if (cleanTitle.length > TITLE_MAX_CHARS) {
    titleScore = Math.max(0, titleScore - 5);
    push("title_over_limit", -5, 0);
  } else push("title_over_limit", 0, 0);

  // Description (30).
  let descScore = 0;
  if (cleanDesc.trim().length >= 100) {
    descScore += 8;
    push("description_length", 8, 8);
  } else if (cleanDesc.trim()) {
    descScore += 3;
    push("description_length", 3, 8);
  } else push("description_length", 0, 8);
  if (cleanDesc.includes("Search Keywords:")) {
    descScore += 10;
    push("description_keyword_block", 10, 10);
  } else push("description_keyword_block", 0, 10);
  if (cleanHashes.slice(0, 3).some((h) => cleanDesc.includes(h))) {
    descScore += 7;
    push("description_hashtag_line", 7, 7);
  } else push("description_hashtag_line", 0, 7);
  const upper = cleanDesc.toUpperCase();
  if (
    upper.includes("SUBSCRIBE") ||
    upper.includes("FOLLOW") ||
    cleanDesc.includes("👉")
  ) {
    descScore += 5;
    push("description_cta", 5, 5);
  } else push("description_cta", 0, 5);

  // Tags (25).
  let tagScore = 0;
  if (cleanTags.length >= 15) {
    tagScore += 10;
    push("tags_depth", 10, 10);
  } else if (cleanTags.length >= 8) {
    tagScore += 6;
    push("tags_depth", 6, 10);
  } else if (cleanTags.length > 0) {
    tagScore += 2;
    push("tags_depth", 2, 10);
  } else push("tags_depth", 0, 10);
  const joined = cleanTags.join(", ");
  if (joined.length >= 200) {
    tagScore += 5;
    push("tags_budget_fill", 5, 5);
  } else if (cleanTags.length > 0) {
    tagScore += 2;
    push("tags_budget_fill", 2, 5);
  } else push("tags_budget_fill", 0, 5);
  if (keys.length > 0) {
    const covered = keys.filter((k) =>
      cleanTags.some((t) => t.toLowerCase().includes(k)),
    ).length;
    const coverage = Math.round((10 * covered) / Math.max(1, keys.length));
    tagScore += coverage;
    push("tags_keyword_coverage", coverage, 10);
  } else push("tags_keyword_coverage", 0, 10);

  // Hashtags (15).
  let hashScore = 0;
  if (cleanHashes.length >= 3 && cleanHashes.length <= MAX_SEO_HASHTAGS) {
    hashScore += 10;
    push("hashtags_count", 10, 10);
  } else if (cleanHashes.length > 0) {
    hashScore += 4;
    push("hashtags_count", 4, 10);
  } else push("hashtags_count", 0, 10);
  if (
    cleanHashes.length > 0 &&
    cleanHashes.every((h) => h.startsWith("#"))
  ) {
    hashScore += 5;
    push("hashtags_postable", 5, 5);
  } else push("hashtags_postable", 0, 5);

  const qualityScore = Math.min(
    100,
    Math.max(0, titleScore + descScore + tagScore + hashScore),
  );
  const safeRetention = Math.min(100, Math.max(0, Math.round(retention) || 0));
  return {
    qualityScore,
    score:
      safeRetention > 0
        ? Math.round(qualityScore * 0.5 + safeRetention * 0.5)
        : qualityScore,
    retention: safeRetention,
    checks,
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
