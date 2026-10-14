import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_CUT_AGENT_ID,
  __resetJobSimulationForTests,
  autoCutProbe,
  cancelJob,
  getJobStatus,
  isTerminalJobStatus,
  listenRenderFinished,
  listenRenderProgress,
  needsAgentProbe,
  probeAgent,
  renderWarningsFor,
  startRenderJob,
} from "./jobs.ts";

const PARAMS = {
  input_video: "in.mp4",
  output_video: "out.mp4",
  preset_id: "warm_cinematic",
};

function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out"));
      setTimeout(tick, 50);
    };
    tick();
  });
}

describe("render job simulation (browser fallback)", () => {
  it("streams progress to completion with a result", async () => {
    __resetJobSimulationForTests();
    const seen: number[] = [];
    let finished: unknown = null;
    const offP = await listenRenderProgress((p) => seen.push(p.progress));
    const offF = await listenRenderFinished((info) => {
      finished = info;
    });

    const id = await startRenderJob(PARAMS);
    assert.match(id, /^sim-job-/);
    await waitFor(() => finished !== null);

    const info = finished as { status: string; result: { success: boolean } };
    assert.equal(info.status, "completed");
    assert.equal(info.result.success, true);
    assert.ok(seen.length >= 3, `expected progress events, saw ${seen.length}`);
    assert.equal(seen[seen.length - 1], 1);

    const status = await getJobStatus(id);
    assert.equal(status.status, "completed");
    offP();
    offF();
    __resetJobSimulationForTests();
  });

  it("cancel stops the job and reports cancelled", async () => {
    __resetJobSimulationForTests();
    let finished: unknown = null;
    const offF = await listenRenderFinished((info) => {
      finished = info;
    });

    const id = await startRenderJob(PARAMS);
    const cancelled = await cancelJob(id);
    assert.equal(cancelled, true);
    await waitFor(() => finished !== null);

    const info = finished as { status: string; error: string };
    assert.equal(info.status, "cancelled");
    assert.match(info.error, /Cancelled/);
    // Second cancel is a no-op.
    assert.equal(await cancelJob(id), false);
    offF();
    __resetJobSimulationForTests();
  });

  it("unknown job id raises", async () => {
    __resetJobSimulationForTests();
    await assert.rejects(() => getJobStatus("nope"), /Unknown job id/);
  });
});

describe("probeAgent fallback", () => {
  it("reports simulated availability in the browser", async () => {
    const probe = await probeAgent("claude");
    assert.equal(probe.agent, "claude");
    assert.equal(probe.available, true);
    assert.equal(probe.note, "simulated");
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
