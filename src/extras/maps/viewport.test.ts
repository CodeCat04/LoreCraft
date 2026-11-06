import {
  centerOnFraction,
  clampFraction,
  clampViewport,
  fitViewport,
  fractionToScreen,
  isOnImage,
  screenToFraction,
  zoomAt,
  zoomLimits,
} from './viewport';

const image = { width: 2000, height: 1000 };
const view = { width: 1000, height: 800 };

describe('map viewport', () => {
  it('fits the image inside the view, centered', () => {
    const t = fitViewport(image, view);
    expect(t.k).toBeCloseTo(952 / 2000);
    const topLeft = fractionToScreen(t, image, 0, 0);
    const bottomRight = fractionToScreen(t, image, 1, 1);
    expect(topLeft.x).toBeCloseTo(24);
    expect(view.width - bottomRight.x).toBeCloseTo(24);
    expect(topLeft.y).toBeCloseTo(view.height - bottomRight.y);
  });

  it('keeps a pin at the same fraction at any zoom and pan', () => {
    let t = fitViewport(image, view);
    const pin = { x: 0.3, y: 0.7 };
    for (const factor of [1.5, 3, 0.2, 8]) {
      t = zoomAt(t, factor, 400, 300, image, view);
      const screen = fractionToScreen(t, image, pin.x, pin.y);
      const back = screenToFraction(t, image, screen.x, screen.y);
      expect(back.x).toBeCloseTo(pin.x, 10);
      expect(back.y).toBeCloseTo(pin.y, 10);
    }
  });

  it('zooms around the point under the cursor', () => {
    const t = fitViewport(image, view);
    const before = screenToFraction(t, image, 500, 400);
    const after = screenToFraction(zoomAt(t, 2, 500, 400, image, view), image, 500, 400);
    expect(after.x).toBeCloseTo(before.x, 10);
    expect(after.y).toBeCloseTo(before.y, 10);
  });

  it('stops zooming at its limits', () => {
    const limits = zoomLimits(image, view);
    let t = fitViewport(image, view);
    for (let i = 0; i < 50; i += 1) t = zoomAt(t, 2, 500, 400, image, view);
    expect(t.k).toBe(limits.max);
    for (let i = 0; i < 50; i += 1) t = zoomAt(t, 0.5, 500, 400, image, view);
    expect(t.k).toBe(limits.min);
  });

  it('cannot pan the image off screen', () => {
    const t = fitViewport(image, view);
    const far = clampViewport({ ...t, tx: 100000, ty: -100000 }, image, view);
    expect(far.tx).toBeLessThan(view.width);
    expect(far.ty + image.height * far.k).toBeGreaterThan(0);
  });

  it('centers on a pin', () => {
    const t = { k: 2, tx: 0, ty: 0 };
    const centered = centerOnFraction(t, image, view, 0.5, 0.5);
    const screen = fractionToScreen(centered, image, 0.5, 0.5);
    expect(screen.x).toBeCloseTo(view.width / 2);
    expect(screen.y).toBeCloseTo(view.height / 2);
  });

  it('knows when a point is on the image', () => {
    expect(isOnImage({ x: 0, y: 1 })).toBe(true);
    expect(isOnImage({ x: -0.01, y: 0.5 })).toBe(false);
    expect(isOnImage({ x: 0.5, y: 1.01 })).toBe(false);
    expect(clampFraction(-3)).toBe(0);
    expect(clampFraction(3)).toBe(1);
    expect(clampFraction(0.25)).toBe(0.25);
  });
});
