# End-to-end and security review

Reviewed on 14 October 2026 on Apple Silicon macOS. The local desktop workflow
completed successfully with synthetic footage. The final automated suites pass;
this review does not establish that every external service or platform works.

## Final validation

| Check | Result |
| --- | --- |
| TypeScript tests | 188 passed |
| Python tests, active managed environment | 214 passed |
| Rust unit tests | 28 passed; 1 network-dependent test intentionally ignored |
| Rust real render integration | 1 passed |
| Rust subprocess/security integrations | 4 passed |
| Production TypeScript/Vite build | Passed; large JavaScript chunk warning remains |
| Isolated macOS QA app bundle | Built successfully |
| npm dependency audit | 0 reported vulnerabilities |
| Active Python environment, OSV batch scan | 24 packages checked, 0 reported findings |
| Cargo audit | 0 counted vulnerabilities; 2 informational advisories remain below |

Total: **435 passing automated tests**. Final test logs are in
`/tmp/2pixelshorts-qa-{node,python,rust,build,bundle}.log`. Dependency audit results
are in `/tmp/2pixelshorts-qa-{npm,rust}-audit.json` and
`/tmp/2pixelshorts-qa-active-python-audit.json`. These temporary paths are local
evidence and may disappear after cleanup or reboot. Scans reflect advisory
database coverage at review time, not proof that dependencies have no flaws.

## Workflows exercised

| Workflow | Evidence and boundary |
| --- | --- |
| Native file import | Parented file picker selected synthetic speech video; metadata reported H.264, correct video FPS, and mono audio. Picker cancellation was not separately exercised. |
| Local speech recognition | Cached tiny.en model produced 35 words from synthetic narration using the upgraded Python environment. |
| Metadata generation | A live Claude CLI generated SEO from synthetic material. The final import path now requests local initial metadata; explicit re-analysis can use the selected model. |
| Studio configuration | Browser preview exercised aspect ratio, caption position/casing/style, title, description, and tags. Browser processing is simulated and is not desktop render evidence. |
| Real desktop rendering | Native UI rendered the synthetic source to 1080×1920, 15.67 seconds, with audio and visible captions. Switched to Queue during the job; completion was retained. |
| Output review | Per-output transcript, takes, EDL, framing report, and review summary were generated. The extracted frame was visually inspected. |
| Source Play / Reveal | Source playback opened in QuickTime; Finder selected the source. Render drawer Reveal selected the completed MP4. Drawer Play was clicked but output playback could not be independently confirmed. |
| Queue and metadata transfer | Native output entered the local queue. Browser preview verified duplicate prevention, persisted queue/draft after reload, and queue edit transfer into Social. No post was sent. |
| Channel profiles | Reproduced broken Add behavior, fixed it, then created and saved a disposable browser QA profile. |
| API-key feedback | A long fake key did not become Verified. Browser verification reports that desktop is required. Successful live provider authentication was not exercised. |
| Credential storage | Actual macOS QA Keychain write/read/delete roundtrip passed with a dummy value in an initially empty QA namespace; no production keys were changed. Migration failure cases have automated coverage. |
| Stream download | Probed the public YouTube Short `if7Dmuw49IA` and downloaded seconds 0–3 as a real 1080×1920 MP4 with audio. |
| Failure and cancellation | Tests cover invalid trims/durations, source overwrite, stale async results, helper key leakage, unbuffered progress, and Unix descendant termination on cancellation. |

The native workflow above was exercised before the final small hardening edits.
The final source passed all suites and was bundled again. A fresh final native
UI inspection could not be completed: the computer-use service could see the
QA process but could not resolve its window, including after reconnecting.
The final bundle should receive a human launch smoke check before release.

The synthetic render has no face, so its successful framing check verifies
canvas/layout behavior, not face tracking across real people or complex footage.
The low-resolution-source warning was expected for the 960×540 fixture.

Local artifacts, intentionally ignored by Git:

- [Rendered MP4](../framing-review/e2e-20261014/native-render.mp4)
- [Inspected captioned frame](../framing-review/e2e-20261014/native-frame.jpg)
- [Framing report](../framing-review/e2e-20261014/native-render.framing.json)
- [Review summary](../framing-review/e2e-20261014/review.json)
- Transcript, EDL, and take summary beside that MP4.

## Issues corrected

- Desktop API keys now use the OS credential store. Legacy plaintext removal
  occurs only after successful migration; browser preview keys are session-only.
  Saving and resetting report credential-store failures instead of silently
  losing keys. Key verification makes a read-only provider request instead of
  accepting a string based on its length.
- Enabled a production Content Security Policy and restricted external opening
  to HTTPS URLs without embedded credentials. Stream URL validation also
  rejects embedded credentials and nonstandard ports.
- App-generated transcription and trends helpers receive keys through their
  environment rather than command arguments; known values are redacted from
  returned logs. Helpers clear inherited application key variables first.
  Provider HTTP clients do not forward credentials through redirects.
- Editing agents use temporary workspaces, exclude app API key variables, and
  restrict tools where the CLI supports it. Windows batch agent wrappers are
  excluded; automated editing requires a native executable. Import no longer
  automatically sends transcripts to the selected cloud editing model.
- Corrected ffprobe video codec/FPS selection, IPC error normalization, native
  file selection, console argument parsing, and console inclusion controls.
- Validated input/output paths, trim ordering, finite numeric values, and prompt
  length. Rejects overwriting the original source, including hardlink aliases.
- Gave every output its own transcript/EDL/takes files, avoiding collisions
  between simultaneous renders. Automatic fallback cuts now cap long sources
  at 30 seconds when Studio requests an automatic duration.
- Improved progress delivery and cancellation cleanup on Unix; fixed event
  subscription cleanup and completion races. Prevented old SEO requests from
  overwriting metadata belonging to a newer selection.
- Fixed new-profile selection, reset coverage for stored stream runs, and
  dependency/runtime issues described below.

The CSP follows [Tauri's CSP mechanism](https://v2.tauri.app/security/csp/).
Credential backends use the native stores supported by
[keyring](https://docs.rs/keyring/3.6.3/keyring/). These controls reduce specific
risks; they are not a security boundary against a compromised local account or
a malicious CLI deliberately selected by the user. The console intentionally
executes user-specified local programs. Keys still exist briefly in application
and helper-process memory.

## Runtime and dependency changes

Updated source-map-js and the affected Python packages. Local transcription
setup now requires Python 3.10+; Python **3.13.16** was installed and tested.
The active project `video-use/.venv` points to the managed environment at
`~/.2pixelshorts/video-use/.venv`. Original Python 3.9 environments were preserved
under `~/.2pixelshorts/engine-backups/security-upgrade-20261014-025845/`, in
`managed-python39` and `project-python39`. System Python was not replaced.

Pinned compatible PyAV and Hugging Face Hub ranges after reproducing failure
with their newest releases. Normal local transcription loads cached models
without attempting a network fetch; setup downloads the model explicitly.

Cargo still reports these upstream dependency advisories:

- [RUSTSEC-2024-0370](https://rustsec.org/advisories/RUSTSEC-2024-0370.html):
  `proc-macro-error` 1.0.4 is unmaintained.
- [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html):
  `glib` 0.18.5 has an unsound iterator implementation. It belongs to the
  Linux GTK dependency tree and is not used by the macOS runtime. Linux release
  readiness requires resolving or evaluating this issue and testing on Linux.

## Remaining verification and product limits

Live Zernio connection/OAuth, media upload, posting, service-side scheduling,
retry behavior on real accounts, ElevenLabs transcription, and authenticated
YouTube trends need dedicated test credentials and destinations. Existing
contract/unit tests do not prove those services work with a real account today.
No production post, credential reset, or private-media upload was performed.

The queue currently requires manual dispatch. A future timestamp in local queue
storage does not itself implement automatic publishing while the app is closed.
Automatic scheduling should be treated as a separate feature, not inferred from
the queue UI or the aspirational project specification.

Windows/Linux runtime behavior, Windows process-tree cancellation, native
credential stores outside macOS, and live non-Claude editing agents were not
validated. Custom-prompt cuts have automated coverage but were not exhaustively
assessed for editorial quality. Agent sandbox/tool restrictions depend on the
installed CLI; transcript and channel context are sent to the chosen provider
when explicitly using an editing model. Local-cache loading also requires that
the speech model has already been installed.

The Python suite emits existing fixture ResourceWarnings and an AVFoundation
duplicate-class warning when video libraries share the test process. Tests pass;
production speech decoding remains isolated in a worker process. The frontend
bundle size warning remains a performance follow-up.

## Repeatable local checks

From the application directory:

```sh
npm test
npm run build
npm audit
cd src-tauri
cargo test
cargo audit
cd ../video-use
.venv/bin/python -m unittest discover -s tests
```

`cargo audit` requires cargo-audit to be installed. This run used a temporary
installation at `/tmp/2pixelshorts-qa-tools/bin/cargo-audit`. Python dependency
scanning queried public package names/versions against
[OSV's batch API](https://google.github.io/osv.dev/api/).

Build the isolated debug QA app from the application directory:

```sh
npm run tauri -- build --debug --bundles app --config src-tauri/tauri.qa.conf.json
```

The macOS QA WebView store requires macOS 14+. Use synthetic fixtures and the
QA credential namespace when repeating destructive reset or migration tests.
Keep production media, queue entries, and live social accounts outside that run.
