"""Color-grade presets for the 2PixelShorts render pipeline.

Each preset maps to an ffmpeg ``-vf`` filter chain that scales/crops the
source to the requested aspect canvas (default vertical 9:16 1080x1920)
and applies a look. The filter strings intentionally mirror the
``fallback_ffmpeg_render`` presets in ``src-tauri/src/video_runner.rs`` so
the Python engine and the Rust fallback produce the same look for the
same preset id.
"""

from typing import Dict, Tuple

# Canvas dimensions per aspect ratio.
ASPECT_DIMS: Dict[str, Tuple[int, int]] = {
    "9:16": (1080, 1920),
    "1:1": (1080, 1080),
    "16:9": (1920, 1080),
}

# Vertical 9:16 base: upscale to cover, then center-crop.
_VERTICAL_BASE = "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920"

PRESETS: Dict[str, str] = {
    "warm_cinematic": f"{_VERTICAL_BASE},eq=contrast=1.12:saturation=1.15",
    "neutral_punch": f"{_VERTICAL_BASE},eq=contrast=1.06:saturation=1.05",
    # Indie 35mm: lifted matte blacks, muted saturation, olive shadow wash.
    "moody_film": (
        f"{_VERTICAL_BASE},eq=contrast=0.95:brightness=0.03:saturation=0.85,"
        "colorbalance=gs=0.08:bs=-0.08:gm=0.03"
    ),
    # Unfiltered natural camera colors; same framing as vertical_clean.
    "subtle": _VERTICAL_BASE,
    "vertical_clean": _VERTICAL_BASE,
}

DEFAULT_PRESET = "vertical_clean"
DEFAULT_ASPECT = "9:16"


def parse_aspect(value=None) -> str:
    """Normalize an aspect id; unknown values fall back to 9:16."""
    key = (value or "").strip()
    if key in ASPECT_DIMS:
        return key
    return DEFAULT_ASPECT


def canvas_for(aspect=None) -> Tuple[int, int]:
    """Return (width, height) for an aspect id."""
    return ASPECT_DIMS[parse_aspect(aspect)]


def base_filter_for(aspect=None) -> str:
    """Geometry portion (scale + crop) for an aspect canvas."""
    w, h = canvas_for(aspect)
    return f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}"


def _color_suffix(preset_id: str) -> str:
    """Return only the color-grade portion of a preset (no geometry)."""
    key = (preset_id or "").strip().lower()
    if key == "warm_cinematic":
        return ",eq=contrast=1.12:saturation=1.15"
    if key == "neutral_punch":
        return ",eq=contrast=1.06:saturation=1.05"
    if key == "moody_film":
        return (
            ",eq=contrast=0.95:brightness=0.03:saturation=0.85,"
            "colorbalance=gs=0.08:bs=-0.08:gm=0.03"
        )
    return ""


def get_filter(preset_id: str, aspect_ratio=None) -> str:
    """Return the ffmpeg video-filter chain for a preset id + aspect.

    Unknown ids fall back to the clean filter instead of failing,
    matching the Rust fallback behavior.
    """
    return base_filter_for(aspect_ratio) + _color_suffix(preset_id)


def color_chain(preset_id: str) -> str:
    """Return only the color-grade portion (no scale/crop) of a preset.

    Split layouts compose their own geometry (screen fit + face zoom +
    vstack) and apply this after stacking so both bands share the look.
    Returns "" for the clean presets.
    """
    return _color_suffix(preset_id)


def list_presets() -> Dict[str, str]:
    """Return a copy of the preset id -> filter-chain mapping."""
    return dict(PRESETS)
