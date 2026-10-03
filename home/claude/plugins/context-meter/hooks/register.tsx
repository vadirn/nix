import { atom, read, update } from "claude-code";
import type {
  EngineInterface,
  Register,
  SessionCompactResult,
  SessionContextUsage,
} from "claude-code";

import type { Reading } from "../types";

const reading = atom({ plugin: "context-meter", key: "reading" } as const, null);
const compacted = atom({ plugin: "context-meter", key: "compacted" } as const, null);
const isCompacting = atom({ plugin: "context-meter", key: "isCompacting" } as const, false);

// Desktop meter size in CSS pixels; terminal meter width in cells.
const BAR_WIDTH = 160;
const BAR_HEIGHT = 6;
const BAR_CELLS = 24;

// A desktop cell is 8 CSS px. The native header row's text sits 5 px further
// in than the band's own inset, so 0.625 lines "Context" up with it.
const DESKTOP_INSET = 0.625;

// Quality drops with the absolute token count, so the zones are fixed sizes.
const AMBER_FROM = 200_000;
const RED_FROM = 350_000;

const zoneColor = (tokens: number) => {
  if (tokens >= RED_FROM) return "#d2553f";
  if (tokens >= AMBER_FROM) return "#e2a33a";

  return "#6ba368";
};

const meterSvg = (percent: number, color: string) => {
  const r = BAR_HEIGHT / 2;
  const fill = percent <= 0 ? 0 : Math.max(BAR_HEIGHT, (Math.min(100, percent) / 100) * BAR_WIDTH);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${BAR_WIDTH}" height="${BAR_HEIGHT}" viewBox="0 0 ${BAR_WIDTH} ${BAR_HEIGHT}">`,
    `<rect width="${BAR_WIDTH}" height="${BAR_HEIGHT}" rx="${r}" fill="#8a8a8a" fill-opacity="0.22"/>`,
    fill > 0
      ? `<rect width="${fill.toFixed(1)}" height="${BAR_HEIGHT}" rx="${r}" fill="${color}"/>`
      : "",
    `</svg>`,
  ].join("");
};

const toReading = (context: SessionContextUsage): Reading => ({
  tokens: context.tokens ?? null,
  window: context.window,
  percent: context.percent ?? null,
});

const size = (tokens: number | null) => {
  if (tokens === null) return "?";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;

  return `${Math.round(tokens / 1000)}k`;
};

const record = async ($: EngineInterface, result: SessionCompactResult) => {
  if (result.skip !== undefined) return;

  await update($, compacted, () => ({
    before: result.tokensBefore ?? null,
    after: result.tokensAfter ?? null,
  }));
};

// Runs `/compact` as if typed. `$.session.compact()` is refused in SDK-hosted
// sessions such as the desktop's, where compaction runs inside a turn. The
// `session.compact` hook below records the sizes, as for a typed `/compact`.
const compact = async ($: EngineInterface) => {
  await update($, isCompacting, () => true);

  try {
    await $.command.run({ command: "compact" });
  } catch (error) {
    $.ui.toast(`Compaction failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await update($, isCompacting, () => false);
  }
};

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    const { context } = await $.session.usage();
    await update($, reading, () => toReading(context));

    return next(e);
  });

  on("session.measure", async ($, e, next) => {
    if (e.changed.includes("context")) {
      await update($, reading, () => toReading(e.context));

      if (e.context.tokens !== undefined) {
        await update($, compacted, () => null);
      }
    }

    return next(e);
  });

  // `/compact` and auto-compaction of the main conversation.
  on("session.compact", async ($, e, next) => {
    const isMain = e.agentId === undefined && e.trigger !== "precompute";

    if (!isMain) return next(e);

    await update($, isCompacting, () => true);

    try {
      const result = await next(e);
      await record($, result);

      return result;
    } finally {
      await update($, isCompacting, () => false);
    }
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.view.agentId !== undefined) return next(e);

    const now = await read($, reading);

    if (now === null) return next(e);

    const last = await read($, compacted);
    const isBusy = await read($, isCompacting);
    const ui = $.ui.resolve(e);
    const { Box, Button, Text } = ui;
    const Svg = "Svg" in ui ? ui.Svg : undefined;

    const meter = [];

    if (last !== null) {
      meter.push(
        <Text dimColor>
          {`Compacted ${size(last.before)} → ${size(last.after)} · the meter returns after the next reply`}
        </Text>,
      );
    } else if (now.tokens === null || now.percent === null) {
      meter.push(<Text dimColor>{`Context · no reply yet · ${size(now.window)} window`}</Text>);
    } else {
      const percent = now.percent;
      const color = zoneColor(now.tokens);
      meter.push(<Text dimColor>Context</Text>);

      if (Svg !== undefined) {
        meter.push(
          <Svg
            source={meterSvg(percent, color)}
            alt={`${percent}% of the context window used`}
            width={BAR_WIDTH}
            height={BAR_HEIGHT}
          />,
        );
      } else {
        const filled = Math.round((Math.min(100, percent) / 100) * BAR_CELLS);

        meter.push(
          <Box>
            <Text color={color}>{"━".repeat(filled)}</Text>
            <Text dimColor>{"━".repeat(BAR_CELLS - filled)}</Text>
          </Box>,
        );
      }

      meter.push(
        <Text bold color={color}>{`${percent}%`}</Text>,
        <Text dimColor>{`${size(now.tokens)} / ${size(now.window)}`}</Text>,
      );
    }

    // Before the first reply there is nothing to compact.
    const hasConversation = now.tokens !== null || last !== null;
    const isWorking = e.props.isWorking;
    const action = [];

    if (isBusy) {
      action.push(<Text dimColor>Compacting…</Text>);
    } else if (hasConversation) {
      // Compaction runs between turns, so mid-turn the button dims and explains.
      action.push(
        <Button
          key="compact"
          label="Compact"
          dimColor={isWorking}
          onPress={() =>
            isWorking
              ? $.ui.toast("Compact runs between turns: press it when this one ends")
              : compact($)
          }
        />,
      );
    }

    return (
      <Box
        justifyContent="space-between"
        alignItems="center"
        gap={2}
        paddingLeft={e.surface === "terminal" ? 1 : DESKTOP_INSET}
        paddingRight={1}
      >
        <Box alignItems="center" gap={1}>
          {meter}
        </Box>
        {action}
      </Box>
    );
  });
};
