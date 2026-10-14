"""Local, temporal framing for livestream clips. No prompts or cloud calls.

YuNet locates the face; the webcam region (not the face box) is fitted into
the lower panel. Every EDL window is analyzed independently on its own
timeline, so a crop from elsewhere in a long stream cannot leak into it.
"""

import json
import math
import os
import subprocess
import tempfile
from statistics import median

MODEL_PATH = os.path.join(os.path.dirname(__file__), "assets", "models",
                          "face_detection_yunet_2023mar.onnx")
ANALYSIS_FPS = 2.0
MAX_SAMPLES = 360
SCREEN_SHARE = 0.60
FACE_HOLD_SECONDS = 1.5


def even(value):
    return max(2, int(value) // 2 * 2)


def clamp(value, low, high):
    return min(max(value, low), max(low, high))


def rect(x, y, w, h, bounds):
    bx, by, bw, bh = bounds
    w, h = min(even(w), even(bw)), min(even(h), even(bh))
    x = int(clamp(x, bx, bx + bw - w)) // 2 * 2
    y = int(clamp(y, by, by + bh - h)) // 2 * 2
    return [x, y, w, h]


def contains(outer, inner, tolerance=2):
    x, y, w, h = outer
    fx, fy, fw, fh = inner
    return (x - tolerance <= fx and y - tolerance <= fy
            and x + w + tolerance >= fx + fw
            and y + h + tolerance >= fy + fh)


def corner_face(face, width, height):
    x, y, w, h = face
    cx, cy = (x + w / 2) / width, (y + h / 2) / height
    return h / height <= .23 and (cx < .32 or cx > .68) and (cy < .43 or cy > .57)


def safe_head(face, width, height):
    """Hair, ears/headphones and chin space beyond the detector's tight box."""
    x, y, w, h = face
    return rect(x - w * .40, y - h * .42, w * 1.8, h * 1.62,
                [0, 0, width, height])


def webcam_bounds(face, width, height):
    x, y, w, h = face
    cw = min(w * 3.8, width * .45)
    ch = min(max(h * 2.25, cw * .75), height * .50)
    return rect(x + w / 2 - cw / 2, y + h / 2 - ch * .62, cw, ch,
                [0, 0, width, height])


def refine_webcam(frame, approximate, face):
    """Use sustained image edges, requiring two sides, to find overlay bounds."""
    import cv2
    import numpy as np
    height, width = frame.shape[:2]
    pixels = cv2.GaussianBlur(frame, (3, 3), 0).astype(np.float32)
    x, y, w, h = approximate
    edges = [x, y, x + w, y + h]
    found = 0
    # Locate the horizontal camera borders first. When a person leans in,
    # the face estimate extends into the desktop above the overlay; using
    # that wrong vertical span to find side borders picks desktop windows.
    for side in (1, 3, 0, 2):
        value = edges[side]
        vertical = side in (0, 2)
        length, span = (width, w) if vertical else (height, h)
        radius = max(6, int(min(length * .16, span * .65)))
        lo, hi = (edges[1], edges[3]) if vertical else (edges[0], edges[2])
        a, b = int(lo + (hi - lo) * .1), int(hi - (hi - lo) * .1)
        if b - a < 12:
            continue
        scores = []
        for pos in range(max(2, int(value) - radius), min(length - 2, int(value) + radius)):
            if vertical:
                delta = np.max(np.abs(pixels[a:b, pos-2:pos].mean(axis=1)
                                      - pixels[a:b, pos:pos+2].mean(axis=1)), axis=1)
            else:
                delta = np.max(np.abs(pixels[pos-2:pos, a:b].mean(axis=0)
                                      - pixels[pos:pos+2, a:b].mean(axis=0)), axis=1)
            scores.append((pos, float(np.median(delta)), float((delta > 14).mean())))
        baseline = median(s[1] for s in scores) if scores else 0
        fx, fy, fw, fh = face
        def outside_face(pos):
            return (pos <= fx-fw*.30 if side == 0 else
                    pos <= fy if side == 1 else
                    pos >= fx+fw*1.30 if side == 2 else pos >= fy+fh)
        candidates = [(p, strength * support - abs(p - value) * .12
                       + ((p-value)*(.16 if side == 0 else -.16) if vertical else 0))
                      for p, strength, support in scores
                      if outside_face(p) and support >= .55 and strength >= max(18, baseline * 1.8 + 6)]
        if candidates:
            pos = max(candidates, key=lambda s: s[1])[0]
            edges[side] = pos + 2 if side < 2 else pos - 2
            found += 1
    left, top, right, bottom = edges
    if found < 2 or right <= left or bottom <= top:
        return approximate
    result = rect(left, top, right - left, bottom - top, [0, 0, width, height])
    # A visible edge must not snap through hair/chin or turn into a desktop window.
    if not .35 <= result[2] * result[3] / (w * h) <= 2 or not contains(result, face):
        return approximate
    return result


def choose_face(faces, previous, width, height):
    """Track the source webcam, including a large card in composed shorts."""
    if not faces:
        return None
    if height > width:
        # Edited shorts often contain the webcam twice: a tiny copy inside
        # the shared screen, and the actual large facecam card below it.
        lower = [f for f in faces if (f[1]+f[3]/2)/height >= .60
                 and f[3]/height >= .08 and f[2]/width >= .10]
        pool = lower or faces
    else:
        corners = [f for f in faces if corner_face(f, width, height)]
        pool = corners or faces
    if previous:
        px, py, pw, ph = previous
        def distance(f):
            x, y, w, h = f
            return math.hypot((x + w/2 - px - pw/2) / width,
                              (y + h/2 - py - ph/2) / height)
        closest = min(pool, key=distance)
        if distance(closest) < .15:
            return closest
    return max(pool, key=lambda f: f[2] * f[3])


def layout_for_face(face, width, height, requested, aspect, content=None):
    if requested == "auto" and height > width:
        # An existing portrait composition is already framed. Preserve its
        # screen, facecam card, padding and graphics in any output aspect.
        return "preserve"
    if face is None:
        return "fit"
    if requested == "single" or aspect != "9:16":
        return "single"
    if requested in ("face-only", "screen-top", "face-top"):
        return requested
    if content is not None:
        # A large speaker inset with black padding and a chat sidebar is
        # a talking-head scene, even when the face sits near the frame edge.
        return "single"
    if width > height and corner_face(face, width, height):
        return "screen-top"
    # A small central face can be an avatar or a photo on the shared screen.
    return "single" if face[3] / height >= .18 or height >= width else "fit"


def stabilize_samples(samples, width, height, requested, aspect):
    """Hold brief detector dropouts; require sustained evidence for layout cuts."""
    previous = None
    candidates = []
    for sample in samples:
        previous = choose_face(sample["faces"], previous, width, height)
        candidates.append(previous)
    def same_face(a, b):
        return (math.hypot((a[0]+a[2]/2-b[0]-b[2]/2)/width,
                           (a[1]+a[3]/2-b[1]-b[3]/2)/height) < .12
                and .5 <= a[3]/b[3] <= 2)
    # A single spurious face must not create a webcam panel, even if the
    # dropout hold would otherwise repeat that observation for several frames.
    confirmed = []
    for i, face in enumerate(candidates):
        supported = face is not None and (len(samples) == 1 or any(
            j != i and other is not None
            and abs(samples[j]["t"] - samples[i]["t"]) <= max(1.5, 2/ANALYSIS_FPS)
            and same_face(face, other) for j, other in enumerate(candidates)))
        confirmed.append(face if supported else None)
    last, last_time = None, -100
    for sample, face in zip(samples, confirmed):
        if sample.get("scene_cut"):
            last, last_time = None, -100
        stable_camera = (last is not None and corner_face(last, width, height)
                         and sample.get("content") is None and sample.get("camera_present", False))
        if face is None and (sample["t"] - last_time <= FACE_HOLD_SECONDS or stable_camera):
            face = last
            sample["held"] = True
        elif face is not None:
            last, last_time = face, sample["t"]
        sample["face"] = face
        sample["layout"] = layout_for_face(face, width, height, requested, aspect, sample.get("content"))
    if not samples:
        return []
    current = samples[0]["layout"]
    pending = []
    for i, sample in enumerate(samples):
        wanted = sample["layout"]
        if wanted == current:
            for j in pending:
                samples[j]["layout"] = current
            pending = []
            continue
        if pending and samples[pending[-1]]["layout"] != wanted:
            for j in pending:
                samples[j]["layout"] = current
            pending = []
        pending.append(i)
        if len(pending) >= 3:
            current, pending = wanted, []
    for j in pending:
        samples[j]["layout"] = current
    return samples


def content_region(frame):
    """Find a large padded video inset; exclude a sidebar across a black gutter."""
    import numpy as np
    height, width = frame.shape[:2]
    occupied = np.max(frame, axis=2) > 24
    rows = np.flatnonzero(occupied.mean(axis=1) > .015)
    if not len(rows):
        return None
    top, bottom = int(rows[0]), int(rows[-1]) + 1
    if top < height*.06 or height-bottom < height*.06 or bottom-top > height*.85:
        return None
    columns = occupied[top:bottom].mean(axis=0) > .025
    intervals, left = [], None
    for x, active in enumerate(list(columns) + [False]):
        if active and left is None:
            left = x
        if not active and left is not None:
            if x-left >= width*.45:
                intervals.append([left, top, x-left, bottom-top])
            left = None
    return max(intervals, key=lambda r: r[2]*r[3]) if intervals else None


def camera_region_present(frame, region):
    """Confirm a known webcam's borders while a profile/occlusion hides its face."""
    import numpy as np
    height, width = frame.shape[:2]
    x, y, w, h = (int(v) for v in region)
    if w > width*.5 or h > height*.5:
        return False
    pixels = frame.astype(np.float32)
    supported = 0
    for side, value in enumerate((x, y, x+w, y+h)):
        vertical = side in (0, 2)
        length = width if vertical else height
        a, b = (y+int(h*.1), y+int(h*.9)) if vertical else (x+int(w*.1), x+int(w*.9))
        for p in range(max(2, value-4), min(length-2, value+5)):
            if vertical:
                delta = np.max(np.abs(pixels[a:b, p-2:p].mean(axis=1)-pixels[a:b, p:p+2].mean(axis=1)), axis=1)
            else:
                delta = np.max(np.abs(pixels[p-2:p, a:b].mean(axis=0)-pixels[p:p+2, a:b].mean(axis=0)), axis=1)
            if len(delta) and float(np.median(delta)) >= 18 and float((delta > 14).mean()) >= .55:
                supported += 1
                break
    return supported >= 2


def stacked_facecam_boundary(frame, faces):
    """Find a broad horizontal card boundary above a large lower face.

    This is caption placement evidence only. It never changes source crops.
    Require a strong edge across most of the width, rather than guessing a
    fixed 60/40 seam from face position or from a screen's text rows.
    """
    import numpy as np
    height, width = frame.shape[:2]
    if height <= width:
        return None
    face = choose_face(faces, None, width, height)
    if face is None or (face[1]+face[3]/2)/height < .60 or face[3]/height < .08:
        return None
    # A detector box can extend into the padding above a clipped forehead.
    # Include the upper third of the box so the actual card edge is eligible.
    lo, hi = int(height*.35), int(min(height*.85, face[1]+face[3]*.35))
    if hi <= lo:
        return None
    left, right = int(width*.05), int(width*.95)
    pixels = frame[:, left:right].astype(np.float32)
    strip = max(2, int(height*.003))
    candidates = []
    for y in range(lo, hi):
        delta = np.max(np.abs(pixels[y-strip:y].mean(axis=0)
                              - pixels[y:y+strip].mean(axis=0)), axis=1)
        strength, support = float(np.median(delta)), float((delta > 18).mean())
        if strength >= 24 and support >= .70:
            candidates.append((y, strength*support))
    if not candidates:
        return None
    # The card edge sits immediately above the head. A stronger edge much
    # farther up can be a browser toolbar within the shared screen.
    return min(candidates, key=lambda item: (abs(item[0]-face[1]), -item[1]))[0]


def read_samples(input_path, start, end, width, height, fps, detector):
    """One FFmpeg decode per selected span; spool frames to bound RAM usage."""
    import cv2
    import numpy as np
    aw = even(min(width, 960))
    ah = even(height * aw / width)
    # Keep tall portrait footage bounded too.
    if ah > 1280:
        aw, ah = even(aw * 1280 / ah), 1280
    frame_bytes = aw * ah * 3
    samples = []
    previous_hist = None
    last_camera, last_selected = None, None
    with tempfile.TemporaryFile() as raw:
        proc = subprocess.run(
            ["ffmpeg", "-v", "error", "-ss", f"{start:.6f}", "-i", input_path,
             "-t", f"{end-start:.6f}", "-vf", f"fps={fps:.6f},scale={aw}:{ah}",
             "-an", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
            stdout=raw, stderr=subprocess.PIPE, timeout=180)
        if proc.returncode:
            raise RuntimeError("framing decode failed: " + proc.stderr.decode(errors="replace")[-500:])
        raw.seek(0)
        for index in range(MAX_SAMPLES + 1):
            data = raw.read(frame_bytes)
            if len(data) != frame_bytes:
                break
            frame = np.frombuffer(data, np.uint8).reshape(ah, aw, 3)
            content = content_region(frame)
            if content is not None:
                content = [v * (width/aw if k % 2 == 0 else height/ah)
                           for k, v in enumerate(content)]
            hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
            hist = cv2.calcHist([hsv], [0, 1], None, [16, 16], [0, 180, 0, 256])
            cv2.normalize(hist, hist)
            scene_cut = previous_hist is not None and cv2.compareHist(previous_hist, hist, cv2.HISTCMP_BHATTACHARYYA) > .65
            previous_hist = hist
            if scene_cut or content is not None:
                last_camera = None
            detector.setInputSize((aw, ah))
            _, detected = detector.detect(frame)
            detected = list(detected) if detected is not None else []
            # Small sunglasses/profile faces need larger detector input. Scan
            # corner tiles without re-decoding or enlarging the rendered pixels.
            if width > height and not any(corner_face(h[:4], aw, ah) for h in detected):
                tw, th = aw // 2, ah // 2
                for ox, oy in ((aw-tw, ah-th), (0, ah-th), (aw-tw, 0), (0, 0)):
                    tile = cv2.resize(frame[oy:oy+th, ox:ox+tw], (tw*2, th*2))
                    detector.setInputSize((tw*2, th*2))
                    _, hits = detector.detect(tile)
                    if hits is not None:
                        for hit in hits:
                            hit = hit.copy()
                            hit[0:14:2] = hit[0:14:2] / 2 + ox
                            hit[1:14:2] = hit[1:14:2] / 2 + oy
                            # Width/height are lengths, not coordinates.
                            hit[2], hit[3] = hit[2] - ox, hit[3] - oy
                            if corner_face(hit[:4], aw, ah):
                                detected.append(hit)
            faces, cams = [], []
            if detected:
                for hit in detected:
                    x, y, w, h = (float(v) for v in hit[:4])
                    if h / ah < .025 or hit[-1] < .75:
                        continue
                    small = [x, y, w, h]
                    large = [x * width/aw, y * height/ah, w * width/aw, h * height/ah]
                    faces.append(large)
                    if corner_face(large, width, height):
                        bounds = refine_webcam(frame, webcam_bounds(small, aw, ah), small)
                        cams.append([v * (width/aw if k % 2 == 0 else height/ah)
                                     for k, v in enumerate(bounds)])
                    else:
                        cams.append(None)
            selected = choose_face(faces, last_selected, width, height)
            if selected is not None and corner_face(selected, width, height) and content is None:
                cam = cams[faces.index(selected)]
                if cam is not None:
                    small = [v * (aw/width if k % 2 == 0 else ah/height) for k, v in enumerate(cam)]
                    if camera_region_present(frame, small):
                        last_camera = small
            if selected is not None:
                last_selected = selected
            camera_present = last_camera is not None and camera_region_present(frame, last_camera)
            seam = stacked_facecam_boundary(frame, [
                [v * (aw/width if k % 2 == 0 else ah/height) for k, v in enumerate(face)]
                for face in faces]) if height > width else None
            samples.append({"t": min(index / fps, end-start), "faces": faces,
                            "cams": cams, "scene_cut": scene_cut, "content": content,
                            "camera_present": camera_present,
                            "stacked_seam": seam * height/ah if seam is not None else None})
    return samples


def plan_from_samples(samples, start, end, width, height, requested, aspect, manual=None):
    if manual is not None and requested == "auto":
        requested = "single"
    samples = stabilize_samples(samples, width, height, requested, aspect)
    runs = []
    for index, sample in enumerate(samples):
        previous = runs[-1][-1] if runs else None
        moved = False
        if previous and sample["layout"] == "preserve":
            moved = bool(sample.get("scene_cut"))
            prior = [s["stacked_seam"] for s in runs[-1] if s.get("stacked_seam") is not None]
            seam = sample.get("stacked_seam")
            if prior and seam is not None and abs(seam-median(prior)) > height*.04:
                upcoming = samples[index:index+3]
                moved = moved or (len(upcoming) == 3 and all(
                    s.get("stacked_seam") is not None
                    and abs(s["stacked_seam"]-seam) <= height*.025 for s in upcoming))
        if previous and sample["layout"] in ("screen-top", "face-top", "face-only"):
            a, b = previous.get("face"), sample.get("face")
            if a is not None and b is not None:
                moved = (abs(a[0]-b[0]) > width * .18 or abs(a[1]-b[1]) > height * .18
                         or not .5 <= a[3]/b[3] <= 2)
        if not runs or runs[-1][0]["layout"] != sample["layout"] or moved:
            runs.append([])
        runs[-1].append(sample)
    if not runs:
        layout = layout_for_face(None, width, height, requested, aspect)
        shot = {"start": start, "end": end, "layout": layout, "samples": []}
        if layout == "preserve":
            shot["source_composition"] = "portrait"
        return [shot]
    shots = []
    for i, run in enumerate(runs):
        layout = run[0]["layout"]
        shot = {"start": start + (run[0]["t"] if i else 0),
                "end": start + runs[i+1][0]["t"] if i+1 < len(runs) else end,
                "layout": layout, "samples": run}
        contents = [s["content"] for s in run if s.get("content") is not None]
        if layout != "preserve" and len(contents) >= len(run)*.6:
            shot["content"] = rect(*(median(c[k] for c in contents) for k in range(4)),
                                   [0, 0, width, height])
        if layout == "preserve":
            shot["source_composition"] = "portrait"
            seams = [s["stacked_seam"] for s in run if s.get("stacked_seam") is not None]
            if seams:
                boundary = median(seams)
                stable = [y for y in seams if abs(y-boundary) <= height*.025]
                if len(stable) >= max(2, len(run)*.6):
                    shot["source_composition"] = "screen-over-facecam"
                    shot["source_seam"] = median(stable)
        cams = []
        for sample in run:
            if sample["face"] is not None and sample["face"] in sample["faces"]:
                cam = sample["cams"][sample["faces"].index(sample["face"])]
                if cam:
                    cams.append(cam)
        if manual is not None:
            shot["cam"] = manual
        elif cams:
            # Webcam edges are fixed: don't pan the entire overlay with every head tilt.
            shot["cam"] = rect(*(median(c[k] for c in cams) for k in range(4)),
                               [0, 0, width, height])
        if layout in ("screen-top", "face-top", "face-only") and "cam" not in shot:
            faces = [s["face"] for s in run if s["face"] is not None]
            if faces:
                shot["cam"] = webcam_bounds([median(f[k] for f in faces) for k in range(4)], width, height)
            else:
                shot["layout"] = "fit"
        shots.append(shot)
    return shots


def analyze(input_path, segments, width, height, requested="auto", aspect="9:16", manual=None, log=print):
    total = sum(s["end"] - s["start"] for s in segments)
    fps = min(ANALYSIS_FPS, MAX_SAMPLES / max(total, 1))
    plan = {"version": 1, "source_size": [width, height], "requested_layout": requested,
            "aspect": aspect, "analysis_fps": fps, "detector": "manual" if manual else "YuNet",
            "shots": [], "warnings": []}
    if width > height and height < 720:
        plan["warnings"].append(f"Low-resolution source ({width}x{height}); webcam detail is limited. "
                                "Use a 720p or 1080p source for sharper shorts.")
    detector = None
    if manual is None:
        try:
            import cv2
            detector = cv2.FaceDetectorYN.create(MODEL_PATH, "", (960, 540), .75, .3, 5000)
        except Exception as exc:
            plan["detector"] = "unavailable"
            plan["warnings"].append("Face detection unavailable; preserving the full source. "
                                    "Run video-use/setup_framing.sh. " + str(exc))
    for index, seg in enumerate(segments):
        start, end = float(seg["start"]), float(seg["end"])
        log(f"[STAGE 1/4] Framing window {index+1}/{len(segments)}: {start:.2f}-{end:.2f}s")
        if manual is not None:
            samples = [{"t": 0, "faces": [manual], "cams": [manual]}]
        elif detector is not None:
            samples = read_samples(input_path, start, end, width, height, fps, detector)
        else:
            samples = []
        shots = plan_from_samples(samples, start, end, width, height, requested, aspect, manual)
        for shot in shots:
            shot["segment"] = index
        plan["shots"].extend(shots)
    for warning in plan["warnings"]:
        log("[STAGE 1/4] " + warning)
    log("[STAGE 1/4] Framing: " + ", ".join(
        f"{s['start']:.1f}-{s['end']:.1f}s {s['layout']}" for s in plan["shots"]))
    return plan


def fit_chain(label, region, out_w, out_h, prefix):
    """Fit every source pixel over a soft backdrop, with no second cover crop."""
    x, y, w, h = region
    return (f"{label}crop={w}:{h}:{x}:{y},split[{prefix}bg][{prefix}fg];"
            f"[{prefix}bg]scale={out_w}:{out_h}:force_original_aspect_ratio=increase,"
            f"crop={out_w}:{out_h},gblur=sigma=30[{prefix}blur];"
            f"[{prefix}fg]scale={out_w}:{out_h}:force_original_aspect_ratio=decrease[{prefix}fit];"
            f"[{prefix}blur][{prefix}fit]overlay=x=(W-w)/2:y=(H-h)/2:shortest=1,"
            f"setsar=1[{prefix}out]")


def focus_crop(shot, width, height, out_w, out_h):
    """Fixed crop size per shot; smooth face motion without zoom pumping."""
    faces = [(s["t"] - shot["samples"][0]["t"], s["face"])
             for s in shot["samples"] if s.get("face") is not None]
    if not faces:
        return None
    if shot["layout"] == "face-only" and "cam" in shot and any(
            corner_face(f, width, height) for _, f in faces):
        # A landscape webcam often cannot fill a portrait without cutting
        # headphones/hair. Fitting its complete region is the safe composition.
        return None
    ratio = out_w / out_h
    bx, by, bw, bh = shot.get("content", [0, 0, width, height])
    # Single crop uses the full source height where possible. Face-only keeps
    # head and shoulders, never a narrow portrait crop of a tight face box.
    ch = min(bh, bw / ratio)
    if shot["layout"] == "face-only":
        ch = min(ch, max(f[3] * 3.2 for _, f in faces))
    # Widen the viewport when a complete head cannot fit the target aspect;
    # the renderer then fits it with a soft backdrop instead of cutting ears.
    cw = min(bw, max(ch * ratio, max(safe_head(f, width, height)[2] for _, f in faces)))
    cw, ch = even(cw), even(ch)
    positions = []
    prev = None
    for time, face in faces:
        head = safe_head(face, width, height)
        # If the head cannot fit this aspect, preserve the webcam/source with fit.
        if head[2] > cw or head[3] > ch:
            return None
        fx, fy, fw, fh = face
        tx = clamp(fx + fw/2 - cw/2, bx, bx+bw-cw)
        ty = clamp(fy + fh/2 - ch*.40, by, by+bh-ch)
        if prev:
            dt = max(.01, time - prev[0])
            tx = prev[1] if abs(tx-prev[1]) < cw*.06 else prev[1] + clamp(tx-prev[1], -cw*.65*dt, cw*.65*dt)
            ty = prev[2] if abs(ty-prev[2]) < ch*.04 else prev[2] + clamp(ty-prev[2], -ch*.65*dt, ch*.65*dt)
        # The safety constraint overrides smoothing when the head approaches an edge.
        tx = clamp(tx, max(bx, head[0]+head[2]-cw), min(bx+bw-cw, head[0]))
        ty = clamp(ty, max(by, head[1]+head[3]-ch), min(by+bh-ch, head[1]))
        prev = (time, tx, ty)
        positions.append(prev)
    if len(positions) > 40:
        reduced = [positions[round(i*(len(positions)-1)/39)] for i in range(40)]
        for (time, face) in faces:
            a, b = reduced[0], reduced[-1]
            for left, right in zip(reduced, reduced[1:]):
                if left[0] <= time <= right[0]:
                    a, b = left, right
                    break
            fraction = clamp((time-a[0])/max(b[0]-a[0], .001), 0, 1)
            x, y = a[1]+(b[1]-a[1])*fraction, a[2]+(b[2]-a[2])*fraction
            if not contains([x, y, cw, ch], safe_head(face, width, height)):
                return None
        positions = reduced
    return cw, ch, positions


def path_expr(points):
    """FFmpeg expression in local shot time. Linear camera motion, bounded size."""
    if not points:
        return "0"
    # Only retain meaningful path changes; a static camera becomes one constant.
    reduced = [points[0]]
    for point in points[1:]:
        if abs(point[1] - reduced[-1][1]) >= 2 or point == points[-1]:
            reduced.append(point)
    if max(v for _, v in reduced) - min(v for _, v in reduced) < 2:
        return f"{reduced[0][1]:.3f}"
    expression = f"{reduced[-1][1]:.3f}"
    for (a, av), (b, bv) in reversed(list(zip(reduced, reduced[1:]))):
        if b <= a:
            continue
        ramp = f"({av:.3f}+({bv-av:.3f})*clip((t-{a:.4f})/{b-a:.4f},0,1))"
        expression = f"if(lt(t,{b:.4f}),{ramp},{expression})"
    return expression


def video_graph(plan, segments, out_w, out_h, has_audio=False, fade=.03):
    width, height = plan["source_size"]
    parts, outputs = [], []
    offset = 0
    for i, shot in enumerate(plan["shots"]):
        segment = shot["segment"]
        # Audio crossfades consume time; remove the matching video tail so
        # captions, source cuts and A/V remain synchronized across EDL joins.
        end = min(shot["end"], segments[segment]["end"] -
                  (fade if has_audio and segment < len(segments)-1 else 0))
        if end <= shot["start"]:
            continue
        prefix = f"fr{i}"
        label = f"[{prefix}src]"
        parts.append(f"[0:v]trim=start={shot['start']:.6f}:end={end:.6f},setpts=PTS-STARTPTS{label}")
        layout = shot["layout"]
        full = [0, 0, even(width), even(height)]
        content = shot.get("content", full)
        if layout == "preserve":
            parts.append(fit_chain(label, full, out_w, out_h, prefix))
            shot["crop"] = full
            if "source_seam" in shot:
                scale = min(out_w/width, out_h/height)
                top = (out_h-height*scale)/2
                face_tops = [s["face"][1] for s in shot["samples"] if s.get("face") is not None]
                seam = min([shot["source_seam"]] + face_tops)
                shot["caption_y"] = round(top + seam*scale - min(64, out_h*.04))
                shot["caption_alignment"] = 2
        elif layout in ("screen-top", "face-top"):
            screen_h = even(out_h * SCREEN_SHARE)
            face_h = out_h - screen_h
            parts.append(f"{label}split[{prefix}s][{prefix}f]")
            parts.append(fit_chain(f"[{prefix}s]", full, out_w, screen_h, prefix+"s"))
            cam = shot["cam"]
            # Include the observed head envelope if boundary estimation was uncertain.
            heads = [s["face"] for s in shot["samples"] if s.get("face")]
            if any(not contains(cam, head, tolerance=0) for head in heads):
                left = min([cam[0]] + [h[0] for h in heads]); top = min([cam[1]] + [h[1] for h in heads])
                right = max([cam[0]+cam[2]] + [h[0]+h[2] for h in heads]); bottom = max([cam[1]+cam[3]] + [h[1]+h[3] for h in heads])
                # Round outward. Rounding a low-resolution face envelope down
                # by two pixels can remove several percent of the chin.
                cam = rect(int(left)//2*2, int(top)//2*2,
                           right-left+4, bottom-top+4, full)
            parts.append(fit_chain(f"[{prefix}f]", cam, out_w, face_h, prefix+"f"))
            first, second = (prefix+"fout", prefix+"sout") if layout == "face-top" else (prefix+"sout", prefix+"fout")
            parts.append(f"[{first}][{second}]vstack=inputs=2:shortest=1[{prefix}out]")
            shot["crop"] = cam
            shot["caption_y"] = face_h + 64 if layout == "face-top" else screen_h - 64
            shot["caption_alignment"] = 8 if layout == "face-top" else 2
        elif layout in ("single", "face-only"):
            crop = focus_crop(shot, width, height, out_w, out_h)
            if crop is None:
                parts.append(fit_chain(label, shot.get("cam", content), out_w, out_h, prefix))
                shot["crop"] = shot.get("cam", content)
            else:
                cw, ch, positions = crop
                x = path_expr([(t, x) for t, x, _ in positions])
                y = path_expr([(t, y) for t, _, y in positions])
                if abs(cw/ch - out_w/out_h) < .005:
                    parts.append(f"{label}crop={cw}:{ch}:x='{x}':y='{y}',scale={out_w}:{out_h},setsar=1[{prefix}out]")
                else:
                    parts.append(f"{label}crop={cw}:{ch}:x='{x}':y='{y}'[{prefix}tracked]")
                    parts.append(fit_chain(f"[{prefix}tracked]", [0, 0, cw, ch], out_w, out_h, prefix))
                shot["crop_size"], shot["crop_path"] = [cw, ch], positions
        else:
            parts.append(fit_chain(label, content, out_w, out_h, prefix))
            shot["crop"] = content
        shot["output_start"], shot["output_end"] = offset, offset + end - shot["start"]
        offset = shot["output_end"]
        outputs.append(f"[{prefix}out]")
    parts.append("".join(outputs) + f"concat=n={len(outputs)}:v=1:a=0[vframed]")
    return ";".join(parts), "[vframed]"


def place_captions(text, plan, position=None):
    """Place default/bottom split captions on the screen side of the seam."""
    if position not in (None, "", "bottom", "center"):
        return text
    def seconds(stamp):
        h, m, s = stamp.split(":")
        return int(h)*3600 + int(m)*60 + float(s)
    lines = []
    for line in text.splitlines():
        if line.startswith("Dialogue:"):
            fields = line.split(",", 9)
            time = seconds(fields[1])
            shot = next((s for s in plan["shots"] if s.get("output_start", 0) <= time < s.get("output_end", 0)), None)
            if shot and "caption_y" in shot:
                # Apply after every style reset too; active-word highlighting
                # must not reset positioning back onto the person's face.
                tag = r"{\an%d\pos(%d,%d)}" % (shot["caption_alignment"], plan["canvas"][0]//2, shot["caption_y"])
                fields[9] = tag + fields[9].replace(r"{\r}", r"{\r}" + tag)
                line = ",".join(fields)
        lines.append(line)
    return "\n".join(lines) + "\n"


def save_report(output_path, plan, validation):
    report = dict(plan, validation=validation)
    # Keep the actionable selected track, not all competing screen faces.
    report["shots"] = [dict(s, samples=[{"t": p["t"], "face": p.get("face"),
                                         "held": p.get("held", False)} for p in s["samples"]])
                       for s in plan["shots"]]
    with open(os.path.splitext(output_path)[0] + ".framing.json", "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)


def face_retention(plan):
    """Measure source-visible face pixels retained by the planned viewports."""
    width, height = plan["source_size"]
    fractions, source_fractions = [], []
    for shot in plan["shots"]:
        path = shot.get("crop_path")
        for sample in shot["samples"]:
            face = sample.get("face")
            if face is None:
                continue
            x, y, w, h = face
            sx, sy, sw, sh = shot.get("content", [0, 0, width, height])
            left, top, right, bottom = max(sx, x), max(sy, y), min(sx+sw, x+w), min(sy+sh, y+h)
            if path:
                time = sample["t"] - shot["samples"][0]["t"]
                a, b = path[0], path[-1]
                for first, second in zip(path, path[1:]):
                    if first[0] <= time <= second[0]:
                        a, b = first, second
                        break
                f = clamp((time-a[0])/max(b[0]-a[0], .001), 0, 1)
                cw, ch = shot["crop_size"]
                crop = [a[1]+(b[1]-a[1])*f, a[2]+(b[2]-a[2])*f, cw, ch]
            else:
                crop = shot["crop"]
            cx, cy, cw, ch = crop
            retained = max(0, min(right, cx+cw)-max(left, cx)) * max(0, min(bottom, cy+ch)-max(top, cy))
            area = max(0, right-left)*max(0, bottom-top)
            if area > 0:
                fractions.append(min(1., retained/area))
                source_fractions.append(min(1., area/(w*h)))
    return {"face_samples": len(fractions), "minimum_visible_face_retention": min(fractions) if fractions else None,
            "source_face_clipped_samples": sum(f < .90 for f in source_fractions)}
