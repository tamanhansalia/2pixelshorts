import { invoke } from "./invoke.ts";
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
    subtitleStyle: params.subtitle_style || null,
    subtitlePosition: params.subtitle_position || null,
    subtitleSize: params.subtitle_size || null,
    subtitleCase: params.subtitle_case || null,
    targetDuration: params.target_duration || null,
    // NOTE: ?? (not ||) — cut_start 0 is the beginning of the video.
    cutStart: params.cut_start ?? null,
    cutEnd: params.cut_end ?? null,
    promptHook: params.prompt_hook || null,
    elevenlabsKey: params.elevenlabs_key || null,
    channelContext: params.channel_context || null,
    metaTitle: params.meta_title || null,
    metaDesc: params.meta_desc || null,
    metaTags: params.meta_tags || null,
    layout: params.layout || null,
    faceRoi: params.face_roi || null,
  };
}

export async function startRenderJob(params: RenderShortParams): Promise<string> {
  if (isTauri()) {
    return await invoke<string>("start_render_job", toInvokeParams(params));
  }
  return startSimulatedJob(params);
}

export async function getJobStatus(jobId: string): Promise<RenderJobInfo> {
  if (isTauri()) {
    return await invoke<RenderJobInfo>("get_job_status", { jobId });
  }
  const job = simulatedJobs.get(jobId);
  if (!job) throw new Error(`Unknown job id: ${jobId}`);
  return { ...job };
}

export async function cancelJob(jobId: string): Promise<boolean> {
  if (isTauri()) {
    return await invoke<boolean>("cancel_job", { jobId });
  }
  const sim = simulatedTimers.get(jobId);
  const job = simulatedJobs.get(jobId);
  if (sim) {
    clearInterval(sim.timer);
    simulatedTimers.delete(jobId);
  }
  if (job && !isTerminalJobStatus(job.status)) {
    job.status = "cancelled";
    job.finished_at = new Date().toISOString();
    job.error = "Cancelled by user";
    emitSimulatedFinished(job);
    return true;
  }
  return false;
}

export async function listenRenderProgress(
  cb: (progress: RenderJobProgress) => void,
): Promise<UnlistenFn> {
  if (isTauri()) {
    return await listen<RenderJobProgress>("render-progress", (event) => {
      cb(event.payload);
    });
  }
  simulatedProgressListeners.add(cb);
  return () => {
    simulatedProgressListeners.delete(cb);
  };
}

export async function probeAgent(agentId: string): Promise<AgentProbe> {
  if (isTauri()) {
    return await invoke<AgentProbe>("probe_agent", { agentId });
  }
  return {
    agent: agentId,
    available: true,
    binary: agentId,
    path: null,
    note: "simulated",
  };
}

/** Agent id for the no-AI automatic head-cut. Never needs a CLI probe. */
export const AUTO_CUT_AGENT_ID = "auto";

export function needsAgentProbe(agentId: string): boolean {
  return agentId !== AUTO_CUT_AGENT_ID;
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
    note: "Automatic head-cut; no agent CLI is invoked",
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
  simulatedFinishedListeners.add(cb);
  return () => {
    simulatedFinishedListeners.delete(cb);
  };
}

// ---------------------------------------------------------------------------
// Browser-preview simulation (non-Tauri only). Mirrors the real event shapes
// so the job UI is fully exercisable under plain `vite dev`.
// ---------------------------------------------------------------------------

const SIM_LINES = [
  "[STAGE 1/4] Probing audio & phrase cues",
  "[STAGE 2/4] AI Agent selected viral cuts",
  "[STAGE 3/4] Trimming dead pauses & baking 30ms anti-pop crossfades",
  "[STAGE 4/4] 9:16 Vertical crop, grade & subtitles",
  "[COMPLETE] 9:16 Short rendered",
];

const simulatedJobs = new Map<string, RenderJobInfo>();
const simulatedTimers = new Map<string, { timer: ReturnType<typeof setInterval> }>();
const simulatedProgressListeners = new Set<(p: RenderJobProgress) => void>();
const simulatedFinishedListeners = new Set<(info: RenderJobInfo) => void>();

function emitSimulatedProgress(p: RenderJobProgress) {
  simulatedProgressListeners.forEach((cb) => cb(p));
}

function emitSimulatedFinished(info: RenderJobInfo) {
  simulatedFinishedListeners.forEach((cb) => cb({ ...info }));
}

let simCounter = 0;

function startSimulatedJob(params: RenderShortParams): string {
  simCounter += 1;
  const id = `sim-job-${Date.now()}-${simCounter}`;
  const job: RenderJobInfo = {
    id,
    kind: "render",
    status: "running",
    progress: 0,
    stage: "Starting pipeline",
    input_video: params.input_video,
    output_video: params.output_video,
    created_at: new Date().toISOString(),
    finished_at: null,
    result: null,
    error: null,
  };
  simulatedJobs.set(id, job);

  let step = 0;
  const timer = setInterval(() => {
    const current = simulatedJobs.get(id);
    if (!current || isTerminalJobStatus(current.status)) {
      clearInterval(timer);
      simulatedTimers.delete(id);
      return;
    }
    const line = SIM_LINES[step];
    const progress = (step + 1) / SIM_LINES.length;
    current.progress = progress;
    current.stage = line;
    const done = step === SIM_LINES.length - 1;
    emitSimulatedProgress({ job_id: id, progress, stage: line, line, done });
    step += 1;
    if (done) {
      clearInterval(timer);
      simulatedTimers.delete(id);
      const result: CommandOutput = {
        success: true,
        code: 0,
        stdout: `${SIM_LINES.join("\n")}\n[COMPLETE] 9:16 Short rendered: ${params.output_video}`,
        stderr: "video-use engine (simulated): cuts extracted, 30ms crossfade applied.",
        fallback_used: false,
      };
      current.status = "completed";
      current.finished_at = new Date().toISOString();
      current.result = result;
      emitSimulatedFinished(current);
    }
  }, 350);

  simulatedTimers.set(id, { timer });
  return id;
}

/** Test-only: reset simulation state between tests. */
export function __resetJobSimulationForTests() {
  simulatedTimers.forEach(({ timer }) => clearInterval(timer));
  simulatedTimers.clear();
  simulatedJobs.clear();
  simulatedProgressListeners.clear();
  simulatedFinishedListeners.clear();
}
