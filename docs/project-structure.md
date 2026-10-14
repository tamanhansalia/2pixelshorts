# Project structure and architecture

The `2pixelshorts` repository is also the application root. Install, test, and
build commands run here. The frontend, Rust backend, and Python engine keep
their existing internal organization and their sibling relationship.

| Location | Purpose |
| --- | --- |
| `src/components/` | Studio, subtitles, queue, social publisher, settings, CLI tools, and shared interface components |
| `src/lib/` | IPC wrappers, credentials, local stores, job lifecycle, SEO, and adjacent TypeScript regression tests |
| `src/types/` | Shared frontend data contracts |
| `src-tauri/src/` | Native commands, tool discovery, secure credentials, render jobs, subprocess control, and Zernio API integration |
| `src-tauri/tests/` | Real rendering and subprocess/security integration tests |
| `src-tauri/icons/` | Native application icons |
| `src-tauri/tauri.conf.json` | Application identity, CSP, build commands, and Python resource bundling |
| `video-use/helpers/` | Transcription, edit planning, downloads, framing, captions, rendering, SEO, and review helpers |
| `video-use/helpers/assets/models/` | Offline YuNet face detector and its upstream license |
| `video-use/tests/` | Python unit, render, and security regressions |
| `public/` | Brand images, web icons, and subtitle style previews |
| `scripts/` | Branding maintenance and Windows build-tool installation |
| `docs/design/` | Non-runtime design explorations |
| `docs/archive/` | Historical planning; use maintained guides for current features |
| `.github/` | CI checks and contributor issue templates |

## Runtime flow

The React interface invokes Tauri commands through `src/lib/ipc.ts` and subscribes
to render job events. Rust validates parameters, discovers local executables,
and spawns `video-use/helpers/short_pipeline.py`. The Python pipeline transcribes,
selects source segments, frames/renders with FFmpeg, and writes per-output
metadata and review sidecars. Rust streams progress and handles cancellation.

Publishing uses `src-tauri/src/zernio.rs`; credentials go through the OS vault.
Queue/draft/history stores remain in the application WebView. The browser
preview simulates native operations and cannot validate the desktop pipeline.

The Rust package/library remain `pixelshorts`/`pixelshorts_lib` because Rust
identifiers cannot begin with a digit. The repository, npm package, executable,
and displayed product use `2pixelshorts`. The existing application identifier,
credential namespace, WebView store, and `~/.2pixelshorts` managed environment
remain stable across the repository rename.

## Generated and local files

`node_modules/`, `dist/`, `src-tauri/target/`, `video-use/.venv`, caches, and render
outputs are ignored. Historical personal media, transcripts, design-agent drafts,
and downloaded tools are preserved locally in ignored `.local-artifacts/`.
They are not required to build or run the project. Fresh clones contain source,
required assets, documentation, and tests.
