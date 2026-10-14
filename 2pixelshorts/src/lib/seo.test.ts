import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildFullSeoPatch,
  fitTagBudget,
  mergeTrendingTerms,
  normalizeHashtag,
  normalizeHashtags,
  platformLimits,
  scoreSeoPackage,
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
    assert.ok(normalizeHashtags(tags).length <= 8);
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

  it("mirrors the engine weights (title 30 / desc 30 / tags 25 / tags 15)", () => {
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
    assert.equal(totals.get("title"), 30);
    assert.equal(totals.get("description"), 30);
    assert.equal(totals.get("tags"), 25);
    assert.equal(totals.get("hashtags"), 15);
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
    });
    assert.deepEqual(patch.hashtags, ["#rustasync"]);
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
