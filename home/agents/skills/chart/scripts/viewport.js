/**
 * Zoom and pan for a wide diagram inside a `show_widget` fragment.
 *
 * render.ts inlines this function, whitespace-minified, as `(function …)(id)`,
 * so it runs once per widget with no globals. The viewport holds pele's SVG at
 * its natural size, and a CSS transform scales and moves it, which leaves
 * pele's markup untouched. Scale 1 is pele's 1:1 layout, so text renders at
 * the 14px it was measured at.
 */
// oxlint-disable-next-line no-unused-vars -- invoked by the inlined IIFE
function mermaidViewport(id) {
  const view = document.getElementById(id);
  const tools = document.getElementById(`${id}-tools`);
  if (!view || !tools) return;
  const svg = view.querySelector("svg");
  const readout = tools.querySelector("output");
  const width = Number(view.dataset.w);
  const height = Number(view.dataset.h);
  const MAX = 4;
  const STEP = 1.25;
  const PAN = 48;
  let scale = 1;
  let x = 0;
  let y = 0;

  const fit = () => Math.min(view.clientWidth / width, view.clientHeight / height, 1);

  // Pan with half a viewport of slack: any corner of the diagram can reach the centre.
  const clamp = (offset, size, box) => Math.min(box / 2, Math.max(box / 2 - size * scale, offset));

  function apply() {
    x = clamp(x, width, view.clientWidth);
    y = clamp(y, height, view.clientHeight);
    svg.style.transform = `translate(${x}px,${y}px) scale(${scale})`;
    readout.textContent = `${Math.round(scale * 100)}%`;
  }

  // Scale to `next`, keeping the diagram point under (ax, ay) in place.
  function zoomTo(next, ax = view.clientWidth / 2, ay = view.clientHeight / 2) {
    const s = Math.min(Math.max(next, fit()), MAX);
    x = ax - ((ax - x) * s) / scale;
    y = ay - ((ay - y) * s) / scale;
    scale = s;
    apply();
  }

  // Centre the diagram at scale s; `left` pins its left edge instead, where a
  // left-to-right flow starts.
  function show(s, left) {
    scale = s;
    x = left ? 0 : (view.clientWidth - width * s) / 2;
    y = (view.clientHeight - height * s) / 2;
    apply();
  }

  const local = (e) => {
    const r = view.getBoundingClientRect();
    return [e.clientX - r.left - view.clientLeft, e.clientY - r.top - view.clientTop];
  };

  const actions = {
    in: () => zoomTo(scale * STEP),
    out: () => zoomTo(scale / STEP),
    fit: () => show(fit(), false),
    actual: () => show(1, true),
  };
  for (const button of tools.querySelectorAll("button[data-act]")) {
    button.addEventListener("click", actions[button.dataset.act]);
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

  // Safari reports trackpad pinch as gesture events instead.
  let gestureStart = 0;
  view.addEventListener("gesturestart", (e) => {
    e.preventDefault();
    gestureStart = scale;
  });
  view.addEventListener("gesturechange", (e) => {
    e.preventDefault();
    zoomTo(gestureStart * e.scale, ...local(e));
  });

  // One pointer pans; two pointers pinch around their midpoint.
  const pointers = new Map();
  const pair = () => {
    const [[ax, ay], [bx, by]] = pointers.values();
    return { x: (ax + bx) / 2, y: (ay + by) / 2, d: Math.hypot(ax - bx, ay - by) };
  };
  // The toolbar sits inside the viewport; capturing its pointer would swallow the click.
  view.addEventListener("pointerdown", (e) => {
    if ((e.pointerType === "mouse" && e.button !== 0) || tools.contains(e.target)) return;
    view.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, local(e));
    view.style.cursor = "grabbing";
  });
  view.addEventListener("pointermove", (e) => {
    const last = pointers.get(e.pointerId);
    if (!last) return;
    const now = local(e);
    if (pointers.size === 2) {
      const before = pair();
      pointers.set(e.pointerId, now);
      const after = pair();
      x += after.x - before.x;
      y += after.y - before.y;
      zoomTo(before.d > 0 ? (scale * after.d) / before.d : scale, after.x, after.y);
      return;
    }
    pointers.set(e.pointerId, now);
    x += now[0] - last[0];
    y += now[1] - last[1];
    apply();
  });
  const release = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size === 0) view.style.cursor = "";
  };
  view.addEventListener("pointerup", release);
  view.addEventListener("pointercancel", release);

  view.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const pan = {
      ArrowLeft: [PAN, 0],
      ArrowRight: [-PAN, 0],
      ArrowUp: [0, PAN],
      ArrowDown: [0, -PAN],
    }[e.key];
    if (pan) {
      x += pan[0];
      y += pan[1];
      apply();
    } else if (e.key === "+" || e.key === "=") actions.in();
    else if (e.key === "-") actions.out();
    else if (e.key === "0") actions.actual();
    else if (e.key === "f") actions.fit();
    else return;
    e.preventDefault();
  });

  // The widget can narrow with the window; keep the scale at or above the new fit.
  new ResizeObserver(() => zoomTo(scale, 0, 0)).observe(view);
  actions.actual();
}
