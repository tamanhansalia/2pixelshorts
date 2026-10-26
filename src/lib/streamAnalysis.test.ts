import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createStreamAnalysisRunner, isBusyClipJob, type StreamAnalysisJob } from "./streamAnalysis.ts";
import type { StreamProbe, SuggestStreamClipsResult } from "./streamClips.ts";
import { blankStreamRun, emptyStreamRunStore, upsertStreamRun } from "./streamRuns.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function result(url: string): SuggestStreamClipsResult {
  return {
    url, title: url, channel: "Channel", duration: 200,
    transcriptSource: "youtube-captions", wordsCount: 500, picker: "heuristic", pickerNote: "",
    clips: [{ start: 10, end: 40, score: .9, reason: "Hook", text: "A complete thought" }],
  };
}

describe("App-owned clip analysis", () => {
  it("treats running and watching jobs as busy", () => {
    assert.equal(isBusyClipJob({ url: "a", startedAt: "t", status: "running" }), true);
    assert.equal(isBusyClipJob({ url: "a", startedAt: "t", status: "watching" }), true);
    assert.equal(isBusyClipJob({ url: "a", startedAt: "t", status: "completed", finishedAt: "t", clipCount: 1 }), false);
    assert.equal(isBusyClipJob(undefined), false);
  });

  it("deduplicates rapid starts and completes after the active page/source changes", async () => {
    const selection = deferred<SuggestStreamClipsResult>();
    const metadata = deferred<StreamProbe>();
    let calls = 0;
    let probeUpdates = 0;
    let activeSource = "https://youtu.be/source-a";
    let store = emptyStreamRunStore();
    const jobs: Record<string, StreamAnalysisJob> = {};
    const runner = createStreamAnalysisRunner({
      probe: () => metadata.promise,
      suggest: () => { calls++; return selection.promise; },
      onStart: (job) => {
        jobs[job.url] = job;
        store = upsertStreamRun(store, blankStreamRun(job.url));
      },
      onProbe: () => { probeUpdates++; },
      onWatching: () => assert.fail("Unexpected watching"),
      onComplete: (job, output) => {
        jobs[job.url] = job;
        store = upsertStreamRun(store, { ...store.runs[job.url], result: output });
      },
      onFailure: () => assert.fail("Unexpected failure"),
    });
    const first = runner.start(` ${activeSource} `, { agentId: "auto" });
    assert.equal(runner.start(activeSource, {}), first);
    assert.equal(runner.isRunning(activeSource), true);
    await Promise.resolve();
    assert.equal(calls, 1);
    activeSource = "another source on a different page";
    store = upsertStreamRun(store, blankStreamRun(activeSource));
    selection.resolve(result("https://youtu.be/source-a"));
    await first;
    assert.equal(jobs["https://youtu.be/source-a"].status, "completed");
    assert.equal(store.runs["https://youtu.be/source-a"].result?.clips.length, 1);
    assert.equal(store.runs[activeSource].result, null);
    assert.equal(runner.isRunning("https://youtu.be/source-a"), false);
    metadata.resolve({ url: "https://youtu.be/source-a" } as StreamProbe);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(probeUpdates, 0, "Late metadata must not change a completed run");
  });

  it("keeps concurrent links independent when they finish in reverse order", async () => {
    const a = deferred<SuggestStreamClipsResult>();
    const b = deferred<SuggestStreamClipsResult>();
    const complete: string[] = [];
    const runner = createStreamAnalysisRunner({
      probe: async () => { throw new Error("Metadata unavailable"); },
      suggest: (url) => url === "a" ? a.promise : b.promise,
      onStart() {}, onProbe() {}, onWatching() {},
      onComplete: (job) => { complete.push(job.url); },
      onFailure: () => assert.fail("Metadata failure must not block selection"),
    });
    const first = runner.start("a", {});
    const second = runner.start("b", {});
    b.resolve(result("b"));
    await second;
    assert.deepEqual(complete, ["b"]);
    assert.equal(runner.isRunning("a"), true);
    a.resolve(result("a"));
    await first;
    assert.deepEqual(complete, ["b", "a"]);
  });

  it("surfaces native errors, releases the lock and allows a successful retry", async () => {
    let attempts = 0;
    const updates: StreamAnalysisJob[] = [];
    const runner = createStreamAnalysisRunner({
      probe: async () => { throw new Error("No thumbnail"); },
      suggest: async (url) => {
        if (++attempts === 1) throw "Local transcription failed";
        return result(url);
      },
      onStart: (job) => { updates.push(job); }, onProbe() {}, onWatching() {},
      onComplete: (job) => { updates.push(job); },
      onFailure: (job) => { updates.push(job); },
    });
    await runner.start("a", {});
    const failed = updates[1];
    assert.equal(failed.status, "failed");
    assert.equal(failed.status === "failed" && failed.error, "Local transcription failed");
    assert.equal(runner.isRunning("a"), false);
    await runner.start("a", {});
    assert.equal(updates[updates.length - 1]?.status, "completed");
    assert.equal(attempts, 2);
  });

  it("arms watching for a live probe and a live-right-now suggest error", async () => {
    const watching: string[] = [];
    const failures: string[] = [];
    const probe = deferred<StreamProbe>();
    const selection = deferred<SuggestStreamClipsResult>();
    const runner = createStreamAnalysisRunner({
      probe: () => probe.promise,
      suggest: () => selection.promise,
      onStart() {},
      onProbe() {},
      onWatching: (job) => { watching.push(job.status); },
      onComplete: () => assert.fail("Live streams must not complete"),
      onFailure: (job) => { failures.push(job.status); },
    });
    const pending = runner.start("https://youtube.com/live/abc", {});
    await Promise.resolve();
    probe.resolve({
      url: "https://youtube.com/live/abc", title: "Live", channel: "C",
      thumbnail: null, duration: 0, view_count: null, upload_date: null, is_live: true,
    });
    selection.reject(new Error("stream_clip.py: that stream is live right now: retry later"));
    await pending;
    assert.ok(watching.includes("watching"));
    assert.deepEqual(failures, []);
    assert.equal(runner.isRunning("https://youtube.com/live/abc"), false);
  });

  it("still completes if a live probe arrives after clips are ready", async () => {
    const selection = deferred<SuggestStreamClipsResult>();
    const metadata = deferred<StreamProbe>();
    const watching: string[] = [];
    let completed = 0;
    const runner = createStreamAnalysisRunner({
      probe: () => metadata.promise,
      suggest: () => selection.promise,
      onStart() {}, onProbe() {},
      onWatching: (job) => { watching.push(job.url); },
      onComplete: () => { completed++; },
      onFailure: () => assert.fail("Unexpected failure"),
    });
    const pending = runner.start("https://youtu.be/vod", {});
    selection.resolve(result("https://youtu.be/vod"));
    await pending;
    assert.equal(completed, 1);
    metadata.resolve({
      url: "https://youtu.be/vod", title: "VOD", channel: "C",
      thumbnail: null, duration: 100, view_count: null, upload_date: null, is_live: true,
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(watching, []);
  });
});
