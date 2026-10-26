import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyStudioSeo,
  baseName,
  blankStudioDraft,
  buildDraftFromQueue,
  buildSourceEntries,
  dayGroupFor,
  emptyStudioStore,
  groupEntriesByDay,
  mergeSourceIds,
  normalizeStudioStore,
  removeSource,
  resolveEntryStatus,
  resolveSourceStatus,
  selectSource,
  latestCompletedOutput,
  preferredSeoAgent,
  shouldAutoNameOutput,
  slugifyTitle,
  sourceLabel,
  streamClipSourceName,
  suggestOutputPath,
  upsertDraft,
  importClipDrafts,
  type SourceEntry,
  type StudioProjectDraft,
} from "./studioProjects.ts";

describe("output auto-naming", () => {
  it("slugifies titles keeping letters, dropping emoji", () => {
    assert.equal(slugifyTitle("The Secret Workflow Nobody Tells You 🤫"), "The_Secret_Workflow_Nobody_Tells_You");
    assert.equal(slugifyTitle("Stop Doing This (Do This Instead) ❌"), "Stop_Doing_This_Do_This_Instead");
    assert.equal(slugifyTitle("  spaced   out  "), "spaced_out");
    assert.equal(slugifyTitle("a/b\\c:d*e?f\"g<h>i|j"), "abcdefghij");
    assert.equal(slugifyTitle(""), "");
    assert.ok(slugifyTitle("x".repeat(100)).length <= 60);
  });

  it("prefers the Shorts title, then stream, then input, then default", () => {
    assert.deepEqual(
      suggestOutputPath({ seoTitle: "My Short", inputPath: "C:\\v\\raw.mp4" }),
      { path: "C:\\v\\My_Short.mp4", source: "title" },
    );
    assert.deepEqual(
      suggestOutputPath({ streamTitle: "Friday Stream!", inputPath: "/tmp/raw.mp4" }),
      { path: "/tmp/Friday_Stream.mp4", source: "stream" },
    );
    assert.deepEqual(
      suggestOutputPath({ inputPath: "/tmp/raw.mp4" }),
      { path: "/tmp/raw_short.mp4", source: "input" },
    );
    assert.deepEqual(suggestOutputPath({}), { path: "final_short.mp4", source: "default" });
  });

  it("keeps queue-prefilled paths as user-chosen", () => {
    const d = buildDraftFromQueue({ video_path: "out.mp4", title: "T" });
    assert.equal(d.outputTouched, true);
  });

  it("resolves playback to the newest completed render, never a running/failed one", () => {
    const history = [
      { inputVideo: "raw.mp4", outputVideo: "retry_short.mp4", status: "running" as const, progress: 0.5 },
      { inputVideo: "raw.mp4", outputVideo: "raw_short.mp4", status: "completed" as const, progress: 1 },
      { inputVideo: "raw.mp4", outputVideo: "old_short.mp4", status: "completed" as const, progress: 1 },
      { inputVideo: "other.mp4", outputVideo: "other_short.mp4", status: "completed" as const, progress: 1 },
      { inputVideo: "bad.mp4", outputVideo: "bad_short.mp4", status: "failed" as const, progress: 0.2 },
    ];
    assert.equal(latestCompletedOutput("raw.mp4", history), "raw_short.mp4");
    assert.equal(latestCompletedOutput("bad.mp4", history), null);
    assert.equal(latestCompletedOutput("missing.mp4", history), null);
    assert.equal(latestCompletedOutput("", history), null);
  });

  it("never auto-renames the output once a render exists on disk", () => {
    // Regression: post-render SEO set a new title and the auto-name effect
    // renamed outputPath to a title-slug file that was never rendered, so
    // the review popup's Play / Reveal silently opened nothing.
    assert.equal(shouldAutoNameOutput(false, null), true);
    assert.equal(shouldAutoNameOutput(false, "raw_short.mp4"), false);
    assert.equal(shouldAutoNameOutput(true, null), false);
    assert.equal(shouldAutoNameOutput(true, "raw_short.mp4"), false);
  });

  it("names imported stream clips distinctly per index", () => {
    assert.equal(
      streamClipSourceName("Friday Stream!", 123, 0),
      "Friday_Stream_clip1.mp4",
    );
    assert.equal(
      streamClipSourceName("Friday Stream!", 123, 1),
      "Friday_Stream_clip2.mp4",
    );
    assert.equal(
      streamClipSourceName("  ", 123, 0),
      "stream_src_123_clip1.mp4",
    );
  });

  it("backfills untouched drafts stored before the flag existed", () => {
    const legacy = {
      projects: {
        custom: { ...draft({ inputPath: "a.mp4", outputPath: "C:\\v\\mine.mp4" }), outputTouched: undefined },
        blank: { ...draft({ inputPath: "b.mp4", outputPath: "final_short.mp4" }), outputTouched: undefined },
      },
      recent: ["custom", "blank"],
      currentId: null,
    } as unknown as Parameters<typeof normalizeStudioStore>[0];
    const next = normalizeStudioStore(legacy);
    assert.equal(next.projects["custom"].outputTouched, true);
    assert.equal(next.projects["custom"].outputPath, "C:\\v\\mine.mp4");
    assert.equal(next.projects["blank"].outputTouched, false);
  });
});

function draft(over: Partial<StudioProjectDraft> = {}): StudioProjectDraft {
  return {
    inputPath: "C:\\videos\\a.mp4",
    outputPath: "C:\\videos\\a_short.mp4",
    outputTouched: true,
    metadata: null,
    presetId: "warm_cinematic",
    agentId: "claude",
    cutStartInput: "",
    cutEndInput: "",
    burnInCaptions: true,
    subtitleStyle: "pop",
    subtitlePosition: "bottom",
    subtitleSize: "standard",
    subtitleCase: "sentence",
    promptHook: "",
    contextOverride: "",
    seoTitle: "Title",
    seoDescription: "Desc",
    seoTags: ["shorts"],
    reviewReport: null,
    updatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    ...over,
  };
}

describe("studio projects", () => {
  it("imports clip downloads as sidebar sources in finder order", () => {
    const meta = {
      file_path: "/clips/a_clip1.mp4",
      duration_seconds: 32,
      width: 1080,
      height: 1920,
      fps: 30,
      codec: "h264",
      audio_channels: 2,
      file_size_bytes: 10,
    };
    const next = importClipDrafts(emptyStudioStore(), [
      { inputPath: "/clips/a_clip1.mp4", metadata: meta, title: "Technical breakdown" },
      { inputPath: "/clips/a_clip2.mp4", metadata: null, title: "Fast-paced showcase" },
    ], "2026-10-20T12:00:00.000Z");
    assert.deepEqual(next.recent, ["/clips/a_clip1.mp4", "/clips/a_clip2.mp4"]);
    assert.equal(next.currentId, "/clips/a_clip1.mp4");
    assert.equal(next.projects["/clips/a_clip1.mp4"].seoTitle, "Technical breakdown");
    assert.equal(next.projects["/clips/a_clip1.mp4"].studioStage, "edit");
    assert.equal(next.projects["/clips/a_clip2.mp4"].studioStage, "source");
    const untouched = emptyStudioStore();
    assert.equal(importClipDrafts(untouched, []), untouched);
  });

  it("upserts drafts most-recent-first", () => {
    let store = emptyStudioStore();
    store = upsertDraft(store, draft({ inputPath: "a.mp4" }));
    store = upsertDraft(store, draft({ inputPath: "b.mp4" }));
    assert.deepEqual(store.recent, ["b.mp4", "a.mp4"]);
    store = upsertDraft(store, draft({ inputPath: "a.mp4", seoTitle: "New" }));
    assert.deepEqual(store.recent, ["a.mp4", "b.mp4"]);
    assert.equal(store.projects["a.mp4"].seoTitle, "New");
  });

  it("selects the current source", () => {
    let store = emptyStudioStore();
    store = upsertDraft(store, draft({ inputPath: "a.mp4" }));
    store = selectSource(store, "a.mp4");
    assert.equal(store.currentId, "a.mp4");
  });

  it("starts a new short completely blank", () => {
    const d = blankStudioDraft();
    assert.equal(d.inputPath, "");
    assert.equal(d.outputPath, "");
    assert.equal(d.outputTouched, false);
    assert.equal(d.metadata, null);
    assert.equal(d.seoTitle, "");
    assert.deepEqual(d.seoTags, []);
    assert.equal(d.reviewReport, null);
    assert.equal("activeStep" in d, false);
    assert.equal(d.burnInCaptions, true);
  });

  it("prefills a draft from a queue item without a step", () => {
    const d = buildDraftFromQueue({
      video_path: "out.mp4",
      title: "Queued title",
      description: "Queued desc",
      tags: ["ai"],
    });
    assert.equal(d.inputPath, "out.mp4");
    assert.equal(d.seoTitle, "Queued title");
    assert.equal(d.seoDescription, "Queued desc");
    assert.deepEqual(d.seoTags, ["ai"]);
    assert.equal("activeStep" in d, false);
  });

  it("merges recents with queued paths without duplicates", () => {
    assert.deepEqual(
      mergeSourceIds(["a.mp4", "b.mp4"], ["b.mp4", "c.mp4"]),
      ["a.mp4", "b.mp4", "c.mp4"],
    );
  });

  it("resolves source status from history first, queue second", () => {
    const history = [
      { inputVideo: "r.mp4", outputVideo: "r_short.mp4", status: "running" as const, progress: 0.4 },
      { inputVideo: "d.mp4", outputVideo: "d_short.mp4", status: "completed" as const, progress: 1 },
      { inputVideo: "f.mp4", outputVideo: "f_short.mp4", status: "failed" as const, progress: 0.2 },
    ];
    assert.deepEqual(resolveSourceStatus("r.mp4", history, []), {
      status: "rendering",
      progress: 0.4,
    });
    assert.deepEqual(resolveSourceStatus("d_short.mp4", history, []), {
      status: "completed",
    });
    assert.deepEqual(resolveSourceStatus("f.mp4", history, []), {
      status: "failed",
    });
    assert.deepEqual(resolveSourceStatus("q.mp4", [], ["q.mp4"]), {
      status: "queued",
    });
    assert.deepEqual(resolveSourceStatus("new.mp4", [], []), {
      status: "editing",
    });
  });

  it("removes a source and clears current when it matches", () => {
    let store = emptyStudioStore();
    store = upsertDraft(store, draft({ inputPath: "a.mp4" }));
    store = upsertDraft(store, draft({ inputPath: "b.mp4" }));
    store = selectSource(store, "a.mp4");
    store = removeSource(store, "a.mp4");
    assert.deepEqual(store.recent, ["b.mp4"]);
    assert.equal("a.mp4" in store.projects, false);
    assert.equal(store.currentId, null);
  });

  it("removing an unknown id leaves the store untouched", () => {
    let store = emptyStudioStore();
    store = upsertDraft(store, draft({ inputPath: "a.mp4" }));
    const next = removeSource(store, "missing.mp4");
    assert.deepEqual(next, store);
  });

  it("takes the file name from any path style", () => {
    assert.equal(baseName("C:\\videos\\clip.mp4"), "clip.mp4");
    assert.equal(baseName("/home/u/clip.mp4"), "clip.mp4");
    assert.equal(baseName("clip.mp4"), "clip.mp4");
  });

  it("pins createdAt on first save so edits never move the day", () => {
    let store = emptyStudioStore();
    const first = draft({ inputPath: "a.mp4", createdAt: "2026-10-01T10:00:00.000Z" });
    store = upsertDraft(store, first);
    assert.equal(store.projects["a.mp4"].createdAt, "2026-10-01T10:00:00.000Z");
    store = upsertDraft(
      store,
      draft({ inputPath: "a.mp4", createdAt: "2026-10-06T10:00:00.000Z", seoTitle: "New" }),
    );
    assert.equal(store.projects["a.mp4"].createdAt, "2026-10-01T10:00:00.000Z");
    assert.equal(store.projects["a.mp4"].seoTitle, "New");
  });

  it("backfills createdAt for drafts stored before it existed", () => {
    const legacy = {
      projects: {
        "a.mp4": { ...draft({ inputPath: "a.mp4" }), createdAt: undefined },
      },
      recent: ["a.mp4"],
      currentId: null,
    } as unknown as Parameters<typeof normalizeStudioStore>[0];
    const next = normalizeStudioStore(legacy);
    assert.match(
      next.projects["a.mp4"].createdAt,
      /^\d{4}-\d{2}-\d{2}T/,
      "falls back to updatedAt ISO timestamp",
    );
  });

  it("merges a source with its queued output into one row", () => {
    const history = [
      {
        inputVideo: "a.mp4", outputVideo: "a_short.mp4",
        status: "completed" as const, progress: 1, createdAt: "2026-10-06T09:00:00.000Z",
      },
    ];
    const store = upsertDraft(
      upsertDraft(emptyStudioStore(), draft({ inputPath: "a.mp4", outputPath: "a_short.mp4", createdAt: "2026-10-06T08:00:00.000Z" })),
      draft({ inputPath: "b.mp4", outputPath: "b.mp4", createdAt: "2026-10-06T08:30:00.000Z" }),
    );
    const entries = buildSourceEntries(
      store.recent,
      store.projects,
      history,
      [{ video_path: "a_short.mp4", created_at: "2026-10-06T10:00:00.000Z" }],
    );
    assert.equal(entries.length, 2, "input + queued output collapse to one row");
    const merged = entries.find((e) => e.id === "a.mp4");
    assert.deepEqual(merged?.files, ["a.mp4", "a_short.mp4"]);
    assert.equal(merged?.status, "completed");
    assert.deepEqual(merged?.queuePaths, ["a_short.mp4"]);
    assert.equal(merged?.projectId, "a.mp4");
  });

  it("keeps queue-only outputs as standalone rows, newest first", () => {
    const entries = buildSourceEntries([], {}, [], [
      { video_path: "old.mp4", created_at: "2026-10-01T10:00:00.000Z" },
      { video_path: "new.mp4", created_at: "2026-10-06T10:00:00.000Z" },
    ]);
    assert.deepEqual(entries.map((e) => e.id), ["new.mp4", "old.mp4"]);
    assert.equal(entries[0].projectId, null);
    assert.equal(entries[0].status, "queued");
  });

  it("labels sidebar shorts with the SEO title", () => {
    assert.equal(
      sourceLabel({ seoTitle: "  Stop Doing This  ", fallbackPath: "clip_short.mp4" }),
      "Stop Doing This",
    );
    assert.equal(
      sourceLabel({ seoTitle: "   ", queueTitle: "Queued hook", fallbackPath: "out.mp4" }),
      "Queued hook",
    );
    assert.equal(
      sourceLabel({ historyTitle: "From render", fallbackPath: "a_short.mp4" }),
      "From render",
    );
    assert.equal(sourceLabel({ fallbackPath: "C:\\v\\raw.mp4" }), "raw.mp4");

    const titled = upsertDraft(
      emptyStudioStore(),
      draft({ inputPath: "a.mp4", outputPath: "a_short.mp4", seoTitle: "The Secret Workflow" }),
    );
    const titledEntries = buildSourceEntries(titled.recent, titled.projects, [], []);
    assert.equal(titledEntries[0]?.label, "The Secret Workflow");

    const untitled = upsertDraft(
      emptyStudioStore(),
      draft({ inputPath: "clip.mp4", outputPath: "clip_short.mp4", seoTitle: "  " }),
    );
    const untitledEntries = buildSourceEntries(untitled.recent, untitled.projects, [], []);
    assert.equal(untitledEntries[0]?.label, "clip_short.mp4");

    const fromHistory = upsertDraft(
      emptyStudioStore(),
      draft({ inputPath: "a.mp4", outputPath: "a_short.mp4", seoTitle: "" }),
    );
    const historyEntries = buildSourceEntries(
      fromHistory.recent,
      fromHistory.projects,
      [
        {
          inputVideo: "a.mp4",
          outputVideo: "a_short.mp4",
          status: "completed",
          progress: 1,
          createdAt: "2026-10-06T09:00:00.000Z",
          seo: { title: "From render", description: "", tags: [] },
        },
      ],
      [],
    );
    assert.equal(historyEntries[0]?.label, "From render");

    const queued = buildSourceEntries([], {}, [], [
      { video_path: "out.mp4", created_at: "2026-10-06T10:00:00.000Z", title: "Queued hook" },
    ]);
    assert.equal(queued[0]?.label, "Queued hook");
  });

  it("resolves merged status from the newest history touch", () => {
    const history = [
      { inputVideo: "a.mp4", outputVideo: "a_short.mp4", status: "running" as const, progress: 0.4 },
    ];
    assert.deepEqual(resolveEntryStatus(["a.mp4", "a_short.mp4"], history, ["a_short.mp4"]), {
      status: "rendering",
      progress: 0.4,
    });
    assert.deepEqual(resolveEntryStatus(["b.mp4"], [], ["b.mp4"]), { status: "queued" });
    assert.deepEqual(resolveEntryStatus(["c.mp4"], [], []), { status: "editing" });
  });

  it("buckets timestamps into Today / Yesterday / weekday / Older", () => {
    // Fixed "now": Tue 2026-10-06 12:00 local.
    const nowMs = new Date(2026, 9, 6, 12, 0, 0).getTime();
    const iso = (y: number, m: number, d: number) => new Date(y, m, d, 9, 0, 0).toISOString();
    assert.equal(dayGroupFor(iso(2026, 9, 6), nowMs).label, "Today");
    assert.equal(dayGroupFor(iso(2026, 9, 5), nowMs).label, "Yesterday");
    assert.equal(dayGroupFor(iso(2026, 9, 3), nowMs).label, "Saturday");
    assert.equal(dayGroupFor(iso(2026, 8, 20), nowMs).label, "Older");
    assert.equal(dayGroupFor("not-a-date", nowMs).label, "Older");
  });

  it("orders day groups newest-first with Older last", () => {
    const nowMs = new Date(2026, 9, 6, 12, 0, 0).getTime();
    const entry = (id: string, createdAt: string): SourceEntry => ({
      id, label: id, createdAt, status: "editing", files: [id], projectId: id, queuePaths: [],
    });
    const iso = (y: number, m: number, d: number) => new Date(y, m, d, 9, 0, 0).toISOString();
    const groups = groupEntriesByDay(
      [entry("old", iso(2026, 8, 1)), entry("today", iso(2026, 9, 6)), entry("yday", iso(2026, 9, 5))],
      nowMs,
    );
    assert.deepEqual(groups.map((g) => g.group.label), ["Today", "Yesterday", "Older"]);
    assert.deepEqual(groups[0].entries.map((e) => e.id), ["today"]);
  });
});

describe("applyStudioSeo", () => {
  const meta = {
    title: "New title",
    description: "New desc",
    tags: ["a", "b"],
    review_report: null,
  };

  function store() {
    const d = draft();
    return {
      version: 1 as const,
      currentId: d.inputPath,
      recent: [] as string[],
      projects: { [d.inputPath]: d },
    };
  }

  it("merges into the draft matched by input path", () => {
    const next = applyStudioSeo(store(), "C:\\videos\\a.mp4", meta);
    assert.equal(next.projects["C:\\videos\\a.mp4"].seoTitle, "New title");
    assert.deepEqual(next.projects["C:\\videos\\a.mp4"].seoTags, ["a", "b"]);
  });

  it("merges into the draft matched by output path", () => {
    const next = applyStudioSeo(store(), "C:\\videos\\a_short.mp4", meta);
    assert.equal(next.projects["C:\\videos\\a.mp4"].seoDescription, "New desc");
  });

  it("copies tags instead of aliasing them", () => {
    const next = applyStudioSeo(store(), "C:\\videos\\a.mp4", meta);
    assert.notEqual(next.projects["C:\\videos\\a.mp4"].seoTags, meta.tags);
    assert.deepEqual(next.projects["C:\\videos\\a.mp4"].seoTags, meta.tags);
  });

  it("leaves the store untouched for unknown targets", () => {
    const before = store();
    const next = applyStudioSeo(before, "C:\\videos\\other.mp4", meta);
    assert.equal(next, before);
  });

  it("preserves alternates, hashtags, and scores for later reopen", () => {
    const full = {
      ...meta,
      title_alternatives: ["Alt 1", "Alt 2"],
      hashtags: ["#a", "#b"],
      seo_score: 88,
      quality_score: 72,
      keywords_analyzed: ["a"],
    };
    const next = applyStudioSeo(store(), "C:\\videos\\a.mp4", full);
    const draft = next.projects["C:\\videos\\a.mp4"];
    assert.deepEqual(draft.seoTitleAlternatives, ["Alt 1", "Alt 2"]);
    assert.deepEqual(draft.seoHashtags, ["#a", "#b"]);
    assert.equal(draft.seoScore, 88);
    assert.equal(draft.seoQualityScore, 72);
    assert.deepEqual(draft.seoKeywords, ["a"]);
    // Copied, never aliased.
    assert.notEqual(draft.seoTitleAlternatives, full.title_alternatives);
    assert.notEqual(draft.seoHashtags, full.hashtags);
  });

  it("defaults spares to empty when the package omits them", () => {
    const next = applyStudioSeo(store(), "C:\\videos\\a.mp4", meta);
    const draft = next.projects["C:\\videos\\a.mp4"];
    assert.deepEqual(draft.seoTitleAlternatives, []);
    assert.deepEqual(draft.seoHashtags, []);
    assert.equal(draft.seoScore, null);
  });

  it("stores an empty demand list instead of the spoken phrases", () => {
    const next = applyStudioSeo(store(), "C:\\videos\\a.mp4", {
      ...meta,
      search_queries: ["open sir"],
      demand_queries: [],
    });
    const saved = next.projects["C:\\videos\\a.mp4"];
    assert.deepEqual(saved.seoSearchQueries, ["open sir"]);
    assert.deepEqual(saved.seoDemandQueries, []);
  });
});

describe("preferred SEO agent", () => {
  it("uses the newest real CLI and skips Auto cut", () => {
    assert.equal(preferredSeoAgent(emptyStudioStore()), "claude");
    let store = emptyStudioStore();
    store = upsertDraft(store, draft({ inputPath: "a.mp4", agentId: "auto", updatedAt: "2026-10-01T00:00:00.000Z" }));
    store = upsertDraft(store, draft({ inputPath: "b.mp4", agentId: "codex", updatedAt: "2026-10-02T00:00:00.000Z" }));
    assert.equal(preferredSeoAgent(store), "codex");
  });
});
