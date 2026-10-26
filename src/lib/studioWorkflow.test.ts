import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveStreamRestore, resolveStudioStage } from "./studioWorkflow.ts";

describe("resolveStudioStage", () => {
  it("stays on Video until a file is loaded", () => {
    assert.equal(resolveStudioStage("captions", false), "source");
    assert.equal(resolveStudioStage("captions", true), "captions");
    assert.equal(resolveStudioStage("nope", true), "edit");
  });
});

describe("resolveStreamRestore", () => {
  it("keeps Plus / new-short empty even when a clip job is running", () => {
    assert.equal(
      resolveStreamRestore({ startBlank: true, hasSourceInput: false, hasBusyClipJob: true }),
      "none",
    );
    assert.equal(
      resolveStreamRestore({ startBlank: true, hasSourceInput: true, hasBusyClipJob: false }),
      "none",
    );
  });

  it("reopens a busy clip job when returning to Studio", () => {
    assert.equal(
      resolveStreamRestore({ startBlank: false, hasSourceInput: true, hasBusyClipJob: true }),
      "busy-job",
    );
  });

  it("does not refill a loaded file with the last stream", () => {
    assert.equal(
      resolveStreamRestore({ startBlank: false, hasSourceInput: true, hasBusyClipJob: false }),
      "none",
    );
  });

  it("reopens the last stream when returning to an empty Studio", () => {
    assert.equal(
      resolveStreamRestore({ startBlank: false, hasSourceInput: false, hasBusyClipJob: false }),
      "recent-run",
    );
  });
});
