# Transcription provider plan and implementation

Status: implemented. Settings saves an explicit provider and processing follows it.

## Upstream review

Reviewed [browser-use/video-use](https://github.com/browser-use/video-use) and its
[transcribe.py](https://github.com/browser-use/video-use/blob/main/helpers/transcribe.py).
The upstream integration extracts mono 16 kHz audio and uses ElevenLabs Scribe:

- Endpoint: `POST https://api.elevenlabs.io/v1/speech-to-text`.
- Authentication: ElevenLabs API key in the `xi-api-key` header.
- Model: `scribe_v1`, matching upstream.
- Multipart fields: `file`, `model_id`, `timestamps_granularity=word`,
  `diarize=true`, `tag_audio_events=true`.

The [official Speech-to-Text API reference](https://elevenlabs.io/docs/api-reference/speech-to-text/convert)
documents this endpoint and word timestamps. The account's current allowance
and limits apply; the app does not promise a fixed number of free calls.

This project's `video-use/` is an adapted engine, so the integration preserves
its existing transcript shape, local model support, rendering and caption style.

## Implementation steps

1. **Save one explicit provider preference.** Settings → Engine shows Local
   Whisper and ElevenLabs API. Default to Local; persist the choice separately
   from credentials and clear it during a complete app-data reset.
2. **Route every transcription request.** Both render entry points, source
   transcript extraction, video/SEO analysis and YouTube audio fallback pass an
   explicit engine through TypeScript IPC, Rust and Python. Existing YouTube
   captions remain a free first source for link analysis.
3. **Integrate Scribe audio uploads.** Keep API keys in the existing OS vault,
   send them to workers through environment variables, extract mono FLAC audio,
   spool multipart data to disk and upload using the upstream Scribe fields.
   Filter spacing and audio-event tokens out of spoken captions.
4. **Keep the choice predictable.** Local never invokes the cloud, even with a
   saved key. ElevenLabs never silently switches to Whisper. Surface missing
   credentials, authentication, permission, quota and rate-limit errors. Do not
   retry ambiguous cloud requests automatically, since retries may use credits.
5. **Verify and package.** Cover persisted preferences, reset, IPC routing,
   Rust argument building, both Python providers, YouTube fallback and export
   failure. Exercise the real multipart sender against a local HTTP server with
   real FFmpeg audio extraction, then build the desktop bundle and inspect UI.

## Acceptance checks

- Local remains selected after saving an ElevenLabs key.
- The selected provider survives reload and applies to subsequent operations.
- Cloud processing needs a key with Speech-to-Text access. The optional read-only
  key test uses account access; restricted keys can be saved without that test.
- A provider error cannot become a successful export with missing captions.
- YouTube caption retrieval does not consume transcription API credits.
- Word timestamps retain their source-video timeline in both providers.
- Local long-form transcription retains the existing bounded five-minute windows.
- Upload tests verify headers, content length, FLAC content and upstream fields;
  no live ElevenLabs account credits are used by the automated suite.

## Verification results

- 198 frontend tests passed, including persisted selection, reset and five IPC entry points.
- 282 Python tests passed, including actual HTTP multipart upload to a local test server.
- 33 Rust unit tests passed; one existing external-service test remains ignored.
- Both native pipeline end-to-end tests passed, including real FFmpeg output.
- A real short YouTube audio transcription produced 37 words locally while a
  dummy cloud key was present; the selected provider remained `local-whisper`.
- Browser UI verification covered both choices and selection persistence after reload.
- The updated debug desktop bundle was built with the selected-provider helpers.

Live ElevenLabs authentication and account allowance were not exercised; HTTP
contract and error handling were verified against a local service without
using account credits.
