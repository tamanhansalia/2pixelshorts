import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LIVE_WATCH_INTERVAL_MS,
  armWatchLive,
  blankStreamRun,
  clearWatchLive,
  emptyStreamRunStore,
  getStreamRun,
  isLiveCheckDue,
  isLiveVodReady,
  isWatchableLiveRun,
  liveUrlsDueForCheck,
  mostRecentUsableRun,
  normalizeStreamUrl,
  recordLiveCheck,
  removeStreamRun,
  streamSidebarItems,
  upsertStreamRun,
  watchableLiveUrls,
} from "./streamRuns.ts";

const RESULT = {
  url: "https://www.youtube.com/watch?v=abc",
  title: "T",
  channel: "C",
  duration: 100,
  transcriptSource: "youtube-captions",
  wordsCount: 500,
  picker: "agent:claude",
  pickerNote: "",
  clips: [
    { start: 10, end: 40, score: 0.9, reason: "hook", text: "hello" },
  ],
};

describe("normalizeStreamUrl", () => {
  it("trims whitespace", () => {
    assert.equal(normalizeStreamUrl("  https://x  "), "https://x");
  });
});

describe("upsertStreamRun", () => {
  it("stores a run and fronts its URL in recents", () => {
    const run = { ...blankStreamRun(RESULT.url), result: RESULT };
    const store = upsertStreamRun(emptyStreamRunStore(), run);
    assert.deepEqual(store.recent, [RESULT.url]);
    assert.equal(store.runs[RESULT.url].result?.clips.length, 1);
  });

  it("pins createdAt on first save across later edits", () => {
    const first = upsertStreamRun(
      emptyStreamRunStore(),
      blankStreamRun(RESULT.url),
    );
    const created = first.runs[RESULT.url].createdAt;
    const second = upsertStreamRun(first, {
      ...blankStreamRun(RESULT.url),
      createdAt: new Date().toISOString(),
      result: RESULT,
    });
    assert.equal(second.runs[RESULT.url].createdAt, created);
    assert.equal(second.runs[RESULT.url].result?.title, "T");
  });

  it("ignores blank URLs", () => {
    const store = upsertStreamRun(
      emptyStreamRunStore(),
      blankStreamRun("   "),
    );
    assert.deepEqual(store.recent, []);
  });

  it("keeps the split layout and face ROI with the run", () => {
    const run = {
      ...blankStreamRun(RESULT.url),
      layout: "face-top",
      faceRoi: "bl",
      result: RESULT,
    };
    const store = upsertStreamRun(emptyStreamRunStore(), run);
    assert.equal(store.runs[RESULT.url].layout, "face-top");
    assert.equal(store.runs[RESULT.url].faceRoi, "bl");
  });
});

describe("getStreamRun", () => {
  it("returns null for unknown or blank URLs", () => {
    const store = upsertStreamRun(
      emptyStreamRunStore(),
      blankStreamRun(RESULT.url),
    );
    assert.ok(getStreamRun(store, RESULT.url));
    assert.equal(getStreamRun(store, "https://other"), null);
    assert.equal(getStreamRun(store, "  "), null);
  });
});

describe("mostRecentUsableRun", () => {
  it("prefers analyzed runs over newer untouched links", () => {
    let store = upsertStreamRun(
      emptyStreamRunStore(),
      blankStreamRun("https://new-link"),
    );
    store = upsertStreamRun(store, {
      ...blankStreamRun(RESULT.url),
      result: RESULT,
    });
    // RESULT.url is older but analyzed; newest touched is bare.
    const reordered = {
      runs: store.runs,
      recent: ["https://new-link", RESULT.url],
    };
    assert.equal(mostRecentUsableRun(reordered)?.url, RESULT.url);
  });

  it("returns null for an empty store", () => {
    assert.equal(mostRecentUsableRun(emptyStreamRunStore()), null);
  });
});

describe("streamSidebarItems", () => {
  it("lists most-recent rows with titles and clip counts", () => {
    const store = upsertStreamRun(emptyStreamRunStore(), {
      ...blankStreamRun(RESULT.url),
      result: RESULT,
    });
    const items = streamSidebarItems(store);
    assert.equal(items.length, 1);
    assert.equal(items[0].url, RESULT.url);
    assert.equal(items[0].title, "T");
    assert.equal(items[0].clipCount, 1);
  });

  it("falls back to the URL when no metadata exists yet", () => {
    const store = upsertStreamRun(
      emptyStreamRunStore(),
      blankStreamRun("https://bare"),
    );
    const items = streamSidebarItems(store);
    assert.equal(items[0].title, "https://bare");
    assert.equal(items[0].clipCount, null);
  });
});

describe("isWatchableLiveRun", () => {
  const liveProbe = {
    url: RESULT.url,
    title: "Friday stream",
    channel: "C",
    thumbnail: null,
    duration: 0,
    view_count: null,
    upload_date: null,
    is_live: true,
  };

  it("is watchable while flagged live with no clips", () => {
    const run = { ...blankStreamRun(RESULT.url), probe: liveProbe, watchLive: true };
    assert.equal(isWatchableLiveRun(run), true);
  });

  it("is not watchable once clips exist or watching stops", () => {
    const withClips = {
      ...blankStreamRun(RESULT.url),
      probe: liveProbe,
      watchLive: true,
      result: RESULT,
    };
    assert.equal(isWatchableLiveRun(withClips), false);
    const unwatched = { ...blankStreamRun(RESULT.url), probe: liveProbe };
    assert.equal(isWatchableLiveRun(unwatched), false);
    const vod = {
      ...blankStreamRun(RESULT.url),
      probe: { ...liveProbe, is_live: false, duration: 3600 },
      watchLive: true,
    };
    assert.equal(isWatchableLiveRun(vod), false);
    assert.equal(isWatchableLiveRun(null), false);
  });

  it("arms watching, records checks, and lists due URLs", () => {
    let store = armWatchLive(emptyStreamRunStore(), RESULT.url);
    store = {
      ...store,
      runs: { ...store.runs, [RESULT.url]: { ...store.runs[RESULT.url], probe: liveProbe } },
    };
    assert.equal(isWatchableLiveRun(store.runs[RESULT.url]), true);
    assert.deepEqual(watchableLiveUrls(store), [RESULT.url]);
    assert.equal(isLiveVodReady(liveProbe), false);
    assert.equal(isLiveVodReady({ ...liveProbe, is_live: false, duration: 3600 }), true);
    const now = Date.parse(store.runs[RESULT.url].lastCheckedAt ?? "") || Date.now();
    assert.equal(isLiveCheckDue(store.runs[RESULT.url], now), false);
    assert.equal(isLiveCheckDue(store.runs[RESULT.url], now + LIVE_WATCH_INTERVAL_MS), true);
    store = recordLiveCheck(store, RESULT.url, { ...liveProbe, is_live: false, duration: 3600 });
    assert.equal(store.runs[RESULT.url].watchLive, false);
    assert.equal(isWatchableLiveRun(store.runs[RESULT.url]), false);
    store = armWatchLive(emptyStreamRunStore(), RESULT.url);
    store = {
      ...store,
      runs: { ...store.runs, [RESULT.url]: { ...store.runs[RESULT.url], probe: liveProbe, lastCheckedAt: null } },
    };
    assert.deepEqual(liveUrlsDueForCheck(store), [RESULT.url]);
    store = clearWatchLive(store, RESULT.url);
    assert.equal(store.runs[RESULT.url].watchLive, false);
  });

  it("marks sidebar rows live/watching and reopens watched runs", () => {
    let store = upsertStreamRun(
      emptyStreamRunStore(),
      blankStreamRun("https://bare"),
    );
    store = upsertStreamRun(store, {
      ...blankStreamRun(RESULT.url),
      probe: liveProbe,
      watchLive: true,
    });
    const reordered = { runs: store.runs, recent: ["https://bare", RESULT.url] };
    assert.equal(mostRecentUsableRun(reordered)?.url, RESULT.url);
    const items = streamSidebarItems(store);
    const live = items.find((i) => i.url === RESULT.url);
    assert.equal(live?.isLive, true);
    assert.equal(live?.watching, true);
  });
});

describe("removeStreamRun", () => {
  it("drops the run and its recent entry", () => {
    let store = upsertStreamRun(
      emptyStreamRunStore(),
      blankStreamRun(RESULT.url),
    );
    store = removeStreamRun(store, RESULT.url);
    assert.deepEqual(store.recent, []);
    assert.equal(getStreamRun(store, RESULT.url), null);
  });

  it("leaves the store untouched for unknown URLs", () => {
    const store = upsertStreamRun(
      emptyStreamRunStore(),
      blankStreamRun(RESULT.url),
    );
    assert.equal(removeStreamRun(store, "https://other"), store);
  });
});
