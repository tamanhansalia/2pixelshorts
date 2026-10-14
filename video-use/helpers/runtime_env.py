"""Stable per-user engine environment, also used by the native resolver."""
from pathlib import Path
import os
import shutil
import subprocess
import sys


def managed_env():
    return Path.home() / ".2pixelshorts" / "video-use" / ".venv"


def supported_python():
    requested = os.environ.get("PIXEL_PYTHON")
    candidates = [requested] if requested else ["python3.13", "python3.12", "python3.11", "python3.10", "python3"]
    for candidate in candidates:
        executable = shutil.which(candidate) if candidate else None
        if not executable:
            continue
        try:
            result = subprocess.run([executable, "-c", "import sys;sys.exit(sys.version_info < (3,10))"], timeout=5, capture_output=True)
            if result.returncode == 0:
                return executable
        except (OSError, subprocess.TimeoutExpired):
            pass
    raise RuntimeError("Local captions need Python 3.10+ for patched dependencies. Install Python 3.13, or set PIXEL_PYTHON to its executable.")


if __name__ == "__main__":
    try:
        print(supported_python() if "--python" in sys.argv else managed_env())
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
