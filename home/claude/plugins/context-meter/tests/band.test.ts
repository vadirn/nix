import type { SessionCompactResult } from "claude-code";
import { expect, test } from "claude-code/testing";

const props = (isWorking: boolean) => ({
  hasSurvey: false,
  isWorking,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
});

const CASES = [
  { tokens: 84_000, percent: 8, color: "#6ba368" },
  { tokens: 250_000, percent: 25, color: "#e2a33a" },
  { tokens: 400_000, percent: 40, color: "#d2553f" },
] as const;

test("zone colour follows absolute tokens on desktop and terminal", async ($, on) => {
  on("session.measure", (_$, e) => ({ changed: e.changed }));

  for (const one of CASES) {
    await $.session.measure({
      context: { tokens: one.tokens, window: 1_000_000, percent: one.percent },
      rateLimits: [],
      changed: ["context"],
    });

    for (const surface of ["desktop", "terminal"] as const) {
      const ui = await $.ui.mount({
        plugin: "context-meter",
        surface,
        component: "AbovePrompt",
        props: props(false),
      });

      const label = await ui.find({ type: "Text", text: new RegExp(`^${one.percent}%$`) });
      expect(label?.props.color).toBe(one.color);
      const button = await ui.find({ key: "compact" });
      expect(button?.props.dimColor).toBe(false);

      const band = await ui.find({ type: "Box" });
      expect(band?.props.paddingLeft).toBe(surface === "desktop" ? 0.625 : 1);

      if (surface === "desktop") {
        const svg = await ui.find({ type: "Svg" });
        expect(String(svg?.props.source)).toContain(`fill="${one.color}"`);
      }

      await ui.unmount();
    }
  }
});

test("button stays, dimmed, while a turn runs", async ($, on) => {
  on("session.measure", (_$, e) => ({ changed: e.changed }));
  const runs: string[] = [];
  on("command.run", { command: "compact" }, (_$, e) => {
    runs.push(e.command);

    return { text: "Compacted" };
  });
  const toasts: string[] = [];
  on("ui.toast", (_$, e) => {
    toasts.push(e.text);

    return { value: undefined };
  });
  await $.session.measure({
    context: { tokens: 170_000, window: 1_000_000, percent: 17 },
    rateLimits: [],
    changed: ["context"],
  });

  for (const surface of ["desktop", "terminal"] as const) {
    const ui = await $.ui.mount({
      plugin: "context-meter",
      surface,
      component: "AbovePrompt",
      props: props(true),
    });

    expect((await ui.find({ key: "compact" }))?.props.dimColor).toBe(true);
    await ui.press({ key: "compact" });
    await ui.unmount();
  }

  // A mid-turn press explains instead of compacting.
  expect(runs).toEqual([]);
  expect(toasts).toEqual([
    "Compact runs between turns: press it when this one ends",
    "Compact runs between turns: press it when this one ends",
  ]);
});

test("press runs /compact as if typed", async ($, on) => {
  on("session.measure", (_$, e) => ({ changed: e.changed }));
  const runs: string[] = [];
  on("command.run", { command: "compact" }, (_$, e) => {
    runs.push(e.command);

    return { text: "Compacted" };
  });
  await $.session.measure({
    context: { tokens: 120_000, window: 1_000_000, percent: 12 },
    rateLimits: [],
    changed: ["context"],
  });

  const ui = await $.ui.mount({
    plugin: "context-meter",
    surface: "desktop",
    component: "AbovePrompt",
    props: props(false),
  });

  await ui.press({ key: "compact" });
  expect(runs).toEqual(["compact"]);
  await ui.unmount();
});

test("a main compaction shows Compacting…, then its sizes; others leave no note", async ($, on) => {
  on("session.measure", (_$, e) => ({ changed: e.changed }));

  const band = () =>
    $.ui.mount({
      plugin: "context-meter",
      surface: "desktop",
      component: "AbovePrompt",
      props: props(false),
    });
  const note = async () => {
    const ui = await band();
    const found = await ui.find({ type: "Text", text: /^Compacted/ });
    await ui.unmount();

    return found?.text;
  };

  // The engine stand-in answers `answer` and notes whether the band said
  // "Compacting…" meanwhile.
  let answer: SessionCompactResult = { skip: "vetoed" };
  const isBusy: boolean[] = [];
  on("session.compact", async () => {
    const ui = await band();
    isBusy.push((await ui.find({ type: "Text", text: "Compacting…" })) !== undefined);
    await ui.unmount();

    return answer;
  });
  await $.session.measure({
    context: { tokens: 420_000, window: 1_000_000, percent: 42 },
    rateLimits: [],
    changed: ["context"],
  });

  // The test session holds no transcript, so each call hands one in.
  const message = { role: "user" as const, text: "hello", toolUses: [] };
  const compact = (input: object = {}) =>
    $.session.compact({ messages: [message], ...input } as never);

  await compact();
  expect(await note()).toBeUndefined();

  answer = { messages: [message], tokensBefore: 420_000, tokensAfter: 35_000 };
  await compact({ agentId: "helper" });
  await compact({ trigger: "precompute" });
  expect(await note()).toBeUndefined();

  await compact();
  expect(await note()).toMatch(/^Compacted 420k → 35k/);

  expect(isBusy).toEqual([true, false, false, true]);
});

test("before the first reply, a fresh session has no button and a resumed one does", async ($, on) => {
  on("session.measure", (_$, e) => ({ changed: e.changed }));
  let turns = 0;
  on("session.turns", () => ({ value: turns }));
  await $.session.measure({
    context: { window: 1_000_000 },
    rateLimits: [],
    changed: ["context"],
  });

  for (const surface of ["desktop", "terminal"] as const) {
    turns = 0;
    let ui = await $.ui.mount({
      plugin: "context-meter",
      surface,
      component: "AbovePrompt",
      props: props(false),
    });
    expect(
      await ui.find({ type: "Text", text: "Context · no reply yet · 1.0M window" }),
    ).toBeDefined();
    expect(await ui.find({ key: "compact" })).toBeUndefined();
    await ui.unmount();

    turns = 3;
    ui = await $.ui.mount({
      plugin: "context-meter",
      surface,
      component: "AbovePrompt",
      props: props(false),
    });
    expect(await ui.find({ key: "compact" })).toBeDefined();
    await ui.unmount();
  }
});
