import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildQuickSchedulePayload,
  clearCompletedItems,
  filterQueueItems,
  findQueueItemByVideoPath,
  formatRelease,
  formatScheduledLabel,
  isQueueItemOverdue,
  isVideoPathQueued,
  newScheduleItem,
  parseTagList,
  quickScheduleBlocker,
  recoverStuckPublishing,
  removeQueueItem,
  selectableShorts,
  sortQueueBySchedule,
  splitSchedule,
  toPublishPayload,
  type QuickScheduleInput,
} from "./outbox.ts";
import type { ScheduleItem } from "../types/index.ts";

function input(over: Partial<QuickScheduleInput> = {}): QuickScheduleInput {
  return {
    videoPath: "final_short.mp4",
    title: "This New Rust Tool Feels Like Cheating",
    description: "Processed with 2PixelShorts.",
    tagsText: "rust, shorts, coding",
    scheduledDate: "2026-10-10",
    scheduledTime: "18:00",
    timezone: "Asia/Kolkata",
    ...over,
  };
}

describe("quick schedule", () => {
  it("parses tags, trimming hashes and deduping", () => {
    assert.deepEqual(parseTagList("rust, #shorts, coding, Rust, ,"), [
      "rust",
      "shorts",
      "coding",
    ]);
    assert.deepEqual(parseTagList(""), []);
  });

  it("builds a queued payload with combined schedule time", () => {
    const payload = buildQuickSchedulePayload(input());
    assert.equal(payload.title, "This New Rust Tool Feels Like Cheating");
    assert.equal(payload.video_path, "final_short.mp4");
    assert.equal(payload.publish_now, false);
    assert.deepEqual(payload.platforms, []);
    assert.equal(payload.scheduled_for, "2026-10-10T18:00:00");
    assert.equal(payload.timezone, "Asia/Kolkata");
    assert.deepEqual(payload.tags, ["rust", "shorts", "coding"]);
  });

  it("trims and caps the title at 100 chars", () => {
    const payload = buildQuickSchedulePayload(
      input({ title: `  ${"x".repeat(150)}  ` }),
    );
    assert.equal(payload.title.length, 100);
  });

  it("blocks scheduling until video, title, and date exist", () => {
    assert.equal(
      quickScheduleBlocker(input({ videoPath: "  " })),
      "Pick a video file first.",
    );
    assert.equal(
      quickScheduleBlocker(input({ title: "  " })),
      "Analyze the video (or type a title) first.",
    );
    assert.equal(
      quickScheduleBlocker(input({ scheduledDate: "" })),
      "Pick a release date first.",
    );
    assert.equal(quickScheduleBlocker(input()), null);
  });
});

describe("schedule parse/format", () => {
  it("splits ISO variants with seconds and Z/offset suffixes", () => {
    assert.deepEqual(splitSchedule("2026-10-10T18:00"), {
      date: "2026-10-10",
      time: "18:00",
    });
    assert.deepEqual(splitSchedule("2026-10-10T18:30:00Z"), {
      date: "2026-10-10",
      time: "18:30",
    });
    assert.deepEqual(splitSchedule("2026-10-10T18:30:00.000Z"), {
      date: "2026-10-10",
      time: "18:30",
    });
    assert.deepEqual(splitSchedule("2026-10-10 09:15:00+05:30"), {
      date: "2026-10-10",
      time: "09:15",
    });
  });

  it("keeps date-only input with the default time, blanks garbage", () => {
    assert.deepEqual(splitSchedule("2026-10-10"), {
      date: "2026-10-10",
      time: "18:00",
    });
    for (const bad of ["", "  ", "garbage", "10/10/2026", undefined, null]) {
      assert.deepEqual(splitSchedule(bad), { date: "", time: "18:00" });
    }
  });

  it("never renders Invalid Date", () => {
    assert.deepEqual(formatRelease("garbage"), { day: "garbage", time: "" });
    assert.equal(formatScheduledLabel("garbage"), "garbage");
    assert.equal(formatScheduledLabel(""), "unknown time");
    assert.equal(formatScheduledLabel(undefined), "unknown time");
    const valid = "2026-10-10T18:00:00";
    assert.equal(
      formatScheduledLabel(valid),
      new Date(valid).toLocaleString(),
    );
    assert.ok(!formatScheduledLabel(valid).includes("Invalid"));
  });
});

describe("selectableShorts", () => {
  it("lists queue entries first and skips a render of the same file", () => {
    const shorts = selectableShorts(
      [
        {
          id: "job-1",
          title: "Queued hook",
          description: "From the queue",
          tags: ["rust"],
          video_path: "/out/same.mp4",
        },
      ],
      [
        {
          id: "render-same",
          outputVideo: "/out/same.mp4",
          status: "completed",
          seo: { title: "Should not win", description: "", tags: [] },
        },
        {
          id: "render-new",
          outputVideo: "/out/fresh.mp4",
          status: "completed",
          seo: {
            title: "Fresh short",
            description: "Analyzed",
            tags: ["clip"],
          },
        },
        {
          id: "render-running",
          outputVideo: "/out/still-going.mp4",
          status: "running",
        },
      ],
    );
    assert.deepEqual(
      shorts.map((s) => [s.source, s.videoPath, s.title]),
      [
        ["queue", "/out/same.mp4", "Queued hook"],
        ["render", "/out/fresh.mp4", "Fresh short"],
      ],
    );
    assert.deepEqual(shorts[1]?.tags, ["clip"]);
  });

  it("uses the file name when a finished render has no title", () => {
    const shorts = selectableShorts(
      [],
      [
        {
          id: "render-bare",
          outputVideo: "/out/final_short.mp4",
          status: "completed",
        },
      ],
    );
    assert.equal(shorts.length, 1);
    assert.equal(shorts[0]?.title, "final short");
    assert.equal(shorts[0]?.source, "render");
  });
});

describe("sortQueueBySchedule", () => {
  function row(id: string, scheduled_for: string) {
    return { id, scheduled_for };
  }

  it("orders entries oldest release first", () => {
    const items = [
      row("c", "2026-10-12T18:00:00"),
      row("a", "2026-10-10T09:00:00"),
      row("b", "2026-10-11T18:00:00"),
    ];
    assert.deepEqual(
      sortQueueBySchedule(items).map((i) => i.id),
      ["a", "b", "c"],
    );
  });

  it("sorts invalid dates last without mutating the input", () => {
    const items = [row("bad", "not-a-date"), row("ok", "2026-10-10T18:00:00")];
    const sorted = sortQueueBySchedule(items);
    assert.deepEqual(
      sorted.map((i) => i.id),
      ["ok", "bad"],
    );
    assert.deepEqual(
      items.map((i) => i.id),
      ["bad", "ok"],
    );
  });
});

describe("isQueueItemOverdue", () => {
  const now = new Date("2026-10-11T12:00:00Z").getTime();

  it("flags queued entries with a past release slot", () => {
    assert.equal(
      isQueueItemOverdue(
        { status: "queued", scheduled_for: "2026-10-10T18:00:00Z" },
        now,
      ),
      true,
    );
    assert.equal(
      isQueueItemOverdue(
        { status: "queued", scheduled_for: "2026-10-12T18:00:00Z" },
        now,
      ),
      false,
    );
  });

  it("never flags non-queued statuses or invalid dates", () => {
    for (const status of ["publishing", "completed", "failed"] as const) {
      assert.equal(
        isQueueItemOverdue(
          { status, scheduled_for: "2026-10-10T18:00:00Z" },
          now,
        ),
        false,
      );
    }
    assert.equal(
      isQueueItemOverdue({ status: "queued", scheduled_for: "garbage" }, now),
      false,
    );
  });
});

describe("removeQueueItem", () => {
  function entry(
    id: string,
    status: ScheduleItem["status"] = "queued",
  ): ScheduleItem {
    return {
      id,
      title: `Post ${id}`,
      video_path: `${id}.mp4`,
      platforms: ["youtube"],
      scheduled_for: "2026-10-10T18:00:00",
      timezone: "UTC",
      status,
      created_at: "2026-10-01T00:00:00.000Z",
    };
  }

  it("removes the targeted entry and keeps the rest in order", () => {
    const items = [entry("a"), entry("b"), entry("c")];
    assert.deepEqual(
      removeQueueItem(items, "b").map((i) => i.id),
      ["a", "c"],
    );
  });

  it("removes entries regardless of status", () => {
    const items = [
      entry("q", "queued"),
      entry("p", "publishing"),
      entry("d", "completed"),
      entry("f", "failed"),
    ];
    for (const target of ["q", "p", "d", "f"]) {
      const next = removeQueueItem(items, target);
      assert.equal(next.length, 3);
      assert.ok(next.every((i) => i.id !== target));
    }
  });

  it("leaves the queue untouched for an unknown id", () => {
    const items = [entry("a"), entry("b")];
    assert.deepEqual(removeQueueItem(items, "missing"), items);
  });
});

describe("recoverStuckPublishing", () => {
  function entry(
    id: string,
    status: ScheduleItem["status"],
  ): ScheduleItem {
    return {
      id,
      title: `Post ${id}`,
      video_path: `${id}.mp4`,
      platforms: ["youtube"],
      scheduled_for: "2026-10-10T18:00:00",
      timezone: "UTC",
      status,
      created_at: "2026-10-01T00:00:00.000Z",
      error: null,
    };
  }

  it("returns stranded publishing rows to queued with an explanation", () => {
    const stuck = entry("p", "publishing");
    const next = recoverStuckPublishing([stuck]);
    assert.equal(next.length, 1);
    assert.equal(next[0]?.status, "queued");
    assert.ok((next[0]?.error ?? "").length > 0);
    // Untouched fields survive the reset.
    assert.equal(next[0]?.id, "p");
    assert.equal(next[0]?.video_path, "p.mp4");
    assert.deepEqual(next[0]?.platforms, ["youtube"]);
  });

  it("leaves settled rows untouched", () => {
    const items = [
      entry("q", "queued"),
      entry("d", "completed"),
      entry("f", "failed"),
    ];
    const next = recoverStuckPublishing(items);
    assert.deepEqual(
      next.map((i) => [i.id, i.status, i.error]),
      [
        ["q", "queued", null],
        ["d", "completed", null],
        ["f", "failed", null],
      ],
    );
  });

  it("never mutates the input and handles an empty queue", () => {
    const items = [entry("p", "publishing")];
    const snapshot = structuredClone(items);
    recoverStuckPublishing(items);
    assert.deepEqual(items, snapshot);
    assert.deepEqual(recoverStuckPublishing([]), []);
  });
});

describe("dispatch payload", () => {
  it("reuses the queue entry id as idempotency key", () => {
    const entry = newScheduleItem({
      title: "Launch",
      description: "Desc",
      platforms: ["youtube"],
      video_path: "final_short.mp4",
      publish_now: true,
      scheduled_for: undefined,
      timezone: "UTC",
      account_ids: ["acc_1"],
      tags: ["shorts"],
    });
    const payload = toPublishPayload(entry);
    assert.equal(payload.publish_now, true);
    assert.equal(payload.idempotency_key, entry.id);
    assert.deepEqual(payload.platforms, ["youtube"]);
    assert.deepEqual(payload.account_ids, ["acc_1"]);
  });

  it("uses a fresh idempotency key after a failed attempt", () => {
    const entry = newScheduleItem({
      title: "Launch",
      description: "Desc",
      platforms: ["youtube"],
      video_path: "final_short.mp4",
      publish_now: true,
      timezone: "UTC",
    });
    const failed = { ...entry, status: "failed" as const, error: "no" };
    const payload = toPublishPayload(failed);
    assert.ok(payload.idempotency_key?.startsWith(`${entry.id}:retry:`));
    assert.notEqual(payload.idempotency_key, entry.id);
  });
});

describe("queue hygiene", () => {
  function item(
    id: string,
    over: Partial<ScheduleItem> = {},
  ): ScheduleItem {
    return {
      id,
      title: `Post ${id}`,
      video_path: `${id}.mp4`,
      platforms: [],
      scheduled_for: "2026-10-10T18:00:00",
      timezone: "UTC",
      status: "queued",
      created_at: "2026-10-01T00:00:00.000Z",
      ...over,
    };
  }

  it("finds queued video paths on the trimmed path", () => {
    const items = [item("a", { video_path: "  /out/same.mp4 " })];
    assert.equal(findQueueItemByVideoPath(items, "/out/same.mp4")?.id, "a");
    assert.equal(isVideoPathQueued(items, " /out/same.mp4 "), true);
    assert.equal(isVideoPathQueued(items, "/out/other.mp4"), false);
    assert.equal(findQueueItemByVideoPath(items, "  "), undefined);
    assert.equal(isVideoPathQueued(items, ""), false);
  });

  it("clears only completed entries, keeping order", () => {
    const items = [
      item("a", { status: "queued" }),
      item("b", { status: "completed" }),
      item("c", { status: "failed" }),
      item("d", { status: "completed" }),
    ];
    const snapshot = structuredClone(items);
    assert.deepEqual(
      clearCompletedItems(items).map((i) => i.id),
      ["a", "c"],
    );
    assert.deepEqual(items, snapshot);
    assert.deepEqual(clearCompletedItems([]), []);
  });

  it("filters by status and title/path search together", () => {
    const items = [
      item("a", { title: "Rust Hooks", video_path: "/out/rust.mp4" }),
      item("b", {
        title: "Cooking cut",
        video_path: "/out/RUST-broll.mp4",
        status: "failed",
      }),
      item("c", {
        title: "Rust finale",
        video_path: "/out/finale.mp4",
        status: "completed",
      }),
    ];
    assert.deepEqual(
      filterQueueItems(items, { status: "failed" }).map((i) => i.id),
      ["b"],
    );
    assert.deepEqual(
      filterQueueItems(items, { query: "rust" }).map((i) => i.id),
      ["a", "b", "c"],
    );
    assert.deepEqual(
      filterQueueItems(items, { status: "queued", query: "finale" }),
      [],
    );
    assert.deepEqual(
      filterQueueItems(items, { status: "completed", query: "FINALE" }).map(
        (i) => i.id,
      ),
      ["c"],
    );
    assert.deepEqual(
      filterQueueItems(items).map((i) => i.id),
      ["a", "b", "c"],
    );
  });
});
