# Installation and troubleshooting

2pixelshorts currently supports building the desktop application from source.
No prebuilt release installer is published at the time of this guide.
Use the repository root for every npm and Cargo command below.

## Prerequisites

| Tool | Requirement |
| --- | --- |
| Git | Clone the repository |
| Node.js and npm | Node 24 or newer; `.nvmrc` selects 24 |
| Rust | Current stable toolchain, with Cargo |
| Python | 3.10+; 3.13 tested for local speech recognition |
| FFmpeg and FFprobe | On PATH; renders need H.264/AAC and the subtitles filter (libass) |
| yt-dlp | Optional for stream downloads and caption-based YouTube edit references |
| Agent CLI | Optional; install and authenticate a supported agent before selecting it |

Follow [Tauri's platform prerequisites](https://v2.tauri.app/start/prerequisites/)
for native build dependencies. On macOS install Xcode command-line tools. Windows
needs the MSVC Rust toolchain, Visual Studio C++ Build Tools, and WebView2. Linux
needs the distribution's GTK/WebKit development packages, a running desktop
session, and a working Secret Service provider for credential storage.

With Homebrew on macOS, `brew install ffmpeg python@3.13 yt-dlp` installs the
media/Python tools. Install Node and Rust separately. On Windows or Linux,
install those tools through their official installers or your package manager;
check that their executables are visible in a new terminal. The optional
Windows helper `scripts/windows/install_cpp_build_tools.bat` downloads the
Microsoft-signed installer instead of storing an executable in this repository.

```sh
node --version
npm --version
rustc --version
cargo --version
python3 --version
ffmpeg -version
ffprobe -version
yt-dlp --version
```

On Windows, use `python --version` instead of `python3 --version`.

## Clone and start

```sh
git clone https://github.com/tamanhansalia/2pixelshorts.git
cd 2pixelshorts
npm ci
npm run tauri -- dev
```

`npm run dev` runs a browser preview with simulated native operations.
`npm run tauri -- dev` runs the real desktop app. Set service keys through
Settings; do not put credentials in source files. Import a short synthetic video
and render it first before using production footage or publishing accounts.

## Local captions and face framing

The core engine uses Python's standard library and external FFmpeg. Install
OpenCV for offline face framing and faster-whisper for local captions. Setup
downloads the `tiny.en` speech model; subsequent normal recognition uses its
cache without a network fetch.

On macOS/Linux:

```sh
# Captions plus framing
./video-use/setup_local_stt.sh
# Or framing only
./video-use/setup_framing.sh
```

Set `PIXEL_PYTHON` to a supported interpreter if automatic discovery fails.
An existing environment using an older Python must be backed up and recreated;
copying a virtual environment between machines is not supported.

On Windows PowerShell:

```powershell
python -m venv video-use/.venv
$enginePython = "video-use/.venv/Scripts/python.exe"
& $enginePython -m pip install --upgrade pip
& $enginePython -m pip install -r video-use/requirements-local.txt
& $enginePython -c "from faster_whisper import WhisperModel; WhisperModel('tiny.en', device='cpu', compute_type='int8')"
```

For framing only, install `requirements-framing.txt` instead and skip the model
download. Creating the virtual environment with Python 3.13 is recommended.
The backend automatically prefers the interpreter in `video-use/.venv`.

## Build and use an installed app

```sh
npm run tauri -- build
```

Bundles appear in `src-tauri/target/release/bundle/` for the build platform.
Build on each target OS; cross-platform installers are not produced by this
single command. Signing/notarization for public distribution needs separate
platform credentials. A macOS debug QA build with its own data/credential
namespace is documented in the [validation report](e2e-security-review.md).

The Python helpers and face model are bundled, but Python, FFmpeg, agent CLIs,
and optional yt-dlp remain external runtime tools. Python virtual environments
are not included in installers. For an app launched independently of the clone,
install its stable per-user Python environment:

```sh
# macOS/Linux: run from your source clone once
./video-use/setup_local_stt.sh --managed
# Or framing only
./video-use/setup_framing.sh --managed
```

On Windows PowerShell:

```powershell
$engineDir = Join-Path $env:USERPROFILE ".2pixelshorts/video-use/.venv"
python -m venv $engineDir
$enginePython = Join-Path $engineDir "Scripts/python.exe"
& $enginePython -m pip install -r video-use/requirements-local.txt
& $enginePython -c "from faster_whisper import WhisperModel; WhisperModel('tiny.en', device='cpu', compute_type='int8')"
```

The stable `~/.2pixelshorts/video-use/.venv` location is preserved by the rename.
For framing only on Windows, use `requirements-framing.txt` and skip the speech
model download.

## Troubleshooting

- Missing compiler/WebKit/WebView: install the native prerequisites linked above.
- Missing helper: verify `video-use/helpers/short_pipeline.py` is present beside
  `src-tauri/`; don't build from a partial copy of the repository.
- Missing FFmpeg/FFprobe or yt-dlp: install them and restart the app/terminal.
- No local captions: use the correct Python environment, complete the model
  download, and check Settings' transcription status.
- Face-framing warning: install `requirements-framing.txt` into the environment
  actually used by the app. Without a detector the engine preserves the source.
- Browser renders are simulated: launch the native app to validate real output.
- Key-store failure on Linux: check the desktop Secret Service provider.
- Queue timestamps do not trigger background publishing: dispatch manually;
  see the current limits in the README.

macOS has the most extensive recorded verification. Windows/Linux require
platform smoke checks; the [review](e2e-security-review.md) describes remaining
service and platform verification.
