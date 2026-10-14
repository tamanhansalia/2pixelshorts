import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCredentialStore, EMPTY_API_KEYS, type ApiKeys, type CredentialProvider } from "./credentials.ts";
import { API_KEY_ZERNIO } from "./appReset.ts";

function fixture(initial: Partial<ApiKeys> = {}, legacy = "") {
  const keys: ApiKeys = { ...EMPTY_API_KEYS, ...initial };
  const storage = new Map([[API_KEY_ZERNIO, legacy]]);
  const writes: string[] = [];
  let fail = false;
  const store = createCredentialStore({
    read: async () => ({ ...keys }),
    write: async (provider: CredentialProvider, value: string) => {
      if (fail) throw new Error("vault locked");
      keys[provider] = value;
      writes.push(provider);
    },
    clear: async () => {
      if (fail) throw new Error("vault locked");
      Object.assign(keys, EMPTY_API_KEYS);
    },
  }, { getItem: (key) => storage.get(key) ?? null, removeItem: (key) => { storage.delete(key); } });
  return { keys, storage, writes, store, lock: () => { fail = true; } };
}

describe("secure credential migration", () => {
  it("moves a legacy key before deleting the plaintext copy", async () => {
    const f = fixture({}, "  old-secret  ");
    assert.equal((await f.store.load()).zernio, "old-secret");
    assert.deepEqual(f.writes, ["zernio"]);
    assert.equal(f.storage.has(API_KEY_ZERNIO), false);
  });
  it("preserves the recoverable original when the vault rejects migration", async () => {
    const f = fixture({}, "old-secret");
    f.lock();
    await assert.rejects(() => f.store.load(), /locked/);
    assert.equal(f.storage.get(API_KEY_ZERNIO), "old-secret");
  });
  it("never overwrites a newer securely stored credential", async () => {
    const f = fixture({ zernio: "new-secret" }, "old-secret");
    assert.equal((await f.store.load()).zernio, "new-secret");
    assert.deepEqual(f.writes, []);
    assert.equal(f.storage.has(API_KEY_ZERNIO), false);
  });
  it("saves normalized keys without storing plaintext", async () => {
    const f = fixture();
    await f.store.save("youtube", "  fresh-key  ");
    assert.equal(f.keys.youtube, "fresh-key");
    assert.equal(f.storage.size, 1); // unrelated legacy fixture untouched
  });
  it("clears both credential stores only after the secure deletion succeeds", async () => {
    const f = fixture({ zernio: "key" }, "old-secret");
    f.lock();
    await assert.rejects(() => f.store.clear(), /locked/);
    assert.equal(f.storage.get(API_KEY_ZERNIO), "old-secret");
  });
  it("reset removes secure and legacy credentials", async () => {
    const f = fixture({ zernio: "key" }, "old-secret");
    await f.store.clear();
    assert.deepEqual(f.keys, EMPTY_API_KEYS);
    assert.equal(f.storage.size, 0);
  });
});
