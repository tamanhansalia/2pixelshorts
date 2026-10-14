import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { STREAM_RUNS_KEY } from "./streamRuns.ts";
import { RENDER_HISTORY_KEY } from "./renderHistory.ts";
import { STUDIO_STORE_KEY } from "./studioProjects.ts";
import type { KeyValueStorage } from "./channelProfiles.ts";
import {
  APP_STORAGE_KEYS,
  resetAllLocalData,
} from "./appReset.ts";

function fakeStore(seed: Record<string, string> = {}): KeyValueStorage & {
  data: Record<string, string>;
} {
  const data = { ...seed };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
    },
    removeItem: (k) => {
      delete data[k];
    },
  };
}

describe("app reset", () => {
  it("removes every known app key and reports them", () => {
    const seed: Record<string, string> = {};
    for (const key of APP_STORAGE_KEYS) seed[key] = "value";
    seed["unrelated_key"] = "keep me";
    const store = fakeStore(seed);
    const removed = resetAllLocalData(store);
    assert.deepEqual([...removed].sort(), [...APP_STORAGE_KEYS].sort());
    assert.deepEqual(store.data, { unrelated_key: "keep me" });
  });

  it("covers the canonical store keys by construction", () => {
    assert.ok(APP_STORAGE_KEYS.includes(STUDIO_STORE_KEY));
    assert.ok(APP_STORAGE_KEYS.includes(RENDER_HISTORY_KEY));
    assert.ok(APP_STORAGE_KEYS.includes(STREAM_RUNS_KEY));
    assert.ok(APP_STORAGE_KEYS.includes("2pixel_zernio_key"));
    assert.ok(APP_STORAGE_KEYS.includes("2pixel_elevenlabs_key"));
    assert.ok(APP_STORAGE_KEYS.includes("2pixel_youtube_key"));
    assert.ok(APP_STORAGE_KEYS.includes("2pixel_schedule_queue"));
    assert.ok(APP_STORAGE_KEYS.includes("2pixel_channel_profiles"));
    assert.ok(APP_STORAGE_KEYS.includes("2pixel_default_channel"));
    assert.equal(new Set(APP_STORAGE_KEYS).size, APP_STORAGE_KEYS.length);
  });

  it("removes saved stream analysis as part of a complete reset", () => {
    const store = fakeStore({ [STREAM_RUNS_KEY]: '{"runs":{"saved-stream":{}}}' });
    resetAllLocalData(store);
    assert.equal(store.getItem(STREAM_RUNS_KEY), null);
  });

  it("keeps going when one key removal throws", () => {
    const store = fakeStore({ a: "1", b: "2" });
    const throwing: KeyValueStorage = {
      ...store,
      removeItem: (k) => {
        if (k === APP_STORAGE_KEYS[0]) throw new Error("locked");
        delete store.data[k];
      },
    };
    const removed = resetAllLocalData(throwing);
    assert.equal(removed.length, APP_STORAGE_KEYS.length - 1);
    assert.ok(!removed.includes(APP_STORAGE_KEYS[0]));
  });

  it("does nothing without storage", () => {
    const globalRef = globalThis as Record<string, unknown>;
    const saved = globalRef.localStorage;
    globalRef.localStorage = undefined;
    try {
      assert.deepEqual(resetAllLocalData(), []);
    } finally {
      globalRef.localStorage = saved;
    }
  });
});
