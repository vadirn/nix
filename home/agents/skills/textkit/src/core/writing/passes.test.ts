// writing/passes tests — makeIdMarkerStripper's marker-conditional trim: a
// marker-free candidate returns byte-identical (nested-list and code-block
// indentation preserved); a stripped marker still trims the slack it leaves.
import { expect, test } from "bun:test";
import { makeIdMarkerStripper } from "textkit/core/writing/passes.ts";

test("makeIdMarkerStripper: a marker-free candidate returns byte-identical (keeps indentation)", () => {
  const strip = makeIdMarkerStripper([{ id: "B1" }]);
  const code = "    indented code line one\n    indented code line two";
  expect(strip(code)).toBe(code);
  const nested = "  - child one\n  - child two";
  expect(strip(nested)).toBe(nested);
});

test("makeIdMarkerStripper: a stripped marker still trims the slack it leaves", () => {
  const strip = makeIdMarkerStripper([{ id: "B1" }, { id: "B2" }]);
  expect(strip("[B1] The text.")).toBe("The text.");
  expect(strip(" [B2]The text. ")).toBe("The text.");
  expect(strip("Mid-sentence [B1] echo survives content.")).toBe(
    "Mid-sentence echo survives content.",
  );
});
