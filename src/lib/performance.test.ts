import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyMetrics,
  bestPostingHours,
  createPerformanceStore,
  median,
  needsRefresh,
  parseAnalytics,
  rankPosts,
  seoSignals,
  trackPublished,
  winningTitles,
  type PerformanceRecord,
  type PerformanceRecords,
} from "./performance.ts";

function memory() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

function record(id: string, views: number | null, title = id, publishedAt = "2026-10-01T15:00:00"): PerformanceRecord {
  return {
    postId: id,
    title,
    publishedAt,
    platforms: ["youtube"],
    metrics:
      views === null
        ? null
        : { views, likes: 1, comments: 0, shares: 0, saves: 0, engagementRate: null, platforms: [] },
    fetchedAt: null,
  };
}

function records(...rows: PerformanceRecord[]): PerformanceRecords {
  return Object.fromEntries(rows.map((r) => [r.postId, r]));
}

describe("parseAnalytics", () => {
  it("reads post totals and per-platform links", () => {
    const text = JSON.stringify({
      postId: "p1",
      analytics: { views: 1200, likes: 40, comments: 5, shares: 2, saves: 1, engagementRate: 3.9 },
      platformAnalytics: [
        {
          platform: "youtube",
          platformPostUrl: "https://youtube.com/shorts/abc",
          analytics: { views: 1200, likes: 40, comments: 5, shares: 2 },
        },
      ],
    });
    const m = parseAnalytics(text);
    assert.ok(m && m !== "pending");
    assert.equal(m.views, 1200);
    assert.equal(m.engagementRate, 3.9);
    assert.equal(m.url, "https://youtube.com/shorts/abc");
    assert.equal(m.platforms[0].platform, "youtube");
  });

  it("sums platform numbers when totals are missing", () => {
    const m = parseAnalytics(
      JSON.stringify({
        platformAnalytics: [
          { platform: "youtube", analytics: { views: 10 } },
          { platform: "tiktok", analytics: { views: 5, likes: 2 } },
        ],
      }),
    );
    assert.ok(m && m !== "pending");
    assert.equal(m.views, 15);
    assert.equal(m.likes, 2);
  });

  it("flags pending syncs and rejects junk", () => {
    assert.equal(parseAnalytics('{"pending":true}'), "pending");
    assert.equal(parseAnalytics("not json"), null);
    assert.equal(parseAnalytics('{"message":"ok"}'), null);
  });
});

describe("tracking + refresh", () => {
  it("tracks only completed rows with a post id, once", () => {
    const queue = [
      { post_id: "p1", status: "completed" as const, title: "A", scheduled_for: "2026-10-01T10:00:00Z", created_at: "", platforms: ["youtube"] },
      { post_id: "", status: "completed" as const, title: "B", scheduled_for: "", created_at: "", platforms: [] },
      { post_id: "p3", status: "queued" as const, title: "C", scheduled_for: "", created_at: "", platforms: [] },
    ];
    const first = trackPublished({}, queue);
    assert.deepEqual(Object.keys(first), ["p1"]);
    assert.equal(trackPublished(first, queue), first);
  });

  it("refreshes young posts often, older daily, then stops", () => {
    const now = new Date("2026-10-19T12:00:00Z");
    const young = { ...record("a", 1, "a", "2026-10-19T00:00:00Z"), fetchedAt: "2026-10-19T07:00:00Z" };
    assert.equal(needsRefresh(young, now), false);
    assert.equal(needsRefresh({ ...young, fetchedAt: "2026-10-19T05:00:00Z" }, now), true);
    const week = { ...record("b", 1, "b", "2026-10-12T00:00:00Z"), fetchedAt: "2026-10-19T00:00:00Z" };
    assert.equal(needsRefresh(week, now), false);
    assert.equal(needsRefresh({ ...week, fetchedAt: "2026-10-18T00:00:00Z" }, now), true);
    const old = { ...record("c", 1, "c", "2026-08-01T00:00:00Z"), fetchedAt: "2026-09-01T00:00:00Z" };
    assert.equal(needsRefresh(old, now), false);
    assert.equal(needsRefresh({ ...old, fetchedAt: null }, now), true);
    const future = record("d", null, "d", "2026-11-01T00:00:00Z");
    assert.equal(needsRefresh(future, now), false);
  });

  it("keeps the last metrics while a sync is pending", () => {
    const start = records(record("a", 50));
    const next = applyMetrics(start, "a", "pending", new Date());
    assert.equal(next.a.metrics?.views, 50);
    assert.equal(next.a.pending, true);
    assert.equal(applyMetrics(start, "missing", null, new Date()), start);
  });
});

describe("ranking", () => {
  it("needs four posts before judging against the median", () => {
    const few = rankPosts(records(record("a", 100), record("b", 300)));
    assert.equal(few.median, 0);
    assert.ok(few.ranked.every((r) => r.multiple === null));
    const many = rankPosts(
      records(record("a", 100), record("b", 100), record("c", 300), record("d", 1000), record("e", null)),
    );
    assert.equal(many.median, 200);
    assert.equal(many.ranked[0].record.postId, "d");
    assert.equal(many.ranked[0].multiple, 5);
    assert.equal(many.ranked.length, 4);
  });

  it("returns winning titles at 1.5x the median", () => {
    const rows = records(
      record("a", 100, "Plain"),
      record("b", 100, "Plain two"),
      record("c", 290, "Close but no"),
      record("d", 1000, "Rust in 60s"),
    );
    assert.deepEqual(winningTitles(rows), ["Rust in 60s"]);
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([]), 0);
  });

  it("ranks posting hours with 2+ posts", () => {
    const rows = records(
      record("a", 100, "a", "2026-10-01T09:00:00"),
      record("b", 300, "b", "2026-10-02T09:30:00"),
      record("c", 900, "c", "2026-10-03T18:00:00"),
      record("d", 700, "d", "2026-10-04T18:10:00"),
      record("e", 5000, "e", "2026-10-05T21:00:00"),
    );
    const hours = bestPostingHours(rows);
    assert.deepEqual(
      hours.map((h) => [h.hour, h.medianViews, h.posts]),
      [
        [18, 800, 2],
        [9, 200, 2],
      ],
    );
  });
});

describe("seo signals", () => {
  it("serves fresh trends and winners, drops stale trends", () => {
    const store = createPerformanceStore(memory());
    const now = new Date("2026-10-19T12:00:00Z");
    store.saveTrends({ niche: "rust", terms: ["tokio", "deadpool"], queries: [], savedAt: "2026-10-18T12:00:00Z" });
    store.save(
      records(record("a", 100, "A"), record("b", 100, "B"), record("c", 100, "C"), record("d", 900, "Winner")),
    );
    assert.deepEqual(seoSignals(store, now), {
      trendTerms: ["tokio", "deadpool"],
      winningTitles: ["Winner"],
    });
    store.saveTrends({ niche: "rust", terms: ["old"], queries: [], savedAt: "2026-10-01T00:00:00Z" });
    assert.deepEqual(seoSignals(store, now).trendTerms, []);
    assert.deepEqual(seoSignals(null, now), { trendTerms: [], winningTitles: [] });
  });
});
