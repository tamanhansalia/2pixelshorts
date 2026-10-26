import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildStorageScope, formatBytes, recordsAfterCleanup } from "./storage.ts";
import type { RenderHistoryEntry } from "./renderHistory.ts";
import { blankStudioDraft, upsertDraft, emptyStudioStore, type StudioStore } from "./studioProjects.ts";
import type { StreamRun, StreamRunStore } from "./streamRuns.ts";
import type { ScheduleItem } from "../types/index.ts";

function job(over: Partial<RenderHistoryEntry> = {}): RenderHistoryEntry {
  return {
    id: "job-1",
    inputVideo: "/videos/in.mp4",
    outputVideo: "/renders/out.mp4",
    presetId: "warm_cinematic",
    status: "completed",
    progress: 100,
    stage: "Done",
    createdAt: "2026-10-19T00:00:00.000Z",
    finishedAt: "2026-10-19T00:01:00.000Z",
    error: null,
    ...over,
  };
}

function queueItem(video_path: string, status: ScheduleItem["status"]): ScheduleItem {
  return {
    id: video_path, title: "t", video_path, platforms: [], scheduled_for: "", timezone: "UTC",
    status, created_at: "2026-10-19T00:00:00.000Z",
  };
}

function studioWith(...inputs: string[]): StudioStore {
  return inputs.reduce(
    (store, inputPath) => upsertDraft(store, { ...blankStudioDraft(), inputPath, outputPath: "/renders/x.mp4" }),
    emptyStudioStore(),
  );
}

function streamRuns(title: string): StreamRunStore {
  const run = { url: "https://youtu.be/x", probe: { title } } as unknown as StreamRun;
  return { runs: { [run.url]: run }, recent: [run.url] };
}

describe("buildStorageScope", () => {
  it("collects record folders and protects active renders and pending posts", () => {
    const scope = buildStorageScope({
      history: [job(), job({ id: "job-2", outputVideo: "/renders/live.mp4", status: "running" })],
      studio: studioWith("/videos/in.mp4"),
      queue: [queueItem("/renders/queued.mp4", "queued"), queueItem("/renders/posted.mp4", "completed")],
      streamRuns: { runs: {}, recent: [] },
    });
    assert.deepEqual(scope.directories.sort(), [".", "/renders", "/videos"]);
    assert.ok(scope.protected.includes("/renders/live.mp4"));
    assert.ok(scope.protected.includes("/renders/queued.mp4"));
    assert.ok(!scope.protected.includes("/renders/posted.mp4"));
    assert.ok(!scope.protected.includes("/renders/out.mp4"));
  });

  it("includes the helper working directory for relative video paths", () => {
    const scope = buildStorageScope({
      history: [job({ inputVideo: "in.mp4", outputVideo: "final_short.mp4" })],
      studio: emptyStudioStore(),
      queue: [],
      streamRuns: { runs: {}, recent: [] },
    });
    assert.deepEqual(scope.directories, ["."]);
    assert.deepEqual(scope.recordPaths, ["in.mp4", "final_short.mp4"]);
    assert.deepEqual(scope.renderedVideos, ["final_short.mp4"]);
  });

  it("recognizes older stream downloads only by their stream run title", () => {
    const scope = buildStorageScope({
      history: [],
      studio: studioWith("/d/Big_Launch_clip1.mp4", "/d/stream_src_123_clip2.mp4", "/d/holiday_clip1.mp4", "/d/stream_src_1791383341047_9.mp4"),
      queue: [],
      streamRuns: streamRuns("Big Launch!"),
    });
    assert.deepEqual(scope.legacyStreamClips.sort(), ["/d/Big_Launch_clip1.mp4", "/d/stream_src_123_clip2.mp4", "/d/stream_src_1791383341047_9.mp4"]);
  });
});

describe("recordsAfterCleanup", () => {
  it("drops finished history and Studio sources for removed files", () => {
    const history = [job(), job({ id: "job-2", outputVideo: "/renders/keep.mp4" })];
    const studio = { ...studioWith("/d/clip_clip1.mp4", "/videos/in.mp4"), currentId: "/d/clip_clip1.mp4" };
    const next = recordsAfterCleanup(history, studio, ["/renders/out.mp4", "/renders/out.mp4.words.json", "/d/clip_clip1.mp4"]);
    assert.deepEqual(next.history.map((j) => j.id), ["job-2"]);
    assert.deepEqual(next.removedSources, ["/d/clip_clip1.mp4"]);
    assert.ok(!("/d/clip_clip1.mp4" in next.studio.projects));
    assert.equal(next.studio.currentId, null);
  });

  it("returns the same objects when nothing matches", () => {
    const history = [job()];
    const studio = studioWith("/videos/in.mp4");
    const next = recordsAfterCleanup(history, studio, ["/elsewhere.mp4"]);
    assert.equal(next.history, history);
    assert.equal(next.studio, studio);
  });
});

describe("formatBytes", () => {
  it("formats with sensible precision", () => {
    assert.equal(formatBytes(0), "0 KB");
    assert.equal(formatBytes(500), "1 KB");
    assert.equal(formatBytes(1536 * 1024), "1.5 MB");
    assert.equal(formatBytes(669 * 1024 * 1024), "669 MB");
    assert.equal(formatBytes(1.4 * 1024 ** 3), "1.4 GB");
  });
});
