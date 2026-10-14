import { it } from "node:test";
import assert from "node:assert/strict";
import { normalizeIpcError } from "./invoke.ts";

it("preserves actionable native failure text for the UI", async () => {
  await assert.rejects(() => normalizeIpcError(() => Promise.reject("Output must differ from the source video")), /Output must differ/);
});
it("keeps JavaScript error identity and successful results", async () => {
  const original = new Error("existing failure");
  await assert.rejects(() => normalizeIpcError(() => Promise.reject(original)), (error) => error === original);
  assert.equal(await normalizeIpcError(() => Promise.resolve("result")), "result");
});
