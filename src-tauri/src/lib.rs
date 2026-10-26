pub mod cli_scanner;
pub mod credentials;
pub mod jobs;
pub mod models;
pub mod storage;
pub mod video_runner;
pub mod transcription;
pub mod zernio;

use jobs::RenderRequest;
use models::{
    CliToolInfo, CommandOutput, JobInfo, JobStatus, SocialPublishPayload, VideoMetadata,
    ZernioAccount,
};
use tauri::Manager;

#[tauri::command]
async fn get_api_keys(app: tauri::AppHandle) -> Result<std::collections::BTreeMap<String, String>, String> {
    let service = app.config().identifier.clone();
    tokio::task::spawn_blocking(move || credentials::read(&service)).await.map_err(|_| "Credential worker failed".to_string())?
}

#[tauri::command]
async fn set_api_key(app: tauri::AppHandle, provider: String, value: String) -> Result<(), String> {
    let service = app.config().identifier.clone();
    tokio::task::spawn_blocking(move || credentials::write(&service, &provider, &value)).await.map_err(|_| "Credential worker failed".to_string())?
}

#[tauri::command]
async fn clear_api_keys(app: tauri::AppHandle) -> Result<(), String> {
    let service = app.config().identifier.clone();
    tokio::task::spawn_blocking(move || credentials::clear(&service)).await.map_err(|_| "Credential worker failed".to_string())?
}

/// Read-only authentication checks. Never return response bodies or URLs
/// containing credentials to the WebView/logs.
#[tauri::command]
async fn validate_api_key(provider: String, api_key: String) -> Result<(), String> {
    if api_key.trim().is_empty() { return Err("Enter an API key before testing".into()); }
    let client = gateway_client()?;
    let request = match provider.as_str() {
        "zernio" => client.get("https://zernio.com/api/v1/accounts").bearer_auth(api_key.trim()),
        "elevenlabs" => client.get("https://api.elevenlabs.io/v1/user").header("xi-api-key", api_key.trim()),
        "youtube" => client.get("https://www.googleapis.com/youtube/v3/i18nRegions").query(&[("part", "snippet"), ("key", api_key.trim())]),
        _ => return Err("Unknown credential provider".into()),
    };
    let response = request.send().await.map_err(|_| "Could not reach the service. Check your connection and retry.".to_string())?;
    let status = response.status();
    if status.is_success() { return Ok(()); }
    if provider == "elevenlabs" && (status.as_u16() == 401 || status.as_u16() == 403) {
        let detail = response.json::<serde_json::Value>().await.unwrap_or_default();
        if detail["detail"]["status"].as_str() == Some("missing_permissions") {
            return Err("This read-only key test requires User:Read permission. A Speech-to-Text-only key can still be saved and used with Scribe; this test does not consume transcription credits.".into());
        }
    }
    Err(format!("Service rejected the authentication check (HTTP {}). Check the key and its API permissions.", status.as_u16()))
}

#[tauri::command]
async fn scan_clis() -> Result<Vec<CliToolInfo>, String> {
    Ok(cli_scanner::scan_all_clis().await)
}

#[tauri::command]
async fn probe_custom_cli(name: String, path_or_command: String) -> Result<CliToolInfo, String> {
    Ok(cli_scanner::probe_custom_tool(name, path_or_command).await)
}

#[tauri::command]
async fn probe_video(app: tauri::AppHandle, path: String) -> Result<VideoMetadata, String> {
    let metadata = video_runner::probe_video_metadata(&path).await?;
    app.asset_protocol_scope().allow_file(&path).map_err(|e| e.to_string())?;
    Ok(metadata)
}

#[tauri::command]
async fn read_source_transcript(input_video: String, elevenlabs_key: Option<String>, transcription_provider: Option<String>,
    prepare: Option<bool>, agent_id: Option<String>, target_duration: Option<f64>,
    prompt_hook: Option<String>, channel_context: Option<String>) -> Result<serde_json::Value, String> {
    let script = jobs::resolve_helper_script("transcript_edit.py");
    let mut args = vec![script, "--input".into(), input_video];
    if prepare == Some(true) { args.push("--prepare".into()); }
    for (flag, value) in [("--agent", agent_id), ("--prompt", prompt_hook), ("--channel-context", channel_context)] {
        if let Some(value) = value.filter(|v| !v.trim().is_empty()) { args.extend([flag.into(), value]); }
    }
    if let Some(duration) = target_duration {
        if !duration.is_finite() || duration <= 0. { return Err("Target duration must be positive".into()); }
        args.extend(["--duration".into(), duration.to_string()]);
    }
    args.extend(transcription::helper_args(transcription_provider.as_deref(), elevenlabs_key.as_deref(), true)?);
    let out = video_runner::run_helper_process(&jobs::resolve_python(), &args, None).await?;
    if !out.success {
        return Err(out.stderr.lines().rev().find(|line| line.starts_with("Transcript:"))
            .unwrap_or("Could not read transcript. Check transcription in Settings.").to_string());
    }
    let json = out.stdout.split("__TRANSCRIPT_START__").nth(1)
        .and_then(|s| s.split("__TRANSCRIPT_END__").next())
        .ok_or("Transcript worker returned no transcript")?;
    serde_json::from_str(json.trim()).map_err(|e| format!("Invalid transcript: {}", e))
}

#[tauri::command]
async fn run_cli(
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<CommandOutput, String> {
    video_runner::run_cli_process(&command, &args, cwd.as_deref()).await
}

#[tauri::command]
async fn render_short(
    input_video: String,
    output_video: String,
    preset_id: String,
    agent_id: Option<String>,
    model_id: Option<String>,
    subtitle_style: Option<String>,
    subtitle_position: Option<String>,
    subtitle_size: Option<String>,
    subtitle_case: Option<String>,
    target_duration: Option<f64>,
    cut_start: Option<f64>,
    cut_end: Option<f64>,
    prompt_hook: Option<String>,
    elevenlabs_key: Option<String>,
    transcription_provider: Option<String>,
    channel_context: Option<String>,
    meta_title: Option<String>,
    meta_desc: Option<String>,
    meta_tags: Option<String>,
    aspect_ratio: Option<String>,
    layout: Option<String>,
    face_roi: Option<String>,
    edit_plan: Option<serde_json::Value>,
    edit_strategy: Option<String>,
    remove_silence: Option<bool>,
    remove_retakes: Option<bool>,
) -> Result<CommandOutput, String> {
    let req = RenderRequest {
        input_video: input_video.clone(),
        output_video: output_video.clone(),
        preset_id: preset_id.clone(),
        cut_start,
        cut_end,
        agent_id,
        model_id,
        subtitle_style,
        subtitle_position,
        subtitle_size,
        subtitle_case,
        target_duration,
        prompt_hook,
        elevenlabs_key,
        transcription_provider,
        channel_context,
        meta_title,
        meta_desc,
        meta_tags,
        aspect_ratio,
        layout,
        face_roi,
        edit_plan,
        edit_strategy,
        remove_silence,
        remove_retakes,
    };
    req.validate()?;
    let script_path = jobs::resolve_pipeline_script();
    let (args, _plan_file) = req.prepare_pipeline_args(&script_path)?;

    // Execute Python Short Creation Pipeline
    let python = jobs::resolve_python();
    // A failed edit must fail visibly. Re-rendering the whole stream here
    // discarded the selected cuts and face framing while reporting success.
    video_runner::run_helper_process(&python, &args, None).await
}

/// Background job version of `render_short`: returns a job id immediately,
/// streams `render-progress` events, and finishes with `render-finished`.
#[tauri::command]
async fn start_render_job(
    app: tauri::AppHandle,
    input_video: String,
    output_video: String,
    preset_id: String,
    agent_id: Option<String>,
    model_id: Option<String>,
    subtitle_style: Option<String>,
    subtitle_position: Option<String>,
    subtitle_size: Option<String>,
    subtitle_case: Option<String>,
    target_duration: Option<f64>,
    cut_start: Option<f64>,
    cut_end: Option<f64>,
    prompt_hook: Option<String>,
    elevenlabs_key: Option<String>,
    transcription_provider: Option<String>,
    channel_context: Option<String>,
    meta_title: Option<String>,
    meta_desc: Option<String>,
    meta_tags: Option<String>,
    aspect_ratio: Option<String>,
    layout: Option<String>,
    face_roi: Option<String>,
    edit_plan: Option<serde_json::Value>,
    edit_strategy: Option<String>,
    remove_silence: Option<bool>,
    remove_retakes: Option<bool>,
) -> Result<String, String> {
    let req = RenderRequest {
        input_video,
        output_video,
        preset_id,
        cut_start,
        cut_end,
        agent_id,
        model_id,
        subtitle_style,
        subtitle_position,
        subtitle_size,
        subtitle_case,
        target_duration,
        prompt_hook,
        elevenlabs_key,
        transcription_provider,
        channel_context,
        meta_title,
        meta_desc,
        meta_tags,
        aspect_ratio,
        layout,
        face_roi,
        edit_plan,
        edit_strategy,
        remove_silence,
        remove_retakes,
    };
    req.validate()?;
    let job_id = {
        let registry = app.state::<jobs::JobRegistry>();
        jobs::create_render_job(&registry, &req)
    };
    let task_app = app.clone();
    let task_id = job_id.clone();
    let handle = tokio::spawn(async move {
        run_render_job(task_app, task_id, req).await;
    });
    app.state::<jobs::JobRegistry>()
        .store_task(&job_id, handle);
    Ok(job_id)
}

async fn run_render_job(app: tauri::AppHandle, job_id: String, req: RenderRequest) {
    {
        let registry = app.state::<jobs::JobRegistry>();
        registry.set_running(&job_id);
    }
    jobs::emit_progress(&app, &job_id, 0.0, "Starting pipeline", "Starting pipeline", false);

    let script_path = jobs::resolve_pipeline_script();

    let line_app = app.clone();
    let line_id = job_id.clone();
    let mut last_progress = 0.0f32;
    let python = jobs::resolve_python();
    let output = match req.prepare_pipeline_args(&script_path) {
      Err(error) => Err(error),
      Ok((args, _plan_file)) => jobs::run_pipeline_streaming(&python, &args, |line| {
        let registry = line_app.state::<jobs::JobRegistry>();
        let stage = line.to_string();
        if let Some(p) = jobs::parse_progress_line(line) {
            last_progress = p;
            registry.update_progress(&line_id, p, &stage);
        }
        jobs::emit_progress(&line_app, &line_id, last_progress, &stage, line, false);
    })
    .await,
    };

    let registry = app.state::<jobs::JobRegistry>();
    let cancelled = matches!(
        registry.get(&job_id).map(|j| j.status),
        Some(JobStatus::Cancelled)
    );
    if !cancelled {
        match output {
            Ok(out) => registry.finish(&job_id, out),
            Err(error) => registry.finish(
                &job_id,
                CommandOutput {
                    success: false,
                    code: -1,
                    stdout: String::new(),
                    stderr: error,
                    fallback_used: false,
                },
            ),
        }
    }
    registry.take_task(&job_id);
    if let Some(info) = registry.get(&job_id) {
        jobs::emit_finished(&app, &info);
    }
}

#[tauri::command]
async fn get_job_status(app: tauri::AppHandle, job_id: String) -> Result<JobInfo, String> {
    let registry = app.state::<jobs::JobRegistry>();
    registry
        .get(&job_id)
        .ok_or_else(|| format!("Unknown job id: {}", job_id))
}

#[tauri::command]
async fn cancel_job(app: tauri::AppHandle, job_id: String) -> Result<bool, String> {
    let registry = app.state::<jobs::JobRegistry>();
    let was_active = registry.mark_cancelled(&job_id);
    if let Some(handle) = registry.take_task(&job_id) {
        handle.abort();
    }
    if let Some(info) = registry.get(&job_id) {
        jobs::emit_finished(&app, &info);
    }
    Ok(was_active)
}

/// Probe one editing agent's headless availability via agent_edit.py.
/// Returns the probe JSON object: {agent, available, binary, path, note}.
#[tauri::command]
async fn probe_agent(agent_id: String) -> Result<serde_json::Value, String> {
    let script = jobs::resolve_helper_script("agent_edit.py");
    let args = vec![
        script,
        "--agent".to_string(),
        agent_id.clone(),
        "--probe".to_string(),
    ];
    let python = jobs::resolve_python();
    let out = video_runner::run_helper_process(&python, &args, None).await?;
    if !out.success {
        return Err(format!(
            "agent probe failed for '{}': {}",
            agent_id,
            out.stderr.trim()
        ));
    }
    serde_json::from_str(out.stdout.trim())
        .map_err(|e| format!("agent probe returned invalid JSON: {}", e))
}

/// Review a rendered short via review.py: grounds the review report in
/// the actual output (probe + transcript sidecars). Returns raw JSON.
#[tauri::command]
async fn review_render(
    output_video: String,
    channel_context: Option<String>,
) -> Result<String, String> {
    let script = jobs::resolve_helper_script("review.py");
    let mut args = vec![script, "--input".to_string(), output_video];
    if let Some(ctx) = channel_context {
        if !ctx.trim().is_empty() {
            args.push("--context".to_string());
            args.push(ctx);
        }
    }
    let python = jobs::resolve_python();
    let out = video_runner::run_helper_process(&python, &args, None).await?;
    if !out.success {
        return Err(format!("review failed: {}", out.stderr.trim()));
    }
    Ok(out.stdout.trim().to_string())
}

/// Fetch trending Shorts keywords via trending.py. The helper exits 0
/// with a JSON doc in all graceful cases (no key, API error); only usage
/// errors fail the command.
#[tauri::command]
async fn fetch_trending(
    niche: String,
    api_key: Option<String>,
) -> Result<serde_json::Value, String> {
    let script = jobs::resolve_helper_script("trending.py");
    let mut args = vec![script, "--niche".to_string(), niche];
    if let Some(key) = api_key {
        if !key.trim().is_empty() {
            args.push("--api-key".to_string());
            args.push(key);
        }
    }
    let python = jobs::resolve_python();
    let out = video_runner::run_helper_process(&python, &args, None).await?;
    if !out.success {
        return Err(format!("trending fetch failed: {}", out.stderr.trim()));
    }
    serde_json::from_str(out.stdout.trim())
        .map_err(|e| format!("trending returned invalid JSON: {}", e))
}

/// `a|b|c` for the SEO helper: trimmed, pipes stripped, at most 10 items.
fn join_signal_list(values: Option<&[String]>) -> Option<String> {
    let items: Vec<String> = values
        .unwrap_or(&[])
        .iter()
        .map(|v| v.replace('|', " ").split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|v| !v.is_empty())
        .take(10)
        .collect();
    if items.is_empty() {
        None
    } else {
        Some(items.join("|"))
    }
}

#[tauri::command]
async fn generate_seo_metadata(
    input_video: String,
    channel_context: Option<String>,
    agent_id: Option<String>,
    elevenlabs_key: Option<String>,
    transcription_provider: Option<String>,
    trend_terms: Option<Vec<String>>,
    winning_titles: Option<Vec<String>>,
) -> Result<String, String> {
    let script_path = jobs::resolve_pipeline_script();

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

    // Market signals ride as pipe-separated lists (see split_signal_arg).
    for (flag, values) in [("--trend-terms", trend_terms), ("--winning-titles", winning_titles)] {
        if let Some(joined) = join_signal_list(values.as_deref()) {
            args.push(flag.to_string());
            args.push(joined);
        }
    }

    args.extend(transcription::helper_args(transcription_provider.as_deref(), elevenlabs_key.as_deref(), true)?);

    let python = jobs::resolve_python();
    let output = video_runner::run_helper_process(&python, &args, None).await;
    match output {
        Ok(out) => {
            if let Some(start) = out.stdout.find("__SEO_METADATA_START__") {
                if let Some(end) = out.stdout.find("__SEO_METADATA_END__") {
                    let json_str = out.stdout[start + "__SEO_METADATA_START__".len()..end].trim();
                    return Ok(json_str.to_string());
                }
            }
            // No markers: the pipeline refused to template anything (missing
            // file, no transcript, agent failure). Surface its reason so the
            // UI can show an honest empty state instead of fake metadata.
            let detail = if out.stderr.trim().is_empty() {
                out.stdout.trim().to_string()
            } else {
                out.stderr.trim().to_string()
            };
            let short: String = detail.chars().take(400).collect();
            Err(format!("SEO review failed: {}", short))
        }
        Err(e) => Err(format!("Failed to run SEO generation: {}", e)),
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
struct TranscriptionStatus {
    elevenlabs_key_configured: bool,
    local_available: bool,
    local_model: String,
    ffmpeg_available: bool,
    active_engine: String,
}

/// Probe a public YouTube / Twitch VOD link via stream_clip.py.
/// Returns the video card JSON (title, channel, thumbnail, duration,
/// views, upload date). Metadata loads in the background and never
/// blocks clip setup — failures are honest errors, not placeholders.
#[tauri::command]
async fn probe_stream(url: String) -> Result<serde_json::Value, String> {
    let script = jobs::resolve_helper_script("stream_clip.py");
    let args = vec![
        script,
        "--probe".to_string(),
        "--url".to_string(),
        url.clone(),
    ];
    let python = jobs::resolve_python();
    let out = video_runner::run_helper_process(&python, &args, None).await?;
    if !out.success {
        let detail = if out.stderr.trim().is_empty() {
            out.stdout.trim().to_string()
        } else {
            out.stderr.trim().to_string()
        };
        let short: String = detail.chars().take(400).collect();
        return Err(short);
    }
    serde_json::from_str(out.stdout.trim())
        .map_err(|e| format!("stream probe returned invalid JSON: {}", e))
}

/// Find the best clip windows in a stream URL via stream_clip.py.
/// The clip count follows quality (threshold + min-gap merge), never a
/// fixed quota. Returns the suggestion JSON document.
#[tauri::command]
async fn suggest_stream_clips(
    url: String,
    transcription_provider: Option<String>,
    elevenlabs_key: Option<String>,
    agent_id: Option<String>,
    channel_context: Option<String>,
    prompt_hook: Option<String>,
    threshold: Option<f64>,
    min_length: Option<f64>,
    max_length: Option<f64>,
    max_clips: Option<u32>,
    min_gap: Option<f64>,
) -> Result<serde_json::Value, String> {
    let script = jobs::resolve_helper_script("stream_clip.py");
    let mut args = vec![
        script,
        "--suggest".to_string(),
        "--url".to_string(),
        url,
    ];
    // Captioned sources need no paid call or key. Audio fallback validates the key.
    args.extend(transcription::helper_args(transcription_provider.as_deref(), elevenlabs_key.as_deref(), false)?);
    if let Some(agent) = agent_id {
        if !agent.trim().is_empty() {
            args.push("--agent".to_string());
            args.push(agent);
        }
    }
    if let Some(ctx) = channel_context {
        if !ctx.trim().is_empty() {
            args.push("--channel-context".to_string());
            args.push(ctx);
        }
    }
    if let Some(hook) = prompt_hook {
        if !hook.trim().is_empty() {
            args.push("--prompt".to_string());
            args.push(hook);
        }
    }
    if let Some(v) = threshold {
        args.push("--threshold".to_string());
        args.push(v.to_string());
    }
    if let Some(v) = min_length {
        args.push("--min-length".to_string());
        args.push(v.to_string());
    }
    if let Some(v) = max_length {
        args.push("--max-length".to_string());
        args.push(v.to_string());
    }
    if let Some(v) = max_clips {
        args.push("--max-clips".to_string());
        args.push(v.to_string());
    }
    if let Some(v) = min_gap {
        args.push("--min-gap".to_string());
        args.push(v.to_string());
    }
    let python = jobs::resolve_python();
    let out = video_runner::run_helper_process(&python, &args, None).await?;
    if !out.success {
        let detail = if out.stderr.trim().is_empty() {
            out.stdout.trim().to_string()
        } else {
            out.stderr.trim().to_string()
        };
        // Progress precedes transcription failures; preserve the final error.
        let detail = out.stderr.lines().rev()
            .find(|line| line.starts_with("stream_clip.py:"))
            .unwrap_or(&detail);
        let short: String = detail.chars().take(400).collect();
        return Err(short);
    }
    serde_json::from_str(out.stdout.trim())
        .map_err(|e| format!("clip finder returned invalid JSON: {}", e))
}

/// Download one clip window from a stream URL via yt-dlp sections.
/// Only the winning window is fetched — never the full VOD.
/// Relative names land in `~/.2pixelshorts/clips` so YouTube-only studio
/// sessions (no local file yet) still get a stable, probe-able path.
#[tauri::command]
async fn fetch_stream_clip(
    url: String,
    start: f64,
    end: f64,
    output: String,
) -> Result<CommandOutput, String> {
    let output = jobs::resolve_stream_clip_output(&output)?;
    let script = jobs::resolve_helper_script("stream_clip.py");
    let args = vec![
        script,
        "--download".to_string(),
        "--url".to_string(),
        url,
        "--start".to_string(),
        start.to_string(),
        "--end".to_string(),
        end.to_string(),
        "--output".to_string(),
        output,
    ];
    let python = jobs::resolve_python();
    video_runner::run_helper_process(&python, &args, None).await
}

/// Report which transcription engine `auto` would use, so the UI can
/// explain upfront why analysis would fail instead of failing blind.
#[tauri::command]
async fn probe_transcription(
    elevenlabs_key: Option<String>,
    transcription_provider: Option<String>,
) -> Result<TranscriptionStatus, String> {
    let script = jobs::resolve_helper_script("transcribe.py");
    let mut args = vec![script, "--probe".to_string()];
    args.extend(transcription::helper_args(transcription_provider.as_deref(), None, false)?);
    if let Some(key) = elevenlabs_key {
        if !key.trim().is_empty() {
            args.push("--elevenlabs-key".to_string());
            args.push(key);
        }
    }
    let python = jobs::resolve_python();
    let out = video_runner::run_helper_process(&python, &args, None)
        .await
        .map_err(|e| format!("Failed to probe transcription: {}", e))?;
    if !out.success {
        return Err(format!(
            "Transcription probe failed: {}",
            out.stderr.trim()
        ));
    }
    serde_json::from_str(out.stdout.trim())
        .map_err(|e| format!("Transcription probe returned invalid JSON: {}", e))
}

/// Short-timeout client for metadata calls (accounts, status, retry).
fn gateway_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))
}

/// Long-timeout client for media upload + post dispatch (large-video PUTs and
/// video posts can take minutes; the gateway docs advise ≥180 s timeouts).
fn gateway_upload_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(1800))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))
}

#[tauri::command]
async fn get_zernio_accounts(api_key: String) -> Result<Vec<ZernioAccount>, String> {
    if api_key.trim().is_empty() {
        return Ok(vec![]);
    }

    let client = gateway_client()?;
    let res = client
        .get("https://zernio.com/api/v1/accounts")
        .header("Authorization", format!("Bearer {}", api_key.trim()))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Network error querying Zernio: {}", e))?;

    if !res.status().is_success() {
        let code = res.status();
        let body: String = res.text().await.unwrap_or_default().chars().take(400).collect();
        return Err(format!(
            "Zernio accounts returned status {}: {}",
            code,
            body.trim()
        ));
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
                .or_else(|| item.get("accountId"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let platform = item.get("platform")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string();
            let name = item.get("displayName")
                .or_else(|| item.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or("Channel")
                .to_string();
            let username = item.get("username")
                .or_else(|| item.get("screenName"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let avatar = item.get("profilePicture")
                .or_else(|| item.get("avatar"))
                .or_else(|| item.get("profileImageUrl"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            // Connection state per the gateway's SocialAccount schema: `isActive`
            // reports health, `needsReconnection` means the stored OAuth token
            // is dead, and `enabled: false` accounts cannot be posted to.
            let active = item.get("isActive")
                .or_else(|| item.get("isConnected"))
                .or_else(|| item.get("connected"))
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let needs_reconnect = item.get("needsReconnection")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let enabled = item.get("enabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let is_connected = active && !needs_reconnect && enabled;

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
    let endpoint = format!("https://zernio.com/api/v1/connect/{}", clean_platform);

    // NOTE: the gateway's getConnectUrl requires a `profileId` query param this
    // client does not track yet, so the API call is best-effort: whatever URL
    // it returns (its `authUrl`) wins, otherwise the dashboard connect page is
    // a working fallback the user can complete by hand.
    if !api_key.trim().is_empty() {
        if let Ok(client) = gateway_client() {
            if let Ok(res) = client
                .get(&endpoint)
                .header("Authorization", format!("Bearer {}", api_key.trim()))
                .header("Accept", "application/json")
                .send()
                .await
            {
                if res.status().is_success() {
                    if let Ok(val) = res.json::<serde_json::Value>().await {
                        if let Some(url) = val
                            .get("authUrl")
                            .or_else(|| val.get("url"))
                            .or_else(|| val.get("redirectUrl"))
                            .and_then(|u| u.as_str())
                        {
                            return Ok(url.to_string());
                        }
                    }
                }
            }
        }
    }

    Ok(format!("https://zernio.com/app/connect/{}", clean_platform))
}

#[tauri::command]
async fn publish_to_zernio(
    api_key: String,
    payload: SocialPublishPayload,
) -> Result<String, String> {
    if api_key.trim().is_empty() {
        return Err("Zernio API key is empty. Please enter your API key in Settings.".to_string());
    }
    if payload.platforms.is_empty() {
        return Err("No platforms selected. Pick at least one connected channel first.".to_string());
    }

    let client = gateway_upload_client()?;

    // Resolve the video URL: an explicit public media URL skips the upload,
    // otherwise the local file is uploaded through a presigned URL first.
    let media_url = match payload
        .media_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(url) => url.to_string(),
        None => zernio::upload_media(&client, &api_key, &payload.video_path).await?,
    };

    let mut body = zernio::build_post_body(&payload, &media_url, chrono::Utc::now());
    // TikTok rejects the create call without consent + privacy settings.
    // Creator-info narrows privacy and the comment/duet/stitch toggles; a
    // failed lookup keeps the public defaults already written on the body.
    let tiktok_index = payload
        .platforms
        .iter()
        .position(|p| p.eq_ignore_ascii_case("tiktok"));
    if tiktok_index.is_some() {
        let account_id = tiktok_index
            .and_then(|i| payload.account_ids.as_ref().and_then(|ids| ids.get(i)))
            .map(|s| s.as_str());
        let settings = zernio::resolve_tiktok_settings(&client, &api_key, account_id).await;
        zernio::apply_tiktok_settings(&mut body, &settings);
    }

    // One idempotency key per logical post (the queue entry id when dispatched
    // from the app): retries after a timeout or 5xx return the original post
    // instead of double-posting, per the gateway's 24-hour retry contract.
    let mut req = client
        .post("https://zernio.com/api/v1/posts")
        .header("Authorization", format!("Bearer {}", api_key.trim()))
        .header("Content-Type", "application/json");
    if let Some(key) = payload.idempotency_key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
        req = req.header("Idempotency-Key", key);
    }
    let res = req
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
        // 201 and 207 both carry the created post, including a terminal
        // `failed` or a `partial`. Return the body so the client can store
        // the post id and show the per-platform reason. Turning `failed`
        // into an Err here used to drop the id, and the next dispatch then
        // replayed the same failure through the idempotency key.
        Ok(text)
    } else {
        Err(zernio::format_api_error(status.as_u16(), &text))
    }
}

#[tauri::command]
async fn get_post_status(api_key: String, post_id: String) -> Result<String, String> {
    if api_key.trim().is_empty() {
        return Err("Zernio API key is empty.".to_string());
    }
    if post_id.trim().is_empty() {
        return Err("Post id is empty.".to_string());
    }
    let client = gateway_client()?;
    let res = client
        .get(format!(
            "https://zernio.com/api/v1/posts/{}",
            post_id.trim()
        ))
        .header("Authorization", format!("Bearer {}", api_key.trim()))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Failed to connect to Zernio API: {}", e))?;
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    if status.is_success() {
        Ok(text)
    } else {
        Err(format!("Zernio API returned status {}: {}", status, text))
    }
}

/// Read post analytics (views, likes, comments, shares per platform) for a
/// published post from `GET /v1/analytics?postId=`. A 202 means Zernio is
/// still syncing metrics; it comes back as `{"pending": true}`.
#[tauri::command]
async fn get_post_analytics(api_key: String, post_id: String) -> Result<String, String> {
    if api_key.trim().is_empty() {
        return Err("Zernio API key is empty.".to_string());
    }
    if post_id.trim().is_empty() {
        return Err("Post id is empty.".to_string());
    }
    let client = gateway_client()?;
    let res = client
        .get("https://zernio.com/api/v1/analytics")
        .query(&[("postId", post_id.trim())])
        .header("Authorization", format!("Bearer {}", api_key.trim()))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Failed to connect to Zernio API: {}", e))?;
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    if status.as_u16() == 202 {
        return Ok(serde_json::json!({ "pending": true }).to_string());
    }
    if status.is_success() {
        Ok(text)
    } else {
        Err(zernio::format_api_error(status.as_u16(), &text))
    }
}

#[tauri::command]
async fn retry_post(api_key: String, post_id: String) -> Result<String, String> {
    if api_key.trim().is_empty() {
        return Err("Zernio API key is empty.".to_string());
    }
    if post_id.trim().is_empty() {
        return Err("Post id is empty.".to_string());
    }
    let client = gateway_client()?;
    let res = client
        .post(format!(
            "https://zernio.com/api/v1/posts/{}/retry",
            post_id.trim()
        ))
        .header("Authorization", format!("Bearer {}", api_key.trim()))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Failed to connect to Zernio API: {}", e))?;
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    if status.is_success() {
        Ok(text)
    } else {
        Err(format!("Zernio API returned status {}: {}", status, text))
    }
}

#[tauri::command]
async fn pick_video_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    tokio::task::spawn_blocking(move || {
        let mut picker = app.dialog().file()
            .set_title("Select Source Video Footage")
            .add_filter("Video files", &["mp4", "mov", "mkv", "avi", "webm", "m4v", "mpg", "mpeg", "ts", "flv", "wmv", "3gp"]);
        if let Some(window) = app.get_webview_window("main") {
            picker = picker.set_parent(&window);
        }
        picker.blocking_pick_file().map(|file| {
            file.into_path().map(|path| path.to_string_lossy().into_owned())
                .map_err(|_| "Select a local video file".to_string())
        }).transpose()
    }).await.map_err(|_| "File picker worker failed".to_string())?
}

/// `open`/`explorer` spawn happily for a path that does not exist and exit
/// on their own, so without this check a stale path fails silently in the UI.
fn ensure_path_exists(path: &str) -> Result<(), String> {
    if std::path::Path::new(path).exists() {
        Ok(())
    } else {
        Err(format!("File not found: {}", path))
    }
}

#[tauri::command]
async fn open_file_location(path: String) -> Result<(), String> {
    ensure_path_exists(&path)?;
    #[cfg(target_os = "windows")]
    {
        let clean_path = path.replace('/', "\\");
        let arg = format!("/select,{}", clean_path);
        tokio::process::Command::new("explorer.exe")
            .arg(arg)
            .spawn()
            .map_err(|e| format!("Failed to open file location: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        tokio::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| format!("Failed to reveal file in Finder: {}", e))?;
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        use std::path::Path;
        let dir = Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().into_owned())
            .filter(|p| !p.is_empty())
            .unwrap_or(path.clone());
        tokio::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("Failed to open file location: {}", e))?;
    }
    Ok(())
}

/// List files the app created (renders, downloads, leftovers, caches, engine backups).
#[tauri::command]
async fn scan_storage(scope: storage::StorageScope) -> Result<Vec<storage::StorageItem>, String> {
    tokio::task::spawn_blocking(move || storage::scan(&scope, &storage::Roots::detect()))
        .await
        .map_err(|_| "Storage scan failed".to_string())
}

/// Move the selected app files to the Trash. Paths are re-validated by a fresh scan.
#[tauri::command]
async fn delete_storage_items(scope: storage::StorageScope, paths: Vec<String>) -> Result<storage::DeleteReport, String> {
    tokio::task::spawn_blocking(move || {
        storage::delete_with(&scope, &storage::Roots::detect(), &paths, storage::move_to_trash)
    })
    .await
    .map_err(|_| "Storage cleanup failed".to_string())
}

#[tauri::command]
async fn open_file(path: String) -> Result<(), String> {
    ensure_path_exists(&path)?;
    #[cfg(target_os = "windows")]
    {
        tokio::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", "Start-Process -FilePath $env:PIXEL_OPEN_PATH"])
            .env("PIXEL_OPEN_PATH", &path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        tokio::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        tokio::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    video_runner::configure_media_tool_path();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(jobs::JobRegistry::new())
        .setup(|app| {
            // Debug QA bundles opt out of the default window so their
            // WebKit store cannot reuse real Studio drafts or credentials.
            // Use the builder here: current Tauri config code generation
            // emits a Vec for dataStoreIdentifier's fixed-size array.
            #[cfg(debug_assertions)]
            if app.config().identifier.ends_with(".qa") && app.get_webview_window("main").is_none() {
                if let Some(config) = app.config().app.windows.first() {
                    let builder = tauri::WebviewWindowBuilder::from_config(app, config)?;
                    #[cfg(target_os = "macos")]
                    let builder = builder.data_store_identifier([32,112,105,120,101,108,115,104,111,114,116,115,0,0,10,14]);
                    builder.build()?;
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_api_keys,
            set_api_key,
            clear_api_keys,
            validate_api_key,
            scan_clis,
            probe_custom_cli,
            probe_video,
            read_source_transcript,
            run_cli,
            render_short,
            start_render_job,
            get_job_status,
            cancel_job,
            probe_agent,
            review_render,
            fetch_trending,
            probe_stream,
            suggest_stream_clips,
            fetch_stream_clip,
            scan_storage,
            delete_storage_items,
            generate_seo_metadata,
            probe_transcription,
            get_zernio_accounts,
            get_zernio_connect_url,
            publish_to_zernio,
            get_post_status,
            get_post_analytics,
            retry_post,
            pick_video_file,
            open_file_location,
            open_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

