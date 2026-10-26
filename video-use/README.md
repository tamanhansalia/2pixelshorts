# video-use engine (local install)

Python video engine for 2pixelshorts. The Tauri backend shells out to
`helpers/short_pipeline.py` (see `../src-tauri/src/jobs.rs` and
`../src-tauri/src/lib.rs`). This folder lives at the `2pixelshorts` repository root
so the backend's relative lookups resolve on every machine:

- dev from `src-tauri/` → `../video-use/helpers/short_pipeline.py`
- dev/run from app root → `video-use/helpers/short_pipeline.py`

## Helpers

| Script | Role |
|---|---|
| `helpers/short_pipeline.py` | Entry point: orchestrates transcribe → pack → cut → render; `--generate-seo-only` prints the SEO JSON between `__SEO_METADATA_START__` / `__SEO_METADATA_END__` markers |
| `helpers/agent_edit.py` | Agent-driven cut selection: builds an edit prompt from takes + channel context, invokes an agent CLI headlessly, validates the returned EDL |
| `helpers/render.py` | ffmpeg core: temporal framing, grade, synchronized EDL assembly, subtitle burn, output validation |
| `helpers/framing.py` | Offline YuNet face tracking, webcam border detection, speaker inset framing, full-frame fit fallback, seam captions and per-output `.framing.json` reports |
| `helpers/automatic_edit.py` | Studio options → silence/retake cleanup, AI highlights, or full recording; failures are reported without a substitute export |
| `helpers/transcript_edit.py` | Word-safe speech ranges, conservative repeated-take detection, and legacy explicit-plan validation |
| `helpers/review.py` | Post-render review grounded in measured output facts (probe + `words.json` / `edl.json` / `takes_packed.md` sidecars) |
| `helpers/trending.py` | Niche trends: rising Shorts terms via YouTube Data API (`search.list` + `videos.list` views-per-hour weighting, 24h cache) plus free YouTube autocomplete queries (no key; `PIXEL_DISABLE_SUGGEST=1` turns it off) |
| `helpers/seo.py` | SEO rules shared by every package: hook panel + title linter (adapted from the MIT [youtube-agent-skill](https://github.com/Jakeschincariol/youtube-agent-skill)), 0-100 score (title 40 · hook 15 · description 30 · hashtags 10 · tags 5), hashtag and tag budgets |
| `helpers/grade.py` | Grade preset → ffmpeg `-vf` filter map (`warm_cinematic`, `neutral_punch`, `vertical_clean`) |
| `helpers/transcribe.py` | Selected Local Whisper or ElevenLabs Scribe → word-level JSON; explicit provider failures stop processing |
| `helpers/pack_transcripts.py` | Word JSON → `takes_packed.md` editorial cut sheet |
| `helpers/stream_clip.py` | Stream clip finder: probe link → captions or local audio transcription → clip suggestions (selected `--agent` or Auto scoring; `--probe` / `--suggest` / `--download --start/--end`) |

YouTube/VOD clip analysis tries English captions first. If captions are missing,
malformed, or blocked, it downloads the source audio and transcribes it with the
transcription provider selected in Settings → Engine. Local Whisper uses the
cached model; ElevenLabs uploads extracted audio using the saved API key. Long videos can
take several minutes; temporary audio is removed after success or failure.
Long recordings are transcribed in five-minute windows with overlapping context,
reusing one model and mapping word timestamps back to the original video. This
keeps speech-detection memory bounded instead of processing an entire VOD at once.
This fallback requires `yt-dlp`, `ffmpeg`, and either local transcription setup or
an ElevenLabs key, according to the selected provider.
Missing dependencies, download restrictions, and audio without detectable speech
produce an actionable error. A selected editing agent receives the resulting
transcript; Auto uses local scoring. Analysis is based on speech, not visual scenes.

## Prerequisites

- Python 3.10+ (`python` on Windows, `python3` on macOS/Linux); Python 3.13
  is the tested local transcription runtime.

Local transcription setup requires Python 3.10+ to install patched dependencies;
Python 3.13 is the tested runtime. Setup prefers an installed supported version,
or the executable supplied by `PIXEL_PYTHON`. Runtime transcription uses the
cached model without network access. Run setup once to download it.
- `ffmpeg` + `ffprobe` in PATH ([download](https://ffmpeg.org/download.html),
  or `brew install ffmpeg` on macOS)

The core render helpers use the standard library. Automatic face framing
also needs OpenCV; its small MIT-licensed YuNet model is bundled inside
`helpers/assets/models/`, including in the app resources. Enable it once:

```sh
cd video-use
./setup_framing.sh
```

The native app resolves the project environment next to its actual helper
script. For a packaged app launched from Finder or the desktop, use
`./setup_framing.sh --managed` (or `./setup_local_stt.sh --managed` for both
captions and framing). This installs into the stable per-user
`~/.2pixelshorts/video-use/.venv` environment, which the native app also resolves.
`setup_local_stt.sh` installs the framing dependency in either mode.
If face detection is unavailable, the engine fits the complete source and
the Studio displays a framing warning.

Transcription runs in two modes:

- **ElevenLabs Scribe** (cloud, most accurate): set the key in the app
  under Settings → API keys → ElevenLabs Scribe.
- **Local whisper** (on-device, no key, no uploads): one-time setup
  downloads faster-whisper + the small.en model into the
  project env `video-use/.venv` (gitignored). The Tauri backend prefers
  this interpreter automatically whenever it exists:

```sh
cd video-use
./setup_local_stt.sh
```

Settings → Engine offers **Local Whisper** (default) and **ElevenLabs API**.
The choice saves automatically and controls exports, source transcripts, video
analysis and YouTube audio fallback. Saving a key alone never enables cloud use.
API keys remain in the OS credential vault; local jobs receive no cloud key.
ElevenLabs uses the same Speech-to-Text API as
[upstream video-use](https://github.com/browser-use/video-use/blob/main/helpers/transcribe.py):
`POST https://api.elevenlabs.io/v1/speech-to-text`, model `scribe_v1`, word
timestamps, diarization and audio event tags. A key needs Speech-to-Text access.
Only extracted mono audio is uploaded, with disk-backed multipart handling for
long recordings. API allowance depends on the user's ElevenLabs account.
The cloud provider needs Python and FFmpeg; installing Whisper or downloading
a local model is not required to use ElevenLabs.

The desktop app always supplies `--engine local|elevenlabs`. Missing keys,
provider errors and exhausted quota stop the operation rather than switching
providers. Legacy standalone CLI `--engine auto` retains its old behavior.
`--local-model` overrides
the most accurate locally cached English model (`small.en`, then `base.en`, then `tiny.en`). Rendering never downloads a model.

See [the provider implementation plan](../docs/transcription-providers.md) for
the routing and verification details.

## Cut selection order

Studio sends the selected `--edit-strategy` at export time:

- **Clean up** preserves the complete story, removing long pauses and earlier
  repeated takes according to the two cleanup controls. It has no duration cap.
- **AI highlight** asks the selected CLI for a focused moment within the chosen
  duration. Overlong segments are excluded; a plan with no usable segment gets
  one correction attempt, then fails visibly. Word-safe boundaries allow up to
  0.25 seconds of tolerance. A source already below the target can legitimately
  retain the same content as Cleanup.
- **Keep full video** preserves the entire timeline, including silence. With
  captions off and no custom instructions, it does not invoke transcription.
  Explicit custom instructions can still request cuts.

Automatic re-exports use separate filenames when a path is already recorded in
render history, so comparing modes does not overwrite the earlier export.
Manually chosen output paths remain under the user's control.

Standalone CLI callers can also supply `--edit-plan`, `--edl`, or manual trim
ranges. These cannot be combined with `--edit-strategy`. The legacy path without
an explicit strategy can fall back to a head cut; Studio mode failures never do.
Each output owns `OUTPUT.mp4.words.json`, `OUTPUT.mp4.edl.json`,
`OUTPUT.mp4.edit.json` (automation), and `OUTPUT.mp4.takes_packed.md`.
The review helper still reads legacy shared sidecars for older exports.

Native subprocesses receive transcription/trends keys through environment
variables and redact those values from returned logs. Editing agents run in a
temporary workspace with other services' keys removed. Claude and Grok disable
built-in tools; Claude also disables MCP/skills. Codex uses a read-only sandbox;
AGY uses plan mode and its sandbox. Editing models still receive transcript and
channel context through their configured AI provider.

Importing a source generates its initial metadata locally. Explicit re-analysis
or rendering with a selected editing model can send transcript and channel
context to that model's provider.

## Studio automation

Studio has five stages: Video → Edit & format → Captions → Title & tags → Export.
Edit & format keeps the AI CLI selector visible and uses its configured model
automatically, alongside the optional **Add custom instructions** switch. Disabling instructions keeps
the text saved but excludes it from the render request.
No transcript editor or written prompt is required. Studio sends `--edit-strategy`
to this repository's `short_pipeline.py` through the native background worker:

- `cleanup` (default): transcribe once, remove long pauses and earlier repeated
  takes, preserve the whole story without a duration cap.
- `highlights`: ask the selected editing CLI for a coherent short at the chosen
  30/60/90-second target, protect word boundaries, then apply cleanup.
- `full`: preserve all footage and apply the selected style and captions.

Cleanup controls map to `--keep-silence` and `--keep-retakes`. All three modes use
`render_edl` for framing, grading, caption burn, audio joins and output validation.
`OUTPUT.edit.json` records the actual engine path, strategy, cuts and removals.
Missing speech detection or failed AI edits fail the job; they cannot silently
produce a head cut. Browser previews cannot render or report simulated success.

## CLI custom prompts and YouTube references

Studio and CLI callers can combine `--prompt` with any `--edit-strategy`.
Instructions refine the chosen mode; cleanup and full mode use the source duration
as their maximum rather than a 30-second highlight budget. Full mode only requests
cuts when the instructions ask for them. `--model` selects an explicit model supported
by the chosen CLI; omitting it uses that CLI's default. The legacy CLI path without
`--edit-strategy` is also supported.
For example: `Open on my demo, skip the introduction, and use the spoken hook
structure from https://www.youtube.com/watch?v=VIDEO_ID_HERE as a reference.`

Up to three public YouTube video links in a prompt are resolved through
`yt-dlp`: the engine reads their metadata and English captions, with timestamped
opening/closing takes and speech rate included in the editing agent's context.
The reference is caption-based: it does not inspect visual effects or insert
reference footage/audio. Framing, color grade and caption design remain the
explicit Studio settings. Private videos, live streams, missing captions, and
invalid/channel/playlist links return an actionable error.

A nonempty custom prompt requires an available editing agent and a source
transcript (local Whisper or ElevenLabs). It cannot be combined with manual
trims or an explicit EDL. When its reference/transcription/agent fails, the job
fails instead of falling back to a cut that ignores the prompt. Jobs without
a custom prompt retain the existing automatic fallback behavior. A successful
prompt render saves its request, resolved reference evidence and chosen source
segments in `OUTPUT.mp4.edit.json` so each short has its own edit record.

## Agent CLIs

Each agent is invoked headlessly and must return EDL JSON. Availability is
probed per machine (`--probe`) — the app only offers verified agents:

On Windows, automated editing requires a native `.exe` agent. Batch-file
wrappers are excluded because passing an untrusted transcript through `cmd.exe`
would introduce shell parsing.

| Agent | Headless invocation | Model flag |
|---|---|---|
| claude | `claude -p --output-format json` | `--model` |
| codex | `codex exec --output-schema` | `-m` |
| agy | `agy -p --output-format json --json-schema` | `--model` |
| grok | `grok -p --json-schema` | `-m` |

```sh
python3 helpers/agent_edit.py --agent claude --probe
```

## Manual checks

```sh
cd video-use
python3 helpers/short_pipeline.py --help
python3 helpers/short_pipeline.py --input in.mp4 --output dummy.mp4 --generate-seo-only
python3 helpers/short_pipeline.py --input in.mp4 --output dummy.mp4 --generate-seo-only --trend-terms "deadpool|tokio" --winning-titles "Rust in 60s"
python3 helpers/short_pipeline.py --input in.mp4 --output short.mp4 --preset warm_cinematic --duration 30
python3 helpers/short_pipeline.py --input in.mp4 --output short.mp4 --cut-start 12 --cut-end 40
python3 helpers/review.py --input short.mp4
python3 helpers/inspect_framing.py --input short.mp4 --before old.mp4 --sheet framing-qa.jpg
python3 helpers/trending.py --niche "rust programming" --api-key "$YT_KEY"
python3 -m unittest discover -s tests
```

## Livestream framing

`auto` is the default for both the CLI and Studio. It analyzes only the
selected head cut or EDL windows, samples faces throughout the clip, holds
brief detector dropouts, and adapts at sustained camera/layout changes.
Small sunglasses/profile faces get additional corner-tile detection.

Already-portrait inputs retain their complete existing composition in Auto,
including screen, lower facecam card, borders and graphics. They are fitted
into the output canvas rather than cropped to a face or split a second time.
The larger lower facecam takes priority over a tiny webcam copy in the screen.
When a stable, broad card boundary is detected, new default/center captions
sit above it; boundary changes follow sustained evidence or scene cuts.
Explicit Single/Face only modes remain available for deliberate reframing.

For a corner webcam, the output uses a 60% screen / 40% webcam split. The
webcam region is fitted with room for the head and shoulders, rather than
cover-cropping a tight face box. Default captions sit on the screen side
of the seam. Padded fullscreen speaker scenes use a tracked speaker view
with the black border and separate chat sidebar removed. An uncertain
detection preserves the source rather than guessing a camera corner.

Every render writes `OUTPUT.framing.json` with selected source times,
layout decisions, camera crops/paths, warnings and measured output checks.
Audio crossfade joins and video/caption timelines have matching durations.
A failed Python pipeline is reported as a failed job; the native backend
does not silently encode the entire livestream as a replacement.

YouTube downloads prefer HD video with either AAC or Opus audio and merge
to MP4. A low-resolution input is flagged because its small webcam cannot
gain detail through cropping. A face already outside the original camera
cannot be reconstructed by reframing.
