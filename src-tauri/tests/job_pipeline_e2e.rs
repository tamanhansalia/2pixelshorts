//! Headless end-to-end test for the job pipeline runner.
//!
//! Drives the real `video-use/helpers/short_pipeline.py` through
//! `run_pipeline_streaming` (the same function the Tauri job engine uses),
//! asserting streamed progress reaches 100% and a valid 9:16 short is
//! produced. Soft-skips when ffmpeg or the helper is unavailable.

use pixelshorts_lib::jobs::{parse_progress_line, resolve_python, run_pipeline_streaming, RenderRequest};
use std::path::PathBuf;
use std::process::Stdio;

fn repo_helper(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("video-use")
        .join("helpers")
        .join(rel)
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

/// Opt-in real speech fixture: a sentence spoken twice, pauses, and a unique
/// closing thought. Exercises the actual app request/interpreter/worker path.
#[tokio::test]
async fn real_speech_cleanup_keeps_the_later_take_and_the_ending() {
    let Ok(source) = std::env::var("PIXEL_E2E_SPEECH_SOURCE") else { return; };
    let directory = std::env::var("PIXEL_E2E_OUTPUT_DIR").expect("set output directory for retained QA artifacts");
    let output = PathBuf::from(directory).join("native-cleanup.mp4");
    let req: RenderRequest = serde_json::from_value(serde_json::json!({
        "input_video": source, "output_video": output, "preset_id": "warm_cinematic",
        "edit_strategy": "cleanup", "agent_id": "auto", "remove_silence": true,
        "remove_retakes": true, "subtitle_style": "hype", "subtitle_position": "center",
        "subtitle_size": "standard", "subtitle_case": "uppercase", "layout": "auto",
        "aspect_ratio": "9:16", "face_roi": "auto"
    })).unwrap();
    req.validate().unwrap();
    let script = pixelshorts_lib::jobs::resolve_pipeline_script();
    let (mut args, _plan) = req.prepare_pipeline_args(&script).unwrap();
    args.extend(["--engine".into(), "local".into()]);
    let result = run_pipeline_streaming(&resolve_python(), &args, |_| {}).await.unwrap();
    std::fs::write(output.with_extension("log.txt"), format!("{}\n{}", result.stdout, result.stderr)).unwrap();
    assert!(result.success, "real edit failed: {}", result.stderr);
    assert!(!result.fallback_used);
    assert!(result.stdout.contains("video-use cleanup"));
    let evidence: serde_json::Value = serde_json::from_slice(&std::fs::read(format!("{}.edit.json", output.display())).unwrap()).unwrap();
    assert_eq!(evidence["strategy"], "cleanup");
    assert!(!evidence["removals"].as_array().unwrap().is_empty(), "the repeated first take was not removed: {}", evidence);
    let segments = evidence["segments"].as_array().unwrap();
    assert!(segments[0]["start"].as_f64().unwrap() > 9.0, "must retain the later take, not the earlier one");
    assert!(segments.last().unwrap()["end"].as_f64().unwrap() > 25.0, "must retain the unique closing thought");
    assert!(segments.last().unwrap()["end"].as_f64().unwrap() < evidence["source_duration"].as_f64().unwrap() - 0.8,
            "speech detection must not invent words and retain the empty outro");
    let actual = pixelshorts_lib::video_runner::probe_video_metadata(output.to_str().unwrap()).await.unwrap();
    assert_eq!((actual.width, actual.height), (1080, 1920));
    assert_eq!(actual.audio_channels, 1);
    assert!(actual.duration_seconds > 13.0 && actual.duration_seconds < 18.0, "unexpected edited duration: {}", actual.duration_seconds);
    let report: serde_json::Value = serde_json::from_slice(&std::fs::read(output.with_extension("framing.json")).unwrap()).unwrap();
    assert_eq!(report["validation"]["passed"], true);
    assert!((report["validation"]["expected_duration"].as_f64().unwrap() - actual.duration_seconds).abs() < 0.15);
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
    let dir = std::env::temp_dir().join(format!("job_e2e_café_🎬_{}", stamp));
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
        model_id: None,
        subtitle_style: Some("none".to_string()),
        subtitle_position: None,
        subtitle_size: None,
        subtitle_case: None,
        target_duration: Some(2.0),
        cut_start: None,
        cut_end: None,
        prompt_hook: None,
        elevenlabs_key: None,
        transcription_provider: Some("local".into()),
        channel_context: None,
        meta_title: Some("job e2e".to_string()),
        // FFmpeg truncates long Unicode metadata in its stderr log, which
        // used to crash Python's strict decoding after a successful render.
        meta_desc: Some(format!("a{}", "–🎬".repeat(1200))),
        meta_tags: None,
        aspect_ratio: None,
        layout: None,
        face_roi: None,
        edit_plan: None,
        edit_strategy: None,
        remove_silence: None,
        remove_retakes: None,
    };
    req.validate().unwrap();
    let mut invalid = req.clone();
    invalid.output_video = req.input_video.clone();
    assert!(invalid.validate().unwrap_err().contains("source"));
    invalid.output_video = output.to_string_lossy().into_owned();
    invalid.target_duration = Some(f64::NAN);
    assert!(invalid.validate().unwrap_err().contains("finite"));
    let mut args = req.to_pipeline_args(&script.to_string_lossy());
    // This offline media fixture does not need speech; legacy CLI auto may
    // use local Whisper or a placeholder. Explicit cloud now requires a key.
    args.extend(["--engine".to_string(), "auto".to_string()]);
    let python = resolve_python();

    let mut max_progress = 0.0f32;
    let mut saw_complete = false;
    let out = run_pipeline_streaming(&python, &args, |line| {
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

    // The same native runner must honor an approved full-source edit,
    // even with a shorter target and an editing model present.
    let mut approved = req.clone();
    let full = dir.join("approved-full.mp4");
    approved.output_video = full.to_string_lossy().into_owned();
    approved.target_duration = Some(1.0);
    approved.agent_id = Some("codex".into());
    approved.subtitle_style = Some("pop".into());
    approved.edit_plan = Some(serde_json::json!({
        "version": 1, "source_path": input, "source_duration": 3.0,
        "segments": [{"start": 0.0, "end": 3.0}],
        "words": [{"word": "corrected", "start": 0.2, "end": 1.0}]
    }));
    approved.validate().unwrap();
    let (args, plan_file) = approved.prepare_pipeline_args(&script.to_string_lossy()).unwrap();
    let plan_path = plan_file.as_ref().unwrap().path().to_path_buf();
    assert!(plan_path.is_file());
    assert_eq!(serde_json::from_slice::<serde_json::Value>(&std::fs::read(&plan_path).unwrap()).unwrap(),
               approved.edit_plan.clone().unwrap());
    let out = run_pipeline_streaming(&python, &args, |_| {}).await.unwrap();
    assert!(out.success, "approved edit failed: {}", out.stderr);
    assert!(out.stdout.contains("Your edit: 3.00s"));
    let metadata = pixelshorts_lib::video_runner::probe_video_metadata(full.to_str().unwrap()).await.unwrap();
    assert!((metadata.duration_seconds - 3.0).abs() < 0.15);
    drop(plan_file);
    assert!(!plan_path.exists(), "temporary transcript edit was not cleaned up");

    // The same native request builder must route automation to video-use,
    // without reusing a transcript plan or imposing the old duration cap.
    let automatic = dir.join("automatic_full.mp4");
    let mut automated = req.clone();
    automated.output_video = automatic.to_string_lossy().into_owned();
    automated.edit_strategy = Some("full".into());
    automated.remove_silence = Some(false);
    automated.remove_retakes = Some(false);
    automated.target_duration = Some(1.0);
    automated.validate().unwrap();
    let mut args = automated.to_pipeline_args(&script.to_string_lossy());
    args.extend(["--engine".into(), "auto".into()]);
    let out = run_pipeline_streaming(&python, &args, |_| {}).await.unwrap();
    assert!(out.success, "automation failed: {}", out.stderr);
    assert!(out.stdout.contains("video-use full: 3.00s"));
    let evidence: serde_json::Value = serde_json::from_slice(&std::fs::read(format!("{}.edit.json", automatic.display())).unwrap()).unwrap();
    assert_eq!(evidence["strategy"], "full");
    assert_eq!(evidence["remove_silence"], false);
    assert_eq!(evidence["remove_retakes"], false);
    assert_eq!(evidence["source_path"], input.canonicalize().unwrap().to_string_lossy().as_ref());
    let metadata = pixelshorts_lib::video_runner::probe_video_metadata(automatic.to_str().unwrap()).await.unwrap();
    assert!((metadata.duration_seconds - 3.0).abs() < 0.15);

    std::fs::remove_dir_all(&dir).ok();
}
