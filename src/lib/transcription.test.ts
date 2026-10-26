import { it } from "node:test";
import assert from "node:assert/strict";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { loadTranscriptionProvider, saveTranscriptionProvider, transcriptionInvokeParams, TRANSCRIPTION_PROVIDER_KEY } from "./transcription.ts";
import { resetAllLocalData } from "./appReset.ts";
import { renderShort, generateSeoMetadata, readSourceTranscript, probeTranscription } from "./ipc.ts";
import { startRenderJob } from "./jobs.ts";
import { suggestStreamClips } from "./streamClips.ts";

function store() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); } };
}

it("defaults to Local and never infers cloud use from an API key", () => {
  const storage = store();
  assert.equal(loadTranscriptionProvider(storage), "local");
  assert.deepEqual(transcriptionInvokeParams("secret", "local"), { transcriptionProvider: "local", elevenlabsKey: null });
  storage.setItem(TRANSCRIPTION_PROVIDER_KEY, "auto");
  assert.equal(loadTranscriptionProvider(storage), "local");
  assert.equal(loadTranscriptionProvider({ getItem: () => { throw new Error("locked"); } }), "local");
});

it("persists the provider independently of credentials and resets it with app data", () => {
  const storage = store();
  saveTranscriptionProvider("elevenlabs", storage);
  assert.equal(loadTranscriptionProvider(storage), "elevenlabs");
  assert.deepEqual([...storage.values.entries()], [[TRANSCRIPTION_PROVIDER_KEY, "elevenlabs"]]);
  resetAllLocalData(storage);
  assert.equal(loadTranscriptionProvider(storage), "local");
});

it("all transcription entry points honor the saved provider and keep cloud keys out of local jobs", async () => {
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const priorStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storage = store();
  Object.defineProperty(globalThis, "window", { value: {}, writable: true, configurable: true });
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  mockIPC((command, args) => {
    calls.push({ command, args: args as Record<string, unknown> });
    return command === "generate_seo_metadata" ? "{}" : command === "suggest_stream_clips" ? { clips: [] } : {};
  });
  try {
    for (const provider of ["local", "elevenlabs"] as const) {
      saveTranscriptionProvider(provider);
      calls.length = 0;
      const params = { input_video: "source.mp4", output_video: "short.mp4", preset_id: "vertical_clean", elevenlabs_key: "saved-key" };
      await renderShort(params);
      await startRenderJob(params);
      await generateSeoMetadata("source.mp4", undefined, undefined, "saved-key");
      await readSourceTranscript("source.mp4", "saved-key");
      await suggestStreamClips("https://youtu.be/abcdefghijk", { elevenlabsKey: "saved-key" });
      assert.equal(calls.length, 5);
      for (const call of calls) {
        assert.equal(call.args.transcriptionProvider, provider, call.command);
        assert.equal(call.args.elevenlabsKey, provider === "local" ? null : "saved-key", call.command);
      }
      await probeTranscription("saved-key");
      assert.equal(calls[5].args.transcriptionProvider, provider);
      assert.equal(calls[5].args.elevenlabsKey, "saved-key", "Readiness can report a saved key in Local mode");
    }
  } finally {
    clearMocks();
    if (priorWindow) Object.defineProperty(globalThis, "window", priorWindow); else Reflect.deleteProperty(globalThis, "window");
    if (priorStorage) Object.defineProperty(globalThis, "localStorage", priorStorage); else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
