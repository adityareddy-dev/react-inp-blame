import { loadFont } from '@remotion/fonts';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { continueRender, delayRender, Easing, interpolate, staticFile, useCurrentFrame } from 'remotion';
import { createOverlay, type OverlayHandle } from '../../../packages/core/src/overlay';
import { inp, report } from './fixture';

/**
 * The landing page's phone: 720x1500 with a transparent background. The phone's body, bezel and screen are
 * drawn here; everything outside the body is alpha 0, so the page shows through and adds only its glow.
 *
 * Inside the screen is a small React app (a sign-in screen, then a profile page with a photo grid) and, on
 * top of it, the library's own badge and panel: the real createOverlay from packages/core/src/overlay.ts, fed
 * the real report shape (fixture.ts). The frame number alone decides what the overlay shows, so any frame
 * renders the same on its own, which is what Remotion needs to render in parallel.
 *
 * Story, 15 s at 30 fps, and the last frame equals the first so the loop is clean:
 *   0.8-1.8  a finger comes up to Log in            1.8-2.2  the press: the screen is stuck for 400 ms
 *   2.2      the profile page appears, the badge reads 400 ms
 *   3.6      tap on the badge, the panel opens        5.1      tap on the row, it opens to the explanation
 *   7.2-10.6 drag up, down the component list         12.2     tap the close button
 *   13.2-14  the app goes back to the sign-in screen, the badge back to INP with a dash
 */

export const W = 720;
export const H = 1500;
export const FPS = 30;
export const DURATION = 450;

// Phone body inside the 720x1500 frame, then the screen inside the body.
const BODY = { x: 6, y: 6, w: 708, h: 1488, r: 108 };
const SCREEN = { x: 24, y: 24, w: 672, h: 1452, r: 90 };
// The overlay's panel is 372 px wide with 16 px either side, so the app is laid out 404 px wide and scaled to the screen.
const CSS_W = 404;
const SCALE = SCREEN.w / CSS_W;
const CSS_H = SCREEN.h / SCALE;

const ease = Easing.bezier(0.45, 0, 0.2, 1);
const span = (time: number, a: number, b: number) => interpolate(time, [a, b], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: ease });

/** What the overlay shows at a time: whether the page has an interaction, whether the panel is open, whether the row is open. */
function overlayState(time: number) {
  return {
    reported: time >= 2.25 && time < 13.6,
    open: time >= 3.65 && time < 12.25,
    expanded: time >= 5.15 && time < 12.25,
    scroll: span(time, 7.2, 10.6),
  };
}

const PRESSED: [number, number][] = [[1.8, 2.3], [3.6, 3.75], [5.1, 5.25], [7.0, 10.8], [12.2, 12.35]];
const pressedAt = (time: number) => PRESSED.some(([a, b]) => time >= a && time < b);

type Pt = { x: number; y: number };

export const Demo = ({ showFinger = true }: { showFinger?: boolean }) => {
  const frame = useCurrentFrame();
  const time = frame / FPS;
  const stage = useRef<HTMLDivElement>(null);
  const slot = useRef<HTMLDivElement>(null);
  const login = useRef<HTMLButtonElement>(null);
  const finger = useRef<HTMLDivElement>(null);
  const handle = useRef<OverlayHandle | null>(null);
  const live = useRef({ reported: false });
  const [ready, setReady] = useState(false);
  const [wait] = useState(() => delayRender('fonts'));

  useEffect(() => {
    loadFont({ family: 'Instrument Sans', url: staticFile('fonts/instrument-sans-latin.woff2'), weight: '400 700' })
      .catch(() => undefined)
      .then(() => {
        setReady(true);
        continueRender(wait);
      });
  }, [wait]);

  useLayoutEffect(() => {
    if (!stage.current || !slot.current) return;
    if (!handle.current) {
      const source = {
        reports: () => (live.current.reported ? [report] : []),
        inp: () => (live.current.reported ? inp : null),
        onInteraction: () => () => undefined,
        clear: () => undefined,
        stats: () => ({ mode: 'active', react: 'reading', unsupportedReason: null }),
        debug: { hook: () => ({ renderers: [], devtoolsLockedOut: false }) },
      };
      handle.current = createOverlay(source as never, { position: 'bottom-left' });
      const host = document.getElementById('react-inp-blame');
      if (host) slot.current.appendChild(host);
    }
    const overlay = handle.current;
    const root = (document.getElementById('react-inp-blame') as HTMLElement).shadowRoot as ShadowRoot;
    const want = overlayState(time);
    live.current.reported = want.reported;
    // Open first so the rows exist, bring the row to the wanted state, then close again if that is what the time says.
    overlay.open();
    const toggle = root.querySelector<HTMLElement>('.row .toggle');
    if (toggle && (toggle.getAttribute('aria-expanded') === 'true') !== want.expanded) toggle.click();
    if (!want.open) overlay.close();
    // The row's blame line in the words of the landing page's reference panel (apps/site/reference/hero-old.png),
    // the overlay's wording before 015005b. The overlay draws synchronously on open, close and toggle, so this
    // stays until the next frame draws it again.
    const line = root.querySelector<HTMLElement>('.row .blame:not(.later)');
    if (line) {
      const name = document.createElement('b');
      name.textContent = 'onClick';
      line.replaceChildren('most likely ', name, ' in SignInPage in the handler');
    }
    const panel = root.querySelector<HTMLElement>('.panel') as HTMLElement;
    const max = Math.max(0, panel.scrollHeight - panel.clientHeight);
    panel.scrollTop = want.open && want.expanded ? want.scroll * max : 0;

    // The finger, placed from where the overlay's own controls are.
    const box = stage.current.getBoundingClientRect();
    const at = (el: Element | null, dy = 0.5): Pt | null => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: (r.left + r.width / 2 - box.left) / SCALE, y: (r.top + r.height * dy - box.top) / SCALE };
    };
    const off: Pt = { x: CSS_W / 2, y: CSS_H + 70 };
    const pr = panel.getBoundingClientRect();
    const dragFrom: Pt = { x: (pr.left + pr.width / 2 - box.left) / SCALE, y: (pr.bottom - box.top) / SCALE - 70 };
    const dragTo: Pt = { x: dragFrom.x, y: dragFrom.y - 330 };
    const rowTop = at(root.querySelector('.row .toggle'), 0);
    const key: Record<string, Pt | null> = {
      off,
      login: at(login.current),
      badge: at(root.querySelector('.badge')),
      row: rowTop ? { x: rowTop.x, y: rowTop.y + 16 } : null,
      dragFrom,
      dragTo,
      x: at(root.querySelector('.x')),
    };
    const way: [number, string][] = [[0, 'off'], [0.8, 'off'], [1.7, 'login'], [2.3, 'login'], [3.5, 'badge'], [3.85, 'badge'], [4.6, 'row'], [5.35, 'row'], [6.1, 'dragFrom'], [7.2, 'dragFrom'], [10.6, 'dragTo'], [11.0, 'dragTo'], [11.9, 'x'], [12.45, 'x'], [13.2, 'off'], [15, 'off']];
    let pos = off;
    for (let i = 0; i < way.length - 1; i++) {
      const [a, ka] = way[i]!;
      const [b, kb] = way[i + 1]!;
      if (time >= a && time <= b) {
        const from = key[ka] ?? off;
        const to = key[kb] ?? off;
        // The drag follows the list's own scroll, so the finger and the content move together.
        const p = ka === 'dragFrom' && kb === 'dragTo' ? want.scroll : span(time, a, b);
        pos = { x: from.x + (to.x - from.x) * p, y: from.y + (to.y - from.y) * p };
        break;
      }
    }
    const f = finger.current;
    if (f) {
      const down = pressedAt(time);
      f.style.transform = `translate(${pos.x - 26}px, ${pos.y - 26}px) scale(${down ? 0.8 : 1})`;
      f.style.opacity = showFinger ? (down ? '0.95' : '0.7') : '0';
    }
  }, [frame, time, ready, showFinger]);

  useEffect(() => () => handle.current?.dispose(), []);

  const pressed = time >= 1.8 && time < 2.2;
  const profile = time >= 2.2 && time < 13.2 ? 1 : time >= 13.2 && time < 14 ? 1 - span(time, 13.2, 14) : 0;

  return (
    <div style={{ position: 'relative', width: W, height: H, background: 'transparent', fontFamily: '"Instrument Sans", system-ui, sans-serif' }}>
      {/* the phone body: dark titanium edge, a thin highlight, side buttons */}
      <svg width={W} height={H} style={{ position: 'absolute', inset: 0 }} aria-hidden="true">
        <defs>
          <linearGradient id="edge" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#5b5a72" />
            <stop offset="0.5" stopColor="#2a2938" />
            <stop offset="1" stopColor="#4a4960" />
          </linearGradient>
        </defs>
        <rect x={0} y={250} width={8} height={90} rx={4} fill="#2f2e3e" />
        <rect x={0} y={380} width={8} height={150} rx={4} fill="#2f2e3e" />
        <rect x={0} y={560} width={8} height={150} rx={4} fill="#2f2e3e" />
        <rect x={W - 8} y={420} width={8} height={210} rx={4} fill="#2f2e3e" />
        <rect x={BODY.x} y={BODY.y} width={BODY.w} height={BODY.h} rx={BODY.r} fill="url(#edge)" />
        <rect x={BODY.x + 5} y={BODY.y + 5} width={BODY.w - 10} height={BODY.h - 10} rx={BODY.r - 5} fill="#0a0910" />
      </svg>

      {/* the screen: the only opaque content besides the body */}
      <div style={{ position: 'absolute', left: SCREEN.x, top: SCREEN.y, width: SCREEN.w, height: SCREEN.h, borderRadius: SCREEN.r, overflow: 'hidden', background: '#f3f2fa' }}>
        <div ref={stage} style={{ position: 'absolute', left: 0, top: 0, width: CSS_W, height: CSS_H, transform: `scale(${SCALE})`, transformOrigin: '0 0', overflow: 'hidden', isolation: 'isolate', color: '#1a1928' }}>
          <SignIn buttonRef={login} pressed={pressed} />
          <div style={{ position: 'absolute', inset: 0, opacity: profile, background: '#f3f2fa' }}>
            <Profile />
          </div>
          <div style={{ position: 'absolute', top: 16, left: 34, fontSize: 15, fontWeight: 700 }}>9:41</div>
          <div style={{ position: 'absolute', top: 19, right: 32, display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ width: 17, height: 10, background: 'linear-gradient(90deg, #1a1928 0 25%, transparent 25% 30%, #1a1928 30% 55%, transparent 55% 60%, #1a1928 60% 85%, transparent 85% 90%, #1a1928 90%)', borderRadius: 1 }} />
            <span style={{ width: 24, height: 11, border: '1.5px solid #1a1928', borderRadius: 4, position: 'relative' }}>
              <i style={{ position: 'absolute', inset: 1.5, right: 5, background: '#1a1928', borderRadius: 1.5 }} />
            </span>
          </div>

          <div style={{ position: 'absolute', left: '50%', bottom: 7, width: 134, height: 5, marginLeft: -67, borderRadius: 3, background: '#1a1928', opacity: 0.85 }} />
          <div ref={slot} />
          <div ref={finger} style={{ position: 'absolute', left: 0, top: 0, width: 52, height: 52, borderRadius: 26, background: 'rgba(139,141,247,0.35)', border: '2px solid rgba(60,58,130,0.85)', boxShadow: '0 4px 14px rgba(20,19,40,0.35)', zIndex: 2147483647, pointerEvents: 'none', opacity: 0 }} />
        </div>
        {/* the camera island */}
        <div style={{ position: 'absolute', left: '50%', top: 22, width: 170, height: 48, marginLeft: -85, borderRadius: 24, background: '#06050a' }} />
      </div>
    </div>
  );
};

const SignIn = ({ buttonRef, pressed }: { buttonRef: React.RefObject<HTMLButtonElement | null>; pressed: boolean }) => (
  <div style={{ position: 'absolute', inset: 0, padding: '112px 22px 0' }}>
    <div style={{ fontSize: 15, fontWeight: 600, color: '#5a5875', marginBottom: 6 }}>Framely</div>
    <h1 style={{ margin: '0 0 24px', fontSize: 31, lineHeight: 1.1, fontWeight: 700, letterSpacing: '-0.01em' }}>Log in to Framely</h1>
    <div style={fieldStyle}>ada@framely.example</div>
    <div style={{ ...fieldStyle, letterSpacing: 3, fontSize: 20, lineHeight: '22px' }}>{'•'.repeat(12)}</div>
    <button
      ref={buttonRef}
      type="button"
      style={{
        width: '100%',
        height: 52,
        marginTop: 8,
        border: 0,
        borderRadius: 12,
        font: '700 17px "Instrument Sans", system-ui, sans-serif',
        color: '#ffffff',
        background: pressed ? '#3f41b8' : '#5b5ee6',
        transform: pressed ? 'scale(0.985)' : 'none',
      }}
    >
      Log in
    </button>
    <div style={{ marginTop: 18, color: '#5a5875', fontSize: 14 }}>Forgot your password?</div>
  </div>
);

const fieldStyle: React.CSSProperties = {
  height: 52,
  display: 'flex',
  alignItems: 'center',
  padding: '0 16px',
  marginBottom: 12,
  background: '#ffffff',
  border: '1.5px solid #c9c7dc',
  borderRadius: 12,
  fontSize: 16,
  color: '#2b2a40',
};

const Profile = () => (
  <div style={{ padding: '100px 18px 0' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
      <div style={{ width: 62, height: 62, borderRadius: 31, background: 'linear-gradient(135deg, #8b8df7, #34d3b6)' }} />
      <div>
        <div style={{ fontSize: 22, fontWeight: 700 }}>Ada Reyes</div>
        <div style={{ fontSize: 14, color: '#5a5875' }}>240 photos</div>
      </div>
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4, marginTop: 22 }}>
      {Array.from({ length: 15 }, (_, i) => (
        <div key={i} style={{ aspectRatio: '1', borderRadius: 4, background: `linear-gradient(135deg, hsl(${(i * 47) % 360} 70% 76%), hsl(${((i * 47) % 360) + 50} 70% 56%))` }} />
      ))}
    </div>
  </div>
);
