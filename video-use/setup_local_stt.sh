#!/bin/sh
# One-time setup for on-device transcription (no API key, no uploads).
# Creates video-use/.venv, installs faster-whisper, and pre-downloads the
# small.en model so the first render never stalls on a download.
set -eu
cd "$(dirname "$0")"
engine_python=$(python3 helpers/runtime_env.py --python)
stt_env_dir=".venv"
if [ "${1:-}" = "--managed" ]; then
  stt_env_dir=$(python3 helpers/runtime_env.py)
fi

if [ ! -x "$stt_env_dir/bin/python" ]; then
  echo "creating video engine environment ..."
  "$engine_python" -m venv "$stt_env_dir"
fi
"$stt_env_dir/bin/python" -c 'import sys; sys.exit(sys.version_info < (3, 10))' || {
  echo "Existing engine uses an outdated Python. Back up that environment and rebuild it with Python 3.13." >&2
  exit 1
}
"$stt_env_dir/bin/python" -m pip install --upgrade pip
"$stt_env_dir/bin/python" -m pip install -r requirements-local.txt
echo "downloading faster-whisper small.en model ..."
"$stt_env_dir/bin/python" -c "from faster_whisper import WhisperModel; WhisperModel('small.en', device='cpu', compute_type='int8'); print('small.en ready')"
echo "done: renders now transcribe locally when no ElevenLabs key is set."
