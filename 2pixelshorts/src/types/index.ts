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
}

export interface VideoReviewReport {
  overall_summary: string;
  hook_detected: string;
  content_highlights: string[];
  retention_score: number;
  target_audience: string;
  suggested_pacing: string;
  word_count?: number;
}

export interface SeoMetadata {
  title: string;
  title_alternatives: string[];
  description: string;
  tags: string[];
  hashtags: string[];
  seo_score: number;
  keywords_analyzed?: string[];
  review_report?: VideoReviewReport;
}

export interface RenderShortParams {
  input_video: string;
  output_video: string;
  preset_id: string;
  agent_id?: string;
  subtitle_style?: string;
  subtitle_position?: "bottom" | "center" | "top" | string;
  subtitle_size?: "compact" | "standard" | "large" | string;
  subtitle_case?: "uppercase" | "title" | "sentence" | string;
  target_duration?: number;
  prompt_hook?: string;
  elevenlabs_key?: string;
  channel_context?: string;
  meta_title?: string;
  meta_desc?: string;
  meta_tags?: string;
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
}

export type GlobalTaskStatus = 
  | { type: "idle" }
  | { type: "scanning"; label: string }
  | { type: "probing"; label: string }
  | { type: "rendering"; label: string; progress?: number }
  | { type: "publishing"; label: string };

export type HeroUiThemeId = 
  | "default" 
  | "black" 
  | "sky" 
  | "lavender" 
  | "mint" 
  | "netflix" 
  | "spotify" 
  | "discord" 
  | "rabbit" 
  | "coinbase" 
  | "airbnb";

export interface HeroUiThemeConfig {
  id: HeroUiThemeId;
  name: string;
  tag: string;
  accent: string;
  background: string;
  surface: string;
  description: string;
}

export const HERO_UI_THEMES: HeroUiThemeConfig[] = [
  {
    id: "default",
    name: "HeroUI Default",
    tag: "Modern Electric",
    accent: "#006FEE",
    background: "#090b10",
    surface: "#11141c",
    description: "Official HeroUI electric blue with high-contrast obsidian slate surfaces",
  },
  {
    id: "black",
    name: "Black / Obsidian",
    tag: "Monochrome Pro",
    accent: "#FFFFFF",
    background: "#090a0d",
    surface: "#111317",
    description: "Monochrome stark white accent on deep obsidian carbon workstation",
  },
  {
    id: "sky",
    name: "Sky",
    tag: "Cyan Electric",
    accent: "#0ea5e9",
    background: "#080f18",
    surface: "#0f1c2b",
    description: "Airy, high-luminance cyan and deep oceanic navy panels",
  },
  {
    id: "lavender",
    name: "Lavender",
    tag: "Vibrant Violet",
    accent: "#a855f7",
    background: "#0f0a17",
    surface: "#181024",
    description: "Rich purple hue with deep violet contrast and soft neon aura",
  },
  {
    id: "mint",
    name: "Mint",
    tag: "Fresh Emerald",
    accent: "#10b981",
    background: "#06140f",
    surface: "#0c2119",
    description: "Crisp emerald mint accent with dark botanical undertones",
  },
  {
    id: "netflix",
    name: "Netflix",
    tag: "Cinematic Crimson",
    accent: "#e50914",
    background: "#0d0d0e",
    surface: "#161618",
    description: "High-contrast cinematic red on pitch dark charcoal panels",
  },
  {
    id: "spotify",
    name: "Spotify",
    tag: "Neon Sound",
    accent: "#1ed760",
    background: "#0b110d",
    surface: "#121c15",
    description: "Signature neon audio green on deep studio black surfaces",
  },
  {
    id: "discord",
    name: "Discord",
    tag: "Console Blurple",
    accent: "#5865f2",
    background: "#10121a",
    surface: "#1a1c26",
    description: "Iconic console indigo blurple with sleek dark slate panels",
  },
  {
    id: "coinbase",
    name: "Coinbase",
    tag: "Royal Blue",
    accent: "#0052ff",
    background: "#080c18",
    surface: "#0f1629",
    description: "Electric royal blue on crisp modern slate",
  },
  {
    id: "rabbit",
    name: "Rabbit",
    tag: "Cyber Orange",
    accent: "#ff5a00",
    background: "#130c08",
    surface: "#1f140e",
    description: "High-energy cybernetic amber orange on warm obsidian",
  },
  {
    id: "airbnb",
    name: "Airbnb",
    tag: "Coral Rose",
    accent: "#ff385c",
    background: "#14080d",
    surface: "#200f16",
    description: "Warm coral and rose quartz on velvety midnight surfaces",
  },
];

