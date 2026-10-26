import { invoke } from "./invoke.ts";
import { transcriptionInvokeParams } from "./transcription.ts";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauri } from "./ipc.ts";
import type {
  AgentProbe,
  CommandOutput,
  JobStatus,
  RenderJobInfo,
  RenderJobProgress,
  RenderShortParams,
} from "../types/index.ts";

export function isTerminalJobStatus(status: JobStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function toInvokeParams(params: RenderShortParams) {
  return {
    inputVideo: params.input_video,
    outputVideo: params.output_video,
    presetId: params.preset_id,
    aspectRatio: params.aspect_ratio || null,
    agentId: params.agent_id || null,
    modelId: params.model_id?.trim() || null,
    subtitleStyle: params.subtitle_style || null,
    subtitlePosition: params.subtitle_position || null,
    subtitleSize: params.subtitle_size || null,
    subtitleCase: params.subtitle_case || null,
    targetDuration: params.target_duration || null,
    // NOTE: ?? (not ||) — cut_start 0 is the beginning of the video.
    cutStart: params.cut_start ?? null,
    cutEnd: params.cut_end ?? null,
    promptHook: params.prompt_hook || null,
    ...transcriptionInvokeParams(params.elevenlabs_key, params.transcription_provider),
    channelContext: params.channel_context || null,
    metaTitle: params.meta_title || null,
    metaDesc: params.meta_desc || null,
    metaTags: params.meta_tags || null,
    layout: params.layout || null,
    faceRoi: params.face_roi || null,
    editPlan: params.edit_plan ?? null,
    editStrategy: params.edit_strategy ?? null,
    removeSilence: params.remove_silence ?? null,
    removeRetakes: params.remove_retakes ?? null,
  };
}

export async function startRenderJob(params: RenderShortParams): Promise<string> {
  if (isTauri()) {
    return await invoke<string>("start_render_job", toInvokeParams(params));
  }
  throw new Error("Open the 2pixelshorts desktop app to render with video-use. Browser preview cannot edit videos.");
}

export async function getJobStatus(jobId: string): Promise<RenderJobInfo> {
  if (isTauri()) {
    return await invoke<RenderJobInfo>("get_job_status", { jobId });
  }
  throw new Error(`No native render job available: ${jobId}`);
}

export async function cancelJob(jobId: string): Promise<boolean> {
  if (isTauri()) {
    return await invoke<boolean>("cancel_job", { jobId });
  }
  throw new Error(`No native render job available: ${jobId}`);
}

export async function listenRenderProgress(
  cb: (progress: RenderJobProgress) => void,
): Promise<UnlistenFn> {
  if (isTauri()) {
    return await listen<RenderJobProgress>("render-progress", (event) => {
      cb(event.payload);
    });
  }
  return () => {};
}

export async function probeAgent(agentId: string): Promise<AgentProbe> {
  if (isTauri()) {
    return await invoke<AgentProbe>("probe_agent", { agentId });
  }
  return {
    agent: agentId,
    available: false,
    binary: agentId,
    path: null,
    note: "Editing models are only available in the desktop app",
  };
}

/** Agent id for the local automatic cleanup. Never needs a CLI probe. */
export const AUTO_CUT_AGENT_ID = "auto";

export function needsAgentProbe(agentId: string): boolean {
  return agentId !== AUTO_CUT_AGENT_ID;
}

/** CLIs Title & tags may call, in the same order Studio lists them. */
export const SEO_AGENT_ORDER = ["claude", "codex", "agy", "grok"] as const;

/**
 * CLI for a Title & tags package. The cut and the package are separate:
 * Auto cut still uses the first installed CLI. A chosen CLI wins when it
 * is installed or not yet probed. When every probe has returned and none
 * are installed, returns undefined so the engine composes from the
 * transcript. Before any probe exists, returns the first id — the engine
 * falls back to that composition if the binary is missing.
 */
export function seoAgentForPackage(
  selectedAgent: string | null | undefined,
  probes: Record<string, { available?: boolean } | undefined>,
  order: readonly string[] = SEO_AGENT_ORDER,
): string | undefined {
  const ids = order.filter((id) => id && id !== AUTO_CUT_AGENT_ID);
  const selected = (selectedAgent ?? "").trim();
  if (selected && selected !== AUTO_CUT_AGENT_ID) {
    const row = probes[selected];
    if (!row || row.available !== false) return selected;
  }
  const installed = ids.find((id) => probes[id]?.available === true);
  if (installed) return installed;
  if (!ids.some((id) => probes[id])) return ids[0];
  return undefined;
}

export interface RenderWarning {
  kind: "fallback" | "transcript" | "agent" | "framing";
  message: string;
  detail?: string;
}

/**
 * Explain a "successful but degraded" render from the job result, so the
 * user never mistakes an unedited passthrough for a finished short.
 */
export function renderWarningsFor(result: CommandOutput | null): RenderWarning[] {
  if (!result?.success) return [];
  const warnings: RenderWarning[] = [];
  const text = `${result.stdout}\n${result.stderr}`;
  if (/Face detection unavailable/i.test(text)) {
    warnings.push({
      kind: "framing",
      message: "Face tracking unavailable — the full source was preserved.",
      detail: "Run video-use/setup_framing.sh to enable local webcam framing, then re-render.",
    });
  }
  if (/Low-resolution source/i.test(text)) {
    warnings.push({
      kind: "framing",
      message: "The source resolution limits webcam sharpness.",
      detail: "Use a 720p or 1080p source. Framing preserves the face but cannot recover missing detail.",
    });
  }
  if (/Source camera clips the face/i.test(text)) {
    warnings.push({
      kind: "framing",
      message: "Part of the face is outside the original camera view.",
      detail: "The visible portion was preserved. Choose a moment where the speaker is fully inside the source camera.",
    });
  }
  if (result.fallback_used) {
    warnings.push({
      kind: "fallback",
      message: "The full pipeline failed — this is a basic 9:16 fallback render.",
      detail: "No cuts, subtitles, or AI work were applied. See the log below, then re-render.",
    });
  }
  // Transcript failures surface under several wordings (placeholder writes,
  // Scribe network errors, missing local engine, clean-video renders) — all
  // of them mean captions and AI cuts were skipped, so match them all.
  if (
    /no API key|no transcript|scribe request failed|local engine failed|wrote placeholder|rendering clean video/i.test(
      text,
    )
  ) {
    warnings.push({
      kind: "transcript",
      message: "No transcript — captions and AI cuts were skipped.",
      detail:
        "Add your ElevenLabs key under Settings → API keys → ElevenLabs Scribe, then re-render.",
    });
  }
  const agentFailure = text.match(/Agent cut failed \((.*)\)/);
  if (agentFailure) {
    warnings.push({
      kind: "agent",
      message: "The AI cut failed — used the automatic cut instead.",
      detail: agentFailure[1].slice(0, 200),
    });
  }
  return warnings;
}

/** Synthesized probe result for the automatic cut (always available). */
export function autoCutProbe(): AgentProbe {
  return {
    agent: AUTO_CUT_AGENT_ID,
    available: true,
    binary: "auto",
    path: null,
    note: "Silence and retake cleanup; no agent CLI is invoked",
  };
}

export async function listenRenderFinished(
  cb: (info: RenderJobInfo) => void,
): Promise<UnlistenFn> {
  if (isTauri()) {
    return await listen<RenderJobInfo>("render-finished", (event) => {
      cb(event.payload);
    });
  }
  return () => {};
}
