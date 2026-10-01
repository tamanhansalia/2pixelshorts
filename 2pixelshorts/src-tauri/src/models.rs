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
    pub subtitle_style: String, // "bold_overlay", "natural_sentence", "none"
    pub subtitle_case: String, // "uppercase", "natural"
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
}

