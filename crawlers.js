// Rainbow spiders that crawl over the page: each walks to a block on screen, frames it, spins a few threads to it,
// then moves on. Drawn on a fixed overlay that ignores the mouse. Off for prefers-reduced-motion, asleep when the tab
// is hidden, one spider on small screens.
(() => {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const SELECT = '.card,.step,h1,h2,.stat,.coin,.row,.vote,.seat,.vb,.bundle,.cl,.token,.btn.primary,.big,.check,.holder';
  const C = ['#ff2e7e', '#ff8a1f', '#ffe81f', '#4dff6a', '#1fd2ff', '#5b6bff', '#b84dff'];
  const NS = 'http://www.w3.org/2000/svg';
  const SCALE = innerWidth > 760 ? 1.9 : 1.5;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  Object.assign(svg.style, { position: 'fixed', inset: '0', width: '100vw', height: '100vh', pointerEvents: 'none', zIndex: '15', overflow: 'visible' });
  svg.innerHTML = `<defs><linearGradient id="crw-rb" x1="0" y1="0" x2="1" y2="1">${C.map((c, i) => `<stop offset="${i / 6}" stop-color="${c}"/>`).join('')}</linearGradient>
    <filter id="crw-gl" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>`;
  document.body.appendChild(svg);

  const visible = () => [...document.querySelectorAll(SELECT)].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 60 && r.height > 24 && r.width < innerWidth * 0.95 && r.bottom > 70 && r.top < innerHeight - 20 && getComputedStyle(el).visibility !== 'hidden';
  });

  function makeSpider(i) {
    const g = document.createElementNS(NS, 'g');
    const frame = document.createElementNS(NS, 'rect');
    const threads = document.createElementNS(NS, 'g');
    frame.setAttribute('fill', 'none'); frame.setAttribute('stroke', 'url(#crw-rb)'); frame.setAttribute('stroke-width', '2'); frame.setAttribute('rx', '14'); frame.setAttribute('filter', 'url(#crw-gl)');
    threads.setAttribute('stroke', '#cfe9ff'); threads.setAttribute('stroke-opacity', '.45'); threads.setAttribute('stroke-width', '1'); threads.setAttribute('stroke-dasharray', '3 4');
    svg.append(frame, threads, g);
    return { g, frame, threads, x: innerWidth * (0.2 + 0.6 * Math.random()), y: innerHeight * (0.3 + 0.5 * Math.random()), target: null, corner: 0, state: 'pick', until: 0, phase: i * 1.7, hue: i * 3 };
  }
  const spiders = [makeSpider(0)];
  if (innerWidth > 760) spiders.push(makeSpider(1));

  function drawSpider(s, t, moving, ang) {
    const legs = [];
    for (let k = 0; k < 8; k++) {
      const side = k < 4 ? -1 : 1, j = k % 4, base = (-0.9 + j * 0.6) * side;
      const sw = moving ? Math.sin(t * 14 + k * 1.3) * 0.28 : Math.sin(t * 2 + k) * 0.06;
      const a1 = ang + Math.PI / 2 * side + base * 0.6 + sw, kx = Math.cos(a1) * 9, ky = Math.sin(a1) * 9;
      const a2 = a1 + 0.9 * side, tx = kx + Math.cos(a2) * 8, ty = ky + Math.sin(a2) * 8;
      legs.push(`<path d="M0 0L${kx.toFixed(1)} ${ky.toFixed(1)}L${tx.toFixed(1)} ${ty.toFixed(1)}" stroke="${C[(k + s.hue) % 7]}" stroke-width="1.7" fill="none" stroke-linecap="round"/>`);
    }
    const bx = -Math.cos(ang) * 7, by = -Math.sin(ang) * 7;
    s.g.setAttribute('transform', `translate(${s.x.toFixed(1)} ${s.y.toFixed(1)}) scale(${SCALE})`);
    s.g.innerHTML = `<g filter="url(#crw-gl)">${legs.join('')}<ellipse cx="${bx.toFixed(1)}" cy="${by.toFixed(1)}" rx="6.5" ry="5" transform="rotate(${(ang * 180 / Math.PI).toFixed(0)} ${bx.toFixed(1)} ${by.toFixed(1)})" fill="url(#crw-rb)"/><circle r="3.6" fill="#140f3c" stroke="url(#crw-rb)" stroke-width="1.4"/></g>`;
  }

  let last = performance.now(), running = true;
  function tick(now) {
    if (!running) return;
    const t = now / 1000, dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    for (const s of spiders) {
      if (s.state === 'pick') {
        const busy = spiders.map((o) => o.target);
        const pool = visible().filter((el) => !busy.includes(el));
        s.target = pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
        s.corner = Math.floor(Math.random() * 4);
        s.state = s.target ? 'walk' : 'rest';
        s.until = now + 1500;
        s.frame.setAttribute('opacity', '0'); s.threads.innerHTML = '';
      }
      let moving = false, ang = Math.sin(t + s.phase) * 0.3 - Math.PI / 2;
      if (s.target) {
        const r = s.target.getBoundingClientRect();
        if (r.bottom < 60 || r.top > innerHeight) { s.state = 'pick'; continue; }
        const cx = [r.left, r.right, r.right, r.left][s.corner], cy = [r.top, r.top, r.bottom, r.bottom][s.corner];
        const dx = cx - s.x, dy = cy - s.y, d = Math.hypot(dx, dy);
        if (s.state === 'walk') {
          if (d > 3) { const v = Math.min(d, 260 * dt); s.x += (dx / d) * v; s.y += (dy / d) * v; moving = true; ang = Math.atan2(dy, dx); }
          else { s.state = 'frame'; s.until = now + 2600; }
        } else if (s.state === 'frame') {
          s.x = cx; s.y = cy;
          const p = Math.min(1, (2600 - (s.until - now)) / 500), fade = Math.min(1, (s.until - now) / 400);
          s.frame.setAttribute('x', r.left - 5); s.frame.setAttribute('y', r.top - 5); s.frame.setAttribute('width', r.width + 10); s.frame.setAttribute('height', r.height + 10);
          s.frame.setAttribute('opacity', (0.9 * Math.min(p, fade)).toFixed(2));
          const pts = [[r.left, r.top], [r.right, r.top], [r.right, r.bottom], [r.left, r.bottom], [r.left + r.width / 2, r.top]];
          s.threads.innerHTML = pts.map(([px, py]) => `<line x1="${s.x}" y1="${s.y}" x2="${s.x + (px - s.x) * p}" y2="${s.y + (py - s.y) * p}" opacity="${fade.toFixed(2)}"/>`).join('');
          if (now > s.until) s.state = 'pick';
        }
      } else if (now > s.until) s.state = 'pick';
      drawSpider(s, t, moving, ang);
    }
    requestAnimationFrame(tick);
  }
  document.addEventListener('visibilitychange', () => { running = !document.hidden; if (running) { last = performance.now(); requestAnimationFrame(tick); } });
  requestAnimationFrame(tick);
})();
