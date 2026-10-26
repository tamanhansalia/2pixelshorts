<p align="center">
  <img src="public/brand/logo-256.png" width="96" height="96" alt="2pixelshorts logo" />
</p>

# 2pixelshorts

A desktop video studio and social publisher for vertical shorts, built with
Tauri, React, TypeScript, Rust, and a local Python video engine.

Import footage, choose cuts and captions, render shorts, manage a local queue,
and publish through connected Zernio accounts. Local transcription and face
framing are available without a cloud API key. Editing agents and external
publishing services are optional and require their own installations/accounts.

## Install and run from source

Install Git, **Node.js 24+**, stable Rust, **Python 3.10+** (3.13 tested),
FFmpeg/FFprobe, and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/).
For stream downloads and YouTube editing references, install `yt-dlp` too.

```sh
git clone https://github.com/tamanhansalia/2pixelshorts.git
cd 2pixelshorts
npm ci
npm run tauri -- dev
```

The clone is already the application root. No files need to be moved or copied.
See [installation and troubleshooting](docs/installation.md) for macOS,
Windows, Linux, local captions/framing, and building an installer.

On macOS/Linux, enable local captions and framing once:

```sh
./video-use/setup_local_stt.sh
```

This creates an ignored Python environment and downloads the English `tiny.en`
speech model. Python and FFmpeg remain runtime requirements for a packaged app;
see the guide for installing the managed engine environment.

## Studio workflow

Studio keeps one video project across five stages. You can revisit any stage
after importing a video, and your choices are saved on this computer.

1. **Video:** import a local recording, or find and import clips from a public
   YouTube or Twitch VOD link with Auto cut or your configured CLI.
2. **Edit & format:** clean up pauses and repeated takes, find an AI highlight,
   or keep the entire video. Optionally turn on **Add custom instructions**
   alongside any mode, including YouTube pacing references. The AI editing CLI
   selector is always visible and uses the CLI’s configured model automatically.
   Choose color, aspect ratio, and framing here too.
3. **Captions:** choose a style, position, size, and casing, or turn captions off.
   The caption sample demonstrates the style; export to see it on your footage.
4. **Title & tags:** optionally edit publishing details, review the analysis,
   apply channel context, or fetch keyword trends.
5. **Export:** review the settings, choose the output path, and export an MP4.
   Progress, cancellation, processing details, and render history stay available.

The preview shows the original recording or the latest completed export.
Finished exports can be opened, revealed in their folder, queued, or sent to
Social. Custom instructions use your installed CLI and its configured account;
the provider may charge for AI planning. Video rendering runs locally.

## Project structure

```text
2pixelshorts/
├── src/             # React interface, stores, IPC, and frontend tests
├── src-tauri/       # Rust desktop backend, native icons, and integration tests
├── video-use/       # Python video engine, bundled face model, setup, and tests
├── public/          # Web branding and subtitle preview images
├── scripts/         # Branding and Windows build-tool setup
├── docs/            # Setup, architecture, design, and validation notes
└── .github/         # Automated checks and issue templates
```

See the [structure and architecture guide](docs/project-structure.md) and
[video engine documentation](video-use/README.md).

## Development checks

```sh
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

Run the Python suite with the engine environment:

```sh
# macOS/Linux
video-use/.venv/bin/python -m unittest discover -s video-use/tests
# Windows PowerShell
video-use/.venv/Scripts/python.exe -m unittest discover -s video-use/tests
```

Build the desktop application with `npm run tauri -- build`. Generated bundles
are under `src-tauri/target/release/bundle/`. Browser development with `npm run dev`
shows the interface without running local tools; use the native app to test rendering,
credential storage, file actions, and publishing.

## Current behavior and limits

Desktop API keys use the OS credential store. Legacy plaintext keys are removed
only after successful migration. Browser preview keys stay in session memory.
Settings verifies keys through read-only provider requests.

The local queue requires manual dispatch; a saved future timestamp does not
publish automatically while the app is closed. Live social publishing,
ElevenLabs, and authenticated trends need valid service credentials.
[The end-to-end and security review](docs/e2e-security-review.md) records tested
workflows and remaining platform/service verification.

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup and change validation. Report
sensitive vulnerabilities through the process in [SECURITY.md](SECURITY.md).
Keep API keys, private media, transcripts, render outputs, Python environments,
and downloaded installers out of commits.

## License

The project source is available under the [MIT license](LICENSE).
The bundled YuNet model retains its [upstream MIT license](video-use/helpers/assets/models/YuNet-LICENSE).
Dependencies and external services retain their own licenses and terms.
