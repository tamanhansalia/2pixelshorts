"""Committed tests for the video-use engine helpers.

Stdlib unittest only — run from the video-use directory:

    python3 -m unittest discover -s tests -v
"""

import json
import os
import subprocess
import sys
import unittest
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "helpers"))
# SEO autocomplete is a live network call; tests stay offline.
os.environ["PIXEL_DISABLE_SUGGEST"] = "1"

import agent_edit
import grade
import pack_transcripts
import render
import review
import seo
import short_pipeline
import stream_clip
import tempfile
import transcribe
import trending


class ExtractJsonTests(unittest.TestCase):
    def test_claude_envelope_result_field(self):
        stdout = json.dumps({"type": "result", "result": '{"segments": []}'})
        self.assertEqual(
            agent_edit.extract_json(stdout, "claude"), {"segments": []}
        )

    def test_error_envelope_raises_agent_message(self):
        stdout = json.dumps({
            "type": "result", "is_error": True,
            "result": "You've hit your weekly limit",
        })
        with self.assertRaises(agent_edit.AgentError) as ctx:
            agent_edit.extract_json(stdout, "claude")
        self.assertIn("weekly limit", str(ctx.exception))

    def test_success_envelope_not_mistaken_for_error(self):
        self.assertIsNone(agent_edit._envelope_error(
            json.dumps({"type": "result", "result": '{"segments": []}'})
        ))
        self.assertIsNone(agent_edit._envelope_error("plain text"))
        self.assertIsNone(agent_edit._envelope_error(
            json.dumps({"segments": [{"start": 0, "end": 1}]})
        ))

    def test_error_dict_message_extracted(self):
        self.assertEqual(
            agent_edit._envelope_error(json.dumps(
                {"type": "error", "error": {"message": "bad schema", "code": 400}}
            )),
            "bad schema",
        )

    def test_edl_schema_is_strict_mode_compatible(self):
        schema = agent_edit.EDL_SCHEMA
        self.assertFalse(schema["additionalProperties"])
        items = schema["properties"]["segments"]["items"]
        self.assertFalse(items["additionalProperties"])
        self.assertEqual(
            sorted(items["required"]),
            ["end", "reason", "score", "start"],
        )

    def test_grok_envelope_text_field(self):
        stdout = json.dumps(
            {"text": '{"segments": [{"start": 0, "end": 5}]}', "stopReason": "end_turn"}
        )
        self.assertEqual(
            agent_edit.extract_json(stdout, "grok"),
            {"segments": [{"start": 0, "end": 5}]},
        )

    def test_raw_json(self):
        self.assertEqual(
            agent_edit.extract_json('{"segments": []}', "codex"), {"segments": []}
        )

    def test_fenced_json(self):
        self.assertEqual(
            agent_edit.extract_json(
                '```json\n{"segments": []}\n```', "agy"
            ),
            {"segments": []},
        )

    def test_json_embedded_in_prose(self):
        self.assertEqual(
            agent_edit.extract_json(
                'Here is the cut: {"segments": [{"start": 1, "end": 2}]} done.',
                "codex",
            ),
            {"segments": [{"start": 1, "end": 2}]},
        )

    def test_garbage_raises(self):
        with self.assertRaises(agent_edit.AgentError):
            agent_edit.extract_json("no json here at all", "claude")
        with self.assertRaises(agent_edit.AgentError):
            agent_edit.extract_json("", "claude")


class ValidateEdlTests(unittest.TestCase):
    def test_happy_path_sorted_and_scored(self):
        edl = agent_edit.validate_edl(
            {"segments": [
                {"start": 10, "end": 20, "score": 0.9, "reason": "hook"},
                {"start": 0, "end": 5, "score": 0.7},
            ]},
            duration=60.0,
            target_duration=30.0,
        )
        self.assertEqual(len(edl["segments"]), 2)
        self.assertEqual(edl["segments"][0]["start"], 0)
        self.assertEqual(edl["total_selected"], 15.0)

    def test_clamps_to_duration_and_drops_invalid(self):
        edl = agent_edit.validate_edl(
            {"segments": [
                {"start": 50, "end": 999},
                {"start": 70, "end": 80},  # beyond duration
                {"start": 5, "end": 5},  # zero length
                {"start": -3, "end": 2},  # negative start
                "not-a-segment",
            ]},
            duration=60.0,
        )
        self.assertEqual(len(edl["segments"]), 1)
        self.assertEqual(edl["segments"][0]["end"], 60.0)

    def test_fixes_overlaps(self):
        edl = agent_edit.validate_edl(
            {"segments": [
                {"start": 0, "end": 10},
                {"start": 8, "end": 15},
            ]},
            duration=60.0,
        )
        self.assertEqual(edl["segments"][1]["start"], 10)

    def test_budget_keeps_best_scores(self):
        edl = agent_edit.validate_edl(
            {"segments": [
                {"start": 0, "end": 20, "score": 0.3},
                {"start": 30, "end": 40, "score": 0.9},
            ]},
            duration=60.0,
            target_duration=15.0,
        )
        self.assertEqual(len(edl["segments"]), 1)
        self.assertEqual(edl["segments"][0]["start"], 30)

    def test_empty_after_validation_raises(self):
        with self.assertRaises(agent_edit.AgentError):
            agent_edit.validate_edl({"segments": []}, duration=60.0)
        with self.assertRaises(agent_edit.AgentError):
            agent_edit.validate_edl({"nope": 1}, duration=60.0)


class PromptTests(unittest.TestCase):
    def test_prompt_carries_context_hook_and_rules(self):
        prompt = agent_edit.build_prompt(
            "1. [00:00.00-00:05.00] hello world",
            duration=120.0,
            target_duration=25.0,
            context="Rust channel",
            hook="open on the demo",
        )
        self.assertIn("Rust channel", prompt)
        self.assertIn("open on the demo", prompt)
        self.assertIn("120.0 seconds", prompt)
        self.assertIn("25 seconds", prompt)
        self.assertIn('"segments"', prompt)
        self.assertIn("hello world", prompt)

    def test_prompt_truncates_to_budget(self):
        prompt = agent_edit.build_prompt(
            "x" * (agent_edit.MAX_PROMPT_CHARS + 5000),
            duration=60.0,
            target_duration=30.0,
        )
        self.assertLessEqual(len(prompt), agent_edit.MAX_PROMPT_CHARS + 500)
        self.assertIn("truncated", prompt)


class ProbeTests(unittest.TestCase):
    def test_unknown_agent_never_available(self):
        probe = agent_edit.probe_agent("hal9000")
        self.assertFalse(probe["available"])
        self.assertIn("unknown agent", probe["note"])

    def test_gemini_cli_is_removed(self):
        # The Gemini CLI no longer exists: it must not be offered as an
        # agent, and probing it reports "unknown agent".
        self.assertNotIn("gemini", agent_edit.AGENTS)
        probe = agent_edit.probe_agent("gemini")
        self.assertFalse(probe["available"])
        self.assertIn("unknown agent", probe["note"])

    def test_all_known_agents_have_specs(self):
        for agent_id in ("claude", "codex", "agy", "grok"):
            self.assertIn(agent_id, agent_edit.AGENTS)
            spec = agent_edit.AGENTS[agent_id]
            self.assertTrue(spec["binaries"])
            self.assertTrue(spec["help_markers"])


class AgyArgvTests(unittest.TestCase):
    def test_prompt_attached_to_p_last(self):
        argv = agent_edit._agy_argv("agy", "PROMPT", None, None)
        # agy's `-p` consumes the next token as the prompt value: every
        # option flag must precede it or the cut fails with exit 2.
        self.assertEqual(argv[-2:], ["-p", "PROMPT"])
        self.assertLess(argv.index("--output-format"), argv.index("-p"))
        self.assertLess(argv.index("--json-schema"), argv.index("-p"))

    def test_model_flag_stays_before_prompt(self):
        argv = agent_edit._agy_argv("agy", "PROMPT", "my-model", None)
        self.assertLess(argv.index("--model"), argv.index("-p"))
        self.assertEqual(argv[argv.index("--model") + 1], "my-model")
        self.assertEqual(argv[-2:], ["-p", "PROMPT"])

    def test_structured_output_envelope_preferred(self):
        stdout = json.dumps({
            "status": "SUCCESS",
            "response": '{"segments": [], "toolAction": "Finishing task"}',
            "structured_output": {
                "segments": [
                    {"start": 0, "end": 5, "score": 0.9, "reason": "hook"}
                ]
            },
        })
        doc = agent_edit.extract_json(stdout, "agy")
        self.assertEqual(
            doc["segments"],
            [{"start": 0, "end": 5, "score": 0.9, "reason": "hook"}],
        )


class RetimeTests(unittest.TestCase):
    def test_words_map_to_output_timeline(self):
        words = [
            {"word": "a", "start": 11.0, "end": 11.5},
            {"word": "b", "start": 32.0, "end": 32.5},
            {"word": "zzz", "start": 90.0, "end": 90.5},  # outside: dropped
        ]
        segments = [
            {"start": 10.0, "end": 20.0},
            {"start": 30.0, "end": 40.0},
        ]
        out = render.retime_words_for_edl(words, segments)
        self.assertEqual([w["word"] for w in out], ["a", "b"])
        self.assertAlmostEqual(out[0]["start"], 1.0)
        # second segment starts at 10 - 0.03 (acrossfade overlap)
        self.assertAlmostEqual(out[1]["start"], 2.0 + 9.97, places=2)


class EdlFilterTests(unittest.TestCase):
    SEGMENTS = [
        {"start": 10.0, "end": 15.0},
        {"start": 30.0, "end": 36.0},
    ]

    def test_multi_segment_chain(self):
        filt, total = render.build_edl_filter(self.SEGMENTS, "warm_cinematic")
        self.assertIn("trim=start=10.000:end=15.000", filt)
        self.assertIn("concat=n=2:v=1:a=0", filt)
        self.assertIn("acrossfade=d=0.03", filt)
        self.assertIn("afade=t=in:st=0:d=0.03", filt)
        self.assertIn("eq=contrast=1.12", filt)
        self.assertAlmostEqual(total, 11.0 - 0.03, places=2)

    def test_single_segment_has_no_crossfade(self):
        filt, total = render.build_edl_filter(self.SEGMENTS[:1], "neutral_punch")
        self.assertNotIn("acrossfade", filt)
        self.assertIn("concat=n=1", filt)
        self.assertAlmostEqual(total, 5.0)

    def test_no_audio_maps_video_only(self):
        args = render.build_edl_ffmpeg_args(
            "in.mp4", "out.mp4", self.SEGMENTS, "warm_cinematic", has_audio=False
        )
        joined = " ".join(args)
        self.assertIn("-an", joined)
        self.assertNotIn("[a]", joined)

    def test_empty_segments_raise(self):
        with self.assertRaises(render.RenderError):
            render.build_edl_ffmpeg_args("in.mp4", "out.mp4", [], "warm_cinematic")


class SeoContractTests(unittest.TestCase):
    def test_metadata_matches_typescript_shape(self):
        words = [
            {"word": w, "start": i * 0.5, "end": i * 0.5 + 0.4}
            for i, w in enumerate(
                ("rust async pooling tokio deadpool ".split() * 6))
        ]
        seo = short_pipeline.generate_statistical_seo(
            "/tmp/rust_talk.mp4", words, 30.0, "rust and tauri",
            "faster-whisper:tiny.en",
        )
        for key in ("title", "title_alternatives", "description", "tags",
                    "hashtags", "search_queries", "pinned_comment",
                    "seo_score", "keywords_analyzed", "review_report"):
            self.assertIn(key, seo)
        for key in ("overall_summary", "hook_detected", "content_highlights",
                    "retention_score", "target_audience", "suggested_pacing",
                    "word_count"):
            self.assertIn(key, seo["review_report"])

    def test_templated_generator_is_gone(self):
        # The old filename-templated package (hardcoded seo_score 98) must
        # never come back: every package is grounded in a transcript.
        self.assertFalse(hasattr(short_pipeline, "generate_metadata"))


class ReviewTests(unittest.TestCase):
    def _words(self, n, span=30.0):
        return [
            {"word": f"w{i}", "start": i * span / n, "end": (i + 1) * span / n}
            for i in range(n)
        ]

    def test_report_shape_matches_typescript(self):
        report = review.build_report(
            30.0, self._words(60), [{"start": 0, "end": 15, "score": 0.9, "reason": "hook"},
                                    {"start": 20, "end": 35, "score": 0.8, "reason": "payoff"}],
            takes_count=8, context="Channel: X\nAudience: Makers",
        )
        for key in ("overall_summary", "hook_detected", "content_highlights",
                    "retention_score", "target_audience", "suggested_pacing",
                    "word_count", "takes_count", "segment_count",
                    "output_duration", "speech_wps"):
            self.assertIn(key, report)
        self.assertEqual(report["word_count"], 60)
        self.assertEqual(report["segment_count"], 2)
        self.assertEqual(report["output_duration"], 30.0)
        self.assertEqual(report["target_audience"], "Makers")
        self.assertIn("hook", report["content_highlights"][0])

    def test_dense_speech_scores_higher_than_silence(self):
        dense = review.build_report(30.0, self._words(75), [], 0)
        silent = review.build_report(30.0, [], [], 0)
        self.assertGreater(dense["retention_score"], silent["retention_score"])
        self.assertEqual(silent["word_count"], 0)
        self.assertEqual(silent["hook_detected"], "")

    def test_score_clamped_and_duration_fit(self):
        sweet = review.build_report(30.0, self._words(60), [], 0)
        tiny = review.build_report(3.0, self._words(6, span=3.0), [], 0)
        self.assertGreaterEqual(sweet["retention_score"], tiny["retention_score"])
        for report in (sweet, tiny):
            self.assertGreaterEqual(report["retention_score"], 40)
            self.assertLessEqual(report["retention_score"], 99)

    def test_words_filtered_to_segments(self):
        words = self._words(10, span=100.0)
        kept = review._words_in_output(
            words, [{"start": 0, "end": 25.0}], 25.0
        )
        self.assertTrue(0 < len(kept) < len(words))
        self.assertTrue(all(w["start"] < 25.0 for w in kept))


class TrendingTests(unittest.TestCase):
    VIDEOS = [
        {"title": "Rust Async Secrets Nobody Tells You",
         "description": "connection pooling deep dive", "channel": "c1"},
        {"title": "Rust Connection Pooling in 60 Seconds",
         "description": "async secrets revealed", "channel": "c2"},
    ]

    def test_extract_ranks_domain_terms(self):
        keywords = trending.extract_keywords(self.VIDEOS, top_n=10)
        terms = [k["term"] for k in keywords]
        self.assertIn("rust", terms)
        self.assertIn("connection pooling", terms)
        # Stopwords and filler never surface as terms.
        for stop in ("the", "in", "you", "60"):
            self.assertNotIn(stop, terms)
        rust = next(k for k in keywords if k["term"] == "rust")
        self.assertEqual(rust["sources"], 2)

    def test_tokenize_filters_noise(self):
        tokens = trending.tokenize("The 10 BEST-known AI Tricks!!")
        self.assertNotIn("the", tokens)
        self.assertNotIn("10", tokens)
        self.assertIn("tricks", tokens)

    def test_no_key_is_graceful(self):
        with tempfile.TemporaryDirectory() as cache_dir:
            doc = trending.get_trending("rust", api_key="", cache_dir=cache_dir)
        self.assertEqual(doc["keywords"], [])
        self.assertIn("note", doc)

    def test_velocity_weights_rising_videos(self):
        videos = [
            {"video_id": "a", "title": "tokio tricks", "description": "",
             "published_at": "2026-01-01T00:00:00Z"},
            {"video_id": "b", "title": "deadpool tricks", "description": "",
             "published_at": "2026-01-01T00:00:00Z"},
        ]
        now = datetime(2026, 1, 1, 10, tzinfo=timezone.utc)
        trending.apply_velocity(videos, {"a": 100000, "b": 10}, now=now)
        self.assertEqual(videos[0]["views_per_hour"], 10000.0)
        terms = {k["term"]: k["score"]
                 for k in trending.extract_keywords(videos)}
        self.assertGreater(terms["tokio"], terms["deadpool"])

    def test_suggestions_parse_and_fail_soft(self):
        original = trending._get_json
        try:
            os.environ["PIXEL_DISABLE_SUGGEST"] = "0"
            trending._get_json = lambda url, timeout: [
                "rust", ["Rust Tutorial", "rust  tutorial", "rust game"]]
            self.assertEqual(trending.fetch_suggestions("rust"),
                             ["rust tutorial", "rust game"])

            def boom(url, timeout):
                raise OSError("offline")
            trending._get_json = boom
            self.assertEqual(trending.fetch_suggestions("rust"), [])
            os.environ["PIXEL_DISABLE_SUGGEST"] = "1"
            self.assertEqual(trending.fetch_suggestions("rust"), [])
        finally:
            trending._get_json = original
            os.environ["PIXEL_DISABLE_SUGGEST"] = "1"

    def test_cache_round_trip_and_stale(self):
        with tempfile.TemporaryDirectory() as cache_dir:
            path = trending.cache_path(cache_dir, "rust dev!", region="US")
            self.assertIn("rust_dev", os.path.basename(path))
            fresh = {"niche": "rust", "keywords": [{"term": "rust", "score": 3}],
                     "videos": [],
                     "fetched_at": datetime.now(timezone.utc).isoformat()}
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(fresh, fh)
            # Fresh cache wins without any API key.
            doc = trending.get_trending("rust dev!", cache_dir=cache_dir, region="US")
            self.assertTrue(doc.get("cached"))
            self.assertEqual(doc["keywords"], fresh["keywords"])
            # Stale cache is ignored.
            old = dict(fresh)
            old["fetched_at"] = "2020-01-01T00:00:00+00:00"
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(old, fh)
            self.assertIsNone(trending.load_cache(path))


class GradePackTests(unittest.TestCase):
    def test_unknown_preset_falls_back(self):
        self.assertEqual(
            grade.get_filter("no_such_preset"), grade.get_filter("vertical_clean")
        )

    def test_pack_groups_and_renders(self):
        words = [
            {"word": w, "start": i * 0.5, "end": i * 0.5 + 0.4}
            for i, w in enumerate("one two three four".split())
        ]
        takes = pack_transcripts.pack_words(words, max_words=2)
        self.assertEqual(len(takes), 2)
        md = pack_transcripts.render_markdown(takes, "demo.mp4")
        self.assertIn("| 1 | 00:00.00", md)

    def test_pack_splits_on_silence_gaps(self):
        words = [
            {"word": "one", "start": 0.0, "end": 0.4},
            {"word": "two", "start": 0.5, "end": 0.9},
            {"word": "three", "start": 10.0, "end": 10.4},
        ]
        takes = pack_transcripts.pack_words(words, max_words=10)
        self.assertEqual(len(takes), 2)
        self.assertEqual(takes[1]["text"], "three")


class SubtitleStyleTests(unittest.TestCase):
    # The preview/render caption contract (see render.py header): standard
    # text burns at FontSize 50 on the 1080x1920 canvas with PlayRes-pinned
    # margins, and the fluid-width monitor previews it proportionally via
    # container-query units (4.63cqw) at any width. The style itself
    # carries the inactive (plain-word) color; the active highlight lives
    # on per-word ASS events (words_to_ass tests below).

    def test_pop_theme_standard_size_matches_preview_scale(self):
        style = render.subtitle_force_style("pop", "bottom", "standard")
        self.assertIn("PrimaryColour=&H00FFFFFF", style)
        self.assertIn("Bold=-1", style)
        self.assertIn("FontSize=50", style)

    def test_boxed_theme_opaque_backing(self):
        style = render.subtitle_force_style("boxed", "bottom", "standard")
        self.assertIn("BorderStyle=3", style)
        self.assertIn("BackColour=&H001B1818", style)

    def test_editorial_serif_italic(self):
        style = render.subtitle_force_style("editorial", "bottom", "standard")
        self.assertIn("FontName=Georgia", style)
        self.assertIn("Italic=-1", style)

    def test_punch_burns_massive_single_word(self):
        style = render.subtitle_force_style("punch", "bottom", "standard")
        self.assertIn("FontSize=104", style)

    def test_position_alignment_and_margins(self):
        top = render.subtitle_force_style("pop", "top", "standard")
        self.assertIn("Alignment=8", top)
        self.assertIn("MarginV=140", top)
        center = render.subtitle_force_style("pop", "center", "standard")
        self.assertIn("Alignment=5", center)
        self.assertIn("MarginV=0", center)
        bottom = render.subtitle_force_style("pop", "bottom", "standard")
        self.assertIn("Alignment=2", bottom)
        self.assertIn("MarginV=200", bottom)

    def test_size_scaling(self):
        # pop base is 50: compact -> 42, standard -> 50, large -> 60.
        self.assertIn("FontSize=42", render.subtitle_force_style("pop", "bottom", "compact"))
        self.assertIn("FontSize=50", render.subtitle_force_style("pop", "bottom", "standard"))
        self.assertIn("FontSize=60", render.subtitle_force_style("pop", "bottom", "large"))

    def test_unknown_values_fall_back_to_default(self):
        style = render.subtitle_force_style("nope", "sideways", "huge")
        self.assertIn("PrimaryColour=&H00FFFFFF", style)
        self.assertIn("FontSize=50", style)
        self.assertIn("Alignment=2", style)

    def test_cue_size_punch_single_word(self):
        self.assertEqual(render.cue_size_for_style("punch"), 1)
        self.assertEqual(render.cue_size_for_style("pop"), 2)
        self.assertEqual(render.cue_size_for_style(None), 2)

    def test_ass_color_uses_bgr_order(self):
        # Regression guard: hand-written &HAABBGGRR literals were
        # byte-swapped for several themes (cyan rendered yellow, ...).
        self.assertEqual(render._ass_color("#FFE500"), "&H0000E5FF")
        self.assertEqual(render._ass_color("#7C3AED"), "&H00ED3A7C")
        self.assertEqual(render._ass_color("#00F5FF"), "&H00FFF500")
        self.assertEqual(render._ass_color("#FACC15"), "&H0015CCFA")
        self.assertEqual(render._ass_color("#22C55E"), "&H005EC522")

    def test_active_tags_match_theme_hex(self):
        for theme_id, theme in render._SUBTITLE_THEMES.items():
            if theme["active"] != theme["inactive"]:
                self.assertIn(
                    render._ass_color(theme["active"]),
                    theme["active_tags"], theme_id,
                )

    def test_ass_pins_playres_and_style(self):
        words = [
            {"word": "THIS", "start": 0.0, "end": 0.5},
            {"word": "NEW", "start": 0.5, "end": 1.0},
        ]
        doc = render.words_to_ass(
            words, case="uppercase", style_id="pop",
            position="bottom", size="standard",
        )
        self.assertIn("PlayResX: 1080", doc)
        self.assertIn("PlayResY: 1920", doc)
        self.assertIn("Style: Caption,Arial,50,", doc)
        self.assertIn(",2,40,40,200,1", doc)  # bottom alignment + margins

    def test_ass_highlights_only_the_spoken_word(self):
        words = [
            {"word": "THIS", "start": 0.0, "end": 0.5},
            {"word": "NEW", "start": 0.5, "end": 1.0},
        ]
        doc = render.words_to_ass(
            words, case="uppercase", style_id="pop",
            position="bottom", size="standard",
        )
        events = [ln for ln in doc.splitlines() if ln.startswith("Dialogue:")]
        self.assertEqual(len(events), 2)
        # First word spoken: active tags on THIS, reset before NEW so the
        # highlight cannot leak onto the following word.
        self.assertTrue(
            events[0].endswith(r"{\1c&H0000E5FF&}THIS{\r} NEW"),
            events[0],
        )
        self.assertTrue(
            events[1].endswith("THIS " + r"{\1c&H0000E5FF&}NEW{\r}"),
            events[1],
        )
        self.assertIn("0:00:00.00,0:00:00.50", events[0])
        # Continuous timing: the cue's last word holds briefly instead of
        # blinking out the instant it ends.
        self.assertIn("0:00:00.50,0:00:01.50", events[1])

    def test_ass_cues_play_without_gaps(self):
        # Inter-word pauses used to blank the line (visible blinking).
        words = [
            {"word": "THIS", "start": 0.0, "end": 0.4},
            {"word": "NEW", "start": 0.6, "end": 1.0},
        ]
        doc = render.words_to_ass(words, style_id="pop")
        events = [ln for ln in doc.splitlines() if ln.startswith("Dialogue:")]
        self.assertEqual(len(events), 2)
        # First event holds until the next word begins; the last word's
        # trailing hold keeps the line up instead of blinking out.
        self.assertIn("0:00:00.00,0:00:00.60", events[0])
        self.assertIn("0:00:00.60,0:00:01.50", events[1])

    def test_ass_cues_never_overlap(self):
        words = [
            {"word": "A", "start": 0.0, "end": 0.4},
            {"word": "B", "start": 0.6, "end": 2.0},
            {"word": "C", "start": 2.1, "end": 2.5},
            {"word": "D", "start": 2.6, "end": 3.0},
        ]
        doc = render.words_to_ass(words, style_id="pop")
        events = [ln for ln in doc.splitlines() if ln.startswith("Dialogue:")]
        self.assertEqual(len(events), 4)
        # Cue 1's last word hold is clipped at cue 2's start.
        self.assertIn("0:00:00.60,0:00:02.10", events[1])
        self.assertIn("0:00:02.10,0:00:02.60", events[2])
        self.assertIn("0:00:02.60,0:00:03.50", events[3])

    def test_ass_punch_emits_single_word_cues(self):
        words = [
            {"word": "THIS", "start": 0.0, "end": 0.5},
            {"word": "NEW", "start": 0.5, "end": 1.0},
        ]
        doc = render.words_to_ass(words, style_id="punch")
        events = [ln for ln in doc.splitlines() if ln.startswith("Dialogue:")]
        self.assertEqual(len(events), 2)
        self.assertTrue(events[0].endswith(",THIS"), events[0])
        self.assertTrue(events[1].endswith(",NEW"), events[1])
        self.assertIn("Style: Caption,Arial,104,", doc)

    def test_ass_escapes_braces(self):
        words = [{"word": "a{b", "start": 0.0, "end": 1.0}]
        doc = render.words_to_ass(words, style_id="pop")
        self.assertIn(r"A\{B", doc)
        self.assertNotIn("a{b", doc.replace(r"\{", ""))

    def test_head_cut_builder_ass_needs_no_force_style(self):
        args = render.build_ffmpeg_args(
            "in.mp4", "out.mp4", "vertical_clean", srt_path="c.ass",
            subtitle_style="hype", subtitle_position="top",
            subtitle_size="large",
        )
        vf = args[args.index("-vf") + 1]
        self.assertIn("subtitles=c.ass", vf)
        self.assertNotIn("force_style", vf)
        self.assertIn("format=gbrp", vf)
        self.assertLess(vf.index("format=gbrp"), vf.index("subtitles="))
        self.assertLess(vf.index("subtitles="), vf.index("format=yuv420p"))

    def test_head_cut_builder_legacy_srt_keeps_force_style(self):
        args = render.build_ffmpeg_args(
            "in.mp4", "out.mp4", "vertical_clean", srt_path="c.srt",
            subtitle_style="hype", subtitle_position="top",
            subtitle_size="large",
        )
        vf = args[args.index("-vf") + 1]
        self.assertIn("PrimaryColour=&H00FFFFFF", vf)
        self.assertIn("Alignment=8", vf)
        self.assertIn("MarginV=140", vf)

    def test_edl_filter_threads_style(self):
        filt, _total = render.build_edl_filter(
            [{"start": 0.0, "end": 2.0}], "vertical_clean",
            srt_path="c.ass", subtitle_style="glow",
            subtitle_position="center", subtitle_size="standard",
        )
        self.assertIn("subtitles=c.ass", filt)
        self.assertNotIn("force_style", filt)
        self.assertIn("format=gbrp", filt)

    def test_captions_stay_fully_opaque_without_size_jump(self):
        # Spoken-word highlight is color-only: a selected caption must not
        # fade in (inactive_alpha / &H80 shadow) or change size (\fscx).
        for theme_id, theme in render._SUBTITLE_THEMES.items():
            self.assertNotIn("inactive_alpha", theme, theme_id)
            tags = theme.get("active_tags") or ""
            self.assertNotIn(r"\fscx", tags, theme_id)
            self.assertNotIn(r"\fscy", tags, theme_id)
            style = render.subtitle_ass_style_line(theme_id, "bottom", "standard")
            self.assertNotIn("&H80", style, theme_id)
            self.assertNotIn("&H66", style, theme_id)
            primary = style.split(",")[3]
            self.assertTrue(primary.startswith("&H00"), theme_id)

    def test_glow_inactive_words_are_opaque(self):
        style = render.subtitle_force_style("glow", "bottom", "standard")
        self.assertIn("PrimaryColour=&H00FFFFFF", style)
        ass = render.subtitle_ass_style_line("glow", "bottom", "standard")
        self.assertIn("&H00FFFFFF", ass)

    def test_burned_captions_are_opaque_on_bright_backgrounds(self):
        # Regression: libass over yuv420p washed white glyphs to ~50% gray,
        # which looked like a transparent fade-in. RGB compositing must keep
        # the fill near 255. Dark field so white/yellow fills are measurable.
        with tempfile.TemporaryDirectory(prefix="caption_opaque_") as directory:
            source = os.path.join(directory, "field.mp4")
            output = os.path.join(directory, "burned.mp4")
            ass_path = os.path.join(directory, "captions.ass")
            subprocess.run([
                "ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
                "color=0x123456:s=1080x1920:d=1:r=25",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", source,
            ], check=True)
            with open(ass_path, "w", encoding="utf-8") as handle:
                handle.write(render.words_to_ass(
                    [
                        {"word": "OPAQUE", "start": 0.0, "end": 1.0},
                        {"word": "TEXT", "start": 0.0, "end": 1.0},
                    ],
                    case="uppercase", style_id="pop",
                    position="bottom", size="standard",
                ))
            args = render.build_ffmpeg_args(
                source, output, "vertical_clean", cut_duration=1.0,
                srt_path=ass_path, subtitle_style="pop",
                subtitle_position="bottom", subtitle_size="standard",
                has_audio=False,
            )
            subprocess.run(["ffmpeg", "-v", "error", *args], check=True)
            raw = subprocess.check_output([
                "ffmpeg", "-v", "error", "-ss", "0.2", "-i", output,
                "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
            ])
            width, height = 1080, 1920

            def pixel(x, y):
                index = (y * width + x) * 3
                return raw[index], raw[index + 1], raw[index + 2]

            # Caption sits above MarginV=200 with FontSize 50.
            whitest = 0
            black_outline = 0
            for y in range(1600, 1850):
                for x in range(100, 980):
                    red, green, blue = pixel(x, y)
                    whitest = max(whitest, min(red, green, blue))
                    if red < 40 and green < 40 and blue < 40:
                        black_outline += 1
            self.assertGreater(whitest, 240, "caption fill must stay fully opaque")
            self.assertGreater(black_outline, 20, "caption outline must stay solid black")


class TranscribeEngineTests(unittest.TestCase):
    def setUp(self):
        # Force "faster-whisper not installed" hermetically, even when the
        # suite itself runs under the project venv that has it.
        self._saved = sys.modules.get("faster_whisper", "absent")
        sys.modules["faster_whisper"] = None

    def tearDown(self):
        if self._saved == "absent":
            sys.modules.pop("faster_whisper", None)
        else:
            sys.modules["faster_whisper"] = self._saved

    def _run_main(self, args):
        import io as _io
        from contextlib import redirect_stderr
        err = _io.StringIO()
        with redirect_stderr(err):
            rc = transcribe.main(args)
        return rc, err.getvalue()

    def test_auto_without_key_or_lib_writes_placeholder(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "in.mp4")
            out = os.path.join(tmp, "words.json")
            open(src, "wb").write(b"fake")
            rc, err = self._run_main(
                ["--input", src, "--output", out, "--engine", "auto"]
            )
            self.assertEqual(rc, 0)
            self.assertIn("no API key", err)
            with open(out, encoding="utf-8") as fh:
                doc = json.load(fh)
            self.assertEqual(doc["words"], [])
            self.assertEqual(doc["model"], "none")

    def test_explicit_local_without_lib_points_at_setup(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "in.mp4")
            out = os.path.join(tmp, "words.json")
            open(src, "wb").write(b"fake")
            rc, _err = self._run_main(
                ["--input", src, "--output", out, "--engine", "local"]
            )
            self.assertEqual(rc, 1)
            with open(out, encoding="utf-8") as fh:
                doc = json.load(fh)
            self.assertEqual(doc["words"], [])
            self.assertIn("setup_local_stt", doc["note"])

    def test_explicit_elevenlabs_without_key_fails_with_diagnostic(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "in.mp4")
            out = os.path.join(tmp, "words.json")
            open(src, "wb").write(b"fake")
            rc, err = self._run_main(
                ["--input", src, "--output", out, "--engine", "elevenlabs"]
            )
            self.assertEqual(rc, 1)
            self.assertIn("no API key", err)

    def test_local_decode_pins_temperature_for_determinism(self):
        import types as _types
        calls = {}

        class FakeModel:
            def __init__(self, model_id, device=None, compute_type=None, local_files_only=False):
                calls["model"] = model_id
                calls["offline"] = local_files_only

            def transcribe(self, path, **kwargs):
                calls["kwargs"] = kwargs
                return [], _types.SimpleNamespace(language="en")

        fake_mod = _types.ModuleType("faster_whisper")
        fake_mod.WhisperModel = FakeModel
        saved_mod = sys.modules.get("faster_whisper", "absent")
        saved_run = transcribe.subprocess.run
        sys.modules["faster_whisper"] = fake_mod

        def fake_run(cmd, **kwargs):
            import wave
            with wave.open(cmd[-1], "wb") as fh:
                fh.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                fh.writeframes(b"\0\0" * 16000)
            return _types.SimpleNamespace(returncode=0, stderr="")

        transcribe.subprocess.run = fake_run
        try:
            with tempfile.TemporaryDirectory() as tmp:
                src = os.path.join(tmp, "in.mp4")
                open(src, "wb").write(b"fake")
                doc = transcribe.transcribe_local(src)
        finally:
            transcribe.subprocess.run = saved_run
            if saved_mod == "absent":
                sys.modules.pop("faster_whisper", None)
            else:
                sys.modules["faster_whisper"] = saved_mod
        self.assertEqual(calls["kwargs"].get("temperature"), 0.0)
        self.assertTrue(calls["offline"])
        self.assertTrue(calls["kwargs"].get("word_timestamps"))
        self.assertTrue(calls["kwargs"]["vad_filter"])
        self.assertFalse(calls["kwargs"]["condition_on_previous_text"])
        self.assertEqual(calls["kwargs"]["hallucination_silence_threshold"], 1.0)
        self.assertEqual(doc["model"], f"faster-whisper:{transcribe.FASTER_WHISPER_DEFAULT_MODEL}")

    def test_missing_input_is_usage_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            rc, _err = self._run_main(
                ["--input", os.path.join(tmp, "nope.mp4"),
                 "--output", os.path.join(tmp, "o.json")]
            )
            self.assertEqual(rc, 2)

    def test_words_from_faster_segments(self):
        class W:
            def __init__(self, word, start, end):
                self.word = word
                self.start = start
                self.end = end

        class S:
            def __init__(self, words):
                self.words = words

        segs = [S([W(" hello", 0.5, 0.9), W("  ", 0.9, 1.0), W("world", 1.0, 1.4)])]
        self.assertEqual(
            transcribe.words_from_faster_segments(segs),
            [
                {"word": "hello", "start": 0.5, "end": 0.9},
                {"word": "world", "start": 1.0, "end": 1.4},
            ],
        )
        self.assertEqual(transcribe.words_from_faster_segments([]), [])

    def test_local_words_reject_hallucinated_zero_or_out_of_range_timestamps(self):
        from types import SimpleNamespace as Item
        segment = Item(words=[Item(word="spoken", start=1.0, end=1.5),
                              Item(word="zero", start=2.0, end=2.0),
                              Item(word="after", start=5.0, end=6.0),
                              Item(word="invalid", start=float("nan"), end=3.0),
                              Item(word="last", start=3.5, end=4.1)])
        self.assertEqual(transcribe.words_from_faster_segments([segment], 4.0),
                         [{"word": "spoken", "start": 1.0, "end": 1.5},
                          {"word": "last", "start": 3.5, "end": 4.0}])

    def test_transcript_source_labels(self):
        self.assertEqual(review._transcript_source({"model": "scribe_v1"}), "scribe_v1")
        self.assertEqual(
            review._transcript_source({"model": "faster-whisper:tiny.en"}),
            "faster-whisper:tiny.en",
        )
        self.assertEqual(review._transcript_source({"model": "none"}), "none")
        self.assertEqual(review._transcript_source({}), "none")
        self.assertEqual(review._transcript_source(None), "none")


class TranscribeProbeTests(unittest.TestCase):
    def test_report_shape(self):
        report = transcribe.probe_report("")
        for key in ("elevenlabs_key_configured", "local_available",
                    "local_model", "ffmpeg_available", "active_engine"):
            self.assertIn(key, report)
        self.assertIn(report["active_engine"], ("elevenlabs", "local", "none"))

    def test_key_selects_elevenlabs(self):
        report = transcribe.probe_report("  secret-key  ")
        self.assertTrue(report["elevenlabs_key_configured"])
        self.assertEqual(report["active_engine"], "elevenlabs")

    def test_no_key_falls_back_to_local_or_none(self):
        report = transcribe.probe_report("")
        self.assertFalse(report["elevenlabs_key_configured"])
        if transcribe.local_available():
            import shutil
            if shutil.which("ffmpeg"):
                self.assertEqual(report["active_engine"], "local")
        else:
            self.assertEqual(report["active_engine"], "none")

    def test_probe_flag_needs_no_input_file(self):
        import io as _io
        from contextlib import redirect_stdout
        out = _io.StringIO()
        with redirect_stdout(out):
            rc = transcribe.main(["--probe"])
        self.assertEqual(rc, 0)
        doc = json.load(_io.StringIO(out.getvalue()))
        self.assertIn("active_engine", doc)


class AgentCutGatingTests(unittest.TestCase):
    def test_auto_none_off_disable_agent_cut(self):
        for agent in ("auto", "none", "off", "", None, "  AUTO  "):
            self.assertFalse(short_pipeline.wants_agent_cut(agent), agent)

    def test_named_agent_enables_agent_cut(self):
        for agent in ("claude", "codex", "agy", "grok"):
            self.assertTrue(short_pipeline.wants_agent_cut(agent), agent)


class GradePresetTests(unittest.TestCase):
    def test_moody_film_has_film_look(self):
        filt = grade.get_filter("moody_film")
        self.assertIn("colorbalance=", filt)
        self.assertNotEqual(filt, grade.get_filter("vertical_clean"))

    def test_subtle_is_unfiltered_vertical(self):
        self.assertEqual(
            grade.get_filter("subtle"), grade.get_filter("vertical_clean")
        )

    def test_all_ui_presets_resolve(self):
        for preset in ("warm_cinematic", "neutral_punch", "moody_film", "subtle"):
            self.assertIn("crop=1080:1920", grade.get_filter(preset))

    def test_aspect_canvases(self):
        self.assertIn("crop=1080:1080", grade.get_filter("warm_cinematic", "1:1"))
        self.assertIn("crop=1920:1080", grade.get_filter("warm_cinematic", "16:9"))
        self.assertIn("crop=1080:1920", grade.get_filter("warm_cinematic", "bogus"))
        args = render.build_ffmpeg_args(
            "in.mp4", "out.mp4", "warm_cinematic", aspect_ratio="1:1",
        )
        self.assertIn("crop=1080:1080", args[args.index("-vf") + 1])
        filt, _ = render.build_edl_filter(
            [{"start": 0.0, "end": 2.0}], "warm_cinematic",
            layout="screen-top",
            face_pixels={"x": 0, "y": 0, "w": 100, "h": 100},
            aspect_ratio="1:1",
        )
        self.assertIn("crop=1080:1080", filt)


class SeoPromptTests(unittest.TestCase):
    def test_prompt_carries_takes_context_and_shape(self):
        prompt = short_pipeline.build_seo_prompt(
            "1. [00:00.00-00:05.00] rust async pooling",
            duration=60.0,
            word_count=120,
            context="Rust channel",
        )
        self.assertIn("rust async pooling", prompt)
        self.assertIn("Rust channel", prompt)
        self.assertIn("60.0 seconds", prompt)
        self.assertIn("120", prompt)
        self.assertIn('"title_alternatives"', prompt)
        self.assertIn("actually spoken", prompt)

    def test_prompt_truncates_to_budget(self):
        prompt = short_pipeline.build_seo_prompt(
            "x" * (agent_edit.MAX_PROMPT_CHARS + 5000),
            duration=60.0,
            word_count=999,
        )
        self.assertLessEqual(len(prompt), agent_edit.MAX_PROMPT_CHARS + 500)
        self.assertIn("truncated", prompt)


class ValidateSeoTests(unittest.TestCase):
    def _doc(self, **over):
        doc = {
            "title": "  Rust Pooling Feels Like Cheating ⚡  ",
            "title_alternatives": ["A", "B", "C", "D", "E"],
            "description": "Deep dive.",
            "tags": ["rust", "async", "rust"],
            "hashtags": [],
            "hook_detected": "Stop doing this.",
            "content_highlights": ["h1", "h2", "h3", "h4", "h5"],
            "overall_summary": "Great short.",
        }
        doc.update(over)
        return doc

    def test_happy_path_normalizes(self):
        seo = short_pipeline.validate_seo(self._doc())
        self.assertEqual(seo["title"], "Rust Pooling Feels Like Cheating ⚡")
        self.assertEqual(len(seo["title_alternatives"]), 4)
        self.assertEqual(seo["tags"], ["rust", "async"])
        # Empty hashtags derive from tags.
        self.assertEqual(seo["hashtags"], ["#rust", "#async"])
        self.assertEqual(len(seo["content_highlights"]), 4)

    def test_seo_schema_is_strict_mode_compatible(self):
        schema = short_pipeline.SEO_SCHEMA
        self.assertFalse(schema["additionalProperties"])
        for key in ("title", "title_alternatives", "description", "tags",
                    "hashtags", "hook_detected", "content_highlights",
                    "overall_summary"):
            self.assertIn(key, schema["required"])

    def test_missing_pieces_raise(self):
        for key in ("title", "description", "hook_detected",
                    "overall_summary"):
            with self.assertRaises(short_pipeline.SeoError, msg=key):
                short_pipeline.validate_seo(self._doc(**{key: "  "}))
        with self.assertRaises(short_pipeline.SeoError):
            short_pipeline.validate_seo(self._doc(title_alternatives=[]))
        with self.assertRaises(short_pipeline.SeoError):
            short_pipeline.validate_seo(self._doc(tags=[]))
        with self.assertRaises(short_pipeline.SeoError):
            short_pipeline.validate_seo(self._doc(content_highlights=[]))
        with self.assertRaises(short_pipeline.SeoError):
            short_pipeline.validate_seo("not a dict")


class StatisticalSeoTests(unittest.TestCase):
    def _words(self):
        terms = ("rust async pooling tokio deadpool ".split() * 6)
        return [
            {"word": w, "start": i * 0.5, "end": i * 0.5 + 0.4}
            for i, w in enumerate(terms)
        ]

    def test_package_is_grounded_in_transcript(self):
        words = self._words()
        payload = short_pipeline.generate_statistical_seo(
            "demo.mp4", words, 30.0, "Rust channel", "faster-whisper:tiny.en",
        )
        for key in ("title", "title_alternatives", "description", "tags",
                    "hashtags", "seo_score", "keywords_analyzed",
                    "review_report"):
            self.assertIn(key, payload)
        report = payload["review_report"]
        # Measured numbers, never placeholders.
        self.assertEqual(report["word_count"], len(words))
        self.assertEqual(report["transcript_source"], "faster-whisper:tiny.en")
        self.assertEqual(payload["seo_score"], report["retention_score"])
        # Language comes from actually-spoken terms.
        self.assertIn("rust", payload["tags"])
        self.assertTrue(report["hook_detected"])
        # Spoken phrases are listed, but they are not search demand.
        self.assertEqual(payload["demand_queries"], [])
        got = {c["id"]: c["got"] for c in payload["quality_checks"]}
        self.assertEqual(got["title_query_match"], 0)
        self.assertEqual(got["description_above_fold"], 0)
        self.assertGreaterEqual(len(payload["title_alternatives"]), 1)
        self.assertLessEqual(len(payload["title_alternatives"]), 4)
        # Titles are composed from spoken topic words as complete lines.
        vocab = {w["word"].lower() for w in words}
        for title in [payload["title"]] + payload["title_alternatives"]:
            self.assertLessEqual(len(title), 100)
            self.assertFalse(title.endswith((",", ";", ":")))
            self.assertGreaterEqual(len(title.split()), 2, title)
            for token in title.lower().split():
                token = token.strip(":.,!?\"'").rstrip("...")
                if token:
                    self.assertIn(token, vocab, title)
        self.assertTrue(payload["pinned_comment"])
        # No generic evergreen filler.
        for filler in ("tech", "coding", "developer", "viral",
                       "productivity", "trending"):
            self.assertNotIn(filler, payload["tags"])

    def test_thin_transcript_refuses_instead_of_templating(self):
        thin = [
            {"word": w, "start": i * 0.5, "end": i * 0.5 + 0.4}
            for i, w in enumerate("yes no maybe whatever okay".split())
        ]
        with self.assertRaises(short_pipeline.SeoError):
            short_pipeline.generate_statistical_seo(
                "demo.mp4", thin, 5.0, "", "none",
            )
        with self.assertRaises(short_pipeline.SeoError):
            short_pipeline.generate_statistical_seo(
                "demo.mp4", [], 5.0, "", "none",
            )

    def test_few_distinct_terms_refuses(self):
        words = [
            {"word": w, "start": i * 0.5, "end": i * 0.5 + 0.4}
            for i, w in enumerate(("hello " * 20).split())
        ]
        with self.assertRaises(short_pipeline.SeoError):
            short_pipeline.generate_statistical_seo(
                "demo.mp4", words, 10.0, "", "none",
            )

    def test_composed_title_is_a_complete_query_line(self):
        spoken = (
            "stop wasting hours on rust connection pooling. "
            "tokio's default pool leaks under load and nobody tells you. "
            "here is the deadpool setup I use in production."
        ).split()
        words = [
            {"word": w, "start": i * 0.4, "end": i * 0.4 + 0.35}
            for i, w in enumerate(spoken)
        ]
        payload = short_pipeline.generate_statistical_seo(
            "demo.mp4", words, 28.0, "Rust channel",
            "faster-whisper:tiny.en",
            signals={"search_queries": ["rust connection pooling"],
                     "trend_terms": ["deadpool", "unspokenviral"],
                     "winning_titles": ["Tokio in 30 seconds"]},
        )
        title = payload["title"]
        self.assertFalse(title.endswith((".", ",", ";")))
        self.assertGreaterEqual(len(title.split()), 2)
        self.assertTrue(seo.query_hit(title, ["rust connection pooling"]))
        self.assertNotEqual(title.lower(), "stop wasting hours on rust connection pooling.")
        self.assertIn("deadpool", [t.lower() for t in payload["tags"]])
        self.assertNotIn("unspokenviral", [t.lower() for t in payload["tags"]])
        self.assertTrue(payload["pinned_comment"])
        self.assertTrue(payload["description"].startswith(title))
        self.assertEqual(payload["demand_queries"], ["rust connection pooling"])
        got = {c["id"]: c["got"] for c in payload["quality_checks"]}
        self.assertEqual(got["title_query_match"], 12)

    def test_filler_takes_are_not_the_title(self):
        spoken = (
            "I want to spawn a Muse Agent, is open, sir, and focused. "
            "Okay, I want to open Codex Agent. is open and focused, sir. "
            "Open Terminal. Terminal is open, sir, with Hulk."
        ).split()
        words = [
            {"word": w, "start": i * 0.4, "end": i * 0.4 + 0.35}
            for i, w in enumerate(spoken)
        ]
        payload = short_pipeline.generate_statistical_seo(
            "demo.mp4", words, 20.0, "AI coding live",
            "faster-whisper:tiny.en",
        )
        blob = " ".join(
            [payload["title"]] + payload["title_alternatives"]
            + payload["search_queries"]
        ).lower()
        self.assertNotIn("is open and focused, sir", blob)
        self.assertNotIn("open sir", payload["search_queries"])
        self.assertFalse(payload["title"].endswith(","))
        self.assertGreaterEqual(len(payload["title"].split()), 2)

    def test_assembled_agent_package_keeps_measured_numbers(self):
        words = self._words()
        agent_doc = {
            "title": "Agent Title",
            "title_alternatives": ["A1", "A2"],
            "description": "Agent words.",
            "tags": ["pooling", "rust"],
            "hashtags": ["#pooling"],
            "hook_detected": "Agent hook.",
            "content_highlights": ["c1", "c2"],
            "overall_summary": "Agent summary.",
        }
        payload = short_pipeline.assemble_agent_seo(
            agent_doc, words, 30.0, "Rust channel", "scribe_v1",
        )
        self.assertEqual(payload["title"], "Agent Title")
        self.assertEqual(payload["review_report"]["hook_detected"],
                         "Agent hook.")
        self.assertEqual(payload["review_report"]["word_count"], len(words))
        self.assertEqual(payload["review_report"]["transcript_source"],
                         "scribe_v1")
        self.assertEqual(payload["seo_score"],
                         payload["review_report"]["retention_score"])
        self.assertNotIn("demand_queries", payload)


class SeoStructureTests(unittest.TestCase):
    def _words(self):
        terms = ("rust async pooling tokio deadpool ".split() * 6)
        return [
            {"word": w, "start": i * 0.5, "end": i * 0.5 + 0.4}
            for i, w in enumerate(terms)
        ]

    def test_statistical_package_is_full_and_structured(self):
        words = self._words()
        payload = short_pipeline.generate_statistical_seo(
            "demo.mp4", words, 30.0, "Rust channel",
            "faster-whisper:tiny.en",
        )
        # Honest tag bench: transcript terms only, within the upload budget.
        self.assertGreater(len(payload["tags"]), 0)
        self.assertLessEqual(len(payload["tags"]), 20)
        total = len(", ".join(payload["tags"]))
        self.assertLessEqual(total, 500)
        vocab = {w["word"].lower() for w in words}
        for tag in payload["tags"]:
            core = tag.lower()
            # Topic compounds only add structural suffixes, never new claims.
            for suffix in (" tutorial", " shorts"):
                if core.endswith(suffix):
                    core = core[: -len(suffix)]
                    break
            for token in core.split():
                self.assertIn(token, vocab, tag)
        # Alternatives vary with the takes available, best first.
        self.assertGreaterEqual(len(payload["title_alternatives"]), 1)
        self.assertLessEqual(len(payload["title_alternatives"]), 4)
        # Composed title above the fold, hashtags closing it, no stuffing.
        desc = payload["description"]
        self.assertTrue(desc.startswith(payload["title"]))
        self.assertNotIn("Search Keywords", desc)
        for ht in payload["hashtags"]:
            self.assertIn(ht, desc)
        self.assertLessEqual(len(payload["hashtags"]), 5)
        self.assertTrue(seo.query_hit(desc[:150], payload["search_queries"]
                                      or payload["keywords_analyzed"]))

    def test_validate_caps_tags_and_completes_description(self):
        doc = {
            "title": "Best Title Here",
            "title_alternatives": ["A", "B", "C", "D"],
            "description": "Two sentences on what is covered. Plus key points.",
            "tags": ["keyword-phrase-number-%02d" % i for i in range(25)],
            "hashtags": [],
            "hook_detected": "Hook line.",
            "content_highlights": ["c1", "c2", "c3", "c4"],
            "overall_summary": "Summary.",
        }
        seo = short_pipeline.validate_seo(doc)
        self.assertLessEqual(len(seo["tags"]), 15)
        self.assertLessEqual(len(", ".join(seo["tags"])), 500)
        # Most important first: order preserved from the head.
        self.assertEqual(seo["tags"][0], "keyword-phrase-number-00")
        # Hashtags close the description; no keyword list is appended.
        self.assertNotIn("Search Keywords", seo["description"])
        self.assertIn(seo["hashtags"][0], seo["description"])
        self.assertEqual(seo["description"].count(seo["hashtags"][0]), 1)
        # Optional extras default cleanly when an older agent omits them.
        self.assertEqual(seo["search_queries"], [])
        self.assertEqual(seo["pinned_comment"], "")

    def test_validate_strips_agent_keyword_block_and_keeps_queries(self):
        doc = {
            "title": "Rust pooling in 60 seconds",
            "title_alternatives": ["A"],
            "description": ("Your pool is leaking.\nFix it in Rust.\n\n"
                            "\U0001F50D Search Keywords:\nrust, pool, tokio\n\n"
                            "#rust #tokio"),
            "tags": ["rust", "tokio"],
            "hashtags": ["#rust", "#tokio"],
            "search_queries": ["Rust Connection Pooling", "rust connection pooling",
                               "tokio pool", "deadpool", "extra"],
            "pinned_comment": "  Which pool crate do you use?  ",
            "hook_detected": "Your pool is leaking.",
            "content_highlights": ["c1"],
            "overall_summary": "Summary.",
        }
        seo = short_pipeline.validate_seo(doc)
        self.assertNotIn("Search Keywords", seo["description"])
        self.assertNotIn("rust, pool, tokio", seo["description"])
        self.assertIn("#rust #tokio", seo["description"])
        self.assertEqual(seo["search_queries"],
                         ["rust connection pooling", "tokio pool", "deadpool"])
        self.assertEqual(seo["pinned_comment"], "Which pool crate do you use?")

    def test_fallback_queries_need_every_word_spoken(self):
        words = [{"word": w, "start": i * 0.5, "end": i * 0.5 + 0.4}
                 for i, w in enumerate("open source models run local".split())]
        got = short_pipeline._grounded_queries(
            words, ["open source ai", "open source contribution",
                    "local models", "open source"], [])
        # "ai" and "contribution" were never said; "models" was.
        self.assertEqual(got, ["local models", "open source"])

    def test_fallback_phrases_skip_filler(self):
        words = [{"word": w, "start": i * 0.5, "end": i * 0.5 + 0.4}
                 for i, w in enumerate(
                     ("end end add subtitles local model " * 3).split())]
        phrases = short_pipeline._top_phrases(words)
        self.assertNotIn("end end", phrases)
        self.assertNotIn("end add", phrases)
        self.assertIn("local model", phrases)
        self.assertNotIn("end", short_pipeline._top_terms(words))

    def test_prompt_carries_market_signals(self):
        prompt = short_pipeline.build_seo_prompt(
            "takes", 30.0, 80, "ctx",
            search_queries=["rust connection pooling"],
            trend_terms=["deadpool"],
            winning_titles=["Tokio in 30 seconds"],
        )
        self.assertIn("REAL SEARCH QUERIES", prompt)
        self.assertIn("- rust connection pooling", prompt)
        self.assertIn("TRENDING TERMS", prompt)
        self.assertIn("TITLES THAT WORKED ON THIS CHANNEL", prompt)
        self.assertIn("- Tokio in 30 seconds", prompt)
        bare = short_pipeline.build_seo_prompt("takes", 30.0, 80, "ctx")
        self.assertNotIn("REAL SEARCH QUERIES", bare)

    def test_split_signal_arg(self):
        self.assertEqual(short_pipeline.split_signal_arg(" a | b |a|| "),
                         ["a", "b"])
        self.assertEqual(short_pipeline.split_signal_arg(None), [])


class ExtractSeoDocTests(unittest.TestCase):
    def test_response_wins_over_stale_structured_output(self):
        # Observed live: agy's structured_output carried EDL segments while
        # response held the correct SEO JSON.
        seo = {
            "title": "Stop Doing This With Tokio Runtimes!",
            "title_alternatives": ["A", "B", "C", "D"],
            "description": "Deep dive.",
            "tags": ["tokio", "rust"],
            "hashtags": ["#tokio"],
            "hook_detected": "Stop doing this.",
            "content_highlights": ["c1"],
            "overall_summary": "Summary.",
        }
        stdout = json.dumps({
            "status": "SUCCESS",
            "response": json.dumps(seo),
            "structured_output": {
                "segments": [{"start": 0, "end": 1}],
            },
        })
        self.assertEqual(
            short_pipeline._extract_seo_doc(stdout, "agy")["title"],
            "Stop Doing This With Tokio Runtimes!",
        )

    def test_plain_json_still_parses(self):
        stdout = json.dumps({"title": "T", "x": 1})
        self.assertEqual(
            short_pipeline._extract_seo_doc(stdout, "codex")["title"], "T",
        )


class SeoHonestFailureTests(unittest.TestCase):
    def test_missing_input_file_is_failure_not_template(self):
        import io as _io
        from contextlib import redirect_stderr
        err = _io.StringIO()
        with redirect_stderr(err):
            rc = short_pipeline.main([
                "--input", os.path.join("no-such-dir", "nope.mp4"),
                "--output", "dummy.mp4",
                "--generate-seo-only",
            ])
        self.assertEqual(rc, 1)
        self.assertIn("existing video file", err.getvalue())


class StreamClipTests(unittest.TestCase):
    FILLER = "well um so basically like you know stuff things going on here "
    HOT = ("STOP making this mistake! What is the secret nobody tells you? "
           "Here are 7 proven hacks that work!")

    def _words(self, sections):
        words = []
        cursor = 0.0
        for text, span in sections:
            tokens = text.split(" ")
            for i, token in enumerate(tokens):
                words.append({
                    "word": token,
                    "start": cursor + span * i / len(tokens),
                    "end": cursor + span * (i + 1) / len(tokens),
                })
            cursor += span + 45.0
        return words, cursor

    def _mixed(self):
        return self._words([
            (self.FILLER * 6, 60.0),
            (self.HOT * 4, 40.0),
            (self.FILLER * 6, 60.0),
            (self.HOT * 4, 40.0),
            (self.FILLER * 8, 80.0),
        ])

    def test_supported_urls(self):
        for url in (
            "https://www.youtube.com/watch?v=abc123",
            "https://youtu.be/abc123",
            "https://www.youtube.com/live/abc123",
            "https://www.youtube.com/shorts/abc123",
            "https://www.twitch.tv/videos/1234567890",
        ):
            self.assertTrue(stream_clip.is_supported_url(url), url)
        for url in (
            "https://example.com/video",
            "https://www.twitch.tv/somechannel",
            "not a url",
            "",
        ):
            self.assertFalse(stream_clip.is_supported_url(url), url)

    def test_vtt_parses_cues_to_words(self):
        vtt = ("WEBVTT\n\n00:00:05.000 --> 00:00:08.000\n"
               "Hello world this is a test\n\n"
               "00:00:08.000 --> 00:00:10.000\n<c>Second cue</c> here!\n")
        words = stream_clip.parse_vtt(vtt)
        self.assertEqual(len(words), 9)
        self.assertEqual(words[0]["word"], "Hello")
        self.assertAlmostEqual(words[0]["start"], 5.0)
        self.assertEqual(words[-1]["word"], "here!")
        self.assertLessEqual(words[-1]["end"], 10.0)

    def test_json3_parses_segments(self):
        doc = {"events": [
            {"tStartMs": 1000, "segs": [
                {"utf8": "hello ", "tDurationMs": 400},
                {"utf8": "world", "tDurationMs": 400},
            ]},
        ]}
        words = stream_clip.parse_json3(doc)
        self.assertEqual([w["word"] for w in words], ["hello", "world"])
        self.assertAlmostEqual(words[0]["start"], 1.0)

    def test_count_follows_quality_not_quota(self):
        words, duration = self._mixed()
        loose = stream_clip.suggest_clips(words, duration, threshold=0.55)
        strict = stream_clip.suggest_clips(words, duration, threshold=0.99)
        self.assertGreater(len(loose), 0)
        self.assertEqual(strict, [])
        # Hot regions surface with hook reasons.
        self.assertTrue(any("hook" in c["reason"].lower() for c in loose))

    def test_clips_are_sorted_gap_separated_and_capped(self):
        words, duration = self._mixed()
        clips = stream_clip.suggest_clips(
            words, duration, threshold=0.5, max_clips=2, min_gap=30.0)
        self.assertLessEqual(len(clips), 2)
        starts = [c["start"] for c in clips]
        self.assertEqual(starts, sorted(starts))
        for first, second in zip(clips, clips[1:]):
            self.assertGreaterEqual(second["start"] - first["end"], 30.0)
        for clip in clips:
            for key in ("start", "end", "score", "reason", "text"):
                self.assertIn(key, clip)
            self.assertLess(clip["start"], clip["end"])
            self.assertGreaterEqual(clip["score"], 0.5)

    def test_empty_transcript_suggests_nothing(self):
        self.assertEqual(stream_clip.suggest_clips([], 0.0), [])

    def test_section_time_formats_hh_mm_ss(self):
        self.assertEqual(stream_clip.format_section_time(754), "00:12:34")
        self.assertEqual(stream_clip.format_section_time(45), "00:00:45")

    def test_download_writes_source_marker_for_storage_cleanup(self):
        saved_run = stream_clip._run
        with tempfile.TemporaryDirectory() as tmp:
            output = os.path.join(tmp, "talk_clip1.mp4")

            def fake_run(cmd, timeout):
                with open(output, "wb") as fh:
                    fh.write(b"mp4")
                return subprocess.CompletedProcess(cmd, 0, "", "")

            stream_clip._run = fake_run
            try:
                stream_clip.download_section("https://youtu.be/abcdefghijk", 10, 40, output)
            finally:
                stream_clip._run = saved_run
            with open(output + ".source.json", encoding="utf-8") as fh:
                marker = json.load(fh)
        self.assertEqual(marker["kind"], "stream_clip")
        self.assertEqual((marker["start"], marker["end"]), (10, 40))

    def test_download_creates_missing_parent_and_returns_absolute_path(self):
        saved_run = stream_clip._run
        with tempfile.TemporaryDirectory() as tmp:
            output = os.path.join(tmp, "nested", "talk_clip1.mp4")

            def fake_run(cmd, timeout):
                dest = cmd[cmd.index("-o") + 1]
                with open(dest, "wb") as fh:
                    fh.write(b"mp4")
                return subprocess.CompletedProcess(cmd, 0, "", "")

            stream_clip._run = fake_run
            try:
                saved = stream_clip.download_section(
                    "https://youtu.be/abcdefghijk", 10, 40, output)
            finally:
                stream_clip._run = saved_run
            self.assertEqual(saved, os.path.abspath(output))
            self.assertTrue(os.path.isfile(saved))
            self.assertTrue(os.path.isfile(saved + ".source.json"))

    def test_download_error_hides_urls_and_explains_403(self):
        stderr = (
            "ERROR: [youtube] Unable to download: "
            "HTTP Error 403: Forbidden. "
            "https://rr1---sn-xyz.googlevideo.com/videoplayback?signature=ABC123&lsparams=cps"
        )
        message = stream_clip._clean_download_error(stderr)
        self.assertNotIn("googlevideo.com", message)
        self.assertNotIn("signature", message)
        self.assertIn("bot check", message)
        self.assertIn("yt-dlp", message)

    def test_download_error_passes_through_plain_failures(self):
        message = stream_clip._clean_download_error(
            "ERROR: [youtube] XYZ: Private video. Only the owner can access.")
        self.assertIn("private", message.lower())
        self.assertNotIn("https://", message)

    def test_multiclip_prompt_carries_range_and_context(self):
        prompt = agent_edit.build_multiclip_prompt(
            "1. [00:00.00-00:05.00] hello world",
            duration=120.0, min_length=20.0, max_length=45.0,
            max_clips=6, min_gap=30.0,
            context="Rust channel", hook="open on the demo",
        )
        self.assertIn("Rust channel", prompt)
        self.assertIn("open on the demo", prompt)
        self.assertIn("20-45 seconds", prompt)
        self.assertIn("up to 6 clips", prompt)
        self.assertIn('"segments"', prompt)

    def test_suggest_cli_reads_words_file(self):
        import io as _io
        from contextlib import redirect_stdout
        words, duration = self._mixed()
        with tempfile.NamedTemporaryFile(
                "w", suffix=".json", delete=False) as fh:
            json.dump({"words": words, "duration": duration}, fh)
            path = fh.name
        try:
            buf = _io.StringIO()
            with redirect_stdout(buf):
                rc = stream_clip.main(["--words", path, "--threshold", "0.55"])
            self.assertEqual(rc, 0)
            doc = json.loads(buf.getvalue())
            self.assertIn("clips", doc)
            self.assertGreater(len(doc["clips"]), 0)
            self.assertEqual(doc["transcript_source"], "transcript-file")
        finally:
            os.remove(path)


class MulticlipValidateTests(unittest.TestCase):
    def test_length_window_enforced(self):
        edl = agent_edit.validate_multiclip(
            {"segments": [
                {"start": 0, "end": 30, "score": 0.9, "reason": "good"},
                {"start": 100, "end": 105, "score": 0.95},  # too short
                {"start": 200, "end": 400, "score": 0.9},  # too long
            ]},
            duration=600.0, min_length=20.0, max_length=45.0,
        )
        self.assertEqual(len(edl["segments"]), 1)
        self.assertEqual(edl["segments"][0]["start"], 0)

    def test_overlap_keeps_higher_score(self):
        edl = agent_edit.validate_multiclip(
            {"segments": [
                {"start": 0, "end": 30, "score": 0.6},
                {"start": 20, "end": 45, "score": 0.9},
            ]},
            duration=600.0, min_length=20.0, max_length=45.0, min_gap=0,
        )
        self.assertEqual(len(edl["segments"]), 1)
        self.assertEqual(edl["segments"][0]["start"], 20)

    def test_min_gap_and_cap_follow_score(self):
        edl = agent_edit.validate_multiclip(
            {"segments": [
                {"start": 0, "end": 30, "score": 0.5},
                {"start": 40, "end": 70, "score": 0.9},  # 10s gap: clash
                {"start": 200, "end": 230, "score": 0.8},
            ]},
            duration=600.0, min_length=20.0, max_length=45.0,
            max_clips=1, min_gap=30.0,
        )
        self.assertEqual(len(edl["segments"]), 1)
        self.assertEqual(edl["segments"][0]["start"], 40)

    def test_empty_after_validation_raises(self):
        with self.assertRaises(agent_edit.AgentError):
            agent_edit.validate_multiclip(
                {"segments": []}, duration=60.0,
                min_length=20.0, max_length=45.0,
            )
        with self.assertRaises(agent_edit.AgentError):
            agent_edit.validate_multiclip(
                {"nope": 1}, duration=60.0,
                min_length=20.0, max_length=45.0,
            )


class StreamAgentTests(unittest.TestCase):
    def _words(self):
        words = []
        cursor = 0.0
        text = ("hello world this is a test of the stream clip finder " * 20)
        for token in text.split(" "):
            words.append({"word": token, "start": cursor, "end": cursor + 0.4})
            cursor += 0.5
        return words, cursor

    def test_unknown_agent_raises_without_network(self):
        words, duration = self._words()
        with self.assertRaises(stream_clip.StreamClipError) as ctx:
            stream_clip.suggest_with_agent(words, duration, "hal9000")
        self.assertIn("unknown agent", str(ctx.exception))

    def test_wants_agent_clips_mirrors_pipeline(self):
        self.assertTrue(stream_clip.wants_agent_clips("claude"))
        for agent in ("auto", "none", "off", "", None):
            self.assertFalse(stream_clip.wants_agent_clips(agent))

    def test_clips_carry_transcript_text(self):
        words, _ = self._words()
        clips = stream_clip.clips_with_text(
            [{"start": 0.0, "end": 10.0, "score": 0.9, "reason": "hook"}],
            words,
        )
        self.assertEqual(len(clips), 1)
        self.assertIn("hello", clips[0]["text"])
        self.assertEqual(clips[0]["reason"], "hook")

    def test_failed_selected_agent_reports_failure_without_heuristic_substitute(self):
        import io as _io
        from contextlib import redirect_stderr, redirect_stdout
        words, duration = self._words()
        with tempfile.NamedTemporaryFile(
                "w", suffix=".json", delete=False) as fh:
            json.dump({"words": words, "duration": duration}, fh)
            path = fh.name
        try:
            out, err = _io.StringIO(), _io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                rc = stream_clip.main([
                    "--words", path, "--agent", "hal9000",
                    "--threshold", "0.0", "--min-length", "5",
                    "--max-length", "60",
                ])
            self.assertEqual(rc, 1)
            self.assertEqual(out.getvalue(), "")
            self.assertIn("unknown agent", err.getvalue())
        finally:
            os.remove(path)


class SplitLayoutTests(unittest.TestCase):
    def test_parse_layout_defaults_to_single(self):
        self.assertEqual(render.parse_layout(None), "single")
        self.assertEqual(render.parse_layout(""), "single")
        self.assertEqual(render.parse_layout("bogus"), "single")
        self.assertEqual(render.parse_layout("screen-top"), "screen-top")
        self.assertEqual(render.parse_layout("face-top"), "face-top")

    def test_color_chain_keeps_grade_without_crop(self):
        warm = grade.color_chain("warm_cinematic")
        self.assertIn("eq=", warm)
        self.assertNotIn("crop=", warm)
        self.assertNotIn("scale=", warm)
        self.assertEqual(grade.color_chain("subtle"), "")

    def test_parse_face_roi_corners_stay_in_frame(self):
        for corner in ("br", "bl", "tr", "tl"):
            roi = render.parse_face_roi(corner, 1920, 1080)
            self.assertGreater(roi["w"], 0)
            self.assertGreater(roi["h"], 0)
            self.assertGreaterEqual(roi["x"], 0)
            self.assertGreaterEqual(roi["y"], 0)
            self.assertLessEqual(roi["x"] + roi["w"], 1920)
            self.assertLessEqual(roi["y"] + roi["h"], 1080)
        br = render.parse_face_roi("br", 1920, 1080)
        tl = render.parse_face_roi("tl", 1920, 1080)
        self.assertGreater(br["x"], tl["x"])
        self.assertGreater(br["y"], tl["y"])

    def test_parse_face_roi_fractions(self):
        roi = render.parse_face_roi("0.75,0.7,0.25,0.3", 1920, 1080)
        self.assertEqual(roi, {"x": 1440, "y": 756, "w": 480, "h": 324})

    def test_parse_face_roi_rejects_garbage(self):
        with self.assertRaises(render.RenderError):
            render.parse_face_roi("nonsense", 1920, 1080)

    def test_detect_face_roi_falls_back_on_missing_input(self):
        roi, note = render.detect_face_roi("/nonexistent/clip.mp4", "auto")
        self.assertIn("fallback", note)
        self.assertLessEqual(roi["x"] + roi["w"], 1920)
        self.assertLessEqual(roi["y"] + roi["h"], 1080)

    def test_split_chain_uses_explicit_fanout(self):
        # Regression: one label feeding two chains relies on ffmpeg's
        # implicit fan-out, which breaks EOF propagation into vstack on
        # ffmpeg 9 — trimmed EDL video then runs to full input length
        # while audio stays cut. The explicit split keeps video
        # segment-length. Pinned for both stack orders.
        face = {"x": 1400, "y": 700, "w": 500, "h": 350}
        for layout in ("screen-top", "face-top"):
            chain, stacked = render.split_video_chain(
                "[vcat]", face, layout)
            self.assertIn("[vcat]split[vsplit_screen][vsplit_face]", chain)
            self.assertTrue(chain.index("split[") < chain.index("[vscreen]"))
            self.assertTrue(chain.index("split[") < chain.index("[vface]"))
            self.assertEqual(stacked, "[vstacked]")
        # And the EDL split assembly consumes the trimmed concat label,
        # never the raw input.
        filt, _total = render.build_edl_filter(
            [{"start": 7.92, "end": 10.3}], "warm_cinematic",
            layout="screen-top", face_pixels=face)
        self.assertIn("[vcat]split[", filt)
        self.assertNotIn("[0:v]scale", filt)
        self.assertNotIn("[0:v]crop", filt)

    def test_edl_output_seconds_accounts_crossfades(self):
        one = [{"start": 7.92, "end": 10.3}]
        self.assertEqual(render.edl_output_seconds(one), 2.38)
        two = [{"start": 0.0, "end": 2.0}, {"start": 3.0, "end": 5.0}]
        self.assertEqual(render.edl_output_seconds(two), 3.97)
        self.assertEqual(render.edl_output_seconds(two, False), 4.0)

    def test_words_to_ass_end_cap_holds_final_cue(self):
        words = [{"word": "are", "start": 1.22, "end": 2.38}]
        capped = render.words_to_ass(words, end_cap=2.38)
        ends = []
        for line in capped.splitlines():
            if line.startswith("Dialogue:"):
                parts = line.split(",")
                h, m, s = parts[2].split(":")
                ends.append(int(h) * 3600 + int(m) * 60 + float(s))
        self.assertTrue(ends)
        self.assertLessEqual(max(ends), 2.38)
        uncapped = render.words_to_ass(words)
        uncapped_ends = []
        for line in uncapped.splitlines():
            if line.startswith("Dialogue:"):
                parts = line.split(",")
                h, m, s = parts[2].split(":")
                uncapped_ends.append(int(h) * 3600 + int(m) * 60 + float(s))
        self.assertGreater(max(uncapped_ends), 2.38)

    def test_edl_args_use_vstack_for_split(self):
        segs = [{"start": 0.0, "end": 2.0}]
        face = {"x": 1440, "y": 756, "w": 480, "h": 324}
        args = render.build_edl_ffmpeg_args(
            "in.mp4", "out.mp4", segs, "warm_cinematic",
            layout="screen-top", face_pixels=face,
        )
        joined = " ".join(args)
        self.assertIn("vstack", joined)
        self.assertIn("crop=480:324:1440:756", joined)
        single = render.build_edl_ffmpeg_args(
            "in.mp4", "out.mp4", segs, "warm_cinematic",
        )
        self.assertIn("crop=1080:1920", " ".join(single))

    def test_pipeline_parser_defaults(self):
        args = short_pipeline.build_parser().parse_args(
            ["--input", "in.mp4", "--output", "out.mp4"])
        self.assertEqual(args.layout, "auto")
        self.assertEqual(args.face_roi, "auto")


class StreamLiveProbeTests(unittest.TestCase):
    def _stub_run(self, doc):
        real_run = stream_clip._run

        class Proc:
            returncode = 0
            stdout = json.dumps(doc)
            stderr = ""

        stream_clip._run = lambda cmd, timeout: Proc()  # noqa: E731
        return real_run

    def test_live_probe_reports_is_live_instead_of_raising(self):
        real_run = self._stub_run({
            "title": "Friday stream",
            "channel": "chan",
            "thumbnails": [{"url": "http://thumb"}],
            "duration": None,
            "view_count": 10,
            "upload_date": "20260101",
            "is_live": True,
        })
        try:
            meta = stream_clip.probe_url("https://www.youtube.com/watch?v=live")
        finally:
            stream_clip._run = real_run
        self.assertTrue(meta["is_live"])
        self.assertEqual(meta["duration"], 0.0)
        self.assertEqual(meta["title"], "Friday stream")

    def test_vod_probe_still_reports_finished(self):
        real_run = self._stub_run({
            "title": "VOD",
            "channel": "chan",
            "thumbnails": [],
            "duration": 3720,
            "view_count": 5,
            "upload_date": "20260102",
            "is_live": False,
        })
        try:
            meta = stream_clip.probe_url("https://www.youtube.com/watch?v=vod")
        finally:
            stream_clip._run = real_run
        self.assertFalse(meta["is_live"])
        self.assertEqual(meta["duration"], 3720.0)

    def test_suggest_refuses_live_with_watch_message(self):
        import io as _io
        from contextlib import redirect_stderr, redirect_stdout
        real_run = self._stub_run({
            "title": "Friday stream",
            "channel": "chan",
            "thumbnails": [],
            "duration": None,
            "view_count": 10,
            "upload_date": "20260101",
            "is_live": True,
        })
        try:
            out, err = _io.StringIO(), _io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                rc = stream_clip.main(
                    ["--suggest", "--url", "https://www.youtube.com/watch?v=live"])
        finally:
            stream_clip._run = real_run
        self.assertEqual(rc, 1)
        self.assertIn("live right now", err.getvalue())

    def test_live_status_is_live_without_is_live_flag(self):
        real_run = self._stub_run({
            "title": "Friday stream",
            "channel": "chan",
            "thumbnails": [],
            "duration": None,
            "live_status": "is_live",
        })
        try:
            meta = stream_clip.probe_url("https://www.youtube.com/watch?v=live")
        finally:
            stream_clip._run = real_run
        self.assertTrue(meta["is_live"])
        self.assertEqual(meta["duration"], 0.0)

    def test_post_live_and_upcoming_are_unfinished(self):
        for status in ("post_live", "is_upcoming"):
            real_run = self._stub_run({
                "title": "Processing",
                "channel": "chan",
                "thumbnails": [],
                "duration": 0,
                "is_live": False,
                "was_live": status == "post_live",
                "live_status": status,
            })
            try:
                meta = stream_clip.probe_url("https://www.youtube.com/watch?v=live")
            finally:
                stream_clip._run = real_run
            self.assertTrue(meta["is_live"], status)

    def test_was_live_without_duration_is_unfinished(self):
        real_run = self._stub_run({
            "title": "Processing VOD",
            "channel": "chan",
            "thumbnails": [],
            "duration": None,
            "is_live": False,
            "was_live": True,
            "live_status": "was_live",
        })
        try:
            meta = stream_clip.probe_url("https://www.youtube.com/watch?v=vod")
        finally:
            stream_clip._run = real_run
        self.assertTrue(meta["is_live"])

    def test_was_live_vod_with_duration_is_ready(self):
        real_run = self._stub_run({
            "title": "VOD",
            "channel": "chan",
            "thumbnails": [],
            "duration": 3600,
            "is_live": False,
            "was_live": True,
            "live_status": "was_live",
        })
        try:
            meta = stream_clip.probe_url("https://www.youtube.com/watch?v=vod")
        finally:
            stream_clip._run = real_run
        self.assertFalse(meta["is_live"])
        self.assertEqual(meta["duration"], 3600.0)

    def test_suggest_refuses_post_live_before_transcript(self):
        import io as _io
        from contextlib import redirect_stderr, redirect_stdout
        real_run = self._stub_run({
            "title": "Just ended",
            "channel": "chan",
            "thumbnails": [],
            "duration": None,
            "is_live": False,
            "live_status": "post_live",
        })
        try:
            out, err = _io.StringIO(), _io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                rc = stream_clip.main(
                    ["--suggest", "--url", "https://www.youtube.com/live/abc"])
        finally:
            stream_clip._run = real_run
        self.assertEqual(rc, 1)
        self.assertIn("live right now", err.getvalue())
        self.assertEqual(out.getvalue().strip(), "")

    def test_is_unfinished_live_covers_yt_dlp_shapes(self):
        self.assertTrue(stream_clip.is_unfinished_live({"is_live": True}))
        self.assertTrue(stream_clip.is_unfinished_live({"live_status": "is_live"}))
        self.assertTrue(stream_clip.is_unfinished_live({"live_status": "post_live", "is_live": False}))
        self.assertTrue(stream_clip.is_unfinished_live({"was_live": True, "duration": None}))
        self.assertFalse(stream_clip.is_unfinished_live({"is_live": False, "live_status": "was_live", "was_live": True, "duration": 120}))
        self.assertFalse(stream_clip.is_unfinished_live({"is_live": False, "live_status": "not_live", "duration": 10}))
        self.assertFalse(stream_clip.is_unfinished_live({}))
        self.assertFalse(stream_clip.is_unfinished_live(None))


class SeoCoreTests(unittest.TestCase):
    def test_normalize_hashtags_dedupe_and_backfill(self):
        tags = ["Rust Async", "rustasync", "Connection Pooling"]
        out = seo.normalize_hashtags(tags, ["#RustAsync"])
        self.assertEqual(out[0], "#rustasync")
        self.assertIn("#connectionpooling", out)
        # "#rustasync" appears once despite case/space variants.
        self.assertEqual(out.count("#rustasync"), 1)

    def test_normalize_hashtag_handles_digits_and_noise(self):
        self.assertEqual(seo.normalize_hashtag(" 60 Seconds "), "#t60seconds")
        self.assertEqual(seo.normalize_hashtag("C++ tips!"), "#ctips")
        self.assertEqual(seo.normalize_hashtag(""), "")

    def test_fit_tag_budget_dedupes_case_insensitively(self):
        tags = seo.fit_tag_budget(["Rust", "rust", " RUST ", "tokio"])
        self.assertEqual(tags, ["Rust", "tokio"])
        joined = ", ".join(seo.fit_tag_budget(["x" * 400, "y" * 200]))
        self.assertLessEqual(len(joined), 500)

    def test_top_phrases_are_spoken_bigrams(self):
        words = [
            {"word": w, "start": i * 0.5, "end": i * 0.5 + 0.4}
            for i, w in enumerate(
                ("rust async pooling ".split() * 6))
        ]
        phrases = short_pipeline._top_phrases(words)
        self.assertGreater(len(phrases), 0)
        vocab = {w["word"] for w in words}
        for phrase in phrases:
            first, second = phrase.split(" ")
            self.assertIn(first, vocab)
            self.assertIn(second, vocab)

    def test_statistical_package_carries_quality_signals(self):
        words = [
            {"word": w, "start": i * 0.5, "end": i * 0.5 + 0.4}
            for i, w in enumerate(
                ("rust async pooling tokio deadpool ".split() * 6))
        ]
        payload = short_pipeline.generate_statistical_seo(
            "demo.mp4", words, 30.0, "Rust channel",
            "faster-whisper:tiny.en",
        )
        # seo_score stays the measured retention figure (contract).
        self.assertEqual(payload["seo_score"],
                         payload["review_report"]["retention_score"])
        self.assertIn("quality_score", payload)
        self.assertIn("quality_checks", payload)
        self.assertGreaterEqual(payload["quality_score"], 0)
        self.assertLessEqual(payload["quality_score"], 100)
        check_ids = {c["id"] for c in payload["quality_checks"]}
        for expected in ("title_query_match", "title_mobile_fit",
                         "hook_strength", "description_above_fold",
                         "description_no_stuffing", "hashtags_count"):
            self.assertIn(expected, check_ids)
        # Phrases widen the bench without invented filler.
        self.assertTrue(any(" " in tag for tag in payload["tags"]))
        for filler in ("tech", "coding", "viral", "trending"):
            self.assertNotIn(filler, payload["tags"])

    def test_scorer_rewards_complete_packages(self):
        tags = ["rust", "rust async", "rust tutorial", "shorts",
                "tokio", "pooling", "connection pooling", "async",
                "programming", "developer"]
        hashtags = seo.normalize_hashtags(tags, ["#rust"])
        desc = seo.build_description(
            "Stop doing this with rust",
            "About Rust. Covered: async; pooling.",
            ["async deep dive", "pooling fix"],
            hashtags, cta="Subscribe for more!",
        )
        full = seo.score_seo("Rust async pooling fix", desc, tags,
                             hashtags, ["rust", "async"], retention=90,
                             queries=["rust async pooling"])
        thin = seo.score_seo("", "", [], [], [], retention=0)
        self.assertGreater(full["seo_score"], thin["seo_score"])
        self.assertGreater(full["quality_score"], 60)

    def test_scorer_prefers_clean_query_title_over_stuffed_package(self):
        tags = ["rust", "tokio", "deadpool", "connection pooling", "async"]
        hashtags = ["#rust", "#tokio", "#deadpool"]
        clean_desc = seo.build_description(
            "Your Rust pool is leaking connections.",
            "Fix rust connection pooling with deadpool in 60 seconds.",
            ["Why tokio pools leak"], hashtags, cta="Follow for more Rust.")
        stuffed_desc = ("Watch now!\n\n\U0001F50D Search Keywords:\n"
                        + ", ".join(["kw%d" % i for i in range(20)])
                        + "\n\n" + " ".join(hashtags))
        queries = ["rust connection pooling"]
        clean = seo.score_seo("Rust connection pooling in 60s", clean_desc,
                              tags, hashtags, [], queries=queries,
                              hook="Your Rust pool is leaking connections.")
        stuffed = seo.score_seo("THE BEST INSANE SECRET TRICK EVER",
                                stuffed_desc, tags * 3, hashtags, [],
                                queries=queries)
        self.assertGreater(clean["quality_score"],
                           stuffed["quality_score"] + 30)
        got = {c["id"]: c["got"] for c in stuffed["checks"]}
        self.assertEqual(got["description_no_stuffing"], 0)
        self.assertEqual(got["title_not_shouting"], 0)

    def test_hook_panel_weakest_link(self):
        strong = seo.score_hook(
            "You are wasting 3 hours a week on Rust builds, and nobody "
            "tells you why")
        weak = seo.score_hook("hey guys welcome back")
        self.assertGreater(strong["verdict"], weak["verdict"])
        self.assertIn(weak["weakest"], seo.HOOK_FIXES)
        self.assertEqual(seo.score_hook("")["verdict"], 0)

    def test_query_hit_and_title_lint(self):
        self.assertTrue(seo.query_hit("Connection pooling in Rust",
                                      ["rust connection pooling"]))
        self.assertFalse(seo.query_hit("Cooking pasta fast",
                                       ["rust connection pooling"]))
        lint = seo.lint_title("THE BEST INSANE trick")
        self.assertTrue(lint["shouting"])
        self.assertIn("best", lint["vague"])
        self.assertTrue(seo.lint_title("Rust in 60s")["mobile_fit"])

    def test_camel_case_hashtags_converge(self):
        self.assertEqual(seo.normalize_hashtag("RustAsync"), "#rustasync")
        out = seo.normalize_hashtags(["rust async"], ["#RustAsync"])
        self.assertEqual(out, ["#rustasync"])

    def test_strip_keyword_block_inline_and_next_line(self):
        inline = "Hook\n\nSearch Keywords: a, b, c\n\n#a"
        self.assertEqual(seo.strip_keyword_block(inline), "Hook\n\n#a")
        nextline = "Hook\n\U0001F50D Search Keywords:\na, b\n#a"
        self.assertEqual(seo.strip_keyword_block(nextline), "Hook\n#a")

    def test_scorer_penalizes_overlong_titles(self):
        tags = ["rust"]
        hashtags = ["#rust"]
        long_score = seo.score_seo("x" * 120, "body " * 30, tags,
                                   hashtags, ["rust"])
        short_score = seo.score_seo("Rust async fix", "body " * 30, tags,
                                    hashtags, ["rust"])
        self.assertGreater(short_score["quality_score"],
                           long_score["quality_score"])


class StreamFramingTests(unittest.TestCase):
    def test_parse_layout_accepts_face_only_and_auto(self):
        self.assertEqual(render.parse_layout("face-only"), "face-only")
        self.assertEqual(render.parse_layout("auto"), "auto")
        self.assertEqual(render.parse_layout("bogus"), "single")

    def test_face_only_chain_zooms_roi_to_full_canvas(self):
        face = {"x": 1400, "y": 700, "w": 500, "h": 350}
        chain, label = render.face_only_chain("[0:v]", face)
        self.assertIn("crop=500:350:1400:700", chain)
        self.assertIn("scale=1080:1920", chain)
        self.assertIn("crop=1080:1920", chain)
        self.assertEqual(label, "[vfacefull]")

    def test_face_only_chain_contain_rect_for_spanning_face(self):
        # Reported close-up: the old crop=1053:1053:0:867 amputated ~230px
        # per cheek. The crop must grow to contain the whole head instead.
        face = {"x": 0, "y": 867, "w": 1053, "h": 1053}
        chain, label = render.face_only_chain("[0:v]", face, 1080, 1920)
        self.assertIn("crop=1052:1872:0:48", chain)
        self.assertNotIn("crop=1053:1053:0:867", chain)
        self.assertEqual(label, "[vfacefull]")

    def test_split_face_band_fit_blur_for_spanning_face(self):
        # Same footage in a split band: fit the whole head over a blurred
        # pad instead of cover-cropping it (which sliced forehead/chin).
        # Small ROIs keep the old cover-zoom chain (no dims or no span).
        face = {"x": 0, "y": 867, "w": 1053, "h": 1053}
        chain, stacked = render.split_video_chain(
            "[0:v]", face, "screen-top", 1080, 1920)
        self.assertIn("gblur=sigma=40", chain)
        self.assertIn("overlay=", chain)
        self.assertIn("[vface]", chain)
        self.assertEqual(stacked, "[vstacked]")
        small = {"x": 1400, "y": 700, "w": 500, "h": 350}
        old, _stacked = render.split_video_chain(
            "[0:v]", small, "screen-top", 1920, 1080)
        self.assertNotIn("gblur", old)
        self.assertNotIn("overlay=", old)

    def test_edl_args_use_blur_band_for_spanning_face(self):
        face = {"x": 0, "y": 867, "w": 1053, "h": 1053}
        args = render.build_edl_ffmpeg_args(
            "in.mp4", "out.mp4", [{"start": 0.0, "end": 2.0}],
            "vertical_clean", layout="screen-top", face_pixels=face,
            src_w=1080, src_h=1920)
        joined = " ".join(args)
        self.assertIn("gblur=sigma=40", joined)
        self.assertIn("overlay=", joined)

    def test_resolve_auto_uses_split_only_on_true_detection(self):
        real_detect = render.detect_face_roi
        pixels = {"x": 1, "y": 2, "w": 3, "h": 4}
        try:
            render.detect_face_roi = lambda *a, **k: (  # noqa: E731
                pixels, "face:auto detected (x=1,y=2,w=3,h=4)")
            layout, found, _note = render.resolve_auto_layout("in.mp4")
            self.assertEqual(layout, "screen-top")
            self.assertEqual(found, pixels)
            render.detect_face_roi = lambda *a, **k: (  # noqa: E731
                pixels, "face:auto fallback br corner (x=1,y=2,w=3,h=4)")
            layout, found, _note = render.resolve_auto_layout("in.mp4")
            self.assertEqual(layout, "single")
            self.assertIsNone(found)
        finally:
            render.detect_face_roi = real_detect

    def test_single_args_use_face_chain_for_face_only(self):
        face = {"x": 1400, "y": 700, "w": 500, "h": 350}
        args = render.build_split_single_args(
            "in.mp4", "out.mp4", "vertical_clean", face, layout="face-only")
        joined = " ".join(args)
        self.assertIn("crop=500:350:1400:700", joined)
        self.assertIn("[vfacefull]", joined)
        self.assertNotIn("vstack", joined)

    def test_edl_args_use_face_chain_for_face_only(self):
        face = {"x": 1400, "y": 700, "w": 500, "h": 350}
        args = render.build_edl_ffmpeg_args(
            "in.mp4", "out.mp4", [{"start": 0.0, "end": 2.0}],
            "vertical_clean", layout="face-only", face_pixels=face)
        joined = " ".join(args)
        self.assertIn("crop=500:350:1400:700", joined)
        self.assertIn("[vfacefull]", joined)
        self.assertNotIn("vstack", joined)

    def test_usable_face_rejects_fallback_guesses(self):
        self.assertTrue(render._is_usable_face(
            "face:auto detected (x=1,y=2,w=3,h=4)"))
        self.assertTrue(render._is_usable_face("face:manual br"))
        self.assertFalse(render._is_usable_face(
            "face:auto fallback br corner (x=1,y=2,w=3,h=4); "
            "detection failed (no face found in preview frame)"))
        self.assertFalse(render._is_usable_face(""))
        self.assertFalse(render._is_usable_face(None))

    def test_single_crop_filter_centers_detected_face(self):
        # 1920x1080 landscape, face left of center: the full-height
        # 1080x1920 window pans left (x=82) instead of dead center
        # (x=1166); the vertical span is preserved, so y stays 0.
        face = {"x": 200, "y": 700, "w": 300, "h": 300}
        filt = render.single_crop_filter(
            "warm_cinematic", "9:16", face, 1920, 1080)
        self.assertIn("crop=1080:1920:82:0", filt)
        self.assertIn("eq=contrast=1.12", filt)

    def test_single_crop_filter_clamps_and_stays_even(self):
        # Face glued to the right edge: the window clamps to the frame
        # (never past it) with even offsets for yuv420.
        face = {"x": 1600, "y": 0, "w": 320, "h": 300}
        filt = render.single_crop_filter(
            "warm_cinematic", "9:16", face, 1920, 1080)
        self.assertIn("crop=1080:1920:2332:0", filt)

    def test_single_crop_filter_without_face_is_plain_center(self):
        self.assertEqual(
            render.single_crop_filter("warm_cinematic", "9:16"),
            grade.get_filter("warm_cinematic", "9:16"),
        )
        self.assertEqual(
            render.single_crop_filter("warm_cinematic", "1:1"),
            grade.get_filter("warm_cinematic", "1:1"),
        )

    def test_ffmpeg_single_args_center_face(self):
        face = {"x": 200, "y": 700, "w": 300, "h": 300}
        args = render.build_ffmpeg_args(
            "in.mp4", "out.mp4", "warm_cinematic",
            face_pixels=face, src_w=1920, src_h=1080)
        self.assertIn("crop=1080:1920:82:0", args[args.index("-vf") + 1])

    def test_edl_single_filter_centers_face(self):
        face = {"x": 200, "y": 700, "w": 300, "h": 300}
        filt, _total = render.build_edl_filter(
            [{"start": 0.0, "end": 2.0}], "warm_cinematic",
            layout="single", face_pixels=face, src_w=1920, src_h=1080)
        self.assertIn("crop=1080:1920:82:0", filt)
        self.assertNotIn("vstack", filt)

    def test_resolve_auto_splits_only_for_corner_cam_faces(self):
        real_detect, real_probe = render.detect_face_roi, render.probe_media
        try:
            render.probe_media = lambda *a, **k: (  # noqa: E731
                {"duration": 10.0, "width": 1920, "height": 1080,
                 "has_audio": True})
            # Corner-cam-sized detection (~8% of frame) -> split stack.
            render.detect_face_roi = lambda *a, **k: (  # noqa: E731
                {"x": 1400, "y": 700, "w": 500, "h": 350},
                "face:auto detected (x=1400,y=700,w=500,h=350)")
            layout, found, _note = render.resolve_auto_layout("in.mp4")
            self.assertEqual(layout, "screen-top")
            self.assertEqual(found["w"], 500)
            # Fullscreen subject (~30% of frame) -> face-centered single.
            render.detect_face_roi = lambda *a, **k: (  # noqa: E731
                {"x": 600, "y": 200, "w": 900, "h": 700},
                "face:auto detected (x=600,y=200,w=900,h=700)")
            layout, found, note = render.resolve_auto_layout("in.mp4")
            self.assertEqual(layout, "single")
            self.assertEqual(found["w"], 900)
            self.assertIn("face-centered single", note)
        finally:
            render.detect_face_roi = real_detect
            render.probe_media = real_probe

    def test_resolve_auto_manual_roi_centers_single(self):
        real_detect = render.detect_face_roi
        try:
            pixels = {"x": 1400, "y": 700, "w": 500, "h": 350}
            render.detect_face_roi = lambda *a, **k: (  # noqa: E731
                pixels, "face:manual br")
            layout, found, note = render.resolve_auto_layout("in.mp4")
            self.assertEqual(layout, "single")
            self.assertEqual(found, pixels)
            self.assertIn("face-centered single", note)
        finally:
            render.detect_face_roi = real_detect

    def test_effective_layout_collapses_face_only_off_vertical(self):
        self.assertEqual(render.effective_layout("face-only", "1:1"), "single")
        self.assertEqual(render.effective_layout("face-only", "16:9"), "single")
        self.assertEqual(
            render.effective_layout("face-only", "9:16"), "face-only")
        self.assertEqual(render.effective_layout("auto", "1:1"), "auto")

    def test_sample_times_spread_and_collapse(self):
        self.assertEqual(render._sample_times(0), [1.0])
        self.assertEqual(render._sample_times(None), [1.0])
        self.assertEqual(render._sample_times(6.0), [2.0, 3.0, 4.0])
        self.assertEqual(render._sample_times(0.4), [0.0, 0.2, 0.4])
        self.assertEqual(render._sample_times(44.0), [21.0, 22.0, 23.0])

    def test_box_iou(self):
        self.assertAlmostEqual(
            render._box_iou((0, 0, 10, 10), (0, 0, 10, 10)), 1.0)
        self.assertEqual(
            render._box_iou((0, 0, 10, 10), (20, 20, 10, 10)), 0.0)
        self.assertAlmostEqual(
            render._box_iou((0, 0, 10, 10), (5, 0, 10, 10)), 50.0 / 150.0)

    def _install_fake_vision(self, script):
        """Fake cv2/numpy/probe/grab so consensus runs without binaries."""
        import sys
        import types
        calls = {"n": 0}

        class FakeCascade:
            def empty(self):
                return False

            def detectMultiScale(self, *args, **kwargs):
                out = script[min(calls["n"], len(script) - 1)]
                calls["n"] += 1
                return out

        cv2mod = types.ModuleType("cv2")
        cv2mod.data = types.SimpleNamespace(haarcascades="")
        cv2mod.CascadeClassifier = lambda *a, **k: FakeCascade()
        cv2mod.imdecode = lambda *a, **k: object()
        cv2mod.cvtColor = (
            lambda *a, **k: types.SimpleNamespace(shape=(1080, 1920)))
        cv2mod.IMREAD_COLOR = 1
        cv2mod.COLOR_BGR2GRAY = 2
        npmod = types.ModuleType("numpy")
        npmod.frombuffer = lambda *a, **k: object()
        npmod.uint8 = "u1"
        saved = (sys.modules.get("cv2"), sys.modules.get("numpy"),
                 render.probe_media, render._grab_frame_jpeg)
        sys.modules["cv2"] = cv2mod
        sys.modules["numpy"] = npmod
        render.probe_media = lambda *a, **k: {  # noqa: E731
            "duration": 6.0, "width": 1920, "height": 1080,
            "has_audio": True}
        render._grab_frame_jpeg = lambda *a, **k: b"fakejpeg"  # noqa: E731
        return saved

    def _restore_vision(self, saved):
        import sys
        real_cv2, real_np, real_probe, real_grab = saved
        if real_cv2 is None:
            sys.modules.pop("cv2", None)
        else:
            sys.modules["cv2"] = real_cv2
        if real_np is None:
            sys.modules.pop("numpy", None)
        else:
            sys.modules["numpy"] = real_np
        render.probe_media = real_probe
        render._grab_frame_jpeg = real_grab

    def test_consensus_accepts_stable_face(self):
        saved = self._install_fake_vision(
            [[(100, 100, 50, 50)], [], [(102, 98, 52, 50)]])
        try:
            roi, note = render.detect_face_roi("in.mp4", "auto")
        finally:
            self._restore_vision(saved)
        self.assertTrue(note.startswith("face:auto detected"), note)
        self.assertEqual(roi, {"x": 80, "y": 79, "w": 91, "h": 90})

    def test_consensus_rejects_transient_false_positive(self):
        saved = self._install_fake_vision(
            [[(100, 100, 50, 50)], [], [(900, 900, 50, 50)]])
        try:
            roi, note = render.detect_face_roi("in.mp4", "auto")
        finally:
            self._restore_vision(saved)
        self.assertIn("no stable face", note)
        self.assertEqual(roi, {"x": 1401, "y": 734, "w": 518, "h": 345})

    def test_cluster_boxes_groups_by_overlap(self):
        big_a = ((0, 0, 100, 100), 0.0)
        big_b = ((10, 10, 100, 100), 1.0)
        small = ((500, 500, 20, 20), 2.0)
        groups = render._cluster_boxes([big_a, small, big_b])
        self.assertEqual(len(groups), 2)
        # Most members first.
        self.assertEqual(len(groups[0]), 2)
        self.assertEqual(len(groups[1]), 1)

    def test_cluster_boxes_prefers_dominant_area_on_tie(self):
        # Same member count: the dominant on-screen face must win over a
        # tiny PiP so the crop follows the subject, not the corner.
        giant_a = ((0, 0, 500, 500), 0.0)
        giant_b = ((10, 10, 500, 500), 1.0)
        pip_a = ((900, 900, 60, 60), 0.0)
        pip_b = ((905, 905, 60, 60), 1.0)
        groups = render._cluster_boxes([pip_a, giant_a, pip_b, giant_b])
        self.assertEqual(len(groups), 2)
        self.assertEqual(len(groups[0]), 2)
        self.assertEqual(groups[0][0][0][2], 500)

    def test_consensus_picks_dominant_face_across_frames(self):
        # Largest box flips between the giant subject face and a small
        # PiP frame to frame; the mean of the dominant cluster wins.
        script = [
            [(235, 1311, 591, 591)],
            [(902, 791, 74, 74)],
            [(229, 1284, 582, 582)],
        ]
        saved = self._install_fake_vision(script)
        try:
            roi, note = render.detect_face_roi("in.mp4", "auto")
        finally:
            self._restore_vision(saved)
        self.assertTrue(note.startswith("face:auto detected"), note)
        # Mean giant box (232, 1297.5, 586.5, 586.5) expanded 1.8x,
        # clamped into the 1920x1080 fake frame.
        self.assertEqual(
            roi, {"x": 0, "y": 25, "w": 1055, "h": 1055})

    def test_portrait_face_window_full_frame_for_width_spanning_face(self):
        # The reported vertical stream case: the head already spans the
        # full width (0..1053 of 1080). The old (118, 464, 818, 1456)
        # window shaved ~118px off each cheek, so no zoom window may be
        # returned: full frame, nothing cut.
        window = render._portrait_face_window(
            {"x": 0, "y": 867, "w": 1053, "h": 1053},
            1080, 1920, 1080, 1920)
        self.assertIsNone(window)

    def test_portrait_face_window_identity_for_full_frame(self):
        # A manual full-frame ROI is already the whole canvas: keep
        # pixels untouched instead of resampling pointlessly.
        self.assertIsNone(render._portrait_face_window(
            {"x": 0, "y": 0, "w": 1080, "h": 1920},
            1080, 1920, 1080, 1920, face_expanded=False))
        filt = render.single_crop_filter(
            "warm_cinematic", "9:16",
            {"x": 0, "y": 0, "w": 1080, "h": 1920}, 1080, 1920,
            face_expanded=False)
        self.assertEqual(
            filt, grade.get_filter("warm_cinematic", "9:16"))

    def test_portrait_zoom_filter_full_frame_for_width_spanning_face(self):
        # Same width-spanning subject: no zoom crop (it cut the face),
        # just the graded full-frame pass-through. (The pass-through
        # itself carries a no-op crop=1080:1920, which cuts nothing.)
        filt = render.single_crop_filter(
            "warm_cinematic", "9:16",
            {"x": 0, "y": 867, "w": 1053, "h": 1053}, 1080, 1920)
        self.assertNotIn("crop=818:1456", filt)
        self.assertEqual(
            filt, grade.get_filter("warm_cinematic", "9:16"))

    def test_portrait_manual_roi_skips_unexpand(self):
        # Manual ROIs are already tight: no detector-context inversion.
        filt = render.single_crop_filter(
            "warm_cinematic", "9:16",
            {"x": 700, "y": 1300, "w": 300, "h": 400},
            1080, 1920, face_expanded=False)
        self.assertIn("crop=", filt)
        self.assertIn("scale=1080:1920", filt)

    def test_resolve_auto_portrait_routes(self):
        real_detect = render.detect_face_roi
        try:
            # Dominant portrait face (53%) -> zoom single with pixels.
            render.detect_face_roi = lambda *a, **k: (  # noqa: E731
                {"x": 0, "y": 867, "w": 1053, "h": 1053},
                "face:auto detected (x=0,y=867,w=1053,h=1053)")
            layout, found, note = render.resolve_auto_layout(
                "in.mp4", "auto", src_w=1080, src_h=1920)
            self.assertEqual(layout, "single")
            self.assertIsNotNone(found)
            self.assertIn("face-centered single", note)
            # Tiny portrait face (0.5%) -> untouched single, no pixels.
            render.detect_face_roi = lambda *a, **k: (  # noqa: E731
                {"x": 866, "y": 756, "w": 100, "h": 100},
                "face:auto detected (x=866,y=756,w=100,h=100)")
            layout, found, _note = render.resolve_auto_layout(
                "in.mp4", "auto", src_w=1080, src_h=1920)
            self.assertEqual(layout, "single")
            self.assertIsNone(found)
            # Landscape corner cam still splits.
            render.detect_face_roi = lambda *a, **k: (  # noqa: E731
                {"x": 1532, "y": 679, "w": 194, "h": 194},
                "face:auto detected (x=1532,y=679,w=194,h=194)")
            layout, found, _note = render.resolve_auto_layout(
                "in.mp4", "auto", src_w=1920, src_h=1080)
            self.assertEqual(layout, "screen-top")
            self.assertIsNotNone(found)
        finally:
            render.detect_face_roi = real_detect


if __name__ == "__main__":
    unittest.main()
