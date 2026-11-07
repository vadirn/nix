/// <reference lib="dom" />
/**
 * Zoom and pan for a wide diagram inside a `show_widget` fragment.
 *
 * render.ts bundles this module, with @muxmuxmux/core, into one inline IIFE.
 * It exports nothing: on load it sets up every viewport in the document that
 * no earlier copy has claimed, so several diagrams can share one page. The
 * viewport holds pele's SVG at its natural size, and a CSS transform scales
 * and moves it, which leaves pele's markup untouched. Scale 1 is pele's 1:1
 * layout, so text renders at the 14px it was measured at.
 */
import { controller } from "@muxmuxmux/core";
import { TOOLBAR_ROOM } from "./toolbar.ts";

const MAX = 4;
const STEP = 1.25;

type Point = [number, number];

// Arrow keys pan by 48px.
const PAN: Record<string, Point> = {
  ArrowLeft: [48, 0],
  ArrowRight: [-48, 0],
  ArrowUp: [0, 48],
  ArrowDown: [0, -48],
};

function setUp(view: HTMLElement) {
  const tools = document.getElementById(`${view.id}-tools`);
  const svg = view.querySelector("svg");
  const readout = tools?.querySelector("output");
  if (!tools || !svg || !readout) return;
  const width = Number(view.dataset.w);
  const height = Number(view.dataset.h);
  let scale = 1;
  let x = 0;
  let y = 0;

  // The fit leaves the toolbar's room clear below the diagram.
  const fit = () =>
    Math.min(view.clientWidth / width, (view.clientHeight - TOOLBAR_ROOM) / height, 1);

  // Pan with half a viewport of slack: any corner of the diagram can reach the
  // centre. A diagram smaller than half the viewport can also rest anywhere
  // between the top or left edge and the centre, where the fit centres it.
  const clamp = (offset: number, size: number, box: number) =>
    Math.min(box / 2, Math.max(Math.min(0, box / 2 - size * scale), offset));

  const apply = () => {
    x = clamp(x, width, view.clientWidth);
    y = clamp(y, height, view.clientHeight);
    svg.style.transform = `translate(${x}px,${y}px) scale(${scale})`;
    readout.textContent = `${Math.round(scale * 100)}%`;
  };

  // Scale to `next`, keeping the diagram point under (ax, ay) in place.
  function zoomTo(next: number, ax = view.clientWidth / 2, ay = view.clientHeight / 2) {
    const s = Math.min(Math.max(next, fit()), MAX);
    x = ax - ((ax - x) * s) / scale;
    y = ay - ((ay - y) * s) / scale;
    scale = s;
    apply();
  }

  // Centre the diagram at scale s in the space above the toolbar's room;
  // `corner` pins its top-left corner instead, where a top-down or
  // left-to-right flow starts.
  function show(s: number, corner: boolean) {
    scale = s;
    x = corner ? 0 : (view.clientWidth - width * s) / 2;
    y = corner ? 0 : (view.clientHeight - TOOLBAR_ROOM - height * s) / 2;
    apply();
  }

  const local = (e: MouseEvent): Point => {
    const r = view.getBoundingClientRect();
    return [e.clientX - r.left - view.clientLeft, e.clientY - r.top - view.clientTop];
  };

  const actions = {
    in: () => zoomTo(scale * STEP),
    out: () => zoomTo(scale / STEP),
    fit: () => show(fit(), false),
    actual: () => show(1, true),
  };
  for (const button of tools.querySelectorAll<HTMLButtonElement>("button[data-act]")) {
    button.addEventListener("click", actions[button.dataset.act as keyof typeof actions]);
  }

  // A plain wheel scrolls the chat; ctrl/cmd+wheel zooms. Trackpad pinch arrives as ctrl+wheel.
  view.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const delta = Math.max(-25, Math.min(25, e.deltaMode ? e.deltaY * 16 : e.deltaY));
      zoomTo(scale * 2 ** (-delta / 50), ...local(e));
    },
    { passive: false },
  );

  // Safari reports trackpad pinch as gesture events instead. They exist in
  // WebKit only, so lib.dom leaves them out. iOS fires them for a touch pinch
  // too, beside the pointers the drag already pinches with, so only a pinch
  // that holds no pointer, a trackpad's, zooms here.
  type GestureEvent = MouseEvent & { scale: number };
  let gestureStart = 0;
  view.addEventListener("gesturestart", (e) => {
    e.preventDefault();
    gestureStart = scale;
  });
  view.addEventListener("gesturechange", (e) => {
    e.preventDefault();
    if (pointers.size > 0) return;
    zoomTo(gestureStart * (e as GestureEvent).scale, ...local(e as GestureEvent));
  });

  // Pointers held on the diagram, by id, at their last viewport position.
  // The drag's phase is the controller's state; this map is its data.
  const pointers = new Map<number, Point>();

  // Capture the pointer, so the drag keeps going outside the viewport.
  const hold = (e: PointerEvent) => {
    view.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, local(e));
  };

  // Record where a held pointer is now and return how far it moved. A pointer
  // that was never held, such as one pressed on the toolbar, returns nothing.
  const step = (e: PointerEvent): Point | undefined => {
    const last = pointers.get(e.pointerId);
    if (!last) return;
    const now = local(e);
    pointers.set(e.pointerId, now);
    return [now[0] - last[0], now[1] - last[1]];
  };

  const pair = () => {
    const [[ax, ay], [bx, by]] = pointers.values();
    return { x: (ax + bx) / 2, y: (ay + by) / 2, d: Math.hypot(ax - bx, ay - by) };
  };

  // One held pointer pans; a second pinches around their midpoint. A third
  // finds no `down` in "pinching", so it changes nothing. Lifting either
  // pinching pointer hands the drag back to the other as a pan.
  const drag = controller("idle", {
    idle: {
      down: (e: PointerEvent) => {
        hold(e);
        drag.set("panning");
      },
    },
    panning: {
      down: (e: PointerEvent) => {
        hold(e);
        drag.set("pinching");
      },
      move: (e: PointerEvent) => {
        // A mouse moving with no button down missed its pointerup, as when the
        // button came up in another app. End the drag instead of panning on hover.
        if (e.pointerType === "mouse" && e.buttons === 0) {
          if (pointers.delete(e.pointerId)) drag.set("idle");
          return;
        }
        const moved = step(e);
        if (!moved) return;
        x += moved[0];
        y += moved[1];
        apply();
      },
      up: (e: PointerEvent) => {
        if (pointers.delete(e.pointerId)) drag.set("idle");
      },
    },
    pinching: {
      move: (e: PointerEvent) => {
        if (!pointers.has(e.pointerId)) return;
        const before = pair();
        step(e);
        const after = pair();
        x += after.x - before.x;
        y += after.y - before.y;
        zoomTo(before.d > 0 ? (scale * after.d) / before.d : scale, after.x, after.y);
      },
      up: (e: PointerEvent) => {
        if (pointers.delete(e.pointerId)) drag.set("panning");
      },
    },
  });

  drag.subscribe((state) => {
    view.style.cursor = state === "idle" ? "grab" : "grabbing";
  });

  // The toolbar sits inside the viewport; capturing its pointer would swallow the click.
  view.addEventListener("pointerdown", (e) => {
    if ((e.pointerType === "mouse" && e.button !== 0) || tools.contains(e.target as Node)) return;
    drag.down(e);
  });
  view.addEventListener("pointermove", drag.move);
  // Losing capture ends a pointer's part in the drag, as lifting it does. It
  // also follows every pointerup, which finds the pointer gone and does nothing.
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
    view.addEventListener(type, drag.up);
  }

  view.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const pan = PAN[e.key];
    if (pan) {
      x += pan[0];
      y += pan[1];
      apply();
    } else if (e.key === "+" || e.key === "=") actions.in();
    else if (e.key === "-") actions.out();
    // The physical key as well, since a Cyrillic layout types "а" on F and
    // AZERTY types "à" on 0.
    else if (e.key === "0" || e.code === "Digit0") actions.actual();
    else if (e.key === "f" || e.code === "KeyF") actions.fit();
    else return;
    e.preventDefault();
  });

  // The widget can narrow with the window; keep the scale at or above the new fit.
  new ResizeObserver(() => zoomTo(scale, 0, 0)).observe(view);
  // Open on the whole diagram.
  actions.fit();
}

for (const view of document.querySelectorAll<HTMLElement>("[data-w][data-h]:not([data-ready])")) {
  view.dataset.ready = "";
  setUp(view);
}
