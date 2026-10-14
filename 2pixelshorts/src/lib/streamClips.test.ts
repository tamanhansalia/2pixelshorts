import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  STREAM_ASPECT_RATIOS,
  STREAM_DEFAULTS,
  STREAM_LAYOUTS,
  STREAM_LENGTHS,
  STREAM_REVIEW_MODELS,
  aspectDims,
  clipOutputPath,
  dirPrefixOf,
  effectiveLayoutForAspect,
  formatClipRange,
  formatClipTime,
  isLiveStreamError,
  isSplitStreamLayout,
  isYoutubeUrl,
  needsNineSixteenCanvas,
  parseAspectRatio,
  reviewModelOption,
  streamSuggestOptions,
} from "./streamClips.ts";

describe("isLiveStreamError", () => {
  it("matches still-live failures, not real errors", () => {
    assert.equal(
      isLiveStreamError(new Error("that stream is live right now: retry later")),
      true,
    );
    assert.equal(isLiveStreamError("LIVE RIGHT NOW"), true);
    assert.equal(isLiveStreamError(new Error("no English captions")), false);
    assert.equal(isLiveStreamError(""), false);
    assert.equal(isLiveStreamError(null), false);
  });
});

describe("isYoutubeUrl", () => {
  it("accepts watch, short, live and shorts links", () => {
    for (const url of [
      "https://www.youtube.com/watch?v=abc123",
      "https://youtu.be/abc123",
      "https://www.youtube.com/live/abc123",
      "https://www.youtube.com/shorts/abc123",
      "https://m.youtube.com/watch?v=abc123",
    ]) {
      assert.equal(isYoutubeUrl(url), true, url);
    }
  });

  it("accepts completed Twitch VODs but not live channels", () => {
    assert.equal(isYoutubeUrl("https://www.twitch.tv/videos/1234567890"), true);
    assert.equal(isYoutubeUrl("https://www.twitch.tv/somechannel"), false);
  });

  it("rejects non-video URLs and garbage", () => {
    for (const url of [
      "https://example.com/video",
      "not a url",
      "",
      "ftp://www.youtube.com/watch?v=abc123",
      "https://user:secret@www.youtube.com/watch?v=abc123",
      "https://www.youtube.com:8443/watch?v=abc123",
    ]) {
      assert.equal(isYoutubeUrl(url), false, url);
    }
  });
});

describe("formatClipTime", () => {
  it("renders mm:ss under an hour and h:mm:ss above", () => {
    assert.equal(formatClipTime(45), "0:45");
    assert.equal(formatClipTime(754), "12:34");
    assert.equal(formatClipTime(3720), "1:02:00");
  });

  it("clamps negatives to zero", () => {
    assert.equal(formatClipTime(-5), "0:00");
  });
});

describe("formatClipRange", () => {
  it("joins start and end timecodes", () => {
    assert.equal(formatClipRange(745, 778), "12:25–12:58");
  });
});

describe("clipOutputPath", () => {
  it("suffixes the stem keeping extension and directory", () => {
    assert.equal(clipOutputPath("final_short.mp4", 0), "final_short_clip1.mp4");
    assert.equal(
      clipOutputPath("C:\\vids\\final_short.mp4", 2),
      "C:\\vids\\final_short_clip3.mp4",
    );
  });

  it("falls back to a default base", () => {
    assert.equal(clipOutputPath("", 1), "final_short_clip2.mp4");
  });
});

describe("STREAM_REVIEW_MODELS", () => {
  it("offers every agent reviewer plus the heuristic fallback", () => {
    const ids = STREAM_REVIEW_MODELS.map((m) => m.id);
    assert.deepEqual(ids, ["claude", "codex", "agy", "grok", "auto"]);
    for (const model of STREAM_REVIEW_MODELS) {
      assert.ok(model.name.length > 0, model.id);
    }
  });
});

describe("reviewModelOption", () => {
  it("labels available models with a check", () => {
    assert.deepEqual(
      reviewModelOption(
        { id: "claude", name: "Claude" },
        { available: true, probing: false },
      ),
      { value: "claude", label: "Claude ✓", disabled: false },
    );
  });

  it("disables and labels unavailable models", () => {
    assert.deepEqual(
      reviewModelOption(
        { id: "grok", name: "Grok" },
        { available: false, probing: false },
      ),
      { value: "grok", label: "Grok — unavailable", disabled: true },
    );
  });

  it("keeps everything enabled while probing or unknown", () => {
    for (const state of [
      { available: null as boolean | null, probing: true },
      { available: null as boolean | null, probing: false },
    ]) {
      assert.deepEqual(
        reviewModelOption({ id: "codex", name: "Codex" }, state),
        { value: "codex", label: "Codex", disabled: false },
      );
    }
  });
});

describe("STREAM_LAYOUTS", () => {
  it("offers auto, single, both split directions, and face-only", () => {
    assert.deepEqual(
      STREAM_LAYOUTS.map((l) => l.id),
      ["auto", "single", "screen-top", "face-top", "face-only"],
    );
    assert.equal(isSplitStreamLayout("single"), false);
    assert.equal(isSplitStreamLayout("screen-top"), true);
    assert.equal(isSplitStreamLayout("face-top"), true);
    assert.equal(isSplitStreamLayout("face-only"), false);
    assert.equal(isSplitStreamLayout("auto"), false);
  });

  it("marks split and face-only framings as 9:16-only", () => {
    assert.equal(needsNineSixteenCanvas("screen-top"), true);
    assert.equal(needsNineSixteenCanvas("face-top"), true);
    assert.equal(needsNineSixteenCanvas("face-only"), true);
    assert.equal(needsNineSixteenCanvas("single"), false);
    assert.equal(needsNineSixteenCanvas("auto"), false);
  });
});

describe("dirPrefixOf", () => {
  it("keeps the directory separator and drops the file", () => {
    assert.equal(dirPrefixOf("C:\\vids\\final_short.mp4"), "C:\\vids\\");
    assert.equal(dirPrefixOf("/tmp/out.mp4"), "/tmp/");
    assert.equal(dirPrefixOf("final_short.mp4"), "");
  });
});

describe("STREAM_ASPECT_RATIOS", () => {
  it("offers vertical, square, and wide canvases", () => {
    assert.deepEqual(
      STREAM_ASPECT_RATIOS.map((a) => a.id),
      ["9:16", "1:1", "16:9"],
    );
    assert.deepEqual(aspectDims("9:16"), { width: 1080, height: 1920 });
    assert.deepEqual(aspectDims("1:1"), { width: 1080, height: 1080 });
    assert.deepEqual(aspectDims("16:9"), { width: 1920, height: 1080 });
  });

  it("falls back to 9:16 for unknown values", () => {
    assert.equal(parseAspectRatio("bogus"), "9:16");
    assert.equal(parseAspectRatio(null), "9:16");
    assert.equal(effectiveLayoutForAspect("screen-top", "1:1"), "single");
    assert.equal(effectiveLayoutForAspect("screen-top", "9:16"), "screen-top");
    assert.equal(effectiveLayoutForAspect("single", "16:9"), "single");
    assert.equal(effectiveLayoutForAspect("face-only", "1:1"), "single");
    assert.equal(effectiveLayoutForAspect("face-only", "9:16"), "face-only");
    assert.equal(effectiveLayoutForAspect("auto", "1:1"), "auto");
    assert.equal(effectiveLayoutForAspect("auto", "9:16"), "auto");
  });
});

describe("streamSuggestOptions", () => {
  it("uses the Standard band with the default scoring budget", () => {
    const opts = streamSuggestOptions({
      agentId: "claude",
      channelContext: "gaming",
      promptHook: "keep hooks punchy",
    });
    assert.equal(opts.agentId, "claude");
    assert.equal(opts.channelContext, "gaming");
    assert.equal(opts.promptHook, "keep hooks punchy");
    assert.equal(opts.threshold, STREAM_DEFAULTS.threshold);
    assert.equal(opts.minLength, STREAM_LENGTHS.standard.min);
    assert.equal(opts.maxLength, STREAM_LENGTHS.standard.max);
    assert.equal(opts.maxClips, STREAM_DEFAULTS.maxClips);
    assert.equal(opts.minGap, STREAM_DEFAULTS.minGap);
  });
});
