import test from "node:test";
import assert from "node:assert/strict";
import {
  accountLabel,
  canDispatch,
  canonicalPlatformId,
  connectedPlatformIds,
  extractPostId,
  isPlatformConnected,
  mapRemoteStatus,
  platformFailureMessage,
  postStatusOf,
  pruneSelection,
} from "./channels.ts";
import type { ZernioAccount } from "../types/index.ts";

const acc = (overrides: Partial<ZernioAccount> = {}): ZernioAccount => ({
  id: "acc_1",
  platform: "youtube",
  name: "Studio",
  is_connected: true,
  ...overrides,
});

test("no accounts means nothing is connected (regression: tiktok/youtube faked as linked)", () => {
  const accounts: ZernioAccount[] = [];
  for (const id of ["tiktok", "youtube", "instagram"]) {
    assert.equal(isPlatformConnected(accounts, id), false);
  }
  assert.deepEqual(connectedPlatformIds(accounts), []);
});

test("x accounts count as twitter", () => {
  const accounts = [acc({ platform: "x", is_connected: true })];
  assert.equal(canonicalPlatformId("X"), "twitter");
  assert.equal(isPlatformConnected(accounts, "twitter"), true);
  assert.deepEqual(connectedPlatformIds(accounts), ["twitter"]);
});

test("only gateway-linked platforms count, matched case-insensitively", () => {
  const accounts = [
    acc({ platform: "YouTube", is_connected: true }),
    acc({ id: "acc_2", platform: "tiktok", is_connected: false }),
  ];
  assert.equal(isPlatformConnected(accounts, "youtube"), true);
  assert.equal(isPlatformConnected(accounts, "tiktok"), false);
  assert.deepEqual(connectedPlatformIds(accounts), ["youtube"]);
});

test("account label never invents a handle", () => {
  assert.equal(accountLabel(acc({ username: "@studio" })), "@studio");
  assert.equal(accountLabel(acc({ username: undefined })), "Studio");
  assert.equal(
    accountLabel(acc({ username: undefined, name: "" })),
    "Connected",
  );
});

test("pruneSelection drops disconnected ids", () => {
  const accounts = [acc({ platform: "youtube", is_connected: true })];
  assert.deepEqual(
    pruneSelection(["youtube", "tiktok"], accounts),
    ["youtube"],
  );
  assert.deepEqual(pruneSelection(["tiktok"], []), []);
});

test("canDispatch requires a key and only connected selections", () => {
  const accounts = [acc({ platform: "youtube", is_connected: true })];
  assert.equal(canDispatch("", ["youtube"], accounts), false);
  assert.equal(canDispatch("zr_live_1", [], accounts), false);
  assert.equal(canDispatch("zr_live_1", ["tiktok"], accounts), false);
  assert.equal(canDispatch("zr_live_1", ["youtube"], accounts), true);
  assert.equal(canDispatch("zr_live_1", ["youtube"], []), false);
});

test("extractPostId reads nested and flat id shapes", () => {
  assert.equal(
    extractPostId(JSON.stringify({ post: { _id: "p1" } })),
    "p1",
  );
  assert.equal(extractPostId(JSON.stringify({ post: { id: "p2" } })), "p2");
  assert.equal(extractPostId(JSON.stringify({ _id: "p3" })), "p3");
  assert.equal(extractPostId(JSON.stringify({ id: "p4" })), "p4");
  assert.equal(extractPostId(JSON.stringify({ postId: "p5" })), "p5");
});

test("extractPostId returns null without inventing an id", () => {
  assert.equal(extractPostId("not json"), null);
  assert.equal(extractPostId(JSON.stringify({ ok: true })), null);
  assert.equal(extractPostId(JSON.stringify({ post: { _id: "  " } })), null);
  assert.equal(extractPostId("123"), null);
});

test("extractPostId reads SDK-style data envelopes", () => {
  assert.equal(
    extractPostId(JSON.stringify({ data: { post: { _id: "d1" } } })),
    "d1",
  );
  assert.equal(
    extractPostId(JSON.stringify({ data: { post: { id: "d2" } } })),
    "d2",
  );
  assert.equal(extractPostId(JSON.stringify({ data: { _id: "d3" } })), "d3");
});

test("platformFailureMessage names only the failed channels", () => {
  const text = JSON.stringify({
    post: {
      status: "failed",
      platforms: [
        { platform: "tiktok", status: "failed", errorMessage: "Missing consent" },
        { platform: "youtube", status: "published" },
      ],
    },
  });
  assert.equal(
    platformFailureMessage(text),
    "Zernio could not publish: tiktok: Missing consent",
  );
  assert.equal(
    platformFailureMessage(JSON.stringify({ post: { status: "published" } })),
    null,
  );
});

test("postStatusOf reads post and data.post statuses", () => {
  assert.equal(
    postStatusOf(JSON.stringify({ post: { _id: "p1", status: "published" } })),
    "published",
  );
  assert.equal(
    postStatusOf(JSON.stringify({ data: { post: { status: "failed" } } })),
    "failed",
  );
  assert.equal(postStatusOf("not json"), null);
  assert.equal(postStatusOf(JSON.stringify({ ok: true })), null);
});

test("mapRemoteStatus maps known states and rejects unknown ones", () => {
  assert.equal(mapRemoteStatus("published"), "completed");
  assert.equal(mapRemoteStatus("POSTED"), "completed");
  assert.equal(mapRemoteStatus("failed"), "failed");
  assert.equal(mapRemoteStatus("Scheduled"), "queued");
  assert.equal(mapRemoteStatus("processing"), "publishing");
  assert.equal(mapRemoteStatus("mystery-state"), null);
  assert.equal(mapRemoteStatus(""), null);
});
