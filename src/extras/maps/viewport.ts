/**
 * Pan and zoom arithmetic for maps. A viewport maps image pixels to screen pixels as
 * `screen = image * k + (tx, ty)`. Pins are stored as fractions of the image, so they
 * do not depend on any of this.
 */

export interface Viewport {
  k: number;
  tx: number;
  ty: number;
}

export interface Size {
  width: number;
  height: number;
}

const FIT_MARGIN_PX = 24;
/** How much of the image must stay on screen, so it cannot be lost by panning. */
const KEEP_VISIBLE_PX = 64;
/** The most one image pixel can be enlarged. */
const MAX_PIXEL_SCALE = 8;

export function fitViewport(image: Size, view: Size): Viewport {
  const room = {
    width: Math.max(1, view.width - FIT_MARGIN_PX * 2),
    height: Math.max(1, view.height - FIT_MARGIN_PX * 2),
  };
  const k = Math.min(room.width / image.width, room.height / image.height);
  return {
    k,
    tx: (view.width - image.width * k) / 2,
    ty: (view.height - image.height * k) / 2,
  };
}

export function zoomLimits(image: Size, view: Size): { min: number; max: number } {
  const fit = fitViewport(image, view).k;
  return { min: Math.min(fit, 1) / 2, max: Math.max(fit * 2, MAX_PIXEL_SCALE) };
}

/** Keeps a corner of the image on screen. */
export function clampViewport(t: Viewport, image: Size, view: Size): Viewport {
  const w = image.width * t.k;
  const h = image.height * t.k;
  return {
    k: t.k,
    tx: Math.min(view.width - KEEP_VISIBLE_PX, Math.max(KEEP_VISIBLE_PX - w, t.tx)),
    ty: Math.min(view.height - KEEP_VISIBLE_PX, Math.max(KEEP_VISIBLE_PX - h, t.ty)),
  };
}

/** Zooms so that the point under (sx, sy) stays there. */
export function zoomAt(t: Viewport, factor: number, sx: number, sy: number, image: Size, view: Size): Viewport {
  const { min, max } = zoomLimits(image, view);
  const k = Math.min(max, Math.max(min, t.k * factor));
  const applied = k / t.k;
  return clampViewport(
    { k, tx: sx - (sx - t.tx) * applied, ty: sy - (sy - t.ty) * applied },
    image,
    view,
  );
}

export function screenToFraction(t: Viewport, image: Size, sx: number, sy: number): { x: number; y: number } {
  return {
    x: (sx - t.tx) / (image.width * t.k),
    y: (sy - t.ty) / (image.height * t.k),
  };
}

export function fractionToScreen(t: Viewport, image: Size, x: number, y: number): { x: number; y: number } {
  return {
    x: x * image.width * t.k + t.tx,
    y: y * image.height * t.k + t.ty,
  };
}

/** Moves the view so that a point on the image is in the middle of the screen. */
export function centerOnFraction(t: Viewport, image: Size, view: Size, x: number, y: number): Viewport {
  return clampViewport(
    {
      k: t.k,
      tx: view.width / 2 - x * image.width * t.k,
      ty: view.height / 2 - y * image.height * t.k,
    },
    image,
    view,
  );
}

export function clampFraction(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function isOnImage(point: { x: number; y: number }): boolean {
  return point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1;
}
