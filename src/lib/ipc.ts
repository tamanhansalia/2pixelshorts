import { invoke } from "./invoke.ts";
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
  VideoReviewReport
} from "../types/index.ts";
import {
  fitTagBudget,
  normalizeHashtags,
  scoreSeoPackage,
  trimTitle,
} from "./seo.ts";

export const isTauri = () => {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
};

export async function validateApiKey(provider: "zernio" | "elevenlabs" | "youtube", apiKey: string): Promise<void> {
  if (!isTauri()) throw new Error("Live key verification is available in the desktop app.");
  await invoke("validate_api_key", { provider, apiKey });
}

// Simulated CLI tools used only by the browser preview.
export const MOCK_TOOLS: CliToolInfo[] = [
  {
    id: "claude",
    name: "Claude Code CLI",
    command: "claude",
    path: "claude",
    version: "2.1.220 (Claude Code)",
    is_available: true,
    is_enabled: true,
    description: "Anthropic Claude Code autonomous agent CLI for conversational video editing and EDL generation.",
    category: "agent",
  },
  {
    id: "codex",
    name: "Codex CLI",
    command: "codex",
    path: "codex",
    version: "codex-cli 0.145.0",
    is_available: true,
    is_enabled: true,
    description: "OpenAI Codex CLI for terminal-driven coding, video workflows, and sub-agents.",
    category: "agent",
  },
  {
    id: "agy",
    name: "Antigravity CLI (AGY)",
    command: "agy",
    path: "agy",
    version: "1.2.12",
    is_available: true,
    is_enabled: true,
    description: "Google DeepMind Antigravity CLI for pair-programming, multi-agent pipelines, and video tasks.",
    category: "agent",
  },
  {
    id: "grok",
    name: "Grok CLI",
    command: "grok",
    path: "grok",
    version: "grok 1.0.0 (3cd0d0cbce)",
    is_available: true,
    is_enabled: true,
    description: "xAI Grok terminal CLI for reasoning, scripting, and content generation.",
    category: "agent",
  },
  {
    id: "ffmpeg",
    name: "FFmpeg",
    command: "ffmpeg",
    path: "ffmpeg",
    version: "ffmpeg version 8.1.1",
    is_available: true,
    is_enabled: true,
    description: "Core video & audio transcoding, scaling, 9:16 filtering, and subtitle burning.",
    category: "media",
  },
  {
    id: "ffprobe",
    name: "FFprobe",
    command: "ffprobe",
    path: "ffprobe",
    version: "ffprobe version 8.1.1",
    is_available: true,
    is_enabled: true,
    description: "Extracts video stream metadata, audio channels, duration, and frame rate.",
    category: "media",
  },
  {
    id: "python",
    name: "Python 3 Runtime",
    command: "python",
    path: "python",
    version: "Python 3.13.14",
    is_available: true,
    is_enabled: true,
    description: "Executes the video-use helper pipeline (render.py, grade.py, transcribe.py).",
    category: "runtime",
  },
  {
    id: "ytdlp",
    name: "yt-dlp",
    command: "yt-dlp",
    path: "C:\\tools\\yt-dlp.exe",
    version: "2025.01.15",
    is_available: true,
    is_enabled: true,
    description: "Downloads reference footage, audio, or assets from YouTube and online platforms.",
    category: "media",
  },
  {
    id: "manim",
    name: "Manim Community",
    command: "manim",
    path: null,
    version: null,
    is_available: false,
    is_enabled: false,
    description: "Mathematical and programmatic animation engine for diagram overlays.",
    category: "animation",
  },
];

export async function scanClis(): Promise<CliToolInfo[]> {
  if (isTauri()) {
    return await invoke<CliToolInfo[]>("scan_clis");
  }
  // Browser preview fallback
  await new Promise((r) => setTimeout(r, 0));
  return MOCK_TOOLS;
}

export async function probeCustomCli(name: string, pathOrCommand: string): Promise<CliToolInfo> {
  if (isTauri()) {
    return await invoke<CliToolInfo>("probe_custom_cli", { name, pathOrCommand });
  }
  return {
    id: `custom-${name.toLowerCase().replace(/\s+/g, "-")}`,
    name,
    command: pathOrCommand,
    path: pathOrCommand,
    version: "1.0.0 (custom)",
    is_available: true,
    is_enabled: true,
    description: "User registered custom CLI tool",
    category: "custom",
  };
}

export async function runCli(command: string, args: string[]): Promise<CommandOutput> {
  if (isTauri()) {
    return await invoke<CommandOutput>("run_cli", { command, args, cwd: null });
  }
  await new Promise((r) => setTimeout(r, 400));
  return {
    success: true,
    code: 0,
    stdout: `[SIMULATED CLI EXECUTION]\n$ ${command} ${args.join(" ")}\nOutput: Process returned exit code 0.\nStatus: Ready for processing.`,
    stderr: "",
    fallback_used: false,
  };
}

export async function probeVideo(path: string): Promise<VideoMetadata> {
  if (isTauri()) {
    return await invoke<VideoMetadata>("probe_video", { path });
  }
  await new Promise((r) => setTimeout(r, 300));
  return {
    file_path: path,
    duration_seconds: 42.5,
    width: 1920,
    height: 1080,
    fps: 30.0,
    codec: "h264",
    audio_channels: 2,
    file_size_bytes: 35600000,
  };
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
      aspectRatio: params.aspect_ratio || null,
      subtitleStyle: params.subtitle_style || null,
      subtitlePosition: params.subtitle_position || null,
      subtitleSize: params.subtitle_size || null,
      subtitleCase: params.subtitle_case || null,
      targetDuration: params.target_duration || null,
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
    });
  }
  await new Promise((r) => setTimeout(r, 1400));
  const aspect = params.aspect_ratio || "9:16";
  return {
    success: true,
    code: 0,
    stdout: `[STAGE 1/4] Probing audio & phrase cues for ${params.input_video}\n[STAGE 2/4] AI Agent (${(params.agent_id || "claude").toUpperCase()}) selected viral cuts with auto sentence boundary completion\n[STAGE 3/4] Trimming dead pauses & baking 30ms anti-pop crossfades\n[STAGE 4/4] ${aspect} crop, ${params.preset_id} grade & ${params.subtitle_style === "none" ? "clean video" : `${params.subtitle_style || "pop"} subtitles (${params.subtitle_position || "bottom"}, ${params.subtitle_size || "standard"})`}\n[AI SEO] Embedded title "${params.meta_title || "Auto AI Title"}" & metadata package into MP4\n[COMPLETE] ${aspect} Short rendered: ${params.output_video}`,
    stderr: `video-use engine: cuts extracted, 30ms crossfade applied, SEO metadata embedded.`,
    fallback_used: false,
  };
}

export async function generateSeoMetadata(
  inputVideo: string,
  channelContext?: string,
  agentId?: string,
  elevenlabsKey?: string,
): Promise<SeoMetadata> {
  if (isTauri()) {
    // Desktop: the video-use engine transcribes the source and (for a named
    // agent) has the agent CLI write the package. Failures reject so the UI
    // shows an honest empty state — never template text.
    const raw = await invoke<string>("generate_seo_metadata", {
      inputVideo,
      channelContext: channelContext || null,
      agentId: agentId || null,
      elevenlabsKey: elevenlabsKey || null,
    });
    return JSON.parse(raw);
  }

  // High-fidelity fallback algorithm
  await new Promise((r) => setTimeout(r, 600));
  const filename = inputVideo.split(/[\\/]/).pop()?.replace(/\.[^/.]+$/, "") || "video";
  const cleanName = filename.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  const ctxLower = (channelContext || "").toLowerCase();
  
  // Custom topic extraction based on channel context or filename
  let topic = cleanName;
  if (ctxLower.includes("rust") || ctxLower.includes("tauri")) {
    topic = "Rust & Tauri";
  } else if (ctxLower.includes("ai") || ctxLower.includes("code") || cleanName.toLowerCase().includes("ai")) {
    topic = "AI Developer Tool";
  } else if (ctxLower.includes("saas") || ctxLower.includes("startup")) {
    topic = "Indie SaaS";
  } else if (ctxLower.includes("python")) {
    topic = "Python Automation";
  }

  const primaryTitle = `The Secret ${topic} Workflow Nobody Tells You 🤫`;
  const alt1 = `Stop Doing This With ${topic} (Do This Instead) ❌`;
  const alt2 = `This New ${topic} Feels Like Cheating ⚡`;
  const alt3 = `How to Master ${topic} in 60 Seconds 🚀`;

  // Tag bench + hashtags through the shared SEO core so the browser
  // preview follows the same budget and normalization rules as the engine.
  const tags = fitTagBudget([
    topic.toLowerCase(),
    `${topic.toLowerCase()} tutorial`,
    `${topic.toLowerCase()} shorts`,
    "shorts",
    "tech",
    "coding",
    "developer",
    "software engineering",
    `${topic.toLowerCase()} tips`,
    "ai tools",
    "productivity",
    "webdev",
    "programming tips",
    "short",
    "how to",
    "beginners guide",
    "explained",
    "crash course",
  ]);

  const hashtags = normalizeHashtags(tags);

  const channelNiche = channelContext ? channelContext.trim() : "daily tech & developer guides";
  const hook = `Stop doing this with ${topic} — here is what top engineers do instead.`;
  const overview =
    `The complete breakdown on ${topic}! In this short, we review the entire workflow from start to finish.\n\n` +
    `👉 Subscribe to our channel for ${channelNiche}!`;
  const highlights = [
    `Core breakthrough with ${topic}`,
    "How to optimize performance and save hours",
    "Pro tips for modern creators",
  ];
  const description =
    `${hook}\n\n${overview}\n\n📌 Key Highlights:\n` +
    highlights.map((h) => `• ${h}`).join("\n") +
    `\n\n🔍 Search Keywords:\n${tags.join(", ")}\n\n${hashtags.join(" ")}`;
  const keywords = [topic.toLowerCase(), "workflow", "optimization", "productivity"];
  // Honest package-quality score from the shared scorer — never a fixed
  // near-perfect figure for ungrounded preview copy.
  const quality = scoreSeoPackage(
    alt2,
    description,
    tags,
    hashtags,
    keywords,
    0,
  );

  return {
    title: trimTitle(alt2),
    title_alternatives: [primaryTitle, alt1, alt2, alt3].map((t) => trimTitle(t)),
    description,
    tags,
    hashtags,
    seo_score: quality.score,
    quality_score: quality.qualityScore,
    quality_checks: quality.checks,
    keywords_analyzed: keywords,
    review_report: {
      overall_summary: `Preview package for ${filename} (browser preview — no transcript analyzed). Audio pacing and hooks will be measured from the real recording on desktop.`,
      hook_detected: `Stop doing this with ${topic} - here is what top engineers do instead.`,
      content_highlights: [
        `Core breakthrough and architecture breakdown of ${topic}`,
        "Performance benchmarks and speed optimizations",
        "Real-world edge cases to avoid when deploying",
        "Actionable steps to set this up in under 60 seconds"
      ],
      retention_score: quality.score,
      target_audience: `Engineers, developers, and tech builders aligned with your channel profile.`,
      suggested_pacing: "Fast-paced punchy cuts with 30ms anti-pop crossfades",
      word_count: 0
    }
  };
}

/**
 * Report which transcription engine analysis would use. Desktop probes
 * the real interpreter; the browser fallback can only reflect the key.
 */
export async function probeTranscription(
  elevenlabsKey?: string,
): Promise<TranscriptionStatus> {
  if (isTauri()) {
    return await invoke<TranscriptionStatus>("probe_transcription", {
      elevenlabsKey: elevenlabsKey?.trim() ? elevenlabsKey.trim() : null,
    });
  }
  const keyConfigured = !!elevenlabsKey?.trim();
  return {
    elevenlabs_key_configured: keyConfigured,
    local_available: false,
    local_model: "tiny.en",
    ffmpeg_available: false,
    active_engine: keyConfigured ? "elevenlabs" : "none",
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
  // Browser preview: clearly-marked sample terms, no network involved.
  await new Promise((r) => setTimeout(r, 500));
  return {
    niche,
    keywords: [
      { term: "rust async", score: 9.5, sources: 4 },
      { term: "connection pooling", score: 7.0, sources: 3 },
      { term: "ai agents", score: 6.5, sources: 3 },
      { term: "shorts", score: 6.0, sources: 5 },
      { term: "tauri v2", score: 4.5, sources: 2 },
    ],
    videos: [],
    fetched_at: new Date().toISOString(),
    cached: false,
    note: "simulated",
  };
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
    return await invoke<string>("publish_to_zernio", { apiKey, payload });
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
