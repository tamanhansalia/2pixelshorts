"""Agent-driven cut selection (EDL generation).

Builds an edit prompt from packed takes + channel context, invokes the
selected agent CLI headlessly, and parses the returned Edit Decision List:

    {"segments": [{"start": 12.5, "end": 28.0, "score": 0.9, "reason": "..."}]}

Headless invocations below were verified live against each CLI's `--help`
(and end-to-end for claude/grok) during the Phase 0 spike. `probe_agent()`
re-verifies availability on the current machine instead of assuming it:
an agent is offered only when its binary exists AND its help advertises a
non-interactive mode.

Any failure raises AgentError — the pipeline catches it and falls back to
the automatic head-cut, so rendering never depends on agent success.

Stdlib only.
"""

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile

try:
    from . import edit_references as reference_mod
except ImportError:
    import edit_references as reference_mod

# JSON Schema constraining structured agent output. Strict-mode compatible:
# every object sets additionalProperties=false and requires all of its
# properties (OpenAI structured output rejects the schema otherwise).
EDL_SCHEMA = {
    "type": "object",
    "properties": {
        "segments": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "start": {"type": "number"},
                    "end": {"type": "number"},
                    "score": {"type": "number"},
                    "reason": {"type": "string"},
                },
                "required": ["start", "end", "score", "reason"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["segments"],
    "additionalProperties": False,
}

# Envelope fields tried (in order) when an agent wraps its answer in a
# result object instead of printing raw JSON. `structured_output` (emitted
# by agy alongside the human-readable `response`) goes first: it is the
# schema-validated object, while `response` may carry prose or extra keys.
ENVELOPE_FIELDS = ("structured_output", "result", "text", "output", "response", "lastMessage", "message")

# Prompt budget: direct process spawn allows ~32k chars on Windows; stay
# well under it so long transcripts can't break invocation.
MAX_PROMPT_CHARS = 20000
MIN_SEGMENT_SECONDS = 0.5


class AgentError(Exception):
    pass


def private_agent_env():
    # Editing models consume the supplied transcript. They do not need
    # publishing/transcription credentials inherited by the video engine.
    return {key: value for key, value in os.environ.items() if key not in (
        "PIXEL_ELEVENLABS_KEY", "PIXEL_YOUTUBE_KEY", "ZERNIO_API_KEY",
        "ELEVENLABS_API_KEY", "YOUTUBE_API_KEY",
    )}


def _claude_argv(binary, prompt, model, _schema_file):
    argv = [binary]
    if model:
        argv += ["--model", model]
    return argv + ["-p", "--tools", "", "--strict-mcp-config", "--disable-slash-commands", "--output-format", "json", prompt]


def _codex_argv(binary, prompt, model, schema_file):
    argv = [binary, "exec", "--sandbox", "read-only", "--skip-git-repo-check"]
    if model:
        argv += ["-m", model]
    if schema_file:
        argv += ["--output-schema", schema_file]
    return argv + [prompt]


def _agy_argv(binary, prompt, model, _schema_file):
    # agy's `-p` consumes the next token as the prompt value, so every
    # option flag must precede it: `agy [options] -p '<prompt>'`.
    # (The previous `agy -p --output-format json ... <prompt>` order made
    # `-p` swallow `--output-format` as the prompt and every agy cut
    # failed with exit 2, silently falling back to the automatic head-cut.)
    argv = [binary]
    if model:
        argv += ["--model", model]
    return argv + [
        "--mode", "plan", "--sandbox", "--disable-slash-commands",
        "--output-format", "json",
        "--json-schema", json.dumps(EDL_SCHEMA),
        "-p", prompt,
    ]


def _grok_argv(binary, prompt, model, _schema_file):
    argv = [binary]
    if model:
        argv += ["-m", model]
    return argv + ["--tools", "", "--disable-web-search", "-p", prompt, "--json-schema", json.dumps(EDL_SCHEMA)]


# agent_id -> {binaries, help_markers, argv builder, needs_schema_file}
AGENTS = {
    "claude": {
        "binaries": ["claude"],
        "help_markers": ["--print"],
        "argv": _claude_argv,
        "needs_schema_file": False,
        "extract": "envelope",
    },
    "codex": {
        "binaries": ["codex"],
        "help_markers": ["exec"],
        "argv": _codex_argv,
        "needs_schema_file": True,
        "extract": "generic",
    },
    "agy": {
        "binaries": ["agy"],
        "help_markers": ["--print"],
        "argv": _agy_argv,
        "needs_schema_file": False,
        "extract": "generic",
    },
    "grok": {
        "binaries": ["grok"],
        "help_markers": ["--single"],
        "argv": _grok_argv,
        "needs_schema_file": False,
        "extract": "envelope",
    },
}


def probe_agent(agent_id):
    """Check an agent's headless availability on this machine.

    Returns {"agent", "available", "binary", "path", "note"}. Never raises.
    """
    agent_id = (agent_id or "").strip().lower()
    spec = AGENTS.get(agent_id)
    if spec is None:
        return {
            "agent": agent_id, "available": False, "binary": None,
            "path": None, "note": f"unknown agent '{agent_id}'",
        }
    path = None
    binary = None
    for cand in spec["binaries"]:
        # Windows batch wrappers run through cmd.exe, whose quote rules are
        # unsafe for arbitrary transcript/prompt text. Prefer native CLIs.
        found = (shutil.which(cand + ".exe") if os.name == "nt" else None) or shutil.which(cand)
        if found:
            binary, path = cand, found
            break
    if not path:
        return {
            "agent": agent_id, "available": False, "binary": spec["binaries"][0],
            "path": None, "note": "binary not found in PATH",
        }
    if os.name == "nt" and path.lower().endswith((".cmd", ".bat")):
        return {
            "agent": agent_id, "available": False, "binary": binary,
            "path": path, "note": "Use a native .exe on PATH. Batch launchers are unsafe for untrusted video text.",
        }
    try:
        proc = subprocess.run(
            [path, "--help"], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=20,
        )
        help_text = (proc.stdout or "") + (proc.stderr or "")
    except Exception as exc:
        return {
            "agent": agent_id, "available": False, "binary": binary,
            "path": path, "note": f"--help probe failed: {exc}",
        }
    if not any(marker in help_text for marker in spec["help_markers"]):
        return {
            "agent": agent_id, "available": False, "binary": binary,
            "path": path, "note": "no non-interactive mode advertised in --help",
        }
    return {
        "agent": agent_id, "available": True, "binary": binary,
        "path": path, "note": "headless mode verified",
    }


def build_prompt(takes_text, duration, target_duration, context=None, hook=None,
                 references=None):
    """Build the edit prompt, truncating takes to the prompt budget."""
    lines = [
        "You are a viral-shorts editor. Pick the best continuous segments",
        "for a vertical short from the transcript takes below.",
        f"SOURCE DURATION: {duration:.1f} seconds.",
    ]
    if target_duration and target_duration > 0:
        lines.append(f"TARGET: total selected footage <= {target_duration:.0f} seconds.")
    else:
        lines.append("TARGET: total selected footage <= 30 seconds.")
    if context and context.strip():
        lines.append(f"CHANNEL CONTEXT: {context.strip()}")
    if hook and hook.strip():
        lines.append(f"CUSTOM EDIT PROMPT: {hook.strip()}")
    if references:
        lines.append(reference_mod.reference_context(references))
    lines += [
        "RULES:",
        "- Output ONLY a JSON object, no markdown fences, no commentary.",
        '- Shape: {"segments": [{"start": s, "end": e, "score": 0-1, "reason": "..."}]}',
        "- start/end are seconds (floats), start < end, within 0 and the source duration.",
        "- Prefer fewer high-energy segments; keep sentence boundaries using take timestamps.",
        "- Follow the custom prompt for hook, topic and pacing using SOURCE footage only.",
        "- This is source cut selection: do not promise overlays, new audio, or inserted footage.",
        "TAKES:",
    ]
    header = "\n".join(lines) + "\n"
    budget = MAX_PROMPT_CHARS - len(header) - 200
    takes = takes_text or ""
    if len(takes) > budget:
        takes = takes[:budget] + "\n[... transcript truncated for prompt budget ...]"
    return header + takes


def _strip_fences(text):
    text = text.strip()
    if text.startswith("```"):
        text = re_sub_fences(text)
    return text.strip()


def re_sub_fences(text):
    # Remove a single wrapping markdown code fence if present.
    lines = text.split("\n")
    if lines and lines[0].strip().startswith("```"):
        lines = lines[1:]
    if lines and lines[-1].strip() == "```":
        lines = lines[:-1]
    return "\n".join(lines)


def _balanced_json_object(text):
    """Extract the first balanced {...} substring, or None."""
    start = text.find("{")
    if start == -1:
        return None
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    return None


def _envelope_error(text):
    """Return the agent's own error message from a result envelope, if any.

    CLIs report runtime failures (rate limits, auth, bad schema) as a JSON
    envelope on stdout even when the exit code is 0 — or alongside a
    non-zero exit with empty stderr. Surfacing their message beats a
    generic parse error. Returns None when the text is not an envelope.
    """
    try:
        doc = json.loads(_strip_fences((text or "").strip()))
    except (json.JSONDecodeError, ValueError, AttributeError):
        return None
    if not isinstance(doc, dict):
        return None
    message = None
    if doc.get("is_error") is True or doc.get("type") == "error":
        message = doc.get("result") or doc.get("message")
    err = doc.get("error")
    if message is None and isinstance(err, dict):
        message = err.get("message") or err.get("code")
    elif message is None and isinstance(err, str):
        message = err
    if isinstance(message, dict):
        message = message.get("message") or message.get("text")
    if message is None or (isinstance(message, str) and not message.strip()):
        return None
    return str(message).strip()[:300]


def extract_json(stdout, _agent_id):
    """Extract the EDL dict from raw agent stdout (layered fallbacks)."""
    text = (stdout or "").strip()
    if not text:
        raise AgentError("agent returned empty output")
    envelope_err = _envelope_error(text)
    if envelope_err:
        raise AgentError(f"agent error: {envelope_err}")

    candidates = []
    try:
        envelope = json.loads(_strip_fences(text))
    except (json.JSONDecodeError, ValueError):
        envelope = None
    if isinstance(envelope, dict):
        if "segments" in envelope:
            candidates.append(envelope)
        for field in ENVELOPE_FIELDS:
            val = envelope.get(field)
            if isinstance(val, str) and val.strip():
                candidates.append(val)
            elif isinstance(val, dict) and "segments" in val:
                candidates.append(val)

    balanced = _balanced_json_object(text)
    if balanced:
        candidates.append(balanced)
    candidates.append(text)

    last_err = "no JSON found"
    for cand in candidates:
        if isinstance(cand, dict):
            return cand
        try:
            parsed = json.loads(_strip_fences(cand))
        except (json.JSONDecodeError, ValueError) as exc:
            last_err = str(exc)
            continue
        if isinstance(parsed, dict):
            return parsed
    raise AgentError(f"could not parse EDL JSON from agent output ({last_err})")


def validate_edl(doc, duration, target_duration=None):
    """Validate + normalize an EDL doc. Returns the normalized doc.

    Sorts by start, clamps to duration, drops invalid/over-short
    segments, fixes overlaps, and enforces the target budget by score.
    Raises AgentError when nothing usable remains.
    """
    if not isinstance(doc, dict) or not isinstance(doc.get("segments"), list):
        raise AgentError("EDL must be an object with a 'segments' array")

    cleaned = []
    for seg in doc["segments"]:
        if not isinstance(seg, dict):
            continue
        try:
            start = float(seg.get("start"))
            end = float(seg.get("end"))
        except (TypeError, ValueError):
            continue
        try:
            score = float(seg.get("score", 0.5))
        except (TypeError, ValueError):
            score = 0.5
        reason = seg.get("reason") or ""
        if not all(math.isfinite(value) for value in (start, end, score)) or not (0 <= start < end):
            continue
        if start >= duration:
            continue
        end = min(end, duration)
        if end - start < MIN_SEGMENT_SECONDS:
            continue
        cleaned.append({
            "start": round(start, 3), "end": round(end, 3),
            "score": max(0.0, min(1.0, score)), "reason": str(reason)[:300],
        })

    cleaned.sort(key=lambda s: s["start"])
    fixed = []
    for seg in cleaned:
        if fixed and seg["start"] < fixed[-1]["end"]:
            seg["start"] = fixed[-1]["end"]
            if seg["end"] - seg["start"] < MIN_SEGMENT_SECONDS:
                continue
        fixed.append(seg)

    budget = target_duration if target_duration and target_duration > 0 else 30.0
    total = sum(s["end"] - s["start"] for s in fixed)
    if total > budget:
        by_score = sorted(fixed, key=lambda s: s["score"], reverse=True)
        kept = []
        kept_total = 0.0
        for seg in by_score:
            length = seg["end"] - seg["start"]
            if kept_total + length <= budget:
                kept.append(seg)
                kept_total += length
        fixed = sorted(kept, key=lambda s: s["start"])
        total = sum(s["end"] - s["start"] for s in fixed)

    if not fixed:
        raise AgentError(f"EDL contained no usable segments within the {budget:g}s target. "
                         "Select a shorter complete moment; do not return the full recording.")

    return {
        "segments": fixed,
        "source": doc.get("source") or "agent",
        "total_selected": round(total, 3),
    }


def _invoke_agent(agent_id, prompt, model=None, timeout=300):
    """Probe, spawn, and parse one agent call. Returns the raw EDL dict."""
    agent_id = (agent_id or "").strip().lower()
    spec = AGENTS.get(agent_id)
    if spec is None:
        raise AgentError(f"unknown agent '{agent_id}'")

    probe = probe_agent(agent_id)
    if not probe["available"]:
        raise AgentError(f"agent '{agent_id}' unavailable: {probe['note']}")

    schema_file = None
    tmpdir = tempfile.mkdtemp(prefix="agent_edl_")
    try:
        if spec["needs_schema_file"]:
            schema_file = os.path.join(tmpdir, "edl_schema.json")
            with open(schema_file, "w", encoding="utf-8") as fh:
                json.dump(EDL_SCHEMA, fh)
        argv = spec["argv"](probe["path"], prompt, model, schema_file)
        try:
            proc = subprocess.run(
                argv, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
                cwd=tmpdir, env=private_agent_env(),
            )
        except subprocess.TimeoutExpired:
            raise AgentError(f"agent '{agent_id}' timed out after {timeout}s")
        if proc.returncode != 0:
            detail = (proc.stderr or "").strip()[-500:]
            if not detail:
                # Some CLIs report the failure as a stdout envelope.
                detail = (
                    _envelope_error(proc.stdout or "")
                    or (proc.stdout or "").strip()[-500:]
                    or "no output"
                )
            raise AgentError(
                f"agent '{agent_id}' exited {proc.returncode}: {detail}"
            )
        doc = extract_json(proc.stdout or "", agent_id)
        doc["source"] = f"agent:{agent_id}"
        return doc
    finally:
        if schema_file and os.path.isfile(schema_file):
            os.remove(schema_file)
        if tmpdir:
            try:
                os.rmdir(tmpdir)
            except OSError:
                pass


def run_agent_cut(agent_id, takes_text, duration, target_duration=None,
                  context=None, hook=None, model=None, timeout=300, reference_prompt=None):
    """Run the full agent cut. Returns the validated EDL dict."""
    try:
        # Automatic modes add their own guidance to hook. Validate the user's
        # 4,000-character allowance and resolve links from their text only.
        references = reference_mod.resolve_references(hook if reference_prompt is None else reference_prompt)
    except (reference_mod.ReferenceError, ValueError) as exc:
        raise AgentError(str(exc)) from exc
    prompt = build_prompt(takes_text, duration, target_duration, context, hook, references)
    for attempt in range(2):
        doc = _invoke_agent(agent_id, prompt, model, timeout)
        try:
            edl = validate_edl(doc, duration, target_duration)
            break
        except AgentError as exc:
            if attempt:
                raise
            prompt += f"\nYour previous edit was rejected: {exc}\nReturn a corrected EDL JSON."
    if hook and hook.strip():
        edl["edit_request"] = {"prompt": hook.strip(), "references": references}
    return edl


def build_multiclip_prompt(takes_text, duration, min_length, max_length,
                           max_clips, min_gap, context=None, hook=None, references=None):
    """Build the multi-clip planning prompt: up to ``max_clips``
    independent windows, each ``min_length``–``max_length`` seconds."""
    lines = [
        "You are a viral-shorts editor. Find the BEST moments across this",
        "whole video and return each as its own clip for vertical shorts.",
        f"SOURCE DURATION: {duration:.1f} seconds.",
        f"TARGET: up to {max_clips} clips, EACH {min_length:.0f}-{max_length:.0f} seconds long.",
    ]
    if context and context.strip():
        lines.append(f"CHANNEL CONTEXT: {context.strip()}")
    if hook and hook.strip():
        lines.append(f"CUSTOM EDIT PROMPT: {hook.strip()}")
    if references:
        lines.append(reference_mod.reference_context(references))
    lines += [
        "RULES:",
        "- Output ONLY a JSON object, no markdown fences, no commentary.",
        '- Shape: {"segments": [{"start": s, "end": e, "score": 0-1, "reason": "..."}]}',
        "- start/end are seconds (floats), start < end, within 0 and the source duration.",
        "- Each segment is ONE self-contained moment: strong hook first, clean sentence close.",
        f"- Segments must not overlap and should be at least {min_gap:.0f}s apart.",
        "- Spread picks across the whole video; skip intros, filler, and dead air.",
        "- Prefer fewer great clips over filling the quota with weak ones.",
        "- Apply the custom prompt using source footage only; references guide spoken hooks and pacing.",
        "- Score honestly: 0.9+ only for genuinely viral moments.",
        "TAKES:",
    ]
    header = "\n".join(lines) + "\n"
    budget = MAX_PROMPT_CHARS - len(header) - 200
    takes = takes_text or ""
    if len(takes) > budget:
        takes = takes[:budget] + "\n[... transcript truncated for prompt budget ...]"
    return header + takes


def validate_multiclip(doc, duration, min_length, max_length,
                       max_clips=12, min_gap=30.0):
    """Validate an agent multi-clip doc. Returns the normalized doc.

    Same cleaning as :func:`validate_edl` (sort, clamp, drop invalid,
    fix overlaps) but each clip must fit the ``min_length``–``max_length``
    window and clips stay ``min_gap`` apart — the count follows quality,
    capped at ``max_clips``. Raises AgentError when nothing usable remains.
    """
    if not isinstance(doc, dict) or not isinstance(doc.get("segments"), list):
        raise AgentError("EDL must be an object with a 'segments' array")

    cleaned = []
    for seg in doc["segments"]:
        if not isinstance(seg, dict):
            continue
        try:
            start = float(seg.get("start"))
            end = float(seg.get("end"))
        except (TypeError, ValueError):
            continue
        try:
            score = float(seg.get("score", 0.5))
        except (TypeError, ValueError):
            score = 0.5
        reason = seg.get("reason") or ""
        if not (0 <= start < end):
            continue
        if start >= duration:
            continue
        end = min(end, duration)
        length = end - start
        if length < MIN_SEGMENT_SECONDS:
            continue
        if length < min_length or length > max_length:
            continue
        cleaned.append({
            "start": round(start, 3), "end": round(end, 3),
            "score": max(0.0, min(1.0, score)), "reason": str(reason)[:300],
        })

    cleaned.sort(key=lambda s: s["start"])
    fixed = []
    for seg in cleaned:
        if fixed and seg["start"] < fixed[-1]["end"]:
            # Keep the higher-scored of two overlapping agent picks.
            if seg["score"] > fixed[-1]["score"]:
                fixed[-1] = seg
            continue
        fixed.append(seg)

    by_score = sorted(fixed, key=lambda s: s["score"], reverse=True)
    kept = []
    for seg in by_score:
        if len(kept) >= max_clips:
            break
        clash = False
        for other in kept:
            overlap = max(seg["start"], other["start"]) < min(seg["end"], other["end"])
            gap = max(seg["start"], other["start"]) - min(seg["end"], other["end"])
            if overlap or gap < min_gap:
                clash = True
                break
        if not clash:
            kept.append(seg)
    fixed = sorted(kept, key=lambda s: s["start"])

    if not fixed:
        raise AgentError("agent returned no usable clips after validation")

    total = sum(s["end"] - s["start"] for s in fixed)
    return {
        "segments": fixed,
        "source": doc.get("source") or "agent",
        "total_selected": round(total, 3),
    }


def run_agent_multiclip(agent_id, takes_text, duration,
                        min_length=20.0, max_length=45.0,
                        max_clips=12, min_gap=30.0,
                        context=None, hook=None, model=None, timeout=600):
    """Plan up to ``max_clips`` clips with an agent. Returns validated EDL."""
    try:
        references = reference_mod.resolve_references(hook)
    except (reference_mod.ReferenceError, ValueError) as exc:
        raise AgentError(str(exc)) from exc
    prompt = build_multiclip_prompt(
        takes_text, duration, min_length, max_length,
        max_clips, min_gap, context, hook, references,
    )
    doc = _invoke_agent(agent_id, prompt, model, timeout)
    clean_id = (agent_id or "").strip().lower()
    return validate_multiclip(
        doc, duration, min_length, max_length, max_clips, min_gap,
    )


def main(argv=None):
    parser = argparse.ArgumentParser(description="Agent-driven EDL cut selection.")
    parser.add_argument("--agent", required=True, help="Agent id (claude|codex|agy|grok).")
    parser.add_argument("--probe", action="store_true", help="Only probe availability as JSON.")
    parser.add_argument("--takes", default=None, help="takes_packed.md path.")
    parser.add_argument("--takes-text", default=None, help="Inline takes text (alternative to --takes).")
    parser.add_argument("--duration", type=float, default=0.0)
    parser.add_argument("--target", type=float, default=30.0)
    parser.add_argument("--context", default=None)
    parser.add_argument("--hook", default=None)
    parser.add_argument("--model", default=None)
    parser.add_argument("--timeout", type=int, default=300)
    parser.add_argument("--output", default=None, help="Destination edl.json.")
    args = parser.parse_args(argv)

    if args.probe:
        print(json.dumps(probe_agent(args.agent)))
        return 0

    if args.takes and os.path.isfile(args.takes):
        with open(args.takes, "r", encoding="utf-8") as fh:
            takes_text = fh.read()
    elif args.takes_text:
        takes_text = args.takes_text
    else:
        print("agent_edit.py: need --takes file or --takes-text", file=sys.stderr)
        return 2

    if args.duration <= 0:
        print("agent_edit.py: need --duration > 0", file=sys.stderr)
        return 2

    try:
        edl = run_agent_cut(
            args.agent, takes_text, args.duration,
            target_duration=args.target, context=args.context,
            hook=args.hook, model=args.model, timeout=args.timeout,
        )
    except AgentError as exc:
        print(f"agent_edit.py: {exc}", file=sys.stderr)
        return 1

    payload = json.dumps(edl, indent=2)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as fh:
            fh.write(payload)
        print(f"agent_edit.py: wrote {len(edl['segments'])} segments -> {args.output}")
    else:
        print(payload)
    return 0


if __name__ == "__main__":
    sys.exit(main())
