"""Studio editing modes with optional agent instructions and references."""
import math

try:
    from . import transcript_edit, agent_edit
except ImportError:
    import transcript_edit
    import agent_edit


def needs_transcript(strategy, *, captions=False, remove_silence=True,
                     remove_retakes=True, prompt=None):
    return (captions or strategy == "highlights" or bool((prompt or "").strip())
            or (strategy == "cleanup" and (remove_silence or remove_retakes)))


def select_edit(strategy, words, duration, *, has_audio=True, captions=False,
                remove_silence=True, remove_retakes=True, agent=None,
                target=None, takes_text="", context=None, model=None, prompt=None):
    if not math.isfinite(duration) or duration <= 0:
        raise transcript_edit.EditError("Could not measure the source video duration")
    if strategy not in ("cleanup", "highlights", "full"):
        raise transcript_edit.EditError("Choose a supported editing mode")
    custom_prompt = (prompt or "").strip()
    uses_agent = strategy == "highlights" or bool(custom_prompt)
    if uses_agent and agent in (None, "", "auto", "none", "off"):
        raise transcript_edit.EditError("Choose an available editing model for AI highlights or custom instructions")
    needs_words = needs_transcript(strategy, captions=captions, remove_silence=remove_silence,
                                  remove_retakes=remove_retakes, prompt=prompt)
    if has_audio and needs_words and not words:
        raise transcript_edit.EditError("Speech detection failed. Check the local transcription engine or ElevenLabs key in Settings, then retry. No unedited export was created.")
    if not has_audio and uses_agent:
        raise transcript_edit.EditError("AI highlights and custom instructions need spoken audio in the source video")
    segments, removals = [{"start": 0., "end": duration}], []
    if words and strategy != "full" and (remove_silence or remove_retakes):
        segments, removals = transcript_edit.cleanup_plan(words, duration, remove_silence, remove_retakes)
    edit = None
    if uses_agent:
        if strategy == "highlights" and (target is None or not math.isfinite(target) or target <= 0):
            raise transcript_edit.EditError("Choose a positive highlight duration")
        if strategy == "highlights":
            guidance = ("Create a coherent professional short from this recording. Choose a strong opening, "
                        "preserve the explanation and payoff, and use complete sentences. "
                        "Do not return the first N seconds just to meet the budget.")
        elif strategy == "cleanup":
            guidance = ("Clean up this recording while preserving its complete story and explanation. "
                        "There is no short-form time limit. Keep all meaningful content unless the user's "
                        "instructions specifically ask to remove or focus on something.")
        else:
            guidance = ("Keep the full recording. Only remove or reorder footage if the user's "
                        "instructions explicitly request it. Do not shorten it to a highlight.")
        guidance += " Never cut through a spoken word."
        if remove_retakes and strategy != "full":
            guidance += " Prefer the later complete take when the speaker restarts."
        if custom_prompt:
            guidance += "\nUSER INSTRUCTIONS:\n" + custom_prompt
        edit = agent_edit.run_agent_cut(agent, takes_text, duration,
                                       target_duration=min(target, duration) if strategy == "highlights" else duration,
                                       context=context, hook=guidance, model=model,
                                       reference_prompt=custom_prompt)
        selected = transcript_edit.safe_agent_ranges(edit["segments"], words, duration)
        segments = [{"start": max(a["start"], b["start"]), "end": min(a["end"], b["end"])}
                    for a in selected for b in segments
                    if min(a["end"], b["end"]) - max(a["start"], b["start"]) > .03]
        if not segments:
            raise transcript_edit.EditError("The editing model selected no usable spoken footage. Retry with a longer target.")
        # Word protection can expand a valid EDL. Allow only a small boundary
        # tolerance, never an arbitrarily long/full-source 'highlight'.
        if strategy == "highlights" and sum(s["end"] - s["start"] for s in segments) > min(target, duration) + .25:
            raise transcript_edit.EditError("The word-safe highlight exceeds the selected duration. "
                                           "Retry or choose a longer target. No substitute export was created.")
    result = {"source": "video-use-automation", "strategy": strategy, "segments": segments,
            "removals": removals, "remove_silence": remove_silence,
            "remove_retakes": remove_retakes, "agent": agent if uses_agent else None, "model": model if uses_agent else None}
    if custom_prompt and edit:
        result["edit_request"] = {"prompt": custom_prompt,
                                  "references": edit.get("edit_request", {}).get("references", [])}
    return result
