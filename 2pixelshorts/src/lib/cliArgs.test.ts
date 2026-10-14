import { it } from "node:test";
import assert from "node:assert/strict";
import { parseCliArguments } from "./cliArgs.ts";

it("preserves quoted code, empty arguments and Windows paths", () => {
  assert.deepEqual(parseCliArguments('-c "print(\'hello world\')" "" "C:\\My Videos\\clip.mp4"'), ["-c", "print('hello world')", "", "C:\\My Videos\\clip.mp4"]);
});
it("keeps shell syntax as inert arguments", () => {
  assert.deepEqual(parseCliArguments("--title '$(touch /tmp/never)' ; rm -rf /"), ["--title", "$(touch /tmp/never)", ";", "rm", "-rf", "/"]);
});
it("rejects unterminated quotes", () => {
  assert.throws(() => parseCliArguments('--title "unfinished'), /Close/);
});
