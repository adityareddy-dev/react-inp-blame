import { expect, test, type Page } from '@playwright/test';
import type { CommitSummary, EventEntrySummary, InteractionReport } from 'react-inp-blame';
import { clearReports, settle, testAttribute } from './page';

const prod = process.env.INP_MODE === 'prod';
const EMAIL = 'ada@example.com';
const PASSWORD = 'Hunter2!';

/** A keydown as a capture listener on the window saw it: the field it landed on and its `timeStamp`, which is its entry's `startTime`. */
interface Keydown {
  field: string;
  ts: number;
}

const near = (a: number, b: number) => Math.abs(a - b) <= 1;

/** The entry is the input the commit is stamped with: the same event, and a keypress stands for its keydown. */
const sameInput = (e: EventEntrySummary, c: CommitSummary) => (e.name === c.inputType || (e.name === 'keypress' && c.inputType === 'keydown')) && near(e.startTime, c.inputTs);

const exact = (r: InteractionReport) => [...r.commits, ...r.followUps].filter((c) => c.joinedBy === 'exact');

/** The entry the report is headed by: the longest, which `start` and `duration` are. */
const headline = (r: InteractionReport) => r.entries.find((e) => e.startTime === r.start && e.duration === r.duration) ?? r.entries[0]!;

const fieldOf = (r: InteractionReport) => (r.target?.selector?.includes(testAttribute('email')) ? 'email' : r.target?.selector?.includes(testAttribute('password')) ? 'password' : 'other');

/** Waits until no report has been revised for a while: a keyup's entry, or a long animation frame, can revise one after it was published. */
async function quiet(page: Page): Promise<void> {
  let seen = -1;
  for (let i = 0; i < 20; i++) {
    const revisions = await page.evaluate(() => window.__REACT_INP_BLAME__.reports().reduce((a, r) => a + r.revision + 1, 0));
    if (revisions === seen) return;
    seen = revisions;
    await page.waitForTimeout(750);
  }
}

/**
 * What is wrong with the reports of a run: every keystroke has one report and one commit stamped with its
 * keydown, a commit is exact in one report at most and there matches an entry of its own type, and each
 * report blames what took its time. A keyup whose paint came after the next key press's render heads its
 * report, and that report holds no render of its own and says its frame waited on that key press.
 */
function problemsOf(reports: InteractionReport[], commits: CommitSummary[], keydowns: Keydown[]): string[] {
  const problems: string[] = [];
  for (const k of keydowns) {
    const holding = reports.filter((r) => r.entries.some((e) => e.name === 'keydown' && near(e.startTime, k.ts)));
    if (holding.length !== 1) problems.push(`the ${k.field} keydown at ${k.ts} is in ${holding.length} reports`);
    const stamped = commits.filter((c) => c.inputType === 'keydown' && near(c.inputTs, k.ts));
    if (stamped.length !== 1) problems.push(`the ${k.field} keydown at ${k.ts} has ${stamped.length} commits stamped with it`);
  }
  const holders = new Map<string, number>();
  for (const r of reports) {
    const at = `report ${r.interactionId} (${fieldOf(r)}, ${headline(r).name} at ${r.start})`;
    if (!keydowns.some((k) => r.entries.some((e) => e.name === 'keydown' && near(e.startTime, k.ts)))) problems.push(`${at} holds no keystroke`);
    if (r.unjoinedCommits !== 0) problems.push(`${at} has ${r.unjoinedCommits} unjoined commits`);
    for (const c of exact(r)) {
      const key = `${c.inputType}@${c.inputTs}:${c.at}`;
      holders.set(key, (holders.get(key) ?? 0) + 1);
      if (!r.entries.some((e) => sameInput(e, c))) problems.push(`${at} holds the ${c.inputType} commit at ${c.inputTs} as exact, and no entry of its own is that input`);
    }
    const { blame } = r.explanation;
    if (headline(r).name === 'keyup') {
      if (blame.kind === 'none' || blame.kind === 'script') problems.push(`${at} blames ${blame.kind}`);
      if (exact(r).length) problems.push(`${at} holds ${exact(r).length} exact commits`);
      // The next key's handler ran before the paint, so the frame waited on it, and the report says so.
      if (!/: the frame (most likely )?waited on the next key press, which the page handled first\./.test(r.explanation.cause)) problems.push(`${at} says ${r.explanation.cause}`);
    } else if (fieldOf(r) === 'email') {
      if (blame.kind !== 'render' || blame.name !== 'FeedPreview') problems.push(`${at} blames ${blame.kind} ${blame.name}`);
      if (!exact(r).some((c) => c.rendered >= 1000)) problems.push(`${at} holds no render of 1000 components`);
    } else if (fieldOf(r) === 'password') {
      const handler = prod ? 'onChange' : 'onPasswordChange';
      if (blame.kind !== 'handler' || blame.name !== handler) problems.push(`${at} blames ${blame.kind} ${blame.name}`);
    } else {
      problems.push(`${at} is on no field`);
    }
  }
  for (const [key, n] of holders) if (n > 1) problems.push(`the commit ${key} is exact in ${n} reports`);
  return problems;
}

// Typing as fast as Playwright can means the next key press often lands before React's own task for what
// the page's report listener set, and before the frame the last keyup paints in. Every report is checked,
// not only the slowest: a keystroke that lost its render, or took the next one's, is still a report.
for (const [run, delay] of [
  [1, 0],
  [1, 60],
  [2, 60],
  [3, 60],
] as const) {
  test(`typing ${delay} ms apart keeps each keystroke's render on its own report, run ${run}`, async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-test=email]');
    await settle(page);
    await page.evaluate(() => {
      const seen: Keydown[] = [];
      (window as unknown as { keydowns: Keydown[] }).keydowns = seen;
      window.addEventListener('keydown', (e) => seen.push({ field: (e.target as HTMLElement).dataset?.test ?? '', ts: e.timeStamp }), { capture: true });
    });
    await clearReports(page);

    await page.locator('[data-test=email]').pressSequentially(EMAIL, { delay });
    await page.locator('[data-test=password]').pressSequentially(PASSWORD, { delay });
    // Each email keystroke renders 1000 tiles and each password one scores it for 110 ms, so every keystroke is reported.
    await page.waitForFunction((n) => window.__REACT_INP_BLAME__.reports().length >= n, EMAIL.length + PASSWORD.length, { timeout: 15_000 });
    await quiet(page);

    const { reports, commits, keydowns } = await page.evaluate(() => ({
      reports: window.__REACT_INP_BLAME__.reports(),
      commits: window.__REACT_INP_BLAME__.debug.commits(),
      keydowns: (window as unknown as { keydowns: Keydown[] }).keydowns,
    }));
    const problems = problemsOf(reports, commits, keydowns);
    const keyups = reports.filter((r) => headline(r).name === 'keyup');
    await test.info().attach('typing', {
      body: JSON.stringify({ delay, keydowns: keydowns.length, reports: reports.length, commits: commits.length, keyupHeaded: keyups.length, problems, keyupVerdicts: keyups.map((r) => r.verdict) }, null, 2),
      contentType: 'application/json',
    });
    expect(keydowns).toHaveLength(EMAIL.length + PASSWORD.length);
    expect(problems).toEqual([]);
  });
}
