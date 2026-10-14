import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { openExternalUrl, probeTranscription } from "./ipc.ts";

// Covers the browser fallback branch. The Tauri branch (opener plugin)
// needs the desktop runtime, so it is verified by build + manual click.
describe("openExternalUrl browser fallback", () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("opens the URL in a new tab", async () => {
    const calls: unknown[][] = [];
    (globalThis as { window: unknown }).window = {
      open: (...args: unknown[]) => {
        calls.push(args);
        return null;
      },
    };
    await openExternalUrl("https://example.com/keys");
    assert.deepEqual(calls, [["https://example.com/keys", "_blank", "noopener,noreferrer"]]);
  });

  it("rejects with the URL when no window exists", async () => {
    await assert.rejects(
      () => openExternalUrl("https://example.com/keys"),
      /https:\/\/example\.com\/keys/,
    );
  });

  it("rejects scripts, local files and credential-bearing links", async () => {
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "https://user:secret@example.com"]) {
      await assert.rejects(() => openExternalUrl(url), /HTTPS/);
    }
  });
});

// Covers the browser fallback branch (no window → not Tauri). The desktop
// branch shells out to the real interpreter and is verified by cargo check.
describe("probeTranscription browser fallback", () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("reports no engine without a key", async () => {
    const status = await probeTranscription("");
    assert.equal(status.elevenlabs_key_configured, false);
    assert.equal(status.local_available, false);
    assert.equal(status.active_engine, "none");
  });

  it("reports elevenlabs when a key is set", async () => {
    const status = await probeTranscription("  secret-key  ");
    assert.equal(status.elevenlabs_key_configured, true);
    assert.equal(status.active_engine, "elevenlabs");
  });
});
