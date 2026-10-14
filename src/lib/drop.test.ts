import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyBrowserFile,
  isDropOverRect,
  pickDroppedVideo,
} from "./drop.ts";

describe("pickDroppedVideo", () => {
  it("returns null when nothing was dropped", () => {
    assert.equal(pickDroppedVideo([]), null);
  });

  it("prefers the video file over other paths", () => {
    assert.equal(
      pickDroppedVideo(["/tmp/notes.txt", "/tmp/clip.MOV", "/tmp/a.png"]),
      "/tmp/clip.MOV",
    );
  });

  it("matches video extensions case-insensitively", () => {
    assert.equal(pickDroppedVideo(["/tmp/CLIP.Mp4"]), "/tmp/CLIP.Mp4");
  });

  it("falls back to the first path so probe can validate it", () => {
    assert.equal(pickDroppedVideo(["/tmp/noext"]), "/tmp/noext");
  });
});

describe("isDropOverRect", () => {
  const rect = { left: 100, right: 300, top: 200, bottom: 400 };

  it("accepts a point inside the rect at scale 1", () => {
    assert.equal(isDropOverRect({ x: 150, y: 250 }, rect, 1), true);
  });

  it("accepts points on the edges", () => {
    assert.equal(isDropOverRect({ x: 100, y: 200 }, rect, 1), true);
    assert.equal(isDropOverRect({ x: 300, y: 400 }, rect, 1), true);
  });

  it("rejects a point outside the rect", () => {
    assert.equal(isDropOverRect({ x: 50, y: 250 }, rect, 1), false);
    assert.equal(isDropOverRect({ x: 150, y: 500 }, rect, 1), false);
  });

  it("converts Tauri physical pixels with the scale factor", () => {
    // (150, 250) CSS px at 200% scaling arrives as (300, 500) physical px.
    assert.equal(isDropOverRect({ x: 300, y: 500 }, rect, 2), true);
    // The same raw numbers at scale 1 fall outside the rect.
    assert.equal(isDropOverRect({ x: 300, y: 500 }, rect, 1), false);
  });

  it("treats a non-positive scale as 1", () => {
    assert.equal(isDropOverRect({ x: 150, y: 250 }, rect, 0), true);
  });
});

describe("classifyBrowserFile", () => {
  it("prefers a real filesystem path when one is exposed", () => {
    assert.deepEqual(
      classifyBrowserFile({ path: "C:\\clips\\a.mp4", name: "a.mp4" }),
      { kind: "path", path: "C:\\clips\\a.mp4" },
    );
  });

  it("marks a bare browser file name as name-only, not a path", () => {
    assert.deepEqual(classifyBrowserFile({ name: "clip.mp4" }), {
      kind: "name-only",
      name: "clip.mp4",
    });
  });

  it("reports empty when no file was dropped", () => {
    assert.deepEqual(classifyBrowserFile(undefined), { kind: "empty" });
    assert.deepEqual(classifyBrowserFile(null), { kind: "empty" });
    assert.deepEqual(classifyBrowserFile({}), { kind: "empty" });
    assert.deepEqual(classifyBrowserFile({ path: "  ", name: " " }), {
      kind: "empty",
    });
  });
});
