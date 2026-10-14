import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  failSeoJob,
  finishSeoJob,
  startSeoJob,
  type StudioSeoJobs,
} from "./seoJobs.ts";
import type { SeoMetadata } from "../types/index.ts";

function meta(): SeoMetadata {
  return {
    title: "T",
    title_alternatives: ["T2"],
    description: "D",
    tags: ["x"],
    hashtags: ["#x"],
    seo_score: 80,
    keywords_analyzed: ["x"],
  };
}

describe("studio SEO jobs", () => {
  it("records running, then done for the live request", () => {
    let jobs: StudioSeoJobs = {};
    jobs = startSeoJob(jobs, "a.mp4", 1, "2026-01-01T00:00:00.000Z");
    assert.equal(jobs["a.mp4"].status, "running");
    jobs = finishSeoJob(jobs, "a.mp4", 1, meta(), "2026-01-01T00:01:00.000Z");
    assert.equal(jobs["a.mp4"].status, "done");
    if (jobs["a.mp4"].status === "done") {
      assert.equal(jobs["a.mp4"].meta.title, "T");
    }
  });

  it("ignores a stale finish from a superseded request", () => {
    let jobs: StudioSeoJobs = {};
    jobs = startSeoJob(jobs, "a.mp4", 1, "t1");
    jobs = startSeoJob(jobs, "a.mp4", 2, "t2");
    const before = jobs;
    jobs = finishSeoJob(jobs, "a.mp4", 1, meta(), "t3");
    assert.equal(jobs, before);
    assert.equal(jobs["a.mp4"].status, "running");
    if (jobs["a.mp4"].status === "running") {
      assert.equal(jobs["a.mp4"].requestId, 2);
    }
  });

  it("ignores a stale failure and an unknown target", () => {
    let jobs: StudioSeoJobs = {};
    jobs = startSeoJob(jobs, "a.mp4", 1, "t1");
    jobs = startSeoJob(jobs, "a.mp4", 2, "t2");
    const before = jobs;
    jobs = failSeoJob(jobs, "a.mp4", 1, "boom", "t3");
    assert.equal(jobs, before);
    jobs = failSeoJob(jobs, "missing.mp4", 9, "boom", "t3");
    assert.equal(jobs, before);
  });

  it("records failures for the live request", () => {
    let jobs: StudioSeoJobs = {};
    jobs = startSeoJob(jobs, "a.mp4", 1, "t1");
    jobs = failSeoJob(jobs, "a.mp4", 1, "boom", "t2");
    assert.equal(jobs["a.mp4"].status, "error");
    if (jobs["a.mp4"].status === "error") {
      assert.equal(jobs["a.mp4"].message, "boom");
    }
  });
});
