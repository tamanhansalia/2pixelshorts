use crate::models::CliToolInfo;
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;

pub struct CliDefinition {
    pub id: &'static str,
    pub name: &'static str,
    pub binary: &'static str,
    pub version_flag: &'static str,
    pub description: &'static str,
    pub category: &'static str,
}

pub const KNOWN_TOOLS: &[CliDefinition] = &[
    // Core Media Processing CLIs
    CliDefinition {
        id: "ffmpeg",
        name: "FFmpeg",
        binary: "ffmpeg",
        version_flag: "-version",
        description: "Core video & audio transcoding, scaling, 9:16 filtering, and subtitle burning.",
        category: "media",
    },
    CliDefinition {
        id: "ffprobe",
        name: "FFprobe",
        binary: "ffprobe",
        version_flag: "-version",
        description: "Extracts video stream metadata, audio channels, duration, and frame rate.",
        category: "media",
    },
    CliDefinition {
        id: "python",
        name: "Python 3 Runtime",
        binary: "python",
        version_flag: "--version",
        description: "Executes the video-use helper pipeline (render.py, grade.py, transcribe.py).",
        category: "runtime",
    },
    CliDefinition {
        id: "ytdlp",
        name: "yt-dlp",
        binary: "yt-dlp",
        version_flag: "--version",
        description: "Downloads reference footage, audio, or assets from YouTube and online platforms.",
        category: "media",
    },
    CliDefinition {
        id: "manim",
        name: "Manim Community",
        binary: "manim",
        version_flag: "--version",
        description: "Mathematical and programmatic animation engine for diagram overlays.",
        category: "animation",
    },

    // AI Agent CLIs for Video Editing & Reasoning
    CliDefinition {
        id: "claude",
        name: "Claude Code CLI",
        binary: "claude",
        version_flag: "--version",
        description: "Anthropic Claude Code autonomous agent CLI for conversational video editing and EDL generation.",
        category: "agent",
    },
    CliDefinition {
        id: "codex",
        name: "Codex CLI",
        binary: "codex",
        version_flag: "--version",
        description: "OpenAI Codex CLI for terminal-driven coding, video workflows, and sub-agents.",
        category: "agent",
    },
    CliDefinition {
        id: "agy",
        name: "Antigravity CLI (AGY)",
        binary: "agy",
        version_flag: "--version",
        description: "Google DeepMind Antigravity CLI for pair-programming, multi-agent pipelines, and video tasks.",
        category: "agent",
    },
    CliDefinition {
        id: "grok",
        name: "Grok CLI",
        binary: "grok",
        version_flag: "--version",
        description: "xAI Grok terminal CLI for reasoning, scripting, and content generation.",
        category: "agent",
    },
];

/// Resolve the absolute path of an executable on the host OS
pub async fn resolve_binary_path(binary: &str) -> Option<String> {
    #[cfg(target_os = "windows")]
    let which_cmd = "where.exe";
    #[cfg(not(target_os = "windows"))]
    let which_cmd = "which";

    match timeout(Duration::from_secs(3), Command::new(which_cmd).kill_on_drop(true).arg(binary).output()).await {
        Ok(Ok(output)) if output.status.success() => {
            let out_str = String::from_utf8_lossy(&output.stdout);
            let first_line = out_str.lines().next().map(|s| s.trim().to_string());
            first_line
        }
        _ => None,
    }
}

/// Helper to build a process Command that safely executes .exe, .cmd, or standard binaries on Windows
fn build_command(executable: &str, arg: &str) -> Command {
    #[cfg(target_os = "windows")]
    {
        if executable.ends_with(".cmd") || executable.ends_with(".bat") {
            let mut cmd = Command::new("cmd.exe");
            cmd.kill_on_drop(true);
            cmd.args(["/C", executable, arg]);
            return cmd;
        }
    }
    let mut cmd = Command::new(executable);
    cmd.kill_on_drop(true);
    cmd.arg(arg);
    cmd
}

/// Probes a CLI executable to see if it is available and captures its version
pub async fn probe_cli(binary: &str, version_flag: &str) -> (bool, Option<String>, Option<String>) {
    let resolved_path = resolve_binary_path(binary).await;
    let probe_target = resolved_path.as_deref().unwrap_or(binary);

    let mut command = build_command(probe_target, version_flag);

    match timeout(Duration::from_secs(4), command.output()).await {
        Ok(Ok(output)) if output.status.success() => {
            let out_str = if !output.stdout.is_empty() {
                String::from_utf8_lossy(&output.stdout).to_string()
            } else {
                String::from_utf8_lossy(&output.stderr).to_string()
            };

            let version = out_str.lines().next().map(|line| {
                let trimmed = line.trim();
                if trimmed.starts_with("ffmpeg version ") {
                    trimmed.split_whitespace().take(3).collect::<Vec<_>>().join(" ")
                } else if trimmed.starts_with("ffprobe version ") {
                    trimmed.split_whitespace().take(3).collect::<Vec<_>>().join(" ")
                } else {
                    trimmed.to_string()
                }
            });

            (true, resolved_path, version)
        }
        _ => (false, resolved_path, None),
    }
}

/// Scans all standard CLIs in the system
pub async fn scan_all_clis() -> Vec<CliToolInfo> {
    let mut results = Vec::new();

    for def in KNOWN_TOOLS {
        let (mut is_available, mut path, mut version) =
            probe_cli(def.binary, def.version_flag).await;
        let mut command = def.binary.to_string();

        // macOS/Linux ship the interpreter as `python3`; Windows uses `python`.
        if def.id == "python" && !is_available {
            let fallback = probe_cli("python3", def.version_flag).await;
            if fallback.0 {
                is_available = fallback.0;
                path = fallback.1;
                version = fallback.2;
                command = "python3".to_string();
            }
        }

        results.push(CliToolInfo {
            id: def.id.to_string(),
            name: def.name.to_string(),
            command,
            path,
            version,
            is_available,
            is_enabled: is_available, // default enabled if detected
            description: def.description.to_string(),
            category: def.category.to_string(),
        });
    }

    results
}

/// Probe a user-specified custom CLI executable
pub async fn probe_custom_tool(name: String, path_or_command: String) -> CliToolInfo {
    let (is_available, path, version) = probe_cli(&path_or_command, "--version").await;

    CliToolInfo {
        id: format!("custom-{}", name.to_lowercase().replace(' ', "-")),
        name,
        command: path_or_command.clone(),
        path: path.or_else(|| if is_available { Some(path_or_command) } else { None }),
        version,
        is_available,
        is_enabled: is_available,
        description: "User registered custom CLI tool".to_string(),
        category: "custom".to_string(),
    }
}
