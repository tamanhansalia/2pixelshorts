import type { ScheduleItem } from "../types/index.ts";
import type { KeyValueStorage } from "./channelProfiles.ts";

/**
 * Post performance: the feedback loop for SEO.
 *
 * Published queue rows carry a Zernio post id; `GET /v1/analytics?postId=`
 * returns views/likes/comments/shares per platform. Records live here (not
 * on queue rows, which get cleared) so the history outlives the queue.
 *
 * Ranking follows the youtube-agent-skill `swipe.py` rule (MIT, Jake
 * Schincariol): a post is judged as a multiple of the channel's own median,
 * never by raw views, and only once there are enough posts for a median to
 * mean anything. The winners feed back into the SEO prompt as "titles that
 * worked on this channel", and posting hours rank by median views.
 */

export const PERFORMANCE_KEY = "2pixel_post_performance";
export const TREND_SIGNALS_KEY = "2pixel_trend_signals";
/** A median of fewer posts is noise, not a baseline. */
export const MIN_POSTS_FOR_MEDIAN = 4;
export const WINNER_MULTIPLE = 1.5;
const MAX_RECORDS = 500;
const HOUR_MS = 3_600_000;

export interface PlatformMetrics {
  platform: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  url?: string;
}

export interface PostMetrics {
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  engagementRate: number | null;
  url?: string;
  platforms: PlatformMetrics[];
}

export interface PerformanceRecord {
  postId: string;
  title: string;
  /** When the post went (or was scheduled to go) live, ISO 8601. */
  publishedAt: string;
  platforms: string[];
  metrics: PostMetrics | null;
  fetchedAt: string | null;
  /** Zernio answered 202: metrics are still syncing. */
  pending?: boolean;
  error?: string | null;
}

export type PerformanceRecords = Record<string, PerformanceRecord>;

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function metricsFrom(obj: Record<string, unknown> | undefined) {
  const a = (obj ?? {}) as Record<string, unknown>;
  return {
    views: num(a.views),
    likes: num(a.likes),
    comments: num(a.comments),
    shares: num(a.shares),
    saves: num(a.saves),
    engagementRate:
      typeof a.engagementRate === "number" && Number.isFinite(a.engagementRate)
        ? a.engagementRate
        : null,
  };
}

/**
 * Parse a Zernio analytics body. Returns `"pending"` while metrics sync,
 * `null` when the body carries no recognisable analytics.
 */
export function parseAnalytics(text: string): PostMetrics | "pending" | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object") return null;
  const root = doc as Record<string, unknown>;
  if (root.pending === true) return "pending";
  // Single-post body; tolerate a `{data: ...}` or `{posts: [x]}` envelope.
  const post = (
    root.analytics || root.platformAnalytics
      ? root
      : (root.data as Record<string, unknown>) ??
        (Array.isArray(root.posts) ? root.posts[0] : undefined)
  ) as Record<string, unknown> | undefined;
  if (!post || (!post.analytics && !post.platformAnalytics)) return null;
  const platforms: PlatformMetrics[] = Array.isArray(post.platformAnalytics)
    ? (post.platformAnalytics as Record<string, unknown>[]).map((entry) => {
        const m = metricsFrom(entry.analytics as Record<string, unknown>);
        return {
          platform: String(entry.platform ?? "unknown"),
          views: m.views,
          likes: m.likes,
          comments: m.comments,
          shares: m.shares,
          url:
            typeof entry.platformPostUrl === "string"
              ? entry.platformPostUrl
              : undefined,
        };
      })
    : [];
  const total = metricsFrom(post.analytics as Record<string, unknown>);
  // Some bodies only fill per-platform numbers; sum them as the total.
  if (!post.analytics && platforms.length) {
    for (const p of platforms) {
      total.views += p.views;
      total.likes += p.likes;
      total.comments += p.comments;
      total.shares += p.shares;
    }
  }
  return {
    ...total,
    url:
      typeof post.platformPostUrl === "string"
        ? post.platformPostUrl
        : platforms.find((p) => p.url)?.url,
    platforms,
  };
}

/** Start tracking every published queue row that has a gateway post id. */
export function trackPublished(
  records: PerformanceRecords,
  queue: Pick<
    ScheduleItem,
    "post_id" | "status" | "title" | "scheduled_for" | "created_at" | "platforms"
  >[],
): PerformanceRecords {
  let next = records;
  for (const item of queue) {
    const id = (item.post_id ?? "").trim();
    if (!id || item.status !== "completed" || next[id]) continue;
    if (next === records) next = { ...records };
    next[id] = {
      postId: id,
      title: item.title,
      publishedAt: item.scheduled_for || item.created_at,
      platforms: [...(item.platforms ?? [])],
      metrics: null,
      fetchedAt: null,
    };
  }
  return next;
}

/**
 * Refresh cadence: hourly-ish while a post is young, daily for a month,
 * then frozen (Shorts settle; old numbers stop changing decisions).
 */
export function needsRefresh(record: PerformanceRecord, now: Date): boolean {
  const published = Date.parse(record.publishedAt);
  if (Number.isFinite(published) && published > now.getTime()) return false;
  if (!record.fetchedAt) return true;
  const fetched = Date.parse(record.fetchedAt);
  if (!Number.isFinite(fetched)) return true;
  const age = Number.isFinite(published) ? now.getTime() - published : 0;
  const since = now.getTime() - fetched;
  if (age < 72 * HOUR_MS) return since >= 6 * HOUR_MS;
  if (age < 30 * 24 * HOUR_MS) return since >= 24 * HOUR_MS;
  return false;
}

export function applyMetrics(
  records: PerformanceRecords,
  postId: string,
  result: PostMetrics | "pending" | null,
  now: Date,
  error: string | null = null,
): PerformanceRecords {
  const prev = records[postId];
  if (!prev) return records;
  return {
    ...records,
    [postId]: {
      ...prev,
      metrics:
        result && result !== "pending" ? result : prev.metrics,
      pending: result === "pending",
      fetchedAt: now.toISOString(),
      error,
    },
  };
}

export function median(values: number[]): number {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface RankedPost {
  record: PerformanceRecord;
  views: number;
  /** Views as a multiple of the channel median (null below the minimum). */
  multiple: number | null;
}

/** Posts with metrics, best first, each scored against the channel median. */
export function rankPosts(records: PerformanceRecords): {
  median: number;
  ranked: RankedPost[];
} {
  const withViews = Object.values(records).filter((r) => r.metrics);
  const baseline =
    withViews.length >= MIN_POSTS_FOR_MEDIAN
      ? median(withViews.map((r) => r.metrics!.views))
      : 0;
  const ranked = withViews
    .map((record) => {
      const views = record.metrics!.views;
      return {
        record,
        views,
        multiple: baseline > 0 ? Math.round((views / baseline) * 10) / 10 : null,
      };
    })
    .sort((a, b) => b.views - a.views);
  return { median: baseline, ranked };
}

/** Titles that beat the channel median by WINNER_MULTIPLE, best first. */
export function winningTitles(records: PerformanceRecords, limit = 5): string[] {
  const out: string[] = [];
  const { median: baseline, ranked } = rankPosts(records);
  if (baseline <= 0) return out;
  for (const row of ranked) {
    // Exact ratio: the display multiple is rounded and would let 1.49x in.
    if (row.views / baseline < WINNER_MULTIPLE) continue;
    const title = row.record.title.trim();
    if (title && !out.includes(title)) out.push(title);
    if (out.length >= limit) break;
  }
  return out;
}

export interface HourSlot {
  /** Local hour of day, 0-23. */
  hour: number;
  posts: number;
  medianViews: number;
}

/** Local posting hours ranked by median views (2+ posts per hour). */
export function bestPostingHours(records: PerformanceRecords): HourSlot[] {
  const byHour = new Map<number, number[]>();
  for (const r of Object.values(records)) {
    if (!r.metrics) continue;
    const t = new Date(r.publishedAt);
    if (Number.isNaN(t.getTime())) continue;
    const list = byHour.get(t.getHours()) ?? [];
    list.push(r.metrics.views);
    byHour.set(t.getHours(), list);
  }
  return [...byHour.entries()]
    .filter(([, views]) => views.length >= 2)
    .map(([hour, views]) => ({
      hour,
      posts: views.length,
      medianViews: median(views),
    }))
    .sort((a, b) => b.medianViews - a.medianViews);
}

export interface TrendSignals {
  niche: string;
  terms: string[];
  queries: string[];
  savedAt: string;
}

export function createPerformanceStore(storage: KeyValueStorage) {
  return {
    load(): PerformanceRecords {
      try {
        const raw = storage.getItem(PERFORMANCE_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as PerformanceRecords)
          : {};
      } catch {
        return {};
      }
    },
    save(records: PerformanceRecords): void {
      try {
        // Keep the newest posts when the history grows past the cap.
        const rows = Object.values(records)
          .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
          .slice(0, MAX_RECORDS);
        storage.setItem(
          PERFORMANCE_KEY,
          JSON.stringify(Object.fromEntries(rows.map((r) => [r.postId, r]))),
        );
      } catch {
        // Storage full or blocked; metrics re-fetch next session.
      }
    },
    loadTrends(): TrendSignals | null {
      try {
        const raw = storage.getItem(TREND_SIGNALS_KEY);
        return raw ? (JSON.parse(raw) as TrendSignals) : null;
      } catch {
        return null;
      }
    },
    saveTrends(signals: TrendSignals): void {
      try {
        storage.setItem(TREND_SIGNALS_KEY, JSON.stringify(signals));
      } catch {
        // Non-critical: the next fetch saves again.
      }
    },
  };
}

function defaultStore() {
  const storage: KeyValueStorage | null =
    typeof localStorage !== "undefined" ? localStorage : null;
  return storage ? createPerformanceStore(storage) : null;
}

export const loadPerformance = (): PerformanceRecords =>
  defaultStore()?.load() ?? {};
export const savePerformance = (records: PerformanceRecords) =>
  defaultStore()?.save(records);
export const saveTrendSignals = (signals: TrendSignals) =>
  defaultStore()?.saveTrends(signals);

/**
 * Market signals for every SEO run: the last fetched niche trends (a week
 * at most) and this channel's own winning titles.
 */
export function seoSignals(
  store = defaultStore(),
  now = new Date(),
): { trendTerms: string[]; winningTitles: string[] } {
  if (!store) return { trendTerms: [], winningTitles: [] };
  const trends = store.loadTrends();
  const fresh =
    trends && now.getTime() - Date.parse(trends.savedAt) < 7 * 24 * HOUR_MS;
  return {
    trendTerms: fresh ? [...trends!.terms].slice(0, 10) : [],
    winningTitles: winningTitles(store.load()),
  };
}
