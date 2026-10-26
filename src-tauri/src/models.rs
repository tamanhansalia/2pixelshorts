use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CliToolInfo {
    pub id: String,
    pub name: String,
    pub command: String,
    pub path: Option<String>,
    pub version: Option<String>,
    pub is_available: bool,
    pub is_enabled: bool,
    pub description: String,
    pub category: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandOutput {
    pub success: bool,
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
    /// Legacy stored results may describe a direct-ffmpeg fallback.
    /// New jobs report pipeline failures instead of exporting the whole source.
    #[serde(default)]
    pub fallback_used: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoMetadata {
    pub file_path: String,
    pub duration_seconds: f64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub codec: String,
    pub audio_channels: u32,
    pub file_size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoPreset {
    pub id: String,
    pub name: String,
    pub aspect_ratio: String, // "9:16" (Shorts), "16:9", "1:1"
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub color_grade: String, // "warm_cinematic", "neutral_punch", "none"
    pub subtitle_style: String, // caption theme id (pop, boxed, ...) or "none"
    pub subtitle_case: String, // "uppercase", "title", "sentence"
    pub silence_threshold_s: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZernioAccount {
    pub id: String,
    pub platform: String,
    pub name: String,
    pub username: Option<String>,
    pub avatar: Option<String>,
    pub is_connected: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobInfo {
    pub id: String,
    pub kind: String,
    pub status: JobStatus,
    pub progress: f32,
    pub stage: String,
    pub input_video: String,
    pub output_video: String,
    pub created_at: String,
    pub finished_at: Option<String>,
    pub result: Option<CommandOutput>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobProgressEvent {
    pub job_id: String,
    pub progress: f32,
    pub stage: String,
    pub line: String,
    pub done: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SocialPublishPayload {
    pub title: String,
    pub description: String,
    pub platforms: Vec<String>, // "youtube", "tiktok", "instagram", "twitter"
    pub video_path: String,
    pub scheduled_for: Option<String>, // ISO 8601 string
    pub timezone: Option<String>,
    pub publish_now: bool,
    pub account_ids: Option<Vec<String>>,
    pub tags: Option<Vec<String>>,
    pub media_url: Option<String>, // public video URL: skips the upload step
    /// Queue entry id, sent as `Idempotency-Key` so gateway retries are safe.
    #[serde(default)]
    pub idempotency_key: Option<String>,
    /// Postable hashtags for captions (preferred over tags-as-hashtags).
    #[serde(default)]
    pub hashtags: Option<Vec<String>>,
    /// YouTube pinned first comment (engagement prompt).
    #[serde(default)]
    pub first_comment: Option<String>,
    /// YouTube category id, e.g. "28" Science & Technology.
    #[serde(default)]
    pub youtube_category: Option<String>,
}

