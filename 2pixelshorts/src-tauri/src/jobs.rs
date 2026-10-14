//! Background render-job engine.
//!
//! The blocking `render_short` command freezes the UI while the Python
//! pipeline runs. This module adds a job-based path with the same behavior:
//! `start_render_job` returns a job id immediately, streams `[STAGE n/4]`
//! progress as `render-progress` Tauri events, and finishes with a
//! `render-finished` event. Jobs are cancellable via `cancel_job`.
//!
//! The pipeline runner itself ([`run_pipeline_streaming`]) is Tauri-free so
//! integration tests can drive the real `short_pipeline.py` headlessly.

use crate::models::{CommandOutput, JobInfo, JobProgressEvent, JobStatus};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;
use tokio::task::JoinHandle;

/// All `render_short` parameters as one struct so the blocking command and
/// the job engine share identical pipeline-argument building.
#[derive(Debug, Clone, Deserialize)]
pub struct RenderRequest {
    pub input_video: String,
    pub output_video: String,
    pub preset_id: String,
    pub agent_id: Option<String>,
    pub subtitle_style: Option<String>,
    pub subtitle_position: Option<String>,
    pub subtitle_size: Option<String>,
    pub subtitle_case: Option<String>,
    pub target_duration: Option<f64>,
    pub cut_start: Option<f64>,
    pub cut_end: Option<f64>,
    pub prompt_hook: Option<String>,
    pub elevenlabs_key: Option<String>,
    pub channel_context: Option<String>,
    pub meta_title: Option<String>,
    pub meta_desc: Option<String>,
    pub meta_tags: Option<String>,
    pub aspect_ratio: Option<String>,
    pub layout: Option<String>,
    pub face_roi: Option<String>,
}

impl RenderRequest {
    pub fn validate(&self) -> Result<(), String> {
        let input = std::path::Path::new(&self.input_video);
        let output = std::path::Path::new(&self.output_video);
        if !input.is_file() { return Err("Source video does not exist or is not a file".into()); }
        if output.extension().and_then(|value| value.to_str()).is_none_or(|ext| !ext.eq_ignore_ascii_case("mp4")) {
            return Err("Choose an MP4 output file".into());
        }
        if input.canonicalize().ok().zip(output.canonicalize().ok()).is_some_and(|(input, output)| input == output) {
            return Err("Output must differ from the source video".into());
        }
        for (label, value) in [("Duration", self.target_duration), ("Cut start", self.cut_start), ("Cut end", self.cut_end)] {
            if value.is_some_and(|value| !value.is_finite() || value < 0.) {
                return Err(format!("{} must be a finite, nonnegative number", label));
            }
        }
        if self.cut_start.zip(self.cut_end).is_some_and(|(start, end)| end <= start) {
            return Err("Cut end must follow cut start".into());
        }
        if self.prompt_hook.as_ref().is_some_and(|prompt| prompt.chars().count() > 4000) {
            return Err("Keep the custom prompt within 4,000 characters".into());
        }
        Ok(())
    }
    /// Build the `short_pipeline.py` CLI args. Empty/blank optionals are
    /// skipped, mirroring the blocking `render_short` behavior exactly.
    pub fn to_pipeline_args(&self, script_path: &str) -> Vec<String> {
        let mut args = vec![
            script_path.to_string(),
            "--input".to_string(),
            self.input_video.clone(),
            "--output".to_string(),
            self.output_video.clone(),
            "--preset".to_string(),
            self.preset_id.clone(),
        ];

        push_opt(&mut args, "--agent", &self.agent_id);
        push_opt(&mut args, "--subtitles", &self.subtitle_style);
        push_opt(
            &mut args,
            "--subtitle-position",
            &self.subtitle_position,
        );
        push_opt(&mut args, "--subtitle-size", &self.subtitle_size);
        push_opt(&mut args, "--subtitle-case", &self.subtitle_case);

        // NOTE: duration is passed even when 0 (VideoStudio sends 0 for
        // "auto"); the pipeline treats 0 as "no trim". Same as render_short.
        if let Some(dur) = self.target_duration {
            args.push("--duration".to_string());
            args.push(dur.to_string());
        }
        if let Some(start) = self.cut_start {
            args.push("--cut-start".to_string());
            args.push(start.to_string());
        }
        if let Some(end) = self.cut_end {
            args.push("--cut-end".to_string());
            args.push(end.to_string());
        }

        push_opt(&mut args, "--prompt", &self.prompt_hook);
        push_opt(&mut args, "--elevenlabs-key", &self.elevenlabs_key);
        push_opt(&mut args, "--channel-context", &self.channel_context);
        push_opt(&mut args, "--meta-title", &self.meta_title);
        push_opt(&mut args, "--meta-desc", &self.meta_desc);
        push_opt(&mut args, "--meta-tags", &self.meta_tags);
        push_opt(&mut args, "--aspect-ratio", &self.aspect_ratio);
        push_opt(&mut args, "--layout", &self.layout);
        push_opt(&mut args, "--face-roi", &self.face_roi);

        args
    }
}

fn push_opt(args: &mut Vec<String>, flag: &str, val: &Option<String>) {
    if let Some(v) = val {
        if !v.trim().is_empty() {
            args.push(flag.to_string());
            args.push(v.clone());
        }
    }
}

/// Locate another helper script living next to `short_pipeline.py`
/// (e.g. `agent_edit.py`). Falls back the same way when nothing matches.
pub fn resolve_helper_script(name: &str) -> String {
    let base = resolve_pipeline_script();
    if base.ends_with("short_pipeline.py") {
        base.replace("short_pipeline.py", name)
    } else {
        base
    }
}

/// Exe-relative lookup root: robust to the process working directory,
/// unlike the legacy CWD-relative candidates below.
fn exe_dir() -> Option<std::path::PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|d| d.to_path_buf()))
}

/// Locate `short_pipeline.py`: exe-relative layouts first (cargo dev
/// target dir, macOS/Windows bundles with resources), then the legacy
/// CWD-relative candidates. Falls back to the legacy Windows path so
/// behavior is unchanged when nothing matches (spawn then fails cleanly).
/// Exe-relative helper candidates for one executable directory.
/// Bundle layouts depend on the resource mapping: macOS lands at
/// `Resources/_up_/video-use/helpers/` (verified in the built .app);
/// the flat and exe-adjacent forms cover other mappings.
fn pipeline_exe_candidates(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    [
        "../../video-use/helpers/short_pipeline.py",
        "../Resources/_up_/video-use/helpers/short_pipeline.py",
        "../Resources/helpers/short_pipeline.py",
        "../Resources/video-use/helpers/short_pipeline.py",
        "helpers/short_pipeline.py",
        "video-use/helpers/short_pipeline.py",
    ]
    .iter()
    .map(|rel| dir.join(rel))
    .collect()
}

pub fn resolve_pipeline_script() -> String {
    if let Some(dir) = exe_dir() {
        for cand in pipeline_exe_candidates(&dir) {
            if cand.is_file() {
                return cand.to_string_lossy().to_string();
            }
        }
    }

    const CANDIDATES: [&str; 4] = [
        "../video-use/helpers/short_pipeline.py",
        "video-use/helpers/short_pipeline.py",
        "../../video-use/helpers/short_pipeline.py",
        "C:\\Users\\Taman\\Documents\\2pixelspace-short\\video-use\\helpers\\short_pipeline.py",
    ];

    CANDIDATES
        .iter()
        .find(|p| std::path::Path::new(p).exists())
        .copied()
        .unwrap_or(CANDIDATES[3])
        .to_string()
}

/// Interpreter used to spawn the video-use helpers: the project venv
/// (`video-use/.venv`, which carries optional local deps such as
/// faster-whisper) when it exists, else the platform Python.
pub fn resolve_python() -> String {
    // Resolve next to the actual helper, so launching the native app outside
    // the repository still uses the environment containing the face detector.
    #[cfg(target_os = "windows")]
    const ENGINE_PYTHON: &str = ".venv/Scripts/python.exe";
    #[cfg(not(target_os = "windows"))]
    const ENGINE_PYTHON: &str = ".venv/bin/python";
    let script = std::path::PathBuf::from(resolve_pipeline_script());
    if let Some(engine) = script.parent().and_then(|helpers| helpers.parent()) {
        let interpreter = engine.join(ENGINE_PYTHON);
        if interpreter.is_file() {
            return interpreter.to_string_lossy().to_string();
        }
    }
    // Installed app resources do not contain a relocatable Python venv.
    // Use the per-user environment created by setup_framing.sh --managed
    // or setup_local_stt.sh --managed when launched from Finder/the desktop.
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        let interpreter = std::path::PathBuf::from(home)
            .join(".2pixelshorts")
            .join("video-use")
            .join(ENGINE_PYTHON);
        if interpreter.is_file() {
            return interpreter.to_string_lossy().to_string();
        }
    }
    #[cfg(target_os = "windows")]
    const VENV_EXE_REL: &str = "../../video-use/.venv/Scripts/python.exe";
    #[cfg(not(target_os = "windows"))]
    const VENV_EXE_REL: &str = "../../video-use/.venv/bin/python";
    #[cfg(target_os = "windows")]
    const VENV_CWD_REL: &[&str] = &[
        "video-use/.venv/Scripts/python.exe",
        "../video-use/.venv/Scripts/python.exe",
    ];
    #[cfg(not(target_os = "windows"))]
    const VENV_CWD_REL: &[&str] = &[
        "video-use/.venv/bin/python",
        "../video-use/.venv/bin/python",
    ];

    if let Some(dir) = exe_dir() {
        let cand = dir.join(VENV_EXE_REL);
        if cand.is_file() {
            return cand.to_string_lossy().to_string();
        }
    }
    for rel in VENV_CWD_REL {
        if std::path::Path::new(rel).is_file() {
            return rel.to_string();
        }
    }

    #[cfg(target_os = "windows")]
    {
        "python".to_string()
    }
    #[cfg(not(target_os = "windows"))]
    {
        "python3".to_string()
    }
}

/// Parse a pipeline stdout line into a 0.0–1.0 progress value.
/// `[STAGE n/4] ...` maps to n/4, `[COMPLETE] ...` maps to 1.0.
pub fn parse_progress_line(line: &str) -> Option<f32> {
    let trimmed = line.trim();
    if trimmed.starts_with("[COMPLETE]") {
        return Some(1.0);
    }
    let rest = trimmed.strip_prefix("[STAGE ")?;
    let (num, denom) = rest.split_once('/')?;
    let n: f32 = num.trim().parse().ok()?;
    let d: f32 = denom
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect::<String>()
        .parse()
        .ok()?;
    if d <= 0.0 {
        return None;
    }
    Some((n / d).clamp(0.0, 1.0))
}

static JOB_COUNTER: AtomicU64 = AtomicU64::new(0);

fn next_job_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let seq = JOB_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("job-{}-{}", millis, seq)
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// In-memory registry of render jobs plus handles to running job tasks.
/// Registered once via Tauri managed state (`.manage(JobRegistry::new())`).
/// Cancellation aborts the task; the pipeline child is spawned with
/// `kill_on_drop`, so aborting reliably kills the underlying process.
pub struct JobRegistry {
    jobs: Mutex<HashMap<String, JobInfo>>,
    tasks: Mutex<HashMap<String, JoinHandle<()>>>,
}

impl JobRegistry {
    pub fn new() -> Self {
        Self {
            jobs: Mutex::new(HashMap::new()),
            tasks: Mutex::new(HashMap::new()),
        }
    }

    pub fn insert(&self, info: JobInfo) {
        self.jobs.lock().unwrap().insert(info.id.clone(), info);
    }

    pub fn get(&self, id: &str) -> Option<JobInfo> {
        self.jobs.lock().unwrap().get(id).cloned()
    }

    pub fn set_running(&self, id: &str) {
        if let Some(job) = self.jobs.lock().unwrap().get_mut(id) {
            job.status = JobStatus::Running;
        }
    }

    pub fn update_progress(&self, id: &str, progress: f32, stage: &str) {
        if let Some(job) = self.jobs.lock().unwrap().get_mut(id) {
            if matches!(job.status, JobStatus::Queued | JobStatus::Running) {
                job.progress = progress.clamp(0.0, 1.0);
                job.stage = stage.to_string();
            }
        }
    }

    pub fn finish(&self, id: &str, result: CommandOutput) {
        if let Some(job) = self.jobs.lock().unwrap().get_mut(id) {
            if matches!(job.status, JobStatus::Cancelled) {
                return; // cancel wins over a racing completion
            }
            job.status = if result.success {
                JobStatus::Completed
            } else {
                JobStatus::Failed
            };
            job.progress = if result.success { 1.0 } else { job.progress };
            job.finished_at = Some(now_rfc3339());
            if !result.success && result.stderr.trim().is_empty() {
                job.error = Some(format!("Pipeline exited with code {}", result.code));
            } else if !result.success {
                job.error = Some(result.stderr.clone());
            }
            job.result = Some(result);
        }
    }

    /// Mark a queued/running job cancelled. Returns true when the job was
    /// active (so the caller should also kill the child process).
    pub fn mark_cancelled(&self, id: &str) -> bool {
        if let Some(job) = self.jobs.lock().unwrap().get_mut(id) {
            if matches!(job.status, JobStatus::Queued | JobStatus::Running) {
                job.status = JobStatus::Cancelled;
                job.finished_at = Some(now_rfc3339());
                job.error = Some("Cancelled by user".to_string());
                return true;
            }
        }
        false
    }

    pub fn store_task(&self, id: &str, handle: JoinHandle<()>) {
        self.tasks.lock().unwrap().insert(id.to_string(), handle);
    }

    pub fn take_task(&self, id: &str) -> Option<JoinHandle<()>> {
        self.tasks.lock().unwrap().remove(id)
    }
}

impl Default for JobRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Run the pipeline with streaming stdout. Each line is passed to `on_line`
/// as it arrives; the returned output aggregates the full streams.
/// Tauri-free so tests can drive the real pipeline headlessly.
pub async fn run_pipeline_streaming<F>(
    python_cmd: &str,
    args: &[String],
    mut on_line: F,
) -> Result<CommandOutput, String>
where
    F: FnMut(&str),
{
    let (args, secrets) = crate::video_runner::private_process_args(args);
    let mut command = Command::new(python_cmd);
    command.args(&args).env("PYTHONUNBUFFERED", "1")
        .env("PIXEL_ELEVENLABS_KEY", "").env("PIXEL_YOUTUBE_KEY", "")
        .envs(secrets.iter().map(|(name, value)| (*name, value)))
        .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).kill_on_drop(true);
    crate::video_runner::ProcessTree::configure(&mut command);
    let mut child = command.spawn()
        .map_err(|e| format!("Failed to execute '{}': {}", python_cmd, e))?;
    let _tree = crate::video_runner::ProcessTree::new(&child);

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture pipeline stdout".to_string())?;
    let stderr = child.stderr.take();

    // Drain stderr concurrently so a full pipe buffer can never deadlock
    // the child while we read stdout.
    let stderr_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        if let Some(mut err) = stderr {
            let _ = err.read_to_end(&mut buf).await;
        }
        String::from_utf8_lossy(&buf).to_string()
    });

    let mut full_stdout = String::new();
    let mut reader = BufReader::new(stdout).lines();
    while let Some(line) = reader
        .next_line()
        .await
        .map_err(|e| format!("Failed to read pipeline output: {}", e))?
    {
        let line = crate::video_runner::redact_secrets(line, &secrets);
        on_line(&line);
        full_stdout.push_str(&line);
        full_stdout.push('\n');
    }

    let status = child
        .wait()
        .await
        .map_err(|e| format!("Failed waiting on pipeline: {}", e))?;
    let stderr_text = crate::video_runner::redact_secrets(stderr_task.await.unwrap_or_default(), &secrets);

    Ok(CommandOutput {
        success: status.success(),
        code: status.code().unwrap_or(-1),
        stdout: full_stdout,
        stderr: stderr_text,
        fallback_used: false,
    })
}

/// Create a render job and return its id. The caller spawns the actual work
/// (needs `AppHandle` for events); this only builds the queued record.
pub fn create_render_job(registry: &JobRegistry, req: &RenderRequest) -> String {
    let id = next_job_id();
    registry.insert(JobInfo {
        id: id.clone(),
        kind: "render".to_string(),
        status: JobStatus::Queued,
        progress: 0.0,
        stage: "Queued".to_string(),
        input_video: req.input_video.clone(),
        output_video: req.output_video.clone(),
        created_at: now_rfc3339(),
        finished_at: None,
        result: None,
        error: None,
    });
    id
}

/// Emit a progress event, ignoring send errors (no listeners yet).
pub fn emit_progress(
    app: &tauri::AppHandle,
    job_id: &str,
    progress: f32,
    stage: &str,
    line: &str,
    done: bool,
) {
    use tauri::Emitter;
    let _ = app.emit(
        "render-progress",
        JobProgressEvent {
            job_id: job_id.to_string(),
            progress: progress.clamp(0.0, 1.0),
            stage: stage.to_string(),
            line: line.to_string(),
            done,
        },
    );
}

pub fn emit_finished(app: &tauri::AppHandle, info: &JobInfo) {
    use tauri::Emitter;
    let _ = app.emit("render-finished", info);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_parses_stage_lines() {
        assert_eq!(
            parse_progress_line("[STAGE 1/4] Probing source"),
            Some(0.25)
        );
        assert_eq!(
            parse_progress_line("[STAGE 3/4] Trimming & baking fades"),
            Some(0.75)
        );
        assert_eq!(
            parse_progress_line("[COMPLETE] 9:16 Short rendered: out.mp4"),
            Some(1.0)
        );
    }

    #[test]
    fn progress_ignores_other_lines() {
        assert_eq!(parse_progress_line("ffmpeg version 9.0"), None);
        assert_eq!(parse_progress_line(""), None);
        assert_eq!(parse_progress_line("[STAGE x/4] broken"), None);
        assert_eq!(parse_progress_line("[STAGE 1/0] broken"), None);
    }

    #[test]
    fn pipeline_args_skip_blank_optionals() {
        let req = RenderRequest {
            input_video: "in.mp4".to_string(),
            output_video: "out.mp4".to_string(),
            preset_id: "warm_cinematic".to_string(),
            agent_id: Some("claude".to_string()),
            subtitle_style: Some("  ".to_string()),
            subtitle_position: None,
            subtitle_size: None,
            subtitle_case: None,
            target_duration: Some(0.0),
            cut_start: None,
            cut_end: None,
            prompt_hook: None,
            elevenlabs_key: Some(String::new()),
            channel_context: None,
            meta_title: Some("Title".to_string()),
            meta_desc: None,
            meta_tags: None,
            aspect_ratio: None,
            layout: None,
            face_roi: None,
        };
        let args = req.to_pipeline_args("short_pipeline.py");
        // script + 3 required pairs = 7, agent pair = 2, duration pair = 2, title pair = 2
        assert_eq!(args.len(), 13);
        assert!(args.contains(&"--agent".to_string()));
        assert!(!args.contains(&"--subtitles".to_string()));
        assert!(!args.contains(&"--elevenlabs-key".to_string()));
        let dur_pos = args.iter().position(|a| a == "--duration").unwrap();
        assert_eq!(args[dur_pos + 1], "0");
    }

    #[test]
    fn pipeline_args_preserve_multiline_prompt_and_youtube_link_as_one_argument() {
        let prompt = "Open on the demo.\nUse https://youtu.be/abcdefghijk for pacing; keep it punchy.";
        let req: RenderRequest = serde_json::from_value(serde_json::json!({
            "input_video": "in.mp4", "output_video": "out.mp4",
            "preset_id": "warm_cinematic", "agent_id": "claude",
            "prompt_hook": prompt
        })).unwrap();
        let args = req.to_pipeline_args("short_pipeline.py");
        let position = args.iter().position(|arg| arg == "--prompt").unwrap();
        assert_eq!(args[position + 1], prompt);
        assert_eq!(args.iter().filter(|arg| arg.as_str() == prompt).count(), 1);
    }

    #[test]
    fn pipeline_args_include_manual_trim() {
        let mut req = RenderRequest {
            input_video: "in.mp4".to_string(),
            output_video: "out.mp4".to_string(),
            preset_id: "p".to_string(),
            agent_id: None,
            subtitle_style: None,
            subtitle_position: None,
            subtitle_size: None,
            subtitle_case: None,
            target_duration: None,
            cut_start: Some(2.5),
            cut_end: Some(9.0),
            prompt_hook: None,
            elevenlabs_key: None,
            channel_context: None,
            meta_title: None,
            meta_desc: None,
            meta_tags: None,
            aspect_ratio: None,
            layout: None,
            face_roi: None,
        };
        let args = req.to_pipeline_args("s.py");
        let joined = args.join(" ");
        assert!(joined.contains("--cut-start 2.5"), "{}", joined);
        assert!(joined.contains("--cut-end 9"), "{}", joined);

        // Zero start is meaningful (beginning of video) and must survive.
        req.cut_start = Some(0.0);
        let args = req.to_pipeline_args("s.py");
        let joined = args.join(" ");
        assert!(joined.contains("--cut-start 0"), "{}", joined);
    }

    #[test]
    fn pipeline_args_include_split_layout() {
        let req = RenderRequest {
            input_video: "in.mp4".to_string(),
            output_video: "out.mp4".to_string(),
            preset_id: "p".to_string(),
            agent_id: None,
            subtitle_style: None,
            subtitle_position: None,
            subtitle_size: None,
            subtitle_case: None,
            target_duration: None,
            cut_start: None,
            cut_end: None,
            prompt_hook: None,
            elevenlabs_key: None,
            channel_context: None,
            meta_title: None,
            meta_desc: None,
            meta_tags: None,
            aspect_ratio: None,
            layout: Some("screen-top".to_string()),
            face_roi: Some("auto".to_string()),
        };
        let joined = req.to_pipeline_args("s.py").join(" ");
        assert!(joined.contains("--layout screen-top"), "{}", joined);
        assert!(joined.contains("--face-roi auto"), "{}", joined);
    }

    #[test]
    fn pipeline_args_include_aspect_ratio() {
        let req = RenderRequest {
            input_video: "in.mp4".to_string(),
            output_video: "out.mp4".to_string(),
            preset_id: "p".to_string(),
            agent_id: None,
            subtitle_style: None,
            subtitle_position: None,
            subtitle_size: None,
            subtitle_case: None,
            target_duration: None,
            cut_start: None,
            cut_end: None,
            prompt_hook: None,
            elevenlabs_key: None,
            channel_context: None,
            meta_title: None,
            meta_desc: None,
            meta_tags: None,
            aspect_ratio: Some("1:1".to_string()),
            layout: Some("single".to_string()),
            face_roi: None,
        };
        let joined = req.to_pipeline_args("s.py").join(" ");
        assert!(joined.contains("--aspect-ratio 1:1"), "{}", joined);
    }

    #[test]
    fn registry_lifecycle() {
        let reg = JobRegistry::new();
        let req = RenderRequest {
            input_video: "in.mp4".to_string(),
            output_video: "out.mp4".to_string(),
            preset_id: "p".to_string(),
            agent_id: None,
            subtitle_style: None,
            subtitle_position: None,
            subtitle_size: None,
            subtitle_case: None,
            target_duration: None,
            cut_start: None,
            cut_end: None,
            prompt_hook: None,
            elevenlabs_key: None,
            channel_context: None,
            meta_title: None,
            meta_desc: None,
            meta_tags: None,
            aspect_ratio: None,
            layout: None,
            face_roi: None,
        };
        let id = create_render_job(&reg, &req);
        assert_eq!(reg.get(&id).unwrap().status, JobStatus::Queued);

        reg.set_running(&id);
        reg.update_progress(&id, 0.5, "[STAGE 2/4]");
        let info = reg.get(&id).unwrap();
        assert_eq!(info.status, JobStatus::Running);
        assert_eq!(info.progress, 0.5);

        // Cancel wins over a racing completion.
        assert!(reg.mark_cancelled(&id));
        reg.finish(
            &id,
            CommandOutput {
                success: true,
                code: 0,
                stdout: String::new(),
                stderr: String::new(),
                fallback_used: false,
            },
        );
        let info = reg.get(&id).unwrap();
        assert_eq!(info.status, JobStatus::Cancelled);
        assert!(info.result.is_none());
        // Second cancel is a no-op.
        assert!(!reg.mark_cancelled(&id));
    }

    #[test]
    fn pipeline_script_resolves_to_existing_helper_in_repo() {
        let path = resolve_pipeline_script();
        assert!(
            path.ends_with("short_pipeline.py"),
            "unexpected resolution: {}",
            path
        );
        assert!(
            std::path::Path::new(&path).exists(),
            "resolved helper missing: {}",
            path
        );
    }

    #[test]
    fn exe_candidates_cover_dev_and_bundle_layouts() {
        let dir = std::path::Path::new("/app/Contents/MacOS");
        let joined: Vec<String> = pipeline_exe_candidates(dir)
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect();
        assert!(joined.iter().any(|p| p.ends_with(
            "Resources/_up_/video-use/helpers/short_pipeline.py"
        )));
        assert!(joined.iter().any(|p| p
            .ends_with("../../video-use/helpers/short_pipeline.py")));
    }

    #[test]
    fn python_prefers_venv_then_platform_default() {
        let python = resolve_python();
        assert!(!python.is_empty());
        #[cfg(target_os = "windows")]
        assert!(python == "python" || python.ends_with("python.exe"));
        #[cfg(not(target_os = "windows"))]
        assert!(python == "python3" || python.ends_with("video-use/.venv/bin/python"));
    }
}
