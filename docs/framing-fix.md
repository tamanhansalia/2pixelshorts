# Livestream framing repair — 12 October 2026

The 16:9 → 9:16 conversion now follows the selected source footage instead
of choosing one static face box at the midpoint of the entire input.
Twelve saved shorts were regenerated with captions and natural color.
Local review exports are in `framing-review/index.html`, with the individual
videos, start/middle/end comparison sheets and measured checks alongside it.
The original exports were preserved.

## Findings and changes

- The old Haar detector missed sunglasses and small/profile webcams. The
  bundled offline YuNet model detects these cases, with additional corner
  tiles and temporal confirmation to reject isolated false positives.
- A tight face box was cover-cropped a second time into a shallow strip,
  removing hair, headphones and chin. A 60% screen / 40% webcam layout now
  fits the camera region. Webcam borders are refined before cropping, with
  an outward-rounded face envelope to protect low-resolution chins.
- Midpoint analysis could frame unrelated footage in a long livestream.
  Each selected EDL window now has its own analysis and source timeline.
- Crop/layout changes follow sustained visual evidence. A known webcam's
  visible borders hold its composition through profile/occlusion dropouts.
  Moving cameras get separate regions. Large padded speaker views with a
  chat sidebar use a tracked speaker crop instead of a corner split.
- Single/speaker crops reserve head space, apply a camera deadzone, and
  bound pan speed and expression size. If a complete head cannot fit the
  aspect, it is fitted with a soft backdrop rather than cover-cropped.
- Default split captions sit on the screen side of the seam, including
  after active-word style resets.
- Audio crossfades, video cuts and caption offsets now consume matching
  durations. Video-only cuts do not consume an audio crossfade offset.
- Native job failures no longer trigger an untrimmed whole-source FFmpeg
  render reported as successful. Interpreter resolution checks the actual
  helper's environment so the local detector is used outside the usual CWD.
- Unix desktop launches add the installed user/Homebrew media tool locations
  to their executable search path while preserving the existing entries.
- Downloads prefer HD video paired with either AAC or Opus audio. Restricting
  the audio to M4A could unnecessarily fall back to a combined 360p format.
- Render-time transcription runs in a separate worker. This removes the
  observed macOS duplicate FFmpeg/Objective-C library collision between
  Whisper's PyAV dependency and OpenCV in the same Python process.

Every render produces an `OUTPUT.framing.json` sidecar and validates the
planned source-visible face rectangles before encoding, then output canvas,
duration and audio presence afterward. Missing dependencies and actual source
limits produce Studio warnings. `inspect_framing.py` exports comparison sheets
and checks the rendered artifact independently.

## Validation

- 183 Python tests passed, including a real FFmpeg pixel comparison that
  verifies the face rectangle's shape and margins in a two-cut short.
- 173 frontend tests passed; TypeScript/Vite build passed.
- 25 Rust unit tests and the real pipeline integration test passed. One
  pre-existing test remains ignored.
- Twelve real output clips passed 1080×1920, duration and face viewport
  retention checks. Start, middle and end snapshots were extracted for each,
  with visual comparisons against the earlier saved exports.
- A separate 44-second captioned source demo exercised the complete local
  transcription → render pipeline.
- The macOS app was rebuilt with the detector/model resources included. The
  managed per-user environment was installed and a captioned five-second
  render ran through the packaged helper from `/tmp`, outside the repository.

Clip 5's source is 640×360, so its webcam cannot gain detail through reframing.
Clips 7 and 8 already cut part of the head off in the original camera while
the speaker leans in or stands up; the output preserves the visible portion. These are source limits,
and both are called out in the review page.

## References inspected

- [2PixelSpace sample Short](https://www.youtube.com/shorts/if7Dmuw49IA)
- [BridgeMind sample Short](https://www.youtube.com/shorts/T9HZUooFt_8)
- [BridgeClip layout analyzer](https://github.com/bridge-mind/bridgeclip/blob/main/engine/clip_engine/services/layout_analyzer.py)
- [BridgeClip layout renderer](https://github.com/bridge-mind/bridgeclip/blob/main/engine/clip_engine/services/layout_renderer.py)
- [OpenCV YuNet model](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet)

The rendering implementation is local to this project. The small YuNet model
is redistributed with its MIT license in `helpers/assets/models/YuNet-LICENSE`.

## Already-framed short preservation — 14 October 2026

Reviewed saved portrait exports with the screen above a lower facecam card.
The temporal selector favored the tiny corner webcam inside the shared screen
over the larger lower camera. Exact 9:16 inputs often happened to keep their
geometry, but other portrait ratios or a detected padded inset could trigger
an unwanted face/content crop. New captions had no existing-card seam and
could land over the lower facecam.

Auto now preserves the complete portrait source composition in every output
aspect, prioritizes the larger lower webcam for tracking, and uses a confirmed
horizontal card boundary for safe caption placement. It retains source borders
and graphics and never splits an already-composed portrait a second time.
The boundary is measured from the image rather than assuming a 60/40 split;
persistent card changes and scene cuts get independent caption boundaries.
Explicit framing modes still perform deliberate crops.

New regression checks cover competing screen/facecam detections, unavailable
detectors, padded insets, changing/unstable seams, fitted-output padding, and
a real FFmpeg render of a 3:4 composition into 9:16 that retains both screen
edges and the lower camera. Original videos are preserved. Four-second local
review exports from existing-card, existing-stack and wide-source examples are
in `framing-review/autoframing-2026-10-14/` with measured framing reports.

Validation: 205 Python tests and the TypeScript/Vite build passed. All twelve
saved corrected shorts were analyzed at their start, middle and end; every
window preserved the existing composition and retained 100% of detected,
source-visible face pixels. Three real four-second outputs passed canvas,
duration, audio and face-retention checks. The synthetic FFmpeg regression
also burned captions and verified that they remained above the lower panel.
