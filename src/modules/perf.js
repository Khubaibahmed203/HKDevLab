/**
 * Slow devices should get a lighter version of the same show — not a stuttering one.
 * "Lite" keeps every scene and the 3D depth, but drops the expensive extras
 * (blur filters, glass backdrop-blur, the animated dot field, big glows).
 */
const html = document.documentElement;

/** Known-weak hardware, or a visitor who asked their browser to save data. */
export function isWeakDevice() {
  const n = navigator;
  const c = n.connection;
  return Boolean((n.deviceMemory && n.deviceMemory <= 2) || (n.hardwareConcurrency && n.hardwareConcurrency <= 2) || (c && c.saveData));
}

/**
 * Measures real frame times while the visitor is scrolling. If the page can't hold ~25 fps,
 * switch to lite mode once. (Frames from a hidden tab or a one-off hitch are ignored.)
 */
export function watchPerformance(onSlow) {
  if (html.classList.contains('is-lite')) return;
  let last = 0, lastScroll = 0, n = 0, sum = 0, done = false;
  window.addEventListener('scroll', () => { lastScroll = performance.now(); }, { passive: true });
  document.addEventListener('visibilitychange', () => { last = 0; });
  const tick = (now) => {
    if (done) return;
    if (last && now - lastScroll < 250) {
      const dt = now - last;
      if (dt < 250) { sum += dt; n++; }
      if (n >= 90) {
        if (sum / n > 40) { done = true; html.classList.add('is-lite'); onSlow && onSlow(); return; }
        if (sum / n < 24) { done = true; return; }   // clearly smooth: stop measuring
        sum = 0; n = 0;
      }
    }
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
