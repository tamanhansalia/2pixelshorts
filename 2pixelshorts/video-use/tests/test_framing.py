"""Framing regressions, including a real FFmpeg pixel/timing check."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "helpers"))
import framing
import render


def samples(faces, step=.5, cam=None):
    return [{"t": i * step, "faces": [face] if face else [],
             "cams": [cam] if face else [], "face": face} for i, face in enumerate(faces)]


class FramingTests(unittest.TestCase):
    def test_all_four_corner_cameras_are_recognized(self):
        for face in ([100, 70, 100, 130], [1700, 70, 100, 130],
                     [100, 800, 100, 130], [1700, 800, 100, 130]):
            self.assertTrue(framing.corner_face(face, 1920, 1080))
            self.assertEqual(framing.layout_for_face(face, 1920, 1080, "auto", "9:16"), "screen-top")

    def test_talking_head_does_not_split_just_because_face_area_is_small(self):
        # The old area-only rule split this normal full-screen speaker.
        face = [750, 180, 260, 310]
        self.assertEqual(framing.layout_for_face(face, 1920, 1080, "auto", "9:16"), "single")

    def test_persistent_corner_cam_wins_over_a_large_face_on_shared_screen(self):
        cam, photo = [1600, 780, 110, 140], [600, 100, 450, 500]
        self.assertEqual(framing.choose_face([photo, cam], cam, 1920, 1080), cam)

    def test_no_detection_fits_full_source_in_every_mode(self):
        for mode in ("auto", "single", "screen-top", "face-top", "face-only"):
            self.assertEqual(framing.layout_for_face(None, 1920, 1080, mode, "9:16"), "fit")

    def test_brief_dropout_does_not_switch_layout(self):
        face = [1600, 780, 110, 140]
        output = framing.stabilize_samples(samples([face, face, None, None, face]), 1920, 1080, "auto", "9:16")
        self.assertEqual({s["layout"] for s in output}, {"screen-top"})
        self.assertTrue(output[2]["held"])

    def test_confirmed_webcam_borders_prevent_pose_dropouts_from_shrinking_face(self):
        face = [1600, 780, 110, 140]
        source = samples([face, face] + [None]*10 + [face, face])
        for sample in source:
            sample["camera_present"] = True
        output = framing.stabilize_samples(source, 1920, 1080, "auto", "9:16")
        self.assertEqual({s["layout"] for s in output}, {"screen-top"})

    def test_transient_false_positive_cannot_become_a_held_camera(self):
        face = [1600, 780, 110, 140]
        output = framing.stabilize_samples(samples([None, face, None, None, None]), 1920, 1080, "auto", "9:16")
        self.assertEqual({s["layout"] for s in output}, {"fit"})

    def test_sustained_change_starts_at_first_evidence(self):
        cam, speaker = [1600, 780, 110, 140], [650, 120, 300, 400]
        shots = framing.plan_from_samples(samples([cam, cam, cam, speaker, speaker, speaker]), 100, 103, 1920, 1080, "auto", "9:16")
        self.assertEqual([s["layout"] for s in shots], ["screen-top", "single"])
        self.assertEqual(shots[1]["start"], 101.5)

    def test_hard_scene_cut_clears_previous_face_hold(self):
        cam = [1600, 780, 110, 140]
        source = samples([cam, cam, cam, None, None, None])
        source[3]["scene_cut"] = True
        shots = framing.plan_from_samples(source, 0, 3, 1920, 1080, "auto", "9:16")
        self.assertEqual(shots[-1]["start"], 1.5)
        self.assertEqual(shots[-1]["layout"], "fit")

    def test_camera_moving_to_another_corner_gets_its_own_region(self):
        right, left = [1600, 780, 110, 140], [120, 780, 110, 140]
        shots = framing.plan_from_samples(samples([right]*3 + [left]*3), 0, 3, 1920, 1080, "auto", "9:16")
        self.assertEqual(len(shots), 2)
        self.assertGreater(shots[0]["cam"][0], 1200)
        self.assertLess(shots[1]["cam"][0], 300)

    def test_video_only_caption_timeline_does_not_consume_audio_crossfade(self):
        words = [{"word": "hello", "start": 90, "end": 90.5}]
        segments = [{"start": 10, "end": 12}, {"start": 90, "end": 92}]
        retimed = render.retime_words_for_edl(words, segments, has_audio=False)
        self.assertEqual(retimed[0]["start"], 2.)

    def test_analysis_uses_selected_edl_times_and_resets_between_windows(self):
        segments = [{"start": 12., "end": 14.}, {"start": 900., "end": 902.}]
        fake = types.SimpleNamespace(FaceDetectorYN=types.SimpleNamespace(create=lambda *a: object()))
        with patch.dict(sys.modules, cv2=fake), patch.object(framing, "read_samples", return_value=[]) as read:
            plan = framing.analyze("long-stream.mp4", segments, 1920, 1080, log=lambda _: None)
        self.assertEqual([(c.args[1], c.args[2]) for c in read.call_args_list], [(12., 14.), (900., 902.)])
        self.assertEqual([s["segment"] for s in plan["shots"]], [0, 1])

    def test_missing_detector_preserves_full_frame_and_explains_setup(self):
        with patch.dict(sys.modules, cv2=None):
            plan = framing.analyze("source.mp4", [{"start": 50, "end": 52}], 1920, 1080, log=lambda _: None)
        self.assertEqual(plan["shots"][0]["layout"], "fit")
        self.assertIn("setup_framing", plan["warnings"][0])

    def test_moving_speaker_crop_contains_hair_ears_and_chin(self):
        faces = [[x, 200, 150, 210] for x in (500, 620, 740, 860, 1000, 1150)]
        shot = framing.plan_from_samples(samples(faces), 0, 3, 1920, 1080, "single", "9:16")[0]
        cw, ch, path = framing.focus_crop(shot, 1920, 1080, 1080, 1920)
        for (_, x, y), face in zip(path, faces):
            self.assertTrue(framing.contains([x, y, cw, ch], framing.safe_head(face, 1920, 1080)))
        self.assertGreater(path[-1][1], path[0][1])

    def test_spanning_closeup_fits_instead_of_amputating_sides(self):
        face = [0, 800, 1080, 900]
        shot = framing.plan_from_samples(samples([face, face]), 0, 1, 1080, 1920, "single", "9:16")[0]
        crop = framing.focus_crop(shot, 1080, 1920, 1080, 1920)
        self.assertTrue(crop is None or crop[:2] == (1080, 1920))

    def test_portrait_does_not_become_a_corner_stack(self):
        self.assertEqual(framing.layout_for_face([750, 1300, 170, 220], 1080, 1920, "auto", "9:16"), "preserve")

    def test_portrait_tracks_large_lower_facecam_instead_of_tiny_screen_copy(self):
        tiny, card = [900, 790, 60, 75], [400, 1300, 210, 290]
        self.assertEqual(framing.choose_face([tiny, card], tiny, 1080, 1920), card)

    def test_auto_preserves_portrait_without_face_or_detector_in_every_aspect(self):
        for aspect in ("9:16", "1:1", "16:9"):
            with patch.dict(sys.modules, cv2=None):
                plan = framing.analyze("portrait.mp4", [{"start": 0, "end": 2}],
                                       1080, 1920, aspect=aspect, log=lambda _: None)
            self.assertEqual(plan["shots"][0]["layout"], "preserve")

    def test_preserved_layout_ignores_padded_inset_and_keeps_every_source_pixel(self):
        source = samples([[400, 1300, 210, 290]]*4)
        for s in source:
            s["content"] = [100, 160, 880, 1500]
            s["stacked_seam"] = 1152
        shot = framing.plan_from_samples(source, 0, 2, 1080, 1920, "auto", "9:16")[0]
        self.assertNotIn("content", shot)
        self.assertEqual(shot["source_composition"], "screen-over-facecam")
        shot["segment"] = 0
        framing.video_graph({"source_size": [1080, 1920], "shots": [shot]},
                            [{"start": 0, "end": 2}], 1080, 1920)
        self.assertEqual(shot["crop"], [0, 0, 1080, 1920])
        self.assertEqual(shot["source_seam"], 1152)

    def test_preserved_caption_seam_accounts_for_fitted_output_padding(self):
        source = samples([[180, 430, 100, 100]]*4)
        for s in source:
            s["stacked_seam"] = 384
        shot = framing.plan_from_samples(source, 0, 2, 480, 640, "auto", "9:16")[0]
        shot["segment"] = 0
        graph, _ = framing.video_graph({"source_size": [480, 640], "shots": [shot]},
                                      [{"start": 0, "end": 2}], 1080, 1920)
        self.assertEqual(shot["crop"], [0, 0, 480, 640])
        self.assertNotIn("vstack", graph)
        self.assertEqual(shot["caption_y"], 240 + 864 - 64)

    def test_explicit_portrait_face_only_still_reframes(self):
        face = [400, 1300, 210, 290]
        self.assertEqual(framing.layout_for_face(face, 1080, 1920, "face-only", "9:16"), "face-only")

    def test_unstable_portrait_seam_is_not_used_for_captions(self):
        source = samples([[400, 1300, 210, 290]]*6)
        for i, s in enumerate(source):
            s["stacked_seam"] = 800 if i % 2 else 1152
        shots = framing.plan_from_samples(source, 0, 3, 1080, 1920, "auto", "9:16")
        self.assertEqual(len(shots), 1)
        self.assertNotIn("source_seam", shots[0])

    def test_persistent_portrait_card_change_updates_caption_boundary(self):
        source = samples([[400, 1400, 210, 290]]*6)
        for i, s in enumerate(source):
            s["stacked_seam"] = 1152 if i < 3 else 1344
        shots = framing.plan_from_samples(source, 0, 3, 1080, 1920, "auto", "9:16")
        self.assertEqual([s["source_seam"] for s in shots], [1152, 1344])
        self.assertEqual(shots[1]["start"], 1.5)

    def test_card_boundary_detection_prefers_facecam_edge_over_browser_toolbar(self):
        try:
            import numpy as np
        except ImportError:
            self.skipTest("numpy required for image-boundary test")
        frame = np.zeros((640, 360, 3), dtype=np.uint8)
        frame[240:360] = 255  # A much stronger edge in the screen.
        frame[448:] = 90  # The actual lower camera card.
        self.assertAlmostEqual(framing.stacked_facecam_boundary(frame, [[140, 430, 80, 100]]), 448, delta=2)
        self.assertIsNone(framing.stacked_facecam_boundary(np.zeros_like(frame), [[140, 430, 80, 100]]))

    def test_large_padded_speaker_inset_is_not_a_corner_webcam(self):
        face = [450, 250, 250, 240]
        content = [114, 172, 1172, 746]
        self.assertEqual(framing.layout_for_face(face, 1920, 1080, "auto", "9:16", content), "single")

    def test_long_moving_camera_path_is_bounded_for_ffmpeg_parser(self):
        faces = [[500+i*3, 200, 150, 210] for i in range(100)]
        shot = framing.plan_from_samples(samples(faces), 0, 50, 1920, 1080, "single", "9:16")[0]
        crop = framing.focus_crop(shot, 1920, 1080, 1080, 1920)
        self.assertIsNotNone(crop)
        self.assertLessEqual(len(crop[2]), 40)

    def test_small_camera_envelope_rounds_outward_to_preserve_chin(self):
        face = [530.9587, 278.5905, 41.6798, 49.1962]
        shot = {"start": 0, "end": 1, "segment": 0, "layout": "screen-top",
                "cam": [482, 220, 142, 106], "samples": samples([face, face])}
        plan = {"source_size": [640, 360], "shots": [shot]}
        framing.video_graph(plan, [{"start": 0, "end": 1}], 1080, 1920)
        self.assertEqual(framing.face_retention(plan)["minimum_visible_face_retention"], 1.)

    def test_missing_source_head_is_separate_from_output_crop_loss(self):
        face = [400, 90, 230, 280]
        shot = {"start": 0, "end": 1, "segment": 0, "layout": "fit",
                "content": [114, 172, 1172, 744], "crop": [114, 172, 1172, 744],
                "samples": samples([face, face])}
        result = framing.face_retention({"source_size": [1920, 1080], "shots": [shot]})
        self.assertEqual(result["minimum_visible_face_retention"], 1.)
        self.assertEqual(result["source_face_clipped_samples"], 2)

    def test_split_captions_stay_at_seam_after_word_style_reset(self):
        plan = {"canvas": [1080, 1920], "shots": [{"output_start": 0, "output_end": 2,
                 "caption_y": 1088, "caption_alignment": 2}]}
        text = "Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,{\\1c&HFFFF&}hello{\\r} world\n"
        placed = framing.place_captions(text, plan)
        self.assertEqual(placed.count(r"\pos(540,1088)"), 2)
        self.assertEqual(framing.place_captions(text, plan, "top"), text)

    def test_crossfade_video_cut_and_caption_timeline_agree(self):
        segs = [{"start": 10, "end": 12}, {"start": 90, "end": 92}]
        shots = [{"start": s["start"], "end": s["end"], "segment": i, "layout": "fit", "samples": []} for i, s in enumerate(segs)]
        plan = {"source_size": [1920, 1080], "shots": shots}
        graph, _ = framing.video_graph(plan, segs, 1080, 1920, True)
        self.assertIn("end=11.970000", graph)
        self.assertAlmostEqual(shots[1]["output_start"], 1.97)
        self.assertAlmostEqual(shots[1]["output_end"], render.edl_output_seconds(segs))


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "requires FFmpeg")
class FramingRenderTests(unittest.TestCase):
    def test_already_composed_portrait_preserves_screen_and_camera_at_different_aspect(self):
        with tempfile.TemporaryDirectory(prefix="preframed_test_") as directory:
            source, output = [os.path.join(directory, n) for n in ("source.mp4", "short.mp4")]
            subprocess.run([
                "ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
                "color=green:s=480x640:d=2:r=20,drawbox=x=0:y=384:w=480:h=256:c=blue:t=fill,"
                "drawbox=x=180:y=430:w=100:h=100:c=yellow:t=fill,"
                "drawbox=x=0:y=0:w=12:h=640:c=red:t=fill,drawbox=x=468:y=0:w=12:h=640:c=red:t=fill",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", source], check=True)
            source_samples = samples([[180, 430, 100, 100]]*4)
            for s in source_samples:
                s["stacked_seam"] = 384
                s["content"] = [0, 80, 480, 480]
            fake = types.SimpleNamespace(FaceDetectorYN=types.SimpleNamespace(create=lambda *a: object()))
            with patch.dict(sys.modules, cv2=fake), patch.object(framing, "read_samples", return_value=source_samples):
                render.render_edl(source, output, [{"start": 0, "end": 2}],
                                  preset_id="subtle", layout="auto", subtitle_style="pop",
                                  subtitle_position="bottom", words=[
                                      {"word": "SAFE", "start": .2, "end": .8},
                                      {"word": "CAPTIONS", "start": .8, "end": 1.5}],
                                  log=lambda _: None)
            pixels = subprocess.check_output(["ffmpeg", "-v", "error", "-ss", "0.5", "-i", output,
                "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
            # Both screen edges survive, the lower camera is still blue,
            # and the face marker keeps its original square proportions.
            def pixel(x, y):
                i = (y*1080+x)*3
                return pixels[i:i+3]
            self.assertGreater(pixel(10, 500)[0], 200)
            self.assertGreater(pixel(1070, 500)[0], 200)
            self.assertGreater(pixel(100, 1300)[2], 200)
            self.assertGreater(pixel(520, 1280)[0], 190)
            self.assertGreater(pixel(520, 1280)[1], 190)
            white = [(x, y) for y in range(800, 1900, 4) for x in range(80, 1000, 4)
                     if min(pixel(x, y)) > 210]
            self.assertTrue(white, "caption text was not rendered")
            self.assertLess(max(y for _, y in white), 1104, "captions cover the existing facecam panel")
            with open(os.path.splitext(output)[0]+".framing.json") as fh:
                report = json.load(fh)
            self.assertEqual(report["shots"][0]["layout"], "preserve")
            self.assertEqual(report["shots"][0]["caption_y"], 1040)
            self.assertTrue(report["validation"]["passed"])

    def test_render_preserves_entire_camera_face_and_exact_edl_duration(self):
        with tempfile.TemporaryDirectory(prefix="framing_test_") as directory:
            source, output = [os.path.join(directory, n) for n in ("source.mp4", "short.mp4")]
            subprocess.run([
                "ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
                "color=black:s=640x360:d=4:r=20,drawbox=x=480:y=210:w=140:h=140:c=red:t=fill,drawbox=x=525:y=250:w=45:h=55:c=yellow:t=fill",
                "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source], check=True)
            segments = [{"start": 1., "end": 2.}, {"start": 2.5, "end": 3.7}]
            def known_plan(_path, spans, width, height, *args):
                shots = []
                for i, span in enumerate(spans):
                    ss = samples([[525, 250, 45, 55]]*3, cam=[480, 210, 140, 140])
                    planned = framing.plan_from_samples(ss, span["start"], span["end"], width, height, "auto", "9:16", [480, 210, 140, 140])
                    for shot in planned:
                        shot["segment"] = i
                    shots.extend(planned)
                return {"source_size": [width, height], "shots": shots}
            with patch.object(framing, "analyze", side_effect=known_plan):
                render.render_edl(source, output, segments, preset_id="subtle", log=lambda _: None)
            info = render.probe_media(output)
            self.assertEqual((info["width"], info["height"]), (1080, 1920))
            self.assertAlmostEqual(info["duration"], 2.17, delta=.06)
            self.assertTrue(info["has_audio"])
            pixels = subprocess.check_output(["ffmpeg", "-v", "error", "-ss", "0.5", "-i", output,
                                               "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
            # Locate the yellow 'face' in the webcam panel. A cover crop of
            # the tight face would clip it at the panel edges or distort it.
            points = [(x, y) for y in range(1152, 1920, 3) for x in range(0, 1080, 3)
                      if pixels[(y*1080+x)*3] > 190 and pixels[(y*1080+x)*3+1] > 190
                      and pixels[(y*1080+x)*3+2] < 70]
            self.assertTrue(points)
            xs, ys = zip(*points)
            self.assertGreater(min(ys), 1152)
            self.assertLess(max(ys), 1900)
            self.assertAlmostEqual((max(xs)-min(xs))/(max(ys)-min(ys)), 45/55, delta=.06)
            with open(os.path.splitext(output)[0] + ".framing.json") as handle:
                self.assertTrue(json.load(handle)["validation"]["passed"])


if __name__ == "__main__":
    unittest.main()
