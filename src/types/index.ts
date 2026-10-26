export interface CliToolInfo {
  id: string;
  name: string;
  command: string;
  path: string | null;
  version: string | null;
  is_available: boolean;
  is_enabled: boolean;
  description: string;
  category: "core" | "runtime" | "downloader" | "animation" | "custom" | string;
}

export interface CommandOutput {
  success: boolean;
  code: number;
  stdout: string;
  stderr: string;
  /** True when the basic ffmpeg fallback rendered this output. */
  fallback_used: boolean;
}

export interface VideoMetadata {
  file_path: string;
  duration_seconds: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  audio_channels: number;
  file_size_bytes: number;
}

export interface VideoPreset {
  id: string;
  name: string;
  aspect_ratio: string;
  width: number;
  height: number;
  fps: number;
  color_grade: string;
  subtitle_style: string;
  subtitle_case: string;
  silence_threshold_s: number;
  description: string;
}

export interface ZernioAccount {
  id: string;
  platform: string;
  name: string;
  username?: string;
  avatar?: string;
  is_connected: boolean;
}

export interface SocialPublishPayload {
  title: string;
  description: string;
  platforms: string[];
  video_path: string;
  scheduled_for?: string;
  timezone?: string;
  publish_now: boolean;
  account_ids?: string[];
  tags?: string[];
  media_url?: string;
  /** Queue entry id, sent as `Idempotency-Key` so gateway retries are safe. */
  idempotency_key?: string;
  /** Postable hashtags for captions (preferred over tags-as-hashtags). */
  hashtags?: string[];
  /** YouTube pinned first comment. */
  first_comment?: string;
  /** YouTube category id, e.g. "28" Science & Technology. */
  youtube_category?: string;
}

export interface VideoReviewReport {
  overall_summary: string;
  hook_detected: string;
  content_highlights: string[];
  retention_score: number;
  target_audience: string;
  suggested_pacing: string;
  word_count?: number;
  takes_count?: number;
  segment_count?: number;
  output_duration?: number;
  speech_wps?: number;
  transcript_source?: string;
}

export interface SeoQualityCheck {
  id: string;
  got: number;
  of: number;
}

export interface SeoMetadata {
  title: string;
  title_alternatives: string[];
  description: string;
  tags: string[];
  hashtags: string[];
  seo_score: number;
  /** Package-quality figure (0-100) from the engine scorer; additive. */
  quality_score?: number | null;
  quality_checks?: SeoQualityCheck[];
  keywords_analyzed?: string[];
  /** The 3 searches this short should win (lowercase phrases). */
  search_queries?: string[];
  /**
   * Subset of search_queries that came from outside the transcript
   * (autocomplete, trends, or the agent). Empty means the package's
   * phrases were composed from speech and must not raise the score.
   * Omitted on packages written before this field existed.
   */
  demand_queries?: string[];
  /** Suggested pinned first comment (YouTube). */
  pinned_comment?: string;
  review_report?: VideoReviewReport;
}

export interface RenderShortParams {
  input_video: string;
  output_video: string;
  preset_id: string;
  agent_id?: string;
  model_id?: string;
  subtitle_style?: string;
  subtitle_position?: "bottom" | "center" | "top" | string;
  subtitle_size?: "compact" | "standard" | "large" | string;
  subtitle_case?: "uppercase" | "title" | "sentence" | string;
  target_duration?: number;
  aspect_ratio?: string;
  cut_start?: number;
  cut_end?: number;
  prompt_hook?: string;
  elevenlabs_key?: string;
  transcription_provider?: "local" | "elevenlabs";
  channel_context?: string;
  meta_title?: string;
  meta_desc?: string;
  meta_tags?: string;
  /** auto = detect, single = face-centered crop, screen-top / face-top =
   * face + screen split, face-only = face zoom. */
  layout?: string;
  /** Always "auto": the engine detects the face itself. */
  face_roi?: string;
  edit_plan?: TranscriptEditPlan;
  edit_strategy?: "cleanup" | "highlights" | "full";
  remove_silence?: boolean;
  remove_retakes?: boolean;
}

export interface TranscriptWord { word: string; start: number; end: number }
export interface SourceTranscript {
  source_path: string;
  source_duration: number;
  words: TranscriptWord[];
  engine: string;
  suggested_segments?: { start: number; end: number }[];
  edit_method?: string;
  removals?: { start: number; end: number; reason: string; later_start?: number }[];
}
export interface TranscriptEditPlan {
  version: 1;
  source_path: string;
  source_duration: number;
  segments: { start: number; end: number }[];
  /** null asks the renderer to transcribe; [] intentionally has no captions. */
  words: TranscriptWord[] | null;
}

export interface ScheduleItem {
  id: string;
  title: string;
  video_path: string;
  platforms: string[];
  scheduled_for: string;
  timezone: string;
  status: "queued" | "publishing" | "completed" | "failed";
  created_at: string;
  post_id?: string;
  remote_status?: string;
  /** Full payload kept for re-dispatch from the queue (Post now). */
  description?: string;
  tags?: string[];
  hashtags?: string[];
  first_comment?: string;
  account_ids?: string[];
  /** Last dispatch error, shown on the row. */
  error?: string | null;
}

export type GlobalTaskStatus =
  | { type: "idle" }
  | { type: "scanning"; label: string }
  | { type: "probing"; label: string }
  | { type: "rendering"; label: string; progress?: number }
  | { type: "analyzing"; label: string }
  | { type: "publishing"; label: string };

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

/** Readiness of the selected transcription provider (see probe_transcription). */
export interface TranscriptionStatus {
  elevenlabs_key_configured: boolean;
  local_available: boolean;
  local_model: string;
  ffmpeg_available: boolean;
  active_engine: "elevenlabs" | "local" | "none";
}

export interface RenderJobInfo {
  id: string;
  kind: string;
  status: JobStatus;
  progress: number;
  stage: string;
  input_video: string;
  output_video: string;
  created_at: string;
  finished_at: string | null;
  result: CommandOutput | null;
  error: string | null;
}

export interface RenderJobProgress {
  job_id: string;
  progress: number;
  stage: string;
  line: string;
  done: boolean;
}

export interface AgentProbe {
  agent: string;
  available: boolean;
  binary: string | null;
  path: string | null;
  note: string;
}

export interface TrendingKeyword {
  term: string;
  score: number;
  sources?: number;
}

export interface TrendingVideo {
  title: string;
  channel: string;
  views?: number | null;
  views_per_hour?: number | null;
}

export interface TrendingResult {
  niche: string;
  keywords: TrendingKeyword[];
  videos: TrendingVideo[];
  /** Free YouTube autocomplete phrases for the niche. */
  queries?: string[];
  fetched_at: string | null;
  cached: boolean;
  note?: string;
  error?: string;
}
