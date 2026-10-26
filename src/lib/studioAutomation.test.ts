import { it } from "node:test";
import assert from "node:assert/strict";
import { automationParams, nextAutomaticExport, normalizeEditStrategy } from "./studioAutomation.ts";
import { blankStudioDraft, emptyStudioStore, normalizeStudioStore } from "./studioProjects.ts";
import { generateSeoMetadata, probeVideo, renderShort, runCli } from "./ipc.ts";
import { probeStream, suggestStreamClips, fetchStreamClip } from "./streamClips.ts";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { startRenderJob } from "./jobs.ts";

it("automatic exports preserve previous modes and repeated exports as separate files", () => {
  const used = ["/videos/demo.mp4"];
  const highlight = nextAutomaticExport(used[0], "highlights", used);
  assert.equal(highlight, "/videos/demo-highlights.mp4");
  used.push(highlight);
  const full = nextAutomaticExport(highlight, "full", used);
  assert.equal(full, "/videos/demo-full.mp4");
  used.push(full);
  assert.equal(nextAutomaticExport(full, "highlights", used), "/videos/demo-highlights-2.mp4");
  assert.equal(nextAutomaticExport("/new/export.mp4", "cleanup", used), "/new/export.mp4");
});

it("cleanup reaches the engine without an AI budget or transcript plan", () => {
  const params = automationParams("cleanup", "claude", 30, true, false);
  assert.equal(params.edit_strategy, "cleanup");
  assert.equal(params.agent_id, "auto");
  assert.equal(params.target_duration, undefined);
  assert.equal(params.edit_plan, undefined);
  assert.equal(params.remove_retakes, false);
});
it("highlights forward the chosen real model and explicit target", () => {
  const params = automationParams("highlights", "codex", 60, false, true);
  assert.equal(params.agent_id, "codex");
  assert.equal(params.target_duration, 60);
  assert.equal(params.remove_silence, false);
});
it("optional instructions and model reach native IPC alongside the selected cutting mode", async () => {
  const params = automationParams("cleanup", "codex", 30, true, true, "  Keep the complete tutorial, remove false starts.  ", true, "selected-model");
  assert.equal(params.prompt_hook, "Keep the complete tutorial, remove false starts.");
  assert.equal(params.edit_strategy, "cleanup");
  assert.equal(params.remove_retakes, true);
  assert.equal(params.model_id, "selected-model");
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true, writable: true });
  const calls: Record<string, unknown>[] = [];
  mockIPC((_command, args) => { calls.push(args as Record<string, unknown>); return "custom-job"; });
  try {
    await startRenderJob({ input_video: "in.mov", output_video: "out.mp4", preset_id: "subtle_clean", ...params });
    assert.equal(calls[0].promptHook, params.prompt_hook);
    assert.equal(calls[0].agentId, "codex");
    assert.equal(calls[0].editStrategy, "cleanup");
    assert.equal(calls[0].modelId, "selected-model");
    assert.equal(calls[0].editPlan, null);
    assert.equal(calls[0].targetDuration, null);
  } finally {
    clearMocks();
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
it("stage, framing and custom instructions survive saving and reopening a project", () => {
  const draft = { ...blankStudioDraft(), inputPath: "/video.mov", metadata: { duration_seconds: 60 },
    studioStage: "captions", layout: "screen-top", editStrategy: "custom", promptHook: "Keep my explanation." };
  const stored = JSON.parse(JSON.stringify({ ...emptyStudioStore(), projects: { "/video.mov": draft } }));
  const reopened = normalizeStudioStore(stored).projects["/video.mov"];
  assert.equal(reopened.studioStage, "captions");
  assert.equal(reopened.layout, "screen-top");
  assert.equal(reopened.editStrategy, "cleanup");
  assert.equal(reopened.customInstructionsEnabled, true);
  assert.equal(reopened.promptHook, "Keep my explanation.");
  delete stored.projects["/video.mov"].editStrategy;
  assert.equal(normalizeStudioStore(stored).projects["/video.mov"].editStrategy, "cleanup");
  assert.equal(normalizeStudioStore(stored).projects["/video.mov"].customInstructionsEnabled, true);
  stored.projects["/video.mov"].metadata = null;
  assert.equal(normalizeStudioStore(stored).projects["/video.mov"].studioStage, "source");
});
it("old transcript drafts no longer block rendering; new choices persist", () => {
  const draft = { ...blankStudioDraft(), inputPath: "/video.mov" };
  const store = JSON.parse(JSON.stringify({ ...emptyStudioStore(), projects: { "/video.mov": draft } }));
  delete store.projects["/video.mov"].editStrategy;
  store.projects["/video.mov"].transcriptDraft = { prepared: false };
  assert.equal(normalizeStudioStore(store).projects["/video.mov"].editStrategy, "cleanup");
  store.projects["/video.mov"].editStrategy = "highlights";
  store.projects["/video.mov"].highlightTarget = 60;
  assert.equal(normalizeStudioStore(store).projects["/video.mov"].highlightTarget, 60);
  assert.equal(normalizeEditStrategy("invalid"), "cleanup");
});
it("browser preview refuses invented input metadata, exports and stream clips", async () => {
  for (const action of [() => probeVideo("in.mov"), () => generateSeoMetadata("in.mov"),
    () => runCli("ffmpeg", []), () => renderShort({ input_video: "in.mov", output_video: "out.mp4", preset_id: "vertical_clean" }),
    () => probeStream("https://youtu.be/abcdefghijk"), () => suggestStreamClips("https://youtu.be/abcdefghijk"),
    () => fetchStreamClip("https://youtu.be/abcdefghijk", 0, 10, "out.mp4")]) {
    await assert.rejects(action, /desktop app/);
  }
});

it("render entry points forward automation and caption choices to native IPC", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true, writable: true });
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  mockIPC((command, args) => {
    calls.push({ command, args: args as Record<string, unknown> });
    return command === "start_render_job" ? "native-job" : { success: true };
  });
  try {
    const params = { input_video: "in.mov", output_video: "out.mp4", preset_id: "warm_cinematic",
      ...automationParams("highlights", "codex", 60, false, true),
      subtitle_style: "hype", subtitle_position: "center", subtitle_size: "large", subtitle_case: "sentence", layout: "auto" };
    assert.equal(await startRenderJob(params), "native-job");
    await renderShort(params);
    assert.deepEqual(calls.map(c => c.command), ["start_render_job", "render_short"]);
    for (const { args } of calls) {
      assert.equal(args.editStrategy, "highlights");
      assert.equal(args.agentId, "codex");
      assert.equal(args.targetDuration, 60);
      assert.equal(args.removeSilence, false);
      assert.equal(args.removeRetakes, true);
      assert.equal(args.editPlan, null);
      assert.equal(args.subtitleStyle, "hype");
      assert.equal(args.subtitlePosition, "center");
      assert.equal(args.subtitleSize, "large");
      assert.equal(args.subtitleCase, "sentence");
    }
  } finally {
    clearMocks();
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});


it("turning optional instructions off retains local cleanup and full mode without an AI call", () => {
  for (const mode of ["cleanup", "full"] as const) {
    const params = automationParams(mode, "codex", 30, true, false, "Saved instructions", false, "saved-model");
    assert.equal(params.edit_strategy, mode);
    assert.equal(params.agent_id, "auto");
    assert.equal(params.prompt_hook, undefined);
    assert.equal(params.model_id, undefined);
    assert.equal(params.target_duration, undefined);
  }
});
it("blank optional instructions do not require AI; highlights retain their budget with instructions", () => {
  assert.equal(automationParams("cleanup", "auto", 30, true, true, "  ", true).agent_id, "auto");
  const params = automationParams("highlights", "claude", 60, false, true, "Use https://youtu.be/abcdefghijk as a reference", true, "chosen-model");
  assert.equal(params.target_duration, 60);
  assert.equal(params.edit_strategy, "highlights");
  assert.match(params.prompt_hook!, /https:\/\/youtu.be/);
  assert.equal(params.remove_silence, false);
});
it("disabled instructions and model choice survive project normalization", () => {
  const draft = { ...blankStudioDraft(), inputPath: "/video.mov", customInstructionsEnabled: false,
    promptHook: "Keep this saved for later", modelId: "chosen-model" };
  const reopened = normalizeStudioStore({ ...emptyStudioStore(), projects: { [draft.inputPath]: draft } }).projects[draft.inputPath];
  assert.equal(reopened.customInstructionsEnabled, false);
  assert.equal(reopened.promptHook, draft.promptHook);
  assert.equal(reopened.modelId, draft.modelId);
});
