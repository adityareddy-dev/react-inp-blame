// The landing page's only script: the theme toggle, the active nav link, and the phone video.
// The page works without it (dark or the system theme, anchors, a looping video); this adds the rest.

const root = document.documentElement;

/* ---------- theme ---------- */
const toggle = document.querySelector('.theme-toggle');
if (toggle) {
  const systemLight = window.matchMedia('(prefers-color-scheme: light)');
  const current = () => root.getAttribute('data-theme') || (systemLight.matches ? 'light' : 'dark');
  const label = () => {
    toggle.setAttribute('aria-label', current() === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme');
  };
  toggle.hidden = false;
  label();
  toggle.addEventListener('click', () => {
    const next = current() === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('rib-theme', next); } catch (e) { /* storage blocked: the choice lasts for this visit */ }
    label();
  });
  systemLight.addEventListener?.('change', label);
}

/* ---------- active nav link ---------- */
const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
const navEl = document.querySelector('.site-nav');
const links = [...document.querySelectorAll('.site-nav a[href^="#"]')];
const byId = new Map(links.map((a) => [a.getAttribute('href').slice(1), a]));
const targets = [...byId.keys()].map((id) => document.getElementById(id)).filter(Boolean);
if ('IntersectionObserver' in window && targets.length) {
  const visible = new Set();
  const mark = () => {
    // The first section, in page order, that is crossing the band just under the header.
    const active = targets.find((t) => visible.has(t));
    links.forEach((a) => {
      const on = !!active && byId.get(active.id) === a;
      if (on) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current');
    });
    // On a phone the nav row scrolls sideways, so bring the active link into view inside it (never the page).
    // Back at the hero no link is active, so the row returns to its start and the first link reads whole.
    const cur = navEl && navEl.querySelector('a[aria-current]');
    if (navEl && navEl.scrollWidth > navEl.clientWidth) {
      const left = cur ? Math.max(0, cur.offsetLeft - 20) : 0;
      if (Math.abs(navEl.scrollLeft - left) > 1) navEl.scrollTo({ left, behavior: reduce.matches ? 'auto' : 'smooth' });
    }
  };
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => (e.isIntersecting ? visible.add(e.target) : visible.delete(e.target)));
    mark();
  }, { rootMargin: '-20% 0px -65% 0px' });
  targets.forEach((t) => io.observe(t));
}

/* ---------- the phone ---------- */
const videos = [...document.querySelectorAll('video[data-phone]')];
// The hero phone picks its file from the <source> list alone: Safari and every iOS browser take phone-demo.mov,
// HEVC with alpha from Apple's own encoder; Chrome and Firefox say they can't play video/quicktime and take the
// WebM, VP9 with alpha. A browser that said it could play the MOV and then fails on it gets an opaque H.264 render
// clipped to the phone body by CSS, never the WebM, whose alpha WebKit ignores.

// The reduced-motion path puts the transparent poster where the video was.
function swapToPoster(v) {
  const img = document.createElement('img');
  img.className = v.className;
  img.src = v.getAttribute('poster');
  img.width = v.width || 720;
  img.height = v.height || 1500;
  img.alt = v.getAttribute('aria-label') || '';
  v.replaceWith(img);
}

// On a phone the badge recording plays its phone cut (the <source media> in index.html), so its poster matches.
const phoneCut = window.matchMedia('(max-width: 759px)').matches;

videos.forEach((v) => {
  if (phoneCut && !v.closest('.hero') && v.getAttribute('poster') === '/media/overlay.png') v.setAttribute('poster', '/media/overlay-phone.png');
  if (reduce.matches) {
    // Reduced motion: no autoplay, the poster stays.
    swapToPoster(v);
    return;
  }
  const mov = v.closest('.hero') && v.querySelector('source[type^="video/quicktime"]');
  // Every browser fires error at a <source> it skips, so only one that claims the MOV is switched.
  if (mov && v.canPlayType(mov.getAttribute('type'))) {
    const clipped = () => {
      if (v.classList.contains('device-media--clip')) return;
      v.querySelectorAll('source').forEach((s) => s.remove());
      v.classList.add('device-media--clip');
      v.removeAttribute('poster');
      v.src = '/media/phone-demo-webkit.mp4';
      v.addEventListener('error', () => { v.classList.remove('device-media--clip'); v.removeAttribute('src'); v.setAttribute('poster', '/media/phone-demo-poster.png'); swapToPoster(v); }, { once: true });
      v.load();
    };
    mov.addEventListener('error', clipped, { once: true });
    // This script runs after parsing, so the MOV may already have failed and the WebM taken its place.
    if (v.currentSrc && !v.currentSrc.endsWith('.mov')) clipped();
  }
});

// Play a phone only while it is on screen, so two clips never decode at once off screen.
const live = [...document.querySelectorAll('video[data-phone]')];
if ('IntersectionObserver' in window && live.length) {
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) e.target.play?.().catch(() => {});
      else e.target.pause?.();
    });
  }, { threshold: 0.15 });
  live.forEach((v) => io.observe(v));
}
