use crate::models::{CommandOutput, VideoMetadata};
use serde_json::Value;
use std::path::Path;
use tokio::process::Command;

pub(crate) struct ProcessTree(Option<u32>);
impl ProcessTree {
    pub(crate) fn configure(command: &mut Command) {
        #[cfg(unix)] {
            use std::os::unix::process::CommandExt;
            command.as_std_mut().process_group(0);
        }
        #[cfg(not(unix))] let _ = command;
    }
    pub(crate) fn new(child: &tokio::process::Child) -> Self { Self(child.id()) }
}
impl Drop for ProcessTree {
    fn drop(&mut self) {
        #[cfg(unix)] if let Some(pid) = self.0 {
            // The child owns a separate group, including media/agent workers.
            unsafe { libc::kill(-(pid as i32), libc::SIGKILL); }
        }
    }
}

/// Generated Python helper invocations use environment variables for secrets
/// so process listings cannot expose the user's API keys.
pub(crate) fn private_process_args(args: &[String]) -> (Vec<String>, Vec<(&'static str, String)>) {
    let mut clean = Vec::new();
    let mut secrets = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let variable = match args[i].as_str() {
            "--elevenlabs-key" => Some("PIXEL_ELEVENLABS_KEY"),
            "--api-key" => Some("PIXEL_YOUTUBE_KEY"),
            _ => None,
        };
        if let Some(variable) = variable {
            if let Some(value) = args.get(i + 1) {
                secrets.push((variable, value.clone()));
                i += 2;
                continue;
            }
        }
        clean.push(args[i].clone());
        i += 1;
    }
    (clean, secrets)
}

pub(crate) fn redact_secrets(mut text: String, secrets: &[(&str, String)]) -> String {
    for (_, secret) in secrets {
        if !secret.is_empty() { text = text.replace(secret, "[REDACTED]"); }
    }
    text
}

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
            "-i",
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
    let mut audio_channels = 0;

    if let Some(streams) = json_val.get("streams").and_then(|s| s.as_array()) {
        for s in streams {
            if let Some(w) = s.get("width").and_then(|w| w.as_u64()) {
                width = w as u32;
            }
            if let Some(h) = s.get("height").and_then(|h| h.as_u64()) {
                height = h as u32;
            }
            if s.get("width").is_some() {
            if let Some(c) = s.get("codec_name").and_then(|c| c.as_str()) {
                codec = c.to_string();
            }
            }
            if let Some(ch) = s.get("channels").and_then(|ch| ch.as_u64()) {
                audio_channels = ch as u32;
            }
            if let Some(rate) = s.get("r_frame_rate").filter(|_| s.get("width").is_some()).and_then(|r| r.as_str()) {
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

/// Finder/desktop launchers may omit the directories where local media
/// tools are installed. Preserve the existing search path and add known
/// user/Homebrew locations before any native worker threads are started.
pub fn configure_media_tool_path() {
    #[cfg(unix)]
    {
        let entries = std::env::var_os("PATH")
            .map(|value| std::env::split_paths(&value).collect())
            .unwrap_or_default();
        let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
        if let Ok(value) = std::env::join_paths(media_path_entries(entries, home.as_deref())) {
            std::env::set_var("PATH", value);
        }
    }
}

#[cfg(unix)]
fn media_path_entries(mut entries: Vec<std::path::PathBuf>, home: Option<&Path>) -> Vec<std::path::PathBuf> {
    let mut additions = Vec::new();
    if let Some(home) = home {
        additions.push(home.join(".local/bin"));
    }
    additions.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(std::path::PathBuf::from));
    for directory in additions.into_iter().rev() {
        if directory.is_dir() && !entries.contains(&directory) {
            entries.insert(0, directory);
        }
    }
    entries
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn desktop_path_finds_local_media_tools_with_only_system_path() {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let home = std::env::temp_dir().join(format!("media_path_{}", stamp));
        let bin = home.join(".local/bin");
        std::fs::create_dir_all(&bin).unwrap();
        let tool = bin.join("ffmpeg");
        std::fs::write(&tool, "#!/bin/sh\necho local-media-ready\n").unwrap();
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o700)).unwrap();
        let original = vec![std::path::PathBuf::from("/usr/bin"), std::path::PathBuf::from("/bin")];
        let entries = media_path_entries(original.clone(), Some(&home));
        assert!(original.iter().all(|entry| entries.contains(entry)));
        let path = std::env::join_paths(&entries).unwrap();
        let output = std::process::Command::new("ffmpeg").env("PATH", path).arg("-version").output().unwrap();
        assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "local-media-ready");
        assert_eq!(media_path_entries(entries.clone(), Some(&home)), entries);
        std::fs::remove_dir_all(home).unwrap();
    }
}
/// Execute a local CLI binary or script with provided arguments
pub async fn run_cli_process(
    command_name: &str, args: &[String], working_dir: Option<&str>,
) -> Result<CommandOutput, String> {
    run_process(command_name, args, working_dir, false).await
}

/// Privacy handling is reserved for the app's generated helper commands.
/// A user-supplied CLI/script keeps the arguments the user actually entered.
pub async fn run_helper_process(
    command_name: &str, args: &[String], working_dir: Option<&str>,
) -> Result<CommandOutput, String> {
    run_process(command_name, args, working_dir, true).await
}

async fn run_process(
    command_name: &str, args: &[String], working_dir: Option<&str>, is_helper: bool,
) -> Result<CommandOutput, String> {
    let (private_args, secrets) = if is_helper { private_process_args(args) } else { (args.to_vec(), Vec::new()) };
    let args = &private_args;
    #[cfg(target_os = "windows")]
    let mut cmd = if command_name.ends_with(".cmd") || command_name.ends_with(".bat") {
        let mut c = Command::new("cmd.exe");
        c.args(["/C", command_name]);
        c.args(args);
        c.kill_on_drop(true);
        c
    } else {
        let mut c = Command::new(command_name);
        c.args(args);
        c.kill_on_drop(true);
        c
    };

    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = Command::new(command_name);
        c.args(args);
        c.kill_on_drop(true);
        c
    };

    if let Some(dir) = working_dir {
        cmd.current_dir(dir);
    }
    if is_helper { cmd.env("PIXEL_ELEVENLABS_KEY", "").env("PIXEL_YOUTUBE_KEY", ""); }
    for (name, secret) in &secrets { cmd.env(name, secret); }
    if is_helper { cmd.env("PYTHONUNBUFFERED", "1"); }

    ProcessTree::configure(&mut cmd);
    cmd.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    let child = cmd.spawn().map_err(|e| format!("Failed to execute '{}': {}", command_name, e))?;
    let _tree = ProcessTree::new(&child);
    let output = child
        .wait_with_output()
        .await
        .map_err(|e| format!("Failed to execute '{}': {}", command_name, e))?;

    let stdout = redact_secrets(String::from_utf8_lossy(&output.stdout).to_string(), &secrets);
    let stderr = redact_secrets(String::from_utf8_lossy(&output.stderr).to_string(), &secrets);

    Ok(CommandOutput {
        success: output.status.success(),
        code: output.status.code().unwrap_or(-1),
        stdout,
        stderr,
        fallback_used: false,
    })
}
