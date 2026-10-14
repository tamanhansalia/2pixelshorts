#!/bin/sh
# Install local face detection without a transcription model or cloud key.
set -eu
cd "$(dirname "$0")"
engine_python=$(python3 helpers/runtime_env.py --python)
framing_env_dir=".venv"
if [ "${1:-}" = "--managed" ]; then
  framing_env_dir=$(python3 helpers/runtime_env.py)
fi
if [ ! -x "$framing_env_dir/bin/python" ]; then
  "$engine_python" -m venv "$framing_env_dir"
fi
"$framing_env_dir/bin/python" -m pip install -r requirements-framing.txt
"$framing_env_dir/bin/python" -c "import cv2; from pathlib import Path; model = str(Path('helpers/assets/models/face_detection_yunet_2023mar.onnx')); cv2.FaceDetectorYN.create(model, '', (960, 540)); print('Livestream framing ready')"
