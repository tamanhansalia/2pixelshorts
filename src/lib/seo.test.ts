import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildFullSeoPatch,
  fitTagBudget,
  lintTitle,
  mergeTrendingTerms,
  normalizeHashtag,
  normalizeHashtags,
  platformLimits,
  queryHit,
  packageQueryTargets,
  scoreHook,
  scoreSeoPackage,
  TITLE_MOBILE_CHARS,
  feedTruncation,
  trimTitle,
} from "./seo.ts";

describe("seo hashtag normalization", () => {
  it("dedupes case/space variants and backfills from tags", () => {
    const out = normalizeHashtags(["Rust Async", "rustasync"], ["#RustAsync"]);
    assert.equal(out[0], "#rustasync");
    assert.equal(out.filter((h) => h === "#rustasync").length, 1);
  });

  it("handles digits and noise", () => {
    assert.equal(normalizeHashtag(" 60 Seconds "), "#t60seconds");
    assert.equal(normalizeHashtag(""), "");
  });

  it("caps at the hashtag limit", () => {
    const tags = Array.from({ length: 20 }, (_, i) => `tag${i}`);
    assert.ok(normalizeHashtags(tags).length <= 5);
  });
});

describe("seo tag budget", () => {
  it("dedupes case-insensitively and keeps order", () => {
    assert.deepEqual(fitTagBudget(["Rust", "rust", " RUST ", "tokio"]), [
      "Rust",
      "tokio",
    ]);
  });

  it("never exceeds the character budget", () => {
    const joined = fitTagBudget(["x".repeat(400), "y".repeat(200)]).join(", ");
    assert.ok(joined.length <= 500);
  });
});

describe("seo scoring", () => {
  function completePackage() {
    const tags = [
      "rust",
      "rust async",
      "rust tutorial",
      "shorts",
      "tokio",
      "pooling",
      "connection pooling",
      "async",
      "programming",
      "developer",
    ];
    const hashtags = normalizeHashtags(tags, ["#rust"]);
    const description = [
      "Stop doing this with rust",
      "",
      "About Rust. Covered: async; pooling. Subscribe for more!",
      "",
      "📌 Key Highlights:",
      "• async deep dive",
      "",
      "🔍 Search Keywords:",
      tags.join(", "),
      "",
      hashtags.join(" "),
    ].join("\n");
    return { tags, hashtags, description };
  }

  it("rewards complete packages over empty ones", () => {
    const full = completePackage();
    const good = scoreSeoPackage(
      "Rust async pooling fix",
      full.description,
      full.tags,
      full.hashtags,
      ["rust", "async"],
      90,
    );
    const thin = scoreSeoPackage("", "", [], [], [], 0);
    assert.ok(good.score > thin.score);
    assert.ok(good.qualityScore > 60);
  });

  it("penalizes overlong titles", () => {
    const tags = ["rust"];
    const hashtags = ["#rust"];
    const long = scoreSeoPackage("x".repeat(120), "body ".repeat(30), tags, hashtags, ["rust"]);
    const short = scoreSeoPackage("Rust async fix", "body ".repeat(30), tags, hashtags, ["rust"]);
    assert.ok(short.qualityScore > long.qualityScore);
  });

  it("mirrors the engine weights (title 40 / hook 15 / desc 30 / hashtags 10 / tags 5)", () => {
    const full = completePackage();
    const result = scoreSeoPackage(
      "Rust async pooling fix",
      full.description,
      full.tags,
      full.hashtags,
      ["rust", "async"],
    );
    const totals = new Map<string, number>();
    for (const c of result.checks) {
      totals.set(c.id.split("_")[0], (totals.get(c.id.split("_")[0]) ?? 0) + c.of);
    }
    assert.equal(totals.get("title"), 40);
    assert.equal(totals.get("hook"), 15);
    assert.equal(totals.get("description"), 30);
    assert.equal(totals.get("hashtags"), 10);
    assert.equal(totals.get("tags"), 5);
  });

  // Reference values computed by video-use/helpers/seo.py:score_seo on the
  // same inputs; the two scorers must agree check for check.
  it("matches the Python engine on reference packages", () => {
    const clean = scoreSeoPackage(
      "Rust connection pooling in 60s",
      "Your Rust pool is leaking connections.\nFix rust connection pooling with deadpool in 60 seconds.\n\n\u2022 Why tokio pools leak\n\nFollow for more Rust.\n\n#rust #tokio #deadpool",
      ["rust", "tokio", "deadpool", "connection pooling", "async"],
      ["#rust", "#tokio", "#deadpool"],
      [],
      0,
      { hook: "Your Rust pool is leaking connections.", queries: ["rust connection pooling"] },
    );
    assert.equal(clean.qualityScore, 90);
    assert.equal(clean.hook.verdict, 36);
    const stuffed = scoreSeoPackage(
      "THE BEST INSANE SECRET TRICK EVER",
      "Watch now!\n\nSearch Keywords:\na, b, c, d, e, f, g, h, i, j\n\n#a",
      ["x"],
      ["#a"],
      ["rust"],
    );
    assert.equal(stuffed.qualityScore, 37);
    assert.equal(stuffed.hook.verdict, 25);
    const got = Object.fromEntries(stuffed.checks.map((c) => [c.id, c.got]));
    assert.deepEqual(got, {
      title_present: 5,
      title_mobile_fit: 8,
      title_query_match: 0,
      title_concrete: 0,
      title_not_shouting: 0,
      title_front_loaded: 3,
      title_over_limit: 0,
      hook_strength: 4,
      description_above_fold: 0,
      description_length: 2,
      description_hashtags: 5,
      description_no_stuffing: 0,
      hashtags_count: 4,
      hashtags_postable: 3,
      tags_present: 3,
    });
    assert.equal(scoreSeoPackage("", "", [], [], []).qualityScore, 0);
  });

  it("lints titles and matches search queries", () => {
    assert.ok(queryHit("Connection pooling in Rust", ["rust connection pooling"]));
    assert.ok(!queryHit("Cooking pasta fast", ["rust connection pooling"]));
    const lint = lintTitle("THE BEST INSANE trick");
    assert.ok(lint.shouting);
    assert.deepEqual(lint.vague, ["best", "insane"]);
    assert.ok(lintTitle("Rust in 60s").mobileFit);
  });

  it("scores hooks with the weakest-link rule", () => {
    const strong = scoreHook(
      "You are wasting 3 hours a week on Rust builds, and nobody tells you why",
    );
    const weak = scoreHook("hey guys welcome back");
    assert.ok(strong.verdict > weak.verdict);
    assert.equal(scoreHook("").verdict, 0);
  });
});

describe("package query targets", () => {
  it("does not treat spoken keywords as demand when the engine says there is none", () => {
    assert.deepEqual(
      packageQueryTargets({
        search_queries: ["open sir"],
        keywords_analyzed: ["open", "sir"],
        demand_queries: [],
      }),
      { queries: [], keywords: [] },
    );
  });

  it("scores external queries and ignores the spoken keyword stand-in", () => {
    assert.deepEqual(
      packageQueryTargets({
        search_queries: ["rust connection pooling", "tokio pool"],
        keywords_analyzed: ["rust"],
        demand_queries: ["rust connection pooling"],
      }),
      { queries: ["rust connection pooling"], keywords: [] },
    );
  });

  it("keeps the keyword fallback for packages saved before demand existed", () => {
    assert.deepEqual(
      packageQueryTargets({
        search_queries: ["rust async"],
        keywords_analyzed: ["rust"],
      }),
      { queries: ["rust async"], keywords: ["rust"] },
    );
  });
});

describe("seo patch + trending", () => {
  it("preserves hashtags, alternates, and scores", () => {
    const patch = buildFullSeoPatch({
      title: "T",
      title_alternatives: ["A", "B"],
      description: "D",
      tags: ["rust async"],
      hashtags: ["#RustAsync"],
      keywords_analyzed: ["rust"],
      seo_score: 88,
      quality_score: 72,
      search_queries: ["rust async"],
      pinned_comment: "Which runtime?",
    });
    assert.deepEqual(patch.hashtags, ["#rustasync"]);
    assert.deepEqual(patch.searchQueries, ["rust async"]);
    assert.equal(patch.pinnedComment, "Which runtime?");
    assert.deepEqual(patch.titleAlternatives, ["A", "B"]);
    assert.equal(patch.retentionScore, 88);
    assert.equal(patch.qualityScore, 72);
  });

  it("merges missing trending terms without flooding", () => {
    const merged = mergeTrendingTerms(["rust"], ["Rust", "tokio", "async", "pooling", "extra"]);
    assert.deepEqual(merged, ["rust", "tokio", "async", "pooling"]);
  });

  it("knows per-platform limits", () => {
    assert.equal(platformLimits("youtube").title, 100);
    assert.equal(platformLimits("tiktok").description, 2200);
    assert.equal(platformLimits("unknown").title, 100);
  });

  it("trims titles on word boundaries", () => {
    assert.equal(trimTitle("short", 100), "short");
    const trimmed = trimTitle(`${"word "} `.repeat(30).trim(), 100);
    assert.ok(trimmed.length <= 100);
    assert.ok(trimmed.endsWith("..."));
  });
});

describe("seo feed truncation", () => {
  it("shows the phone and desktop cuts", () => {
    const short = feedTruncation("Rust in 60s");
    assert.equal(short.chars, "Rust in 60s".length);
    assert.equal(short.mobile, "Rust in 60s");
    assert.ok(short.mobileFits);
    assert.ok(short.desktopFits);
    const long = "Rust connection pooling will leak under load unless you cap it now";
    const cut = feedTruncation(long);
    assert.ok(cut.mobile.endsWith("…"));
    assert.ok(cut.mobile.length <= TITLE_MOBILE_CHARS + 1);
    assert.ok(!cut.mobileFits);
    assert.ok(!cut.desktopFits);
    assert.ok(cut.desktop.endsWith("…"));
  });
});
