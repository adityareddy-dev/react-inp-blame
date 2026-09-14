import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { InteractionReport } from 'inpector';
import { onInteraction } from 'inpector';
import { burn } from '../burn';
import { Entry, Pill, titleFor } from '../ReportCard';
import { journey, type Step } from './journey';

interface Profile {
  handle: string;
  name: string;
  posts: number;
  followers: number;
  following: number;
  photos: number[];
}

/** Pretends to be the server. 450 ms is a realistic round trip on a phone. */
function fetchProfile(email: string): Promise<Profile> {
  const handle = (email.split('@')[0] || 'you').replace(/[^a-z0-9._]/gi, '').toLowerCase() || 'you';
  return new Promise((resolve) =>
    setTimeout(
      () =>
        resolve({
          handle,
          name: handle.replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
          posts: 240,
          followers: 1284,
          following: 312,
          photos: Array.from({ length: 240 }, (_, i) => (i * 47) % 360),
        }),
      450,
    ),
  );
}

/** Realistic mistake: a strength score computed synchronously on every keystroke. */
function passwordStrength(pw: string): number {
  burn(90);
  let s = 0;
  if (pw.length >= 8) s++;
  if (/[A-Z]/.test(pw)) s++;
  if (/[0-9]/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  return s;
}

/** Realistic mistake: hashing the password on the main thread before sending it. */
function hashPassword(pw: string): string {
  burn(260);
  let h = 0;
  for (let i = 0; i < pw.length; i++) h = (h * 31 + pw.charCodeAt(i)) | 0;
  return h.toString(16);
}

export function SignInDemo() {
  const [profile, setProfile] = useState<Profile | null>(null);
  useEffect(() => onInteraction((r) => journey.upsertReport(r)), []);
  return (
    <>
      <div className="topbar">
        <span>
          <b>Framely</b> · a sign-in flow with three realistic mistakes, measured as you use it
        </span>
        <a href="#lab/context-storm">Anti-pattern lab →</a>
      </div>
      <div className="shell">
        <div className="stage">
          {profile ? (
            <ProfilePage
              profile={profile}
              onReset={() => {
                journey.reset();
                setProfile(null);
              }}
            />
          ) : (
            <SignInPage onSignedIn={setProfile} />
          )}
        </div>
        <Journey />
      </div>
    </>
  );
}

function SignInPage({ onSignedIn }: { onSignedIn: (p: Profile) => void }) {
  // Mistake 1: the email lives here, so every keystroke re-renders the phone preview below.
  const [email, setEmail] = useState('');
  const [hasPassword, setHasPassword] = useState(false);
  const passwordRef = useRef('');
  const [status, setStatus] = useState<'idle' | 'loading'>('idle');

  function onEmailChange(e: React.ChangeEvent<HTMLInputElement>) {
    setEmail(e.target.value);
  }
  // Mistake 3: the click hashes the password synchronously before the request goes out.
  function handleLogin() {
    hashPassword(passwordRef.current);
    setStatus('loading');
    const at = performance.now();
    fetchProfile(email).then((p) => {
      journey.wait('Waiting for the server', performance.now() - at, at);
      onSignedIn(p);
    });
  }

  return (
    <div className="login">
      <PhonePreview email={email} />
      <div>
        <form className="card-ig" onSubmit={(e) => e.preventDefault()}>
          <h1 className="wordmark">Framely</h1>
          <input className="field" data-test="email" placeholder="Phone number, username, or email" value={email} onChange={onEmailChange} autoComplete="off" />
          <PasswordField
            onChange={(v) => {
              passwordRef.current = v;
              setHasPassword(v.length > 0);
            }}
          />
          <button className="btn" type="button" data-test="login" onClick={handleLogin} disabled={status === 'loading' || !email || !hasPassword}>
            Log in
          </button>
          <div className="hint" style={{ textAlign: 'center', marginTop: 8 }}>{status === 'loading' ? 'Signing you in…' : ''}</div>
          <div className="or">OR</div>
          <a href="#" onClick={(e) => e.preventDefault()} style={{ fontSize: 12, color: '#00376b' }}>
            Forgot password?
          </a>
        </form>
        <div className="card-ig small">
          Don't have an account?{' '}
          <a href="#" onClick={(e) => e.preventDefault()}>
            Sign up
          </a>
        </div>
      </div>
    </div>
  );
}

/** Owns its own state, so typing here re-renders only this field and the meter. */
function PasswordField({ onChange }: { onChange: (value: string) => void }) {
  const [password, setPassword] = useState('');
  const [strength, setStrength] = useState(0);
  // Mistake 2: the strength score is computed in the handler, on the main thread, per keystroke.
  function onPasswordChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value;
    setPassword(v);
    setStrength(passwordStrength(v));
    onChange(v);
  }
  return (
    <>
      <input className="field" data-test="password" type="password" placeholder="Password" value={password} onChange={onPasswordChange} autoComplete="off" />
      <div className="strength">
        <i style={{ width: `${strength * 25}%` }} />
      </div>
      <div className="hint">{password ? ['Too short', 'Weak', 'Okay', 'Good', 'Strong'][strength] : ''}</div>
    </>
  );
}

/**
 * The preview greets you by the email you are typing, so it takes `email` as a prop and
 * re-renders on every keystroke in that field. The 1000 tiles below it are not memoised,
 * so they all come along. Password keystrokes never reach it: memo() bails out.
 */
const PhonePreview = memo(function PhonePreview({ email }: { email: string }) {
  return (
    <div className="phone">
      <div className="screen">
        <div className="top">Framely</div>
        <div className="hint" style={{ padding: '6px 16px 4px' }}>{email ? `Hi ${email.split('@')[0]}` : 'Welcome back'}</div>
        <FeedPreview />
      </div>
    </div>
  );
});

function FeedPreview() {
  return (
    <div className="feed">
      {Array.from({ length: 1000 }, (_, i) => (
        <PostTile key={i} hue={(i * 37) % 360} />
      ))}
    </div>
  );
}

function PostTile({ hue }: { hue: number }) {
  burn(0.07);
  return <div className="post" style={{ '--h': hue } as React.CSSProperties} />;
}

function ProfilePage({ profile, onReset }: { profile: Profile; onReset: () => void }) {
  return (
    <div className="profile">
      <div className="profile-head">
        <div className="avatar">
          <div />
        </div>
        <div>
          <h2>{profile.handle}</h2>
          <div className="stats">
            <span>
              <b>{profile.posts}</b> posts
            </span>
            <span>
              <b>{profile.followers.toLocaleString()}</b> followers
            </span>
            <span>
              <b>{profile.following}</b> following
            </span>
          </div>
          <div>
            <b>{profile.name}</b>
          </div>
          <div style={{ color: '#555' }}>Signed in. Every photo below measured itself while rendering, which is the fourth mistake.</div>
          <p>
            <button className="linkbtn" data-test="reset" onClick={onReset}>
              Start over
            </button>
          </p>
        </div>
      </div>
      <div className="grid-ig" data-test="photos">
        {profile.photos.map((h, i) => (
          <PhotoTile key={i} hue={h} />
        ))}
      </div>
    </div>
  );
}

/** Mistake 4: each tile sets a style then reads the grid's size in a layout effect. 240 forced layouts. */
function PhotoTile({ hue }: { hue: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    el.style.setProperty('--h', String(hue));
    el.dataset.w = String(el.parentElement!.getBoundingClientRect().width);
  }, [hue]);
  burn(0.25);
  return <div ref={ref} className="photo" />;
}

type Row = { key: string; kind: 'group'; reports: InteractionReport[] } | { key: string; kind: 'wait'; label: string; ms: number };

const isTyping = (r: InteractionReport) => /key press|typing/.test(r.explanation.headline);

/** Consecutive key presses in the same field collapse into one row. */
function toRows(steps: Step[]): Row[] {
  const rows: Row[] = [];
  for (const s of steps) {
    if (s.kind === 'wait') {
      rows.push({ key: s.id, kind: 'wait', label: s.label, ms: s.ms });
      continue;
    }
    const r = s.report;
    const last = rows[rows.length - 1];
    if (isTyping(r) && last && last.kind === 'group' && isTyping(last.reports[0]) && last.reports[0].target?.selector === r.target?.selector) {
      last.reports.push(r);
    } else {
      rows.push({ key: s.id, kind: 'group', reports: [r] });
    }
  }
  return rows;
}

function GroupEntry({ reports }: { reports: InteractionReport[] }) {
  const slowest = reports.reduce((a, b) => (b.duration > a.duration ? b : a));
  const { title, subtitle } = titleFor(slowest);
  if (reports.length === 1) return <Entry report={slowest} title={title} subtitle={subtitle} compact />;
  const sorted = reports.map((r) => r.duration).sort((a, b) => a - b);
  const typical = Math.round(sorted[Math.floor(sorted.length / 2)]);
  return <Entry report={slowest} title={title} subtitle={`${reports.length} key presses · slowest ${Math.round(slowest.duration)} ms · typical ${typical} ms · ${subtitle ?? ''}`} compact />;
}

function Journey() {
  const [steps, setSteps] = useState<Step[]>(journey.steps());
  useEffect(() => journey.subscribe(setSteps), []);
  const rows = toRows(steps);
  const reports = steps.filter((s): s is Extract<Step, { kind: 'interaction' }> => s.kind === 'interaction').map((s) => s.report);
  const worst = reports.reduce<InteractionReport | null>((w, r) => (!w || r.duration > w.duration ? r : w), null);
  return (
    <aside className="journey" data-test="journey">
      <h3>What took time</h3>
      <p className="muted">Every interaction on this page, in order. INP, Interaction to Next Paint, is the slowest of them.</p>
      {rows.length === 0 && <div className="empty">Type an email and a password, then log in. Each step shows up here as it happens.</div>}
      {rows.map((row) =>
        row.kind === 'wait' ? (
          <div className="wait" key={row.key}>
            <span>{row.label}</span>
            <b>{Math.round(row.ms)} ms</b>
          </div>
        ) : (
          <GroupEntry key={row.key} reports={row.reports} />
        ),
      )}
      {worst && (
        <div className="inp" data-test="inp">
          Page INP so far
          <b>{Math.round(worst.duration)} ms</b>
          <Pill rating={worst.explanation.rating} /> from {titleFor(worst).title.toLowerCase()}
        </div>
      )}
    </aside>
  );
}
