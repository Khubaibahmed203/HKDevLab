/**
 * Background dot field — square "pixels" (a nod to the logo mark) that
 * ripple with a slow wave, swell and scatter around the pointer, and drift
 * with the page scroll. Quantised into a few alpha buckets so each frame is
 * a handful of fills rather than thousands of style changes.
 */
const BUCKETS = 8;
const GAP = 38;

export function initField(canvas, { animate = true } = {}) {
  const ctx = canvas.getContext('2d', { alpha: true });
  const mouse = { x: -9999, y: -9999, sx: -9999, sy: -9999, active: false };
  let w = 0, h = 0, dpr = 1, cols = 0, rows = 0, raf = 0, running = false;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    w = window.innerWidth; h = window.innerHeight;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.ceil(w / GAP) + 2; rows = Math.ceil(h / GAP) + 3;
    if (!animate) draw(0);
  }

  const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

  function draw(time) {
    ctx.clearRect(0, 0, w, h);
    mouse.sx += (mouse.x - mouse.sx) * 0.14; mouse.sy += (mouse.y - mouse.sy) * 0.14;
    const drift = ((window.scrollY || 0) * 0.14) % GAP;
    const paths = Array.from({ length: BUCKETS }, () => new Path2D());
    const hot = new Path2D();

    for (let r = 0; r < rows; r++) {
      const by = r * GAP - drift - GAP;
      for (let c = 0; c < cols; c++) {
        const bx = c * GAP - GAP * 0.5;
        const wave = Math.sin(bx * 0.007 + by * 0.005 + time * 0.0006) * 0.5 + 0.5;
        const dx = bx - mouse.sx, dy = by - mouse.sy;
        const dist = Math.hypot(dx, dy);
        const near = mouse.active ? 1 - smooth(0, 230, dist) : 0;
        const push = near * 14 / (dist || 1);
        const x = bx + dx * push, y = by + dy * push;
        const a = 0.1 + wave * wave * 0.2 + near * 0.75;
        const size = 2 + near * 3.4 + wave * 0.6;
        if (near > 0.5) hot.rect(x - size / 2, y - size / 2, size, size);
        else paths[Math.min(BUCKETS - 1, (a * BUCKETS) | 0)].rect(x - size / 2, y - size / 2, size, size);
      }
    }
    for (let i = 0; i < BUCKETS; i++) {
      ctx.fillStyle = `rgba(90, 170, 255, ${((i + 0.5) / BUCKETS * 0.9).toFixed(3)})`;
      ctx.fill(paths[i]);
    }
    ctx.fillStyle = 'rgba(29, 228, 255, .95)';
    ctx.fill(hot);
  }

  function loop(t) { draw(t); raf = requestAnimationFrame(loop); }
  function start() { if (!running) { running = true; raf = requestAnimationFrame(loop); } }
  function stop() { running = false; cancelAnimationFrame(raf); }

  window.addEventListener('resize', resize);
  resize();

  if (animate) {
    window.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      mouse.x = e.clientX; mouse.y = e.clientY; mouse.active = true;
    }, { passive: true });
    document.addEventListener('pointerleave', () => { mouse.active = false; });
    document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
    start();
  }
  return { stop, start };
}
