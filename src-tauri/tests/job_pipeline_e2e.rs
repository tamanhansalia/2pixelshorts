//! Headless end-to-end test for the job pipeline runner.
//!
//! Drives the real `video-use/helpers/short_pipeline.py` through
//! `run_pipeline_streaming` (the same function the Tauri job engine uses),
//! asserting streamed progress reaches 100% and a valid 9:16 short is
//! produced. Soft-skips when ffmpeg or the helper is unavailable.

use pixelshorts_lib::jobs::{parse_progress_line, run_pipeline_streaming, RenderRequest};
use std::path::PathBuf;
use std::process::Stdio;

fn repo_helper(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("video-use")
        .join("helpers")
        .join(rel)
}

fn python_cmd() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "python"
    }
    #[cfg(not(target_os = "windows"))]
    {
        "python3"
    }
}

fn have_binary(name: &str) -> bool {
    // NOTE: ffmpeg-family tools use single-dash `-version`; some static
    // builds exit non-zero on `--version`.
    std::process::Command::new(name)
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[tokio::test]
async fn streams_real_pipeline_to_completion() {
    let script = repo_helper("short_pipeline.py");
    if !script.is_file() {
        eprintln!("SKIP: {} not found", script.display());
        return;
    }
    for bin in ["ffmpeg", "ffprobe"] {
        if !have_binary(bin) {
            eprintln!("SKIP: {} not in PATH", bin);
            return;
        }
    }

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let dir = std::env::temp_dir().join(format!("job_e2e_{}", stamp));
    std::fs::create_dir_all(&dir).unwrap();
    let input = dir.join("input.mp4");
    let output = dir.join("short.mp4");

    // Self-contained 3s landscape fixture with audio.
    let gen = tokio::process::Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=1280x720:rate=24:duration=3",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=3",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-shortest",
        ])
        .arg(&input)
        .status()
        .await
        .expect("spawn ffmpeg fixture");
    assert!(gen.success(), "fixture generation failed");
    assert!(input.is_file(), "fixture was not written");
    let metadata = pixelshorts_lib::video_runner::probe_video_metadata(input.to_str().unwrap()).await.unwrap();
    assert_eq!(metadata.codec, "h264", "audio codec must not replace video codec");
    assert_eq!(metadata.fps, 24.0);
    assert_eq!(metadata.audio_channels, 1);

    let req = RenderRequest {
        input_video: input.to_string_lossy().into_owned(),
        output_video: output.to_string_lossy().into_owned(),
        preset_id: "neutral_punch".to_string(),
        agent_id: None,
        subtitle_style: Some("none".to_string()),
        subtitle_position: None,
        subtitle_size: None,
        subtitle_case: None,
        target_duration: Some(2.0),
        cut_start: None,
        cut_end: None,
        prompt_hook: None,
        elevenlabs_key: None,
        channel_context: None,
        meta_title: Some("job e2e".to_string()),
        meta_desc: None,
        meta_tags: None,
        aspect_ratio: None,
        layout: None,
        face_roi: None,
    };
    req.validate().unwrap();
    let mut invalid = req.clone();
    invalid.output_video = req.input_video.clone();
    assert!(invalid.validate().unwrap_err().contains("source"));
    invalid.output_video = output.to_string_lossy().into_owned();
    invalid.target_duration = Some(f64::NAN);
    assert!(invalid.validate().unwrap_err().contains("finite"));
    let args = req.to_pipeline_args(&script.to_string_lossy());

    let mut max_progress = 0.0f32;
    let mut saw_complete = false;
    let out = run_pipeline_streaming(python_cmd(), &args, |line| {
        if let Some(p) = parse_progress_line(line) {
            max_progress = max_progress.max(p);
        }
        if line.contains("[COMPLETE]") {
            saw_complete = true;
        }
    })
    .await
    .expect("pipeline spawn");

    assert!(out.success, "pipeline failed: {}", out.stderr);
    assert!(saw_complete, "never saw [COMPLETE]");
    assert!(
        (max_progress - 1.0).abs() < f32::EPSILON,
        "progress peaked at {}",
        max_progress
    );
    assert!(output.is_file(), "no output short produced");

    // Verify geometry via ffprobe: 1080x1920, ~2s.
    let probe = tokio::process::Command::new("ffprobe")
        .args([
            "-hide_banner",
            "-v",
            "error",
            "-show_entries",
            "stream=width,height",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1",
        ])
        .arg(&output)
        .output()
        .await
        .expect("spawn ffprobe");
    let text = String::from_utf8_lossy(&probe.stdout);
    assert!(text.contains("width=1080"), "not 1080 wide: {}", text);
    assert!(text.contains("height=1920"), "not 1920 high: {}", text);

    std::fs::remove_dir_all(&dir).ok();
}
