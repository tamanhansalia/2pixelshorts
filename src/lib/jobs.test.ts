import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_CUT_AGENT_ID,
  autoCutProbe,
  cancelJob,
  getJobStatus,
  isTerminalJobStatus,
  listenRenderFinished,
  listenRenderProgress,
  needsAgentProbe,
  probeAgent,
  renderWarningsFor,
  seoAgentForPackage,
  startRenderJob,
} from "./jobs.ts";

const PARAMS = {
  input_video: "in.mp4",
  output_video: "out.mp4",
  preset_id: "warm_cinematic",
};

describe("browser preview cannot invent edits", () => {
  it("refuses rendering, metadata probing, and model availability", async () => {
    let progress = 0, finishes = 0;
    const offP = await listenRenderProgress(() => progress++);
    const offF = await listenRenderFinished(() => finishes++);
    await assert.rejects(() => startRenderJob(PARAMS), /desktop app/);
    await assert.rejects(() => getJobStatus("nope"), /No native render job/);
    await assert.rejects(() => cancelJob("nope"), /No native render job/);
    assert.equal(progress, 0);
    assert.equal(finishes, 0);
    assert.equal((await probeAgent("claude")).available, false);
    offP(); offF();
  });
});

describe("auto cut probe", () => {
  it("never needs a CLI probe and is always available", async () => {
    assert.equal(needsAgentProbe(AUTO_CUT_AGENT_ID), false);
    assert.equal(needsAgentProbe("claude"), true);
    const probe = autoCutProbe();
    assert.equal(probe.agent, AUTO_CUT_AGENT_ID);
    assert.equal(probe.available, true);
  });
});

describe("seo agent for the title package", () => {
  it("uses an installed CLI when the cut is Auto", () => {
    assert.equal(
      seoAgentForPackage(AUTO_CUT_AGENT_ID, {
        claude: { available: false },
        codex: { available: true },
      }),
      "codex",
    );
  });

  it("keeps a chosen CLI that is installed", () => {
    assert.equal(
      seoAgentForPackage("grok", {
        claude: { available: true },
        grok: { available: true },
      }),
      "grok",
    );
  });

  it("skips a chosen CLI that the probe rejected", () => {
    assert.equal(
      seoAgentForPackage("grok", {
        grok: { available: false },
        agy: { available: true },
      }),
      "agy",
    );
  });

  it("composes from the transcript when no CLI is installed", () => {
    assert.equal(
      seoAgentForPackage("auto", {
        claude: { available: false },
        codex: { available: false },
        agy: { available: false },
        grok: { available: false },
      }),
      undefined,
    );
  });

  it("tries Claude before the probe returns", () => {
    assert.equal(seoAgentForPackage("auto", {}), "claude");
  });
});

describe("renderWarningsFor", () => {
  const ok = (over: Record<string, unknown> = {}) => ({
    success: true,
    code: 0,
    stdout: "[COMPLETE] 9:16 Short rendered: out.mp4",
    stderr: "",
    fallback_used: false,
    ...over,
  });

  it("is silent for a clean render", () => {
    assert.deepEqual(renderWarningsFor(ok()), []);
  });

  it("flags the fallback render", () => {
    const [w] = renderWarningsFor(ok({ fallback_used: true }));
    assert.equal(w.kind, "fallback");
  });

  it("surfaces unavailable face tracking instead of calling it fully framed", () => {
    const [warning] = renderWarningsFor(ok({
      stdout: "[STAGE 1/4] Face detection unavailable; preserving the full source.",
    }));
    assert.equal(warning.kind, "framing");
    assert.match(warning.detail ?? "", /setup_framing/);
  });

  it("explains low resolution and missing source face pixels", () => {
    const warnings = renderWarningsFor(ok({
      stdout: "Low-resolution source (640x360)\nSource camera clips the face in part of this clip",
    }));
    assert.equal(warnings.length, 2);
    assert.ok(warnings.every((warning) => warning.kind === "framing"));
    assert.match(warnings[1].message, /original camera view/);
  });

  it("flags the missing transcript with the key location", () => {
    const [w] = renderWarningsFor(
      ok({ stderr: "transcribe.py: no API key, wrote placeholder word JSON" }),
    );
    assert.equal(w.kind, "transcript");
    assert.match(w.detail ?? "", /ElevenLabs Scribe/);
  });

  it("flags cloud and local transcription failures", () => {
    for (const stderr of [
      "transcribe.py: scribe request failed (network down); writing placeholder",
      "transcribe.py: local engine failed (faster-whisper is not installed); wrote placeholder",
      "[STAGE 2/4] No transcript words; rendering clean video",
    ]) {
      const [w] = renderWarningsFor(ok({ stderr }));
      assert.equal(w.kind, "transcript");
    }
  });

  it("surfaces the agent failure reason", () => {
    const [w] = renderWarningsFor(
      ok({
        stderr:
          "[STAGE 2/4] Agent cut failed (agent 'claude' timed out after 300s); using automatic cut",
      }),
    );
    assert.equal(w.kind, "agent");
    assert.match(w.detail ?? "", /timed out/);
  });

  it("keeps nested parentheses in the reason", () => {
    const [w] = renderWarningsFor(
      ok({
        stderr: "Agent cut failed (weekly limit resets 6:30pm (Asia/Calcutta))",
      }),
    );
    assert.match(w.detail ?? "", /Asia\/Calcutta/);
  });

  it("stays silent for failed renders and null", () => {
    assert.deepEqual(renderWarningsFor(ok({ success: false })), []);
    assert.deepEqual(renderWarningsFor(null), []);
  });
});

describe("isTerminalJobStatus", () => {
  it("classifies statuses", () => {
    assert.equal(isTerminalJobStatus("completed"), true);
    assert.equal(isTerminalJobStatus("failed"), true);
    assert.equal(isTerminalJobStatus("cancelled"), true);
    assert.equal(isTerminalJobStatus("queued"), false);
    assert.equal(isTerminalJobStatus("running"), false);
  });
});
