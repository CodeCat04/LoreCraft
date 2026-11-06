/**
 * Limits streamed updates to one a frame, so a fast model cannot freeze the window. A
 * timer backs up the frame, because frames stop in a hidden window and text should not.
 */
export function frameBatcher(apply: () => void): { schedule: () => void; flush: () => void } {
  let waiting = false;
  const run = () => {
    if (!waiting) return;
    waiting = false;
    apply();
  };
  return {
    schedule: () => {
      if (waiting) return;
      waiting = true;
      requestAnimationFrame(run);
      window.setTimeout(run, 120);
    },
    flush: () => {
      waiting = true;
      run();
    },
  };
}
