// textkit's degrade handlers: the shared llm `makeRethrowIfBug` bound to each caller's
// log prefix, in one place so every tool's stderr names itself rather than borrowing
// another's. A tool-specific module imports its handler aliased to `rethrowIfBug`; the
// shared writing-core uses `writingDegrade` because it serves more than one tool, so
// naming a single CLI there would be wrong.
import { makeRethrowIfBug } from "@skills/llm/llm.ts";

export const distillDegrade = makeRethrowIfBug("distill");
export const cardStageDegrade = makeRethrowIfBug("card-stage");
export const simplifyDegrade = makeRethrowIfBug("simplify");
export const writingDegrade = makeRethrowIfBug("writing");
