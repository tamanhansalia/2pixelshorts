import React, { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronRight,
  ChevronLeft,
  Monitor,
  Copy,
  ExternalLink,
  Film,
  FolderOpen,
  Link2,
  Play,
  Search,
  Plus,
  RefreshCw,
  RotateCcw,
  Share2,
  Sparkles,
  Square,
  Tag,
  Target,
  Upload,
  Wand2,
  X,
} from "lucide-react";
import {
  Label,
  ListBox,
  SearchField,
  Select,
  Spinner,
  Switch,
  Tag as HeroTag,
  TagGroup,
} from "@heroui/react";
import {
  AgentProbe,
  SeoMetadata,
  TrendingResult,
  VideoMetadata,
  VideoPreset,
  VideoReviewReport,
} from "../../types";
import { fetchTrending, isTauri, reviewRender } from "../../lib/ipc";
import { automationParams, nextAutomaticExport, normalizeEditStrategy, type EditStrategy } from "../../lib/studioAutomation";
import type { StudioSeoJob } from "../../lib/seoJobs";
import { isBusyClipJob, type StreamAnalysisJobs } from "../../lib/streamAnalysis";
import {
  LEGACY_DEFAULT,
  getDefaultProfile,
  getEffectiveContext,
} from "../../lib/channelProfiles";
import {
  AUTO_CUT_AGENT_ID,
  autoCutProbe,
  needsAgentProbe,
  probeAgent,
  renderWarningsFor,
  seoAgentForPackage,
} from "../../lib/jobs";
import {
  getStreamRun,
  isWatchableLiveRun,
  mostRecentUsableRun,
  type StreamRun,
  type StreamRunStore,
} from "../../lib/streamRuns";
import {
  STREAM_ASPECT_RATIOS,
  STREAM_LAYOUTS,
  clipWorkPath,
  dirPrefixOf,
  downloadStreamClipsAsSources,
  effectiveLayoutForAspect,
  fetchStreamClip,
  formatClipRange,
  formatClipTime,
  isSplitStreamLayout,
  isYoutubeUrl,
  needsNineSixteenCanvas,
  parseAspectRatio,
  resolvedClipOutput,
  streamSuggestOptions,
  type ImportedClipFile,
  type StreamAspectRatioId,
  type StreamLayoutId,
  type SuggestStreamClipsOptions,
} from "../../lib/streamClips";
import type { RenderHistoryEntry } from "../../lib/renderHistory";
import type { StudioProjectDraft } from "../../lib/studioProjects";
import {
  latestCompletedOutput,
  shouldAutoNameOutput,
  streamClipSourceName,
  suggestOutputPath,
} from "../../lib/studioProjects";
import {
  TITLE_MOBILE_CHARS,
  TITLE_SWEET_SPOT,
  feedTruncation,
  fitTagBudget,
  normalizeHashtags,
  packageQueryTargets,
  scoreSeoPackage,
} from "../../lib/seo";
import { saveTrendSignals } from "../../lib/performance";
import { setPinnedComment as rememberPinnedComment } from "../../lib/publishExtras";
import { RenderJobsPanel } from "../jobs/RenderJobsPanel";
import { useRenderJob } from "../../lib/useRenderJob";
import {
  classifyBrowserFile,
  isDropOverRect,
  pickDroppedVideo,
} from "../../lib/drop";
import { notify } from "../../lib/notify";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";
import { SectionCard } from "../ui/Card";
import { Field, TextArea, TextInput } from "../ui/Field";
import { Modal } from "../ui/Modal";
import { EmptyState } from "../ui/EmptyState";
import { LinearProgress } from "../ui/LinearProgress";
import { VideoPreview } from "./VideoPreview";
import { StudioNavigation } from "./StudioNavigation";
import { STUDIO_STAGES, resolveStreamRestore, resolveStudioStage, type StudioStage } from "../../lib/studioWorkflow";
import { Segmented } from "../ui/Segmented";
import { PageHeader } from "../layout/PageHeader";
import {
  SubtitleCase,
  SubtitlePosition,
  SubtitleSize,
  SubtitleStudio,
} from "./SubtitleStudio";

const PRESETS: VideoPreset[] = [
  {
    id: "warm_cinematic",
    name: "Warm Cinematic",
    aspect_ratio: "9:16",
    width: 1080,
    height: 1920,
    fps: 30,
    color_grade: "warm_cinematic",
    subtitle_style: "pop",
    subtitle_case: "uppercase",
    silence_threshold_s: 0.4,
    description: "Teal shadows & warm golden midtones with deep contrast.",
  },
  {
    id: "neutral_punch",
    name: "Neutral Punch",
    aspect_ratio: "9:16",
    width: 1080,
    height: 1920,
    fps: 30,
    color_grade: "neutral_punch",
    subtitle_style: "boxed",
    subtitle_case: "sentence",
    silence_threshold_s: 0.4,
    description:
      "Crisp dynamic range & accurate skin tones for talking-head footage.",
  },
  {
    id: "moody_film",
    name: "Moody Film",
    aspect_ratio: "9:16",
    width: 1080,
    height: 1920,
    fps: 30,
    color_grade: "moody_film",
    subtitle_style: "editorial",
    subtitle_case: "sentence",
    silence_threshold_s: 0.4,
    description:
      "Indie 35mm film stock with lifted matte blacks and subtle olive wash.",
  },
  {
    id: "subtle_clean",
    name: "Natural / Subtle",
    aspect_ratio: "9:16",
    width: 1080,
    height: 1920,
    fps: 30,
    color_grade: "subtle",
    subtitle_style: "subtle",
    subtitle_case: "sentence",
    silence_threshold_s: 0.4,
    description: "Unfiltered natural camera colors with clean 9:16 center framing.",
  },
];

/** Representative gradient per grade, drawn on the preset cards. */
const GRADE_SWATCH: Record<string, string> = {
  warm_cinematic:
    "linear-gradient(110deg, #10343a 0%, #2c5a5c 35%, #c98a4b 72%, #f2c27a 100%)",
  neutral_punch:
    "linear-gradient(110deg, #1c1c1f 0%, #5a5e66 40%, #c9b8a6 75%, #f1ece6 100%)",
  moody_film:
    "linear-gradient(110deg, #22241c 0%, #4a4d38 40%, #8a866a 75%, #c7c0a0 100%)",
  subtle_clean:
    "linear-gradient(110deg, #2a2f36 0%, #6f7883 40%, #b9c2cc 75%, #e9edf1 100%)",
};

const AGENTS = [
  { id: "claude", name: "Claude" },
  { id: "codex", name: "Codex" },
  { id: "agy", name: "AGY" },
  { id: "grok", name: "Grok" },
  // Last so auto-select prefers a real agent; always available, no AI cost.
  { id: AUTO_CUT_AGENT_ID, name: "Auto cut" },
];

const CHECK_LABELS: Record<string, string> = {
  title_present: "Add a title",
  title_mobile_fit: "Fit the title in ~40 chars so the mobile feed shows it all",
  title_query_match: "Put the words of a target search in the title",
  title_concrete: "Swap hype words for a number, name or result",
  title_not_shouting: "Use at most two ALL-CAPS words",
  title_front_loaded: "Move the subject into the first three words",
  title_over_limit: "Shorten past the 100-char limit",
  hook_strength: "Sharpen the opening hook",
  description_above_fold: "Say the target search in the first two lines",
  description_length: "Write 100+ chars of description",
  description_hashtags: "End the description with the hashtag line",
  description_no_stuffing: "Remove keyword lists (they read as spam)",
  hashtags_count: "Keep 3–5 hashtags",
  hashtags_postable: "Fix unpostable hashtags",
  tags_present: "Add 5–15 specific tags",
};

function titleFeedHint(title: string): string {
  if (!title.trim()) {
    return `Names the rendered file too. Aim for ${TITLE_MOBILE_CHARS}–${TITLE_SWEET_SPOT} characters so a phone feed shows the whole line.`;
  }
  const feed = feedTruncation(title);
  if (feed.mobileFits) {
    return `Fits a phone feed (${feed.chars}/${TITLE_MOBILE_CHARS}). Names the rendered file too, unless you override it in Export.`;
  }
  return `Phone feed: “${feed.mobile}” · desktop: “${feed.desktop}”. Names the rendered file too.`;
}

/**
 * Live per-video SEO checklist: scores the CURRENT edited fields (not the
 * frozen engine package) so every tweak immediately shows what still
 * limits this short's reach. Hashtags ride along for one-tap copy.
 */
function SeoChecklist({
  title,
  description,
  tags,
  hashtags,
  keywords,
  queries,
  hook,
  retention,
  engineQuality,
}: {
  title: string;
  description: string;
  tags: string[];
  hashtags: string[];
  keywords: string[];
  queries: string[];
  hook: string;
  retention: number;
  engineQuality: number | null;
}) {
  const [copiedTags, setCopiedTags] = useState(false);
  if (!title.trim() && tags.length === 0) return null;
  const live = scoreSeoPackage(
    title,
    description,
    tags,
    hashtags,
    keywords,
    retention,
    { hook, queries },
  );
  // Biggest misses first: they cost the most reach.
  const misses = live.checks
    .filter((c) => c.of > 0 && c.got < c.of)
    .sort((a, b) => b.of - b.got - (a.of - a.got))
    .slice(0, 3);
  return (
    <div className="space-y-2 rounded-md border border-border bg-surface-secondary/60 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={live.qualityScore >= 70 ? "success" : "warning"}>
          Package {live.qualityScore}/100
        </Badge>
        {typeof engineQuality === "number" && (
          <span className="tabular-nums text-xs text-muted">
            engine {engineQuality}/100
          </span>
        )}
        {retention > 0 && (
          <span className="tabular-nums text-xs text-muted">
            retention {retention}/100
          </span>
        )}
        {hook.trim() && (
          <span
            className="tabular-nums text-xs text-muted"
            title={`Weakest: ${live.hook.weakest} — ${live.hook.fix}`}
          >
            hook {live.hook.verdict}/100 · {live.hook.band.toLowerCase()}
          </span>
        )}
      </div>
      {hook.trim() && live.hook.band === "WEAK" && (
        <p className="flex items-start gap-1.5 text-xs leading-snug text-muted">
          <Target className="mt-0.5 size-3 shrink-0" />
          Hook tip: {live.hook.fix}.
        </p>
      )}
      {queries.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-xs text-muted">Targets:</span>
          {queries.map((q) => (
            <span
              key={q}
              className="rounded-md bg-surface-tertiary px-1.5 py-0.5 text-xs text-foreground"
            >
              {q}
            </span>
          ))}
        </div>
      )}
      {hashtags.length > 0 && (
        <button
          type="button"
          onClick={() => {
            navigator.clipboard.writeText(hashtags.join(" "));
            setCopiedTags(true);
            setTimeout(() => setCopiedTags(false), 2000);
          }}
          title="Copy hashtags"
          className="flex flex-wrap gap-1 text-left"
        >
          {hashtags.map((h) => (
            <span
              key={h}
              className="rounded-md bg-surface-tertiary px-1.5 py-0.5 text-xs text-accent"
            >
              {h}
            </span>
          ))}
          <span className="px-1 py-0.5 text-xs text-muted">
            {copiedTags ? "Copied" : "copy"}
          </span>
        </button>
      )}
      {misses.length > 0 && (
        <ul className="space-y-0.5">
          {misses.map((m) => (
            <li
              key={m.id}
              className="flex items-start gap-1.5 text-xs leading-snug text-muted"
            >
              <Target className="mt-0.5 size-3 shrink-0" />
              {CHECK_LABELS[m.id] ?? m.id} ({m.got}/{m.of})
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Rebuild the last engine package from a persisted draft so reopening a
 * source (or returning after a tab switch) restores alternates, hashtags,
 * and scores — not just the editable title/description/tags.
 */
function packageFromDraft(draft: StudioProjectDraft | null): SeoMetadata | null {
  if (!draft || !draft.seoTitle.trim()) return null;
  return {
    title: draft.seoTitle,
    title_alternatives: draft.seoTitleAlternatives
      ? [...draft.seoTitleAlternatives]
      : [],
    description: draft.seoDescription,
    tags: [...draft.seoTags],
    hashtags: draft.seoHashtags ? [...draft.seoHashtags] : [],
    seo_score: draft.seoScore ?? 0,
    quality_score: draft.seoQualityScore ?? null,
    keywords_analyzed: draft.seoKeywords ? [...draft.seoKeywords] : [],
    search_queries: draft.seoSearchQueries ? [...draft.seoSearchQueries] : [],
    ...(Array.isArray(draft.seoDemandQueries)
      ? { demand_queries: [...draft.seoDemandQueries] }
      : {}),
    pinned_comment: draft.seoPinnedComment ?? "",
    review_report: draft.reviewReport ?? undefined,
  };
}

export interface RenderJobUpdate {
  running: boolean;
  progress?: number;
  label?: string;
  outputPath?: string;
  success?: boolean;
  jobId?: string;
  stage?: string;
}

interface VideoStudioProps {
  elevenLabsKey?: string;
  youtubeKey?: string;
  onJobUpdate?: (update: RenderJobUpdate) => void;
  onRenderStarted?: (
    jobId: string,
    params: {
      input_video: string;
      output_video: string;
      preset_id: string;
      agent_id?: string;
      meta_title?: string;
      meta_desc?: string;
      meta_tags?: string[];
    },
  ) => void;
  renderHistory?: RenderHistoryEntry[];
  activeHistoryJobId?: string | null;
  onOpenJobs?: () => void;
  onCancelRenderJob?: (id: string) => void;
  onDismissRenderJob?: (id: string) => void;
  onClearFinishedRenders?: () => void;
  onQueueOutput?: (
    outputPath: string,
    seo?: { title?: string; description?: string; tags?: string[] },
  ) => void;
  initialDraft?: StudioProjectDraft | null;
  draftLoadKey?: number;
  onDraftChange?: (draft: StudioProjectDraft) => void;
  /** Import downloaded stream clips as their own sidebar sources, so
   * each one is edited on the same single Studio page as a file. */
  onImportClipsAsSources?: (clips: ImportedClipFile[]) => void;
  /** Stream runs, owned by App so clips survive tab switches. */
  streamRuns: StreamRunStore;
  onStreamRunsChange: React.Dispatch<React.SetStateAction<StreamRunStore>>;
  streamAnalysisJobs: StreamAnalysisJobs;
  onAnalyzeStream: (url: string, options: SuggestStreamClipsOptions, layout: string) => void;
  onStopWatchingStream?: (url: string) => void;
  onRemoveStream: (url: string) => void;
  /** Sidebar-opened run: Studio restores it on arrival. */
  pendingStreamUrl?: string | null;
  streamOpenKey?: number;
  onStreamOpened?: () => void;
  /** Plus / new short: do not reopen the last stream into this view. */
  startBlank?: boolean;
  /**
   * App-owned SEO fetch: survives this view unmounting (tab switch,
   * minimize) and merges the result into the matching draft. Resolves
   * with the package + request id, rejects on failure (App toasts).
   */
  onGenerateStudioSeo?: (
    targetVideo: string,
    opts: { context: string; agentId?: string },
  ) => Promise<{ meta: SeoMetadata; requestId: number }>;
  /** Live App-owned SEO jobs, keyed by target video (see seoJobs). */
  studioSeoJobs?: Record<string, StudioSeoJob>;
  onProbeVideo: (path: string, options?: { silent?: boolean }) => Promise<VideoMetadata>;
  onPickVideo: () => Promise<string | null>;
  onOpenFileLocation: (path: string) => Promise<void>;
  onOpenFile: (path: string) => Promise<void>;
  onSendToSocial?: (
    videoPath: string,
    metadata?: { title?: string; description?: string; tags?: string[] },
  ) => void;
}

export const VideoStudio: React.FC<VideoStudioProps> = ({
  elevenLabsKey,
  youtubeKey,
  onJobUpdate,
  onRenderStarted,
  renderHistory = [],
  activeHistoryJobId = null,
  onOpenJobs,
  onCancelRenderJob,
  onDismissRenderJob,
  onClearFinishedRenders,
  onQueueOutput,
  initialDraft = null,
  draftLoadKey = 0,
  onDraftChange,
  onImportClipsAsSources,
  streamRuns,
  onStreamRunsChange,
  streamAnalysisJobs,
  onAnalyzeStream,
  onStopWatchingStream,
  onRemoveStream,
  pendingStreamUrl = null,
  streamOpenKey = 0,
  onStreamOpened,
  startBlank = false,
  onGenerateStudioSeo,
  studioSeoJobs,
  onProbeVideo,
  onPickVideo,
  onOpenFileLocation,
  onOpenFile,
  onSendToSocial,
}) => {
  const [activeStage, setActiveStage] = useState<StudioStage>(() => resolveStudioStage(initialDraft?.studioStage, Boolean(initialDraft?.metadata)));
  const stageHeadingRef = useRef<HTMLHeadingElement>(null);
  const stageFocusPending = useRef(false);
  const goToStage = (stage: StudioStage) => {
    stageFocusPending.current = true;
    setActiveStage(stage);
  };
  const scrollToSection = (id: string) => goToStage(id.replace("studio-", "") as StudioStage);
  useEffect(() => {
    if (!stageFocusPending.current) return;
    stageFocusPending.current = false;
    stageHeadingRef.current?.focus({ preventScroll: true });
    document.getElementById("studio-workspace")?.scrollIntoView({ block: "start" });
  }, [activeStage]);
  const [streamLayout, setStreamLayout] = useState<StreamLayoutId>(STREAM_LAYOUTS.some(layout => layout.id === initialDraft?.layout) ? initialDraft!.layout as StreamLayoutId : "auto");
  const [customInstructionsEnabled, setCustomInstructionsEnabled] = useState(initialDraft?.customInstructionsEnabled ?? (initialDraft?.editStrategy === "custom"));
  const [promptHook, setPromptHook] = useState(initialDraft?.promptHook ?? "");
  const [inputPath, setInputPath] = useState(initialDraft?.inputPath ?? "");
  const [outputPath, setOutputPath] = useState(
    initialDraft?.outputPath ||
      suggestOutputPath({ inputPath: initialDraft?.inputPath }).path,
  );
  // False until the user edits the name in Render: the path above then
  // auto-follows the Shorts title instead of asking upfront in Source.
  const [outputTouched, setOutputTouched] = useState(
    initialDraft?.outputTouched ?? false,
  );
  const [selectedPreset, setSelectedPreset] = useState<string>(
    initialDraft?.presetId ?? "warm_cinematic",
  );
  const [aspectRatio, setAspectRatio] = useState<StreamAspectRatioId>(
    parseAspectRatio(
      (initialDraft as StudioProjectDraft | null)?.aspectRatio ?? "9:16",
    ),
  );
  const [selectedAgent, setSelectedAgent] = useState<string>(
    initialDraft?.agentId ?? "claude",
  );
  const [editStrategy, setEditStrategy] = useState<EditStrategy>(normalizeEditStrategy(initialDraft?.editStrategy));
  const [removeSilence, setRemoveSilence] = useState(initialDraft?.removeSilence ?? true);
  const [removeRetakes, setRemoveRetakes] = useState(initialDraft?.removeRetakes ?? true);
  const [highlightTarget, setHighlightTarget] = useState(initialDraft?.highlightTarget ?? 30);
  const sourceRequestRef = useRef(0);
  const [agentProbe, setAgentProbe] = useState<Record<string, AgentProbe>>({});
  const [probingAgents, setProbingAgents] = useState(false);
  const [burnInCaptions, setBurnInCaptions] = useState<boolean>(
    initialDraft?.burnInCaptions ?? true,
  );
  const [subtitleStyle, setSubtitleStyle] = useState<string>(
    initialDraft?.subtitleStyle ?? "pop",
  );
  const [subtitlePosition, setSubtitlePosition] = useState<SubtitlePosition>(
    (initialDraft?.subtitlePosition as SubtitlePosition | undefined) ?? "bottom",
  );
  const [subtitleSize, setSubtitleSize] = useState<SubtitleSize>(
    (initialDraft?.subtitleSize as SubtitleSize | undefined) ?? "standard",
  );
  const [subtitleCase, setSubtitleCase] = useState<SubtitleCase>(
    (initialDraft?.subtitleCase as SubtitleCase | undefined) ?? "uppercase",
  );
  const agentError = selectedAgent === AUTO_CUT_AGENT_ID ? "Choose an available CLI in Settings → CLI tools."
    : probingAgents ? "Checking your local CLIs…"
    : agentProbe[selectedAgent]?.available === false ? "This CLI is unavailable. Choose another or configure it in Settings → CLI tools." : null;
  const streamAgentError = selectedAgent === AUTO_CUT_AGENT_ID ? null : agentError;
  const usesEditingAgent = editStrategy === "highlights" || (customInstructionsEnabled && Boolean(promptHook.trim()));
  const editError = (usesEditingAgent ? agentError : null)
    || (customInstructionsEnabled && promptHook.length > 4000 ? "Keep custom instructions within 4,000 characters." : null);


  // Per-video context override (blank = use the default channel profile).
  // A stored copy of the old built-in default clears to blank so the
  // migrated profile takes over; genuine custom drafts survive.
  const [contextOverride, setContextOverride] = useState<string>(() => {
    if (initialDraft) return initialDraft.contextOverride;
    const stored = localStorage.getItem("tuari_channel_context") || "";
    return stored.trim() === LEGACY_DEFAULT ? "" : stored;
  });

  // No placeholder content: titles, tags, and the review report only exist
  // after the engine has actually analyzed the video's transcript. Until
  // then Title & tags shows honest empty states. A persisted draft
  // rehydrates the last package so alternates survive reloads.
  const [seoMetadata, setSeoMetadata] = useState<SeoMetadata | null>(() =>
    packageFromDraft(initialDraft),
  );
  const [isGeneratingSeo, setIsGeneratingSeo] = useState<boolean>(false);
  const [seoTitle, setSeoTitle] = useState<string>(
    initialDraft?.seoTitle ?? "",
  );
  const [seoDescription, setSeoDescription] = useState<string>(
    initialDraft?.seoDescription ?? "",
  );
  const [seoTags, setSeoTags] = useState<string[]>(
    initialDraft?.seoTags ?? [],
  );
  const [pinnedComment, setPinnedComment] = useState<string>(
    initialDraft?.seoPinnedComment ?? "",
  );
  const [newTagInput, setNewTagInput] = useState<string>("");
  const [copiedSection, setCopiedSection] = useState<string | null>(null);

  const [isDragging, setIsDragging] = useState(false);
  const [isProbing, setIsProbing] = useState(false);
  const [metadata, setMetadata] = useState<VideoMetadata | null>(
    initialDraft?.metadata ?? null,
  );
  const [probeError, setProbeError] = useState<string | null>(null);
  useEffect(() => {
    if (probeError) notify("Could not read video", probeError, "error");
  }, [probeError]);
  // Native file drops carry real paths (DOM File objects have none), so the
  // Tauri drag-drop event owns drops; the DOM handlers below are the browser
  // fallback. probeRef keeps the event listener on the latest closure.
  const dropzoneRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<(targetPath: string) => Promise<void>>(async () => {});

  const [showPostRenderModal, setShowPostRenderModal] = useState<boolean>(false);
  const [reviewReport, setReviewReport] = useState<VideoReviewReport | null>(
    initialDraft?.reviewReport ?? null,
  );

  const handleUpdateContextOverride = (val: string) => {
    setContextOverride(val);
    localStorage.setItem("tuari_channel_context", val);
  };

  const [streamUrl, setStreamUrl] = useState("");
  const [streamQuery, setStreamQuery] = useState("");
  const [streamUseAsSource, setStreamUseAsSource] = useState<number | null>(null);

  // Load a sidebar-selected source: replaces every persisted field, keeps
  // the live job/log state untouched.
  const loadDraft = (draft: StudioProjectDraft) => {
    if (!job.isRunning && job.inputVideo !== draft.inputPath) job.reset();
    setInputPath(draft.inputPath);
    setOutputPath(
      draft.outputPath ||
        suggestOutputPath({
          seoTitle: draft.seoTitle,
          inputPath: draft.inputPath,
        }).path,
    );
    setOutputTouched(draft.outputTouched ?? false);
    setMetadata(draft.metadata);
    setActiveStage(resolveStudioStage(draft.studioStage, Boolean(draft.metadata)));
    setPromptHook(draft.promptHook ?? "");
    setCustomInstructionsEnabled(draft.customInstructionsEnabled ?? (draft.editStrategy === "custom"));
    setStreamLayout(STREAM_LAYOUTS.some(layout => layout.id === draft.layout) ? draft.layout as StreamLayoutId : "auto");
    setSelectedPreset(draft.presetId);
    setAspectRatio(parseAspectRatio(draft.aspectRatio ?? "9:16"));
    setSelectedAgent(draft.agentId);
    sourceRequestRef.current++;
    setEditStrategy(normalizeEditStrategy(draft.editStrategy));
    setRemoveSilence(draft.removeSilence ?? true);
    setRemoveRetakes(draft.removeRetakes ?? true);
    setHighlightTarget(draft.highlightTarget ?? 30);
    setIsProbing(false);
    setProbeError(null);
    setBurnInCaptions(draft.burnInCaptions);
    setSubtitleStyle(draft.subtitleStyle);
    setSubtitlePosition(draft.subtitlePosition as SubtitlePosition);
    setSubtitleSize(draft.subtitleSize as SubtitleSize);
    setSubtitleCase(draft.subtitleCase as SubtitleCase);
    setContextOverride(draft.contextOverride);
    localStorage.setItem("tuari_channel_context", draft.contextOverride);
    setSeoTitle(draft.seoTitle);
    setSeoDescription(draft.seoDescription);
    setSeoTags(draft.seoTags);
    setPinnedComment(draft.seoPinnedComment ?? "");
    setSeoMetadata(packageFromDraft(draft));
    setReviewReport(draft.reviewReport);
    setStreamUrl("");
    setStreamQuery("");
    setStreamUseAsSource(null);
  };

  const draftLoadKeyRef = useRef(draftLoadKey);
  useEffect(() => {
    if (draftLoadKeyRef.current === draftLoadKey) return;
    draftLoadKeyRef.current = draftLoadKey;
    if (initialDraft) loadDraft(initialDraft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftLoadKey, initialDraft]);

  // Autosave the source draft (edit state + SEO) so tab switches, sidebar
  // selection, and restarts never lose the work in progress.
  useEffect(() => {
    if (!onDraftChange || !inputPath.trim()) return;
    onDraftChange({
      inputPath,
      outputPath,
      outputTouched,
      metadata,
      presetId: selectedPreset,
      aspectRatio,
      agentId: selectedAgent,
      editStrategy,
      removeSilence,
      removeRetakes,
      highlightTarget,
      burnInCaptions,
      subtitleStyle,
      subtitlePosition,
      subtitleSize,
      subtitleCase,
      promptHook,
      customInstructionsEnabled,
      modelId: "",
      studioStage: activeStage,
      layout: streamLayout,
      contextOverride,
      seoTitle,
      seoDescription,
      seoTags: [...seoTags],
      seoTitleAlternatives: seoMetadata?.title_alternatives
        ? [...seoMetadata.title_alternatives]
        : [],
      seoHashtags: normalizeHashtags(seoTags, seoMetadata?.hashtags ?? []),
      seoScore: seoMetadata?.seo_score ?? null,
      seoQualityScore: seoMetadata?.quality_score ?? null,
      seoKeywords: seoMetadata?.keywords_analyzed
        ? [...seoMetadata.keywords_analyzed]
        : [],
      seoSearchQueries: seoMetadata?.search_queries
        ? [...seoMetadata.search_queries]
        : [],
      seoDemandQueries: Array.isArray(seoMetadata?.demand_queries)
        ? [...seoMetadata.demand_queries]
        : undefined,
      seoPinnedComment: pinnedComment,
      reviewReport,
      updatedAt: new Date().toISOString(),
      createdAt: initialDraft?.createdAt ?? new Date().toISOString(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    inputPath,
    outputPath,
    outputTouched,
    metadata,
    selectedPreset,
    aspectRatio,
    selectedAgent,
    editStrategy,
    removeSilence,
    removeRetakes,
    highlightTarget,
    burnInCaptions,
    subtitleStyle,
    subtitlePosition,
    subtitleSize,
    subtitleCase,
    promptHook,
    customInstructionsEnabled,
    activeStage,
    streamLayout,
    contextOverride,
    seoTitle,
    seoDescription,
    seoTags,
    seoMetadata,
    pinnedComment,
    reviewReport,
  ]);

  // The pinned comment rides to Zernio by video path (see publishExtras),
  // so every Studio, Social and Queue publish of this short carries it.
  useEffect(() => {
    rememberPinnedComment([inputPath, outputPath], pinnedComment);
  }, [inputPath, outputPath, pinnedComment]);

  // Tracks mount state: the App-owned fetch below outlives this view
  // (tab switch, minimize), so local state writes must stop at unmount —
  // the result still lands in App state + the draft and is adopted below.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      sourceRequestRef.current++;
    };
  }, []);

  // requestIds already applied locally, per target video: stops a
  // background completion from overwriting newer local edits on return.
  const appliedSeoRef = useRef<Record<string, number>>({});
  const visibleSeoRequestRef = useRef(0);

  const applySeoMeta = (meta: SeoMetadata) => {
    setSeoMetadata(meta);
    setSeoTitle(meta.title);
    setSeoDescription(meta.description);
    setSeoTags(meta.tags);
    // A package without a suggestion keeps whatever the user typed.
    if (meta.pinned_comment?.trim()) setPinnedComment(meta.pinned_comment);
    if (meta.review_report) {
      setReviewReport(meta.review_report);
    }
  };

  // Adopt background completions: an analysis started here that finished
  // while Studio was on another tab (or minimized) arrives via App state.
  // The draft merge in App already persisted it; this mirrors it into the
  // visible fields without touching anything the user edited since.
  useEffect(() => {
    if (!studioSeoJobs) return;
    for (const target of [inputPath, outputPath]) {
      if (!target) continue;
      const entry = studioSeoJobs[target];
      if (entry?.status !== "done") continue;
      if (appliedSeoRef.current[target] === entry.requestId) continue;
      appliedSeoRef.current[target] = entry.requestId;
      applySeoMeta(entry.meta);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studioSeoJobs, inputPath, outputPath]);

  const handleGenerateSeo = async (customPath?: string, customContext?: string) => {
    if (metadata?.audio_channels === 0) {
      notify("No audio track", "This video has no audio to analyze. You can still write a title and description, and export it.", "info");
      return;
    }
    const visibleRequest = ++visibleSeoRequestRef.current;
    // Review the rendered short when one exists, else the source footage.
    // Either path must be a real file: the engine refuses to template
    // metadata it cannot ground in a transcript.
    const targetVideo =
      customPath ||
      (job.result?.success ? outputPath || inputPath : inputPath || outputPath) ||
      "sample_recording.mp4";
    const contextToUse =
      customContext !== undefined
        ? customContext
        : getEffectiveContext(contextOverride);
    // Title & tags uses an installed CLI even when the cut is Auto.
    // Edit mode only decides the cut, not the package.
    const seoAgentId = seoAgentForPackage(selectedAgent, agentProbe);

    setIsGeneratingSeo(true);
    try {
      // App-owned fetch: completion lands in App state + the draft even
      // when this view unmounts mid-flight (App toasts either outcome).
      const generate = onGenerateStudioSeo;
      if (!generate) return;
      const { meta, requestId } = await generate(targetVideo, {
        context: contextToUse,
        agentId: seoAgentId,
      });
      if (!mountedRef.current || visibleSeoRequestRef.current !== visibleRequest) return;
      appliedSeoRef.current[targetVideo] = requestId;
      applySeoMeta(meta);
      // Ground the review in the rendered output when one exists.
      if (job.result?.success && isTauri()) {
        try {
          const grounded = await reviewRender(
            outputPath || targetVideo,
            contextToUse,
          );
          if (!mountedRef.current || visibleSeoRequestRef.current !== visibleRequest) return;
          setReviewReport(grounded);
          setSeoMetadata((prev) =>
            prev ? { ...prev, review_report: grounded } : prev,
          );
        } catch (e) {
          console.warn("Output-grounded review unavailable:", e);
        }
      }
    } finally {
      if (mountedRef.current && visibleSeoRequestRef.current === visibleRequest) setIsGeneratingSeo(false);
    }
  };

  const handleRecalibrateContext = async () => {
    await handleGenerateSeo(outputPath || inputPath);
  };

  // Busy while this view's own request runs OR an App-owned analysis for
  // the current video is still going (e.g. started before a tab switch).
  const backgroundSeoRunning =
    !!studioSeoJobs &&
    [inputPath, outputPath].some(
      (target) => !!target && studioSeoJobs[target]?.status === "running",
    );
  const seoBusy = isGeneratingSeo || backgroundSeoRunning;
  const queryTargets = packageQueryTargets(seoMetadata);

  const [trendingNiche, setTrendingNiche] = useState("");
  const [trending, setTrending] = useState<TrendingResult | null>(null);
  const [trendingLoading, setTrendingLoading] = useState(false);

  // Stream clip finder: paste a public YouTube / Twitch VOD link, get
  // the best windows. Source only collects footage — taste choices
  // (model, length, framing) live in Edit; the finder uses the Edit
  // editing model with the Standard length band.
  // Framing: the engine always auto-detects the facecam, so picking a
  // framing is enough — there is no manual face-source picker. Auto
  // split-stacks corner cams and face-centers everything else.

  // App owns the request and run data. A page/source switch cannot drop a
  // completion, and a result for another URL never leaks into this view.
  const streamRun = getStreamRun(streamRuns, streamUrl);
  const streamJob = streamAnalysisJobs[streamUrl.trim()];
  const streamProbe = streamRun?.probe ?? null;
  const streamResult = streamRun?.result ?? null;
  const streamWatching = isWatchableLiveRun(streamRun) || streamJob?.status === "watching";
  const streamAnalyzing = streamJob?.status === "running" && !streamWatching;
  const streamProbing = streamAnalyzing && !streamProbe;
  const streamSelected = streamRun?.selected ?? [];
  const setStreamSelected = (selection: React.SetStateAction<number[]>) => {
    const url = streamUrl.trim();
    onStreamRunsChange((prev) => {
      const run = prev.runs[url];
      if (!run?.result) return prev;
      const selected = typeof selection === "function" ? selection(run.selected) : selection;
      return { ...prev, runs: { ...prev.runs, [url]: { ...run, selected, updatedAt: new Date().toISOString() } } };
    });
  };
  const [streamImporting, setStreamImporting] = useState(false);
  const [streamImportProgress, setStreamImportProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);

  // Untouched output names auto-follow the Shorts title (then the stream
  // title, then the input file). Editing the name in Render pins it; the
  // reset button there hands control back to this effect.
  const streamTitle = streamResult?.title || streamProbe?.title || "";
  useEffect(() => {
    const url = streamUrl.trim();
    onStreamRunsChange((prev) => {
      const run = prev.runs[url];
      if (!run || run.layout === streamLayout) return prev;
      return { ...prev, runs: { ...prev.runs, [url]: { ...run, layout: streamLayout } } };
    });
  }, [streamUrl, streamLayout, onStreamRunsChange]);

  const loadRunIntoView = (run: StreamRun) => {
    setActiveStage("source");
    setStreamUrl(run.url);
    // Stored runs from before auto framing predate the layout field.
    setStreamLayout((run.layout as StreamLayoutId) || "auto");
    setStreamQuery("");
  };

  const forgetStream = (url: string) => {
    if (streamUrl.trim() === url.trim()) {
      setStreamUrl("");
      setStreamQuery("");
      setStreamUseAsSource(null);
    }
    onRemoveStream(url);
  };

  const handleStreamUrlChange = (value: string) => {
    setStreamUrl(value);
    // Pasting a known link restores its saved clips instantly.
    const run = getStreamRun(streamRuns, value);
    if (run) loadRunIntoView(run);
  };

  // Tab switches remount this view blank. Reopen a busy clip job or the
  // last stream so returning is not empty — unless Plus asked for a new short.
  const restoredStreamRef = useRef(false);
  useEffect(() => {
    if (restoredStreamRef.current) return;
    restoredStreamRef.current = true;
    const runningUrl = Object.values(streamAnalysisJobs).find(isBusyClipJob)?.url ?? null;
    const mode = resolveStreamRestore({
      startBlank,
      hasSourceInput: Boolean(initialDraft?.inputPath),
      hasBusyClipJob: Boolean(runningUrl),
    });
    if (mode === "none") return;
    const run =
      mode === "busy-job"
        ? (runningUrl && getStreamRun(streamRuns, runningUrl)) || mostRecentUsableRun(streamRuns)
        : mostRecentUsableRun(streamRuns);
    if (run) loadRunIntoView(run);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sidebar-opened run: restore it on arrival, then clear the request.
  useEffect(() => {
    if (!pendingStreamUrl || !streamOpenKey) return;
    setActiveStage("source");
    const run = getStreamRun(streamRuns, pendingStreamUrl);
    if (run) {
      loadRunIntoView(run);
    } else {
      setStreamUrl(pendingStreamUrl);
    }
    onStreamOpened?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamOpenKey]);

  // Sidebar forget must clear this view even when Plus did not remount.
  const savedStreamUrlRef = useRef<string | null>(null);
  useEffect(() => {
    const url = streamUrl.trim();
    if (url && getStreamRun(streamRuns, url)) {
      savedStreamUrlRef.current = url;
      return;
    }
    if (savedStreamUrlRef.current && savedStreamUrlRef.current === url) {
      savedStreamUrlRef.current = null;
      setStreamUrl("");
      setStreamQuery("");
      setStreamUseAsSource(null);
    }
  }, [streamRuns, streamUrl]);

  const handleFetchTrending = async () => {
    const niche = trendingNiche.trim() || getDefaultProfile()?.niche || "";
    if (!niche) {
      notify(
        "Niche required",
        "Enter a topic or set a channel profile niche",
        "error",
      );
      return;
    }
    setTrendingLoading(true);
    try {
      const res = await fetchTrending(
        niche.slice(0, 100),
        youtubeKey?.trim() || undefined,
      );
      setTrending(res);
      // Every later SEO run (Studio, Queue) is steered by these for a week.
      if (res.keywords.length || res.queries?.length) {
        saveTrendSignals({
          niche: res.niche,
          terms: res.keywords.slice(0, 10).map((k) => k.term),
          queries: [...(res.queries ?? [])],
          savedAt: new Date().toISOString(),
        });
      }
      if (res.error) notify("Trending unavailable", res.error, "error");
      else if (!youtubeKey?.trim() && res.queries?.length) notify("Searches ready", "Showing what people search. Add a YouTube Data API key in Settings → API keys for rising-video terms too.", "info");
      else if (res.note || (res.keywords.length === 0 && !res.queries?.length)) notify("Trending search", res.note || "No trending terms found. Try another topic.", "info");
      else notify("Trending terms ready", `${res.keywords.length} terms found. Select a term to add it to your tags.`, "success");
    } catch (err) {
      notify(
        "Trending failed",
        err instanceof Error ? err.message : "Could not fetch trends",
        "error",
      );
    } finally {
      setTrendingLoading(false);
    }
  };

  const handleAddTrendingTerm = (term: string) => {
    const clean = term.trim().toLowerCase();
    if (!clean) return;
    // Budget-aware: one tap never pushes the bench past the ~500-char
    // upload limit or the 20-tag cap.
    setSeoTags((prev) =>
      prev.some((t) => t.toLowerCase() === clean)
        ? prev
        : fitTagBudget([...prev, clean]),
    );
  };

  const formatStreamViews = (views: number | null): string | null => {
    if (views === null || views === undefined) return null;
    if (views >= 1_000_000) return `${(views / 1_000_000).toFixed(1)}M views`;
    if (views >= 1_000) return `${(views / 1_000).toFixed(1)}K views`;
    return `${views} views`;
  };

  const formatStreamDate = (raw: string | null): string | null => {
    if (!raw || raw.length !== 8) return null;
    const months = [
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    const month = Number(raw.slice(4, 6));
    if (month < 1 || month > 12) return null;
    return `${months[month - 1]} ${Number(raw.slice(6, 8))}, ${raw.slice(0, 4)}`;
  };

  const handleStreamAnalyze = () => {
    if (streamAgentError) {
      notify("Editing model unavailable", streamAgentError, "error");
      return;
    }
    const url = streamUrl.trim();
    if (!url) {
      notify("Link required", "Paste a public YouTube link first", "error");
      return;
    }
    if (!isYoutubeUrl(url)) {
      notify(
        "Unsupported link",
        "Paste a public YouTube link or a completed Twitch VOD",
        "error",
      );
      return;
    }
    onAnalyzeStream(url, {
      ...streamSuggestOptions({ agentId: selectedAgent, channelContext: getEffectiveContext(contextOverride) || undefined }),
      elevenlabsKey: elevenLabsKey,
    }, streamLayout);
  };

  const streamVisibleClips = useMemo(() => {
    if (!streamResult) return [];
    const q = streamQuery.trim().toLowerCase();
    return streamResult.clips
      .map((clip, index) => ({ clip, index }))
      .filter(
        ({ clip }) =>
          !q ||
          clip.text.toLowerCase().includes(q) ||
          clip.reason.toLowerCase().includes(q),
      );
  }, [streamResult, streamQuery]);

  const toggleStreamClip = (index: number) => {
    setStreamSelected((prev) =>
      prev.includes(index)
        ? prev.filter((i) => i !== index)
        : [...prev, index],
    );
  };

  // Import the selected clips as their own sidebar sources: downloads
  // only the winning windows (never the full VOD), probes each one, and
  // hands them to App so every clip is edited on the same single Studio
  // page as an uploaded file. One failed window must not discard the rest.
  const handleImportClipsAsSources = async () => {
    const res = streamResult;
    const url = streamUrl.trim();
    const indexes = streamSelected;
    if (!res || indexes.length === 0 || streamImporting || streamUseAsSource !== null) return;
    if (!onImportClipsAsSources) {
      notify("Import unavailable", "The studio host did not provide a source importer", "error");
      return;
    }
    const stamp = Date.now();
    const clips = indexes.flatMap((i) => {
      const clip = res.clips[i];
      if (!clip) return [];
      return [{
        start: clip.start,
        end: clip.end,
        label: `Clip ${i + 1}`,
        title: clip.reason.trim(),
        outputName: streamClipSourceName(streamTitle, stamp, i),
      }];
    });
    if (clips.length === 0) {
      notify("Import failed", "None of the selected clips could be downloaded", "error");
      return;
    }
    setStreamImporting(true);
    setStreamImportProgress({ current: 0, total: clips.length });
    try {
      const imported = await downloadStreamClipsAsSources({
        url,
        dirPrefix: dirPrefixOf(outputPath) || dirPrefixOf(inputPath),
        clips,
        probe: (path) => onProbeVideo(path, { silent: true }),
        onProgress: (current, total) => setStreamImportProgress({ current, total }),
        onSkip: (label, message) => notify(`${label} skipped`, message, "error"),
      });
      if (imported.length === 0) {
        notify("Import failed", "None of the selected clips could be downloaded", "error");
        return;
      }
      onImportClipsAsSources(imported);
      const skipped = clips.length - imported.length;
      notify(
        "Clips imported as sources",
        skipped > 0
          ? `${imported.length} clip${imported.length === 1 ? "" : "s"} added, ${skipped} skipped — open each from the sidebar to edit and render it`
          : `${imported.length} clip${imported.length === 1 ? "" : "s"} added — open each from the sidebar to edit and render it`,
        skipped > 0 ? "warning" : "success",
      );
    } catch (err) {
      notify(
        "Import failed",
        err instanceof Error ? err.message : "Could not import the selected clips",
        "error",
      );
    } finally {
      setStreamImporting(false);
      setStreamImportProgress(null);
    }
  };

  // Use one stream clip as this short's source: downloads just that
  // window, probes it, and scrolls to Edit so the single-page flow
  // continues in the Edit & format stage.
  const handleUseClipAsSource = async (index: number) => {
    const res = streamResult;
    const url = streamUrl.trim();
    const clip = res?.clips[index];
    if (!res || !clip || streamUseAsSource !== null || streamImporting) return;
    setStreamUseAsSource(index);
    try {
      const workInput = clipWorkPath(
        dirPrefixOf(outputPath) || dirPrefixOf(inputPath),
        streamClipSourceName(streamTitle, Date.now(), index),
      );
      const fetched = await fetchStreamClip(url, clip.start, clip.end, workInput);
      if (!fetched.success) {
        throw new Error(
          fetched.stderr.trim().slice(0, 220) || "clip download failed",
        );
      }
      const saved = resolvedClipOutput(fetched, workInput);
      setInputPath(saved);
      await handleProbePath(saved);
      notify(
        "Clip set as source",
        `Clip ${index + 1} (${formatClipRange(clip.start, clip.end)}) is now the source — continue in Edit & format`,
        "success",
      );
      scrollToSection("studio-edit");
    } catch (err) {
      notify(
        "Could not use clip",
        err instanceof Error ? err.message : "Clip download failed",
        "error",
      );
    } finally {
      setStreamUseAsSource(null);
    }
  };

  // Background render job: streams progress events, supports cancellation.
  // Completion runs the same post-render review flow the blocking path had.
  // startedJobIdRef tracks the live job id for the finish callback without
  // relying on the render closure.
  const startedJobIdRef = useRef<string | null>(null);
  const job = useRenderJob(async ({ status, result, error, inputVideo: finishedInput, outputVideo: finishedOutput }) => {
    const finishedId = startedJobIdRef.current;
    if (status === "completed" && result?.success) {
      const warnings = renderWarningsFor(result);
      if (warnings.length > 0) {
        notify("Short rendered with warnings", warnings.map(w => [w.message, w.detail].filter(Boolean).join(" — ")).join("\n"), "warning");
      } else {
        notify("Short rendered", `Output saved to ${finishedOutput}`, "success");
      }
      onJobUpdate?.({ running: false, outputPath: finishedOutput, success: true, jobId: finishedId ?? undefined });
      try {
        if (finishedInput === inputPath && metadata?.audio_channels !== 0) await handleGenerateSeo(finishedOutput);
      } catch (e) {
        console.error("Auto post-render review error:", e);
      }
    } else if (status === "cancelled") {
      notify("Render cancelled", "The background job was stopped", "info");
      onJobUpdate?.({ running: false, outputPath: finishedOutput, success: false, jobId: finishedId ?? undefined });
    } else {
      notify(
        "Render failed",
        error || "Render process finished with error code.",
        "error",
      );
      onJobUpdate?.({ running: false, outputPath: finishedOutput, success: false, jobId: finishedId ?? undefined });
    }
    startedJobIdRef.current = null;
  });

  // Re-attach to a render that is still running after a tab switch remounts
  // this view, so the live log/progress resumes instead of going idle.
  useEffect(() => {
    if (!job.jobId && activeHistoryJobId) {
      startedJobIdRef.current = activeHistoryJobId;
      void job.attach(activeHistoryJobId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  useEffect(() => {
    // Once a render is on disk, outputPath is that file: never retarget it
    // at a title-derived name that was never rendered (post-render SEO used
    // to do exactly that, leaving the review popup's Play/Reveal pointing
    // at a nonexistent file). Untouched paths heal back to the real file.
    if (job.isRunning) return;
    const rendered =
      latestCompletedOutput(inputPath, renderHistory) ??
      (job.result?.success && job.inputVideo === inputPath ? job.outputVideo : null);
    if (rendered) {
      if (!outputTouched) {
        setOutputPath((prev) => (prev === rendered ? prev : rendered));
      }
      return;
    }
    if (!shouldAutoNameOutput(outputTouched, rendered)) return;
    const next = suggestOutputPath({
      seoTitle,
      streamTitle,
      inputPath,
    }).path;
    setOutputPath((prev) => (prev === next ? prev : next));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outputTouched, seoTitle, streamTitle, inputPath, renderHistory, job.result, job.inputVideo, job.outputVideo, job.isRunning]);


  // Probe each editing agent's headless availability once per mount.
  // Auto-selects the first available agent when the default is unusable.
  // "auto" needs no CLI, so it is synthesized as always available.
  useEffect(() => {
    let cancelled = false;
    setProbingAgents(true);
    Promise.all(
      AGENTS.filter((a) => needsAgentProbe(a.id)).map((a) =>
        probeAgent(a.id).catch(
          (): AgentProbe => ({
            agent: a.id,
            available: false,
            binary: a.id,
            path: null,
            note: "probe failed",
          }),
        ),
      ),
    )
      .then((probed) => {
        if (cancelled) return;
        const results: AgentProbe[] = [...probed, autoCutProbe()];
        const map: Record<string, AgentProbe> = {};
        results.forEach((r) => {
          map[r.agent] = r;
        });
        setAgentProbe(map);
        const current = results.find((r) => r.agent === selectedAgent);
        if (current && !current.available) {
          const fallback = results.find((r) => r.available);
          if (fallback) setSelectedAgent(fallback.agent);
        }
      })
      .finally(() => {
        if (!cancelled) setProbingAgents(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mirror job progress to the app-wide task indicator (and render history).
  useEffect(() => {
    if (!job.isRunning) return;
    onJobUpdate?.({
      running: true,
      progress: job.progress,
      label: job.stage || "Rendering short",
      outputPath,
      jobId: job.jobId ?? undefined,
      stage: job.stage,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.isRunning, job.progress, job.stage, job.jobId]);

  // Native file-drop listener (Tauri only). A dropped DOM File exposes no
  // filesystem path, so the real path comes from this event. Drops landing
  // outside the source dropzone are ignored.
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    const overDropzone = (pos: { x: number; y: number }) => {
      const el = dropzoneRef.current;
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      return isDropOverRect(pos, rect, window.devicePixelRatio || 1);
    };
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") {
          setIsDragging(overDropzone(payload.position));
        } else if (payload.type === "leave") {
          setIsDragging(false);
        } else if (payload.type === "drop") {
          setIsDragging(false);
          if (payload.paths.length === 0) {
            notify(
              "Drop ignored",
              "The drop carried no file paths — try dragging the file from Finder instead.",
              "warning",
            );
            return;
          }
          if (!dropzoneRef.current) {
            notify(
              "Drop ignored",
              "Drop the video onto the Video file box to load it.",
              "info",
            );
            return;
          }
          if (!overDropzone(payload.position)) {
            notify(
              "Drop ignored",
              "Drop the video onto the Source footage box — drops elsewhere on the window are ignored.",
              "info",
            );
            return;
          }
          const picked = pickDroppedVideo(payload.paths);
          if (!picked) return;
          setInputPath(picked);
          void probeRef.current(picked);
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((err: unknown) => {
        // Native drops unavailable: say so instead of failing silently.
        // The DOM handlers stay as a fallback, and Browse still works.
        console.error("Native file-drop listener failed:", err);
        setProbeError(
          "File drop isn't available in this window — click the box to browse for your video instead.",
        );
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const handleProbePath = async (targetPath: string) => {
    if (!targetPath.trim()) return;
    setActiveStage("source");
    setIsProbing(true);
    setProbeError(null);
    setMetadata(null);
    if (targetPath.trim() !== inputPath.trim()) {
      visibleSeoRequestRef.current++;
      setSeoTitle(""); setSeoDescription(""); setSeoTags([]); setSeoMetadata(null); setReviewReport(null);
      setOutputTouched(false);
      setOutputPath(suggestOutputPath({ inputPath: targetPath.trim() }).path);
      if (!job.isRunning) job.reset();
    }
    const request = ++sourceRequestRef.current;
    try {
      const meta = await onProbeVideo(targetPath.trim());
      if (!mountedRef.current || request !== sourceRequestRef.current) return;
      setMetadata(meta);
      goToStage("edit");
    } catch (err: unknown) {
      if (!mountedRef.current || request !== sourceRequestRef.current) return;
      setProbeError(
        err instanceof Error ? err.message : "Failed to probe file",
      );
      setMetadata(null);
    } finally {
      if (mountedRef.current && request === sourceRequestRef.current) setIsProbing(false);
    }
  };
  probeRef.current = handleProbePath;
  useEffect(() => {
    if (inputPath.trim() && !metadata && !isProbing && !probeError) void probeRef.current(inputPath);
  }, [inputPath, metadata, isProbing, probeError]);

  const handleBrowseFile = async () => {
    try {
      const selected = await onPickVideo();
      if (selected) {
        setInputPath(selected);
        await handleProbePath(selected);
      }
    } catch (err) {
      notify("Could not select video", err instanceof Error ? err.message : String(err), "error");
    }
  };

  // Browser fallback: in Tauri the native drag-drop event below owns all
  // drops (DOM File objects have no usable path there), so these no-op.
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isTauri()) setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isTauri()) setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (isTauri()) {
      setIsDragging(false);
      return;
    }

    const files = e.dataTransfer.files;
    const classified = classifyBrowserFile(
      files && files.length > 0 ? files[0] : undefined,
    );
    setIsDragging(false);
    if (classified.kind === "empty") {
      notify(
        "Drop ignored",
        "The drop carried no file — try dragging the video file itself from your file manager.",
        "warning",
      );
      return;
    }
    if (classified.kind === "name-only") {
      // Plain browsers never reveal a filesystem path, so this name is not
      // a resolvable location. Keep the preview flow but say so honestly.
      notify(
        "Browser preview only",
        `“${classified.name}” has no filesystem path in a browser — open the desktop app to import it for real.`,
        "warning",
      );
      setInputPath(classified.name);
      await handleProbePath(classified.name);
      return;
    }
    setInputPath(classified.path);
    await handleProbePath(classified.path);
  };

  const handleRemoveTag = (tagToRemove: string) => {
    setSeoTags((prev) => prev.filter((t) => t !== tagToRemove));
  };

  const handleAddTag = (e?: React.KeyboardEvent) => {
    if (e && e.key !== "Enter") return;
    const clean = newTagInput.trim().toLowerCase().replace(/^#/, "");
    if (clean && !seoTags.includes(clean)) {
      setSeoTags((prev) => [...prev, clean]);
      setNewTagInput("");
    }
  };

  const handleCopyText = (text: string, sectionId: string) => {
    navigator.clipboard.writeText(text);
    setCopiedSection(sectionId);
    setTimeout(() => setCopiedSection(null), 2000);
  };

  const handleCopyAllMetadata = () => {
    const hashtags = normalizeHashtags(seoTags, seoMetadata?.hashtags ?? []);
    const formatted = `TITLE:\n${seoTitle}\n\nDESCRIPTION:\n${seoDescription}\n\nTAGS:\n${seoTags.join(", ")}\n\nHASHTAGS:\n${hashtags.join(" ")}`;
    handleCopyText(formatted, "all");
  };

  const handleRender = async () => {
    if (!inputPath || !outputPath || job.isRunning) return;
    if (editError) {
      notify("Choose an editing model", editError, "error");
      scrollToSection("studio-edit");
      return;
    }
    const requestedOutput = outputPath.trim() === inputPath.trim()
      ? suggestOutputPath({ inputPath }).path : outputPath;
    const renderOutput = outputTouched ? requestedOutput : nextAutomaticExport(
      requestedOutput, editStrategy,
      [inputPath, ...renderHistory.map(entry => entry.outputVideo),
        ...(job.result?.success && job.outputVideo ? [job.outputVideo] : [])],
    );
    if (renderOutput !== outputPath) setOutputPath(renderOutput);
    scrollToSection("studio-render");
    onJobUpdate?.({
      running: true,
      progress: 0,
      label: "Starting render job",
      outputPath: renderOutput,
    });

    try {
      const effectiveLayout = effectiveLayoutForAspect(streamLayout, aspectRatio);
      const id = await job.start({
        input_video: inputPath,
        output_video: renderOutput,
        preset_id: selectedPreset,
        ...automationParams(editStrategy, selectedAgent, highlightTarget, removeSilence, removeRetakes, promptHook, customInstructionsEnabled),
        aspect_ratio: aspectRatio,
        subtitle_style: burnInCaptions ? subtitleStyle : "none",
        subtitle_position: subtitlePosition,
        subtitle_size: subtitleSize,
        subtitle_case: subtitleCase,
        layout: effectiveLayout,
        // The engine always auto-detects the face: no manual face source.
        face_roi: "auto",
        elevenlabs_key:
          elevenLabsKey?.trim() ? elevenLabsKey.trim() : undefined,
        channel_context: getEffectiveContext(contextOverride) || undefined,
        meta_title: seoTitle.trim() ? seoTitle.trim() : undefined,
        meta_desc: seoDescription.trim() ? seoDescription.trim() : undefined,
        meta_tags: seoTags.length > 0 ? seoTags.join(",") : undefined,
      });
      startedJobIdRef.current = id;
      onRenderStarted?.(id, {
        input_video: inputPath,
        output_video: renderOutput,
        preset_id: selectedPreset,
        agent_id: usesEditingAgent ? selectedAgent : "auto",
        meta_title: seoTitle.trim() ? seoTitle.trim() : undefined,
        meta_desc: seoDescription.trim() ? seoDescription.trim() : undefined,
        meta_tags: seoTags.length > 0 ? [...seoTags] : undefined,
      });
    } catch (err: unknown) {
      notify(
        "Render failed",
        err instanceof Error ? err.message : "Could not start render job",
        "error",
      );
      onJobUpdate?.({ running: false, outputPath: renderOutput, success: false });
    }
  };

  const fileName = inputPath ? inputPath.split(/[\\/]/).pop() : "";

  // File that Play / Reveal / Queue / Send-to-Social must act on: the newest
  // completed render for this source when one exists (outputPath alone can
  // be a not-yet-rendered target name). Falls back to outputPath pre-render.
  const playableOutput =
    latestCompletedOutput(inputPath, renderHistory) ??
    (job.result?.success && job.inputVideo === inputPath ? job.outputVideo : null) ??
    outputPath;

  const renderTagEditor = () => (
    <div className="space-y-2">
      {seoTags.length > 0 && (
        <TagGroup
          aria-label="Search tags"
          size="sm"
          onRemove={(keys) =>
            keys.forEach((key) => handleRemoveTag(String(key)))
          }
        >
          <TagGroup.List>
            {seoTags.map((tag) => (
              <HeroTag key={tag} id={tag} textValue={tag}>
                <span className="max-w-40 truncate">{tag}</span>
              </HeroTag>
            ))}
          </TagGroup.List>
        </TagGroup>
      )}
      <TextInput
        value={newTagInput}
        onChange={(e) => setNewTagInput(e.target.value)}
        onKeyDown={handleAddTag}
        placeholder="Add a tag and press Enter"
        aria-label="Add tag"
      />
    </div>
  );

  const modeSummary = editStrategy === "full" ? "Keep the full recording"
    : editStrategy === "highlights" ? `AI highlight · about ${highlightTarget}s · ${selectedAgent}`
    : `Keep the story${removeSilence ? " · remove long pauses" : ""}${removeRetakes ? " · keep later retakes" : ""}`;
  const editSummary = `${modeSummary}${customInstructionsEnabled && promptHook.trim() ? " · Custom instructions" : ""}`;
  const canRender = Boolean(isTauri() && metadata && inputPath.trim() && outputPath.trim() && !isProbing);
  const hasCompletedOutput = Boolean(latestCompletedOutput(inputPath, renderHistory) || (job.result?.success && job.inputVideo === inputPath));

  const selectedPresetName =
    PRESETS.find((p) => p.id === selectedPreset)?.name ?? selectedPreset;
  const selectedAgentName =
    AGENTS.find((a) => a.id === selectedAgent)?.name ?? selectedAgent;

  const renderPreflightRow = (
    label: string,
    value: string,
    sectionId: string,
  ) => (
    <div className="flex items-center justify-between gap-3 py-2">
      <div className="min-w-0">
        <div className="text-xs text-muted">{label}</div>
        <div className="truncate text-sm font-medium text-foreground" title={value}>
          {value}
        </div>
      </div>
      <Button variant="ghost" size="sm" aria-label={`Edit ${label.toLowerCase()}`} disabled={!metadata && sectionId !== "studio-source"} onClick={() => scrollToSection(sectionId)}>
        Edit
      </Button>
    </div>
  );

  const editingModelSelector = (allowAutomatic = false) => (
    <Select variant="secondary" fullWidth selectedKey={!allowAutomatic && selectedAgent === AUTO_CUT_AGENT_ID ? null : selectedAgent}
      onSelectionChange={key => { if (key) setSelectedAgent(String(key)); }}
      placeholder="Choose a local CLI"
      disabledKeys={AGENTS.filter(agent => agentProbe[agent.id]?.available === false).map(agent => agent.id)}>
      <Label>{allowAutomatic ? "Clip finder" : "AI editing CLI"}</Label><Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
      <Select.Popover><ListBox>{AGENTS.filter(agent => allowAutomatic || agent.id !== AUTO_CUT_AGENT_ID).map(agent =>
        <ListBox.Item key={agent.id} id={agent.id} textValue={agent.name}>{agent.name}</ListBox.Item>)}</ListBox></Select.Popover>
    </Select>
  );
  const stageIndex = STUDIO_STAGES.findIndex(stage => stage.id === activeStage);
  const stage = STUDIO_STAGES[stageIndex];
  const preview = metadata && inputPath ? <VideoPreview inputPath={inputPath}
    completedOutput={latestCompletedOutput(inputPath, renderHistory)}
    completedVersion={renderHistory.find(entry => entry.inputVideo === inputPath && entry.status === "completed")?.id ?? ""}
    jobOutput={job.result?.success && job.inputVideo === inputPath ? job.outputVideo : null}
    jobVersion={job.jobId ?? ""}
    onOpenFile={onOpenFile} onReveal={onOpenFileLocation} /> : null;

  return (
    <div className="studio-workspace space-y-5" id="studio-workspace">
      {/* Page header — draft name + file status, primary actions */}
      <PageHeader
        eyebrow={<span className="inline-flex items-center gap-1.5"><Monitor className="size-3.5" /> Studio · Local rendering</span>}
        title={fileName || "Create your next short"}
        description={metadata ? `${formatClipTime(metadata.duration_seconds)} · ${metadata.width} × ${metadata.height} · Draft saved on this computer` : "From your recording to a finished video, one simple step at a time."}
        actions={
          <Button
            variant={metadata ? "secondary" : "primary"}
            icon={<FolderOpen />}
            onClick={handleBrowseFile}
            disabled={job.isRunning}
          >
            {inputPath ? "Change video" : "Import video"}
          </Button>
        }
      />

      <StudioNavigation active={activeStage} hasVideo={Boolean(metadata)}
        hasJobs={job.status !== "idle" || renderHistory.length > 0} onChange={goToStage} />
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="mb-1 text-xs font-medium text-muted">STEP {stageIndex + 1} OF {STUDIO_STAGES.length}</p>
          <h2 ref={stageHeadingRef} tabIndex={-1} className="text-xl font-semibold text-foreground outline-none">{stage.title}</h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted">{stage.description}</p>
        </div>
        {seoBusy && <span role="status" className="flex items-center gap-2 text-xs text-muted"><Spinner size="sm" /> Analyzing your video</span>}
      </div>
      {!isTauri() && <div className="rounded-xl border border-border bg-surface p-3 text-sm text-muted">Browser preview · Open the desktop app to import videos and run your local editing tools.</div>}
      <div className={`studio-work-area ${metadata ? "studio-work-area--with-preview" : ""}`}>
      <div className="studio-controls min-w-0">
          <section id="studio-source" hidden={activeStage !== "source"} aria-label="Video source" className="studio-panel space-y-5">
              {/* Two ways in, side by side at equal height. */}
              <div className="studio-source-options grid grid-cols-1 gap-5">
              <SectionCard
                title="Video file"
                description={metadata ? "Ready to edit" : "Drop a file or browse"}
                contentClassName="flex flex-col"
              >
                <div
                  ref={dropzoneRef}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  onClick={inputPath ? undefined : handleBrowseFile}
                  role={inputPath ? undefined : "button"}
                  tabIndex={inputPath ? undefined : 0}
                  onKeyDown={
                    inputPath
                      ? undefined
                      : (e) => {
                          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void handleBrowseFile(); }
                        }
                  }
                  className={`rounded-lg transition-colors ${
                    inputPath
                      ? isDragging
                        ? "outline-2 outline-offset-4 outline-accent outline-dashed"
                        : ""
                      : `flex min-h-44 flex-1 cursor-pointer flex-col items-center justify-center border border-dashed px-4 py-10 text-center ${
                          isDragging
                            ? "border-accent bg-accent/5"
                            : "border-border-tertiary hover:border-muted hover:bg-surface-secondary"
                        }`
                  }`}
                >
                  {!inputPath ? (
                    <div className="flex flex-col items-center gap-1.5">
                      <Upload className="mb-1 size-5 text-muted" />
                      <p className="text-sm font-medium text-foreground">
                        {isDragging
                          ? "Drop to import"
                          : "Drop a video here, or click to browse"}
                      </p>
                      <p className="text-xs text-muted">MP4, MOV or MKV</p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <span className="flex h-12 w-[27px] shrink-0 items-center justify-center rounded-[3px] border border-border bg-surface-tertiary text-muted">
                          <Film className="size-3.5" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div
                            className="truncate text-sm font-medium text-foreground"
                            title={fileName}
                          >
                            {fileName}
                          </div>
                          <div
                            className="truncate font-mono text-xs text-muted"
                            title={inputPath}
                          >
                            {inputPath}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-0.5">
                          <Button
                            variant="ghost"
                            size="sm"
                            iconOnly
                            icon={<FolderOpen />}
                            onClick={() => onOpenFileLocation(inputPath)}
                            aria-label="Show in file explorer"
                            title="Show in file explorer"
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            iconOnly
                            icon={<ExternalLink />}
                            onClick={() => onOpenFile(inputPath)}
                            aria-label="Play in default player"
                            title="Play in default player"
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            iconOnly
                            icon={<RotateCcw />}
                            onClick={handleBrowseFile}
                            aria-label="Replace file"
                            title="Replace file"
                          />
                        </div>
                      </div>

                      {isProbing && (
                        <div className="flex items-center justify-center gap-2 py-1 text-xs text-muted">
                          <Spinner size="sm" color="current" />
                          Reading your video…
                        </div>
                      )}
                    </div>
                  )}
                </div>
                {metadata && (
                  <dl className="mt-4 grid grid-cols-3 gap-x-3 gap-y-2.5 border-t border-separator pt-4 text-xs">
                    {[
                      ["Duration", `${metadata.duration_seconds}s`],
                      [
                        "Resolution",
                        `${metadata.width}×${metadata.height}`,
                      ],
                      ["Frame rate", `${metadata.fps} fps`],
                      ["Codec", metadata.codec.toUpperCase()],
                      [
                        "Audio",
                        metadata.audio_channels > 0
                          ? `${metadata.audio_channels} ch`
                          : "None",
                      ],
                      [
                        "File size",
                        `${(metadata.file_size_bytes / 1024 / 1024).toFixed(1)} MB`,
                      ],
                    ].map(([term, value]) => (
                      <div key={term}>
                        <dt className="text-xs text-muted">{term}</dt>
                        <dd className="tabular-nums font-medium text-foreground">
                          {value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </SectionCard>

              <SectionCard
                title="From a stream"
                description="Paste a YouTube or Twitch VOD — the best moments become shorts"
                contentClassName="flex flex-col"
              >
                <div className="flex flex-1 flex-col gap-3">
                  {/* Button sits outside Field so the label-row button
                      shrink rule doesn't apply; bottoms align with the input. */}
                  <div className="flex items-end gap-2">
                    <Field label="Video link" className="min-w-0 flex-1">
                      <TextInput
                        value={streamUrl}
                        onChange={(e) => handleStreamUrlChange(e.target.value)}
                        placeholder="https://www.youtube.com/watch?v=…"
                        className="font-mono"
                        aria-label="Stream link"
                      />
                    </Field>
                    <Button
                      variant="primary"
                      className="shrink-0"
                      icon={<Sparkles />}
                      isLoading={streamAnalyzing}
                      disabled={streamAnalyzing || streamWatching || !streamUrl.trim() || !isTauri()}
                      onClick={handleStreamAnalyze}
                    >
                      Find clips
                    </Button>
                  </div>

                  {streamRuns.recent.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs text-muted">Recent</span>
                      {streamRuns.recent.slice(0, 5).map((recentUrl) => {
                        const run = streamRuns.runs[recentUrl];
                        const title =
                          run?.probe?.title ||
                          run?.result?.title ||
                          recentUrl;
                        const count = run?.result
                          ? ` · ${run.result.clips.length} clip${run.result.clips.length === 1 ? "" : "s"}`
                          : "";
                        const active =
                          recentUrl === streamUrl.trim() &&
                          streamUrl.trim() !== "";
                        return (
                          <span
                            key={recentUrl}
                            className={`flex h-6 max-w-56 items-center gap-1 rounded-[5px] border pr-1 pl-2 text-xs ${
                              active
                                ? "border-accent/50 bg-accent/10 text-foreground"
                                : "border-border text-muted hover:border-border-tertiary hover:text-foreground"
                            }`}
                          >
                            <button
                              type="button"
                              title={recentUrl}
                              onClick={() => run && loadRunIntoView(run)}
                              className="min-w-0 flex-1 truncate text-left"
                            >
                              {title}
                              {count}
                            </button>
                            <button
                              type="button"
                              aria-label={`Forget ${title}`}
                              disabled={streamAnalysisJobs[recentUrl]?.status === "running"}
                              title={streamAnalysisJobs[recentUrl]?.status === "running" ? "Clip finding is running" : "Forget this stream"}
                              onClick={() => forgetStream(recentUrl)}
                              className="shrink-0 rounded px-0.5 hover:text-danger disabled:cursor-not-allowed disabled:opacity-30"
                            >
                              <X className="size-3" />
                            </button>
                          </span>
                        );
                      })}
                    </div>
                  )}

                  {(streamProbing || streamProbe) && (
                    <div className="flex items-center gap-3 rounded-md border border-border bg-surface-secondary p-2">
                      {streamProbe?.thumbnail ? (
                        <img
                          src={streamProbe.thumbnail}
                          alt=""
                          className="h-12 w-20 shrink-0 rounded object-cover"
                          onError={(e) => {
                            e.currentTarget.style.display = "none";
                          }}
                        />
                      ) : (
                        <span className="flex h-12 w-20 shrink-0 items-center justify-center rounded border border-border bg-surface text-muted">
                          <Link2 className="size-4" />
                        </span>
                      )}
                      <div className="min-w-0 leading-tight">
                        {streamProbing && !streamProbe ? (
                          <div className="flex items-center gap-2 text-xs text-muted">
                            <Spinner size="sm" color="current" />
                            Reading video details…
                          </div>
                        ) : (
                          <>
                            <div className="flex items-center gap-2 truncate text-sm font-semibold text-foreground">
                              {streamProbe?.is_live && (
                                <span className="shrink-0 rounded-[4px] bg-danger/15 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-danger">
                                  LIVE
                                </span>
                              )}
                              <span className="truncate">{streamProbe?.title}</span>
                            </div>
                            <div className="truncate text-xs text-muted">
                              {[
                                streamProbe?.channel,
                                streamProbe && streamProbe.duration > 0
                                  ? formatClipTime(streamProbe.duration)
                                  : null,
                                formatStreamViews(streamProbe?.view_count ?? null),
                                formatStreamDate(streamProbe?.upload_date ?? null),
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  )}

                  {streamAnalyzing && (
                    <div role="status" className="space-y-2 rounded-lg border border-accent/20 bg-accent/5 p-3">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <Spinner size="sm" color="current" /> Finding the best moments
                      </div>
                      <LinearProgress label="Finding clips" />
                      <p className="text-xs leading-relaxed text-muted">Reading captions or transcribing audio, then selecting clips. Long videos may take several minutes.</p>
                    </div>
                  )}

                  {streamWatching && !streamAnalyzing && (
                    <div role="status" className="space-y-2 rounded-lg border border-danger/20 bg-danger/5 p-3">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <span className="relative flex size-2 shrink-0">
                          <span className="absolute inline-flex size-full animate-ping rounded-full bg-danger opacity-60" />
                          <span className="relative inline-flex size-2 rounded-full bg-danger" />
                        </span>
                        Waiting for the replay
                      </div>
                      <p className="text-xs leading-relaxed text-muted">
                        This stream is live. Clip finding starts when the VOD is ready.
                      </p>
                      {onStopWatchingStream && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={streamJob?.status === "running"}
                          onClick={() => onStopWatchingStream(streamUrl.trim())}
                        >
                          Stop waiting
                        </Button>
                      )}
                    </div>
                  )}

                  <div className="mt-auto space-y-2 border-t border-separator pt-3">
                    {editingModelSelector(true)}
                    <p className="text-xs leading-relaxed text-muted">Auto cut uses local scoring; a CLI can plan the moments with AI. Import the clips you want, then adjust their edit and framing.</p>
                  </div>
                </div>
              </SectionCard>
              </div>

              {streamResult && !streamAnalyzing && (
                <SectionCard
                  title="Stream clips"
                  description={
                    streamProbe?.title || "Best moments from the stream"
                  }
                >
                  <div className="space-y-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-sm font-semibold text-foreground">
                        {streamResult.clips.length === 0
                          ? "No clips found"
                          : `${streamResult.clips.length} clip${streamResult.clips.length === 1 ? "" : "s"} found`}
                        <span className="ml-1.5 font-normal text-muted">
                          {streamResult.wordsCount.toLocaleString()} words ·{" "}
                          {streamResult.transcriptSource}
                        </span>
                        <span
                          title={
                            streamResult.pickerNote ||
                            "Which engine picked these clips"
                          }
                          className={`ml-1.5 rounded-[4px] px-1.5 py-0.5 text-xs font-medium ${
                            streamResult.picker.startsWith("agent:")
                              ? "bg-accent/12 text-accent"
                              : "bg-surface-tertiary text-muted"
                          }`}
                        >
                          {streamResult.picker.startsWith("agent:")
                            ? `Picked by ${streamResult.picker.slice(6).toUpperCase()}`
                            : "Auto-scored"}
                        </span>
                      </div>
                      {streamResult.clips.length > 0 && (
                        <div className="flex items-center gap-1.5">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              setStreamSelected(
                                streamResult.clips.map((_, i) => i),
                              )
                            }
                          >
                            Select all
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setStreamSelected([])}
                          >
                            Clear
                          </Button>
                        </div>
                      )}
                    </div>

                    {streamResult.clips.length > 0 && (
                      <SearchField
                        variant="secondary"
                        fullWidth
                        value={streamQuery}
                        onChange={setStreamQuery}
                        aria-label="Search clips"
                      >
                        <SearchField.Group>
                          <SearchField.SearchIcon />
                          <SearchField.Input placeholder="Search clips by words or reason…" />
                          <SearchField.ClearButton />
                        </SearchField.Group>
                      </SearchField>
                    )}

                    <div className="divide-y divide-separator overflow-hidden rounded-md border border-border">
                    {streamVisibleClips.map(({ clip, index }) => {
                        const selected = streamSelected.includes(index);
                        const usingAsSource = streamUseAsSource === index;
                        return (
                          <div
                            key={`${clip.start}-${clip.end}`}
                            className={`px-3 py-2.5 transition-colors ${
                              selected
                                ? "bg-accent/8"
                                : "hover:bg-surface-secondary"
                            }`}
                          >
                            <button
                              type="button"
                              onClick={() => toggleStreamClip(index)}
                              aria-pressed={selected}
                              className="block w-full text-left"
                            >
                              <div className="flex items-center gap-2">
                                <span
                                  className={`flex size-4 shrink-0 items-center justify-center rounded-[4px] border ${
                                    selected
                                      ? "border-accent bg-accent text-accent-foreground"
                                      : "border-border-tertiary text-transparent"
                                  }`}
                                >
                                  <Check className="size-3" strokeWidth={3} />
                                </span>
                                <span className="tabular-nums rounded-[4px] bg-surface-tertiary px-1.5 text-xs font-semibold text-foreground">
                                  {Math.round(clip.score * 100)}
                                </span>
                                <span className="tabular-nums text-xs text-muted">
                                  {formatClipRange(clip.start, clip.end)}
                                </span>
                                <span className="truncate text-xs font-medium text-foreground">
                                  {clip.reason}
                                </span>
                              </div>
                              <p className="mt-1 line-clamp-2 pl-6 text-xs leading-relaxed text-muted">
                                {clip.text}
                              </p>
                            </button>
                            <div className="mt-1.5 flex justify-end pl-6">
                              <Button
                                variant="ghost"
                                size="sm"
                                icon={<ChevronRight />}
                                isLoading={usingAsSource}
                                disabled={
                                  streamImporting || streamUseAsSource !== null
                                }
                                onClick={() => handleUseClipAsSource(index)}
                                title="Download this clip and edit it through Style → Captions → Metadata → Render"
                              >
                                {usingAsSource
                                  ? "Setting source…"
                                  : "Use as source"}
                              </Button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    {streamResult.clips.length > 0 &&
                      streamVisibleClips.length === 0 && (
                        <EmptyState
                          icon={<Search className="size-5" />}
                          title="No matches"
                          description="No clips match that search."
                        />
                      )}

                    {streamSelected.length > 0 && (
                      <Button
                        variant="primary"
                        size="md"
                        icon={<FolderOpen />}
                        isLoading={streamImporting}
                        disabled={streamImporting || streamUseAsSource !== null}
                        onClick={() => handleImportClipsAsSources()}
                        className="w-full"
                      >
                        {streamImporting
                          ? streamImportProgress
                            ? `Importing clip ${streamImportProgress.current} of ${streamImportProgress.total}…`
                            : "Importing clips…"
                          : `Import ${streamSelected.length} clip${streamSelected.length === 1 ? "" : "s"} as source${streamSelected.length === 1 ? "" : "s"}`}
                      </Button>
                    )}
                    <p className="text-xs leading-relaxed text-muted">
                      Only the winning windows are downloaded — never the
                      full video. Each clip is fetched on its own, so a
                      failed window is skipped and the rest still become
                      sidebar sources. Open each one to edit and render it
                      like any uploaded video.
                    </p>
                  </div>
                </SectionCard>
              )}
          </section>

          {metadata && (
            /* Automation first, then the output look and framing. */
            <section id="studio-edit" hidden={activeStage !== "edit"} aria-label="Edit and format" className="studio-panel grid grid-cols-1 gap-5">
              <SectionCard title="How would you like to edit?" description="Start with a mode. Fine-tune the details below.">
                <div className="space-y-4">
                  <div className="studio-edit-modes grid gap-3" role="group" aria-label="Editing mode">
                    {([
                      ["cleanup", "Clean up", "Remove pauses & repeated takes"],
                      ["highlights", "AI highlight", "Find a focused moment"],
                      ["full", "Keep full video", "Style without cutting"],

                    ] as const).map(([value, label, description]) => <button key={value} type="button"
                      aria-pressed={editStrategy === value} onClick={() => setEditStrategy(value)}
                      className={`studio-choice ${editStrategy === value ? "studio-choice--selected" : ""}`}>
                      <span className="flex items-center justify-between gap-2 font-medium">{label}{editStrategy === value && <Check className="size-4 shrink-0 text-accent" />}</span>
                      <span className="mt-1 block text-xs leading-relaxed text-muted">{description}</span>
                    </button>)}
                  </div>
                  <p className="text-sm text-muted">{editStrategy === "cleanup"
                    ? "Keep your complete story. Remove long pauses and earlier repeated takes without a fixed time limit."
                    : editStrategy === "highlights" ? `Let an editing model choose a focused short up to ${highlightTarget} seconds, with a clear opening and ending. If the source already fits, it may keep the same content as Clean up.`
                    : "Keep all footage and apply your color, framing, and caption settings. Optional instructions can request specific cuts."}</p>
                  {(editStrategy === "cleanup" || editStrategy === "highlights") && <div className="studio-cleanup-options grid gap-x-5 gap-y-3">
                    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={removeSilence}
                      onChange={e => setRemoveSilence(e.target.checked)} />Remove long pauses</label>
                    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={removeRetakes}
                      onChange={e => setRemoveRetakes(e.target.checked)} />Keep the later repeated take</label>
                  </div>}
                  <div className="space-y-4 border-t border-separator pt-4">
                    {editingModelSelector()}
                    {editStrategy === "highlights" && <Field label="Target length">
                      <Segmented label="Highlight length" value={String(highlightTarget)} onChange={value => setHighlightTarget(Number(value))}
                        options={[{ value: "30", label: "30s" }, { value: "60", label: "60s" }, { value: "90", label: "90s" }]} />
                    </Field>}
                    <div className="space-y-3 rounded-xl border border-border p-3">
                      <Switch isSelected={customInstructionsEnabled} onChange={setCustomInstructionsEnabled} aria-label="Add custom instructions">
                        <Switch.Content>
                          <Switch.Control><Switch.Thumb /></Switch.Control>
                          <Label>Add custom instructions</Label>
                        </Switch.Content>
                      </Switch>
                      <p className="text-xs leading-relaxed text-muted">Optional guidance for this edit. You can use it with any editing mode.</p>
                      {customInstructionsEnabled && <Field label="Your instructions" hint={`${promptHook.length}/4,000 characters · Saved even when switched off`}>
                        <TextArea rows={5} value={promptHook} maxLength={4000} onChange={event => setPromptHook(event.target.value)}
                          aria-label="Custom editing instructions" placeholder="For example: Keep the full explanation, cut the false starts, and use https://www.youtube.com/watch?v=… as a pacing reference." />
                        <p className="mt-2 text-xs leading-relaxed text-muted">YouTube links are read as caption references for the opening, topic and pacing. They do not insert footage from another video. Leave this blank to use the selected mode on its own.</p>
                      </Field>}
                    </div>
                    <p className="text-xs leading-relaxed text-muted">{usesEditingAgent ? "Uses your selected CLI for AI planning; video rendering runs on your computer." : "Clean up and Keep full video run locally without AI unless you add instructions. Your AI selection is saved for when it’s needed."}</p>
                  </div>
                </div>
              </SectionCard>
              <SectionCard title="Color grade" description="Look applied to the whole short">
                <div className="studio-grade-options grid items-stretch gap-3" role="radiogroup" aria-label="Color grade">
                  {PRESETS.map((preset) => {
                    const isSelected = selectedPreset === preset.id;
                    return (
                      <button
                        type="button"
                        key={preset.id}
                        role="radio"
                        aria-checked={isSelected}
                        title={preset.description}
                        onClick={() => setSelectedPreset(preset.id)}
                        className={`flex h-full flex-col overflow-hidden rounded-lg border text-left transition-colors ${
                          isSelected
                            ? "border-accent ring-2 ring-accent/20"
                            : "border-border hover:border-border-tertiary"
                        }`}
                      >
                        <span
                          aria-hidden
                          className="block h-12 w-full"
                          style={{ background: GRADE_SWATCH[preset.id] }}
                        />
                        <span className="flex flex-1 flex-col gap-0.5 border-t border-separator px-3 py-2">
                          <span className="flex items-center justify-between gap-2 text-sm font-medium text-foreground">
                            <span className="truncate">{preset.name}</span>
                            {isSelected && (
                              <Check className="size-3.5 shrink-0 text-accent" strokeWidth={3} />
                            )}
                          </span>
                          <span className="line-clamp-2 text-xs leading-snug text-muted">
                            {preset.description}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </SectionCard>

              <SectionCard
                title="Format & framing"
                description="Output size and how the source is framed in it"
              >
                <div className="space-y-4">
                  <div>
                    <span className="mb-1.5 block text-xs font-medium text-foreground">
                      Aspect ratio
                    </span>
                    <Segmented
                      label="Aspect ratio"
                      value={aspectRatio}
                      fill
                      onChange={(v) => setAspectRatio(parseAspectRatio(v))}
                      options={STREAM_ASPECT_RATIOS.map((a) => ({
                        value: a.id,
                        label: a.name,
                      }))}
                    />
                    <p className="mt-1.5 text-xs leading-snug text-muted">
                      {aspectRatio === "9:16"
                        ? "Vertical 1080×1920 — Shorts, Reels, TikTok."
                        : aspectRatio === "1:1"
                          ? "Square 1080×1080 — feed posts."
                          : "Wide 1920×1080 — YouTube landscape."}
                    </p>
                  </div>
                  <div>
                    <span className="mb-1.5 block text-xs font-medium text-foreground">
                      Framing
                    </span>
                    <Segmented
                      label="Framing"
                      value={streamLayout}
                      fill
                      onChange={(v) => setStreamLayout(v as StreamLayoutId)}
                      options={STREAM_LAYOUTS.map((l) => ({
                        value: l.id,
                        label: l.name,
                      }))}
                    />
                    <p className="mt-1.5 text-xs leading-snug text-muted">
                      {aspectRatio !== "9:16" && needsNineSixteenCanvas(streamLayout)
                        ? "Split and face framings need 9:16 — square and wide renders use the smart single crop."
                        : streamLayout === "auto"
                          ? "Auto preserves already-vertical screen + facecam layouts. Wide recordings use a full webcam panel, speaker crop, or full-frame fit."
                          : streamLayout === "face-only"
                            ? "Frames the speaker with room for hair and chin — best for talking heads."
                            : isSplitStreamLayout(streamLayout)
                              ? "Split keeps the screen above or below a full webcam panel, with captions clear of the face."
                              : "Single follows the detected speaker; uncertain detections preserve the full source."}
                    </p>
                  </div>
                </div>
              </SectionCard>

            </section>
          )}

          {metadata && (
            <section id="studio-captions" hidden={activeStage !== "captions"} aria-label="Captions" className="studio-panel">
            <SubtitleStudio
              selectedTheme={subtitleStyle}
              onSelectTheme={setSubtitleStyle}
              position={subtitlePosition}
              onChangePosition={setSubtitlePosition}
              size={subtitleSize}
              onChangeSize={setSubtitleSize}
              casing={subtitleCase}
              onChangeCasing={setSubtitleCase}
              burnInCaptions={burnInCaptions}
              onToggleBurnInCaptions={setBurnInCaptions}
              videoTitle={seoTitle || fileName}
              aspectRatio={aspectRatio}
              isActive={activeStage === "captions"}
            />
            </section>
          )}

          {metadata && (
            <section id="studio-title" hidden={activeStage !== "title"} aria-label="Title and tags" className="studio-panel flex flex-col gap-5">
              <div className="min-w-0 space-y-5">
              <SectionCard
              title="Title & description"
                  description={
                    seoMetadata
                      ? "Saved with the exported video"
                      : "Write your own details or generate them from speech"
                  }
                  actions={
                    <>
                      <Button
                        variant="ghost"
                        icon={
                          copiedSection === "all" ? <Check /> : <Copy />
                        }
                        onClick={handleCopyAllMetadata}
                        title="Copy full title, description and tags bundle"
                      >
                        {copiedSection === "all" ? "Copied" : "Copy all"}
                      </Button>
                      {onSendToSocial && (
                        <Button
                          variant="primary"
                          icon={<Share2 />}
                          disabled={!hasCompletedOutput}
                          title={!hasCompletedOutput ? "Export your video before sending it to Social" : undefined}
                          onClick={() =>
                            onSendToSocial(playableOutput, {
                              title: seoTitle,
                              description: seoDescription,
                              tags: seoTags,
                            })
                          }
                        >
                          Send to Social
                        </Button>
                      )}
                    </>
                  }
                >
                  <div className="space-y-4">
                    <Field
                      label={
                        <span className="flex items-center gap-1.5">
                          Video title
                          <span className="font-normal text-muted">
                            ({seoTitle.length}/100)
                          </span>
                        </span>
                      }
                      hint={titleFeedHint(seoTitle)}
                      action={
                        <Button
                          variant="ghost"
                          icon={
                            copiedSection === "title" ? <Check /> : <Copy />
                          }
                          onClick={() => handleCopyText(seoTitle, "title")}
                        >
                          {copiedSection === "title" ? "Copied" : "Copy"}
                        </Button>
                      }
                    >
                      <TextInput
                        value={seoTitle}
                        onChange={(e) => setSeoTitle(e.target.value)}
                        aria-label="Video title"
                      />
                    </Field>

                    {seoMetadata?.title_alternatives &&
                      seoMetadata.title_alternatives.filter((t) => t !== seoTitle)
                        .length > 0 && (
                        <div className="flex flex-col gap-1.5">
                          {seoMetadata.title_alternatives
                            .filter((t) => t !== seoTitle)
                            .slice(0, 4)
                            .map((t) => (
                              <button
                                key={t}
                                type="button"
                                onClick={() => setSeoTitle(t)}
                                title="Use this title"
                                className="w-full whitespace-normal break-words rounded-lg border border-border bg-surface-secondary/60 px-2 py-1.5 text-left text-xs text-muted transition-colors hover:border-accent hover:text-foreground"
                              >
                                {t}
                              </button>
                            ))}
                        </div>
                      )}

                    <Field
                      label="Description"
                      action={
                        <Button
                          variant="ghost"
                          icon={
                            copiedSection === "desc" ? <Check /> : <Copy />
                          }
                          onClick={() =>
                            handleCopyText(seoDescription, "desc")
                          }
                        >
                          {copiedSection === "desc" ? "Copied" : "Copy"}
                        </Button>
                      }
                    >
                      <TextArea
                        rows={4}
                        value={seoDescription}
                        onChange={(e) => setSeoDescription(e.target.value)}
                        aria-label="Video description"
                      />
                    </Field>

                    <Field
                      label={
                        <span className="flex items-center gap-1.5">
                          <Tag className="size-3.5 text-muted" />
                          Search tags ({seoTags.length} ·{" "}
                          {seoTags.join(", ").length}/500)
                        </span>
                      }
                      action={
                        <Button
                          variant="ghost"
                          icon={
                            copiedSection === "tags" ? <Check /> : <Copy />
                          }
                          onClick={() =>
                            handleCopyText(seoTags.join(", "), "tags")
                          }
                        >
                          {copiedSection === "tags" ? "Copied" : "Copy"}
                        </Button>
                      }
                    >
                      {renderTagEditor()}
                    </Field>
                    <Field
                      label="Pinned comment"
                      hint="Posted and pinned on YouTube with the upload — a question gets replies"
                    >
                      <TextArea
                        rows={2}
                        value={pinnedComment}
                        onChange={(e) => setPinnedComment(e.target.value)}
                        placeholder="e.g. Which pool crate do you use?"
                        aria-label="Pinned first comment"
                      />
                    </Field>
                    <SeoChecklist
                      title={seoTitle}
                      description={seoDescription}
                      tags={seoTags}
                      hashtags={normalizeHashtags(
                        seoTags,
                        seoMetadata?.hashtags ?? [],
                      )}
                      keywords={queryTargets.keywords}
                      queries={queryTargets.queries}
                      hook={reviewReport?.hook_detected ?? ""}
                      retention={seoMetadata?.seo_score ?? 0}
                      engineQuality={seoMetadata?.quality_score ?? null}
                    />
                    {!seoMetadata && !seoBusy && (
                      <p className="text-xs leading-snug text-muted">
                        No AI analysis yet — titles, tags, and the review
                        summary appear here once your transcript is
                        analyzed. Use Re-analyze in the review summary below.
                      </p>
                    )}
                  </div>
                </SectionCard>
              </div>
            <div className="min-w-0 space-y-5">
            <SectionCard
            title="Review summary"
                description={
                  seoMetadata
                    ? [
                        typeof seoMetadata.quality_score === "number"
                          ? `Package ${seoMetadata.quality_score}/100`
                          : null,
                        seoMetadata.seo_score
                          ? `retention ${seoMetadata.seo_score}/100`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "Whole-video analysis"
                    : "Whole-video analysis"
                }
                actions={
                  <Button
                    variant="secondary"
                    isLoading={seoBusy}
                    icon={<RefreshCw />}
                    onClick={() => handleGenerateSeo()}
                    disabled={seoBusy}
                  >
                    {seoBusy ? "Analyzing" : "Re-analyze"}
                  </Button>
                }
              >
                {reviewReport ? (
                  <div className="space-y-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="success">
                        {reviewReport.retention_score}/100 retention
                      </Badge>
                      {reviewReport.word_count ? (
                        <span className="tabular-nums text-xs text-muted">
                          {reviewReport.word_count} spoken words
                        </span>
                      ) : null}
                      {reviewReport.takes_count ? (
                        <span className="tabular-nums text-xs text-muted">
                          {reviewReport.takes_count} takes
                        </span>
                      ) : null}
                      {reviewReport.segment_count ? (
                        <span className="tabular-nums text-xs text-muted">
                          {reviewReport.segment_count}{" "}
                          {reviewReport.segment_count === 1 ? "cut" : "cuts"}
                        </span>
                      ) : null}
                      {reviewReport.output_duration ? (
                        <span className="tabular-nums text-xs text-muted">
                          {reviewReport.output_duration}s out
                        </span>
                      ) : null}
                      {reviewReport.speech_wps ? (
                        <span className="tabular-nums text-xs text-muted">
                          {reviewReport.speech_wps} w/s
                        </span>
                      ) : null}
                      {reviewReport.transcript_source ? (
                        <span className="tabular-nums text-xs text-muted">
                          transcript: {reviewReport.transcript_source}
                        </span>
                      ) : null}
                    </div>
                    <p className="text-xs leading-relaxed text-muted">
                      {reviewReport.overall_summary}
                    </p>
                    {reviewReport.hook_detected && (
                      <div className="rounded-lg border border-border bg-surface-secondary/60 p-3 text-xs">
                        <span className="mb-0.5 block text-xs font-medium text-muted">
                          Opening hook
                        </span>
                        <span className="font-medium text-foreground">
                          “{reviewReport.hook_detected}”
                        </span>
                      </div>
                    )}
                    {reviewReport.content_highlights?.length > 0 && (
                      <div className="space-y-1">
                        <span className="block text-xs font-medium text-muted">
                          Highlights
                        </span>
                        <ul className="grid grid-cols-1 gap-1 text-xs text-foreground sm:grid-cols-2">
                          {reviewReport.content_highlights.map((h, i) => (
                            <li key={i} className="flex items-start gap-1.5">
                              <span className="text-muted">•</span>
                              <span className="line-clamp-2 leading-snug">
                                {h}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                ) : (
                  <EmptyState
                    icon={<Sparkles className="size-5" />}
                    title="No review yet"
                    description="Use Re-analyze to review this video’s dialogue, pacing and hooks."
                  />
                )}
              </SectionCard>

              <SectionCard
                title="Channel context"
                description={`Steer titles toward your niche · Profile: ${getDefaultProfile()?.name ?? "none"}`}
                actions={
                  <Button
                    variant="secondary"
                    isLoading={seoBusy}
                    icon={<Wand2 />}
                    onClick={handleRecalibrateContext}
                    disabled={seoBusy}
                  >
                    {seoBusy ? "Applying" : "Apply context"}
                  </Button>
                }
              >
                <TextArea
                  rows={2}
                  value={contextOverride}
                  onChange={(e) => handleUpdateContextOverride(e.target.value)}
                  placeholder="Per-video override (optional) — blank uses your default channel profile…"
                  aria-label="Per-video channel context override"
                />
                <p className="mt-1.5 text-xs leading-snug text-muted">
                  Blank uses the default profile from Settings → Channel.
                  Anything typed here wins for this video only.
                </p>
              </SectionCard>

              <SectionCard
                title="Trending boost"
                description={
                  trending?.cached
                    ? "Cached keyword signals · 24h"
                    : "Live Shorts keyword signals"
                }
                actions={
                  <Button
                    variant="secondary"
                    isLoading={trendingLoading}
                    icon={<RefreshCw />}
                    onClick={handleFetchTrending}
                    disabled={trendingLoading}
                  >
                    {trendingLoading ? "Fetching" : "Fetch trends"}
                  </Button>
                }
              >
                <div className="space-y-2.5">
                  <Field label="Topic niche" hint="Blank uses your profile niche">
                    <TextInput
                      value={trendingNiche}
                      onChange={(e) => setTrendingNiche(e.target.value)}
                      placeholder={
                        getDefaultProfile()?.niche?.slice(0, 60) ||
                        "e.g. rust programming"
                      }
                      aria-label="Trending topic niche"
                    />
                  </Field>
                  {trending && trending.keywords.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {trending.keywords.slice(0, 12).map((k) => {
                        const added = seoTags.includes(k.term.toLowerCase());
                        return (
                          <button
                            key={k.term}
                            type="button"
                            disabled={added}
                            onClick={() => handleAddTrendingTerm(k.term)}
                            title={
                              added
                                ? "Already in tags"
                                : `Add "${k.term}" to tags · score ${k.score}`
                            }
                            className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-xs transition-colors ${
                              added
                                ? "cursor-default border-border text-muted opacity-60"
                                : "border-border bg-surface-secondary/60 text-muted hover:border-accent hover:text-foreground"
                            }`}
                          >
                            {added ? (
                              <Check className="size-3" strokeWidth={3} />
                            ) : (
                              <Plus className="size-3" strokeWidth={3} />
                            )}
                            {k.term}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-xs leading-snug text-muted">
                      Fetch what fast-rising Shorts in your niche are titled
                      and what people search, then tap a term to add it.
                      Analysis also uses them automatically for a week.
                    </p>
                  )}
                  {trending?.queries && trending.queries.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-xs text-muted">People search</p>
                      <div className="flex flex-wrap gap-1.5">
                        {trending.queries.slice(0, 10).map((q) => {
                          const added = seoTags.includes(q.toLowerCase());
                          return (
                            <button
                              key={q}
                              type="button"
                              disabled={added}
                              onClick={() => handleAddTrendingTerm(q)}
                              title={added ? "Already in tags" : `Add "${q}" to tags`}
                              className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-xs transition-colors ${
                                added
                                  ? "cursor-default border-border text-muted opacity-60"
                                  : "border-border bg-surface-secondary/60 text-muted hover:border-accent hover:text-foreground"
                              }`}
                            >
                              {added ? (
                                <Check className="size-3" strokeWidth={3} />
                              ) : (
                                <Search className="size-3" strokeWidth={3} />
                              )}
                              {q}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </SectionCard>
              </div>

            </section>
          )}

          {(metadata || job.status !== "idle" || renderHistory.length > 0) && (
            <section id="studio-render" hidden={activeStage !== "render"} aria-label="Export" className="studio-panel space-y-5">
            <div className="min-w-0 space-y-5">
            <SectionCard
            title="Export settings"
                description="Your finished MP4 will be saved here."
              >
                <Field
                  label="Output file"
                  hint={
                    outputTouched
                      ? "Custom name — reset returns to auto."
                      : "Auto-named from your title — edit to override."
                  }
                >
                  <div className="flex items-center gap-2">
                    <TextInput
                      value={outputPath}
                      onChange={(e) => {
                        setOutputPath(e.target.value);
                        setOutputTouched(true);
                      }}
                      placeholder="final_short.mp4"
                      className="font-mono"
                      aria-label="Output file"
                    />
                    {outputTouched && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="shrink-0"
                        iconOnly
                        icon={<RotateCcw />}
                        onClick={() => setOutputTouched(false)}
                        aria-label="Reset to auto name"
                        title="Reset to auto name"
                      />
                    )}
                    {outputPath && (
                      <Button
                        variant="secondary"
                        size="sm"
                        className="shrink-0"
                        iconOnly
                        icon={<FolderOpen />}
                        onClick={() => onOpenFileLocation(playableOutput)}
                        aria-label="Reveal folder in explorer"
                        title="Reveal folder in explorer"
                      />
                    )}
                  </div>
                </Field>
                <div className="divide-y divide-separator">
                  {renderPreflightRow(
                    "Source",
                    fileName || "No footage imported",
                    "studio-source",
                  )}
                  {renderPreflightRow(
                    "Cuts & duration",
                    editSummary,
                    "studio-edit",
                  )}
                  {customInstructionsEnabled && promptHook.trim() && renderPreflightRow("Instructions", promptHook, "studio-edit")}
                  {usesEditingAgent && renderPreflightRow("AI editing CLI", selectedAgentName, "studio-edit")}
                  {renderPreflightRow(
                    "Style",
                    `${selectedPresetName} · ${usesEditingAgent ? selectedAgentName : "Automatic edit"} · ${aspectRatio} · ${streamLayout}`,
                    "studio-edit",
                  )}
                  {renderPreflightRow(
                    "Captions",
                    burnInCaptions
                      ? `${subtitleStyle} · ${subtitlePosition} · ${subtitleSize}`
                      : `Disabled — clean ${aspectRatio} crop`,
                    "studio-captions",
                  )}
                  {renderPreflightRow(
                    "Title",
                    seoTitle || "Untitled",
                    "studio-title",
                  )}
                </div>
              </SectionCard>
              </div>

              <div className="min-w-0 space-y-5">
              <SectionCard
              title="Render output"
                description={
                  job.isRunning
                    ? `Pipeline running · ${Math.round(job.progress * 100)}%`
                    : job.result?.success
                      ? "Pipeline finished"
                      : job.status === "cancelled"
                        ? "Pipeline cancelled"
                        : hasCompletedOutput ? "Saved on this computer" : "Ready to export"
                }
              >
                {job.status === "idle" ? (
                  <div className="space-y-3">
                    <EmptyState
                      icon={hasCompletedOutput ? <CheckCircle2 className="size-5 text-success" /> : <Film className="size-5" />}
                      title={hasCompletedOutput ? "Your latest export is ready" : "Ready when you are"}
                      description={hasCompletedOutput ? "Preview the finished video, or send it to Social when you’re ready to publish." : "Choose Export video below. Progress and any messages from your local tools will appear here."}
                    />
                    {hasCompletedOutput && <div className="flex flex-wrap justify-end gap-2">
                      <Button variant="secondary" icon={<Play />} onClick={() => onOpenFile(playableOutput)}>Play video</Button>
                      {onQueueOutput && <Button variant="secondary" icon={<Plus />} onClick={() => onQueueOutput(playableOutput, { title: seoTitle, description: seoDescription, tags: seoTags })}>Queue</Button>}
                      {onSendToSocial && <Button variant="primary" icon={<Share2 />} onClick={() => onSendToSocial(playableOutput, { title: seoTitle, description: seoDescription, tags: seoTags })}>Send to Social</Button>}
                    </div>}
                  </div>
                ) : (
                  <div className="space-y-3">
                    {job.result?.success && job.inputVideo === inputPath && (
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <Button
                          variant="ghost"
                          icon={<FolderOpen />}
                          onClick={() => onOpenFileLocation(playableOutput)}
                        >
                          Folder
                        </Button>
                        <Button
                          variant="secondary"
                          icon={<Play />}
                          onClick={() => onOpenFile(playableOutput)}
                        >
                          Play
                        </Button>
                        {onQueueOutput && (
                          <Button
                            variant="secondary"
                            icon={<Plus />}
                            onClick={() =>
                              onQueueOutput(playableOutput, {
                                title: seoTitle,
                                description: seoDescription,
                                tags: seoTags,
                              })
                            }
                            title="Queue this short with its meta-page SEO for posting"
                          >
                            Queue
                          </Button>
                        )}
                        <Button
                          variant="primary"
                          icon={<Sparkles />}
                          onClick={() => setShowPostRenderModal(true)}
                        >
                          Review video & SEO
                        </Button>
                      </div>
                    )}
                    <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                      {job.isRunning ? (
                        <>
                          <Spinner size="sm" color="current" />
                          Rendering short…
                          <span className="tabular-nums font-mono text-xs font-medium text-muted">
                            {Math.round(job.progress * 100)}%
                          </span>
                        </>
                      ) : job.result?.success ? (
                        <>
                          <CheckCircle2 className="size-4 text-success" />
                          Short rendered
                          <Badge variant="success">Ready for review</Badge>
                        </>
                      ) : job.status === "cancelled" ? (
                        <>
                          <Square className="size-4 text-muted" />
                          Render cancelled
                        </>
                      ) : (
                        <>
                          <AlertCircle className="size-4 text-danger" />
                          Render failed
                        </>
                      )}
                    </div>

                    {job.isRunning && (
                      <div className="space-y-1.5">
                        <div className="truncate font-mono text-xs text-muted">
                          {job.stage || "Starting…"}
                        </div>
                        <LinearProgress
                          progress={Math.round(job.progress * 100)}
                          label={job.stage || "Rendering short"}
                        />
                      </div>
                    )}

                    {(job.isRunning
                      ? job.logLines.join("\n")
                      : job.result?.stdout) ? (
                      <details className="rounded-lg border border-border p-3" open={Boolean(job.error)}>
                      <summary className="cursor-pointer text-xs font-medium text-muted">Processing details</summary>
                      <pre className="mt-3 max-h-48 overflow-y-auto rounded-lg border border-border bg-surface-secondary/70 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground">
                        {job.isRunning
                          ? job.logLines.join("\n")
                          : job.result?.stdout}
                      </pre>
                    </details>
                    ) : null}
                  </div>
                )}
              </SectionCard>

              <SectionCard
                title="Render history"
                description={
                  renderHistory.length > 0
                    ? `${renderHistory.length} tracked render${renderHistory.length === 1 ? "" : "s"}`
                    : "Past renders appear here"
                }
                actions={
                  onOpenJobs ? (
                    <Button variant="ghost" onClick={onOpenJobs}>
                      View all
                    </Button>
                  ) : undefined
                }
              >
                <RenderJobsPanel
                  jobs={renderHistory}
                  compact
                  onCancel={(id) => onCancelRenderJob?.(id)}
                  onDismiss={(id) => onDismissRenderJob?.(id)}
                  onClearFinished={() => onClearFinishedRenders?.()}
                  onOpenFileLocation={(path) => void onOpenFileLocation(path)}
                  onOpenFile={(path) => void onOpenFile(path)}
                  onQueueOutput={
                    onQueueOutput ? (path) => onQueueOutput(path) : undefined
                  }
                />
              </SectionCard>
              </div>
            </section>
          )}
      </div>
      {preview && <aside aria-label="Video preview" className="studio-preview-rail">{preview}<p className="mt-3 px-1 text-xs leading-relaxed text-muted">Preview your original or last export. New edits, framing and captions appear after export.</p></aside>}
      </div>

      <div className="studio-action-bar">
        <div className="studio-action-summary min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{job.isRunning ? job.stage || "Editing your video…" : metadata ? editSummary : "Add a video to get started"}</p>
          <p className="truncate text-xs text-muted">{metadata ? `${selectedPresetName} · ${aspectRatio} · Captions ${burnInCaptions ? "on" : "off"}` : "Your projects and exports stay on this computer."}</p>
          {job.isRunning && <LinearProgress progress={Math.round(job.progress * 100)} label="Editing video" />}
        </div>
        <div className="studio-action-buttons flex flex-wrap items-center justify-end gap-2">
          {stageIndex > 0 && <Button variant="ghost" icon={<ChevronLeft />} onClick={() => goToStage(STUDIO_STAGES[stageIndex - 1].id)}>Back</Button>}
          {job.isRunning ? <>
            {activeStage !== "render" && <Button variant="secondary" onClick={() => goToStage("render")}>View progress</Button>}
            <Button variant="secondary" icon={<Square />} onClick={() => void job.cancel()}>Cancel render</Button>
          </> : activeStage === "render" ? (
            <Button variant="primary" size="md" disabled={!canRender} icon={<Play />} onClick={handleRender}>
              {hasCompletedOutput ? "Export again" : "Export video"}
            </Button>
          ) : (
            <Button variant="primary" size="md" disabled={!metadata} onClick={() => goToStage(STUDIO_STAGES[stageIndex + 1].id)}>
              Next: {STUDIO_STAGES[stageIndex + 1].label}<ChevronRight className="size-4" />
            </Button>
          )}
        </div>
      </div>

      {/* Post-render review suite */}
      <Modal
        isOpen={showPostRenderModal}
        onClose={() => setShowPostRenderModal(false)}
        size="lg"
        title={
          <span className="flex items-center gap-2">
            Whole-video review & SEO
            <Badge variant="success">Auto-analyzed</Badge>
          </span>
        }
        description="Dialogue, pacing and hook moments were analyzed across the full recording. Steer with channel context below, or dispatch right away."
        footer={
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <Button
                variant="ghost"
                icon={<Play />}
                onClick={() => void onOpenFile(playableOutput)}
                disabled={!playableOutput}
              >
                Play video
              </Button>
              <Button
                variant="ghost"
                icon={<FolderOpen />}
                onClick={() => void onOpenFileLocation(playableOutput)}
                disabled={!playableOutput}
              >
                Reveal in folder
              </Button>
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                variant="secondary"
                icon={copiedSection === "all" ? <Check /> : <Copy />}
                onClick={handleCopyAllMetadata}
              >
                {copiedSection === "all" ? "Copied" : "Copy metadata"}
              </Button>
              {onSendToSocial && (
                <Button
                  variant="primary"
                  icon={<Share2 />}
                  onClick={() => {
                    setShowPostRenderModal(false);
                    onSendToSocial(playableOutput, {
                      title: seoTitle,
                      description: seoDescription,
                      tags: seoTags,
                    });
                  }}
                >
                  Send to Social
                </Button>
              )}
            </div>
          </div>
        }
      >
        <div className="space-y-4">
          {reviewReport && (
            <div className="space-y-2.5 rounded-md border border-border bg-surface-secondary/50 p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-foreground">
                  Summary
                </span>
                <span className="tabular-nums text-xs text-muted">
                  {[
                    reviewReport.word_count
                      ? `${reviewReport.word_count} words`
                      : null,
                    reviewReport.retention_score
                      ? `${reviewReport.retention_score}/100 retention`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>
              <p className="text-xs leading-relaxed text-muted">
                {reviewReport.overall_summary}
              </p>
              {reviewReport.hook_detected && (
                <div className="rounded-lg border border-border bg-surface p-3 text-xs">
                  <span className="mb-0.5 block text-xs font-medium text-muted">
                    Opening hook
                  </span>
                  <span className="font-medium text-foreground italic">
                    “{reviewReport.hook_detected}”
                  </span>
                </div>
              )}
              {reviewReport.content_highlights?.length > 0 && (
                <div className="space-y-1">
                  <span className="block text-xs font-medium text-muted">
                    Key points discussed
                  </span>
                  <ul className="grid grid-cols-1 gap-1 text-xs text-foreground sm:grid-cols-2">
                    {reviewReport.content_highlights.map((h, i) => (
                      <li key={i} className="flex items-start gap-1.5">
                        <span className="text-muted">•</span>
                        <span className="truncate" title={h}>
                          {h}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <div className="space-y-2.5 rounded-md border border-border bg-surface-secondary/30 p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                <Target className="size-4 text-muted" />
                Steer with channel context
              </span>
              <Button
                variant="primary"
                isLoading={seoBusy}
                icon={<Wand2 />}
                onClick={handleRecalibrateContext}
                disabled={seoBusy}
              >
                {seoBusy ? "Recalibrating" : "Fix direction"}
              </Button>
            </div>
            <TextArea
              rows={2}
              value={contextOverride}
              onChange={(e) => handleUpdateContextOverride(e.target.value)}
              placeholder="Per-video override (optional) — blank uses your default channel profile…"
              aria-label="Per-video channel context override"
            />
          </div>

          <Field
            label={
              <span className="flex items-center gap-1.5">
                Suggested title
                <span className="font-normal text-muted">
                  ({seoTitle.length}/100)
                </span>
              </span>
            }
            hint={titleFeedHint(seoTitle)}
            action={
              <Button
                variant="ghost"
                icon={copiedSection === "title" ? <Check /> : <Copy />}
                onClick={() => handleCopyText(seoTitle, "title")}
              >
                Copy
              </Button>
            }
          >
            <TextInput
              value={seoTitle}
              onChange={(e) => setSeoTitle(e.target.value)}
              aria-label="Suggested title"
            />
          </Field>

          <Field
            label="Optimized description"
            action={
              <Button
                variant="ghost"
                icon={copiedSection === "desc" ? <Check /> : <Copy />}
                onClick={() => handleCopyText(seoDescription, "desc")}
              >
                Copy
              </Button>
            }
          >
            <TextArea
              rows={4}
              value={seoDescription}
              onChange={(e) => setSeoDescription(e.target.value)}
              aria-label="Optimized description"
            />
          </Field>

          <Field
            label={`Ranked search tags (${seoTags.length} · ${seoTags.join(", ").length}/500)`}
            action={
              <Button
                variant="ghost"
                icon={copiedSection === "tags" ? <Check /> : <Copy />}
                onClick={() => handleCopyText(seoTags.join(", "), "tags")}
              >
                Copy
              </Button>
            }
          >
            {renderTagEditor()}
          </Field>
        </div>
      </Modal>
    </div>
  );
};
