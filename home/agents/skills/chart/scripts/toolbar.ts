/**
 * The room the zoom toolbar keeps clear below a diagram. render.ts adds it
 * below a diagram shorter than the viewport's cap; the fit, in viewport.ts and
 * in render.ts's first paint, scales the diagram into the space above it. The
 * toolbar is 33px tall, inset 8px from the bottom.
 */
export const TOOLBAR_ROOM = 48;
