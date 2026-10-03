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
