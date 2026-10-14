"""FFmpeg render core: temporal framing, crossfades, grade and captions.

Importable entry point ``render_short(...)`` is used by ``short_pipeline.py``;
the module also works as a standalone CLI for debugging renders.

Pipeline stages (mirrored in stdout so the Tauri UI can stream progress):
  1. Probe source via ffprobe (duration, dimensions).
  2. Analyze the selected head cut / EDL spans through ``framing.py``.
  3. Compose tracked speaker crops, complete webcam panels or full-frame
     fits; align 30ms audio joins and captions on the output timeline.
  4. Run ffmpeg and verify output dimensions, duration and audio presence.

The low-level static builders remain available for callers with explicit
geometry; render_short/render_edl use the temporal plan for every render.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

try:
    from . import grade as grade_mod
    from . import framing as framing_mod
except ImportError:  # running as `python helpers/render.py`
    import grade as grade_mod
    import framing as framing_mod

FADE_SECONDS = 0.03  # 30ms anti-pop crossfades per spec


def parse_aspect_ratio(value=None) -> str:
    """Normalize an aspect id; unknown values fall back to 9:16."""
    try:
        return grade_mod.parse_aspect(value)
    except AttributeError:
        key = (value or "").strip()
        if key in ("9:16", "1:1", "16:9"):
            return key
        return "9:16"


def canvas_for(aspect=None):
    """Return (width, height) for an aspect id."""
    try:
        return grade_mod.canvas_for(aspect)
    except AttributeError:
        return {"9:16": (1080, 1920), "1:1": (1080, 1080), "16:9": (1920, 1080)}[parse_aspect_ratio(aspect)]


def effective_layout(layout, aspect_ratio=None) -> str:
    """Split stacks are composed for the 9:16 canvas; other ratios use single."""
    parsed = parse_layout(layout)
    if parse_aspect_ratio(aspect_ratio) != "9:16" and parsed in SPLIT_LAYOUTS + ("face-only",):
        return "single"
    return parsed


class RenderError(Exception):
    pass


def _which_or_raise(binary):
    path = shutil.which(binary)
    if not path:
        raise RenderError(
            f"required binary '{binary}' not found in PATH. "
            "Install FFmpeg (https://ffmpeg.org/download.html) and retry."
        )
    return path


# ---------------------------------------------------------------------------
# Face + screen split layout (stream VODs with a burned-in facecam).
#
# A 16:9 source center-cropped to 9:16 keeps ~1/3 of the width and drops the
# corners where facecams live. Split mode instead stacks two full-width
# bands on the 1080x1920 canvas: the screen band (whole frame, fit — never
# cropped) and a face band (face ROI zoomed to fill). Both heights are
# multiples of 16 for clean h264 encoding.
# ---------------------------------------------------------------------------
LAYOUTS = ("single", "screen-top", "face-top", "face-only")
SPLIT_LAYOUTS = ("screen-top", "face-top")
FACE_CORNERS = ("br", "bl", "tr", "tl")
SPLIT_SCREEN_H = 1344
SPLIT_FACE_H = 576
DEFAULT_FACE_CORNER = "br"
# Default face ROI as frame fractions (covers a typical corner facecam).
DEFAULT_FACE_REL = {"x": 0.73, "y": 0.68, "w": 0.27, "h": 0.32}


def parse_layout(value):
    """Normalize a layout id; unknown values fall back to single crop.

    ``auto`` passes through: render entries resolve it per input (split
    when a facecam is truly detected, else full-frame single crop).
    """
    key = (value or "").strip().lower()
    if key == "auto":
        return key
    if key in LAYOUTS:
        return key
    return "single"


# A truly detected face covering more than this fraction of the frame is
# the subject itself (fullscreen talking head), not a corner facecam:
# auto framing then uses a face-centered single crop, not a split stack.
AUTO_SPLIT_MAX_FACE_FRACTION = 0.25
# Portrait sources never split under auto: below this face fraction the
# frame stays untouched, at/above it the zoom-to-face single crop runs.
AUTO_PORTRAIT_FACE_FRACTION = 0.05
# Zoom-to-face never upscales more than this (quality guard).
MAX_SINGLE_ZOOM = 2.0
# Detector boxes are expanded by this for hair/shoulders context; the
# zoom window inverts it back to the tight face before re-margaining.
FACE_BOX_EXPANSION = 1.8
# Tight-face margin kept around the subject in the zoom window.
FACE_ZOOM_MARGIN = 1.4


def _is_usable_face(note):
    """True only for a real detection or an explicit manual spec.

    Corner-fallback guesses (missing opencv, no face found) must never
    move the crop or trigger a split — they are guesses, not framing.
    """
    text = note or ""
    return text.startswith("face:auto detected") or text.startswith("face:manual")


def resolve_auto_layout(input_path, face_roi="auto", src_w=0, src_h=0):
    """Resolve ``auto`` framing for one input.

    Returns (layout, face_pixels, note):
    - ``screen-top`` with the ROI when a corner-sized facecam is truly
      detected on a landscape source (split keeps the whole screen
      plus a face strip),
    - ``single`` with the ROI when the detected face fills the frame
      (fullscreen subject: face-centered crop, never a split stack),
    - ``single`` with the ROI when a dominant face is found on a
      portrait source (zoom-to-face crop that never cuts a
      width-spanning subject — full frame instead; auto never splits
      portrait — a split stack would shrink the whole frame),
    - ``single`` with an explicit manual ROI for face-centered cropping,
    - ``single`` without pixels otherwise (plain center crop).
    Detection failures degrade to full frame rather than guessing a split.
    """
    pixels, note = detect_face_roi(input_path, face_roi)
    if note.startswith("face:manual"):
        return "single", pixels, f"{note}; auto framing uses face-centered single"
    if not note.startswith("face:auto detected"):
        return "single", None, f"{note}; auto framing uses full frame"
    if not src_w or not src_h:
        try:
            info = probe_media(input_path)
            src_w, src_h = info["width"] or 0, info["height"] or 0
        except RenderError:
            src_w, src_h = 0, 0
    if src_w > 0 and src_h > 0:
        fraction = (pixels["w"] * pixels["h"]) / float(src_w * src_h)
        if src_h > src_w:
            if fraction >= AUTO_PORTRAIT_FACE_FRACTION:
                return (
                    "single", pixels,
                    f"{note}; auto framing uses face-centered single "
                    f"(face covers {fraction:.0%} of frame)",
                )
            return "single", None, f"{note}; auto framing uses full frame"
        if fraction > AUTO_SPLIT_MAX_FACE_FRACTION:
            return (
                "single", pixels,
                f"{note}; auto framing uses face-centered single "
                f"(face covers {fraction:.0%} of frame)",
            )
    return "screen-top", pixels, f"{note}; auto framing uses split"


def _clamp_roi(x, y, w, h, src_w, src_h):
    w = max(2, min(int(w), src_w))
    h = max(2, min(int(h), src_h))
    x = max(0, min(int(x), src_w - w))
    y = max(0, min(int(y), src_h - h))
    return {"x": x, "y": y, "w": w, "h": h}


# A subject spanning ~the full frame (close-up phone recording) must
# never be zoomed: any narrower window amputates it. Same 0.95 idiom as
# the full-frame guard in _portrait_face_window.
SPANNING_FRACTION = 0.95


def _subject_spans_frame(face_pixels, src_w, src_h):
    """True when the ROI already spans the frame width or height."""
    if src_w <= 0 or src_h <= 0:
        return False
    return (
        (face_pixels["w"] >= src_w * SPANNING_FRACTION
         and face_pixels["x"] <= src_w * (1 - SPANNING_FRACTION))
        or (face_pixels["h"] >= src_h * SPANNING_FRACTION
            and face_pixels["y"] <= src_h * (1 - SPANNING_FRACTION))
    )


def _contain_rect(face_pixels, src_w, src_h, band_w, band_h):
    """Largest band-aspect crop rect containing the whole ROI.

    Unlike cover-cropping the ROI itself, this never cuts the subject:
    the rect grows to the ROI (then the band scales it exactly, with no
    second crop). Clamped into the frame; for a width-spanning subject
    on a 9:16 canvas this is ~the full frame.
    """
    ratio = band_w / float(band_h)
    w = max(float(face_pixels["w"]), face_pixels["h"] * ratio)
    h = w / ratio
    if w > src_w:
        w, h = float(src_w), src_w / ratio
    if h > src_h:
        h, w = float(src_h), src_h * ratio
    cx = face_pixels["x"] + face_pixels["w"] / 2.0
    cy = face_pixels["y"] + face_pixels["h"] / 2.0
    w, h = _even(w), _even(h)
    x = _even(min(max(cx - w / 2.0, 0.0), max(src_w - w, 0.0)))
    y = _even(min(max(cy - h / 2.0, 0.0), max(src_h - h, 0.0)))
    return {"x": x, "y": y, "w": w, "h": h}


def default_face_pixels(src_w, src_h, corner=DEFAULT_FACE_CORNER):
    """Corner-preset face ROI in pixels (the auto fallback)."""
    corner = (corner or DEFAULT_FACE_CORNER).strip().lower()
    if corner not in FACE_CORNERS:
        corner = DEFAULT_FACE_CORNER
    rel = DEFAULT_FACE_REL
    w, h = rel["w"] * src_w, rel["h"] * src_h
    x = 0 if corner in ("bl", "tl") else src_w - w
    y = 0 if corner in ("tl", "tr") else src_h - h
    return _clamp_roi(x, y, w, h, src_w, src_h)


def parse_face_roi(spec, src_w, src_h):
    """Parse a face ROI spec to pixels: corner name or x,y,w,h fractions."""
    text = (spec or "").strip().lower()
    if not text or text == "auto":
        raise RenderError("face ROI 'auto' needs detection (see detect_face_roi)")
    if text in FACE_CORNERS:
        return default_face_pixels(src_w, src_h, text)
    try:
        fx, fy, fw, fh = (float(v) for v in text.split(","))
    except (TypeError, ValueError):
        raise RenderError(
            f"bad face ROI {spec!r}: use auto, br|bl|tr|tl, or x,y,w,h fractions"
        )
    if not (0 <= fx < 1 and 0 <= fy < 1 and 0 < fw <= 1 and 0 < fh <= 1):
        raise RenderError(f"face ROI fractions must be within 0..1: {spec!r}")
    return _clamp_roi(fx * src_w, fy * src_h, fw * src_w, fh * src_h, src_w, src_h)


# Two boxes from different preview frames must overlap by this much
# (intersection-over-union) to count as the same persistent face.
FACE_CONSENSUS_IOU = 0.3


def _sample_times(duration):
    """Up to 3 nearby preview timestamps around the clip midpoint.

    Nearby (not spread out): a moving speaker legitimately sits in
    different spots 20s apart, so consensus must compare neighboring
    frames — a real face persists 1s later, a glitch does not. The
    midpoint avoids intros/outros. Very short clips collapse to fewer
    unique stamps and keep single-frame leniency.
    """
    if not duration or duration <= 0:
        return [1.0]
    mid = duration / 2.0
    return sorted({
        max(0.0, mid - 1.0),
        mid,
        min(duration, mid + 1.0),
    })


def _box_iou(a, b):
    """Intersection-over-union for (x, y, w, h) boxes."""
    ix = max(0, min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = a[2] * a[3] + b[2] * b[3] - inter
    return inter / union if union > 0 else 0.0


def _cluster_boxes(hits):
    """Group per-frame largest hits by IoU linkage (union-find).

    One frame can hold several faces (streamer + gameplay + glitches),
    and the largest box flips between them frame to frame — pairwise
    comparison of raw hits then rejects everything. Clustering recovers
    the persistent faces; each group is one candidate subject.
    Returns groups sorted best-first: most members wins, total area
    breaks ties (the dominant on-screen face beats a tiny PiP).
    """
    parent = list(range(len(hits)))
    boxes = [h[0] for h in hits]

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    for i in range(len(boxes)):
        for j in range(i + 1, len(boxes)):
            if _box_iou(boxes[i], boxes[j]) >= FACE_CONSENSUS_IOU:
                union(i, j)
    groups = {}
    for i, h in enumerate(hits):
        groups.setdefault(find(i), []).append(h)
    ordered = sorted(
        groups.values(),
        key=lambda g: (len(g), sum(b[2] * b[3] for b, _ in g)),
        reverse=True,
    )
    return ordered


def _grab_frame_jpeg(input_path, at_seconds):
    proc = subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", f"{max(0.0, at_seconds):.2f}",
         "-i", input_path, "-frames:v", "1", "-f", "image2pipe",
         "-vcodec", "mjpeg", "-"],
        capture_output=True, timeout=60,
    )
    if proc.returncode != 0 or not proc.stdout:
        raise RenderError("could not grab a preview frame for face detection")
    return proc.stdout


def detect_face_roi(input_path, spec="auto", corner=DEFAULT_FACE_CORNER):
    """Resolve the face ROI: explicit spec, cv2 auto-detect, or corner fallback.

    Never raises: detection failures degrade to the corner preset so a
    missing optional dep (opencv) can never break a render.
    """
    text = (spec or "auto").strip().lower()
    if text not in ("", "auto"):
        try:
            info = probe_media(input_path)
            base_w, base_h = info["width"] or 1920, info["height"] or 1080
        except RenderError:
            base_w, base_h = 1920, 1080
        try:
            return parse_face_roi(text, base_w, base_h), f"face:manual {text}"
        except RenderError as exc:
            fallback = default_face_pixels(base_w, base_h)
            return fallback, f"face:{exc}; used corner fallback"
    try:
        info = probe_media(input_path)
        src_w, src_h = info["width"] or 1920, info["height"] or 1080
        duration = info["duration"] or 0.0
    except RenderError:
        src_w, src_h, duration = 1920, 1080, 0.0
    fallback = default_face_pixels(src_w, src_h, corner)
    fallback_note = (
        f"face:auto fallback {corner} corner "
        f"(x={fallback['x']},y={fallback['y']},"
        f"w={fallback['w']},h={fallback['h']})"
    )
    try:
        import cv2
        import numpy as np
    except ImportError:
        return fallback, (
            fallback_note + "; for true detection install it into the "
            "project venv: video-use/.venv/bin/pip install "
            "\"opencv-python-headless<5\" (5.x removed the Haar cascade API)"
        )
    try:
        cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        cascade = cv2.CascadeClassifier(cascade_path)
        if cascade.empty():
            raise RenderError("face cascade failed to load")
        # Multi-frame consensus: sample up to 3 nearby timestamps and
        # keep the largest hit per frame (source pixels). Hits are
        # clustered by overlap and the dominant persistent face wins —
        # the largest box flips between faces frame to frame (streamer
        # vs gameplay vs glitch), so raw pairwise comparison rejects
        # everything. A group counts with 2+ members; one unique
        # timestamp (very short clips) keeps single-frame behavior.
        hits = []
        stamps = _sample_times(duration)
        for at in stamps:
            try:
                raw = _grab_frame_jpeg(input_path, at)
            except RenderError:
                continue
            frame = cv2.imdecode(
                np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
            if frame is None:
                continue
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            faces = cascade.detectMultiScale(
                gray, scaleFactor=1.1, minNeighbors=4, minSize=(40, 40),
            )
            if len(faces) == 0:
                continue
            fx, fy, fw, fh = max(faces, key=lambda b: b[2] * b[3])
            fh_img, fw_img = gray.shape
            sx, sy = src_w / float(fw_img), src_h / float(fh_img)
            hits.append(((fx * sx, fy * sy, fw * sx, fh * sy), at))
        stable = None
        if hits:
            groups = _cluster_boxes(hits)
            best = groups[0]
            if len(best) >= 2 or (len(best) == 1 and len(stamps) == 1):
                n = float(len(best))
                stable = tuple(
                    sum(b[k] for b, _ in best) / n for k in range(4))
        if stable is None:
            if hits:
                raise RenderError(
                    f"no stable face across {len(stamps)} preview frames")
            raise RenderError("no face found in preview frames")
        fx, fy, fw, fh = stable
        # Expand for hair/shoulders, then clamp to frame.
        cx, cy = fx + fw / 2.0, fy + fh / 2.0
        ew, eh = fw * FACE_BOX_EXPANSION, fh * FACE_BOX_EXPANSION
        found = _clamp_roi(cx - ew / 2.0, cy - eh / 2.0,
                           ew, eh, src_w, src_h)
        return found, (
            f"face:auto detected (x={found['x']},y={found['y']},"
            f"w={found['w']},h={found['h']})"
        )
    except Exception as exc:
        return fallback, f"{fallback_note}; detection failed ({exc})"


def split_video_chain(src_label, face_px, layout, src_w=0, src_h=0):
    """filter_complex chunk stacking screen-fit + face-zoom bands to 1080x1920.

    Returns (chain, stacked_label). Grade color + subtitles are appended by
    the caller onto the stacked label.

    The explicit ``split`` is load-bearing, not style: one label feeding
    two chains relies on ffmpeg's implicit fan-out, which mishandles EOF
    propagation into framesync (vstack) on ffmpeg 9 — the trimmed source
    then runs to full input length while audio stays cut. Emitting split
    keeps trimmed EDL video exactly segment-length.

    When the subject already spans the frame (close-up footage, dims
    known), the face band fits the whole head over a blurred pad instead
    of cover-cropping it (which sliced foreheads and cheeks).
    """
    fx, fy, fw, fh = face_px["x"], face_px["y"], face_px["w"], face_px["h"]
    fanout = f"{src_label}split[vsplit_screen][vsplit_face]"
    screen = (
        "[vsplit_screen]"
        f"scale=1080:{SPLIT_SCREEN_H}:force_original_aspect_ratio=decrease,"
        f"pad=1080:{SPLIT_SCREEN_H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[vscreen]"
    )
    if _subject_spans_frame(face_px, src_w, src_h):
        face = (
            "[vsplit_face]"
            f"crop={fw}:{fh}:{fx}:{fy},split[fbg][ffg];"
            f"[fbg]scale=1080:{SPLIT_FACE_H}:force_original_aspect_ratio=increase,"
            f"crop=1080:{SPLIT_FACE_H},gblur=sigma=40[bblur];"
            f"[ffg]scale=1080:{SPLIT_FACE_H}:force_original_aspect_ratio=decrease[ffit];"
            "[bblur][ffit]overlay=x='trunc((W-w)/2/2)*2':y='trunc((H-h)/2/2)*2',"
            "setsar=1[vface]"
        )
    else:
        face = (
            "[vsplit_face]"
            f"crop={fw}:{fh}:{fx}:{fy},"
            f"scale=1080:{SPLIT_FACE_H}:force_original_aspect_ratio=increase,"
            f"crop=1080:{SPLIT_FACE_H},setsar=1[vface]"
        )
    if layout == "face-top":
        stack = "[vface][vscreen]vstack=inputs=2[vstacked]"
    else:
        stack = "[vscreen][vface]vstack=inputs=2[vstacked]"
    return ";".join([fanout, screen, face, stack]), "[vstacked]"


def face_only_chain(src_label, face_px, src_w=0, src_h=0):
    """filter_complex chunk zooming the face ROI to fill 1080x1920.

    Same zoom math as the split face band, but full height: talking-head
    clips where the screen adds nothing. Returns (chain, video_label);
    grade color + subtitles are appended by the caller onto the label.

    When the subject already spans the frame (close-up footage, dims
    known), the crop grows to a canvas-aspect rect containing the whole
    head instead of amputating its sides.
    """
    fx, fy, fw, fh = face_px["x"], face_px["y"], face_px["w"], face_px["h"]
    if _subject_spans_frame(face_px, src_w, src_h):
        rect = _contain_rect(face_px, src_w, src_h, 1080, 1920)
        fx, fy, fw, fh = rect["x"], rect["y"], rect["w"], rect["h"]
    chain = (
        f"{src_label}crop={fw}:{fh}:{fx}:{fy},"
        f"scale=1080:1920:force_original_aspect_ratio=increase,"
        f"crop=1080:1920,setsar=1[vfacefull]"
    )
    return chain, "[vfacefull]"


def _even(value):
    """Round to an even int (ffmpeg crop offsets must be even for yuv420)."""
    return max(0, int(round(value)) // 2 * 2)


def _portrait_face_window(face_pixels, src_w, src_h, canvas_w, canvas_h,
                          face_expanded=True):
    """Source-space crop window zooming into the face (portrait inputs).

    Returns (x, y, w, h) — a canvas-aspect rect around the margined face,
    zoom-capped and clamped in frame — or None when the window is the
    full frame (nothing to zoom: keep the pixels untouched). A subject
    that already spans the frame width is also kept full frame: any
    narrower window would amputate its sides.
    """
    # Close-up phone recording: the head already spans edge to edge, so
    # zooming in can only cut it (the reported 1080x1920 case lost ~118px
    # per cheek). Checked on the raw ROI so it holds for auto (expanded)
    # and manual ROIs.
    if _subject_spans_frame(face_pixels, src_w, src_h):
        return None
    # Auto ROIs carry detector context (FACE_BOX_EXPANSION): invert it
    # back to the tight face first, then re-margin for the zoom window.
    # Sizing from the expanded box directly would never zoom at all.
    # Manual ROIs are already tight regions: use them as-is.
    fx, fy, fw, fh = (face_pixels["x"], face_pixels["y"],
                      face_pixels["w"], face_pixels["h"])
    cx, cy = fx + fw / 2.0, fy + fh / 2.0
    if face_expanded:
        fw, fh = fw / FACE_BOX_EXPANSION, fh / FACE_BOX_EXPANSION
    ratio = canvas_w / float(canvas_h)
    mw, mh = fw * FACE_ZOOM_MARGIN, fh * FACE_ZOOM_MARGIN
    w = max(mw, mh * ratio)
    h = w / ratio
    # Zoom cap: never upscale beyond MAX_SINGLE_ZOOM (quality guard).
    min_w, min_h = src_w / MAX_SINGLE_ZOOM, src_h / MAX_SINGLE_ZOOM
    if w < min_w:
        w, h = min_w, min_w / ratio
    if h < min_h:
        h, w = min_h, min_h * ratio
    # Must fit: a dominating face shrinks the window back to the frame.
    if w > src_w:
        w, h = float(src_w), src_w / ratio
    if h > src_h:
        h, w = float(src_h), src_h * ratio
    if w >= src_w * 0.95 and h >= src_h * 0.95:
        return None
    w, h = _even(w), _even(h)
    x = _even(min(max(cx - w / 2.0, 0.0), max(src_w - w, 0.0)))
    y = _even(min(max(cy - h / 2.0, 0.0), max(src_h - h, 0.0)))
    x = min(x, max(src_w - w, 0))
    y = min(y, max(src_h - h, 0))
    return x, y, w, h


def single_crop_filter(preset_id, aspect, face_pixels=None, src_w=0, src_h=0,
                       face_expanded=True):
    """Geometry + grade filter for the single-crop canvas.

    Landscape sources upscale to cover and center the crop window on a
    trusted face ROI (true detection or explicit manual spec) instead of
    blindly cropping the center. Portrait sources zoom into the face
    (dropping dead bars) under the same trust rule. Without a trusted
    ROI it is the plain center crop. Either way the filter carries the
    exact ``crop=WxH`` grade tests assert.
    """
    canvas_w, canvas_h = canvas_for(aspect)
    if face_pixels and src_w > 0 and src_h > 0 and src_h > src_w:
        window = _portrait_face_window(
            face_pixels, src_w, src_h, canvas_w, canvas_h,
            face_expanded=face_expanded)
        if window is not None:
            x, y, w, h = window
            return (
                f"crop={w}:{h}:{x}:{y},"
                f"scale={canvas_w}:{canvas_h}"
                + grade_mod.color_chain(preset_id)
            )
        return grade_mod.get_filter(preset_id, aspect)
    if face_pixels and src_w > 0 and src_h > 0:
        try:
            scale = max(canvas_w / float(src_w), canvas_h / float(src_h))
        except (TypeError, ValueError, ZeroDivisionError):
            scale = 0.0
        if scale > 0:
            scaled_w, scaled_h = src_w * scale, src_h * scale
            cx = (face_pixels["x"] + face_pixels["w"] / 2.0) * scale
            cy = (face_pixels["y"] + face_pixels["h"] / 2.0) * scale
            x = _even(min(max(cx - canvas_w / 2.0, 0.0),
                          max(scaled_w - canvas_w, 0.0)))
            y = _even(min(max(cy - canvas_h / 2.0, 0.0),
                          max(scaled_h - canvas_h, 0.0)))
            base = (
                f"scale={canvas_w}:{canvas_h}:force_original_aspect_ratio=increase,"
                f"crop={canvas_w}:{canvas_h}:{x}:{y}"
            )
            return base + grade_mod.color_chain(preset_id)
    return grade_mod.get_filter(preset_id, aspect)


def _stack_tail(stacked, color_vf, srt_path=None, subtitle_style=None,
                subtitle_position=None, subtitle_size=None):
    """Grade + subtitles appended onto the stacked split label.

    After a link label the chain continues with a bare filter name (no
    leading comma), unlike the `-vf` append form of _subtitles_filter.
    """
    chain = (color_vf or "").lstrip(",")
    if srt_path:
        sub = _subtitles_filter(
            srt_path, subtitle_style, subtitle_position, subtitle_size,
        ).lstrip(",")
        chain = f"{chain},{sub}" if chain else sub
    if not chain:
        chain = "null"
    return f"{stacked}{chain}[v]"


def probe_media(path):
    """Return {duration, width, height, has_audio} via ffprobe."""
    _which_or_raise("ffprobe")
    proc = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "stream=width,height,codec_type",
            "-show_entries", "format=duration",
            "-of", "json", path,
        ],
        capture_output=True, text=True, timeout=60,
    )
    if proc.returncode != 0:
        raise RenderError(f"ffprobe failed for {path}: {proc.stderr.strip()}")
    try:
        data = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError as exc:
        raise RenderError(f"ffprobe returned invalid JSON: {exc}")

    width, height = 0, 0
    has_audio = False
    for stream in data.get("streams", []) or []:
        width = width or int(stream.get("width") or 0)
        height = height or int(stream.get("height") or 0)
        if stream.get("codec_type") == "audio":
            has_audio = True
    try:
        duration = float((data.get("format") or {}).get("duration") or 0.0)
    except (TypeError, ValueError):
        duration = 0.0
    return {"duration": duration, "width": width, "height": height, "has_audio": has_audio}


def _fmt_srt_ts(seconds):
    seconds = max(0.0, float(seconds))
    hours = int(seconds // 3600)
    mins = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    millis = int(round((seconds - int(seconds)) * 1000))
    return f"{hours:02d}:{mins:02d}:{secs:02d},{millis:03d}"


def words_to_srt(words, case="uppercase", words_per_cue=2):
    """Convert word-level transcript words to SRT subtitle text."""
    cues = []
    chunk = []
    for item in words or []:
        chunk.append(item)
        if len(chunk) >= words_per_cue:
            cues.append(chunk)
            chunk = []
    if chunk:
        cues.append(chunk)

    blocks = []
    for index, cue in enumerate(cues, start=1):
        text = " ".join((w.get("word") or "").strip() for w in cue).strip()
        if case == "uppercase":
            text = text.upper()
        elif case == "title":
            text = text.title()
        start = float(cue[0].get("start", 0.0))
        end = float(cue[-1].get("end", cue[-1].get("start", start)))
        if end <= start:
            end = start + 1.0
        blocks.append(f"{index}\n{_fmt_srt_ts(start)} --> {_fmt_srt_ts(end)}\n{text}\n")
    return "\n".join(blocks)


def _escape_subtitles_path(path):
    # ffmpeg subtitles filter needs :, ', [ escaped on all platforms.
    return (
        path.replace("\\", "/")
        .replace(":", "\\:")
        .replace("'", "\\'")
        .replace("[", "\\[")
    )


# ---------------------------------------------------------------------------
# Caption contract (shared with src/components/studio/SubtitleStudio.tsx).
#
# The render canvas is 1080x1920 and every generated .ass pins
# PlayResX/PlayResY to exactly that, so FontSize/MarginV below are output
# pixels — not libass's default script resolution (which made the old
# SRT+force_style path render ~2.5x too big and float mid-frame).
#
# Events are continuous (karaoke-style): each word's event holds until the
# next word in its cue begins, with a short trailing hold clipped at the
# next cue — speech gaps never blink the line out and cues never overlap.
#
# The 9:16 monitor preview scales proportionally at any width via container
# query units: FontSize px / 1080 as cqw (standard 50px -> 4.63cqw),
# MarginV px / 1920 as % of height (top 140 -> 7.3%, bottom 200 -> 10.4%),
# center exact middle in both (ASS Alignment 5).
# ---------------------------------------------------------------------------
ASS_PLAYRES_X = 1080
ASS_PLAYRES_Y = 1920
_ASS_MARGIN_LR = 40

# Caption position -> (ASS Alignment, MarginV in output pixels).
_SUBTITLE_POSITIONS = {
    "top": (8, 140),
    "center": (5, 0),
    "bottom": (2, 200),
}

# Caption size -> scale factor. Unknown -> 1.0.
_SUBTITLE_SIZES = {
    "compact": 0.85,
    "standard": 1.0,
    "large": 1.2,
}


def _ass_color(hex_rgb, alpha=0):
    """Convert '#RRGGBB' + alpha byte to ASS '&HAABBGGRR'."""
    clean = (hex_rgb or "#FFFFFF").strip().lstrip("#")
    if len(clean) != 6:
        clean = "FFFFFF"
    red, green, blue = clean[0:2], clean[2:4], clean[4:6]
    return f"&H{alpha:02X}{blue}{green}{red}".upper()


# Caption theme table. Theme ids mirror SUBTITLE_THEMES in
# src/components/studio/SubtitleStudio.tsx; `inactive`/`active` mirror the
# preview's plain-word vs spoken-word colors. `active_tags` are ASS override
# tags applied to the currently spoken word only (pill/glow/underline/skew
# approximations — libass cannot draw rounded CSS pills or 3D extrusion).
_SUBTITLE_THEMES = {
    "pop": {"font": "Arial", "base": 50,
            "inactive": "#FFFFFF", "active": "#FFE500",
            "bold": -1, "italic": 0, "border": 1,
            "outline": "#000000", "back": "#000000",
            "outline_px": 4, "shadow": 2, "blur": 0,
            "active_tags": r"{\1c&H0000E5FF&\fscx112\fscy112}"},
    "spotlight": {"font": "Arial", "base": 50,
                  "inactive": "#FFFFFF", "active": "#FFFFFF",
                  "bold": -1, "italic": 0, "border": 1,
                  "outline": "#000000", "back": "#000000",
                  "outline_px": 2, "shadow": 1, "blur": 0,
                  "active_tags": r"{\3c&H00ED3A7C&\bord5\shad0\fscx105\fscy105}"},
    "glow": {"font": "Arial", "base": 50,
             "inactive": "#FFFFFF", "inactive_alpha": 0x66,
             "active": "#00F5FF",
             "bold": -1, "italic": 0, "border": 1,
             "outline": "#00323A", "back": "#000000",
             "outline_px": 2, "shadow": 0, "blur": 2,
             "active_tags": r"{\1c&H00FFF500&\bord3\blur2\fscx105\fscy105}"},
    "boxed": {"font": "Arial", "base": 50,
              "inactive": "#F5F5F4", "active": "#FACC15",
              "bold": -1, "italic": 0, "border": 3,
              "outline": "#18181B", "back": "#18181B",
              "outline_px": 6, "shadow": 0, "blur": 0,
              "active_tags": r"{\1c&H0015CCFA&}"},
    "editorial": {"font": "Georgia", "base": 50,
                  "inactive": "#ECECE8", "active": "#EAB308",
                  "bold": 0, "italic": -1, "border": 1,
                  "outline": "#1A1A1A", "back": "#000000",
                  "outline_px": 1, "shadow": 1, "blur": 0,
                  "active_tags": r"{\1c&H0008B3EA&\u1}"},
    "hype": {"font": "Arial", "base": 50,
             "inactive": "#FFFFFF", "active": "#22C55E",
             "bold": -1, "italic": 0, "border": 1,
             "outline": "#000000", "back": "#000000",
             "outline_px": 3, "shadow": 2, "blur": 0,
             "active_tags": r"{\1c&H005EC522&\i1\fscx112\fscy112}"},
    "punch": {"font": "Arial", "base": 104,
              "inactive": "#FFFFFF", "active": "#FFFFFF",
              "bold": -1, "italic": 0, "border": 1,
              "outline": "#000000", "back": "#000000",
              "outline_px": 6, "shadow": 3, "blur": 0,
              "active_tags": ""},
    "paper": {"font": "Arial", "base": 50,
              "inactive": "#18181B", "active": "#7C3AED",
              "bold": -1, "italic": 0, "border": 3,
              "outline": "#FFFFFF", "back": "#FFFFFF",
              "outline_px": 6, "shadow": 0, "blur": 0,
              "active_tags": r"{\1c&H00ED3A7C&}"},
    "subtle": {"font": "Arial", "base": 50,
               "inactive": "#D4D4D8", "active": "#FBBF24",
               "bold": 0, "italic": 0, "border": 1,
               "outline": "#000000", "back": "#000000",
               "outline_px": 1, "shadow": 0, "blur": 0,
               "active_tags": r"{\1c&H0024BFFB&}"},
}

_DEFAULT_THEME = {"font": "Arial", "base": 50,
                  "inactive": "#FFFFFF", "active": "#FFE500",
                  "bold": -1, "italic": 0, "border": 1,
                  "outline": "#000000", "back": "#000000",
                  "outline_px": 3, "shadow": 1, "blur": 0,
                  "active_tags": r"{\1c&H0000E5FF&}"}

# Guard against byte-swapped ASS colors: every theme whose active word has
# its own color must embed that exact color in its override tags.
for _name, _theme in list(_SUBTITLE_THEMES.items()) + [("default", _DEFAULT_THEME)]:
    if _theme["active"] != _theme["inactive"]:
        assert _ass_color(_theme["active"]) in _theme["active_tags"], _name
del _name, _theme


def _theme_for(style_id):
    return _SUBTITLE_THEMES.get(
        (style_id or "").strip().lower(), _DEFAULT_THEME,
    )


def _font_size_for(style_id, size):
    theme = _theme_for(style_id)
    factor = _SUBTITLE_SIZES.get((size or "").strip().lower(), 1.0)
    return max(10, round(theme["base"] * factor))


def cue_size_for_style(style_id):
    """Words per subtitle cue for a theme. Punch shows one massive word."""
    if (style_id or "").strip().lower() == "punch":
        return 1
    return 2


def _apply_case(text, case):
    """Apply the caption casing rule to already-joined cue text."""
    if case == "uppercase":
        return text.upper()
    if case == "title":
        return text.title()
    return text


def _ass_escape(text):
    """Escape literal braces for ASS dialogue text."""
    return (text or "").replace("{", r"\{").replace("}", r"\}")


# Trailing hold (seconds) so a cue never blinks out the instant its last
# word ends; the hold is clipped at the next cue so events never overlap.
CUE_TRAILING_HOLD = 0.5


def _word_start(item, default=0.0):
    try:
        return float(item.get("start", default))
    except (TypeError, ValueError):
        return default


def _fmt_ass_ts(seconds):
    seconds = max(0.0, float(seconds))
    hours = int(seconds // 3600)
    mins = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    centis = int(round((seconds - int(seconds)) * 100))
    if centis == 100:
        seconds += 1
        return _fmt_ass_ts(seconds)
    return f"{hours}:{mins:02d}:{secs:02d}.{centis:02d}"


def subtitle_force_style(style_id=None, position=None, size=None):
    """Build the ASS force_style string for legacy .srt burns.

    New code writes .ass files (words_to_ass) that carry their own styles;
    this stays for the standalone --srt debug path. Unknown values fall
    back to the default look instead of failing.
    """
    theme = _theme_for(style_id)
    alignment, margin_v = _SUBTITLE_POSITIONS.get(
        (position or "").strip().lower(), (2, 200),
    )
    font_size = _font_size_for(style_id, size)
    primary = _ass_color(theme["inactive"],
                         theme.get("inactive_alpha", 0))
    outline = _ass_color(theme["outline"], 0x80 if theme["border"] == 1 and theme["outline_px"] <= 1 else 0)
    back = _ass_color(theme["back"], 0) if theme["border"] == 3 else "&H80000000"
    return (
        f"FontName={theme['font']},FontSize={font_size},"
        f"PrimaryColour={primary},OutlineColour={outline},"
        f"BackColour={back},BorderStyle={theme['border']},"
        f"Bold={theme['bold']},Italic={theme['italic']},"
        f"Outline={theme['outline_px']},Shadow={theme['shadow']},"
        f"Alignment={alignment},MarginV={margin_v}"
    )


def subtitle_ass_style_line(style_id=None, position=None, size=None):
    """Build the V4+ Style line for the generated .ass document."""
    theme = _theme_for(style_id)
    alignment, margin_v = _SUBTITLE_POSITIONS.get(
        (position or "").strip().lower(), (2, 200),
    )
    font_size = _font_size_for(style_id, size)
    primary = _ass_color(theme["inactive"],
                         theme.get("inactive_alpha", 0))
    secondary = _ass_color(theme["inactive"],
                           theme.get("inactive_alpha", 0))
    outline = _ass_color(theme["outline"])
    back = _ass_color(theme["back"], 0 if theme["border"] == 3 else 0x80)
    underline = -1 if theme.get("underline") else 0
    return (
        f"Style: Caption,{theme['font']},{font_size},"
        f"{primary},{secondary},{outline},{back},"
        f"{theme['bold']},{theme['italic']},{underline},0,100,100,0,0,"
        f"{theme['border']},{theme['outline_px']},{theme['shadow']},"
        f"{alignment},{_ASS_MARGIN_LR},{_ASS_MARGIN_LR},{margin_v},1"
    )


def words_to_ass(words, case="uppercase", style_id=None, position=None,
                 size=None, words_per_cue=None, aspect_ratio=None,
                 end_cap=None):
    """Convert word-level transcript words to a full ASS document.

    Each cue's words share one visible line; one Dialogue event is emitted
    per word so only the currently spoken word carries the theme's active
    styling — mirroring the monitor preview's animated highlight.

    Timing is continuous (karaoke-style): each event holds until the next
    word in its cue begins, so natural speech gaps never blink the line
    out. The cue's last word holds briefly, clipped at the next cue so
    events never overlap. ``end_cap`` (output seconds) additionally caps
    trailing holds so the final cue of an EDL assembly cannot bleed past
    the rendered output into the next segment's captions.
    """
    if words_per_cue is None:
        words_per_cue = cue_size_for_style(style_id)
    cues = []
    chunk = []
    for item in words or []:
        chunk.append(item)
        if len(chunk) >= words_per_cue:
            cues.append(chunk)
            chunk = []
    if chunk:
        cues.append(chunk)

    theme = _theme_for(style_id)
    active_tags = theme.get("active_tags", "")
    events = []
    for cue_idx, cue in enumerate(cues):
        texts = [_ass_escape(_apply_case(
            (w.get("word") or "").strip(), case)) for w in cue]
        next_cue_start = (
            _word_start(cues[cue_idx + 1][0])
            if cue_idx + 1 < len(cues) and cues[cue_idx + 1]
            else None
        )
        for idx, item in enumerate(cue):
            start = _word_start(item)
            try:
                end = float(item.get("end", start))
            except (TypeError, ValueError):
                end = start
            if end <= start:
                end = start + 0.5
            if idx < len(cue) - 1:
                # Hold the line (highlight moves on) until the next word.
                following = _word_start(cue[idx + 1], default=end)
                if following > start:
                    end = following
            elif next_cue_start is not None and next_cue_start > start:
                # Last word: brief hold, clipped so cues never overlap.
                end = min(end + CUE_TRAILING_HOLD, next_cue_start)
            else:
                end = end + CUE_TRAILING_HOLD
            if end_cap is not None:
                try:
                    end = min(end, float(end_cap))
                except (TypeError, ValueError):
                    pass
                if end <= start:
                    end = start + 0.01
            parts = []
            for j, text in enumerate(texts):
                if not text:
                    continue
                if j == idx and active_tags:
                    # Reset to the style after the active word so the
                    # highlight never leaks onto the following words.
                    parts.append(active_tags + text + r"{\r}")
                else:
                    parts.append(text)
            line = " ".join(parts).strip()
            if not line:
                continue
            events.append(
                f"Dialogue: 0,{_fmt_ass_ts(start)},{_fmt_ass_ts(end)},"
                f"Caption,,0,0,0,,{line}"
            )

    play_w, play_h = canvas_for(aspect_ratio)
    header = "\n".join([
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {play_w}",
        f"PlayResY: {play_h}",
        "WrapStyle: 0",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
        "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding",
        subtitle_ass_style_line(style_id, position, size),
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, "
        "Effect, Text",
    ])
    return header + "\n" + "\n".join(events) + "\n"


def _subtitles_filter(sub_path, style_id=None, position=None, size=None):
    """Build the `subtitles=` video-filter chunk for an .ass or .srt file."""
    escaped = _escape_subtitles_path(sub_path)
    if sub_path.lower().endswith(".ass"):
        # The .ass document carries PlayRes-pinned styles already.
        return f",subtitles={escaped}"
    force_style = subtitle_force_style(style_id, position, size)
    return f",subtitles={escaped}:force_style='{force_style}'"


def build_ffmpeg_args(
    input_path,
    output_path,
    preset_id,
    cut_duration=None,
    srt_path=None,
    meta_title=None,
    meta_desc=None,
    meta_tags=None,
    has_audio=True,
    subtitle_style=None,
    subtitle_position=None,
    subtitle_size=None,
    aspect_ratio=None,
    face_pixels=None,
    src_w=0,
    src_h=0,
    face_expanded=True,
):
    """Build the ffmpeg argument list (without the binary name)."""
    vf = single_crop_filter(
        preset_id, parse_aspect_ratio(aspect_ratio),
        face_pixels, src_w, src_h, face_expanded=face_expanded,
    )
    if srt_path:
        vf += _subtitles_filter(
            srt_path, subtitle_style, subtitle_position, subtitle_size,
        )

    afade_out_start = None
    if cut_duration and cut_duration > FADE_SECONDS:
        afade_out_start = cut_duration - FADE_SECONDS
    if afade_out_start is not None:
        af = (
            f"afade=t=in:st=0:d={FADE_SECONDS},"
            f"afade=t=out:st={afade_out_start:.3f}:d={FADE_SECONDS}"
        )
    else:
        af = f"afade=t=in:st=0:d={FADE_SECONDS}"

    args = ["-y", "-i", input_path]
    if cut_duration and cut_duration > 0:
        args += ["-t", f"{cut_duration:.3f}"]
    args += [
        "-vf", vf,
        "-c:v", "libx264", "-preset", "fast", "-crf", "20",
        "-movflags", "+faststart",
    ]
    if has_audio:
        args += ["-af", af, "-c:a", "aac", "-b:a", "192k"]
    else:
        args += ["-an"]
    if meta_title:
        args += ["-metadata", f"title={meta_title}"]
    if meta_desc:
        args += ["-metadata", f"comment={meta_desc}"]
    if meta_tags:
        args += ["-metadata", f"keywords={meta_tags}"]
    args.append(output_path)
    return args


def build_split_single_args(
    input_path,
    output_path,
    preset_id,
    face_pixels,
    layout="screen-top",
    cut_duration=None,
    srt_path=None,
    meta_title=None,
    meta_desc=None,
    meta_tags=None,
    has_audio=True,
    subtitle_style=None,
    subtitle_position=None,
    subtitle_size=None,
    src_w=0,
    src_h=0,
):
    """Build the ffmpeg argument list for a split/face-only single cut."""
    layout = parse_layout(layout)
    if layout == "face-only":
        chain, stacked = face_only_chain(
            "[0:v]", face_pixels, src_w, src_h)
    else:
        chain, stacked = split_video_chain(
            "[0:v]", face_pixels, layout, src_w, src_h)
    tail = _stack_tail(
        stacked, grade_mod.color_chain(preset_id), srt_path,
        subtitle_style, subtitle_position, subtitle_size,
    )
    args = ["-y", "-i", input_path]
    if cut_duration and cut_duration > 0:
        args += ["-t", f"{cut_duration:.3f}"]
    args += ["-filter_complex", f"{chain};{tail}", "-map", "[v]",
             "-c:v", "libx264", "-preset", "fast", "-crf", "20",
             "-movflags", "+faststart"]
    if has_audio:
        afade_out_start = None
        if cut_duration and cut_duration > FADE_SECONDS:
            afade_out_start = cut_duration - FADE_SECONDS
        if afade_out_start is not None:
            af = (
                f"afade=t=in:st=0:d={FADE_SECONDS},"
                f"afade=t=out:st={afade_out_start:.3f}:d={FADE_SECONDS}"
            )
        else:
            af = f"afade=t=in:st=0:d={FADE_SECONDS}"
        args += ["-af", af, "-c:a", "aac", "-b:a", "192k"]
    else:
        args += ["-an"]
    if meta_title:
        args += ["-metadata", f"title={meta_title}"]
    if meta_desc:
        args += ["-metadata", f"comment={meta_desc}"]
    if meta_tags:
        args += ["-metadata", f"keywords={meta_tags}"]
    args.append(output_path)
    return args


def _render_framed(input_path, output_path, segments, preset_id, info,
                   srt_path=None, subtitle_style=None, subtitle_position=None,
                   subtitle_size=None, meta_title=None, meta_desc=None, meta_tags=None,
                   layout="auto", face_roi="auto", aspect_ratio=None, log=print):
    aspect = parse_aspect_ratio(aspect_ratio)
    segments = sorted(segments, key=lambda s: s["start"])
    duration = info["duration"]
    for segment in segments:
        start, end = float(segment["start"]), float(segment["end"])
        if not (0 <= start < end <= duration + .05):
            raise RenderError(f"framing window outside source: {start}-{end}s (source {duration}s)")
        if end - start <= FADE_SECONDS and len(segments) > 1:
            raise RenderError("EDL segments must be longer than the audio crossfade")
    manual = None
    if (face_roi or "auto").strip().lower() not in ("", "auto"):
        roi = parse_face_roi(face_roi, info["width"], info["height"])
        manual = [roi[k] for k in ("x", "y", "w", "h")]
    try:
        plan = framing_mod.analyze(
            input_path, segments, info["width"], info["height"],
            effective_layout(layout, aspect), aspect, manual, log)
    except (RuntimeError, subprocess.TimeoutExpired) as exc:
        raise RenderError(f"framing analysis failed: {exc}") from exc
    plan["canvas"] = list(canvas_for(aspect))
    # Build geometry first so caption placement uses the actual output timeline.
    framing_mod.video_graph(plan, segments, *canvas_for(aspect), info["has_audio"], FADE_SECONDS)
    retention = framing_mod.face_retention(plan)
    if (retention["minimum_visible_face_retention"] is not None
            and retention["minimum_visible_face_retention"] < .98):
        raise RenderError("framing plan would cut a detected face; output was not rendered")
    if retention["source_face_clipped_samples"] > max(2, retention["face_samples"] * .10):
        warning = "Source camera clips the face in part of this clip; reframing preserves the visible portion."
        plan["warnings"].append(warning)
        log("[STAGE 1/4] " + warning)
    with tempfile.TemporaryDirectory(prefix="framed_captions_") as tmpdir:
        if srt_path and srt_path.lower().endswith(".ass"):
            with open(srt_path, encoding="utf-8") as handle:
                captions = framing_mod.place_captions(handle.read(), plan, subtitle_position)
            srt_path = os.path.join(tmpdir, "captions.ass")
            with open(srt_path, "w", encoding="utf-8") as handle:
                handle.write(captions)
        args = build_edl_ffmpeg_args(
            input_path, output_path, segments, preset_id, srt_path=srt_path,
            meta_title=meta_title, meta_desc=meta_desc, meta_tags=meta_tags,
            has_audio=info["has_audio"], subtitle_style=subtitle_style,
            subtitle_position=subtitle_position, subtitle_size=subtitle_size,
            aspect_ratio=aspect, framing_plan=plan)
        expected = edl_output_seconds(segments, info["has_audio"])
        args[-1:-1] = ["-t", f"{expected:.6f}"]
        log(f"[STAGE 4/4] {aspect} adaptive framing, {preset_id} grade" +
            (" & subtitles burned" if srt_path else " & clean video"))
        proc = subprocess.run(["ffmpeg"] + args, capture_output=True, text=True, timeout=3600)
        if proc.returncode:
            raise RenderError(f"ffmpeg framed render failed: {proc.stderr.strip()[-2000:]}")
    if not os.path.isfile(output_path):
        raise RenderError("ffmpeg exited 0 but no output file was produced")
    rendered = probe_media(output_path)
    valid = (rendered["width"], rendered["height"]) == canvas_for(aspect)
    valid = valid and abs(rendered["duration"] - expected) <= .15
    valid = valid and rendered["has_audio"] == info["has_audio"]
    framing_mod.save_report(output_path, plan, {
        "passed": valid, "expected_duration": expected, "output": rendered, **retention})
    if not valid:
        raise RenderError(f"framed output failed geometry/duration/audio validation: {rendered}")
    log(f"[COMPLETE] {aspect} Short rendered: {output_path}")
    return output_path


def render_short(
    input_path, output_path, preset_id="vertical_clean", cut_duration=None,
    srt_path=None, meta_title=None, meta_desc=None, meta_tags=None,
    subtitle_style=None, subtitle_position=None, subtitle_size=None,
    layout="auto", face_roi="auto", aspect_ratio=None, log=print,
):
    """Frame only the selected head cut, with local temporal face analysis."""
    if not os.path.isfile(input_path):
        raise RenderError(f"input video not found: {input_path}")
    _which_or_raise("ffmpeg")
    info = probe_media(input_path)
    end = min(cut_duration, info["duration"]) if cut_duration and cut_duration > 0 else info["duration"]
    log(f"[STAGE 2/4] Cut selected: 0.00-{end:.2f}s")
    return _render_framed(
        input_path, output_path, [{"start": 0., "end": end}], preset_id, info,
        srt_path, subtitle_style, subtitle_position, subtitle_size,
        meta_title, meta_desc, meta_tags, layout, face_roi, aspect_ratio, log)


def retime_words_for_edl(words, segments, has_audio=True):
    """Map source-timeline words onto the assembled output timeline.

    Words inside a segment shift by (output_offset - seg.start); words
    outside all segments are dropped. acrossfade joins consume FADE_SECONDS
    each, which the running offset accounts for.
    """
    out = []
    offset = 0.0
    ordered = sorted(segments, key=lambda s: s["start"])
    for i, seg in enumerate(ordered):
        s = float(seg["start"])
        e = float(seg["end"])
        for w in words or []:
            try:
                ws = float(w.get("start", -1))
                we = float(w.get("end", ws))
            except (TypeError, ValueError):
                continue
            if not (s <= ws < e):
                continue
            out.append({
                "word": w.get("word") or "",
                "start": round(ws - s + offset, 3),
                "end": round(min(we, e) - s + offset, 3),
            })
        offset += (e - s) - (FADE_SECONDS if has_audio and i < len(ordered) - 1 else 0.0)
    out.sort(key=lambda w: w["start"])
    return out


def edl_output_seconds(segments, has_audio=True):
    """Output duration of an EDL assembly: segment spans minus the
    acrossfade joins (which consume FADE_SECONDS each)."""
    ordered = sorted(segments, key=lambda s: s["start"])
    total = sum(float(s["end"]) - float(s["start"]) for s in ordered)
    if has_audio and len(ordered) > 1:
        total -= FADE_SECONDS * (len(ordered) - 1)
    return round(total, 3)


def build_edl_filter(segments, preset_id, srt_path=None, has_audio=True,
                     subtitle_style=None, subtitle_position=None,
                     subtitle_size=None, layout="single", face_pixels=None,
                     aspect_ratio=None, src_w=0, src_h=0,
                     face_expanded=True, framing_plan=None):
    """Build the filter_complex for multi-segment assembly.

    Video: per-segment trim + concat (hard cuts), then 9:16 grade — or the
    face + screen split stack when layout is screen-top/face-top.
    Audio: per-segment trim + 30ms acrossfade chain (true crossfades),
    plus edge fades at the very start/end.
    Returns (filter_complex_string, output_seconds).
    """
    ordered = sorted(segments, key=lambda s: s["start"])
    n = len(ordered)
    parts = []
    for i, seg in enumerate(ordered):
        s = float(seg["start"])
        e = float(seg["end"])
        parts.append(f"[0:v]trim=start={s:.3f}:end={e:.3f},setpts=PTS-STARTPTS[v{i}]")
    v_inputs = "".join(f"[v{i}]" for i in range(n))
    layout = effective_layout(layout, aspect_ratio)
    if framing_plan is not None:
        parts = []
        chain, framed = framing_mod.video_graph(
            framing_plan, ordered, *canvas_for(aspect_ratio), has_audio, FADE_SECONDS)
        parts.append(chain)
        parts.append(_stack_tail(
            framed, grade_mod.color_chain(preset_id), srt_path,
            subtitle_style, subtitle_position, subtitle_size))
    elif layout != "single" and face_pixels:
        parts.append(f"{v_inputs}concat=n={n}:v=1:a=0[vcat]")
        if layout == "face-only":
            chain, stacked = face_only_chain(
                "[vcat]", face_pixels, src_w, src_h)
        else:
            chain, stacked = split_video_chain(
                "[vcat]", face_pixels, layout, src_w, src_h)
        parts.append(chain)
        parts.append(_stack_tail(
            stacked, grade_mod.color_chain(preset_id), srt_path,
            subtitle_style, subtitle_position, subtitle_size,
        ))
    else:
        vf = single_crop_filter(
            preset_id, parse_aspect_ratio(aspect_ratio),
            face_pixels, src_w, src_h, face_expanded=face_expanded,
        )
        if srt_path:
            vf += _subtitles_filter(
                srt_path, subtitle_style, subtitle_position, subtitle_size,
            )
        parts.append(f"{v_inputs}concat=n={n}:v=1:a=0,{vf}[v]")

    total = edl_output_seconds(ordered, has_audio)
    if has_audio:
        for i, seg in enumerate(ordered):
            s = float(seg["start"])
            e = float(seg["end"])
            parts.append(
                f"[0:a]atrim=start={s:.3f}:end={e:.3f},asetpts=PTS-STARTPTS[a{i}]"
            )
        if n == 1:
            tail = f"afade=t=in:st=0:d={FADE_SECONDS}"
            if total > FADE_SECONDS:
                tail += f",afade=t=out:st={total - FADE_SECONDS:.3f}:d={FADE_SECONDS}"
            parts.append(f"[a0]{tail}[a]")
        else:
            label = "a0"
            for i in range(1, n):
                out_label = f"ax{i}"
                parts.append(
                    f"[{label}][a{i}]acrossfade=d={FADE_SECONDS}[{out_label}]"
                )
                label = out_label
            tail = f"afade=t=in:st=0:d={FADE_SECONDS}"
            if total > FADE_SECONDS:
                tail += f",afade=t=out:st={total - FADE_SECONDS:.3f}:d={FADE_SECONDS}"
            parts.append(f"[{label}]{tail}[a]")

    return ";".join(parts), total


def build_edl_ffmpeg_args(input_path, output_path, segments, preset_id,
                          srt_path=None, meta_title=None, meta_desc=None,
                          meta_tags=None, has_audio=True, subtitle_style=None,
                          subtitle_position=None, subtitle_size=None,
                          layout="single", face_pixels=None,
                          aspect_ratio=None, src_w=0, src_h=0,
                          face_expanded=True, framing_plan=None):
    """Build the ffmpeg argument list for EDL assembly (no binary name)."""
    if not segments:
        raise RenderError("EDL assembly needs at least one segment")
    filter_complex, _total = build_edl_filter(
        segments, preset_id, srt_path=srt_path, has_audio=has_audio,
        subtitle_style=subtitle_style, subtitle_position=subtitle_position,
        subtitle_size=subtitle_size, layout=layout, face_pixels=face_pixels,
        aspect_ratio=aspect_ratio, src_w=src_w, src_h=src_h,
        face_expanded=face_expanded,
        framing_plan=framing_plan,
    )
    args = ["-y", "-i", input_path, "-filter_complex", filter_complex,
            "-map", "[v]"]
    if has_audio:
        args += ["-map", "[a]", "-c:a", "aac", "-b:a", "192k"]
    else:
        args += ["-an"]
    args += ["-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p",
             "-movflags", "+faststart"]
    if meta_title:
        args += ["-metadata", f"title={meta_title}"]
    if meta_desc:
        args += ["-metadata", f"comment={meta_desc}"]
    if meta_tags:
        args += ["-metadata", f"keywords={meta_tags}"]
    args.append(output_path)
    return args


def render_edl(input_path, output_path, segments, preset_id="vertical_clean",
               words=None, subtitle_case="uppercase", subtitle_style=None,
               subtitle_position=None, subtitle_size=None,
               meta_title=None, meta_desc=None, meta_tags=None,
               layout="auto", face_roi="auto", aspect_ratio=None, log=print):
    """Frame every selected EDL span independently, then assemble and caption."""
    if not os.path.isfile(input_path):
        raise RenderError(f"input video not found: {input_path}")
    if not segments:
        raise RenderError("no EDL segments to render")
    _which_or_raise("ffmpeg")
    info = probe_media(input_path)
    log(f"[STAGE 2/4] EDL cut selected: {len(segments)} segments")
    with tempfile.TemporaryDirectory(prefix="edl_subs_") as tmpdir:
        srt_path = None
        if words:
            retimed = retime_words_for_edl(words, segments, info["has_audio"])
            if retimed:
                srt_path = os.path.join(tmpdir, "captions.ass")
                with open(srt_path, "w", encoding="utf-8") as handle:
                    handle.write(words_to_ass(
                        retimed, case=subtitle_case, style_id=subtitle_style,
                        position=subtitle_position, size=subtitle_size,
                        aspect_ratio=aspect_ratio,
                        end_cap=edl_output_seconds(segments, info["has_audio"])))
        return _render_framed(
            input_path, output_path, segments, preset_id, info,
            srt_path, subtitle_style, subtitle_position, subtitle_size,
            meta_title, meta_desc, meta_tags, layout, face_roi, aspect_ratio, log)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Render a vertical short with ffmpeg.")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--preset", default="vertical_clean")
    parser.add_argument("--duration", type=float, default=None)
    parser.add_argument("--edl", default=None, help="Optional edl.json for multi-segment assembly.")
    parser.add_argument("--srt", default=None, help="Optional .srt/.ass file to burn in.")
    parser.add_argument("--meta-title", default=None)
    parser.add_argument("--meta-desc", default=None)
    parser.add_argument("--meta-tags", default=None)
    parser.add_argument("--layout", default="auto",
                        help="auto|single|screen-top|face-top|face-only "
                             "(auto picks split for corner cams, "
                             "face-centered single otherwise).")
    parser.add_argument("--face-roi", default="auto",
                        help="auto, br|bl|tr|tl, or x,y,w,h fractions.")
    parser.add_argument("--aspect-ratio", default="9:16",
                        help="9:16|1:1|16:9 output canvas.")
    args = parser.parse_args(argv)

    try:
        if args.edl:
            if not os.path.isfile(args.edl):
                raise RenderError(f"EDL file not found: {args.edl}")
            with open(args.edl, "r", encoding="utf-8") as fh:
                edl = json.load(fh)
            render_edl(
                args.input, args.output, edl.get("segments", []),
                preset_id=args.preset, meta_title=args.meta_title,
                meta_desc=args.meta_desc, meta_tags=args.meta_tags,
                layout=args.layout, face_roi=args.face_roi,
                aspect_ratio=args.aspect_ratio,
            )
        else:
            render_short(
                args.input, args.output, preset_id=args.preset,
                cut_duration=args.duration, srt_path=args.srt,
                meta_title=args.meta_title, meta_desc=args.meta_desc,
                meta_tags=args.meta_tags,
                layout=args.layout, face_roi=args.face_roi,
                aspect_ratio=args.aspect_ratio,
            )
    except RenderError as exc:
        print(f"render.py: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
