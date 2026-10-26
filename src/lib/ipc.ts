import { invoke } from "./invoke.ts";
import { transcriptionInvokeParams, type TranscriptionProvider } from "./transcription.ts";
import { seoSignals } from "./performance.ts";
import { enrichPublishPayload, getPinnedComment } from "./publishExtras.ts";
import { getDefaultProfile } from "./channelProfiles.ts";
import { openUrl } from "@tauri-apps/plugin-opener";
import type {
  CliToolInfo,
  CommandOutput,
  VideoMetadata,
  SocialPublishPayload,
  RenderShortParams,
  ZernioAccount,
  SeoMetadata,
  TranscriptionStatus,
  TrendingResult,
  VideoReviewReport,
  SourceTranscript,
} from "../types/index.ts";
export const isTauri = () => {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
};

export async function readSourceTranscript(inputVideo: string, elevenlabsKey?: string,
  options: { prepare?: boolean; agentId?: string; targetDuration?: number; promptHook?: string; channelContext?: string; transcriptionProvider?: TranscriptionProvider } = {}): Promise<SourceTranscript> {
  if (!isTauri()) throw new Error("Open the desktop app to transcribe your footage.");
  return invoke<SourceTranscript>("read_source_transcript", { inputVideo, ...transcriptionInvokeParams(elevenlabsKey, options.transcriptionProvider),
    prepare: options.prepare ?? false, agentId: options.agentId ?? null, targetDuration: options.targetDuration ?? null,
    promptHook: options.promptHook ?? null, channelContext: options.channelContext ?? null });
}

export async function validateApiKey(provider: "zernio" | "elevenlabs" | "youtube", apiKey: string): Promise<void> {
  if (!isTauri()) throw new Error("Live key verification is available in the desktop app.");
  await invoke("validate_api_key", { provider, apiKey });
}

export async function scanClis(): Promise<CliToolInfo[]> {
  if (isTauri()) {
    return await invoke<CliToolInfo[]>("scan_clis");
  }
  // Browser preview fallback
  await new Promise((r) => setTimeout(r, 0));
  return [];
}

export async function probeCustomCli(name: string, pathOrCommand: string): Promise<CliToolInfo> {
  if (isTauri()) {
    return await invoke<CliToolInfo>("probe_custom_cli", { name, pathOrCommand });
  }
  throw new Error("Open the 2pixelshorts desktop app to use video-use. This browser preview cannot run local tools.");
}

export async function runCli(command: string, args: string[]): Promise<CommandOutput> {
  if (isTauri()) {
    return await invoke<CommandOutput>("run_cli", { command, args, cwd: null });
  }
  throw new Error("Open the 2pixelshorts desktop app to use video-use. This browser preview cannot run local tools.");
}

export async function probeVideo(path: string): Promise<VideoMetadata> {
  if (isTauri()) {
    return await invoke<VideoMetadata>("probe_video", { path });
  }
  throw new Error("Open the 2pixelshorts desktop app to use video-use. This browser preview cannot run local tools.");
}

export async function renderShort(
  params: RenderShortParams
): Promise<CommandOutput> {
  if (isTauri()) {
    return await invoke<CommandOutput>("render_short", {
      inputVideo: params.input_video,
      outputVideo: params.output_video,
      presetId: params.preset_id,
      agentId: params.agent_id || null,
      modelId: params.model_id?.trim() || null,
      aspectRatio: params.aspect_ratio || null,
      subtitleStyle: params.subtitle_style || null,
      subtitlePosition: params.subtitle_position || null,
      subtitleSize: params.subtitle_size || null,
      subtitleCase: params.subtitle_case || null,
      targetDuration: params.target_duration || null,
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
    });
  }
  throw new Error("Open the 2pixelshorts desktop app to use video-use. This browser preview cannot run local tools.");
}

export async function generateSeoMetadata(
  inputVideo: string,
  channelContext?: string,
  agentId?: string,
  elevenlabsKey?: string,
  transcriptionProvider?: TranscriptionProvider,
  signals: { trendTerms: string[]; winningTitles: string[] } = seoSignals(),
): Promise<SeoMetadata> {
  if (isTauri()) {
    // Desktop: the video-use engine transcribes the source and (for a named
    // agent) has the agent CLI write the package. Failures reject so the UI
    // shows an honest empty state — never template text. Recent niche
    // trends and this channel's winning titles steer every run.
    const raw = await invoke<string>("generate_seo_metadata", {
      inputVideo,
      channelContext: channelContext || null,
      agentId: agentId || null,
      ...transcriptionInvokeParams(elevenlabsKey, transcriptionProvider),
      trendTerms: signals.trendTerms.length ? signals.trendTerms : null,
      winningTitles: signals.winningTitles.length ? signals.winningTitles : null,
    });
    return JSON.parse(raw);
  }
  throw new Error("Open the 2pixelshorts desktop app to use video-use. This browser preview cannot run local tools.");
}

/**
 * Report which transcription engine analysis would use. Desktop probes
 * the real interpreter; the browser fallback can only reflect the key.
 */
export async function probeTranscription(
  elevenlabsKey?: string,
  transcriptionProvider?: TranscriptionProvider,
): Promise<TranscriptionStatus> {
  if (isTauri()) {
    return await invoke<TranscriptionStatus>("probe_transcription", {
      ...transcriptionInvokeParams(elevenlabsKey, transcriptionProvider),
      // Readiness reports the saved key even when Local is selected.
      elevenlabsKey: elevenlabsKey?.trim() || null,
    });
  }
  const keyConfigured = !!elevenlabsKey?.trim();
  return {
    elevenlabs_key_configured: keyConfigured,
    local_available: false,
    local_model: "tiny.en",
    ffmpeg_available: false,
    active_engine: "none",
  };
}

export async function reviewRender(
  outputVideo: string,
  channelContext?: string,
): Promise<VideoReviewReport> {
  if (isTauri()) {
    const raw = await invoke<string>("review_render", {
      outputVideo,
      channelContext: channelContext || null,
    });
    return JSON.parse(raw);
  }
  // Browser preview: no rendered file exists, reuse the SEO analysis report.
  const meta = await generateSeoMetadata(outputVideo, channelContext);
  if (!meta.review_report) throw new Error("No review report available");
  return meta.review_report;
}

export async function fetchTrending(
  niche: string,
  apiKey?: string,
): Promise<TrendingResult> {
  if (isTauri()) {
    return await invoke<TrendingResult>("fetch_trending", {
      niche,
      apiKey: apiKey || null,
    });
  }
  throw new Error("Open the desktop app to fetch real trending keywords with video-use.");
}

export async function getZernioAccounts(apiKey: string): Promise<ZernioAccount[]> {
  if (isTauri()) {
    return await invoke<ZernioAccount[]>("get_zernio_accounts", { apiKey });
  }
  // Browser preview fallback
  await new Promise((r) => setTimeout(r, 300));
  if (!apiKey.trim()) return [];
  return [
    {
      id: "acc_yt_01",
      platform: "youtube",
      name: "2PixelSpace YouTube",
      username: "@2PixelSpace",
      is_connected: true,
    },
    {
      id: "acc_tt_01",
      platform: "tiktok",
      name: "2PixelSpace TikTok",
      username: "@2pixelspace",
      is_connected: true,
    },
  ];
}

export async function getZernioConnectUrl(apiKey: string, platform: string): Promise<string> {
  if (isTauri()) {
    return await invoke<string>("get_zernio_connect_url", { apiKey, platform });
  }
  return `https://zernio.com/app/connect/${platform.toLowerCase()}`;
}

/**
 * Open a URL in the user's default browser. `window.open` silently dies
 * inside the Tauri webview, so the desktop path goes through the opener
 * plugin (already granted via `opener:default`). Rejects with the URL in
 * the message so callers can show it for manual copy-paste.
 */
export async function openExternalUrl(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("External links must use HTTPS without embedded credentials");
  }
  if (isTauri()) {
    try {
      await openUrl(url);
    } catch (err: unknown) {
      throw new Error(
        `Could not open browser for ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return;
  }
  if (typeof window !== "undefined" && typeof window.open === "function") {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  throw new Error(`Could not open browser for ${url}: no window available`);
}

export async function publishToZernio(
  apiKey: string,
  payload: SocialPublishPayload
): Promise<string> {
  if (isTauri()) {
    // Pinned comment, real hashtags and the profile's YouTube category ride
    // along here so every Studio / Social / Queue path gets them.
    const enriched = enrichPublishPayload(payload, {
      pinnedComment: getPinnedComment(payload.video_path),
      youtubeCategory: getDefaultProfile()?.youtubeCategory,
    });
    return await invoke<string>("publish_to_zernio", { apiKey, payload: enriched });
  }
  await new Promise((r) => setTimeout(r, 600));
  return JSON.stringify(
    {
      status: "success",
      message: payload.publish_now
        ? "Post queued for immediate distribution via Zernio API"
        : `Post scheduled for ${payload.scheduled_for} (${payload.timezone})`,
      platforms: payload.platforms,
      account_ids: payload.account_ids,
      tags: payload.tags,
      post: { _id: `post_zr_${Date.now()}` },
    },
    null,
    2
  );
}

export async function getPostStatus(
  apiKey: string,
  postId: string,
): Promise<string> {
  if (isTauri()) {
    return await invoke<string>("get_post_status", { apiKey, postId });
  }
  await new Promise((r) => setTimeout(r, 300));
  return JSON.stringify({ post: { _id: postId, status: "scheduled" } });
}

/** Zernio analytics body for one post (`{"pending": true}` while syncing). */
export async function getPostAnalytics(
  apiKey: string,
  postId: string,
): Promise<string> {
  if (isTauri()) {
    return await invoke<string>("get_post_analytics", { apiKey, postId });
  }
  throw new Error("Open the desktop app to read post analytics.");
}

export async function retryPost(
  apiKey: string,
  postId: string,
): Promise<string> {
  if (isTauri()) {
    return await invoke<string>("retry_post", { apiKey, postId });
  }
  await new Promise((r) => setTimeout(r, 300));
  return JSON.stringify({ post: { _id: postId, status: "publishing" } });
}

export async function pickVideoFile(): Promise<string | null> {
  if (isTauri()) {
    return await invoke<string | null>("pick_video_file");
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "video/*,.mp4,.mov,.mkv,.avi,.webm";
    input.onchange = (e: any) => {
      const file = e.target?.files?.[0];
      if (file) {
        const path = (file as any).path || file.name || "selected_video.mp4";
        resolve(path);
      } else {
        resolve(null);
      }
    };
    input.click();
  });
}

export async function openFileLocation(path: string): Promise<void> {
  if (isTauri()) {
    await invoke("open_file_location", { path });
  } else {
    console.log("Locate file in Explorer:", path);
  }
}

export async function openFile(path: string): Promise<void> {
  if (isTauri()) {
    await invoke("open_file", { path });
  } else {
    console.log("Open file in default player:", path);
  }
}
