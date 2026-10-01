use crate::models::{CommandOutput, VideoMetadata};
use serde_json::Value;
use std::path::Path;
use tokio::process::Command;

/// Probe a video file using ffprobe to extract essential dimensions and duration
pub async fn probe_video_metadata(file_path: &str) -> Result<VideoMetadata, String> {
    if !Path::new(file_path).exists() {
        return Err(format!("File does not exist: {}", file_path));
    }

    // Run ffprobe to get stream and format JSON
    let output = Command::new("ffprobe")
        .args([
            "-v", "error",
            "-show_entries", "stream=width,height,duration,r_frame_rate,codec_name,channels",
            "-show_entries", "format=duration,size",
            "-of", "json",
            file_path,
        ])
        .output()
        .await
        .map_err(|e| format!("Failed to spawn ffprobe: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "ffprobe failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let json_val: Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Failed to parse ffprobe json output: {}", e))?;

    let mut width = 1080;
    let mut height = 1920;
    let mut fps = 30.0;
    let mut codec = "unknown".to_string();
    let mut audio_channels = 2;

    if let Some(streams) = json_val.get("streams").and_then(|s| s.as_array()) {
        for s in streams {
            if let Some(w) = s.get("width").and_then(|w| w.as_u64()) {
                width = w as u32;
            }
            if let Some(h) = s.get("height").and_then(|h| h.as_u64()) {
                height = h as u32;
            }
            if let Some(c) = s.get("codec_name").and_then(|c| c.as_str()) {
                codec = c.to_string();
            }
            if let Some(ch) = s.get("channels").and_then(|ch| ch.as_u64()) {
                audio_channels = ch as u32;
            }
            if let Some(rate) = s.get("r_frame_rate").and_then(|r| r.as_str()) {
                let parts: Vec<&str> = rate.split('/').collect();
                if parts.len() == 2 {
                    if let (Ok(num), Ok(den)) = (parts[0].parse::<f64>(), parts[1].parse::<f64>()) {
                        if den > 0.0 {
                            fps = (num / den * 100.0).round() / 100.0;
                        }
                    }
                }
            }
        }
    }

    let duration = json_val
        .get("format")
        .and_then(|f| f.get("duration"))
        .and_then(|d| d.as_str())
        .and_then(|d| d.parse::<f64>().ok())
        .unwrap_or(0.0);

    let file_size = json_val
        .get("format")
        .and_then(|f| f.get("size"))
        .and_then(|s| s.as_str())
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);

    Ok(VideoMetadata {
        file_path: file_path.to_string(),
        duration_seconds: (duration * 100.0).round() / 100.0,
        width,
        height,
        fps,
        codec,
        audio_channels,
        file_size_bytes: file_size,
    })
}

/// Execute a local CLI binary or script with provided arguments
pub async fn run_cli_process(
    command_name: &str,
    args: &[String],
    working_dir: Option<&str>,
) -> Result<CommandOutput, String> {
    #[cfg(target_os = "windows")]
    let mut cmd = if command_name.ends_with(".cmd") || command_name.ends_with(".bat") {
        let mut c = Command::new("cmd.exe");
        c.args(["/C", command_name]);
        c.args(args);
        c
    } else {
        let mut c = Command::new(command_name);
        c.args(args);
        c
    };

    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = Command::new(command_name);
        c.args(args);
        c
    };

    if let Some(dir) = working_dir {
        cmd.current_dir(dir);
    }

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to execute '{}': {}", command_name, e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    Ok(CommandOutput {
        success: output.status.success(),
        code: output.status.code().unwrap_or(-1),
        stdout,
        stderr,
    })
}
