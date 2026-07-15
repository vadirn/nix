// textkit's degrade handlers: the shared llm `makeRethrowIfBug` bound to each caller's
// log prefix, in one place so every tool's stderr names itself rather than borrowing
// another's. A tool-specific module imports its handler aliased to `rethrowIfBug`; the
// shared writing-core uses `writingDegrade` because both distill and polish invoke it,
// so naming either CLI there would be wrong half the time.
import { makeRethrowIfBug } from "@shared/llm/llm.ts";

export const distillDegrade = makeRethrowIfBug("distill");
export const polishDegrade = makeRethrowIfBug("polish");
export const cardStageDegrade = makeRethrowIfBug("card-stage");
export const writingDegrade = makeRethrowIfBug("writing");
export const g4Degrade = makeRethrowIfBug("g4-harness");
