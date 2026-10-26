import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createPinnedCommentStore,
  enrichPublishPayload,
  extractHashtags,
} from "./publishExtras.ts";
import type { SocialPublishPayload } from "../types/index.ts";

function memory() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

const base: SocialPublishPayload = {
  title: "Rust pooling in 60s",
  description: "Your pool leaks.\nFix it.\n\n#Rust #tokio #rust #deadpool",
  platforms: ["youtube"],
  video_path: "/v/out.mp4",
  publish_now: true,
};

describe("publish extras", () => {
  it("extracts deduped postable hashtags from a caption", () => {
    assert.deepEqual(extractHashtags(base.description), ["#rust", "#tokio", "#deadpool"]);
    assert.deepEqual(extractHashtags("price#1 and #"), []);
  });

  it("fills only what the payload leaves empty", () => {
    const filled = enrichPublishPayload(base, {
      pinnedComment: " Which crate? ",
      youtubeCategory: "28",
    });
    assert.deepEqual(filled.hashtags, ["#rust", "#tokio", "#deadpool"]);
    assert.equal(filled.first_comment, "Which crate?");
    assert.equal(filled.youtube_category, "28");

    const explicit = enrichPublishPayload(
      { ...base, hashtags: ["#x"], first_comment: "Mine", youtube_category: "27" },
      { pinnedComment: "Other", youtubeCategory: "28" },
    );
    assert.deepEqual(explicit.hashtags, ["#x"]);
    assert.equal(explicit.first_comment, "Mine");
    assert.equal(explicit.youtube_category, "27");

    const bare = enrichPublishPayload({ ...base, description: "no tags" }, {});
    assert.equal("hashtags" in bare, false);
    assert.equal("first_comment" in bare, false);
    assert.equal("youtube_category" in bare, false);
  });

  it("stores pinned comments per video path and clears on blank", () => {
    const store = createPinnedCommentStore(memory());
    store.set(["/v/in.mov", "/v/out.mp4", ""], "Which crate?");
    assert.equal(store.get("/v/out.mp4"), "Which crate?");
    assert.equal(store.get("/v/in.mov"), "Which crate?");
    store.set(["/v/out.mp4"], "  ");
    assert.equal(store.get("/v/out.mp4"), "");
    assert.equal(store.get(""), "");
  });
});
