//! Zernio social gateway: media upload + post dispatch.
//!
//! Video flow (per the gateway's media-upload guide + `createPost`):
//! 1. `POST /v1/media/presign` with `{filename, contentType, size}` →
//!    `{uploadUrl, publicUrl}` (uploads up to 5 GB; URL expires in 1 hour).
//! 2. `PUT` the file bytes to `uploadUrl` (storage, no Authorization header).
//! 3. `POST /v1/posts` referencing the public URL in `mediaItems`.
//!    A successful PUT is the upload contract. The public CDN often rejects
//!    HEAD, so a follow-up HEAD is not used as a gate.
//!
//! Known gateway rules honored here (see `createPost` and the platform pages):
//! - `mediaItems[].type` contradicting the URL extension is rejected with 400,
//!   so the presign/PUT content type always matches the file extension.
//! - `platforms[]` entries require `platform` + `accountId`. Per-platform
//!   settings live in `platformSpecificData` (unknown keys are rejected, so
//!   YouTube-only fields go to YouTube only). `customContent` is a sibling
//!   of that object, used when a caption exceeds a platform's limit.
//! - TikTok rejects a post that omits root `tiktokSettings` with
//!   `privacy_level`, `allow_comment`, `allow_duet`, `allow_stitch`,
//!   `content_preview_confirmed: true` and `express_consent_given: true`.
//! - `tags` is a top-level string array (YouTube: each ≤100 chars,
//!   combined ≤500 chars), NOT a field inside `platformSpecificData`.
//! - YouTube blocks distribution unless `madeForKids` is sent explicitly.
//! - Scheduling picks one of `scheduledFor` / `publishNow` / `queuedFromProfile`;
//!   `publishNow` publishes to every platform synchronously in one request
//!   (single- and multi-platform alike). A past `scheduledFor` publishes
//!   synchronously too.
//! - Retries should reuse one `Idempotency-Key` per logical post (24-hour
//!   window); identical content re-posted within 24 hours without one is
//!   rejected with 409 by the gateway's content-hash dedup.

use crate::models::SocialPublishPayload;
use reqwest::Client;
use serde_json::{json, Value};
use std::path::Path;

/// Buffered-upload ceiling. The gateway presigns files up to 5 GB, but this
/// desktop client reads the file into memory for the PUT, so larger files are
/// rejected upfront with guidance instead of risking an OOM mid-upload.
pub const MAX_DIRECT_UPLOAD_BYTES: u64 = 512 * 1024 * 1024;

/// Content type for a video file, matching the gateway's `MediaContentType`
/// enum. Returns `None` for containers the gateway does not accept (notably
/// `.mkv`), so the caller can fail with guidance instead of a 400.
/// Unknown or missing extensions fall back to `video/mp4`.
fn video_content_type(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "mkv" => None,
        "mp4" | "m4v" => Some("video/mp4"),
        "mov" => Some("video/quicktime"),
        "mpeg" | "mpg" => Some("video/mpeg"),
        "avi" => Some("video/x-msvideo"),
        "webm" => Some("video/webm"),
        _ => Some("video/mp4"),
    }
}

/// Upload a local video file through a presigned URL.
/// Returns the permanent public media URL for `mediaItems`.
pub async fn upload_media(
    client: &Client,
    api_key: &str,
    file_path: &str,
) -> Result<String, String> {
    let path = Path::new(file_path);
    if !path.is_file() {
        return Err(format!("Video file not found: {}", file_path));
    }
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    if size > MAX_DIRECT_UPLOAD_BYTES {
        return Err("Video is over 512 MB: too large for this client to upload directly. Host the file at a public HTTPS URL and publish with that media URL instead."
            .to_string());
    }
    let content_type = video_content_type(path).ok_or_else(|| {
        "Unsupported video container: the Zernio gateway only accepts mp4, mov, mpeg, avi, or webm. Convert (e.g. .mkv → .mp4) and try again.".to_string()
    })?;
    let filename = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("video.mp4")
        .to_string();

    let res = client
        .post("https://zernio.com/api/v1/media/presign")
        .header("Authorization", format!("Bearer {}", api_key.trim()))
        .header("Content-Type", "application/json")
        .json(&json!({"filename": filename, "contentType": content_type, "size": size}))
        .send()
        .await
        .map_err(|e| format!("Failed to reach Zernio presign: {}", e))?;
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("Zernio presign returned status {}: {}", status, text));
    }
    let val: Value = serde_json::from_str(&text)
        .map_err(|_| format!("Zernio presign returned invalid JSON: {}", text))?;
    let upload_url = json_string(&val, "uploadUrl")
        .ok_or_else(|| "Zernio presign response missing uploadUrl".to_string())?;
    let public_url = json_string(&val, "publicUrl")
        .ok_or_else(|| "Zernio presign response missing publicUrl".to_string())?;

    let bytes =
        std::fs::read(path).map_err(|e| format!("Failed to read video file: {}", e))?;
    let put = client
        .put(upload_url)
        .header("Content-Type", content_type)
        .body(bytes)
        .send()
        .await
        .map_err(|e| format!("Failed to upload video bytes: {}", e))?;
    if !put.status().is_success() {
        let code = put.status();
        let body = put.text().await.unwrap_or_default();
        return Err(format!("Video upload returned status {}: {}", code, body));
    }

    // PUT 200 is the storage contract. Do not HEAD the public URL: the CDN
    // (media.zernio.com) often answers 403/405 to HEAD while GET works, and
    // that false failure used to abort dispatch before POST /posts.
    Ok(public_url)
}

/// String field at the root or under a `data` envelope.
fn json_string(val: &Value, key: &str) -> Option<String> {
    val.get(key)
        .and_then(|v| v.as_str())
        .or_else(|| {
            val.get("data")
                .and_then(|d| d.get(key))
                .and_then(|v| v.as_str())
        })
        .map(|s| s.to_string())
}

/// Clean tags to the gateway's top-level `tags` shape: trimmed, `#`-stripped,
/// deduped (case-insensitive), each ≤100 chars, combined ≤500 chars.
fn clean_tags(tags: Option<&Vec<String>>) -> Option<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut total = 0usize;
    for raw in tags.map(|t| t.as_slice()).unwrap_or(&[]) {
        let tag: String = raw.trim().trim_start_matches('#').trim().chars().take(100).collect();
        if tag.is_empty() {
            continue;
        }
        let key = tag.to_lowercase();
        if !seen.insert(key) {
            continue;
        }
        // Combined cap: stop before exceeding 500 chars (gateway constraint).
        let add = if out.is_empty() { tag.len() } else { tag.len() + 1 };
        if total + add > 500 {
            break;
        }
        total += add;
        out.push(tag);
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// Gateway platform slug. The accounts list sometimes reports X as `x`.
fn canonical_platform(platform: &str) -> String {
    match platform.trim().to_ascii_lowercase().as_str() {
        "x" => "twitter".to_string(),
        other => other.to_string(),
    }
}

/// Caption cap per platform. X's free accounts hard-fail above 280 (URLs and
/// some emoji count extra), so the X copy stays under 270.
fn caption_limit(platform: &str) -> usize {
    match platform {
        "twitter" => 270,
        "instagram" | "tiktok" => 2200,
        "linkedin" => 3000,
        _ => 5000,
    }
}

fn clip_chars(text: &str, max_chars: usize) -> String {
    text.trim()
        .chars()
        .take(max_chars)
        .collect::<String>()
        .trim()
        .to_string()
}

fn hashtag_token(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .trim()
        .trim_start_matches('#')
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    if cleaned.is_empty() {
        None
    } else {
        Some(format!("#{cleaned}"))
    }
}

/// Title, description, then hashtags that still fit `max_chars`.
/// A caption that does not fit falls back to the title when the title itself
/// fits, so a long YouTube description does not blow X's 280-character cap.
fn compose_caption(
    title: &str,
    description: &str,
    tags: Option<&Vec<String>>,
    max_chars: usize,
) -> String {
    let title = title.trim();
    let description = description.trim();
    let full = if title.is_empty() {
        description.to_string()
    } else if description.is_empty() || description.eq_ignore_ascii_case(title) {
        title.to_string()
    } else {
        format!("{title}\n\n{description}")
    };
    let mut body = if full.chars().count() <= max_chars {
        full
    } else if !title.is_empty() && title.chars().count() <= max_chars {
        title.to_string()
    } else {
        return clip_chars(&full, max_chars);
    };

    let mut seen = std::collections::HashSet::new();
    let lower_body = body.to_lowercase();
    for raw in tags.map(|t| t.as_slice()).unwrap_or(&[]) {
        let Some(tag) = hashtag_token(raw) else {
            continue;
        };
        let key = tag.to_lowercase();
        if !seen.insert(key.clone()) || lower_body.contains(&key) {
            continue;
        }
        let addition = if body.is_empty() {
            tag.clone()
        } else if body.contains('\n') {
            format!(" {tag}")
        } else {
            format!("\n\n{tag}")
        };
        // Once a hashtag block has started, further tags join the same line.
        let addition = if body.lines().last().is_some_and(|l| l.contains('#')) {
            format!(" {tag}")
        } else {
            addition
        };
        if body.chars().count() + addition.chars().count() > max_chars {
            break;
        }
        body.push_str(&addition);
    }
    body
}

/// TikTok rejects the whole create-post call when these are missing.
/// Consent flags are always true: the user confirmed by pressing Publish.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TikTokPostSettings {
    pub privacy_level: String,
    pub allow_comment: bool,
    pub allow_duet: bool,
    pub allow_stitch: bool,
}

impl Default for TikTokPostSettings {
    fn default() -> Self {
        Self {
            privacy_level: "PUBLIC_TO_EVERYONE".to_string(),
            allow_comment: true,
            allow_duet: true,
            allow_stitch: true,
        }
    }
}

impl TikTokPostSettings {
    fn to_json(&self) -> Value {
        json!({
            "privacy_level": self.privacy_level,
            "allow_comment": self.allow_comment,
            "allow_duet": self.allow_duet,
            "allow_stitch": self.allow_stitch,
            "content_preview_confirmed": true,
            "express_consent_given": true,
        })
    }
}

fn interaction_flag(node: Option<&Value>, fallback: bool) -> bool {
    let Some(node) = node else {
        return fallback;
    };
    if let Some(value) = node.as_bool() {
        return value;
    }
    if node.get("enabled").and_then(|v| v.as_bool()) == Some(false) {
        return false;
    }
    node.get("default")
        .and_then(|v| v.as_bool())
        .unwrap_or(fallback)
}

/// Read `GET /accounts/{id}/tiktok/creator-info`. Unknown shapes keep the
/// public-post defaults so a flaky creator-info call cannot block dispatch.
pub fn tiktok_settings_from_creator_info(val: &Value) -> TikTokPostSettings {
    let root = val.get("data").unwrap_or(val);
    let mut settings = TikTokPostSettings::default();
    if let Some(levels) = root.get("privacyLevels").and_then(|v| v.as_array()) {
        let values: Vec<String> = levels
            .iter()
            .filter_map(|item| {
                item.as_str()
                    .map(|s| s.to_string())
                    .or_else(|| item.get("value").and_then(|v| v.as_str()).map(|s| s.to_string()))
            })
            .filter(|s| !s.is_empty())
            .collect();
        if !values.is_empty() {
            settings.privacy_level = if values.iter().any(|v| v == "PUBLIC_TO_EVERYONE") {
                "PUBLIC_TO_EVERYONE".to_string()
            } else {
                values[0].clone()
            };
        }
    }
    if let Some(interactions) = root
        .get("postingLimits")
        .and_then(|p| p.get("interactionSettings"))
    {
        settings.allow_comment = interaction_flag(interactions.get("allow_comment"), true);
        settings.allow_duet = interaction_flag(interactions.get("allow_duet"), true);
        settings.allow_stitch = interaction_flag(interactions.get("allow_stitch"), true);
    }
    settings
}

/// Best-effort creator-info lookup. Network or parse failures keep defaults.
pub async fn resolve_tiktok_settings(
    client: &Client,
    api_key: &str,
    account_id: Option<&str>,
) -> TikTokPostSettings {
    let Some(account_id) = account_id.map(str::trim).filter(|id| !id.is_empty()) else {
        return TikTokPostSettings::default();
    };
    let url = format!(
        "https://zernio.com/api/v1/accounts/{}/tiktok/creator-info?mediaType=video",
        account_id
    );
    let Ok(res) = client
        .get(url)
        .header("Authorization", format!("Bearer {}", api_key.trim()))
        .header("Accept", "application/json")
        .send()
        .await
    else {
        return TikTokPostSettings::default();
    };
    if !res.status().is_success() {
        return TikTokPostSettings::default();
    }
    let Ok(val) = res.json::<Value>().await else {
        return TikTokPostSettings::default();
    };
    tiktok_settings_from_creator_info(&val)
}

pub fn apply_tiktok_settings(body: &mut Value, settings: &TikTokPostSettings) {
    let targets_tiktok = body
        .get("platforms")
        .and_then(|p| p.as_array())
        .is_some_and(|list| {
            list.iter().any(|entry| entry.get("platform").and_then(|p| p.as_str()) == Some("tiktok"))
        });
    if targets_tiktok {
        body["tiktokSettings"] = settings.to_json();
    }
}

/// Per-platform target. YouTube gets title/visibility/madeForKids only.
/// Other schemas reject unknown keys, so they get no `platformSpecificData`.
/// `customContent` is set only when this platform's caption differs from the
/// shared post `content` (shorter X / Instagram / TikTok / LinkedIn copies).
fn platform_entry(
    platform: &str,
    account_id: Option<&str>,
    caption: &str,
    root_content: &str,
    title: &str,
) -> Value {
    let mut entry = json!({ "platform": platform });
    if let Some(acc_id) = account_id.map(str::trim).filter(|id| !id.is_empty()) {
        entry["accountId"] = json!(acc_id);
    }
    if caption != root_content && !caption.is_empty() {
        entry["customContent"] = json!(caption);
    }
    if platform == "youtube" {
        let clipped = clip_chars(title, 100);
        if !clipped.is_empty() {
            entry["platformSpecificData"] = json!({
                "title": clipped,
                "visibility": "public",
                "madeForKids": false,
            });
        }
    }
    entry
}

/// Build the `POST /posts` body. Pure function over an explicit clock so
/// the scheduling rule is unit-testable.
///
/// - `mediaItems` carries the uploaded video URL (`type` must not contradict
///   the URL extension, so video uploads always say `"video"`).
/// - `platforms[]` entries pair each platform with its account id by position;
///   a missing account id omits the field so the gateway names the platform
///   in its 400 instead of silently dropping the target.
/// - `tags` is a top-level string array (gateway requirement). Hashtags from
///   those tags are also written into the caption, because the `hashtags`
///   field is stored and never appended by the gateway.
/// - An explicit `scheduled_for` always wins; otherwise `publish_now` sends
///   `publishNow`, which publishes to every platform synchronously in one
///   request (single- and multi-platform alike, per the gateway docs).
/// - TikTok targets always carry root `tiktokSettings` (public defaults).
///   `publish_to_zernio` overwrites them with creator-info when that call works.
pub fn build_post_body(
    payload: &SocialPublishPayload,
    media_url: &str,
    _now_utc: chrono::DateTime<chrono::Utc>,
) -> Value {
    let root_content = compose_caption(
        &payload.title,
        &payload.description,
        payload.tags.as_ref(),
        5000,
    );
    let platform_objects: Vec<Value> = payload
        .platforms
        .iter()
        .enumerate()
        .map(|(i, plat)| {
            let platform = canonical_platform(plat);
            let acc_id = payload
                .account_ids
                .as_ref()
                .and_then(|ids| ids.get(i))
                .map(|s| s.as_str());
            let caption = compose_caption(
                &payload.title,
                &payload.description,
                payload.tags.as_ref(),
                caption_limit(&platform),
            );
            platform_entry(&platform, acc_id, &caption, &root_content, &payload.title)
        })
        .collect();

    let mut body = json!({
        "content": root_content,
        "platforms": platform_objects,
        "mediaItems": [{"url": media_url, "type": "video"}],
    });
    let youtube_title = clip_chars(&payload.title, 100);
    if !youtube_title.is_empty() {
        body["title"] = json!(youtube_title);
    }
    if let Some(tags) = clean_tags(payload.tags.as_ref()) {
        body["tags"] = json!(tags);
    }
    apply_tiktok_settings(&mut body, &TikTokPostSettings::default());

    if let Some(scheduled_for) = payload.scheduled_for.as_deref() {
        body["scheduledFor"] = json!(scheduled_for);
        if let Some(tz) = payload.timezone.as_deref() {
            body["timezone"] = json!(tz);
        }
    } else {
        // No explicit schedule: dispatch immediately. (A payload with neither
        // schedule nor publish_now would otherwise be saved as a draft the
        // user never asked for.)
        body["publishNow"] = json!(true);
        if let Some(tz) = payload.timezone.as_deref() {
            body["timezone"] = json!(tz);
        }
    }
    body
}

/// The post object inside a `createPost` response (`{post}` or `{data.post}`
/// envelopes). Callers read `status` and per-platform detail from it.
fn response_post(text: &str) -> Option<Value> {
    let val: Value = serde_json::from_str(text).ok()?;
    if val.get("post").is_some() {
        return val.get("post").cloned();
    }
    if let Some(post) = val.get("data").and_then(|d| d.get("post")) {
        return Some(post.clone());
    }
    None
}

/// Error detail when the gateway reports the post failed on every platform
/// (`post.status == "failed"` in a 201 or 207 body). Returns `None` for any
/// other outcome — including `partial` and `scheduled`, which still name a
/// saved, syncable post. A 207 is a 2xx, so callers must check the body, not
/// just the status code.
pub fn post_failure_error(text: &str) -> Option<String> {
    let post = response_post(text)?;
    if post.get("status").and_then(|s| s.as_str()) != Some("failed") {
        return None;
    }
    let mut details: Vec<String> = Vec::new();
    if let Some(platforms) = post.get("platforms").and_then(|p| p.as_array()) {
        for entry in platforms {
            if entry.get("status").and_then(|s| s.as_str()) != Some("failed") {
                continue;
            }
            let name = entry
                .get("platform")
                .and_then(|p| p.as_str())
                .unwrap_or("platform");
            let reason = entry
                .get("errorMessage")
                .and_then(|e| e.as_str())
                .unwrap_or("no detail from gateway");
            details.push(format!("{}: {}", name, reason));
        }
    }
    if details.is_empty() {
        Some("Zernio could not publish the post and gave no per-platform detail.".to_string())
    } else {
        Some(format!(
            "Zernio could not publish the post: {}",
            details.join(" | ")
        ))
    }
}

/// Human-readable gateway error. Prefers the JSON `error` field (and `param`)
/// over the raw body, and names the 24-hour duplicate rule on 409.
pub fn format_api_error(status: u16, text: &str) -> String {
    let parsed = serde_json::from_str::<Value>(text).ok();
    let detail = parsed.as_ref().and_then(|val| {
        let msg = val.get("error").and_then(|e| e.as_str()).unwrap_or("").trim();
        if msg.is_empty() {
            return None;
        }
        let param = val.get("param").and_then(|p| p.as_str()).unwrap_or("").trim();
        if param.is_empty() {
            Some(msg.to_string())
        } else {
            Some(format!("{msg} ({param})"))
        }
    });
    let detail = detail.unwrap_or_else(|| {
        let trimmed = text.trim();
        trimmed.chars().take(500).collect()
    });
    if status == 409 {
        format!(
            "Zernio API returned status 409: {detail}. This usually means identical content was already posted to the same account within 24 hours — change the caption or media, or check the Queue for the original post."
        )
    } else {
        format!("Zernio API returned status {status}: {detail}")
    }
}

/// The post status in a `createPost` response body, if any.
pub fn post_status(text: &str) -> Option<String> {
    response_post(text)?
        .get("status")
        .and_then(|s| s.as_str())
        .map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn payload() -> SocialPublishPayload {
        SocialPublishPayload {
            title: "Title".to_string(),
            description: "Desc".to_string(),
            platforms: vec!["youtube".to_string()],
            video_path: "v.mp4".to_string(),
            scheduled_for: None,
            timezone: Some("UTC".to_string()),
            publish_now: true,
            account_ids: Some(vec!["acc1".to_string()]),
            tags: Some(vec!["rust".to_string(), " shorts ".to_string()]),
            media_url: None,
            idempotency_key: None,
        }
    }

    fn fixed_now() -> chrono::DateTime<chrono::Utc> {
        chrono::Utc.with_ymd_and_hms(2026, 1, 1, 12, 0, 0).unwrap()
    }

    #[test]
    fn single_platform_now_uses_publish_now() {
        let body = build_post_body(&payload(), "https://cdn/x.mp4", fixed_now());
        assert_eq!(body["publishNow"], json!(true));
        assert!(body.get("scheduledFor").is_none());
        assert_eq!(body["mediaItems"][0]["url"], json!("https://cdn/x.mp4"));
        assert_eq!(body["mediaItems"][0]["type"], json!("video"));
    }

    #[test]
    fn youtube_data_carries_title_and_tags_go_top_level() {
        let body = build_post_body(&payload(), "https://cdn/x.mp4", fixed_now());
        let data = &body["platforms"][0]["platformSpecificData"];
        assert_eq!(data["title"], json!("Title"));
        assert_eq!(data["visibility"], json!("public"));
        assert_eq!(data["madeForKids"], json!(false));
        assert_eq!(body["tags"], json!(["rust", "shorts"]));
        assert_eq!(body["platforms"][0]["accountId"], json!("acc1"));
    }

    #[test]
    fn non_youtube_targets_carry_no_extra_data() {
        // Other platform schemas reject unknown keys, so TikTok/Instagram
        // entries must not inherit YouTube-only fields (regression: every
        // platform got title/visibility/tags and the gateway 400'd).
        let mut p = payload();
        p.platforms = vec!["tiktok".to_string(), "instagram".to_string()];
        p.account_ids = Some(vec!["a1".to_string(), "a2".to_string()]);
        let body = build_post_body(&p, "https://cdn/x.mp4", fixed_now());
        for entry in body["platforms"].as_array().unwrap() {
            assert!(
                entry.get("platformSpecificData").is_none(),
                "unexpected platformSpecificData on {}",
                entry["platform"]
            );
        }
        assert_eq!(body["tags"], json!(["rust", "shorts"]));
        let tiktok = &body["tiktokSettings"];
        assert_eq!(tiktok["privacy_level"], json!("PUBLIC_TO_EVERYONE"));
        assert_eq!(tiktok["allow_comment"], json!(true));
        assert_eq!(tiktok["allow_duet"], json!(true));
        assert_eq!(tiktok["allow_stitch"], json!(true));
        assert_eq!(tiktok["content_preview_confirmed"], json!(true));
        assert_eq!(tiktok["express_consent_given"], json!(true));
        assert!(body["platforms"][0].get("platformSpecificData").is_none());
    }

    #[test]
    fn mismatched_account_ids_never_drop_platforms() {
        // A short account list must not silently drop targets (regression:
        // zip truncation posted to a subset of the chosen platforms).
        let mut p = payload();
        p.platforms = vec!["youtube".to_string(), "tiktok".to_string()];
        p.account_ids = Some(vec!["a1".to_string()]);
        let body = build_post_body(&p, "https://cdn/x.mp4", fixed_now());
        let platforms = body["platforms"].as_array().unwrap();
        assert_eq!(platforms.len(), 2);
        assert_eq!(platforms[0]["accountId"], json!("a1"));
        assert!(platforms[1].get("accountId").is_none());
    }

    #[test]
    fn multi_platform_now_publishes_immediately() {
        // publishNow works for every platform synchronously in one request
        // (gateway docs + official SDK multi-platform example).
        let mut p = payload();
        p.platforms = vec!["youtube".to_string(), "tiktok".to_string()];
        p.account_ids = Some(vec!["a1".to_string(), "a2".to_string()]);
        let body = build_post_body(&p, "https://cdn/x.mp4", fixed_now());
        assert_eq!(body["publishNow"], json!(true));
        assert!(body.get("scheduledFor").is_none());
        assert_eq!(
            body["tiktokSettings"]["content_preview_confirmed"],
            json!(true)
        );
    }

    #[test]
    fn long_caption_is_shortened_for_x_and_x_alias_is_twitter() {
        let mut p = payload();
        p.platforms = vec!["x".to_string(), "youtube".to_string()];
        p.description = "d".repeat(400);
        p.account_ids = Some(vec!["a1".to_string(), "a2".to_string()]);
        let body = build_post_body(&p, "https://cdn/x.mp4", fixed_now());
        assert_eq!(body["platforms"][0]["platform"], json!("twitter"));
        let custom = body["platforms"][0]["customContent"].as_str().unwrap();
        assert!(custom.chars().count() <= 270, "{}", custom);
        assert!(body["platforms"][1].get("customContent").is_none());
        assert!(body["content"].as_str().unwrap().chars().count() > 270);
    }

    #[test]
    fn creator_info_respects_disabled_interactions() {
        let val = json!({
            "privacyLevels": [
                {"value": "SELF_ONLY", "label": "Only me"},
                {"value": "PUBLIC_TO_EVERYONE", "label": "Public"}
            ],
            "postingLimits": {
                "interactionSettings": {
                    "allow_comment": {"enabled": true, "default": false},
                    "allow_duet": {"enabled": false, "default": true},
                    "allow_stitch": {"enabled": true, "default": true}
                }
            }
        });
        let settings = tiktok_settings_from_creator_info(&val);
        assert_eq!(settings.privacy_level, "PUBLIC_TO_EVERYONE");
        assert!(!settings.allow_comment);
        assert!(!settings.allow_duet);
        assert!(settings.allow_stitch);
    }

    #[test]
    fn api_error_prefers_the_json_message() {
        let text = json!({"error": "Missing tiktok consent", "param": "tiktokSettings"}).to_string();
        let msg = format_api_error(400, &text);
        assert!(msg.contains("Missing tiktok consent"), "{}", msg);
        assert!(msg.contains("tiktokSettings"), "{}", msg);
        assert!(msg.contains("400"), "{}", msg);
    }

    #[test]
    fn explicit_schedule_always_wins() {
        let mut p = payload();
        p.publish_now = false;
        p.scheduled_for = Some("2026-02-02T18:00:00".to_string());
        let body = build_post_body(&p, "https://cdn/x.mp4", fixed_now());
        assert_eq!(body["scheduledFor"], json!("2026-02-02T18:00:00"));
        assert!(body.get("publishNow").is_none());
    }

    /// Live negative test (ignored by default): a bogus key must fail
    /// cleanly at presign with a readable error. Run explicitly with
    /// `cargo test -- --ignored`. Makes no persistent changes server-side.
    #[tokio::test]
    #[ignore]
    async fn presign_rejects_bogus_key_cleanly() {
        let dir = std::env::temp_dir().join(format!(
            "zernio_neg_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let tiny = dir.join("tiny.mp4");
        std::fs::write(&tiny, vec![0u8; 1024]).unwrap();

        let client = Client::new();
        let err = upload_media(&client, "zr_bogus_key_for_negative_test", &tiny.to_string_lossy())
            .await
            .expect_err("bogus key must not upload");
        assert!(
            err.contains("presign"),
            "error should name the presign step: {}",
            err
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn empty_tags_omit_the_field() {
        let mut p = payload();
        p.tags = Some(vec!["  ".to_string()]);
        let body = build_post_body(&p, "https://cdn/x.mp4", fixed_now());
        assert!(body.get("tags").is_none());
    }

    #[test]
    fn tags_are_cleaned_deduped_and_capped() {
        let mut p = payload();
        p.tags = Some(vec![
            "  #Rust ".to_string(),
            "rust".to_string(),
            "RUST".to_string(),
            "   ".to_string(),
            "shorts".to_string(),
        ]);
        let body = build_post_body(&p, "https://cdn/x.mp4", fixed_now());
        assert_eq!(body["tags"], json!(["Rust", "shorts"]));
    }

    #[test]
    fn youtube_title_is_clipped_to_100_chars() {
        let mut p = payload();
        p.title = "x".repeat(150);
        let body = build_post_body(&p, "https://cdn/x.mp4", fixed_now());
        let title = body["platforms"][0]["platformSpecificData"]["title"]
            .as_str()
            .unwrap();
        assert_eq!(title.chars().count(), 100);
    }

    #[test]
    fn failed_post_body_reports_platform_errors() {
        let text = json!({
            "post": {
                "_id": "abc",
                "status": "failed",
                "platforms": [
                    {"platform": "youtube", "status": "failed", "errorMessage": "Token expired"},
                    {"platform": "tiktok", "status": "published"},
                ],
            },
            "message": "Post created but publishing failed",
        })
        .to_string();
        let err = post_failure_error(&text).expect("failed post must error");
        assert!(err.contains("youtube"), "{}", err);
        assert!(err.contains("Token expired"), "{}", err);
        assert_eq!(post_status(&text).as_deref(), Some("failed"));
    }

    #[test]
    fn partial_and_scheduled_posts_are_not_failures() {
        for status in ["partial", "scheduled", "publishing", "published"] {
            let text = json!({ "post": { "_id": "abc", "status": status } }).to_string();
            assert_eq!(post_failure_error(&text), None, "status {}", status);
            assert_eq!(post_status(&text).as_deref(), Some(status));
        }
        // SDK-style data envelope.
        let text =
            json!({ "data": { "post": { "_id": "abc", "status": "published" } } })
                .to_string();
        assert_eq!(post_failure_error(&text), None);
        assert_eq!(post_status(&text).as_deref(), Some("published"));
    }
}
