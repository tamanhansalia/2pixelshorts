# 2pixelshorts — Complete Project Specification & Master Blueprint

> **A 100% local CLI-powered short-form video creation and social publishing studio.**  
> Built with **React (Vite) + Tailwind CSS + shadcn/ui + Tauri v2 + Rust**.

---

## 1. Executive Summary & Vision

### What is 2pixelshorts?
**2pixelshorts** is a desktop studio that bridges the gap between **local AI video editing** and **multi-platform automated publishing**.

Unlike tools like *BridgeClip* or cloud-only SaaS solutions that charge per-video subscriptions and send all footage to remote cloud agents:
- **Video Editing is 100% Local**: Uses local command-line tools (`ffmpeg`, `ffprobe`, `yt-dlp`, and the `video-use` Python helper pipeline) directly on your machine. Zero cloud processing fees.
- **External APIs are strictly limited to two services**:
  1. **ElevenLabs Scribe**: Word-level verbatim speech-to-text with timestamps for precision cutting.
  2. **Zernio API**: Unified REST API for social media account connections, queueing, and multi-platform publishing (YouTube Shorts, TikTok, Instagram Reels, X/Twitter, LinkedIn, Facebook).

---

## 2. Technology Stack

| Layer | Chosen Technology | Rationale |
| :--- | :--- | :--- |
| **Desktop Core** | **Tauri v2 (Rust)** | Native OS integration, ~15MB bundle size, ~40MB idle RAM (leaves CPU/GPU free for FFmpeg), native tray support, background threads. |
| **Frontend Framework** | **React + Vite (TypeScript)** | Instant HMR, typed IPC communication with Rust backend, massive UI ecosystem. |
| **Styling & Theme** | **Tailwind CSS** | Utility-first styling with native dark mode support for creative studio tools. |
| **Component Library** | **shadcn/ui (Radix UI)** | Accessible, high-end components (dialogs, command palettes, tabs, sliders, data tables). |
| **Local Storage** | **SQLite (rusqlite / sqlx)** | Stores CLI tool paths, editing presets, clip metadata, and scheduled post queues locally on disk. |
| **Process Supervision** | **tokio::process (Rust)** | Non-blocking subprocess execution, real-time stdout/stderr streaming (progress bars), clean process-tree termination. |
| **Video Editing Engine** | **video-use + FFmpeg 8.x** | Local Python & FFmpeg scripts for EDL generation, 30ms audio-fades, color grading, and subtitle burning. |
| **Transcription** | **ElevenLabs Scribe API** | Accurate word-level timestamps and audio events for speech-boundary cutting. |
| **Social Distribution** | **Zernio API** | Unified API for 16+ social platforms; handles OAuth and multi-platform publishing. |

---

## 3. High-Level Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                        REACT FRONTEND (Vite TS)                        │
│                                                                        │
│   ┌───────────────┐ ┌───────────────┐ ┌───────────────┐ ┌───────────┐  │
│   │  CLI Manager  │ │ Video Studio  │ │ Social Queue  │ │ Analytics │  │
│   │  & Scanner UI │ │ & Presets     │ │ & Calendar    │ │ & History │  │
│   └───────┬───────┘ └───────┬───────┘ └───────┬───────┘ └─────┬─────┘  │
│           │                 │                 │               │        │
│           └─────────────────┴────────┬────────┴───────────────┘        │
│                                      │                                 │
│                         Tauri IPC (`invoke` / `listen`)                │
└──────────────────────────────────────┼─────────────────────────────────┘
                                       │
┌──────────────────────────────────────▼─────────────────────────────────┐
│                           TAURI v2 RUST CORE                           │
│                                                                        │
│   ┌───────────────────┐ ┌───────────────────┐ ┌────────────────────┐   │
│   │ CLI Scanner &     │ │ Process Runner    │ │ SQLite Engine      │   │
│   │ Path Registry     │ │ (tokio::process)  │ │ (Clips, Schedules) │   │
│   └─────────┬─────────┘ └─────────┬─────────┘ └─────────┬──────────┘   │
│             │                     │                     │              │
│   ┌─────────▼─────────┐ ┌─────────▼─────────┐ ┌─────────▼──────────┐   │
│   │ Background Tick   │ │ Zernio Client     │ │ ElevenLabs Client  │   │
│   │ Scheduler Engine  │ │ (reqwest HTTPS)   │ │ (reqwest HTTPS)    │   │
│   └───────────────────┘ └───────────────────┘ └────────────────────┘   │
└──────────────┬────────────────────────┬──────────────────────┬─────────┘
               │                        │                      │
┌──────────────▼─────────────┐ ┌────────▼────────────┐ ┌───────▼─────────┐
│ Local System Tools:        │ │ Zernio REST API:    │ │ ElevenLabs API: │
│ • ffmpeg / ffprobe         │ │ • YouTube Shorts    │ │ • Scribe STT    │
│ • video-use helpers        │ │ • TikTok            │ │   (Word-level   │
│ • yt-dlp                   │ │ • Instagram Reels   │ │   timestamps)   │
│ • python 3.13              │ │ • X / LinkedIn / FB │ │                 │
└────────────────────────────┘ └─────────────────────┘ └─────────────────┘
```

---

## 4. Core Modules & Responsibilities

### Module 1: CLI Scanner & Manager
- **Auto-Discovery**: Scans system `PATH` on launch for known binaries across two categories:
  - **AI Video-Editing Agents**:
    - `claude` (Anthropic Claude Code CLI: conversational video editing, EDL assembly)
    - `codex` (OpenAI Codex CLI: sub-agent orchestration)
    - `agy` (Google DeepMind Antigravity CLI: multi-agent pair programming)
    - `grok` (xAI Grok terminal CLI)
    - `gemini` (Google Gemini CLI)
  - **Media Processing & Runtimes**:
    - `ffmpeg` / `ffprobe` (scaling, 9:16 crop, 30ms audio fades, subtitle burning)
    - `python` / `python3` (runs `video-use` helper scripts)
    - `yt-dlp` (downloads reference footage and assets)
    - `manim` (programmatic animations)
- **Validation**: Executes `<cli> --version` or `-v` to confirm health and retrieve version string. Handles `.cmd`/`.bat` files on Windows.
- **Custom CLIs**: Allows adding custom tool paths (e.g. portable ffmpeg, specific virtual environment python, or custom local agent binaries).
- **Toggles**: Enable or disable specific tools for different operations without uninstalling.
- **Removal**: Unregister paths from the local registry without deleting files from disk.

### Module 2: Video Studio & Presets
- **Import Footage**: Drag-and-drop raw clips into the workspace.
- **Probe Metadata**: Calls `ffprobe` to inspect duration, resolution, aspect ratio, audio channels, and FPS.
- **video-use Pipeline**:
  1. `transcribe.py`: Calls ElevenLabs Scribe to output word-level JSON.
  2. `pack_transcripts.py`: Generates `takes_packed.md` for fast editorial cuts.
  3. `grade.py`: Color grades per segment (e.g., `warm_cinematic`, `neutral_punch`).
  4. `render.py`: Concat, audio crossfades (30ms), overlays, and output-timeline subtitles.
- **Presets**:
  - **Social Vertical (9:16)**: 1080x1920 @ 30/60fps, 2-word uppercase bold subtitles, centered framing.
  - **Talking Head Focus**: Auto-crop, silence trimmer (<0.4s gap removal), warm color grade.
  - **Fast Teaser / Launch**: High-pace cuts, typewriter overlay, dynamic captions.

### Module 3: Zernio Social Integration
- **OAuth Connection**: Connect accounts through Zernio dashboard or browser authentication redirect.
- **Platform Selection**: Toggle destinations (YouTube, TikTok, Instagram, X) per video.
- **Per-Platform Metadata**:
  - Title and description.
  - Platform-specific hashtags.
  - Custom thumbnail selection.
- **Publish Now vs. Schedule**: Direct publish or queue for later.

### Module 4: Scheduler & Background Queue
- **Schedule Management**: Pick target date, time, and timezone.
- **SQLite Persistence**: Scheduled items persist across app restarts.
- **Background Worker**:
  - Periodic tick (e.g. every 60 seconds) checks for due posts.
  - Triggers the Zernio publishing endpoint.
  - Logs status: `queued` → `uploading` → `published` | `failed`.
- **System Tray Mode**: Minimizes to system tray on Windows so scheduled publishing continues even when the main window is closed.

---

## 5. File Structure Blueprint

```
2pixelspace-short/
├── PROJECT_SPEC.md                 # This master blueprint
├── video-use/                      # Existing video-use engine & helpers
│   ├── helpers/                    # transcribe.py, render.py, grade.py, etc.
│   └── ...
│
├── 2pixelshorts/                   # Tauri v2 Desktop App
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   ├── tailwind.config.js
│   ├── components.json             # shadcn/ui configuration
│   │
│   ├── src/                        # React Frontend
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── index.css
│   │   │
│   │   ├── components/
│   │   │   ├── ui/                 # shadcn/ui primitives (Button, Dialog, Card, etc.)
│   │   │   ├── layout/
│   │   │   │   ├── Sidebar.tsx
│   │   │   │   ├── Header.tsx
│   │   │   │   └── AppLayout.tsx
│   │   │   ├── cli/
│   │   │   │   ├── CLIManagerModal.tsx
│   │   │   │   ├── CLIToolCard.tsx
│   │   │   │   └── CustomCLIPicker.tsx
│   │   │   ├── studio/
│   │   │   │   ├── ClipDropzone.tsx
│   │   │   │   ├── VideoPlayer.tsx
│   │   │   │   ├── PresetSelector.tsx
│   │   │   │   ├── TranscriptEditor.tsx
│   │   │   │   └── RenderProgressBar.tsx
│   │   │   ├── social/
│   │   │   │   ├── AccountList.tsx
│   │   │   │   ├── PostComposer.tsx
│   │   │   │   └── PlatformToggles.tsx
│   │   │   └── scheduler/
│   │   │       ├── CalendarView.tsx
│   │   │       ├── QueueList.tsx
│   │   │       └── ScheduleModal.tsx
│   │   │
│   │   ├── hooks/
│   │   │   ├── useCLI.ts           # Interacts with Rust CLI commands
│   │   │   ├── useStudio.ts        # Manages video editing state & rendering
│   │   │   ├── useZernio.ts        # Connects accounts & triggers publish
│   │   │   └── useScheduler.ts     # Fetches and mutates scheduled queue
│   │   │
│   │   ├── stores/                 # Zustand state stores
│   │   │   ├── cliStore.ts
│   │   │   ├── studioStore.ts
│   │   │   └── scheduleStore.ts
│   │   │
│   │   └── lib/
│   │       ├── tauri.ts            # Typed Tauri invoke wrapper
│   │       ├── types.ts            # Shared TypeScript interfaces
│   │       └── utils.ts            # shadcn cn() and formatting helpers
│   │
│   └── src-tauri/                  # Tauri Rust Backend
│       ├── Cargo.toml
│       ├── tauri.conf.json
│       ├── capabilities/           # Tauri v2 security capabilities
│       │   └── default.json
│       └── src/
│           ├── main.rs             # Tauri application entry point
│           ├── lib.rs              # Tauri setup & command registration
│           │
│           ├── commands/           # Tauri IPC commands
│           │   ├── mod.rs
│           │   ├── cli.rs          # scan_clis, add_cli, remove_cli, toggle_cli
│           │   ├── video.rs        # probe_clip, run_transcribe, run_render
│           │   ├── zernio.rs       # get_accounts, publish_post
│           │   └── scheduler.rs    # get_queue, add_schedule, delete_schedule
│           │
│           ├── core/               # Business logic
│           │   ├── mod.rs
│           │   ├── cli_scanner.rs  # PATH scanning & version probing
│           │   ├── process_runner.rs # tokio::process spawner with event emit
│           │   ├── db.rs           # SQLite connection & migrations
│           │   ├── scheduler_loop.rs # Background tokio timer loop
│           │   └── zernio_client.rs# reqwest client for Zernio REST API
│           │
│           └── models/             # Rust data structures
│               ├── mod.rs
│               ├── cli_tool.rs
│               ├── preset.rs
│               └── schedule_job.rs
```

---

## 6. Tauri IPC Command Interface (Contract)

### CLI Management Commands
```rust
#[tauri::command]
async fn scan_system_clis() -> Result<Vec<CliToolInfo>, String>;

#[tauri::command]
async fn add_custom_cli(name: String, path: String) -> Result<CliToolInfo, String>;

#[tauri::command]
async fn remove_cli(id: String) -> Result<(), String>;

#[tauri::command]
async fn toggle_cli(id: String, enabled: bool) -> Result<(), String>;
```

### Video Processing & video-use Commands
```rust
#[tauri::command]
async fn probe_video_file(file_path: String) -> Result<VideoMetadata, String>;

#[tauri::command]
async fn execute_render(
    project_dir: String,
    edl_config: EdlPayload,
    preset: VideoPreset
) -> Result<String, String>;

#[tauri::command]
async fn cancel_active_render(process_id: String) -> Result<(), String>;
```

### Scheduler & Zernio Commands
```rust
#[tauri::command]
async fn get_zernio_accounts(api_key: String) -> Result<Vec<SocialAccount>, String>;

#[tauri::command]
async fn schedule_video_post(payload: SchedulePostPayload) -> Result<ScheduleJob, String>;

#[tauri::command]
async fn get_scheduled_queue() -> Result<Vec<ScheduleJob>, String>;

#[tauri::command]
async fn cancel_scheduled_job(job_id: String) -> Result<(), String>;
```

---

## 7. Phased Implementation Roadmap

### Phase 1: Foundation (Scaffold + CLI Scanner)
1. Initialize Tauri v2 with React (Vite + TypeScript).
2. Configure Tailwind CSS and add initial shadcn/ui components (`button`, `card`, `dialog`, `badge`, `tabs`).
3. Implement Rust `cli_scanner.rs` to detect `ffmpeg`, `ffprobe`, `python`, `yt-dlp`.
4. Build the **CLI Manager UI** where users can view detected tools, see their versions, and add custom paths.

### Phase 2: video-use Pipeline Integration
1. Implement Rust `process_runner.rs` to spawn Python scripts with real-time stdout/stderr event streaming to the frontend.
2. Build the **Video Studio UI**: Clip drag-and-drop, metadata display, and preset selector (e.g. Vertical 9:16, Subtitle styles).
3. Connect `transcribe.py` (ElevenLabs) and `render.py` (FFmpeg) with live progress bars.
4. Render and display the final video preview in the UI.

### Phase 3: Zernio API & Social Account Linking
1. Implement secure local API key storage for Zernio and ElevenLabs.
2. Build the **Social Hub UI**: Display connected platforms (YouTube, TikTok, Instagram, X).
3. Connect the publishing endpoint to send completed MP4 clips and captions.

### Phase 4: Scheduler & Background Queue
1. Set up local SQLite database for persistent queue management.
2. Build the **Scheduler Calendar / Queue UI**: Pick publish date, time, and target platforms.
3. Implement the Rust background tick loop that checks the queue every minute and posts via Zernio when due.
4. Configure Tauri v2 System Tray so the app keeps queue checking alive when minimized.

---

## 8. How to Build & Run (Quick Reference)

### Prerequisites Check
```powershell
rustc --version       # Ensure Rust is >= 1.80
cargo --version
node --version        # Ensure Node is >= 20
npm --version
python --version      # Python 3.10+
ffmpeg -version       # FFmpeg installed & in PATH
```

### Development Run
```powershell
cd 2pixelshorts
npm install
npm run tauri dev
```

### Production Build
```powershell
cd 2pixelshorts
npm run tauri build
```
The output `.exe` installer will be generated in `2pixelshorts/src-tauri/target/release/bundle/msi` or `nsis`.
