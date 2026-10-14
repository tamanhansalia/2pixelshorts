import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createProfileStore,
  getEffectiveContext,
  renderProfileText,
  type ChannelProfile,
} from "./channelProfiles.ts";
import type { KeyValueStorage } from "./channelProfiles.ts";

function memory(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

const SAMPLE: ChannelProfile = {
  id: "acme",
  name: "Acme",
  niche: "Woodworking",
  audience: "Makers",
  tone: "Calm",
  cta: "Subscribe!",
  keywords: ["wood", "shop"],
};

describe("channel profiles store", () => {
  it("seeds a 2PixelSpace default on first load", () => {
    const store = createProfileStore(memory());
    const profiles = store.loadProfiles();
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].name, "2PixelSpace");
    assert.equal(store.getDefaultProfile()?.id, profiles[0].id);
  });

  it("migrates a customized legacy context into the seed", () => {
    const storage = memory();
    storage.setItem("tuari_channel_context", "My cooking channel");
    const store = createProfileStore(storage);
    assert.equal(store.loadProfiles()[0].niche, "My cooking channel");
  });

  it("persists profiles and default selection", () => {
    const store = createProfileStore(memory());
    store.saveProfiles([SAMPLE]);
    store.setDefaultProfileId("acme");
    assert.deepEqual(store.loadProfiles(), [SAMPLE]);
    assert.equal(store.getDefaultProfile()?.name, "Acme");
  });

  it("falls back to the first profile when default id is unknown", () => {
    const store = createProfileStore(memory());
    store.saveProfiles([SAMPLE]);
    store.setDefaultProfileId("missing");
    assert.equal(store.getDefaultProfile()?.id, "acme");
  });
});

describe("effective context resolution", () => {
  it("override wins when non-blank", () => {
    const store = createProfileStore(memory());
    store.saveProfiles([SAMPLE]);
    assert.equal(getEffectiveContext("  custom  ", store), "custom");
  });

  it("blank override falls back to the default profile text", () => {
    const store = createProfileStore(memory());
    store.saveProfiles([SAMPLE]);
    store.setDefaultProfileId("acme");
    const resolved = getEffectiveContext("   ", store);
    assert.match(resolved, /Acme/);
    assert.match(resolved, /Woodworking/);
    assert.match(resolved, /Makers/);
  });

  it("renders all profile fields as text", () => {
    const text = renderProfileText(SAMPLE);
    for (const part of ["Acme", "Woodworking", "Makers", "Calm", "Subscribe!", "wood, shop"]) {
      assert.ok(text.includes(part), `missing ${part}`);
    }
  });
});
