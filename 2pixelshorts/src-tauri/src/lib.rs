pub mod cli_scanner;
pub mod models;
pub mod video_runner;

use models::{CliToolInfo, CommandOutput, SocialPublishPayload, VideoMetadata, ZernioAccount};
use serde_json::json;

#[tauri::command]
async fn scan_clis() -> Result<Vec<CliToolInfo>, String> {
    Ok(cli_scanner::scan_all_clis().await)
}

#[tauri::command]
async fn probe_custom_cli(name: String, path_or_command: String) -> Result<CliToolInfo, String> {
    Ok(cli_scanner::probe_custom_tool(name, path_or_command).await)
}

#[tauri::command]
async fn probe_video(path: String) -> Result<VideoMetadata, String> {
    video_runner::probe_video_metadata(&path).await
}

#[tauri::command]
async fn run_cli(
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<CommandOutput, String> {
    video_runner::run_cli_process(&command, &args, cwd.as_deref()).await
}

async fn fallback_ffmpeg_render(
    input_video: &str,
    output_video: &str,
    preset_id: &str,
) -> Result<CommandOutput, String> {
    let filter = match preset_id {
        "warm_cinematic" => {
            "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,eq=contrast=1.12:saturation=1.15"
        }
        "neutral_punch" => {
            "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,eq=contrast=1.06:saturation=1.05"
        }
        _ => {
            "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920"
        }
    };

    let afade_filter = "afade=t=in:st=0:d=0.03";

    let args = vec![
        "-y".to_string(),
        "-i".to_string(),
        input_video.to_string(),
        "-vf".to_string(),
        filter.to_string(),
        "-af".to_string(),
        afade_filter.to_string(),
        "-c:v".to_string(),
        "libx264".to_string(),
        "-preset".to_string(),
        "fast".to_string(),
        "-crf".to_string(),
        "20".to_string(),
        "-c:a".to_string(),
        "aac".to_string(),
        "-b:a".to_string(),
        "192k".to_string(),
        output_video.to_string(),
    ];

    video_runner::run_cli_process("ffmpeg", &args, None).await
}

#[tauri::command]
async fn render_short(
    input_video: String,
    output_video: String,
    preset_id: String,
    agent_id: Option<String>,
    subtitle_style: Option<String>,
    subtitle_position: Option<String>,
    subtitle_size: Option<String>,
    subtitle_case: Option<String>,
    target_duration: Option<f64>,
    prompt_hook: Option<String>,
    elevenlabs_key: Option<String>,
    channel_context: Option<String>,
    meta_title: Option<String>,
    meta_desc: Option<String>,
    meta_tags: Option<String>,
) -> Result<CommandOutput, String> {
    // Locate short_pipeline.py
    let script_candidates = [
        "../video-use/helpers/short_pipeline.py",
        "video-use/helpers/short_pipeline.py",
        "../../video-use/helpers/short_pipeline.py",
        "C:\\Users\\Taman\\Documents\\2pixelspace-short\\video-use\\helpers\\short_pipeline.py",
    ];

    let script_path = script_candidates
        .iter()
        .find(|p| std::path::Path::new(p).exists())
        .copied()
        .unwrap_or("C:\\Users\\Taman\\Documents\\2pixelspace-short\\video-use\\helpers\\short_pipeline.py");

    let mut args = vec![
        script_path.to_string(),
        "--input".to_string(),
        input_video.clone(),
        "--output".to_string(),
        output_video.clone(),
        "--preset".to_string(),
        preset_id.clone(),
    ];

    if let Some(agent) = agent_id {
        if !agent.trim().is_empty() {
            args.push("--agent".to_string());
            args.push(agent);
        }
    }

    if let Some(sub) = subtitle_style {
        if !sub.trim().is_empty() {
            args.push("--subtitles".to_string());
            args.push(sub);
        }
    }

    if let Some(pos) = subtitle_position {
        if !pos.trim().is_empty() {
            args.push("--subtitle-position".to_string());
            args.push(pos);
        }
    }

    if let Some(size) = subtitle_size {
        if !size.trim().is_empty() {
            args.push("--subtitle-size".to_string());
            args.push(size);
        }
    }

    if let Some(casing) = subtitle_case {
        if !casing.trim().is_empty() {
            args.push("--subtitle-case".to_string());
            args.push(casing);
        }
    }

    if let Some(dur) = target_duration {
        args.push("--duration".to_string());
        args.push(dur.to_string());
    }

    if let Some(prompt) = prompt_hook {
        if !prompt.trim().is_empty() {
            args.push("--prompt".to_string());
            args.push(prompt);
        }
    }

    if let Some(key) = elevenlabs_key {
        if !key.trim().is_empty() {
            args.push("--elevenlabs-key".to_string());
            args.push(key);
        }
    }

    if let Some(ctx) = channel_context {
        if !ctx.trim().is_empty() {
            args.push("--channel-context".to_string());
            args.push(ctx);
        }
    }

    if let Some(title) = meta_title {
        if !title.trim().is_empty() {
            args.push("--meta-title".to_string());
            args.push(title);
        }
    }

    if let Some(desc) = meta_desc {
        if !desc.trim().is_empty() {
            args.push("--meta-desc".to_string());
            args.push(desc);
        }
    }

    if let Some(tags) = meta_tags {
        if !tags.trim().is_empty() {
            args.push("--meta-tags".to_string());
            args.push(tags);
        }
    }

    // Execute Python Short Creation Pipeline
    let output = video_runner::run_cli_process("python", &args, None).await;
    match output {
        Ok(out) if out.success => Ok(out),
        Ok(out) => {
            eprintln!("short_pipeline non-zero exit (code {}): {}", out.code, out.stderr);
            fallback_ffmpeg_render(&input_video, &output_video, &preset_id).await
        }
        Err(e) => {
            eprintln!("Failed to spawn python pipeline: {}", e);
            fallback_ffmpeg_render(&input_video, &output_video, &preset_id).await
        }
    }
}

#[tauri::command]
async fn generate_seo_metadata(
    input_video: String,
    channel_context: Option<String>,
    agent_id: Option<String>,
) -> Result<String, String> {
    let script_candidates = [
        "../video-use/helpers/short_pipeline.py",
        "video-use/helpers/short_pipeline.py",
        "../../video-use/helpers/short_pipeline.py",
        "C:\\Users\\Taman\\Documents\\2pixelspace-short\\video-use\\helpers\\short_pipeline.py",
    ];

    let script_path = script_candidates
        .iter()
        .find(|p| std::path::Path::new(p).exists())
        .copied()
        .unwrap_or("C:\\Users\\Taman\\Documents\\2pixelspace-short\\video-use\\helpers\\short_pipeline.py");

    let mut args = vec![
        script_path.to_string(),
        "--input".to_string(),
        input_video,
        "--output".to_string(),
        "dummy_seo.mp4".to_string(),
        "--generate-seo-only".to_string(),
    ];

    if let Some(ctx) = channel_context {
        if !ctx.trim().is_empty() {
            args.push("--channel-context".to_string());
            args.push(ctx);
        }
    }

    if let Some(agent) = agent_id {
        if !agent.trim().is_empty() {
            args.push("--agent".to_string());
            args.push(agent);
        }
    }

    let output = video_runner::run_cli_process("python", &args, None).await;
    match output {
        Ok(out) => {
            if let Some(start) = out.stdout.find("__SEO_METADATA_START__") {
                if let Some(end) = out.stdout.find("__SEO_METADATA_END__") {
                    let json_str = out.stdout[start + "__SEO_METADATA_START__".len()..end].trim();
                    return Ok(json_str.to_string());
                }
            }
            Err(format!("Could not parse SEO metadata from output: {}", out.stdout))
        }
        Err(e) => Err(format!("Failed to run SEO generation: {}", e)),
    }
}

#[tauri::command]
async fn get_zernio_accounts(api_key: String) -> Result<Vec<ZernioAccount>, String> {
    if api_key.trim().is_empty() {
        return Ok(vec![]);
    }

    let client = reqwest::Client::new();
    let res = client
        .get("https://zernio.com/api/v1/accounts")
        .header("Authorization", format!("Bearer {}", api_key.trim()))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Network error querying Zernio: {}", e))?;

    if !res.status().is_success() {
        return Ok(vec![]);
    }

    let val: serde_json::Value = res.json().await.unwrap_or(serde_json::Value::Null);
    let mut accounts = Vec::new();

    let list_opt = if let Some(arr) = val.as_array() {
        Some(arr)
    } else if let Some(arr) = val.get("accounts").and_then(|a| a.as_array()) {
        Some(arr)
    } else if let Some(arr) = val.get("data").and_then(|d| d.as_array()) {
        Some(arr)
    } else {
        None
    };

    if let Some(list) = list_opt {
        for item in list {
            let id = item.get("_id")
                .or_else(|| item.get("id"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let platform = item.get("platform")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string();
            let name = item.get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("Channel")
                .to_string();
            let username = item.get("username")
                .or_else(|| item.get("screenName"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let avatar = item.get("avatar")
                .or_else(|| item.get("profileImageUrl"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let is_connected = item.get("isConnected")
                .or_else(|| item.get("connected"))
                .and_then(|v| v.as_bool())
                .unwrap_or(true);

            if !id.is_empty() {
                accounts.push(ZernioAccount {
                    id,
                    platform,
                    name,
                    username,
                    avatar,
                    is_connected,
                });
            }
        }
    }

    Ok(accounts)
}

#[tauri::command]
async fn get_zernio_connect_url(api_key: String, platform: String) -> Result<String, String> {
    let clean_platform = platform.to_lowercase();
    let client = reqwest::Client::new();
    let endpoint = format!("https://zernio.com/api/v1/connect/{}", clean_platform);

    if !api_key.trim().is_empty() {
        if let Ok(res) = client
            .get(&endpoint)
            .header("Authorization", format!("Bearer {}", api_key.trim()))
            .header("Accept", "application/json")
            .send()
            .await 
        {
            if res.status().is_success() {
                if let Ok(val) = res.json::<serde_json::Value>().await {
                    if let Some(url) = val.get("url").or_else(|| val.get("redirectUrl")).and_then(|u| u.as_str()) {
                        return Ok(url.to_string());
                    }
                }
            }
        }
    }

    Ok(format!("https://zernio.com/app/connect/{}", clean_platform))
}

#[tauri::command]
async fn open_external_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let _ = tokio::process::Command::new("cmd.exe")
            .args(["/C", "start", "", &url])
            .spawn();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = tokio::process::Command::new("open")
            .arg(&url)
            .spawn();
    }
    Ok(())
}

#[tauri::command]
async fn publish_to_zernio(
    api_key: String,
    payload: SocialPublishPayload,
) -> Result<String, String> {
    if api_key.trim().is_empty() {
        return Err("Zernio API key is empty. Please enter your API key in Settings.".to_string());
    }

    let client = reqwest::Client::new();

    // Map platforms to Zernio format, honoring specific account IDs if present
    let platform_objects: Vec<_> = if let Some(ref account_ids) = payload.account_ids {
        account_ids
            .iter()
            .zip(payload.platforms.iter())
            .map(|(acc_id, plat)| {
                json!({
                    "platform": plat.to_lowercase(),
                    "accountId": acc_id
                })
            })
            .collect()
    } else {
        payload
            .platforms
            .iter()
            .map(|p| {
                json!({
                    "platform": p.to_lowercase(),
                })
            })
            .collect()
    };

    let mut body = json!({
        "content": format!("{}\n\n{}", payload.title, payload.description),
        "platforms": platform_objects,
        "publishNow": payload.publish_now,
    });

    if let Some(scheduled_for) = payload.scheduled_for {
        body["scheduledFor"] = json!(scheduled_for);
    }
    if let Some(tz) = payload.timezone {
        body["timezone"] = json!(tz);
    }

    let res = client
        .post("https://zernio.com/api/v1/posts")
        .header("Authorization", format!("Bearer {}", api_key.trim()))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to connect to Zernio API: {}", e))?;

    let status = res.status();
    let text = res
        .text()
        .await
        .unwrap_or_else(|_| "Unknown response".to_string());

    if status.is_success() {
        Ok(text)
    } else {
        Err(format!("Zernio API returned status {}: {}", status, text))
    }
}

#[tauri::command]
async fn pick_video_file() -> Result<Option<String>, String> {
    #[cfg(target_os = "windows")]
    {
        let ps_script = r#"
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Filter = "Video Files (*.mp4;*.mov;*.mkv;*.avi;*.webm)|*.mp4;*.mov;*.mkv;*.avi;*.webm|All Files (*.*)|*.*"
$dialog.Title = "Select Source Video Footage"
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    Write-Output $dialog.FileName
}
"#;
        let output = tokio::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", ps_script])
            .output()
            .await
            .map_err(|e| format!("Failed to open file picker: {}", e))?;

        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if path.is_empty() {
            Ok(None)
        } else {
            Ok(Some(path))
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(None)
    }
}

#[tauri::command]
async fn open_file_location(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let clean_path = path.replace('/', "\\");
        let arg = format!("/select,{}", clean_path);
        let _ = tokio::process::Command::new("explorer.exe")
            .arg(arg)
            .spawn();
    }
    Ok(())
}

#[tauri::command]
async fn open_file(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let _ = tokio::process::Command::new("cmd.exe")
            .args(["/C", "start", "", &path])
            .spawn();
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            scan_clis,
            probe_custom_cli,
            probe_video,
            run_cli,
            render_short,
            generate_seo_metadata,
            get_zernio_accounts,
            get_zernio_connect_url,
            open_external_url,
            publish_to_zernio,
            pick_video_file,
            open_file_location,
            open_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

