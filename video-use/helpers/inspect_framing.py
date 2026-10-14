"""Inspect a rendered short and export a start/middle/end comparison sheet.

python helpers/inspect_framing.py --input short.mp4 --before old.mp4 --sheet qa.jpg
Requires the same OpenCV dependency as framing. Does not modify either video.
"""

import argparse
import json
import os

try:
    from . import framing, render
except ImportError:
    import framing
    import render


def inspect(input_path, sheet_path, before=None):
    import cv2
    import numpy as np
    with open(os.path.splitext(input_path)[0] + ".framing.json", encoding="utf-8") as handle:
        plan = json.load(handle)
    measured = render.probe_media(input_path)
    retention = framing.face_retention(plan)
    timestamps = [min(.5, measured["duration"]/4), measured["duration"]/2,
                  max(0, measured["duration"] - 1)]
    columns = [before, input_path] if before else [input_path]
    sheet = np.full((3*590, len(columns)*350, 3), 22, np.uint8)
    detections = []
    detector = cv2.FaceDetectorYN.create(framing.MODEL_PATH, "", (1080, 1920), .75, .3, 5000)
    for row, time in enumerate(timestamps):
        for col, path in enumerate(columns):
            info = render.probe_media(path)
            raw = render._grab_frame_jpeg(path, min(time, max(0, info["duration"]-.1)))
            frame = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
            h, w = frame.shape[:2]
            if path == input_path:
                detector.setInputSize((w, h))
                _, faces = detector.detect(frame)
                detections.append({"time": round(time, 3), "detected_faces": 0 if faces is None else len(faces)})
            scale = min(330/w, 545/h)
            preview = cv2.resize(frame, (round(w*scale), round(h*scale)))
            ph, pw = preview.shape[:2]
            x, y = col*350+(350-pw)//2, row*590+35
            sheet[y:y+ph, x:x+pw] = preview
            name = "BEFORE" if before and col == 0 else "AFTER"
            cv2.putText(sheet, f"{name}  {time:.1f}s", (col*350+10, row*590+24), 0, .6, (240,240,240), 1)
    if not cv2.imwrite(sheet_path, sheet):
        raise RuntimeError("could not save comparison sheet: " + sheet_path)
    canvas = plan["canvas"]
    valid = [measured["width"], measured["height"]] == canvas
    valid = valid and abs(measured["duration"]-plan["validation"]["expected_duration"]) <= .15
    valid = valid and (retention["minimum_visible_face_retention"] is None
                       or retention["minimum_visible_face_retention"] >= .98)
    return {"input": input_path, "sheet": sheet_path, "passed": valid,
            "output": measured, **retention, "snapshots": detections,
            "warnings": plan.get("warnings", [])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--before")
    parser.add_argument("--sheet", required=True)
    args = parser.parse_args()
    report = inspect(args.input, args.sheet, args.before)
    print(json.dumps(report, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
