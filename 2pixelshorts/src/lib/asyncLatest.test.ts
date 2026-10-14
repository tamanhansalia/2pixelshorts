import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLatestGuard, isUnsavedEdit } from "./asyncLatest.ts";

// Guards the Engine-page race: a slow probe started with the old (empty)
// key must not overwrite the result of the newer post-save probe, or the
// UI reports "Missing" for a key that was just saved.
describe("createLatestGuard", () => {
  it("keeps only the newest request as latest", () => {
    const guard = createLatestGuard();
    const first = guard.next();
    const second = guard.next();
    assert.equal(guard.isLatest(first), false);
    assert.equal(guard.isLatest(second), true);
  });

  it("drops a stale slow probe in favor of the post-save probe", async () => {
    const guard = createLatestGuard();
    let applied: string | null = null;
    const applyIfLatest = (id: number, value: string) => {
      if (guard.isLatest(id)) applied = value;
    };
    // Mount-time probe with the old empty key resolves LAST.
    const stale = (async () => {
      const id = guard.next();
      await new Promise((r) => setTimeout(r, 30));
      applyIfLatest(id, "missing");
    })();
    // Post-save probe with the new key resolves FIRST.
    const fresh = (async () => {
      const id = guard.next();
      await new Promise((r) => setTimeout(r, 5));
      applyIfLatest(id, "saved");
    })();
    await Promise.all([stale, fresh]);
    assert.equal(applied, "saved");
  });

  it("starts independent per component instance", () => {
    const a = createLatestGuard();
    const b = createLatestGuard();
    const idA = a.next();
    b.next();
    assert.equal(a.isLatest(idA), true);
  });
});

describe("isUnsavedEdit", () => {
  it("is false when draft matches the saved key", () => {
    assert.equal(isUnsavedEdit("sk-live", "sk-live"), false);
  });

  it("ignores surrounding whitespace", () => {
    assert.equal(isUnsavedEdit("  sk-live  ", "sk-live"), false);
  });

  it("is true when the typed key differs from the saved key", () => {
    assert.equal(isUnsavedEdit("sk-new", ""), true);
    assert.equal(isUnsavedEdit("sk-new", "sk-old"), true);
    assert.equal(isUnsavedEdit("", "sk-old"), true);
  });
});
