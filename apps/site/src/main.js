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
  };
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => (e.isIntersecting ? visible.add(e.target) : visible.delete(e.target)));
    mark();
  }, { rootMargin: '-20% 0px -65% 0px' });
  targets.forEach((t) => io.observe(t));
}

/* ---------- the phone ---------- */
const videos = [...document.querySelectorAll('video[data-phone]')];
const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
const ua = navigator.userAgent;
// WebKit (Safari, and every iOS browser) ignores the alpha in WebM, so the hero phone gets an opaque H.264
// render of the same video, clipped to the phone body by CSS. Only the hero video changes; the badge recording
// plays as it is.
const webkit = /AppleWebKit/.test(ua) && !/Chrome\/|Chromium|Edg\/|Android/.test(ua);

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

videos.forEach((v) => {
  if (reduce.matches) {
    // Reduced motion: no autoplay, the poster stays.
    swapToPoster(v);
    return;
  }
  if (webkit && v.closest('.hero')) {
    v.classList.add('device-media--clip');
    v.removeAttribute('poster');
    v.querySelectorAll('source').forEach((s) => s.remove());
    v.src = '/media/phone-demo-webkit.mp4';
    v.addEventListener('error', () => { v.classList.remove('device-media--clip'); v.removeAttribute('src'); v.setAttribute('poster', '/media/phone-demo-poster.png'); swapToPoster(v); }, { once: true });
    v.load();
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
