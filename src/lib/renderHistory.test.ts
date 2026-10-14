import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  activeRenderJobs,
  applyFinishedToHistory,
  applyProgressToHistory,
  createRenderHistoryEntry,
  dismissOutputFromHistory,
  MAX_RENDER_HISTORY,
  pushHistoryEntry,
  type RenderHistoryEntry,
} from "./renderHistory.ts";

const PARAMS = {
  input_video: "in.mp4",
  output_video: "out.mp4",
  preset_id: "warm_cinematic",
  agent_id: "claude",
};

function entry(over: Partial<RenderHistoryEntry> = {}): RenderHistoryEntry {
  return {
    id: "job-1",
    inputVideo: "in.mp4",
    outputVideo: "out.mp4",
    presetId: "warm_cinematic",
    status: "queued",
    progress: 0,
    stage: "Queued",
    createdAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    ...over,
  };
}

describe("render history", () => {
  it("creates a queued entry from render params", () => {
    const e = createRenderHistoryEntry("job-9", PARAMS);
    assert.equal(e.id, "job-9");
    assert.equal(e.status, "queued");
    assert.equal(e.progress, 0);
    assert.equal(e.inputVideo, "in.mp4");
    assert.equal(e.agentId, "claude");
    assert.equal(e.seo, undefined);
  });

  it("captures meta-page SEO for queueing", () => {
    const e = createRenderHistoryEntry("job-9", PARAMS, {
      title: "Best Title",
      description: "Hook\n\nBody",
      tags: ["rust"],
    });
    assert.equal(e.seo?.title, "Best Title");
    assert.equal(e.seo?.description, "Hook\n\nBody");
    assert.deepEqual(e.seo?.tags, ["rust"]);
  });

  it("pushes newest-first and caps finished entries", () => {
    let jobs: RenderHistoryEntry[] = [];
    for (let i = 0; i < MAX_RENDER_HISTORY + 5; i++) {
      jobs = pushHistoryEntry(
        jobs,
        entry({ id: `job-${i}`, status: "completed", progress: 1 }),
      );
    }
    assert.equal(jobs.length, MAX_RENDER_HISTORY);
    assert.equal(jobs[0].id, `job-${MAX_RENDER_HISTORY + 4}`);
  });

  it("never drops an active job at the cap", () => {
    let jobs: RenderHistoryEntry[] = [entry({ id: "active", status: "running" })];
    for (let i = 0; i < MAX_RENDER_HISTORY + 5; i++) {
      jobs = pushHistoryEntry(
        jobs,
        entry({ id: `job-${i}`, status: "completed", progress: 1 }),
      );
    }
    assert.ok(jobs.some((j) => j.id === "active"));
  });

  it("applies progress events to the matching active job", () => {
    const jobs = applyProgressToHistory([entry()], {
      job_id: "job-1",
      progress: 0.5,
      stage: "[STAGE 2/4] cutting",
    });
    assert.equal(jobs[0].status, "running");
    assert.equal(jobs[0].progress, 0.5);
    assert.equal(jobs[0].stage, "[STAGE 2/4] cutting");
  });

  it("ignores progress for unknown ids and finished jobs", () => {
    const before = [entry({ status: "completed", progress: 1 })];
    assert.equal(
      applyProgressToHistory(before, {
        job_id: "job-1",
        progress: 0.9,
        stage: "x",
      }),
      before,
    );
    assert.equal(
      applyProgressToHistory([entry()], {
        job_id: "nope",
        progress: 0.9,
        stage: "x",
      }).length,
      1,
    );
  });

  it("applies finished events and pins completed progress to 1", () => {
    const jobs = applyFinishedToHistory([entry({ status: "running" })], {
      id: "job-1",
      status: "completed",
      result: null,
      error: null,
      progress: 0.75,
      stage: "[COMPLETE] done",
      finished_at: null,
    });
    assert.equal(jobs[0].status, "completed");
    assert.equal(jobs[0].progress, 1);
    assert.ok(jobs[0].finishedAt);
  });

  it("classifies active jobs", () => {
    const jobs = [
      entry({ id: "a", status: "queued" }),
      entry({ id: "b", status: "running" }),
      entry({ id: "c", status: "completed" }),
      entry({ id: "d", status: "failed" }),
      entry({ id: "e", status: "cancelled" }),
    ];
    assert.deepEqual(
      activeRenderJobs(jobs).map((j) => j.id),
      ["a", "b"],
    );
  });
});

describe("dismissOutputFromHistory", () => {
  it("removes the finished entries behind a Ready-to-queue row", () => {
    const jobs = [
      entry({ id: "done", outputVideo: "clip1.mp4", status: "completed" }),
      entry({ id: "other", outputVideo: "clip2.mp4", status: "completed" }),
    ];
    const next = dismissOutputFromHistory(jobs, "clip1.mp4");
    assert.deepEqual(
      next.map((j) => j.id),
      ["other"],
    );
  });

  it("drops every finished entry sharing the path (re-rendered outputs)", () => {
    const jobs = [
      entry({ id: "v1", outputVideo: "clip1.mp4", status: "completed" }),
      entry({ id: "v2", outputVideo: "clip1.mp4", status: "failed" }),
    ];
    assert.deepEqual(dismissOutputFromHistory(jobs, "clip1.mp4"), []);
  });

  it("never removes an active render for the same path", () => {
    const jobs = [
      entry({ id: "old", outputVideo: "clip1.mp4", status: "completed" }),
      entry({ id: "live", outputVideo: "clip1.mp4", status: "running" }),
    ];
    const next = dismissOutputFromHistory(jobs, "clip1.mp4");
    assert.deepEqual(
      next.map((j) => j.id),
      ["live"],
    );
  });

  it("ignores unknown paths and leaves history untouched", () => {
    const jobs = [entry({ id: "done", status: "completed" })];
    const next = dismissOutputFromHistory(jobs, "missing.mp4");
    assert.equal(next.length, 1);
    assert.equal(next[0].id, "done");
  });
});
