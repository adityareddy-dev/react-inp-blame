import { aboveRoots, ANONYMOUS, dominantComponent, frameworkLayers, frameworkWrappers, heaviest, leafName, MINIFIED_NAMES_NOTE, minifiedAmongReadable, mostlyComponent, namesLookMinified, readableName, startName } from './commits.js';
import { controlAround, elementOf, selector } from './element.js';
import { fiberFromNode, handlerOf, namingFiber, ownersOf } from './fiber.js';
import { DEFAULT_INPUT_WINDOW, INPUT_TYPES, joinWindow, type InputRecord, type ReactPage } from './hook.js';
import { rateInp } from './inp.js';
import { unexplainedReports } from './install-state.js';
import type { PageNavigation } from './navigation.js';
import type { InteractionTiming } from './observe.js';
import type { Blame, CommitSummary, EventEntrySummary, Explanation, FrameSummary, Hydration, InteractionReport, Phase, ReactStatus, ScriptSummary, StartedNavigation, TargetInfo } from './types.js';
import { dropped } from './warn.js';

// A commit's input stamp and an entry's startTime are the same clock (Event.timeStamp), so
// they agree to the timer's resolution; 1 ms covers the coarsening.
const STAMP_TOLERANCE = 1;
// Handlers whose processing differs by less than this did about the same work, and the handler named
// for them is the best-known event's (see byWork). Chromium gives processing times to 0.1 ms, and a
// handler that does nothing takes under 2 ms.
const HANDLER_TIE_MS = 4;
// Entries presented in the same frame share a render time to within 8 ms, the rounding
// Event Timing applies to durations. Same rule as web-vitals' groupEntriesByRenderTime.
const RENDER_GROUP_MS = 8;

// What the explanation blames and says is decided by the thresholds below. Each is a judgement of
// what is worth naming; the reasons were checked against the demo's scenarios on React 17, 18 and
// 19, development and production builds, with this library's own walk left out of `processing`.

// Working time outside React's render names the handler from 25 ms: shorter, it does not make an
// interaction slow on its own (it is under two frames at 60 Hz).
const HANDLER_MIN_MS = 25;
// It also has to be a quarter of the working time: committing a large render (DOM writes, effects)
// is outside React's render durations too, and took a fifth of it on the demo's 1441-row list.
const HANDLER_MIN_SHARE = 0.25;
// A render with durations earns the blame from 5 ms, a third of a frame; less made nothing slow.
const RENDER_MIN_MS = 5;
// A render known only by its counts earns it from 10 components; fewer is a small update, a counter or a status line.
const RENDER_MIN_COMPONENTS = 10;
// From 50 when a handler is named, since counts cannot weigh a render against a slow handler: the
// demo's password field re-renders 2 components beside a handler that runs for 110 ms.
const RENDER_MIN_COMPONENTS_BESIDE_HANDLER = 50;
// A count this large is a slow render under a long task too, where nothing measured it and the working time was the
// larger part: hyperdx re-rendered 3104 components in 38 ms of working time and the sentence said the rest went to
// waiting and painting. The Sheet's 59 and excalidraw's 149, which had to stay unblamed, are far under it.
const RENDER_MIN_COMPONENTS_UNMEASURED = 1000;
// Past that line the count has to explain the working time as well, in one of two ways. Fifty of one
// component is a list, and a list costs its row times its length whatever the row costs: 150 SlowRow in
// 160 ms, 250 Section in 2.5 s. Fifty different components rendered once each are a tree, whose cost is
// the sum of as many unknowns, most of them small: Radix closing a menu re-renders 85 of them inside 209 ms
// of working time, 200 of which the item's onSelect took. A tree beside a handler is the blame only while
// the working time comes to 2 ms a component at most, a few times what a component takes to render once in
// a production build; past that the time has room in it for the handler, one unknown with a name.
const RENDER_MAX_MS_PER_COMPONENT_BESIDE_HANDLER = 2;
// Where React timed each component, a render's time is put on one component's own render, its time less
// that of the components it rendered, from 25 ms: the line the handler is held to, since under that one
// piece of the app's code does not make an interaction slow on its own. The component has to have rendered
// once, and its own render has to be half of the commit's render time or more, the total the sentence
// prints. Under half, most of the time is in the components under it, and naming the one would send the
// reader after the smaller part. TanStack Table sorting 200,000 rows spent 257 of 277 ms in TableBody's own
// render and about 17 in the components under it; told only "637 components", a reader memoises the rows
// and gains nothing.
const OWN_RENDER_MIN_MS = HANDLER_MIN_MS;
const OWN_RENDER_MIN_SHARE = 0.5;
// A commit's committing and effects are worth saying beside its render from 5 ms and a fifth of its time in all.
const COMMIT_PHASES_MIN_MS = RENDER_MIN_MS;
const COMMIT_PHASES_MIN_SHARE = 0.2;
// A render is named where it started where the end of its hot path is shown to have taken under half of it.
const LEAF_MAX_SHARE = 0.5;
// A Long Animation Frames script is named from 20 ms of it inside the interaction: the API lists
// scripts from 5 ms, and one under 20 did not make its frame long by itself (a long frame is over 50 ms).
const SCRIPT_MIN_MS = 20;
// Waiting, the screen update, and working time without durations are blamed from 50 ms, the length
// of a long task: the least the browser itself calls long. A render known only by its counts is
// working time without durations, and is held to it (see `countEarns`). A wait Event Timing places
// in an earlier entry's screen update can be blamed under it (`pressWaitLeads`), and so can a count a
// long animation frame measured the handler's script holding (`measuredHolder`).
const LONG_TASK_MS = 50;
// A script the input waited behind gives a waiting blame its name from half of the wait. Under that
// the wait was mostly something the browser did not list (another frame's work, rendering, garbage
// collection), and the name would send the reader after the smaller part of it. The same half holds
// for the listener that names a handler blame React had no name for, and for the script after the
// handlers that the screen update is said to have waited on.
const WAITED_BEHIND_MIN_SHARE = 0.5;
/** How much of a wait between handlers long animation frames have to cover for the sentence to say what filled it from them. */
const FRAMES_COVER_SHARE = 0.9;
// Time between handlers before the next input, with nothing on record running, is said from a tenth of the
// time between on. Under that it is the odd moment between two tasks, not a key or a button held down.
const HELD_SAID_SHARE = 0.1;
// A later render is worth a sentence from 10 ms or 25 components. Less is the page settling after the
// paint, a spinner going away or a status line changing, which is not what anyone was waiting for.
const LATER_MIN_MS = 10;
const LATER_MIN_COMPONENTS = 25;
// Forced layout is worth a sentence from 4 ms, a quarter of a frame. It is Long Animation Frames'
// forcedStyleAndLayoutDuration, style recalculation and layout together, so the sentences say both: opening
// a shadcn/ui Sheet, a Chrome trace put about 80 ms of it on styles and 1 ms on layout.
const FORCED_LAYOUT_MIN_MS = 4;
// It takes the blame instead from half of the window it was counted across, on top of the long task
// above. Several things share that window (the handler, React's render, the commit, this library's own
// read), so half of it is what makes the layout the answer rather than one line of it; it is weighed
// against React's render, and a production build measures no render at all, which is exactly where
// this has to hold.
const FORCED_LAYOUT_MIN_SHARE = 0.5;
/** The share of a forced layout that has to be outside React's commit, by the scripts it was charged to or by what the commit took, for the sentence to rule a layout effect out. */
const FORCED_LAYOUT_IN_REACT_SHARE = 0.5;
// Where no render was timed (a production build, or no commit joined at all), the long task is too
// high a bar: on the shadcn docs a sheet opened with 44 to 49 ms of layout in 55 ms of working time,
// and the blame went to a render known only by its counts, then back to the layout on the run where
// it reached 50. There the layout is the only measured duration in the window, so it is held to what
// the handler is: under 25 ms it did not make the interaction slow on its own.
const FORCED_LAYOUT_MIN_MS_NO_DURATIONS = HANDLER_MIN_MS;
// The browser charges forced layout per script, so a window holding several of them holds several
// totals. One script has to account for nine tenths of the layout before its name is used as where
// the layout happened: below that the name would be a claim about a cost the other scripts share, and
// a reader following it optimises whichever one the library happened to sort first. The sentence
// still names the largest and says how much of the total it holds, because that much is a fact.
const FORCED_LAYOUT_ONE_SCRIPT_SHARE = 0.9;
// The screen update gets a note of its own over 100 ms, half of INP's 200 ms budget for "good".
const PRESENTATION_NOTE_MS = 100;
// A render under a long task that the screen update outran gets a note where the working time was half of that update.
const OUTRAN_RENDER_MIN_SHARE = 0.5;
// Where no script after the handlers held half of the screen update, it is put on the browser's own work
// from half of it, the share that lets a script name a wait.
const BROWSER_WORK_MIN_SHARE = 0.5;
// React's scheduler runs its work from a MessageChannel, so Long Animation Frames names its tasks after the port.
const REACT_TASK = 'MessagePort.onmessage';
// The functions react-dom attaches as its listeners on a root, by the names a build that keeps them gives.
const REACT_LISTENER = /^(bound )?dispatch(Discrete|Continuous)Event$/;
const READS_SIZE = "That happens when code reads an element's size right after changing styles";
const USUAL_READ = `${READS_SIZE}, often in a layout effect.`;
// A press held around the interaction is worth a note from 100 ms; an ordinary click is shorter.
const HOLD_NOTE_MS = 100;
// A later render without durations is given a frame's length, to find the long animation frames it ran in.
const FRAME_MS = 16;

// A label names the clicked element; it is not a copy of it. The element can be a list of 3000
// rows, and reading all of its text would cost more than the rest of the report, so at most its
// first run of text is read, and at most 40 characters of the name inside a label are kept.
const LABEL_CHARS = 40;
// Elements whose text is never on the screen, so it cannot be what a reader knows the target by.
const UNSEEN_TEXT_TAGS = ['noscript', 'script', 'style', 'template'];
// Nodes the search for that first run of text looks at: enough to get past an icon, not to crawl a table.
const LABEL_NODES = 32;
// Siblings joined into that run once it starts, the separators between them counted: an interpolated
// string is a handful of nodes, so a long row of them is a list, not a label.
const RUN_NODES = 16;
// The elements a person types or picks a value in: one the page made editable, and one with a text field's
// role. The text inside one is that value, so it is named the way a form field is. A mention chip an editor
// marks contenteditable="false" is still inside the editor. The browser reads "FALSE" as "false", and a
// selector compares a value that way only with the i flag.
const TYPED_IN = '[contenteditable]:not([contenteditable="false" i]),[role="textbox"],[role="searchbox"],[role="combobox"],[role="spinbutton"]';
// How many elements above the one an input landed on are asked whether an EditContext is attached. An
// editor built on one takes key presses in the element it is attached to and draws what was typed inside
// it, a word in a line, and nothing in the markup says so, so it is looked for the way a control is, not
// by a selector.
const EDIT_CONTEXT_ANCESTORS = 5;
const TEXT_NODE = 3;
const COMMENT_NODE = 8;
const PREFERRED = ['click', 'keydown', 'input', 'keypress', 'keyup', 'pointerup', 'mouseup', 'pointerdown', 'mousedown'];
const FRIENDLY: Record<string, string> = {
  click: 'click',
  mousedown: 'click',
  mouseup: 'click',
  pointerdown: 'click',
  pointerup: 'click',
  keydown: 'key press',
  keyup: 'key press',
  keypress: 'key press',
  input: 'typing',
  change: 'typing',
};
const TYPING_EVENTS = ['keydown', 'keyup', 'keypress', 'input', 'change'];
const POINTER_EVENTS = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup'];

/** Where a target's label may come from, once `InstallOptions.labels` is settled for the page's React build. */
export type LabelSource = 'text' | 'attributes';

/**
 * A report's fields apart from the explanation and verdict. The functions below take and return
 * these and never change one; the lifecycle seals each revision into the report it publishes.
 */
export type ReportData = Omit<InteractionReport, 'explanation' | 'verdict'>;

interface PaintGroup {
  renderTime: number;
  processingStart: number;
  processingEnd: number;
  entries: InteractionTiming[];
}

/**
 * What a person would call the interaction: "click", "tap", "key press" or "typing", from the event type
 * and, for a pointer event, the pointer it came from (a finger's or a pen's press is a tap, any other a
 * click, since a press whose pointer was not seen may have been a mouse's). Display text.
 */
export function kindOf(type: string, pointerType?: string | null): string {
  if ((pointerType === 'touch' || pointerType === 'pen') && POINTER_EVENTS.includes(type)) return 'tap';
  return FRIENDLY[type] || type;
}

/** A key press or typing, decided on the event type, not on the words `kindOf` picks. */
export const isTypingEvent = (type: string): boolean => TYPING_EVENTS.includes(type);

/** A click or a tap, decided on the event type. */
export const isPointerEvent = (type: string): boolean => POINTER_EVENTS.includes(type);

/** A later render worth a sentence, rather than the page settling after the paint. */
const worthMentioning = (c: CommitSummary) => (c.hasDurations ? c.total >= LATER_MIN_MS : c.rendered >= LATER_MIN_COMPONENTS);

/** A render with real work in it, the kind the blame weighs and the "rendered N times" note needs two of to be said; a status pill updating is not one. */
export const carriesWork = (c: CommitSummary) => (c.hasDurations ? c.total >= RENDER_MIN_MS : c.rendered >= RENDER_MIN_COMPONENTS);

/** A commit whose numbers stand on their own: durations measured on a clock fine enough for them, joined by its exact input stamp, walked in full. */
const measuredCommit = (c: CommitSummary) => c.hasDurations && !c.coarseClock && c.joinedBy === 'exact' && !c.truncated;

/**
 * A commit whose *names* stand on their own, which is a weaker thing to ask than `measuredCommit`:
 * that it is this interaction's work and not something that merely overlapped it, and that the walk
 * reached the end of the tree it is about to name. Render durations have nothing to do with it, so a
 * production build's subtree and component counts are as good here as a profiling build's.
 */
const namesThisInteraction = (c: CommitSummary) => c.joinedBy === 'exact' && !c.truncated;

/** Entries whose paint landed within 8 ms of each other were presented by one frame. */
function groupByRenderTime(entries: readonly InteractionTiming[]): PaintGroup[] {
  const groups: PaintGroup[] = [];
  for (const e of entries) {
    const renderTime = e.startTime + e.duration;
    let group: PaintGroup | undefined;
    for (let i = groups.length - 1; i >= 0 && !group; i--) {
      const g = groups[i];
      if (g && Math.abs(renderTime - g.renderTime) <= RENDER_GROUP_MS) group = g;
    }
    if (group) {
      group.processingStart = Math.min(group.processingStart, e.processingStart);
      group.processingEnd = Math.max(group.processingEnd, e.processingEnd);
      group.entries.push(e);
    } else {
      groups.push({ renderTime, processingStart: e.processingStart, processingEnd: e.processingEnd, entries: [e] });
    }
  }
  return groups;
}

/** The paint group `entry` falls in. */
function paintGroupOf(entries: readonly InteractionTiming[], entry: InteractionTiming): PaintGroup {
  for (const group of groupByRenderTime(entries)) if (group.entries.includes(entry)) return group;
  return { renderTime: entry.startTime + entry.duration, processingStart: entry.processingStart, processingEnd: entry.processingEnd, entries: [entry] };
}

const near = (a: number, b: number) => Math.abs(a - b) <= STAMP_TOLERANCE;

/**
 * An input of the interaction: an entry's `startTime`, and the types of input the ring can record it
 * as (`InputRecord.type`); null where it is none the ring records, an `input` while an input method
 * composes, which is matched by its time alone.
 */
interface Stamp {
  readonly at: number;
  readonly types: readonly string[] | null;
}

/** The inputs that begin a press. A release's `gestureTs` is one of these. */
const PRESSES: readonly string[] = ['pointerdown', 'keydown'];

/**
 * A listener, as Long Animation Frames names it (`DIV#root.onkeydown`), for a press, or for an event the press
 * dispatches in the same task, right after its own handlers: a key's (the second group), whose `input` is where
 * React's onChange runs, or a pointer's (the third), or for a pointer's release and its click (the fourth).
 */
const PRESS_LISTENER = /\.on(keydown|pointerdown|(keypress|beforeinput|input)|(mousedown|touchstart)|(pointerup|mouseup|click))$/;

/** Whether `a` comes after `b`, compared element by element. */
function isAfter(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    const [x, y] = [a[i] ?? 0, b[i] ?? 0];
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * An entry as a stamp. A keypress is fired by its keydown and has that keydown's time, and so do a
 * mousedown and a mouseup their pointer events', so each stands for the input the ring recorded.
 */
function stampOf(e: Pick<EventEntrySummary, 'name' | 'startTime'>): Stamp {
  const type = e.name === 'keypress' ? 'keydown' : e.name === 'mousedown' ? 'pointerdown' : e.name === 'mouseup' ? 'pointerup' : e.name;
  return { at: e.startTime, types: INPUT_TYPES.includes(type) ? [type] : null };
}

const stampsOf = (entries: readonly Pick<EventEntrySummary, 'name' | 'startTime'>[]): Stamp[] => entries.map(stampOf);

/**
 * Is this stamp the input the ring recorded at `ts` as `type`? By type as well as time: typing fast,
 * the next key's keydown can come under a millisecond after the last keyup, and a render stamped with
 * that keydown is not the keyup's.
 */
const isInput = (s: Stamp, ts: number, type: string) => near(s.at, ts) && (!s.types || s.types.includes(type));

/** Is this stamp the press, a pointerdown or a keydown, that began a gesture at `ts`? A release's press is only ever one of those. */
const isPress = (s: Stamp, ts: number) => near(s.at, ts) && (!s.types || s.types.some((t) => PRESSES.includes(t)));

/** Does this input stamp, a commit's or a navigation's (or the press that input released), match one of these stamps? */
function stampMatches(c: Pick<CommitSummary, 'inputTs' | 'inputType' | 'gestureTs'>, stamps: readonly Stamp[]): boolean {
  return stamps.some((s) => isInput(s, c.inputTs, c.inputType) || isPress(s, c.gestureTs));
}

const rank = (name: string) => {
  const i = PREFERRED.indexOf(name);
  return i < 0 ? PREFERRED.length : i;
};

/**
 * The entries whose handler is looked for, in PREFERRED order: those whose own processing ran within less
 * than HANDLER_TIE_MS of the longest. The event whose handlers did the work is the one to name, so a menu
 * that opens on pointerdown is put on its onPointerDown, not on an onClick beside it that only stops the
 * event, and where that work was a listener of the page's own rather than a React handler, no React
 * handler is named for it: the explanation then names the listener. Where no handler did any real work
 * every entry ties, and the order is PREFERRED's as it always was.
 */
function byWork(sorted: readonly InteractionTiming[]): InteractionTiming[] {
  const workOf = (e: InteractionTiming) => e.processingEnd - e.processingStart;
  let most = 0;
  for (const e of sorted) most = Math.max(most, workOf(e));
  return sorted.filter((e) => workOf(e) > most - HANDLER_TIE_MS);
}

const summarize = (e: InteractionTiming): EventEntrySummary =>
  Object.freeze({
    name: e.name,
    startTime: e.startTime,
    duration: e.duration,
    processingStart: e.processingStart,
    processingEnd: e.processingEnd,
  });

const walked = (commits: readonly CommitSummary[]): number => commits.reduce((a, c) => a + c.walkMs, 0);

/** Each commit's copy per way of joining, so every report and revision holding a commit holds the same frozen object. */
const joinedCopies = new WeakMap<CommitSummary, { exact?: CommitSummary; overlap?: CommitSummary }>();

/** The commit as a report holds it: stamped with how it joined that report. */
function joined(c: CommitSummary, by: 'exact' | 'overlap'): CommitSummary {
  let copies = joinedCopies.get(c);
  if (!copies) joinedCopies.set(c, (copies = {}));
  return (copies[by] ??= Object.freeze({ ...c, joinedBy: by }));
}

/** The first entry target still in the DOM. Event Timing reports null for a node that has left it. */
function entryTarget(entries: readonly InteractionTiming[]): Node | null {
  for (const e of entries) if (e.target) return e.target;
  return null;
}

/**
 * What a keypress entry's event reached, as the ring read it at dispatch onto its keydown's record, since
 * a keypress has none of its own and Enter's submit is in its entry. Undefined for any other entry, and
 * where the ring read nothing.
 */
function keypressReached(inputs: readonly InputRecord[], e: InteractionTiming): string | null | undefined {
  if (e.name !== 'keypress') return undefined;
  return inputs.find((i) => i.type === 'keydown' && i.keypressHandler !== undefined && near(i.ts, e.startTime))?.keypressHandler;
}

/**
 * The onSubmit the key that made this click reached, where the click landed on another element than the
 * key's. Enter in a field submits the form by clicking its submit button, inside the keypress, so the
 * button's onClick runs before the onSubmit that does the work: one for analytics, or the one a library's
 * button always has, would take the onSubmit's name. The keypress's reading of it names that onSubmit, and
 * not the field's own onKeyPress, which the keypress ran before the click and which did none of its work.
 * Null for a click on the key's own element, as Enter on the button makes, for one no key made, and where
 * the keypress reached no onSubmit, so a form with none is named by the button's onClick.
 */
function submittedBy(inputs: readonly InputRecord[], click: InputRecord | undefined): string | null {
  if (click?.type !== 'click') return null;
  const key = inputs.find((i) => i.type === 'keydown' && i.ts === click.gestureTs);
  return (key && key.target !== click.target && key.keypressSubmit) || null;
}

/** The input in the ring that one of these entries is, by its timestamp and type. */
function ringInput(inputs: readonly InputRecord[], stamps: readonly Stamp[]): InputRecord | null {
  return inputs.find((i) => stamps.some((s) => isInput(s, i.ts, i.type))) ?? null;
}

/** An entry is this input, or the press it released. */
const hasEntry = (i: InputRecord, stamps: readonly Stamp[]) => stamps.some((s) => isInput(s, i.ts, i.type) || isPress(s, i.gestureTs));

/**
 * Is this input one of the interaction's own? An entry of its own type at its time is the plain case.
 * The press it released matching one is the next: a click is a pointerdown, a pointerup and a click,
 * and only the entries slow enough to be observed arrive, so a gesture whose pointerdown was the only
 * entry still owns the pointerup and the click that finished it. The last is another input of the same
 * press having an entry: a pointerup whose click was too quick for one still owns that click.
 */
function ownInput(i: InputRecord, stamps: readonly Stamp[], inputs: readonly InputRecord[]): boolean {
  return hasEntry(i, stamps) || inputs.some((o) => o !== i && o.gestureTs === i.gestureTs && hasEntry(o, stamps));
}

/** Every input of this interaction the ring still holds, oldest first. A click is a pointerdown, a pointerup and a click. */
function ringInputs(inputs: readonly InputRecord[], stamps: readonly Stamp[]): InputRecord[] {
  return inputs.filter((i) => ownInput(i, stamps, inputs));
}

/** The pointer that made the named entry, from its input in the ring. */
function pointerOf(inputs: readonly InputRecord[], named: { name: string; startTime: number }): string | null {
  return pointerOfInput(inputs, inputs.find((x) => x.type === named.name && near(x.ts, named.startTime)));
}

/**
 * The pointer that made an input of the ring. WebKit gives a tap's click the pointerType 'mouse', so a click
 * takes a finger's or a pen's from the pointerdown of its own press.
 */
function pointerOfInput(inputs: readonly InputRecord[], i: InputRecord | undefined): string | null {
  const down = i?.type === 'click' ? inputs.find((x) => x.type === 'pointerdown' && x.ts === i.gestureTs && (x.pointerType === 'touch' || x.pointerType === 'pen')) : undefined;
  return down?.pointerType || i?.pointerType || null;
}

/**
 * The stamps a commit of this interaction can carry: its entries', and the press each of its inputs
 * released. Event Timing leaves out an entry under 16 ms, so a tap's pointerdown can be missing from
 * the entries while a render it set off, stamped with it, lands inside the click: a finger held a moment
 * on a card whose onPointerEnter opens it. A press the ring no longer holds is one of either kind: a
 * click a key made released a keydown.
 */
function commitStamps(inputs: readonly InputRecord[], stamps: readonly Stamp[]): Stamp[] {
  const out = stamps.slice();
  for (const i of ringInputs(inputs, stamps)) if (!out.some((s) => isPress(s, i.gestureTs))) out.push({ at: i.gestureTs, types: PRESSES });
  return out;
}

const earliest = (stamps: readonly Stamp[]) => stamps.reduce((a, s) => Math.min(a, s.at), Infinity);
const latest = (stamps: readonly Stamp[]) => stamps.reduce((a, s) => Math.max(a, s.at), -Infinity);

/**
 * Whether a newer interaction had already begun when this commit ran, so the commit is at best
 * ambiguous and must not be attached to this report as a later render.
 *
 * A commit is stamped with the newest input at the time, so one stamped with this interaction's input
 * normally is its work. Normally is not always: a commit made during an event Event Timing gives no
 * interactionId to, or outside any dispatch, is stamped with whatever the ring last held, and that can
 * be an interaction two steps back. Sorting a table and then changing its page size made exactly that
 * report, where the sort click was told it had re-rendered 417 components a second after its paint and
 * the page-size change was what had done it.
 *
 * The ring is the evidence: an input that is not one of this interaction's own, that arrived after all
 * of them and before the commit, means something newer was under way. So does an `input`, `change` or
 * `submit` a script dispatched between the paint and the commit (`InputWork.closers`), which the ring
 * never holds: Playwright's `selectOption` changes a select that way, so a page size changed through it
 * still put its render on the sort click. With nothing newer the commit belongs where its stamp says.
 *
 * A commit before the headline's input, after the press painted, is looked at from that paint (`since`):
 * the interaction's own inputs go on past the commit, so nothing after all of them came before it.
 */
function newerInputBefore(inputs: readonly InputRecord[], stamps: readonly Stamp[], end: number, at: number, since?: number): boolean {
  const own = ringInputs(inputs, stamps);
  const last = since ?? own.reduce((a, i) => Math.max(a, i.ts), latest(stamps));
  if (inputs.some((i) => !own.includes(i) && i.ts > last + STAMP_TOLERANCE && i.ts <= at)) return true;
  const from = Math.max(last, end) + STAMP_TOLERANCE;
  return own.some((i) => i.work.closers?.some((t) => t > from && t <= at));
}

/**
 * Commits the hook saw during this interaction and could not join to it, over the inputs the ring
 * still holds.
 *
 * The hook drops a commit that lands past the join window and keeps the time it ran at, because at
 * that point there is no Event Timing entry to judge it against. Here there is. A commit counts only
 * if it ran while one of the interaction's own entries was in its processing phase, which is where
 * this interaction's handlers were on the stack: React rendering then is something this interaction
 * caused, whatever this library failed to tie it to. A commit outside every such span is somebody
 * else's work, and a page with a clock ticking once a second is full of them. Counting those turned an
 * honest fast click into "3 commits could not be tied to this click" and cost it its `measured`.
 */
function unjoinedCommits(inputs: readonly InputRecord[], stamps: readonly Stamp[], entries: readonly InteractionTiming[]): number {
  const during = (at: number) => entries.some((e) => at >= e.processingStart - STAMP_TOLERANCE && at <= e.processingEnd + STAMP_TOLERANCE);
  return ringInputs(inputs, stamps).reduce((a, i) => a + i.work.unjoined.filter(during).length, 0);
}

/**
 * Server-rendered HTML the interaction landed on before React had hydrated it, or null.
 *
 * React hydrating it inside the interaction is the case with a time on it: one commit of the
 * interaction ended the wait its input started in, and `ms` is what that commit spent rendering.
 * Without such a commit, the case left is the one where nothing of React ran: every input of the
 * interaction that the ring still holds landed on HTML that was still waiting. Reading the newest of
 * them, rather than the first, is what keeps a pointerdown before hydration from speaking for a click
 * after it.
 */
function hydrationOf(commits: readonly CommitSummary[], inputs: readonly InputRecord[], stamps: readonly Stamp[]): Hydration | null {
  // At most one commit carries it: the boundary an input waited on is credited to the commit that
  // hydrated it and to no other, so there is nothing here to pick between or to add up.
  const hydrating = commits.find((c) => c.hydratedTarget != null) ?? null;
  if (hydrating?.hydratedTarget) return Object.freeze({ ...hydrating.hydratedTarget, kind: 'waited', ms: hydrating.hasDurations ? hydrating.total : null });
  const landed = ringInputs(inputs, stamps);
  const still = landed.length > 0 && landed.every((i) => i.dehydrated != null) ? landed[landed.length - 1]?.dehydrated : null;
  return still ? Object.freeze({ ...still, kind: 'not-hydrated', ms: null }) : null;
}

/** The element an interaction landed on: an entry's target, or the node the ring kept when the entries' target has left the DOM. */
export function interactionTarget(entries: readonly InteractionTiming[], inputs: readonly InputRecord[]): Node | null {
  return entryTarget(entries) ?? ringInput(inputs, stampsOf(entries))?.target ?? null;
}

/** When an entry's frame painted, bounded like `paintBound`: its duration is rounded to 8 ms, its `processingEnd` is exact. */
const paintOf = (e: Pick<EventEntrySummary, 'startTime' | 'duration' | 'processingEnd'>) => Math.max(e.startTime + e.duration, e.processingEnd);

/** The latest paint of these entries before `at`; -Infinity where none had painted by then. A press with no entry of its own gives none. */
function paintBefore(entries: readonly Pick<EventEntrySummary, 'startTime' | 'duration' | 'processingEnd'>[], at: number): number {
  let p = -Infinity;
  for (const e of entries) if (paintOf(e) < at) p = Math.max(p, paintOf(e));
  return p;
}

/** Whether a key set this commit off: it is stamped with a keydown, or with a keyup or the click a key made, whose press is that key's keydown. */
const byKey = (c: Pick<CommitSummary, 'inputType' | 'gestureTs'>, inputs: readonly InputRecord[]) =>
  c.inputType === 'keydown' || inputs.some((i) => i.type === 'keydown' && near(i.ts, c.gestureTs));

/**
 * One report's data from every Event Timing entry seen for an interactionId. The headline is the
 * longest single entry, which is the number web-vitals reports as INP for the interaction;
 * `inputs` is the ring of recent inputs, used to tell whose commit is whose and to recover
 * the target when the entry's is gone; `navigations` are the page's, oldest first, to say which
 * one the interaction happened in and which one it started; `inputWindow` is the page's
 * `InstallOptions.inputWindow`, which bounds its later renders (see `isFollowUp`).
 */
export function buildReport(
  entries: readonly InteractionTiming[],
  commits: readonly CommitSummary[],
  frames: readonly FrameSummary[] | null,
  inputs: readonly InputRecord[] = [],
  labels: LabelSource = 'attributes',
  navigations: readonly PageNavigation[] = [],
  inputWindow = DEFAULT_INPUT_WINDOW,
  reactStatus: ReactStatus = 'reading',
  reactPage: ReactPage = NO_REACT_PAGE,
  reactBuild: ReportData['reactBuild'] = null,
): ReportData {
  const longest = entries.reduce((a, e) => (e.duration > a.duration ? e : a));
  const group = paintGroupOf(entries, longest);
  // The same clamps web-vitals applies: processing cannot start before this entry's input,
  // and cannot run past the paint that closed it (a sync modal can make it look that way).
  const start = longest.startTime;
  const processingStart = Math.max(group.processingStart, start);
  const end = Math.max(start + longest.duration, processingStart);
  const processingEnd = Math.min(group.processingEnd, end);
  const duration = longest.duration;
  let first = Infinity;
  let lastPaint = -Infinity;
  for (const e of entries) {
    first = Math.min(first, e.startTime);
    lastPaint = Math.max(lastPaint, e.startTime + e.duration);
  }
  const holdMs = Math.max(0, lastPaint - first - duration);

  // A click arrives as pointerdown, pointerup and click entries sharing one interactionId.
  // Name the interaction by the most meaningful entry painted with the headline.
  const sorted = group.entries.slice().sort((a, b) => rank(a.name) - rank(b.name));
  const named = sorted[0] ?? longest;
  const stamps = stampsOf(entries);
  const ring = ringInput(inputs, stamps);
  // The entry's target is null when the node left the DOM before the observer ran (a close button, a
  // deleted row). The ring kept the node, and what React said about it at dispatch: by the time the
  // entry arrives, React 18 and 19 have cleared the links and props of a deleted fiber.
  const live = entryTarget(entries);
  const targetNode = live ?? ring?.target ?? null;
  const fiber = live && fiberFromNode(live);
  let owners: readonly string[] = [];
  let handler: string | null = null;
  if (fiber) {
    // Named from what a clicked icon belongs to, as at dispatch; the handler is still looked for from the
    // node itself, which is where a handler on the icon would be.
    owners = ownersOf(namingFiber(live));
    for (const e of byWork(sorted)) {
      // The handler React ran is the one the ring read as the event was dispatched. By the time the entry
      // comes, the event's own render can have put another on the element: `onClick={editing ? save : edit}`
      // does on every click, and `onSubmit={step < 2 ? goNext : finish}` on Enter, whose keypress is read
      // onto its keydown's record. Only the record of the entry's own node is taken, since two fingers on
      // two buttons in one frame are two records under a millisecond apart. Server HTML had no handler to
      // read at dispatch, and its record was read again once React hydrated it inside the event's dispatch,
      // to run it. The click Enter in a field makes on the form's submit button is named by the onSubmit its
      // keypress reached.
      const own = inputs.find((i) => i.type === e.name && near(i.ts, e.startTime) && (!e.target || i.target === e.target));
      const reached = keypressReached(inputs, e);
      if (own && (!own.dehydrated || own.hydratedRead)) {
        handler = submittedBy(inputs, own) ?? own.handler;
      } else if (reached !== undefined) {
        handler = reached;
      } else {
        // The element is read now only for an event the ring has no reading of, such as the `input` an input
        // method sends, and for server HTML React did not hydrate inside the event's dispatch. The event's own
        // render can have given the element other props by now, so the fiber cached on it is read (`handlerOf`).
        // An Event Timing entry does not say which key was pressed; the ring entry for the same event
        // does, and which key it was decides whether the press could have submitted a form. It is the key
        // the ring read the handler for, so an input method's Enter is not one here either.
        // A keypress has no ring entry of its own and shares its keydown's key.
        const key = inputs.find((i) => (i.type === e.name || (e.name === 'keypress' && i.type === 'keydown')) && near(i.ts, e.startTime))?.key;
        handler = handlerOf(fiber, e.name, key, true);
      }
      if (handler) break;
    }
  } else if (ring) {
    owners = ring.owners;
    for (const e of byWork(sorted)) {
      const own = inputs.find((i) => i.type === e.name && near(i.ts, e.startTime));
      handler = submittedBy(inputs, own) ?? own?.handler ?? keypressReached(inputs, e) ?? null;
      if (handler) break;
    }
  }

  // Durations are rounded to 8 ms but processingEnd is exact, so a commit inside the
  // handlers is before the paint even when the rounded paint time says otherwise.
  const paintBound = Math.max(end, group.processingEnd);
  const inWindow: CommitSummary[] = [];
  const followUps: CommitSummary[] = [];
  const ownStamps = commitStamps(inputs, stamps);
  for (const c of commits) {
    if (stampMatches(c, ownStamps)) {
      if (c.at < start - STAMP_TOLERANCE) {
        // Work before the headline entry's own input is not part of what INP measured for it. A key's,
        // after one of the interaction's entries painted and inside none of them, is a later render of
        // that paint, as one after the headline's is: a keydown's render before its slower keyup, or before
        // the click the key made. Anything newer is looked for from that paint. An entry runs to its paint
        // as `timed` has it, or a render INP timed would be kept as one it left out. The rest is left out of
        // the report: work inside another of the entries (a press held before its release), or before any
        // of them painted (a press too quick for an entry of its own paints none), and a pointer's before
        // its release, with an entry for the press or without. The hook stamps a drag's move renders with
        // its pointerdown, and nothing tells them from a render the press set off: kept, they were later
        // renders of the drop and published a quiet one. `holdMs` spans the entries alone, so it keeps the
        // time of a press that sent one, and none where the press sent no entry.
        const from = byKey(c, inputs) ? paintBefore(entries, c.at) : -Infinity;
        const inEntry = entries.some((e) => c.at >= e.startTime - STAMP_TOLERANCE && c.at <= paintOf(e) + STAMP_TOLERANCE);
        if (from > -Infinity && !inEntry && isFollowUp(c, from, inputs, stamps, inputWindow, from)) followUps.push(joined(c, 'exact'));
        continue;
      }
      if (c.at <= paintBound) inWindow.push(joined(c, 'exact'));
      else if (isFollowUp(c, end, inputs, stamps, inputWindow)) followUps.push(joined(c, 'exact'));
    } else if (c.at >= processingStart - STAMP_TOLERANCE && c.at <= paintBound && !claimedElsewhere(c, inputs, stamps)) {
      // No stamp matched, but it ran between this interaction's handlers and its paint.
      inWindow.push(joined(c, 'overlap'));
    }
  }
  // The walk runs inside React's commit, so the walk of a commit during the handlers sits inside
  // the processing time the browser measured. That time is this library's, not the page's.
  let walkMs = 0;
  for (const c of inWindow) walkMs += Math.max(0, Math.min(c.at + c.walkMs, processingEnd) - Math.max(c.at, processingStart));
  // Placed by its first input: a click that starts a navigation happened on the page it left.
  const navigation = navigationAt(navigations, first);
  // Another interaction's press that came before this one's paint, which the page may have handled first
  // (`explain` says so only on evidence). A release sets nothing off: a modifier let go before the paint.
  const own = ringInputs(inputs, stamps);
  const next = inputs.find((i) => (PRESSES.includes(i.type) || i.type === 'click') && i.ts > start && i.ts < end && !own.includes(i));
  const summaries = Object.freeze(entries.map(summarize));
  if (reactPage.named || reactPage.roots.length) reactPages.set(summaries, reactPage);

  return {
    schemaVersion: 4,
    interactionId: longest.interactionId,
    type: named.name,
    reactStatus,
    reactBuild,
    strictMode: strictModeOf(reactBuild, [...inWindow, ...followUps]),
    pointerType: pointerOf(inputs, named),
    start,
    end,
    duration,
    holdMs,
    entries: summaries,
    inputDelay: processingStart - start,
    processing: processingEnd - processingStart - walkMs,
    walkMs,
    presentation: end - processingEnd,
    nextInput: next ? Object.freeze({ type: next.type, pointerType: pointerOfInput(inputs, next), start: next.ts, endedAt: next.work.ownEndedAt > next.ts ? next.work.ownEndedAt : null }) : null,
    // A node that left the page has no control above it any more; the one found at dispatch labels it.
    // Labelled as it read at dispatch where the ring has that node: a handler can change the text.
    target: targetNode ? describeTarget(targetNode, owners, handler, labels, live ?? ring?.control ?? targetNode, ring && (!live || ring.target === live) ? ring.label : null) : null,
    hydration: hydrationOf(inWindow, inputs, stamps),
    navigationURL: navigation?.url ?? '',
    navigationType: navigation?.type ?? 'navigate',
    startedNavigation: navigationStartedBy(navigations, stamps),
    commits: Object.freeze(inWindow),
    followUps: Object.freeze(followUps),
    unjoinedCommits: unjoinedCommits(inputs, stamps, entries),
    frames: frames && Object.freeze(framesInWindow(frames, start, end)),
    laterFrames: frames && framesForLater(followUps, frames),
    revision: 0,
    overheadMs: walked(inWindow) + walked(followUps),
  };
}

/** What each report was built knowing of the page's React (`ReactPage`), by its entries, which every revision of it shares. */
const reactPages = new WeakMap<readonly EventEntrySummary[], ReactPage>();
const NO_REACT_PAGE: ReactPage = { roots: [], named: false };

/** The report a revision is published as: frozen, with its explanation and verdict built on first read. */
export function sealReport(data: ReportData): InteractionReport {
  return Object.freeze(Object.defineProperties({ ...data }, EXPLAINED_ON_READ)) as InteractionReport;
}

/** Explanations built so far, by report. Reports are frozen, so each is explained at most once. */
const explanations = new WeakMap<InteractionReport, { explanation: Explanation; verdict: string }>();

function explained(r: InteractionReport): { explanation: Explanation; verdict: string } {
  let built = explanations.get(r);
  if (!built) {
    let explanation: Explanation;
    try {
      explanation = explain(r);
    } catch (error) {
      // Built where the page reads it, in the page's own code, so an error of the library's own is kept
      // from the page here too. The report stays, blaming nothing, and says why.
      dropped(error);
      explanation = unexplained(r);
      unexplainedReports.add(r);
    }
    built = { explanation, verdict: toVerdict(explanation) };
    explanations.set(r, built);
  }
  return built;
}

/** What a verdict counted, for the Performance panel's Summary rows to say the same. */
export interface VerdictCounts {
  /** The renders before the paint that the "React rendered 3 times" note counts. */
  readonly renders: number;
  /** The rest of the renders before the paint, by why the note leaves them out. */
  readonly hydrations: number;
  readonly forced: number;
  readonly small: number;
  /** The working time that went by between one event's handlers and the next's, and where, in the verdict's words. */
  readonly between: number;
  readonly whereBetween: string;
}

/** Whether the long frames over a report's handlers, from `start` to `end`, list no script at all, where one of them is long. */
function listsNoScripts(frames: readonly FrameSummary[], start: number, end: number): boolean {
  const over = frames.filter((f) => f.start < end && f.start + f.duration > start);
  return over.length > 0 && over.every((f) => f.scripts.length === 0) && over.some((f) => f.duration >= LONG_TASK_MS);
}

/**
 * Whether the report's verdict could not say what its handlers' time went on, since the frames over them listed no
 * scripts. Only where the handlers ran long: the browser lists no script under 5 ms, so a quick handler in a frame
 * long for styles and layout lists none on any page.
 */
export function scriptsUnlisted(r: InteractionReport): boolean {
  const start = r.start + r.inputDelay;
  return r.processing >= LONG_TASK_MS && listsNoScripts(r.frames ?? [], start, start + r.processing + r.walkMs);
}

/** Counts by report, kept as each is explained. */
const countsByReport = new WeakMap<InteractionReport, VerdictCounts>();

/** What the verdict counted, or where explaining the report threw, every commit before the paint and no time between handlers. */
export function verdictCounts(r: InteractionReport): VerdictCounts {
  explained(r);
  return countsByReport.get(r) ?? { renders: r.commits.length, hydrations: 0, forced: 0, small: 0, between: 0, whereBetween: '' };
}

/**
 * Reports are built in the Event Timing callback, where every millisecond can delay the next
 * input, and many are never read, so the explanation and verdict are built on first read. They
 * are own enumerable getters: JSON, spreads and structured copies of a report still carry them.
 */
const EXPLAINED_ON_READ: PropertyDescriptorMap = {
  explanation: {
    enumerable: true,
    get(this: InteractionReport) {
      return explained(this).explanation;
    },
  },
  verdict: {
    enumerable: true,
    get(this: InteractionReport) {
      return explained(this).verdict;
    },
  },
};

/** The commit's stamp names another input the ring knows, one that is not part of this interaction. */
function claimedElsewhere(c: CommitSummary, inputs: readonly InputRecord[], stamps: readonly Stamp[]): boolean {
  return inputs.some((i) => i.type === c.inputType && near(i.ts, c.inputTs) && !ownInput(i, stamps, inputs));
}

/** The navigation an interaction that began at `time` happened in: the newest one that had begun by then. Null only for a report built without the page's navigations, as unit tests build them. */
function navigationAt(navigations: readonly PageNavigation[], time: number): PageNavigation | null {
  let found = navigations[0] ?? null;
  for (const n of navigations) if (n.start <= time) found = n;
  return found;
}

/** The soft navigation an interaction started: the last one a router announced while one of its inputs was being dispatched. */
function navigationStartedBy(navigations: readonly PageNavigation[], stamps: readonly Stamp[]): StartedNavigation | null {
  let started: StartedNavigation | null = null;
  for (const { url, router } of navigations) if (router?.input && stampMatches(router.input, stamps)) started = { url, type: router.type };
  return started && Object.freeze(started);
}

/**
 * The next revision of a report more entries arrived for (the click after a held pointerdown, the
 * keyup after a keydown): rebuilt from every entry so far.
 */
export function refreshReport(
  r: ReportData,
  entries: readonly InteractionTiming[],
  commits: readonly CommitSummary[],
  frames: readonly FrameSummary[] | null,
  inputs: readonly InputRecord[] = [],
  labels: LabelSource = 'attributes',
  navigations: readonly PageNavigation[] = [],
  inputWindow = DEFAULT_INPUT_WINDOW,
  reactStatus: ReactStatus = r.reactStatus,
  reactPage: ReactPage = reactPages.get(r.entries) ?? NO_REACT_PAGE,
  reactBuild: ReportData['reactBuild'] = r.reactBuild,
): ReportData {
  // Time already spent building the report stays counted; the walks are recounted for the commits it now holds.
  const building = r.overheadMs - walked(r.commits) - walked(r.followUps);
  const fresh = buildReport(entries, commits, frames, inputs, labels, navigations, inputWindow, reactStatus, reactPage, reactBuild);
  return { ...fresh, revision: r.revision + 1, overheadMs: fresh.overheadMs + building };
}

function framesForLater(later: readonly CommitSummary[], frames: readonly FrameSummary[]): readonly FrameSummary[] {
  return Object.freeze(frames.filter((f) => later.some((c) => f.start <= c.at && f.start + f.duration >= c.at - Math.max(c.total, FRAME_MS))));
}

function framesInWindow(frames: readonly FrameSummary[], start: number, end: number): readonly FrameSummary[] {
  return frames.filter((f) => f.start < end && f.start + f.duration > start);
}

/** `held` and the frames of `found` it does not hold yet, in time order; null when it holds every one. */
function withNewFrames(held: readonly FrameSummary[] | null, found: readonly FrameSummary[]): readonly FrameSummary[] | null {
  const added = found.filter((f) => !held?.includes(f));
  return added.length ? Object.freeze([...(held ?? []), ...added].sort((a, b) => a.start - b.start)) : null;
}

/**
 * A long animation frame can arrive after the report was built (there is no settle timer), so its
 * forced layout and scripts were missing from the explanation. The next revision adds any that overlap
 * the interaction's window or its later renders. The frames a report holds stay in it after the page's
 * store of recent frames lets them go; null when there is nothing new to add.
 */
export function refreshFrames(r: ReportData, frames: readonly FrameSummary[]): ReportData | null {
  const inWindow = withNewFrames(r.frames, framesInWindow(frames, r.start, r.end));
  const later = withNewFrames(r.laterFrames, framesForLater(r.followUps, frames));
  if (!inWindow && !later) return null;
  return { ...r, frames: inWindow ?? r.frames, laterFrames: later ?? r.laterFrames, revision: r.revision + 1 };
}

/**
 * A commit that landed after the paint and is worth a sentence, close enough to be this interaction's
 * own doing, with no newer interaction under way to have caused it instead. Close enough is within
 * `inputWindow` of `followUpFrom`, the length the hook walks a commit by, so a page that sets it longer
 * gets the renders it pays to walk and one that sets it shorter keeps the ones it walked.
 */
function isFollowUp(c: CommitSummary, end: number, inputs: readonly InputRecord[], stamps: readonly Stamp[], inputWindow: number, since?: number): boolean {
  return c.at - followUpFrom(c, end, inputs, stamps) <= inputWindow && worthMentioning(c) && !newerInputBefore(inputs, stamps, end, c.at, since) && !releaseAfterOtherPress(c, inputs, stamps);
}

/**
 * Whether a commit made outside any dispatch is stamped with a keyup or a pointerup, and another press, one
 * that is not this interaction's own, went down between that release and its own press. The hook stamps
 * such a commit with the newest input, and typing fast, keys roll over: B goes down before A comes
 * up, and the results B's keystroke asked for render stamped with A's keyup. A Shift let go after a click
 * puts the click's render on Shift's keyup the same way. The press came before the interaction's last input,
 * so `newerInputBefore` never sees it, and whose render it is cannot be told, so it is attached to nothing.
 * A render stamped with a click is left alone: a pointer held down through a key press ends in one, and the
 * render is the pointer's.
 */
function releaseAfterOtherPress(c: CommitSummary, inputs: readonly InputRecord[], stamps: readonly Stamp[]): boolean {
  if (c.inDispatch || (c.inputType !== 'keyup' && c.inputType !== 'pointerup')) return false;
  const own = ringInputs(inputs, stamps);
  return inputs.some((i) => (PRESSES.includes(i.type) || i.type === 'click') && i.ts > c.gestureTs && i.ts < c.inputTs && !own.includes(i));
}

/**
 * Whether INP timed a later render: React made it in the dispatch of the input it is stamped with
 * (`CommitSummary.inDispatch`), or it landed inside one of the interaction's entries before the paint,
 * a render that began after the entry's input or committed during its handlers. A press held past its
 * paint is one interaction with its release, and the render the release makes lands after the press's
 * paint but inside the release's own entry. So does one React drained while the release waited for its
 * handlers, which the wait INP counts holds.
 */
export const timed = (c: CommitSummary, entries: readonly EventEntrySummary[]): boolean =>
  c.inDispatch === true ||
  entries.some(
    (e) =>
      c.at <= Math.max(e.startTime + e.duration, e.processingEnd) + STAMP_TOLERANCE &&
      (c.at >= e.processingStart - STAMP_TOLERANCE || (c.startedAt !== null && c.startedAt >= e.startTime - STAMP_TOLERANCE)),
  );

/**
 * Whether a later render may yet turn out to be inside an entry that has not come: it is stamped with an
 * input of the interaction that has no entry, and that input came after the paint of every entry there
 * is, as a keyup does or the release of a press held past its paint. An input before one of those paints
 * was presented with it, so its entry, if it has one, came in the same batch.
 */
export const awaitsEntry = (c: CommitSummary, entries: readonly EventEntrySummary[]): boolean =>
  entries.every((e) => !near(e.startTime, c.inputTs) && c.inputTs > e.startTime + e.duration);

/** The later render a report speaks of, in its note and on the panel: the heaviest INP left out, else the heaviest. */
export function laterRenderOf(r: Pick<ReportData, 'followUps' | 'entries'>): CommitSummary | null {
  if (!r.followUps.length) return null;
  const untimed = r.followUps.filter((c) => !timed(c, r.entries));
  return heaviest(untimed.length ? untimed : r.followUps);
}

/**
 * Where a later render's window runs from. The paint, as a rule, not the input: an interaction that took
 * three seconds still gets the render its effects schedule a moment after it. The hook measures from the
 * end of the work of the input the commit is stamped with (`work.endedAt`, which the ring keeps), and for
 * the input the paint closed that is before the paint. Another input of the same interaction can end its
 * work after it: the click that releases a pointer held down past the paint, or a click whose pointerdown
 * was the slow part and painted first. Then the window runs from the end of that input's work, as the
 * hook's did, and a render inside the click's own dispatch is the click's however long the press was held.
 *
 * Only while the ring shows nothing else pressed from the interaction's first input to that one. Where
 * something was, the release may not be this interaction's alone: a pointer held down through a key
 * press, or a release whose press the hook could only guess at and took the newest one for (`gestureOf`).
 * When the ring has let the input go, there is nothing to check it against, and the window runs from the
 * paint.
 */
function followUpFrom(c: CommitSummary, end: number, inputs: readonly InputRecord[], stamps: readonly Stamp[]): number {
  // By type as well: a pointerup and its click are often under a millisecond apart.
  const own = inputs.find((i) => i.type === c.inputType && near(i.ts, c.inputTs));
  const all = ringInputs(inputs, stamps);
  if (!own || !all.includes(own)) return end;
  const first = earliest(stamps);
  // No tolerance on the bounds: the inputs at them are the interaction's own, and the keydown that
  // makes a click can be under a millisecond before it.
  const pressedBetween = inputs.some((i) => i.ts >= first && i.ts <= own.ts && !all.includes(i));
  return pressedBetween ? end : Math.max(end, own.work.endedAt);
}

/** Does this commit belong to the report's input, landing after its paint and inside its later-render window (`followUpFrom`)? */
export function isLaterRender(r: ReportData, c: CommitSummary, inputs: readonly InputRecord[] = [], inputWindow = DEFAULT_INPUT_WINDOW): boolean {
  const stamps = stampsOf(r.entries);
  return c.at > r.end && stampMatches(c, commitStamps(inputs, stamps)) && isFollowUp(c, r.end, inputs, stamps, inputWindow);
}

/** The next revision of a report, with a later render attached; null when it holds that render already. */
export function attachLaterRender(r: ReportData, c: CommitSummary, frames: readonly FrameSummary[] | null): ReportData | null {
  const commit = joined(c, 'exact');
  if (r.followUps.includes(commit)) return null;
  const followUps = Object.freeze([...r.followUps, commit]);
  const laterFrames = frames && (withNewFrames(r.laterFrames, framesForLater(followUps, frames)) ?? r.laterFrames);
  const strictMode = strictModeOf(r.reactBuild, [...r.commits, ...followUps]);
  return { ...r, strictMode, followUps, laterFrames, overheadMs: r.overheadMs + c.walkMs, revision: r.revision + 1 };
}

/** `InteractionReport.strictMode`: said of a development build alone, and of a report holding a commit. */
function strictModeOf(reactBuild: ReportData['reactBuild'], commits: readonly CommitSummary[]): boolean | null {
  return reactBuild === 'development' && commits.length ? commits.some((c) => c.strictMode === true) : null;
}

// What counts as a readable name is `readableName`, in commits.ts, shared with everything that names a commit.

/**
 * The owner a report names the target by: the nearest readable one. Where that is a framework's wrapper
 * (next/link's LinkComponent, which renders the `<a>` for the component above it), the next readable owner is
 * named instead if it is not the framework's own; a link a server component wrote directly has only the App
 * Router's boundaries above it, and keeps the wrapper's name. Where the chain holds no readable name the nearest owner is named anyway,
 * because the alternative is inventing one, and `owners` keeps the chain whole either way.
 */
function namedOwner(owners: readonly string[]): string | null {
  const nearest = owners.findIndex(readableName);
  if (nearest === -1) return owners[0] ?? null;
  const name = owners[nearest]!;
  if (!frameworkWrappers.has(name)) return name;
  const above = owners.slice(nearest + 1).find(readableName);
  return above && !frameworkLayers.has(above) && !frameworkWrappers.has(above) ? above : name;
}

function describeTarget(node: Node, owners: readonly string[], handler: string | null, labels: LabelSource, labelled: Node = node, dispatched?: string | null): TargetInfo {
  return Object.freeze({
    selector: selector(node),
    label: dispatched ?? labelOf(labelled, labels),
    component: namedOwner(owners),
    owners: Object.isFrozen(owners) ? owners : Object.freeze(owners.slice()),
    handler,
  });
}

/**
 * 'button "Add to cart"': the element's kind and what names it. The name comes from what the page's
 * code wrote on the element: its aria-label, a form field's placeholder, aria-placeholder or name, an
 * input's type, or its data-testid or data-test. Where `labels` is 'text', a form field with no aria-label
 * is named by its `<label>` first, and any other element with no aria-label by its first run of text
 * before those data attributes are tried.
 * What a person types in is a form field wherever it is: anything inside an editor, or inside an element
 * with a text field's role, whose text is what they typed, and an element an EditContext is attached to,
 * or one up to five elements inside it. Only an input is named by its type: a select trigger with the
 * role combobox is a button, and the type on a button names nothing.
 */
export function labelOf(node: Node, labels: LabelSource): string | null {
  const landed = elementOf(node);
  if (!landed) return null;
  const el = controlAround(landed);
  const tag = el.tagName.toLowerCase();
  const word = tag === 'a' ? 'link' : tag;
  const field = tag === 'input' || tag === 'select' || typedIn(el) || editing(landed);
  const written = (name: string) => el.getAttribute(name);
  const name =
    written('aria-label') ||
    (field
      ? (labels === 'text' && fieldLabel(el)) || written('placeholder') || written('aria-placeholder') || written('name') || (tag === 'input' && written('type'))
      : labels === 'text'
        ? firstText(el)
        : null) ||
    written('data-testid') ||
    written('data-test');
  const label = name ? clip(name) : '';
  return label ? `${word} "${label}"` : word;
}

/** The text of a form field's first `<label>`, which is what the page shows beside it, never its value. */
function fieldLabel(el: Element): string {
  const label = (el as HTMLInputElement).labels?.[0];
  return label ? firstText(label) : '';
}

/** Is `el` itself one a person types in: a textarea, an editor, or an element with a text field's role? */
const typedIn = (el: Element): boolean => el.tagName.toLowerCase() === 'textarea' || !!el.matches?.(TYPED_IN) || hasEditContext(el);

/**
 * Is `el` inside an editor or an element with a text field's role, or in a document in designMode? Asked
 * of the element an input landed on, which is inside anything the control around it is inside. `closest`
 * rather than a walk up, since a label is read at every key press, except for an EditContext, which no
 * selector can find: that is looked for on the element and its five nearest ancestors.
 */
const editing = (el: Element): boolean => (el as HTMLElement).isContentEditable === true || !!el.closest?.(TYPED_IN) || editContextAround(el);

/**
 * Is an EditContext attached to `el` or to one of its five nearest ancestors? A key press lands on the
 * element it is attached to, and a click on what it drew lands a few elements inside that one.
 */
function editContextAround(el: Element): boolean {
  let at: Element | null = el;
  for (let up = 0; at && up <= EDIT_CONTEXT_ANCESTORS; up++, at = at.parentElement) if (hasEditContext(at)) return true;
  return false;
}

/** Has the page's code attached an EditContext to `el`, which Chromium then hands its key presses to? */
const hasEditContext = (el: Element): boolean => (el as { editContext?: object | null }).editContext != null;

/** Whitespace collapsed, cut at 40 characters. */
function clip(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, LABEL_CHARS).trimEnd();
}

/**
 * The first run of text inside `el`: its first text node with more than whitespace, joined to
 * the text nodes right after it (React renders `Add to cart ({n})` as three), stopping once 40
 * characters are in hand.
 */
function firstText(el: Element): string {
  let node: Node | null = el.firstChild;
  for (let looked = 0; node && looked < LABEL_NODES; looked++) {
    if (node.nodeType === TEXT_NODE && /\S/.test(node.nodeValue ?? '')) {
      let text = node.nodeValue ?? '';
      let joined = 0;
      for (let next = node.nextSibling; next && joined < RUN_NODES && text.length < LABEL_CHARS; next = next.nextSibling, joined++) {
        // Server-rendered HTML separates two adjacent text children with `<!-- -->`, a comment
        // holding a single space, so that hydration can tell them apart, and it stays in the DOM.
        // It is a separator inside one run of text, not the end of it: skipping it is what makes
        // the label read the same under Next.js as under a client-only render.
        if (next.nodeType === COMMENT_NODE) continue;
        if (next.nodeType !== TEXT_NODE) break;
        text += next.nodeValue ?? '';
      }
      return text;
    }
    node = nextNode(node, el);
  }
  return '';
}

/** The node after `node` in document order, without leaving `root`. */
function nextNode(node: Node, root: Node): Node | null {
  // Text nobody can see names nothing: a key press with nothing focused lands on the body, and the
  // first text in a Vite or CRA page's body is its noscript line, "You need to enable JavaScript".
  // Nor is text a person typed or picked read on the way: an editor's, a textarea's, which React keeps the
  // same as its value, or a select's options, one of which is its value.
  const tag = (node as Element).tagName?.toLowerCase() ?? '';
  if (node.firstChild && !UNSEEN_TEXT_TAGS.includes(tag) && tag !== 'select' && !typedIn(node as Element)) return node.firstChild;
  for (let n: Node | null = node; n && n !== root; n = n.parentNode) if (n.nextSibling) return n.nextSibling;
  return null;
}

export const ms = (n: number): string => `${Math.round(n)} ms`;
/** A figure that rounds to nothing reads "under 1 ms". */
const underOr = (n: number): string => (n < 0.5 ? 'under 1 ms' : ms(n));
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

interface Interval {
  readonly from: number;
  readonly to: number;
}

/** `intervals` as sorted pieces that do not overlap, so that each moment counts once. */
function merged(intervals: readonly Interval[]): Interval[] {
  const out: { from: number; to: number }[] = [];
  for (const i of intervals.filter((x) => x.to > x.from).sort((a, b) => a.from - b.from)) {
    const last = out[out.length - 1];
    if (last && i.from <= last.to) last.to = Math.max(last.to, i.to);
    else out.push({ from: i.from, to: i.to });
  }
  return out;
}

/** The time `intervals` cover, each moment once, less what `less` covers of it. */
function coverage(intervals: readonly Interval[], less: readonly Interval[] = []): number {
  const taken = merged(less);
  let total = 0;
  for (const x of merged(intervals)) {
    total += x.to - x.from;
    for (const y of taken) total -= Math.max(0, Math.min(x.to, y.to) - Math.max(x.from, y.from));
  }
  return total;
}
/** What the browser says ran a script: its invoker, else its function's name; null when it gives neither. */
const scriptName = (s: ScriptSummary): string | null => s.invoker || s.name || null;
/**
 * "a script (handleClick, app.js)": a script by what ran it and the file it came from. One the browser gave
 * no name is "a script with no name (app.js)", as `longestSaid` says it.
 */
const aScript = (s: ScriptSummary): string => {
  const name = scriptName(s);
  return name ? `a script (${name}${s.source ? `, ${s.source}` : ''})` : `a script with no name${s.source ? ` (${s.source})` : ''}`;
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A URL the way a link on `page` shows it: its path, query and fragment when it stays on that page's origin. */
function linkText(url: string, page: string): string {
  try {
    const to = new URL(url);
    return to.origin === new URL(page).origin ? to.pathname + to.search + to.hash : url;
  } catch {
    return url;
  }
}

/** "the click handler handleLogin"; "the onClick handler" when the name is a prop's, which is all a minified build leaves. */
function handlerPhrase(name: string, kind: string): string {
  return /^on[A-Z]/.test(name) ? `the ${name} handler` : `the ${kind} handler ${name}`;
}

function leafOf(c: CommitSummary): string {
  return leafName(c) ?? 'the app';
}

/**
 * The component whose own render, its time less the components it rendered, was most of a commit React
 * timed: rendered once, beside others, from `OWN_RENDER_MIN_MS` and `OWN_RENDER_MIN_SHARE` of the commit's
 * render time. Undefined where no one component was, where that one has no name, and where the build timed no
 * single component.
 */
function ownRender(c: CommitSummary): { readonly name: string; readonly self: number } | undefined {
  const top = mostlyComponent(c);
  // A root outside ProfileMode with a `<Profiler>` under it is timed only below the Profiler, so the commit's
  // total can come to less than one component's own time, and "of it" would claim more than the whole.
  if (c.rendered < 2 || top?.count !== 1 || top.name === ANONYMOUS || top.self == null || top.self > c.total) return undefined;
  return top.self >= OWN_RENDER_MIN_MS && top.self >= OWN_RENDER_MIN_SHARE * c.total ? { name: top.name, self: top.self } : undefined;
}

/**
 * "LineItem ×800" where LineItem was most of the commit (`dominantComponent`); "TableBody's own render" where
 * that was most of the time; else the component count, "812 of 1216 components" where the walk counted fewer
 * inside the component the commit is named after, unless `inside` is false, for a blame named after
 * something that holds them all. A walk cut short only ever gives the count, and it says so: "at least 1999
 * components, the rest not walked". The panel's line for a later render says the same.
 */
export function mostlyOf(c: CommitSummary, inside = true): string | null {
  if (c.rendered === 1) return null;
  const top = dominantComponent(c);
  if (top && top.count > 1) return `${top.name} ×${top.count}`;
  const own = ownRender(c);
  if (own) return `${own.name}'s own render`;
  const count = inside ? countInside(c) : renderedCount(c);
  return c.truncated ? `${count}, the rest not walked` : count;
}

/** "812 of 1216 components" where the walk counted fewer inside the component the commit is named after, else "1216 components". */
export function countInside(c: CommitSummary): string {
  const within = insideCount(c);
  return within == null ? renderedCount(c) : `${atLeast(c)}${within} of ${renderedCount(c)}`;
}

/** "at least " where the walk stopped before the end of the tree, so every count of it is a lower bound. */
const atLeast = (c: CommitSummary): string => (c.truncated ? 'at least ' : '');

/**
 * What a render's cause says of a walk cut short, after the render's own sentence: what took the time past the
 * cut was not seen, and where the walk could not tell where the render started (`leafName` gives none), that
 * too. Empty for a walk that went to the end, and for one that reached nothing that rendered or a timed one
 * that could tell where the render started, which the note on the partial count covers.
 */
function walkStopped(c: CommitSummary): string {
  if (!c.truncated || c.rendered === 0) return '';
  // A path that ends in a component with no name still says where the render started.
  const unnamedEnd = (c.hotPath[c.hotPath.length - 1] ?? (c.hasDurations ? c.roots[0] : undefined)) === ANONYMOUS && c.pathStart !== 'unknown-root' && c.pathStart !== 'no-root';
  if (leafName(c) === null && !unnamedEnd) return " The walk stopped partway through that render, so where it started and which components took the time aren't known.";
  return c.hasDurations ? '' : " The walk stopped partway through that render, so which components took the time isn't known.";
}

/** "801 components"; "at least 5000 components" where the walk stopped before the end of the tree. */
export function renderedCount(c: CommitSummary): string {
  return `${atLeast(c)}${plural(c.rendered, 'component')}`;
}

/**
 * How many of the components rendered sit inside the one the commit is named after, where the walk counted
 * them and they are fewer than the commit's (`pathRendered`): what "inside" can claim of a count. Where the
 * walk was cut both counts are lower bounds, and the one inside is said as one. Null where they are all of
 * them, on a report an earlier release stored, and where the commit is named the app, which holds them all.
 */
export function insideCount(c: CommitSummary): number | null {
  return leafName(c) !== null && c.pathRendered != null && c.pathRendered < c.rendered ? c.pathRendered : null;
}

/**
 * For the panel's rows, "mounted" where every component rendered for the first time, since "mounting 1959
 * components" is read as 1959 mounts, "re-rendered" where one in ten or fewer did, "rendered" between;
 * "hydrated" for a hydration. A report an earlier release stored counted no mounts.
 */
export function renderedVerb(c: CommitSummary): string {
  const m = c.mounted ?? 0;
  return c.hydrated ? 'hydrated' : m && m >= c.rendered ? 'mounted' : m * 10 > c.rendered ? 'rendered' : 're-rendered';
}

/** The same as the sentence says it: "re-rendering", "mounting", "rendering", "hydrating". */
function renderVerb(c: CommitSummary): string {
  return `${renderedVerb(c).slice(0, -2)}ing`;
}

/**
 * The commit a report's render or layout blame was built from, for the panel's row to take its verb from: the
 * one whose name and detail the blame carries, the heaviest of them where several do. It is not always the
 * heaviest commit: a 5 ms render whose layout effects ran for 60 ms is named over a 20 ms mount beside it, and
 * a layout blame names the commit whose time could hold the layout. A layout or render blame named from where the
 * render started (`fromName`), or a layout from what several roots sit under (`fromAbove`), is matched that way first.
 * The heaviest where none matches, and null where the report holds no commit.
 */
export function blamedCommit(r: InteractionReport): CommitSummary | null {
  const { kind, name, detail } = r.explanation.blame;
  const fromStart = (x: CommitSummary) => name !== null && (kind === 'layout' || (kind === 'render' && namedFromStart(x))) && (fromAbove(x) ?? fromName(x)) === name && mostlyOf(x, false) === detail;
  const started = r.commits.filter(fromStart);
  const named = started.length ? started : r.commits.filter((x) => leafOf(x) === name && mostlyOf(x) === detail);
  return named.length ? heaviest(named) : r.commits.length ? heaviest(r.commits) : null;
}

/**
 * "801 components inside OrderSummary"; "1216 components from EventTypeWeb down, 812 of them inside Form"
 * where the walk counted fewer inside the component the render is named after than in the commit
 * (`insideCount`), from the component the render started at where that holds them all and has a name worth
 * saying (`startName`); "at least 5000 components, at least 800 of them inside Heavy" where the walk was
 * cut; "89 components inside DialogPortal" where a layout is named after `at`.
 */
function renderedWhere(c: CommitSummary, at?: string): string {
  const inside = insideCount(c);
  if (at || inside == null) return `${renderedCount(c)} inside ${at ?? leafOf(c)}`;
  const from = startName(c);
  return `${renderedCount(c)}${from ? ` from ${from} down` : ''}, ${atLeast(c)}${inside} of them inside ${leafOf(c)}`;
}

/**
 * The component `renderPhrase` says the render went "from ... down" (`startName`): only where it counts fewer
 * inside the component the commit is named after, and that is not the one rendered many times over, where
 * it says how many are inside that one and names no start. Null where it names none.
 */
function fromName(c: CommitSummary): string | null {
  const top = dominantComponent(c);
  return insideCount(c) != null && !(top && top.count > 1 && top.name === leafOf(c)) ? startName(c) : null;
}

/** What a layout in a commit with several roots is named after: the component the walk found them all under, else the app. */
export const fromAbove = (c: CommitSummary): string | undefined => (aboveRoots.has(c.hotPath) ? (aboveRoots.get(c.hotPath) ?? 'the app') : undefined);

/** Whether a render blame is named where the render started: the times on its hot path show its end took under half of it. */
function namedFromStart(c: CommitSummary): boolean {
  const leaf = leafName(c);
  if (!c.hasDurations || leaf === null || fromName(c) === null) return false;
  // Each name at or above the end holds it, and a name's total is its heaviest one's, so the least of them bounds it.
  let bound = Infinity;
  for (const name of c.hotPath.slice(0, c.hotPath.lastIndexOf(leaf) + 1)) {
    const total = c.components.find((x) => x.name === name)?.total;
    if (total != null) bound = Math.min(bound, total);
  }
  return bound < LEAF_MAX_SHARE * c.total;
}

/**
 * "re-rendering 801 components inside OrderSummary, mostly LineItem (800 of them, 161 ms)"; "re-rendering 637
 * components inside TableBody (257 ms of it in TableBody's own render)" where one component's own render was
 * most of it (`ownRender`); "mounting" where every component was rendering for the first time;
 * "hydrating" for a hydration.
 */
function renderPhrase(c: CommitSummary, at?: string): string {
  const verb = renderVerb(c);
  const leaf = at ?? leafOf(c);
  const top = dominantComponent(c);
  // React commits with nothing rendered: a retry that found the boundary still blocked, or an update
  // every component bailed out of. Calling that a re-render of no components reads as a bug in the
  // report rather than as what it is.
  if (c.rendered === 0) return 'committing without rendering a component';
  if (c.rendered === 1) return `${verb} ${leaf}`;
  let mostly = '';
  const own = ownRender(c);
  if (top && top.count > 1) {
    const time = top.self != null ? `, ${ms(top.self)}` : '';
    // The one on the path is one of many of the same name: the count inside it would be read as the count of them.
    if (top.name === leaf) return `${verb} ${renderedCount(c)} inside ${leaf} (${top.count} of them${time})`;
    // Counted over the whole commit, so after a count inside one component it says which count it is of.
    mostly = `, mostly ${top.name} (${top.count} of ${insideCount(c) == null ? 'them' : `the ${c.rendered}`}${time})`;
  } else if (own) {
    // Named even where it is the leaf: "in its own render" could be read as the render's own. In brackets, so
    // a committing or effects figure after it reads as the next part of the whole rather than more of "it".
    mostly = ` (${ms(own.self)} of it in ${own.name}'s own render)`;
  }
  return `${verb} ${renderedWhere(c, at)}${mostly}`;
}

/**
 * "the Suspense boundary in ProductPage": a Suspense boundary has no name of its own, so it is named
 * by the nearest component that holds it. "the page" where a whole root was waiting, which has no
 * component above it to be named after.
 */
function boundaryPhrase(h: Hydration): string {
  if (h.scope === 'root') return 'the page';
  return h.owner ? `the Suspense boundary in ${h.owner}` : 'a Suspense boundary';
}

/** A Long Animation Frames script as one window of the interaction sees it. */
interface ScriptPart {
  readonly script: ScriptSummary;
  /** How much of the script is counted for this window, ms: the part of it lying between the window's two edges. */
  readonly ms: number;
  /**
   * Its forced layout, in proportion to that part. The API gives a script's forced layout as one total,
   * not when in the script it happened, so the share is an estimate: the one web-vitals makes.
   */
  readonly forcedLayout: number;
  /** Whether the whole script lay inside the window, so its forced layout is its own figure rather than a share of one. */
  readonly whole: boolean;
}

/**
 * The part of each script of `frames` that falls inside the window, clipped at both edges, with that
 * part's share of the script's forced layout, because the API gives a script's forced layout as one
 * total and never says when in the script it happened.
 *
 * web-vitals takes the same intersection for `totalScriptDuration` and `longestScript` (its
 * `attribution/onINP.ts`, "intersectingScriptDuration") but clips the left edge only, so a script
 * that starts inside an interaction and runs on past the paint counts against it whole. Here it
 * counts only up to the paint: the rest ran after the screen had updated, and nobody waited for it.
 */
function scriptParts(frames: readonly FrameSummary[], from: number, to: number): ScriptPart[] {
  const parts: ScriptPart[] = [];
  for (const f of frames) {
    for (const script of f.scripts) {
      // A script that had finished before the window, or had not started by the end of it, is not part of it.
      if (script.start + script.duration < from || script.start > to) continue;
      const ms = Math.min(script.start + script.duration, to) - Math.max(from, script.start);
      const whole = script.start >= from - STAMP_TOLERANCE && script.start + script.duration <= to + STAMP_TOLERANCE;
      parts.push({ script, ms, forcedLayout: script.duration > 0 ? (ms / script.duration) * script.forcedLayout : 0, whole });
    }
  }
  return parts;
}

const forcedLayoutOf = (parts: readonly ScriptPart[]): number => parts.reduce((a, p) => a + p.forcedLayout, 0);

/** Whether every script that forced layout in this window ran inside it, so none of the total was shared out by time. */
const forcedLayoutMeasured = (parts: readonly ScriptPart[]): boolean => parts.every((p) => p.whole || p.forcedLayout === 0);

/** The script the browser charged the most forced layout to in this window; null when none forced any. */
function mostForcedLayout(parts: readonly ScriptPart[]): ScriptPart | null {
  let best: ScriptPart | null = null;
  for (const p of parts) if (p.forcedLayout > 0 && (!best || p.forcedLayout > best.forcedLayout)) best = p;
  return best;
}

/** The longest part, if it is long enough to matter. */
function longestPart(parts: readonly ScriptPart[]): ScriptPart | null {
  let best: ScriptPart | null = null;
  for (const p of parts) if (!best || p.ms > best.ms) best = p;
  return best && best.ms >= SCRIPT_MIN_MS ? best : null;
}

/** "DIV.onscroll (app.js)": a script by its name and file, and one the browser gave no name as "one with no name (app.js)". */
const namedWithFile = (s: ScriptSummary): string => `${scriptName(s) ?? 'one with no name'}${s.source ? ` (${s.source})` : ''}`;

/**
 * A sentence naming the longest script the browser recorded, where it has a name, and `also` what it did.
 * Where it has none the sentence is said only `unnamed`, for a script whose time is worth saying anyway.
 */
function longestSaid(p: ScriptPart | null, also = '', unnamed = false): string {
  return p && (unnamed || scriptName(p.script)) ? ` The longest script the browser recorded in that time was ${namedWithFile(p.script)}, ${ms(p.ms)}${also}.` : '';
}

/**
 * The word that marks a sentence as a reading rather than a measurement. Every blame that names
 * something and carries `confidence: 'inferred'` uses it, so the sentence and the data never
 * disagree; a blame of kind 'none' names nothing and has nothing to hedge.
 */
const HEDGE = 'most likely';
/** What would turn a blame read off component counts into a measured one. */
const PROFILING_BUILD = 'A profiling build of React would give exact numbers.';

/** The measured sentence, or the hedged one when the blame is a reading. */
const say = (confidence: Blame['confidence'], measured: string, likely: string): string => (confidence === 'measured' ? measured : likely);

/** The report in plain words. Frozen, like the report it explains. */
function explain(r: InteractionReport): Explanation {
  const rating = rateInp(r.duration);
  const kind = kindOf(r.type, r.pointerType);
  const headline = `${ms(r.duration)} ${kind}`;
  const where = placeOf(r);
  const notes: string[] = [];
  const handlerName = r.target?.handler ?? null;
  const component = r.target?.component ?? null;
  const handler = handlerName ? handlerPhrase(handlerName, kind) : null;
  const outsideName = handler || `code outside React (the ${kind} handler or other scripts)`;
  // React did render during the interaction and this library could not tell which interaction those
  // renders belonged to. Saying it rendered nothing would be false, and nothing said about what React
  // did here is a measurement.
  const unjoined = r.unjoinedCommits > 0;
  // No react-dom is read (it registered before install(), or cannot be read), so an empty `commits` says
  // nothing about what React did, and nothing said about React's work here is a measurement. The ladder
  // has a rung for it, in place of the guesses at the working time below the browser's own measurements.
  const blind = r.reactStatus === 'installed-late' || r.reactStatus === 'unreadable';
  // Where React stopped being read with renders read by then, those are in the report, and only the rest is unknown.
  const partway = r.reactStatus === 'unreadable' && r.commits.length + r.followUps.length > 0;
  const unsure = unjoined || blind;
  const renderedNothing = unjoined ? `React rendered during it, but ${plural(r.unjoinedCommits, 'commit')} could not be tied to this ${kind}` : `React didn't render anything`;
  /**
   * How sure a sentence about React's work can be. A commit that could not be tied to the interaction
   * is missing evidence, so nothing said about what React did here is a measurement, however good the
   * commits that did join are. The phases (waiting, painting) are the browser's numbers and keep
   * their own confidence.
   */
  const measuredFrom = (...cs: readonly CommitSummary[]): Blame['confidence'] => (!unsure && cs.every(measuredCommit) ? 'measured' : 'inferred');
  // A build that records no render durations is the one reason for an inference with a remedy worth
  // naming in the sentence. The others (a clock too coarse to time single components, a walk cut at
  // its budget, a commit joined by its timing rather than its input) each already have a note below.
  const profiling = r.commits.some((x) => !x.hasDurations) ? ` ${PROFILING_BUILD}` : '';

  const processingStart = r.start + r.inputDelay;
  const processingEnd = processingStart + r.processing + r.walkMs;
  /**
   * Working time no entry's handlers ran in. The entries painted in one frame are one working window, as
   * web-vitals counts them, so an event of the interaction that waited behind the one before it has that
   * wait inside the window: from Enter on a button that changed a class on 30,000 cells, the keydown's
   * handlers took 1 ms and the keyup waited 157 ms for the browser before its own. That time is no handler's.
   * Scripts Long Animation Frames recorded in it are theirs; without it, a React render that committed in it
   * leaves what the rest was unknown.
   */
  // Kept whole, a keyup with no listener included: its handlers start and end at once, and that start is
  // still where its wait ended. Handlers within a stamp of each other ran back to back. The entries are the
  // ones painted within 8 ms of the headline paint, the frame the working time is taken from: a keyup released
  // after the key press's paint is in a frame of its own. One painted in this frame can start its handlers just past the working time,
  // which web-vitals ends at the paint the durations' 8 ms rounding gives, so it is clamped to that end.
  const handling: { from: number; to: number; first: string; last: string; input: number }[] = [];
  const inWindow = r.entries.filter((e) => Math.abs(e.startTime + e.duration - r.end) <= RENDER_GROUP_MS && e.processingEnd >= processingStart);
  for (const e of inWindow.sort((a, b) => a.processingStart - b.processingStart)) {
    const from = Math.min(Math.max(e.processingStart, processingStart), processingEnd);
    const to = Math.max(from, Math.min(e.processingEnd, processingEnd));
    const last = handling[handling.length - 1];
    if (last && from <= last.to + STAMP_TOLERANCE) {
      last.to = Math.max(last.to, to);
      last.last = e.name;
      last.input = Math.min(last.input, e.startTime);
    } else handling.push({ from, to, first: e.name, last: e.name, input: e.startTime });
  }
  // What went into each gap: all of it from the next event's own input on, and before that, only time something
  // on record places there: a script or a frame's own style and layout Long Animation Frames recorded, or a
  // React render that kept its durations. A key held down while a paint held up off the thread kept both events
  // in one frame, with the thread idle until the key came up, and that is no wait; a timer that ran while it was
  // held is. What nothing places, a browser without those frames included, is not counted. A render is placed
  // for its own length up to its commit, not from where it started: a transition suspended on data, or a commit
  // held back for a stylesheet, leaves the thread idle in between.
  const busyBefore = (from: number, h: { from: number; input: number }): Interval[] => {
    const until = Math.min(h.input, h.from);
    const clip = (x: Interval): Interval[] => (x.from < until && x.to > from ? [{ from: Math.max(x.from, from), to: Math.min(x.to, until) }] : []);
    const placed: Interval[] = r.commits.filter((x) => x.hasDurations).map((x) => ({ from: x.at - x.total, to: x.at }));
    for (const f of r.frames ?? []) {
      placed.push(...f.scripts.map((x) => ({ from: x.start, to: x.start + x.duration })));
      if (f.styleAndLayoutStart !== null) placed.push({ from: f.styleAndLayoutStart, to: f.start + f.duration });
    }
    return placed.flatMap(clip);
  };
  const gaps = handling.slice(1).map((h, i) => {
    const from = handling[i]!.to;
    const waited = [...busyBefore(from, h), { from: Math.min(h.from, Math.max(from, h.input)), to: h.from }];
    return { from, to: h.from, waited, after: handling[i]!.last, before: h.first };
  });
  const between = gaps.reduce((a, g) => a + g.to - g.from, 0);
  // A render that committed before the next handlers began ran before them, however close.
  const inAGap = (t: number) => gaps.some((g) => t > g.from + STAMP_TOLERANCE && t < g.to);
  // A task starts only once the one before it has finished, so a script that starts from the end of one event's
  // handlers on is not theirs, however soon after: React's scheduler posts its next task for straight after.
  const startsInAGap = (t: number) => gaps.some((g) => t >= g.from && t < g.to - STAMP_TOLERANCE);
  const partsBetween = gaps.flatMap((g) => scriptParts(r.frames ?? [], g.from, g.to));
  const scriptedBetween = partsBetween.reduce((a, p) => a + p.ms, 0);
  const waitedBetween = gaps.reduce((a, g) => a + coverage(g.waited), 0);
  // Time before an input with nothing on record running: the key or the pointer still down, or work no record
  // places.
  const heldBetween = between - waitedBetween;
  const heldGap = heldBetween >= HELD_SAID_SHARE * between ? gaps.find((g) => g.to - g.from - coverage(g.waited) >= 0.5) : undefined;
  // Long frames over the wait say what filled it. They can reach a report after it is built (it is revised when
  // they do), so they change what the sentence says of it, and how much of the time before an input they place.
  const framedWaited = gaps.reduce(
    (a, g) => a + coverage((r.frames ?? []).flatMap((f) => g.waited.map((w) => ({ from: Math.max(w.from, f.start), to: Math.min(w.to, f.start + f.duration) })))),
    0,
  );
  const framesSay = !!r.frames && framedWaited >= FRAMES_COVER_SHARE * waitedBetween;
  const renderedBetween = r.commits.filter((x) => inAGap(x.at));
  const renderedBetweenMs = renderedBetween.reduce((a, x) => a + (x.hasDurations ? x.total : 0), 0);
  // React's own listener, where the script says so: its file is react-dom's, or its function is one react-dom
  // attaches. Where a production build says neither, a listener on the container of a root the hook saw is
  // React's, unless that is the document: under the Next.js App Router the root is the document, and there
  // React's click listener and a tag manager's both read "#document.onclick" (`ReactPage`).
  const page = reactPages.get(r.entries) ?? NO_REACT_PAGE;
  const targetOf = (s: ScriptSummary) => s.invoker.replace(/\.on\w+$/, '');
  const reactsOwn = (s: ScriptSummary) =>
    /react-dom/.test(s.source) || REACT_LISTENER.test(s.name) || (!page.named && targetOf(s) !== '#document' && page.roots.includes(targetOf(s)));
  // React's scheduler tasks up to a commit in a gap are that commit's render, time-sliced or not: each task is
  // the first commit's at or after its start, since a commit cannot come before its own task. A commit inside
  // any other script a long frame recorded, a store update at the end of a timer's, was rendered there, so it
  // is no task's, and says nothing of how much of that script was React's: those are weighed as scripts. So a
  // render that kept no durations is timed by React's tasks before it, where long frames recorded them, if it
  // rendered enough components to count as a render at all. (A page's own MessagePort messages look the same.)
  const renderedElsewhere = (x: CommitSummary) =>
    (r.frames ?? []).some((f) => f.scripts.some((s) => s.invoker !== REACT_TASK && x.at >= s.start && x.at <= s.start + s.duration));
  const commitFrom = (t: number) => r.commits.reduce<CommitSummary | null>((a, x) => (x.at >= t && !renderedElsewhere(x) && (!a || x.at < a.at) ? x : a), null);
  // Without durations (production builds) a render only earns the blame when it is big; a
  // click that re-rendered 10 components and took 260 ms was slow in its handler. Beside a named handler
  // its count has to explain the working time as well: a list of 50 of one component, or a tree at no
  // more than 2 ms a component (RENDER_MAX_MS_PER_COMPONENT_BESIDE_HANDLER). With durations, a commit
  // that took as long as a handler would need to be blamed earns it too: a 3 ms render whose layout
  // effects ran for 300 ms is React's work, and taking that time off the handler has to leave it
  // somewhere. A few milliseconds of committing, which any development build spends, earn nothing.
  // Effects are timed in every build, so a production build's render earns it by them too.
  const countExplains = (x: CommitSummary) =>
    x.rendered >= RENDER_MIN_COMPONENTS_BESIDE_HANDLER &&
    ((mostlyComponent(x)?.count ?? 0) >= RENDER_MIN_COMPONENTS_BESIDE_HANDLER || r.processing <= RENDER_MAX_MS_PER_COMPONENT_BESIDE_HANDLER * x.rendered);
  // A script is the handler only when it started while the input's handlers ran. One that was already
  // running when the input came (the task the input waited behind), or that ran after the handlers, is
  // named by what the browser says ran it. One that started on the timestamp they ended on came after them.
  const ranAsHandler = (s: ScriptSummary) => s.start >= processingStart - STAMP_TOLERANCE && s.start < processingEnd && !startsInAGap(s.start);
  // Each commit ran in the script whose span holds its stamp, after its start and up to its end, and in no other.
  // In Chromium a commit stamped at the end of a listener's microtask is that listener's end exactly, and the next
  // listener starts on the same tick or later. Long Animation Frames lists only scripts over 5 ms, so a short React
  // listener can be missing, and its commit is then in no script listed, not in the one before or after it. A stamp
  // on a script's first tick is that script's only where the effects React ran straight after it, a click's or a
  // key's, ended inside it: React's own listener can commit on its first tick, and a commit stamped where the
  // listener before it ended has run its effects by the time the next one starts. (The end is compared a hair
  // wide, for a start and a duration that do not add up to the end exactly in floating point.)
  const scriptsRun = (r.frames ?? []).flatMap((f) => f.scripts);
  const holderOf = (x: CommitSummary) =>
    scriptsRun.find((s) => {
      const end = s.start + s.duration + 1e-6;
      return x.at <= end && (x.at > s.start || (x.at === s.start && x.effectsEndedAt !== null && x.effectsEndedAt > s.start && x.effectsEndedAt <= end));
    }) ?? null;
  // A count says what React rendered and nothing about how long it took, so a render known by its count
  // alone is held to the working time it sat in: a long task, the bar the handler is held to without
  // durations (below) and the one LONG_TASK_MS promises. Under it, and with nothing that measured it, the count
  // is not a slow render, however large. excalidraw finishing a rectangle re-rendered 149 components in 2.8 ms
  // of working time, with 34 of the click's 40 ms on the screen update, and closing a shadcn/ui Sheet re-rendered
  // 56 in 17 ms of working time, most of it one style recalculation that no frame under 50 ms reports; both read
  // as the render. The same bar keeps a render out of the blame where its working time was the smaller part of
  // the interaction: a screen update longer than 50 ms of working time is over a long task itself, and
  // `screenOutranks` gives it the verdict. The bar is taken on the figure the sentence prints, or 49.6 ms
  // read as "50 ms of working time, short of a long task".
  const longTaskOfWork = Math.round(r.processing) >= LONG_TASK_MS;
  const countSays = (x: CommitSummary) => (handlerName ? countExplains(x) : x.rendered >= RENDER_MIN_COMPONENTS);
  // Under the bar, the handler's script a long animation frame measured holding the commit, 20 ms or more and not
  // mostly forced layout. The frame measured that script and its layout, which no frame does for an unseen
  // restyle like the Sheet's, so the count can take the render there, bounded by the script's measured time.
  const measuredHolder = (x: CommitSummary) => {
    const s = holderOf(x);
    return s && ranAsHandler(s) && s.duration >= SCRIPT_MIN_MS && s.forcedLayout < FORCED_LAYOUT_MIN_SHARE * s.duration ? s : null;
  };
  const countEarns = (x: CommitSummary) => (longTaskOfWork || !!measuredHolder(x) || (x.rendered >= RENDER_MIN_COMPONENTS_UNMEASURED && r.processing >= r.presentation)) && countSays(x);
  // React's own listener times the render it holds the same way: Gboard fires a key's oninput after its
  // keydown's handlers, and React renders what the input changed in its root listener, between the handlers.
  // Only where the render's count earns it that time: the listener runs the page's onChange too, and 12
  // components rendered in a 120 ms oninput beside an 18 ms keydown handler handed the handler the verdict,
  // with the 124 ms between said nowhere.
  const untimedIn = partsBetween.filter((p) => {
    const s = p.script;
    const own = s.invoker !== REACT_TASK && reactsOwn(s);
    const x = s.invoker === REACT_TASK ? commitFrom(s.start) : own ? (r.commits.find((y) => y.at >= s.start && y.at <= s.start + s.duration) ?? null) : null;
    return !!x && !x.hasDurations && carriesWork(x) && renderedBetween.includes(x) && (!own || countEarns(x));
  });
  const untimedMs = untimedIn.reduce((a, p) => a + p.ms, 0);
  /**
   * The time between handlers the next event waited on the main thread, React's renders aside, which are
   * weighed as renders; a script that ran there is part of it, the way a script the input waited behind is
   * part of the wait before the handlers. Where React is not read, or rendered without durations, and no
   * frame says what ran, it is unknown and taken as none.
   */
  const waitBetween =
    !framesSay && (blind || renderedBetween.some((x) => !x.hasDurations && carriesWork(x)))
      ? 0
      : Math.max(0, waitedBetween - renderedBetweenMs - untimedMs);
  const onlyGap = gaps.length === 1 ? gaps[0]! : null;
  const whereBetween = !onlyGap
    ? "between one event's handlers and the next's"
    : onlyGap.after === onlyGap.before
      ? `between one ${onlyGap.after}'s handlers and the next's`
      : `between the ${onlyGap.after}'s handlers and the ${onlyGap.before}'s`;
  const scriptPhrase = (s: ScriptSummary) => (handler && ranAsHandler(s) ? handler : aScript(s));
  const scriptBlameName = (s: ScriptSummary) => (handlerName && ranAsHandler(s) ? handlerName : scriptName(s));

  // A script counts for its part inside each window, and so does its forced layout.
  const frames = r.frames ?? [];
  // A script that started between one event's handlers and the next's is no handler's.
  const whileHandling = scriptParts(frames, processingStart, processingEnd).filter((p) => !startsInAGap(p.script.start));
  const forcedWhileHandling = forcedLayoutOf(whileHandling);
  const forcedAfterInput = forcedLayoutOf(scriptParts(frames, processingStart, r.end));
  const lateScript = longestPart(scriptParts(frames, processingEnd, r.end));
  /**
   * Does the screen update outrank everything the working time holds? Nothing that happened in
   * there can account for more of the interaction than the working time it ran in, so that is what
   * the screen update is measured against — one comparison for the whole ladder, not one per rung
   * against whatever that rung happened to claim. Two things follow. A render or a layout is no
   * longer unseated by a screen update that beats it but not the time it sat in; and because this
   * is the *same* test the screen update's own rung asks, a rung it closes is one the screen update
   * is open to take. A longer wait before the handler can still take the verdict first, since that
   * rung sits above the screen update's. What cannot happen is a verdict refused here landing below
   * the screen update, which is where it turns into `script` or into nothing at all.
   *
   * It is also what keeps two interactions of the same shape from getting opposite verdicts on the
   * strength of a component count: paging a calendar forward and toggling a theme were both 88 ms
   * with 5 ms of working time and 82 of the screen updating, and only one of them came back a
   * render. Under a long task the screen update is blamed only where its frame waited on the next
   * interaction's press (`waitedOnNext`), a rung below every one this test closes, so nothing gives way
   * to it there either.
   */
  const screenOutranks = r.presentation > LONG_TASK_MS && r.presentation > r.processing;
  // A stamp up to a millisecond either side of a script is its own where no other script the browser recorded
  // holds it, by the rule in `holderOf` (`ranInside` says why). `from` moves the start side (`next` says why).
  const holds = (s: ScriptSummary, x: CommitSummary, from = s.start - STAMP_TOLERANCE) => x.at >= from && x.at <= s.start + s.duration + STAMP_TOLERANCE && (holderOf(x) ?? s) === s;
  /**
   * The next interaction's press, where the frame this one painted in waited on it: typing fast, the next
   * key's keydown and its render come before the frame the last keyup paints in. A press coming before
   * the paint is not enough (the second click of a double click delays nothing), so the page has to
   * have worked on it before the paint for half the screen update or more, counted from the press or from
   * the end of the handlers where it came during them. A script Long Animation Frames recorded once the
   * press's own handlers began shows that work, timed, and so does React's render in the press's own dispatch
   * where it ended by the paint. That end says when the work finished and not when it began, so on it alone
   * the sentence is hedged. It is the blame only where the screen update is the larger part of the interaction,
   * as for `screenOutranks`, but without the long-task bar: what the next key keeps the last keyup's frame
   * waiting for can be under one. Under that the screen update's note says it all the same: the script
   * after the handlers is then usually the next press's handler, whose work is the next report's.
   *
   * The press's handlers began where the browser recorded a listener of its (`DIV#root.onkeydown`, or the `oninput`
   * a key dispatches right after, or a pointer's `onmousedown` or its `onclick`), and nothing that started before
   * that ran for it. One of the kinds a press dispatches is the press's only for a press of its kind, and only
   * where this interaction could not have dispatched it. A key's is where the last event this frame handled was
   * this interaction's keyup: a keydown with no keyup, or whose keyup was handled in a later frame, runs its own
   * `oninput` in its task, right after its handlers, as a checkbox's click does, and taken for the next press's, a
   * keydown's 60 ms `oninput` went to waiting and painting. An `onkeypress` or `onbeforeinput` is also the next key's where
   * that event was a pointer's, which dispatches neither: taken for a click's own, the next key's 56 ms `onkeypress` was named as
   * the click's script where 0.18.0 said the frame waited on that key.
   * A pointer's is where that event was not a pointerdown,
   * which can still dispatch its own `mousedown` or `touchstart`: a key dispatches neither, and where its keyup was
   * not handled in this frame, the next click's 56 ms `onmousedown` was named as this key's script. A pointer's
   * `onpointerup`, `onmouseup` and `onclick` are the next press's where that event was this interaction's click or
   * a key's: a pointerdown, or a pointerup whose click was too quick for an entry, still has its own to dispatch,
   * and after a key's handlers the next click's 44 ms `onclick`, its press's listeners too short to be recorded,
   * was named as this key's script. Where no listener was recorded, as for one under 5 ms, a script that started on
   * the tick this interaction's handlers ended on ran ahead of them too, and what came after it is ranked with the
   * rest under PRESENTATION_NOTE_MS, where the note and the painting blame go on the press's render alone, and is
   * the press's work over it (`ownScript` says why). Nor is a script that holds a render of this report's the
   * press's work, wherever it started, though it holds one only from its start: the next key's capture listener
   * puts that key in the ring before its handler runs, so a render stamped with this key a moment before that
   * handler began came before it. Held by it, the next key's 44 ms handler was this key's script. Taken for the
   * next key's, React's own task that committed a key's render, and a timer as its handlers ended or before the
   * next key's listener, went to waiting and painting, and from half of the screen update the note said the frame
   * waited on that key. The next key's handler on the tick after this key's was named as this key's script. A
   * render joined by overlap alone says too little to keep a script: in the next key's handler, one kept that
   * handler as this key's verdict.
   */
  const next = r.nextInput;
  // A next click whose pointerdown the ring does not have after this interaction, pressed before it or not recorded,
  // is weighed as in 0.18.0, every script from the click on its work but one holding a render of this report's, as
  // for any next press: nothing here tells its listeners from this interaction's, and weighed on the rules below,
  // its 36 ms `onclick` was a key's script where 0.18.0 said the frame waited on that click.
  const clickOnly = next?.type === 'click';
  const nextFrom = next ? Math.max(next.start, processingEnd) : 0;
  const last = r.entries.reduce((a: EventEntrySummary | null, e) => (e.processingStart <= processingEnd && (!a || e.processingStart >= a.processingStart) ? e : a), null)?.name ?? '';
  const nextListener =
    next &&
    !clickOnly &&
    scriptsRun.find((s) => {
      const on = s.start >= nextFrom - STAMP_TOLERANCE && PRESS_LISTENER.exec(s.invoker);
      return on && (on[2] ? next.type === 'keydown' && (last === 'keyup' || (on[2] !== 'input' && !last.startsWith('key'))) : !(on[3] || on[4]) || (next.type === 'pointerdown' && (on[3] ? last !== 'pointerdown' : /^(click|key)/.test(last))));
    });
  const nextsWork = (s: ScriptSummary) =>
    !!next &&
    (clickOnly
      ? s.start >= next.start - STAMP_TOLERANCE
      : nextListener
        ? s.start >= nextListener.start
        : s.start >= nextFrom - STAMP_TOLERANCE && s.start > processingEnd + STAMP_TOLERANCE) &&
    !r.commits.some((x) => x.joinedBy === 'exact' && holds(s, x, s.start));
  const nextScriptMs = scriptParts(frames, nextFrom, r.end).reduce((a, p) => (nextsWork(p.script) ? Math.max(a, p.ms) : a), 0);
  // The paint time is rounded to 8 ms. A render that ended later than that ran after the frame, which did not wait on it.
  const nextRenderMs = next?.endedAt != null && next.endedAt <= r.end + RENDER_GROUP_MS ? Math.min(next.endedAt, r.end) - nextFrom : 0;
  const nextShare = WAITED_BEHIND_MIN_SHARE * r.presentation;
  const heldByNext = next && Math.max(nextScriptMs, nextRenderMs) >= nextShare ? next : null;
  // The screen update's clause where the frame waited on that press, as the blame or in the note. The
  // clause about the press is hedged where only its render's end says so.
  const nextClause = (sure: boolean) =>
    `: the frame ${sure ? '' : `${HEDGE} `}waited on the next ${kindOf(next!.type, next!.pointerType)}, which the page handled first.${longestSaid(lateScript)}`;
  // Under PRESENTATION_NOTE_MS the verdict ranks the scripts after the handlers with the rest, every one of them
  // where no listener of that press is on record (`ownScript` and `lateTaken`), so there the note, and the blame
  // where the screen update outranks the working time, go on the press's render alone, hedged as the render's end
  // is: counted from the tick after the handlers, a keydown's own 38 ms timer was its verdict, and the note said in
  // the same report that the frame waited on the next key, naming that timer. Its own 50 ms timer, the painting
  // blame's script without the next key, was said as the next key's wait. Not for a next click with only its click
  // in the ring, which 0.18.0 weighed on its scripts too.
  const byRender = !nextListener && !clickOnly && r.presentation <= PRESENTATION_NOTE_MS;
  const nextNoted = byRender ? next && nextRenderMs >= nextShare : heldByNext;
  const waitedOnNext = nextNoted && r.presentation > r.processing && r.presentation >= r.inputDelay ? next : null;
  /**
   * React's renders that committed inside that script, after the handlers, however long the screen update
   * and whichever phase was the longer: the screen update's clause says them, as its blame or in the note
   * below, which is kept for them. That is what a virtualizer's scroll listener spends its time on when it
   * calls flushSync, or React's own task for an update it scheduled. On TanStack Table's virtualized rows at
   * 4x a checkbox's frame waited on `DIV.onscroll` for 174 ms, a render of the 721 rows it forced, which the
   * report held and the sentence never tied to the script. Tied only over 100 ms, the same render in a 96 ms
   * screen update stayed in the working time and was put down to an effect. React's own task is tied only
   * where the screen update outranks the working time. Under that, its render is the one the handlers
   * scheduled, a transition started from the click, and stays in the working time as the interaction's
   * render: tied to the task, a 100 ms render of 721 rows after 200 ms of handlers was put on a script named
   * `MessagePort.onmessage`, as though React had rendered nothing. The clause still says the render ran inside
   * the task, though, or the note put 150 ms on `MessagePort.onmessage` and never said that the render the
   * verdict named was what it did. Where the build keeps when a render began, it has to have begun inside the
   * script too, and a render duration longer than the script cannot have been in it. A stamp up to a
   * millisecond either side of the script is its only where no other script the browser recorded holds it, by
   * the rule above, so a stamp on the tick one script ends and the next begins is the first one's: a production
   * render committed at the end of React's own task was put in a timer that started on that tick or under a
   * millisecond later, and so out of the working time, as though React had rendered nothing there. A hydration
   * is left where it was: it has a sentence of its own.
   */
  const ranInside = (x: CommitSummary, s: ScriptSummary) =>
    (x.hasDurations ? x.total > 0 || x.rendered > 0 : x.rendered > 0) &&
    x.hydratedTarget == null &&
    x.at > processingEnd + STAMP_TOLERANCE &&
    holds(s, x) &&
    (x.startedAt === null || x.startedAt >= s.start - STAMP_TOLERANCE) &&
    (!x.hasDurations || x.total <= s.duration + STAMP_TOLERANCE);
  // Not where the note says the frame waited on the next press, whose render it would be: where it does not, a render
  // inside the script is said inside it, not counted as a second render beside the handlers'.
  // Once one render with work in it is inside, every render inside is counted there: kept to those with work, a
  // Base UI frame callback holding 8 commits read "React rendered inside it 4 times", and the other 4 were put
  // in the working time as renders after the handlers.
  const ranInScript = lateScript && !nextNoted ? r.commits.filter((x) => ranInside(x, lateScript.script)) : [];
  const ranInLate = ranInScript.some(carriesWork) ? ranInScript : [];
  const insideLate = screenOutranks || lateScript?.script.invoker !== REACT_TASK ? ranInLate : [];
  const lateRender = ranInLate.length ? heaviest(ranInLate) : null;
  // Said right after the script, the render is "inside it". After all the scripts together, "inside that one".
  const renderedInside = (it: string) =>
    !lateRender
      ? ''
      : ranInLate.length === 1
        ? `, and React rendered inside ${it}: ${lateRender.hasDurations ? `${ms(lateRender.total)} ` : ''}${renderPhrase(lateRender)}`
        : `, and React rendered inside ${it} ${ranInLate.length} times, the ${lateRender.hasDurations ? `heaviest ${ms(lateRender.total)}` : 'largest'} ${renderPhrase(lateRender)}`;
  const lateRenderSaid = renderedInside('it');
  /**
   * Where no script took the screen update, the browser's own work on the main thread did, where Long
   * Animation Frames saw it. A key press's style and layout is timed as the frame's own, from its
   * `styleAndLayoutStart`. A click's is mostly done before the frame starts rendering, for the pointer's hit
   * test, and shows only as frame time no script ran in: in Chromium, a click that changed a class on 40,000
   * elements spent 213 of its 231 ms there, and the same change from Enter 211 ms timed as the frame's own.
   */
  const afterHandlers = (from: number, to: number) => Math.max(0, Math.min(to, r.end) - Math.max(from, processingEnd));
  // What a frame ran after its style and layout began, ResizeObserver callbacks say, is not the browser's.
  const frameLayout = frames.reduce((a, f) => {
    const from = f.styleAndLayoutStart;
    if (from === null) return a;
    const scripted = scriptParts([f], Math.max(from, processingEnd), Math.min(f.start + f.duration, r.end)).reduce((b, p) => b + Math.max(0, p.ms), 0);
    return a + Math.max(0, afterHandlers(from, f.start + f.duration) - scripted);
  }, 0);
  const lateScripted = scriptParts(frames, processingEnd, r.end).reduce((a, p) => a + p.ms, 0);
  const unscripted = frames.reduce((a, f) => a + afterHandlers(f.start, f.start + f.duration), 0) - lateScripted;
  const browserShare = BROWSER_WORK_MIN_SHARE * r.presentation;
  const browserClause =
    frameLayout >= browserShare
      ? `, mostly the browser recalculating styles and layout and painting the frame: ${ms(frameLayout)}.`
      : unscripted >= browserShare
        ? `${lateScript ? ':' : '. No script ran for long in that time:'} ${ms(unscripted)} of it was the browser's own work on the main thread, ${HEDGE} recalculating styles and layout.`
        : null;
  // The script is what the screen update waited on from half of it. Under that it is said after the
  // browser's own work, with any render inside it, and said where the browser gave it no name too: a 20 ms
  // timer in a frame that spent 250 ms on style and layout is not why the screen took 370 ms to update, but
  // a 150 ms script is time in it all the same, with a name or without. Where neither the browser nor any
  // one script held half, the scripts together can have, and are said the way the scripts between one
  // event's handlers and the next are: two of 150 and 120 ms in a 370 ms screen update were otherwise left
  // with the longest one's figure and no cause at all.
  const lateLeads = lateScript && lateScript.ms >= WAITED_BEHIND_MIN_SHARE * r.presentation ? lateScript : null;
  const lateScriptClause = lateLeads
    ? `, mostly because ${scriptPhrase(lateLeads.script)} ran for ${ms(lateLeads.ms)} before the next frame${lateRenderSaid}.`
    : !browserClause && lateScripted >= WAITED_BEHIND_MIN_SHARE * r.presentation
      ? `. Scripts ran for ${ms(lateScripted)} of it${lateScript ? `, the longest ${aScript(lateScript.script)} for ${ms(lateScript.ms)}${renderedInside('that one')}` : ''}.`
      : `${browserClause ?? '.'}${longestSaid(lateScript, lateRenderSaid, true)}`;

  // Renders an earlier entry made before this one's input, where that entry painted in a frame of its own: a key's
  // press committed a moment before its slower release. They are the press's work and none of this entry's.
  const earlier = r.entries.filter((e) => e.startTime < r.start && Math.abs(e.startTime + e.duration - r.end) > RENDER_GROUP_MS);
  const pressed = r.commits.filter((x) => x.at < r.start && !near(x.inputTs, r.start) && earlier.some((e) => near(x.inputTs, e.startTime)));
  // Such an entry whose handlers had ended when this input came and which painted only after this one's handlers
  // began: the whole wait before them was that entry's screen update, as Event Timing alone shows.
  const waitedOnPress = earlier.find((e) => e.processingEnd <= r.start + STAMP_TOLERANCE && e.startTime + e.duration >= processingStart - STAMP_TOLERANCE) ?? null;
  // At half the interaction the wait outweighs the other two phases together, so nothing else can be what took it.
  const pressWaitLeads = !!waitedOnPress && r.inputDelay >= r.processing && r.inputDelay >= r.presentation && r.inputDelay >= r.duration / 2;
  // The commits of the working time. One the screen update's clause ties to the script it ran in is that
  // script's, or the same render is said twice, once as the script's and once as the handlers'.
  const inWorkingTime = r.commits.filter((x) => !insideLate.includes(x) && !pressed.includes(x));
  const c = inWorkingTime.length ? heaviest(inWorkingTime) : null;
  const renderTotal = inWorkingTime.reduce((a, x) => a + x.total, 0);
  /**
   * Renders the screen update's clause says a script after the handlers forced: synchronous ones (Scheduler
   * priority 1, React 17's 99, or a build that does not say) in a script that is not React's own task, which Long
   * Animation Frames names `MessagePort.onmessage`. An update an effect made renders there, and on React 17 at 99
   * as well. The script set them off, not an effect.
   */
  const forcedByScript =
    lateScript && lateScript.script.invoker !== REACT_TASK ? insideLate.filter((x) => x.priority === undefined || x.priority === 1 || x.priority === 99) : [];
  /**
   * React's renders, one set for every sentence that counts them and for the "React rendered N times" note: every
   * commit that rendered at all but a render a script forced. Counted apart, a cause read "rendering across 3
   * commits" beside a note saying React "rendered 2 times": the note left out a 3 ms render the total had. A build
   * that records no durations counts every commit that rendered a component too, or plate's search dialog read
   * "React rendered 8 times" where 13 commits rendered. Its renders have no times, so no sentence totals them. The
   * note adds one whose committing or effects were worth saying, or that the render blame names. A hydration is rendering and is
   * counted, though the note is not said for one. The sentences about the working time leave out a render the
   * screen update's clause says was inside a script after it, which the note still counts.
   */
  const rendersAll = r.commits.filter((x) => !forcedByScript.includes(x) && !pressed.includes(x) && (x.hasDurations ? x.total > 0 || x.rendered > 0 : x.rendered > 0));
  const renders = rendersAll.filter((x) => !insideLate.includes(x));
  const rendersMs = renders.reduce((a, x) => a + x.total, 0);
  /**
   * React's render time where several commits hold it, said as their total with the named commit's share:
   * "React spent 55 ms rendering across 2 commits, 30 ms of it re-rendering 30 components inside List". Said
   * beside the one commit's phrase, the total gave List a 500-component Sidebar's 25 ms, and a render blame
   * three 3 ms commits earned together said 3 ms. The share is not called the heaviest, since the commit a
   * blame names can be a lighter render chosen for its committing and effects. `alone` is the figure a
   * sentence gives where one commit holds all of it. Every commit that rendered at all is counted, or six
   * renders of under 1 ms each beside List's 30 ms put their 2 ms on List. A commit named that is none of the
   * renders counted is said alone.
   */
  const severalRenders = (named: CommitSummary) => renders.length > 1 && renders.includes(named) && Math.round(rendersMs) - Math.round(named.total) >= 1;
  const renderSpent = (named: CommitSummary) => (renders.includes(named) ? rendersMs : named.total);
  const renderAcross = (named: CommitSummary, alone: string, at?: string) =>
    severalRenders(named)
      ? `${underOr(rendersMs)} rendering across ${plural(renders.length, 'commit')}, ${underOr(named.total)} of it ${renderPhrase(named, at)}`
      : `${alone} ${renderPhrase(named, at)}`;
  // The same total, for a sentence that leads with the named commit's figure and keeps its word order. It goes
  // after the working time, so only the named render is set against it: led with the total, a note put 35 ms of
  // rendering, some of it after the handlers, in 25 ms of working time. It says what it totals, or after "30 ms
  // re-rendering ... and 60 ms committing it" it read as the sum of the two.
  const inAll = (named: CommitSummary) => (severalRenders(named) ? `, and ${ms(rendersMs)} of rendering in all across ${plural(renders.length, 'commit')}` : '');
  // What the build records, which a report whose every commit was the late script's still says.
  const hasDurations = (c ?? r.commits[0])?.hasDurations ?? false;
  /**
   * The script a verdict names once React is ruled out: the longest anywhere in the interaction but the next
   * press's, except where the screen update's note names the late script, which it does wherever a render ran in it
   * and, with none, over PRESENTATION_NOTE_MS. The next press's is what `nextsWork` counts as its work, where the
   * browser recorded a listener of that press, and no verdict takes it: ranked with the rest, a keydown's verdict
   * named the next key's 44 ms handler, under half of a 90 ms screen update, as having run after its own. With no
   * such listener nothing shows where that press's work began, and every script is ranked: left out from the tick
   * after the handlers on, a timer or React's task of a key's own went to waiting and painting, and the note named
   * it as the longest script. Where the frame waited on the next press the note says so under PRESENTATION_NOTE_MS
   * too (with no such listener, only where that press's render shows it: `byRender` says why), and names the late
   * script, but that does not take the script out of the ranking: left to the note, a keydown's own 30 ms timer,
   * under half of a 90 ms screen update, went to waiting and painting. Where the note names the late script, the
   * verdict takes it only where it held half of the screen update: a 40 ms listener in a 157 ms screen update that
   * spent 110 ms on style and layout is under half of either phase, and is left to the note, with a render in it or
   * without. Taken without, a 60 ms listener was a `script` verdict where the same listener with a render in it was
   * `none`. Where the frame waited on the next press, the note says so and the verdict does not take that press's
   * work even from half: waitedOnNext leaves it to the next report. Taken, a keyup's verdict named the next key's
   * 50 ms handler, and under a 90 ms screen update, with no note, a keydown's named the next key's 70 ms handler as
   * having run after its own. A script that is not that press's work is this interaction's own, though, and still
   * taken: left out, a 60 ms timer between a keydown's handlers and the next key went to waiting and painting, and
   * the note named it as the longest script. Nor, under PRESENTATION_NOTE_MS with no listener of that press on
   * record, is any script that press's work (`byRender`): taken for it, a keydown's own 50 ms timer, the verdict
   * without the next key, lost it to 181 ms of idle handlers. Nor, where the note leaves the late script out, is a
   * next click's with only its click in the ring, as 0.18.0 ranked every script there. The rest is ranked by
   * length, not by where it ran, against every script up to the end of the handlers: ranked by where, a 20 ms click
   * handler took the verdict from the 150 ms listener, and a 25 ms pointerdown listener from a 120 ms timer the
   * click waited behind, which was then said nowhere. `ledScript` is that ranking whether or not the note names the
   * script after the handlers, for the idle handler's rung below, where `ranScript` is settled.
   */
  const lateOnly = insideLate.length > 0 && !c;
  const lateNoted = insideLate.length > 0 || (!!lateScript && r.presentation > PRESENTATION_NOTE_MS);
  const lateTaken = lateLeads && (byRender || (clickOnly && !lateNoted) || !heldByNext || !nextsWork(lateLeads.script)) ? lateLeads : null;
  const earlyScript = longestPart(scriptParts(frames, r.start, processingEnd));
  const ledScript = lateTaken && (!earlyScript || lateTaken.ms > earlyScript.ms) ? lateTaken : earlyScript;
  const ownScript = longestPart(scriptParts(frames, r.start, r.end).filter((p) => !(nextListener && nextsWork(p.script))));
  // Where every render ran in the script after the handlers, the screen update's note says it: React did
  // render, just not in the working time, and a verdict that names no render says that much. So it does where
  // a press rendered after it painted, before a slower release: the later render's note, right after it, says
  // that render, and said bare the two sentences read as React rendering nothing and then something.
  const workingOnly = (lateOnly || (!c && (pressed.length > 0 || r.followUps.some((x) => x.at < r.end)))) && !unjoined;
  const noneWorking = workingOnly ? "React didn't render anything in the working time" : renderedNothing;
  /**
   * The window the scripts, and so the forced layout, were counted across. It runs to the end of the
   * library's own walk, because the walk happens inside the same script the handlers did, and
   * `processing` has that walk taken back out of it. Anything printed against the forced layout is
   * printed against this, or it reads as "110 ms of the 100 ms of working time". Time between one event's
   * handlers and the next's is left out, as its scripts are.
   */
  const handledWindow = r.processing + r.walkMs - between;
  /**
   * React's own time while the input was handled, where the build keeps when each render began: from
   * that start to the end of its commit, so committing is in it, the DOM changes, ref callbacks and
   * layout effects that a render duration leaves out. Only a development or profiling build keeps the
   * start, so a production build has no such span. A span only counts when it began and ended inside
   * one event's handlers. React does not yield in there, so a render that began before them, or
   * committed after, waited or yielded on the way, and what ran meanwhile (the handler, most often) was
   * not React's. Its render duration stands for it, as in a production build. Spans that overlap
   * count once: a root flushed from inside another root's layout effect commits within that span.
   */
  // No slack at the start: a commit and an entry's handlers are timed on the same clock, and what began even a tick
  // before them was not theirs (a transition committed there has its effects held for the next render).
  const inOneHandler = (from: number, to: number) => r.entries.some((e) => from >= e.processingStart && to <= e.processingEnd + STAMP_TOLERANCE);
  const spans = r.commits
    .flatMap((x, order) => {
      const began = x.startedAt;
      // A commit the screen update's clause gave to its script is that script's, and outside the working time.
      if (began === null || insideLate.includes(x) || !inOneHandler(began, x.at)) return [];
      const from = Math.max(began, processingStart);
      const to = Math.min(x.at, processingEnd);
      // The working time ends at the paint the duration's 8 ms rounding gives, which can be before the handlers' own
      // end: a commit that ended past it is timed all the same, with none of it in the working time. So is one that
      // began and ended on the same step of a 0.1 ms clock.
      return to >= from || x.at > processingEnd ?[{ commit: x, order, from, to: Math.max(from, to) }] : [];
    })
    .sort((a, b) => a.from - b.from);
  /**
   * The passive effects', the `useEffect`s', in every build: React 18 and 19 say when a commit's have
   * run, and run a click's or a key press's right after its commit, in the same task. From the end of
   * the hook call for the commit (this library's walk and React DevTools' own reading are not theirs)
   * to then is theirs, under the same rule as a span: the commit and the end of its effects inside one
   * event's handlers. Effects React ran in a later task have no figure here, since whatever ran between
   * the two tasks was not theirs.
   */
  const effectSpans = r.commits.flatMap((x, order) => {
    const began = x.effectsStartedAt;
    const ended = x.effectsEndedAt;
    if (began === null || ended === null || !inOneHandler(x.at, ended)) return [];
    const from = Math.max(began, processingStart);
    const to = Math.min(ended, processingEnd);
    return to > from ? [{ commit: x, order, from, to }] : [];
  });
  // This library's walk of each commit, which `processing` already leaves out. One inside another
  // commit's span, a root committed inside it, is not React's time either.
  const walks = r.commits.map((x) => ({ from: x.at, to: x.at + x.walkMs }));
  const spanned = coverage([...spans, ...effectSpans], walks);
  const spannedRender = spans.reduce((a, x) => a + x.commit.total, 0);
  /**
   * What committing took beyond the render, for each commit with a span: the span less its own render,
   * and less the span of any root it flushed inside it, which is that root's time and counted there.
   */
  const committingOf = new Map<CommitSummary, number>();
  // On a 1 ms clock a root flushed inside another can share both its edges; it committed first, so the
  // earlier of two identical spans is the one inside.
  const within = (inner: (typeof spans)[number], outer: (typeof spans)[number]) =>
    inner !== outer && inner.from >= outer.from && inner.to <= outer.to && (inner.from > outer.from || inner.to < outer.to || inner.order < outer.order);
  for (const span of spans) {
    // The walks of the roots flushed inside it are in their gaps, after each one's own span, and are
    // this library's time.
    const flushed = spans.filter((o) => within(o, span));
    committingOf.set(span.commit, Math.max(0, coverage([span], [...flushed, ...walks]) - span.commit.total));
  }
  const committing = [...committingOf.values()].reduce((a, x) => a + x, 0);
  /**
   * What each commit's effects took: the span less the React time of anything committed inside it,
   * which is counted as that commit's, and less the walks. React commits an update an effect made with
   * `flushSync`, or one a layout effect made, once the effects are done and before it says so, so such
   * a commit lands inside. Where it has no span of its own (a production build keeps no render start),
   * its render cannot be taken out, and the figure says it holds one.
   */
  const effectsOf = new Map<CommitSummary, number>();
  const rendersInside = new Map<CommitSummary, number>();
  for (const span of effectSpans) {
    const within = (o: Interval) => o.from >= span.from && o.to <= span.to;
    const inside = [...spans, ...effectSpans].filter((o) => o.commit !== span.commit && within(o));
    effectsOf.set(span.commit, Math.max(0, coverage([span], [...inside, ...walks])));
    const unspanned = r.commits.filter((x) => x !== span.commit && x.at > span.from && x.at < span.to && !spans.some((o) => o.commit === x));
    if (unspanned.length) rendersInside.set(span.commit, unspanned.length);
  }
  const effects = [...effectsOf.values()].reduce((a, x) => a + x, 0);
  // React's own time for a commit: its render, committing it and its effects.
  const own = (x: CommitSummary) => x.total + (committingOf.get(x) ?? 0) + (effectsOf.get(x) ?? 0);
  /**
   * Where the read that forced a layout could have been, for the sentence that says what forces one. It is
   * usually a layout effect's, and two records can rule that out. The browser charges forced layout to the
   * script it happened in, and React commits inside the script that ran it, the microtask a click queues
   * included (checked in Chromium: a click listener's script runs to the end of the microtask it queued and
   * is charged that microtask's layout). So layout charged to scripts no commit of this interaction ran in
   * was in no layout effect, in any build. Where a commit did run in the script, a build that times the
   * commit bounds how much of it the commit and its effects could have held: at most what they took, so a
   * 2 ms commit held at most 2 of 70 ms. With React unread through the handlers (`unseen`), or a commit not
   * tied to this interaction, only the usual place is said. It is only asked of the working time: after it,
   * a commit another input made can run in the same script, and that commit is not in this report.
   */
  // Whose handlers a script ran in, from its start, and a commit, from its stamp: the innermost event's, the one
  // that began last and, of two that began together, ends first, since Chromium dispatches the click a key sets off
  // inside that key's own handlers. A script starting where an event's handlers ended is not that event's, and a
  // commit stamped where an event's handlers began is the event's already running, where one is: the new event's
  // listeners most likely had not run yet.
  const handlingAt = (t: number, stamp: boolean) => {
    const rank = (e: EventEntrySummary) => [stamp && e.processingStart < t ? 1 : 0, e.processingStart, -e.processingEnd];
    let at: EventEntrySummary | null = null;
    for (const e of r.entries) {
      if (t < e.processingStart || (stamp ? t > e.processingEnd : t >= e.processingEnd)) continue;
      if (!at || isAfter(rank(e), rank(at))) at = e;
    }
    return at;
  };
  const nestedIn = (inner: EventEntrySummary, outer: EventEntrySummary) => inner.processingStart >= outer.processingStart && inner.processingEnd <= outer.processingEnd;
  const committedIn = (x: CommitSummary, s: ScriptSummary) => holderOf(x) === s;
  // A commit in the handlers of a script's event, or of an event dispatched inside them, and not in the script,
  // says React's listener for that event may have been another script, listed or too short to be, and the handler
  // may have run there. Nothing tells React's listener from a library's that set state, so such a script is named
  // by what ran it, not by the handler's name.
  const committedBeside = (s: ScriptSummary) => {
    const e = handlingAt(s.start, false);
    return (
      e !== null &&
      r.commits.some((x) => {
        const theirs = handlingAt(x.at, true);
        return theirs !== null && nestedIn(theirs, e) && !committedIn(x, s);
      })
    );
  };
  // React's own scheduler task can hold a render and no commit, a transition's time slice, so it is never counted
  // as outside React.
  const outsideReact = (parts: readonly ScriptPart[]) =>
    unseen || unjoined ? [] : parts.filter((p) => p.forcedLayout > 0 && p.script.invoker !== REACT_TASK && !r.commits.some((x) => committedIn(x, p.script)));
  /**
   * The sentence; whether the layout could still be in the subtree React rendered, which the blame names only
   * then; the commit in the scripts that forced it, whose subtree that is; and whether several commits ran there
   * and none could have held most of it (`untied`), where no subtree is named.
   */
  const whereRead = (parts: readonly ScriptPart[]): { said: string; inTheSubtree: boolean; commit: CommitSummary | null; untied?: boolean } => {
    const usual = { said: USUAL_READ, inTheSubtree: true, commit: null };
    if (unseen || unjoined) return usual;
    const handlerOrListener = `code outside React, such as ${handler ?? `the ${kind} handler`} or a library's listener`;
    // "In the working time" where a press's render before the release is the later render's note after it.
    if (r.commits.length === 0) return { ...usual, said: `${READS_SIZE}. React did not render${workingOnly ? ' in the working time' : ''}, so it was ${handlerOrListener}.`, inTheSubtree: false };
    const forced = forcedLayoutOf(parts);
    const forcing = parts.filter((p) => p.forcedLayout > 0);
    const outside = outsideReact(parts);
    const forcedOutside = forcedLayoutOf(outside);
    if (forcedOutside >= FORCED_LAYOUT_IN_REACT_SHARE * forced) {
      const scripts = outside.length === 1 ? 'a script' : 'scripts';
      const lead =
        outside.length === forcing.length
          ? `No React commit ran in the ${outside.length === 1 ? 'script' : 'scripts'} that forced it, so it was`
          : Math.round(forcedOutside) >= Math.round(forced) || forced - forcedOutside < 0.5
            ? `All but under 1 ms of it was forced in ${scripts} no React commit ran in, so that was`
            : `${cap(ms(forcedOutside))} of it was forced in ${scripts} no React commit ran in, so that was`;
      return { said: `${READS_SIZE}. ${lead} not in a layout effect but in ${handlerOrListener}.`, inTheSubtree: false, commit: null };
    }
    // The commits that ran in the scripts that forced it. Each has to be timed whole inside one event's
    // handlers, or what its commit took is not known. React's scheduler task forcing layout with no commit in
    // it held a render of unknown length, so then only the usual place is said too.
    const theirs = r.commits.filter((x) => forcing.some((p) => committedIn(x, p.script)));
    if (!theirs.length) return usual;
    const inScripts = forced - forcedOutside;
    // Of several, the one whose time could hold most of the layout (`couldHold`), not the one that rendered most.
    let commit: CommitSummary | null = theirs[0]!;
    let untied = false;
    if (theirs.length > 1) {
      const held = theirs.map((x) => couldHold(x, theirs));
      const most = held.indexOf(Math.max(...held));
      untied = held[most]! < FORCED_LAYOUT_IN_REACT_SHARE * inScripts;
      commit = untied ? null : theirs[most]!;
    }
    const scripts = forcing.filter((p) => theirs.some((x) => committedIn(x, p.script))).length === 1 ? 'the script' : 'the scripts';
    const noneHeld = `React committed ${theirs.length} times in ${scripts} that forced it, and none of those commits took long enough to hold most of it, so which code read the size isn't known.`;
    const tied = (said: string) => (untied ? { said: `${said} ${noneHeld}`, inTheSubtree: true, commit: null, untied } : { said, inTheSubtree: true, commit });
    const slice = forcing.some((p) => p.script.invoker === REACT_TASK && !theirs.some((x) => committedIn(x, p.script)));
    if (slice || !theirs.every((x) => committingOf.has(x))) return tied(untied ? `${READS_SIZE}.` : USUAL_READ);
    const inReact = theirs.reduce((a, x) => a + (committingOf.get(x) ?? 0) + (effectsOf.get(x) ?? 0), 0);
    if (inReact >= FORCED_LAYOUT_IN_REACT_SHARE * inScripts) return tied(untied ? `${READS_SIZE}.` : USUAL_READ);
    // React 17, and a commit with no useEffect, report no effects, so only the commit is said to be timed.
    const effectsTimed = theirs.some((x) => effectsOf.has(x));
    const one = theirs.length === 1;
    const where = `a layout effect${effectsTimed ? ', a ref callback or an effect' : ' or a ref callback'}`;
    const bound = `React's ${one ? 'commit' : 'commits'}${effectsTimed ? ' and effects' : ''} took ${underOr(inReact)} in all, so at most that much of the layout was in ${where}`;
    // A render body can read a size too, and a render of r ms holds at most r ms of layout: where the render
    // could hold most of the rest it stays in what the rest could be, and so does its subtree in the blame.
    const renderMs = theirs.reduce((a, x) => a + x.total, 0);
    if (inReact + renderMs >= FORCED_LAYOUT_IN_REACT_SHARE * inScripts) return tied(`${READS_SIZE}. ${bound}, and the rest in React's render or code outside React.`);
    const all =
      renderMs < 0.5
        ? bound
        : `React's ${one ? 'commit' : 'commits'}${effectsTimed ? ', effects' : ''} and ${one ? 'render' : 'renders'} took ${underOr(inReact + renderMs)} in all, so at most that much of the layout was in React`;
    return { said: `${READS_SIZE}. ${all}, and the rest in ${handlerOrListener}.`, inTheSubtree: false, commit: commit ?? heaviest(theirs) };
  };
  /**
   * The most of a forced layout a commit in the forcing scripts could have held. Timed, that is React's own time for
   * it (`own`). Untimed, it is its effects and the gap since the commit before it in the same script and the same
   * event's handlers, which holds its render, its committing, its layout effects and ref callbacks. The first
   * commit there has nothing before it, so its gap runs from the start of the script or of the event's handlers,
   * whichever is later: that holds the handler too, and is only an upper bound.
   */
  const couldHold = (x: CommitSummary, theirs: readonly CommitSummary[]): number => {
    if (x.hasDurations) return own(x);
    const script = holderOf(x);
    const event = handlingAt(x.at, true);
    let before: CommitSummary | null = null;
    for (const o of theirs) if (o.at < x.at && holderOf(o) === script && handlingAt(o.at, true) === event && (!before || o.at > before.at)) before = o;
    const from = before ? (before.effectsEndedAt ?? before.at + before.walkMs) : Math.max(script?.start ?? x.at, event?.processingStart ?? -Infinity);
    return Math.max(0, x.at - from) + (effectsOf.get(x) ?? 0);
  };
  /** Where a commit's effects figure holds renders it could not take out: ", one more render included". */
  const includedN = (n: number) => (n === 0 ? '' : `, ${n === 1 ? 'one more render' : `${n} more renders`} included`);
  const included = (x: CommitSummary) => includedN(rendersInside.get(x) ?? 0);
  // Committing and effects that would have been enough to blame the handler, had they been the handler's.
  const committingShows = (t: number) => t >= HANDLER_MIN_MS && t >= HANDLER_MIN_SHARE * r.processing;
  const committingMatters = committingShows(committing + effects);
  // A production build has no render durations, so what is left of the working time once the effects
  // are out is the handler and the render together, unsplit. There the effects earn React the blame
  // only where they are at least that remainder: a 150 ms handler beside 60 ms of effects is still the
  // handler's, though the 60 ms are worth saying.
  // Without a handler's name there is no sentence to say them in, and the rest is no one's to take,
  // unless the browser names a script that ran beside React rather than around it (none of the
  // effects inside it), a listener on the document, and for longer.
  const besideReact = longestPart(whileHandling.filter((p) => !effectSpans.some((e) => p.script.start < e.to && p.script.start + p.script.duration > e.from)));
  const effectsEarn =
    committingMatters && (hasDurations || committing + effects >= r.processing / 2 || (!handler && !(besideReact && besideReact.ms > committing + effects)));
  // React's time in all: the spans, and the render durations of the commits that have none.
  const reactWhileHandling = spanned + renderTotal - spannedRender;
  // What the handler has to outrun to be the blame: all of React's time, committing and effects
  // included, not only its render durations, or a 100 ms handler beside a 5 ms render and 200 ms of
  // effects was blamed and the effects went unsaid.
  const reactTime = Math.max(renderTotal, reactWhileHandling);
  // Working time that was neither React's nor forced layout: the handler itself, or other scripts in
  // the same task. Subtracting React's render is what makes it the handler's, so a build that records
  // no durations has no such figure: there this would be the whole working time wearing the handler's
  // name. Subtracting React's commit too keeps a commit phase heavy with layout effects off the handler,
  // which is all that stood between the two in a browser that does not time forced layout. Where it
  // does, forced layout inside React's commit is in both figures, so the larger of the two is taken
  // rather than their sum. The walk is taken out too, by starting from `processing` rather than the
  // window above: it is this library's time, not the app's.
  // Nor can it be more than the handlers' own time, which leaves out what ran between one event's handlers
  // and the next's.
  const outside = Math.max(0, r.processing - between - Math.max(0, Math.max(reactWhileHandling, renderTotal + forcedWhileHandling) - renderedBetweenMs));
  // Where React is read, or no react-dom has loaded yet, and no commit during the handlers went unjoined, a report
  // with no commit in the working time is React rendering nothing, so the whole working time is outside it whatever
  // the build records: a 300 ms handler that set no state is the handler's, as it is beside a 1 ms render. A render
  // the screen update's note ties to the script after the handlers is not in the working time, so a click whose
  // every render ran there is the same: 200 ms of short handlers before a 40 ms scroll listener that rendered read
  // as waiting and painting. So is one where React stopped being read after that render, or after any render of its
  // own it read once the handlers had ended, in React's own task too: React was read all through them. Taken as
  // unknown, 200 ms of handleSave before a scroll listener that rendered was blamed on nothing and the render said to
  // be unseen, and so was 20 ms of it before a render React scheduled for right after it, so the rung for a react-dom
  // that is not read passes such a report on too, and the forced layout's sentence, in `whereRead`, takes the handlers
  // as read. A render that landed after the screen updated is not one of those: it says nothing of the react-dom the
  // handlers ran beside, and counted, a click under 'installed-late' read "React didn't render anything" beside the
  // note that nothing React did is in the report. Where a long animation frame was recorded over the handlers, the
  // browser's own record decides, in any build, where it names a script of 20 ms or more that a verdict would name,
  // as it did. Where it lists only shorter ones, or none, or only one after the handlers that no verdict takes, under
  // half of the screen update or on the next press, it names nothing that ran in them, so the handler keeps its
  // verdict rather than the time reading as waiting and painting. That holds with no note to name the one after
  // them, as `ledScript` weighs it: taken there, a 30 ms timer after 110 ms of short handlers was the verdict under a
  // 99 ms screen update, and the handler's under a 104 ms one. The script that closes the rung is the one the verdict
  // names, too: where a 25 ms timer the click waited behind closed it, that 30 ms timer took the verdict all the same.
  // A frame that ended as they began holds only what the click waited behind: a 30 ms timer there no longer takes a
  // 45 ms handler's verdict, which the handler keeps before that frame arrives and beside a 1 ms render.
  // A click React never dispatched, on server-rendered HTML it had not hydrated, is left out: the handler named
  // there is a hydrated component's above the boundary, which never ran, and the working time can be React's own
  // attempt at hydrating it. "Not loaded yet" is 'waiting', which the page's looks for React's marks decide, so a
  // react-dom that loaded before install() and mounted after the last look is taken for none: a known limit, the
  // one every rung that says React rendered nothing already had.
  const unseen = blind && !r.commits.some((x) => x.at > processingEnd + STAMP_TOLERANCE);
  const reactIdle = !inWorkingTime.length && !unseen && !unjoined && r.hydration?.kind !== 'not-hydrated';
  const framedHandlers = frames.some((f) => f.start < processingEnd && f.start + f.duration > processingStart);
  const idleHandler = reactIdle && !(framedHandlers && ledScript);
  const ranScript = (reactIdle && framedHandlers && ledScript) || (lateNoted ? ledScript : ownScript);
  const outsideMatters = (hasDurations || idleHandler) && outside >= HANDLER_MIN_MS && outside >= HANDLER_MIN_SHARE * r.processing;
  // Under the bar, the commit a measured handler script held whose count earns the render, the largest where several do.
  const heldEarning = !hasDurations && !longTaskOfWork ? inWorkingTime.filter(countEarns) : [];
  const heldRender = heldEarning.length ? heaviest(heldEarning) : null;
  // Whether the render earns the blame: by its durations, by its effects, or by its count (`countEarns`, above).
  const renderMatters = !!c && (effectsEarn || (hasDurations ? renderTotal >= RENDER_MIN_MS : countEarns(c) || !!heldRender));
  // A count the bar alone kept from naming the render. The rungs below the phase blames say so, with the
  // working time the count sat in, rather than calling the render small: nothing measured it, and a
  // count of 1298 is not small by the library's own bars. The time leads, so the count's own clauses
  // ("31 of them inside DismissableLayer") do not read as what took it. A count that committed after the
  // handlers did not sit in the working time, and is said to come after it, as the render verdict places it: 800 rows
  // committed after 30 ms of handlers read "In 30 ms of working time, short of a long task, React was
  // re-rendering 800 components", and the same rows after 55 ms "after the handlers, before the next frame". One
  // committed inside an event's own handlers sat in the working time, whatever its stamp: 800 rows committed at 43 ms
  // in a handler that ran to 43.5, past the paint the duration's rounding put at 40, read as "After the 35 ms of
  // working time", and where no long animation frame showed the handler's script holding them, the commonest
  // recording of a 40 ms click, still did. A count that sat there is the one said, beside a larger one after the
  // handlers: with 150 rows committed in the handler and 800 after it, the sentence gave the 800 and said nothing of
  // what the 30 ms held.
  const cameAfter = (x: CommitSummary) => x.at > processingEnd + STAMP_TOLERANCE && !inOneHandler(x.at, x.at);
  const countedIn = inWorkingTime.filter((x) => countSays(x) && !cameAfter(x));
  const sc = countedIn.length ? heaviest(countedIn) : c;
  const countAfter = !!sc && cameAfter(sc);
  const shortOf =
    sc && !hasDurations && !longTaskOfWork && !heldRender && countSays(sc)
      ? countAfter
        ? `After the ${ms(r.processing)} of working time, short of a long task, React was ${renderPhrase(sc)}, before the next frame`
        : `In ${ms(r.processing)} of working time, short of a long task, React was ${renderPhrase(sc)}`
      : null;
  // One bar both chooses the commit a render blame names and says its committing and effects.
  const afterRender = (x: CommitSummary) => (committingOf.get(x) ?? 0) + (effectsOf.get(x) ?? 0);
  const phasesWorthSaying = (x: CommitSummary) => afterRender(x) >= COMMIT_PHASES_MIN_MS && afterRender(x) >= COMMIT_PHASES_MIN_SHARE * own(x);
  // The commit a render blame names is the one React spent longest on, committing and effects included where
  // they count (below), so a 1 ms render whose layout effects ran for 200 ms is named over a 30 ms render. Where
  // no commit has a span this is the heaviest render, as everywhere else. A commit's committing and effects
  // only count for it where they are worth a mention, across the commits (`committingMatters`) or beside its
  // own render (`phasesWorthSaying`), or a 27 ms render with 4 ms of effects nobody hears about is named over a
  // 30 ms render. Once one commit's are, any commit's from 5 ms count for it too, so a larger render never loses
  // its own for being larger. Without durations a commit is only named over the one with the most components
  // when its effects are what earned the blame.
  const anyWorth = inWorkingTime.some(phasesWorthSaying);
  const ranked = (x: CommitSummary) => (committingMatters || (anyWorth && afterRender(x) >= COMMIT_PHASES_MIN_MS) ? own(x) : x.total);
  const rc = !c ? c : hasDurations ? inWorkingTime.reduce((a, x) => (ranked(x) > ranked(a) ? x : a), c) : effectsEarn ? inWorkingTime.reduce((a, x) => (own(x) > own(a) ? x : a), c) : (heldRender ?? c);
  // Under the bar the render is bounded by the script the frame measured holding it, not by the working time.
  const heldBy = rc && rc === heldRender ? measuredHolder(rc) : null;
  const heldFor = heldBy ? `${ms(heldBy.duration)} a long animation frame measured for ${scriptPhrase(heldBy)}` : null;
  const rcCommitting = rc ? (committingOf.get(rc) ?? 0) : 0;
  const rcEffects = rc ? (effectsOf.get(rc) ?? 0) : 0;
  // Of a committing figure and an effects figure, which to say: each that would be worth saying alone,
  // or both where neither is and only the two together are.
  const worthSaying = (committed: number, ran: number): [boolean, boolean] => {
    const alone = [committingShows(committed), committingShows(ran)];
    const together = !alone[0] && !alone[1] && committingShows(committed + ran);
    return [alone[0] || (together && committed >= 1), alone[1] || (together && ran >= 1)];
  };
  // What committing that commit and running its effects took, where it is worth saying: a render
  // duration stops where committing starts, so layout effects that read geometry 400 times are nowhere in
  // it, and in a browser that does not time forced layout this is the only figure for them.
  const [sayCommitting, sayEffects] = worthSaying(rcCommitting, rcEffects);
  // The commits that hold the figures a sentence says, other than `except`, and where they were from
  // the point of view of the commit the sentence names.
  const holding = ([sayC, sayE]: [boolean, boolean], except: CommitSummary | null = null) =>
    r.commits.filter((x) => x !== except && ((sayC && (committingOf.get(x) ?? 0) >= 1) || (sayE && (effectsOf.get(x) ?? 0) >= 1)));
  const whereOf = (named: CommitSummary | null, said: [boolean, boolean]) => {
    const held = holding(said);
    return held.length > 1 ? ` across ${plural(held.length, 'commit')}` : held.length === 1 && held[0] !== named ? ' in another commit' : '';
  };
  const heldAll = includedN([...rendersInside.values()].reduce((a, x) => a + x, 0));
  const figures = (committed: number, ran: number, [sayC, sayE]: [boolean, boolean], its = '') =>
    [sayC ? `${ms(committed)} committing${its ? ' it' : ''}` : null, sayE ? `${ms(ran)} running ${its}useEffect callbacks` : null].filter((x): x is string => x !== null);
  // Committing and effects can earn the blame across several commits with no one commit's worth
  // saying. Then the totals are what earned it, and the sentence gives those.
  const sayTotals = committingMatters && !sayCommitting && !sayEffects;
  const totalsSaid = worthSaying(committing, effects);
  const totals = sayTotals ? figures(committing, effects, totalsSaid) : [];
  const acrossCommits = totals.length ? `${totals.join(' and ')}${whereOf(rc, totalsSaid)}` : null;
  // And what the others spent beside the named commit's, where worth saying or where the totals earned the blame.
  const othersSaid: [boolean, boolean] = sayTotals
    ? [totalsSaid[0] && committing - rcCommitting >= 1, totalsSaid[1] && effects - rcEffects >= 1]
    : worthSaying(committing - rcCommitting, effects - rcEffects);
  const others = !rc ? [] : figures(committing - rcCommitting, effects - rcEffects, othersSaid);
  const othersBusy = holding(othersSaid, rc).length;
  const alsoOthers = others.length ? ` React also spent ${others.join(' and ')}${othersBusy === 1 ? ' in another commit' : othersBusy > 1 ? ` in ${othersBusy} other commits` : ''}.` : '';
  const extras = figures(rcCommitting, rcEffects, [sayCommitting, sayEffects], 'its ');
  if (sayEffects && rc) extras[extras.length - 1] += included(rc);
  // A figure that ends in the renders it holds takes a comma before the sentence goes on.
  const committedEnd = sayEffects && rc && included(rc) ? ',' : '';
  const committed = extras.length === 2 ? `, ${extras[0]} and ${extras[1]}` : extras.length === 1 ? ` and ${extras[0]}` : acrossCommits ? ` and ${acrossCommits}` : '';
  // In a production build the effects are the only figure, and the totals are said, since there is no
  // render figure to set one commit's beside.
  const effectsFigure = committingMatters ? effects : 0;
  const effectsWhere = `${whereOf(rc, [false, true])}${heldAll}`;
  const profilingRender = profiling ? ' A profiling build of React would time the render too.' : '';
  // The handler is the blame where it outruns all of React's time, or where React's time, whatever it
  // is, would not be the blame anyway: a 28 ms handler beside a 4 ms render and 24 ms of effects.
  // Where the long frames over the handlers list no script at all, nothing says the time outside React was the
  // handler's: a modal that forced layout in a layout effect read "On top of that, the onClick handler ran for
  // about 151 ms" beside its render, for a handler that is one setState, under a dev server whose frames listed
  // no scripts. Beside a render that has the verdict, that time is said as unaccounted for instead. It does not
  // take the verdict from the handler: a render of a few milliseconds took a 368 ms click's verdict that way.
  const unlisted = listsNoScripts(frames, processingStart, processingEnd);
  const unaccounted = ` ${ms(outside)} outside React's render is not accounted for: the browser listed no scripts for this frame, so a forced layout in an effect cannot be told apart from a slow handler.`;
  const handlerWins = outsideMatters && (outside > reactTime || !renderMatters);
  // Forced layout is the one cost outside React the browser measures in every build, so it is weighed
  // against React's render rather than left as a footnote under it: `renderTotal` is 0 in a production
  // build, where a render the library only counted used to outrank a layout it had timed.
  const layoutOutruns =
    forcedWhileHandling >= (hasDurations ? LONG_TASK_MS : FORCED_LAYOUT_MIN_MS_NO_DURATIONS) &&
    forcedWhileHandling >= FORCED_LAYOUT_MIN_SHARE * handledWindow &&
    forcedWhileHandling > renderTotal &&
    forcedWhileHandling > outside;
  // A wait before the handlers that is a long task itself, and at least the handlers' own time and the screen
  // update, is the answer over anything inside them: a 58 ms handler or a 40 ms render after a 400 ms wait did
  // not make the click slow. The same test opens the waiting rung and closes each rung from the forced layout down
  // to it, the handler a production build cannot time included, so a rung this closes is one the wait takes. A
  // wait short of a long task closes nothing, or a 38 ms handler after a 45 ms wait would be nobody's. What a
  // closed rung would have named is said under the wait, in `closedByTheWait`, and a forced layout in the note
  // that follows every blame that is not one.
  // React's renders between one event's handlers and the next's are working time the wait has to outlast too,
  // where a render could be the verdict, since the render rung is judged on them: an 85 ms render between a
  // keydown's handlers and its keyup's is not closed by a 60 ms wait before them. One too small to be the verdict
  // closes nothing, and adding it would only leave the wait short of the handlers' own time with no rung to take
  // it. Nor does one beside a handler or a forced layout that outruns React's render, since that rung is asked
  // first and leaves the time between out of its figure: a 30 ms render there handed a 38 ms handler the verdict
  // over a 60 ms wait. Nor one under a screen update longer than the working time, which closes the render rung
  // too: a 170 ms transition render begun before the keydown gave a 145 ms screen update the verdict over a 150 ms
  // wait. One that kept no durations is timed by React's tasks, where long frames recorded them; where no frame
  // says what ran, nothing times it, and all of the time between is counted, as `waitBetween` counts none of it.
  const renderedInGaps = !(c && rc && renderMatters) || handlerWins || layoutOutruns || screenOutranks
    ? 0
    : !framesSay && renderedBetween.some((x) => !x.hasDurations && carriesWork(x))
      ? between
      : renderedBetweenMs + untimedMs;
  const waitingWins = r.inputDelay > LONG_TASK_MS && r.inputDelay >= r.processing - between + renderedInGaps && r.inputDelay >= r.presentation;
  // The handler a build that records no durations cannot time, named where the rungs above it are not and the
  // working time was a long task and at least the screen update. The effects are measured in every build, so they
  // come off what it is said to have taken.
  const untimedHandler = !!c && !hasDurations && !!handler && longTaskOfWork && r.processing >= r.presentation;
  // Where the count alone chose between the handler and the render, a build that times neither cannot say which
  // it was: StatsPanel's own render took 134 ms of a 135 ms click in development, and its count, 2 components,
  // said the handler. So the sentence names both and the blame keeps the count's pick.
  const countOnly = !hasDurations && !!handler && !!c && c.rendered > 0;
  const tellApart = " A production build of React can't tell these apart, a profiling build can.";
  const untimedTook = effects >= 1 || between >= 1 ? `about ${ms(r.processing - between - effects)} of the ${ms(r.processing)}` : `the ${ms(r.processing)}`;
  // A wait between the events' handlers is no handler's and no render's, so it is weighed against both.
  // Where the wait before the first handler or the screen update is larger, it is a note.
  const betweenMatters =
    waitBetween >= LONG_TASK_MS && waitBetween > outside && waitBetween > reactTime && waitBetween > untimedMs && waitBetween > forcedWhileHandling;
  const betweenWins = betweenMatters && waitBetween >= r.inputDelay && !screenOutranks;
  // A long wait before the handlers is the answer, on the same test as the handler and render rungs: 26 ms of
  // layout at the end of a 300 ms wait did not make the click slow.
  const layoutMatters = layoutOutruns && !waitingWins && !screenOutranks;
  // What the handler still ran for, in a closed rung's note: all of the working time where both read the same.
  const outsideRan = ms(outside) === ms(r.processing) ? `all ${ms(r.processing)}` : `about ${ms(outside)} of the ${ms(r.processing)}`;
  /**
   * Where the render a sentence gives a figure for ran, set against the working time. One committed after the
   * handlers ran after them, and is said to have: a 43 ms render in the task after 15 ms of handlers read "43 ms
   * ... in the 15 ms of working time after the wait". One the handler's own script held did not, whatever its
   * stamp (`cameAfter` says why). One that began before the handlers, or ran longer than they did and still
   * committed with them, was not all in the working time either, and where it ran is left unsaid: a 43 ms render
   * in the task the click waited behind, committed as its handlers began, was said as that wait and then as 43 ms
   * in the 15 ms of working time after it. Only a render in the working time is said against it.
   */
  const renderRan = !rc
    ? 'in'
    : rc.startedAt !== null && rc.startedAt < processingStart - STAMP_TOLERANCE
      ? 'unplaced'
      : cameAfter(rc)
        ? 'after'
        : hasDurations && rc.total > r.processing + STAMP_TOLERANCE
          ? 'unplaced'
          : 'in';
  // The render's place, said after `lead`: `within` where that is the working time, and nothing where it is unknown.
  const placed = (lead: string, within: string) =>
    renderRan === 'after' ? `${lead}after the handlers, before the next frame` : renderRan === 'in' ? `${lead}${within}` : '';

  /**
   * What the ladder would have named had the screen update not outrun the whole working time. The
   * screen update winning the verdict is a tie-break, not a finding that the rest was nothing: a
   * 200 ms render inside a 425 ms interaction is worth knowing about even when the 215 ms of screen
   * update after it is worth more. So the rung the comparison closed leaves a note behind, the way a
   * forced layout that lost to a bigger claim already does. It follows the ladder's own order below
   * the layout rung, which needs no entry here because the forced-layout note further down already
   * fires on every blame that is not a layout. Where the layout outran the rest, the rung closed is
   * the layout's, and that note is all there is to say, under the screen update or the wait: said
   * there, a production build's handleSave "still took the 200 ms" of which the layout took 160, and
   * 800 rows were "still" re-rendering in them. So the note never names a rung the comparison did not
   * close.
   *
   * It is held to the standard of the rung it stands in for: the same commit, the same duration that
   * rung would have blamed, and the same hedge. A note is a claim like any other. It is only pushed
   * where the verdict really is the screen update, because its wording ("... before that") is about
   * the screen update. Hydration sits above the comparison and closes nothing, so repeating its
   * milliseconds as a leftover would say them twice. A `waiting` verdict can take the blame with a
   * rung closed, and there `closedByTheWait` says it instead, worded for the wait. The handler a
   * production build cannot time is said only there: its rung already asks for working time at least
   * as long as the screen update, so the screen update never closes it. The render is placed where
   * `renderRan` puts it.
   */
  const spentIn = (when: string, lead: string) => placed(lead, `in the ${ms(r.processing)} of working time ${when}`);
  // A count under the bar is placed in the script the frame measured holding it, as the render rung places it.
  const heldIn = (when: string, lead: string) => (heldFor ? placed(lead, `within the ${heldFor} ${when}`) : spentIn(when, lead));
  /**
   * A render that ran after the handlers is said with its place alone, and not with what committing and effects took
   * beside it, which is only ever counted in the working time and so is another commit's there: said before the
   * place, "after the handlers, before the next frame" read as where that commit's effects had run, though they ran
   * inside the handlers.
   */
  const spentWith = (when: string) => (renderRan === 'after' ? placed(' ', '') : `${committed}${spentIn(when, `${committedEnd} `)}`);
  // A production build's effects are said as what React then did, where the render ran in the working time. After the
  // handlers the render came after them, and they are left out as above: the render verdict read 800 rows committed
  // after the handlers "then ran useEffect callbacks for about 35 ms", effects that had run inside the handlers.
  const effectsThen = effectsFigure >= 1 && renderRan !== 'after';
  const closedOff = (when: string): string | null =>
    handlerWins
      ? say(
          measuredFrom(...inWorkingTime),
          `${cap(outsideName)} still ran for ${outsideRan} of working time ${when}.`,
          `${cap(outsideName)} ${HEDGE} still ran for ${outsideRan} of working time ${when}.`,
        )
      : c && rc && renderMatters
        ? say(
            measuredFrom(rc),
            `React still spent ${ms(rc.total)} ${renderPhrase(rc)}${spentWith(when)}${inAll(rc)}.`,
            hasDurations
              ? `React ${HEDGE} still spent about ${ms(rc.total)} ${renderPhrase(rc)}${spentWith(when)}${inAll(rc)}.`
              : effectsThen
                ? `React was ${HEDGE} still ${renderPhrase(rc)}, then spent ${ms(effectsFigure)} running useEffect callbacks${effectsWhere}${heldIn(when, heldAll ? ', ' : ' ')}.`
                : `React was ${HEDGE} still ${renderPhrase(rc)}${heldIn(when, ', ')}.`,
          )
        : untimedHandler
          ? `${cap(handler)} ${HEDGE} still took ${untimedTook} of working time ${when}.`
          : null;
  const closedByTheScreen = screenOutranks && !layoutOutruns ? closedOff('before that') : null;
  // The same for a wait before the handlers that took the verdict: a 380 ms render after a 400 ms wait is worth
  // knowing about too. It says "after the wait" rather than "after that", since other notes can come between it
  // and the cause. Where the screen update closed the rung as well, the working time is the smallest of the three
  // phases, and it is left to them.
  const closedByTheWait = waitingWins && !screenOutranks && !layoutOutruns ? closedOff('after the wait') : null;

  // A click can land on server-rendered HTML React has not reached yet, which is the commonest cause
  // of a slow first interaction in a server-rendered app. When React hydrated it inside the
  // interaction, that hydration is the story, ahead of what it rendered or what the handler did.
  const hydrating = r.commits.find((x) => x.hydratedTarget != null) ?? null;
  const waited = r.hydration?.kind === 'waited' && hydrating && carriesWork(hydrating) ? { boundary: r.hydration, commit: hydrating } : null;
  // It takes the blame only when it is what the working time went on. A boundary that hydrated in
  // 2 ms ahead of a 400 ms handler is worth the note below, not the verdict. Where the build records
  // no durations there is no figure to weigh, and the commit carrying real work is the whole test.
  const hydrationTook = waited && (waited.boundary.ms == null || (waited.boundary.ms >= RENDER_MIN_MS && waited.boundary.ms > outside)) ? waited : null;

  // The sentence and the data version of it are decided together, so a UI that shows the
  // short form never disagrees with the long one.
  let cause: string;
  let blame: Blame;
  // A script verdict said as before the handler started, where it held half of the wait, is the wait before the
  // handlers, so the note on the wait does not say it again.
  let saidBehind = false;
  // The commit a sentence set React's render time across several commits beside, where the count it gave has the
  // note on how many times React rendered count the same renders.
  let saidAcross: CommitSummary | null = null;
  // The commit whose render the cause says the walk stopped partway through, which the note on a partial count
  // then leaves out.
  let cutSaid: CommitSummary | null = null;
  // The render blame's commit spent most of its time in useEffect callbacks, which the sentence and detail lead with.
  let effectsLed = false;
  // The commit a layout blame's subtree is, which counts as a render however small, as a render blame's does.
  let layoutOwn: CommitSummary | null = null;
  if (hydrationTook) {
    const { boundary, commit } = hydrationTook;
    const confidence = measuredFrom(commit);
    const first = `The ${kind} landed on server-rendered HTML that had not been hydrated yet, so React hydrated ${boundaryPhrase(boundary)} first`;
    cause =
      boundary.ms == null
        ? `${first}, ${renderedCount(commit)}: ${HEDGE} what the ${ms(r.processing)} of working time went on. This React build records no render durations, so that is read from the component count.${profiling}`
        : say(confidence, `${first}: ${ms(boundary.ms)} of the ${ms(r.processing)} of working time.`, `${first}, ${HEDGE} ${ms(boundary.ms)} of the ${ms(r.processing)} of working time.${profiling}`);
    // Named after the boundary or the page, which holds every component hydrated, so the count is the whole.
    blame = { kind: 'hydration', name: boundaryPhrase(boundary), detail: mostlyOf(commit, false), ms: boundary.ms, confidence };
  } else if (betweenWins) {
    // Nothing the page wrote runs in that time unless a frame says so: the browser was working out what the
    // handlers before it had changed, which a frame records as time no script took.
    const handled = r.processing - between;
    const restyle = 'the browser recalculating styles and layout for what the handlers before it changed';
    // React's own render is never the script the wait is named after.
    const longest = longestPart(partsBetween.filter((p) => !untimedIn.includes(p)));
    // Where part of it was before an input with nothing on record running, what follows is said of the rest, the
    // wait. The figures add up as printed, the wait's being the one the blame carries. A key or a pointer is said
    // to be still down only before its release, and only where long frames could have said what ran.
    const it = heldGap ? 'the wait' : 'it';
    const held = heldGap ? ms(Math.round(between) - Math.round(waitedBetween)) : '';
    const released = heldGap?.before === 'keyup' ? 'key' : /^(pointerup|mouseup|touchend|click|auxclick)$/.test(heldGap?.before ?? '') ? 'pointer' : null;
    const heldSaid = !heldGap
      ? ''
      : !r.frames?.length
        ? ` No long animation frame says what ran in ${held} of it, before the ${heldGap.before} came, so the wait counted is the other ${ms(waitedBetween)}.`
        : released
          ? ` The ${released} was still down for ${held} of it with nothing on record running, so the wait was the other ${ms(waitedBetween)}.`
          : ` Nothing on record ran in ${held} of it, before the ${heldGap.before} came, so the wait was the other ${ms(waitedBetween)}.`;
    const scriptsSaid =
      partsBetween.length === 1
        ? `${cap(aScript(partsBetween[0]!.script))} ran for ${underOr(partsBetween[0]!.ms)} of ${it}`
        : `Scripts ran for ${underOr(scriptedBetween)} of ${it}${longest ? `, the longest ${aScript(longest.script)} for ${ms(longest.ms)}` : ''}`;
    // A build that records no durations says React rendered, and nothing of how long.
    const reactSaid = !renderedBetween.length
      ? `React did not render in ${it}`
      : renderedBetween.every((x) => x.hasDurations)
        ? `React rendered for ${underOr(renderedBetweenMs)} of ${it}`
        : `React rendered in ${it}`;
    const filled = framesSay
      ? scriptedBetween < 1
        ? ` No script ran in ${heldGap ? 'the wait' : 'that time'}, so it was ${HEDGE} ${restyle}.`
        : scriptedBetween >= WAITED_BEHIND_MIN_SHARE * waitedBetween
          ? ` ${scriptsSaid}.`
          : ` ${scriptsSaid}, and the rest was ${HEDGE} ${restyle}.`
      : !r.frames
        ? ` ${reactSaid}, and this browser does not record what else ran, so it was ${HEDGE} ${restyle}.`
        : scriptedBetween >= 1
          ? ` ${scriptsSaid}, and no long animation frame over the rest has been recorded yet, so the rest was ${HEDGE} ${restyle}.`
          : ` ${reactSaid}, and no long animation frame that says what else ran has been recorded yet, so it was ${HEDGE} ${restyle}.`;
    cause = `The handlers took ${underOr(handled)} in all, but ${ms(between)} went by ${whereBetween}.${heldSaid}${filled} That time counts as working time, which runs from the first handler to the last.`;
    const named = longest && longest.ms >= WAITED_BEHIND_MIN_SHARE * waitedBetween ? scriptName(longest.script) : null;
    blame = { kind: 'waiting', name: named, detail: onlyGap ? `between ${onlyGap.after} and ${onlyGap.before}` : 'between handlers', ms: heldGap ? waitedBetween : between, confidence: 'measured' };
  } else if (layoutMatters) {
    // The number is the browser's and nothing React did changes it, so the confidence is about the
    // measurement alone: whether any of the total had to be apportioned across the edge of the window.
    const confidence = forcedLayoutMeasured(whileHandling) ? 'measured' : 'inferred';
    const charged = mostForcedLayout(whileHandling);
    const invoker = charged ? scriptName(charged.script) : null;
    // The name beside that number is not the browser's: it comes from a commit, and a commit that
    // only overlapped the interaction in time, or was walked short of the end, or sits beside commits
    // that could not be tied to this interaction at all, cannot say the layout happened in the
    // subtree it names. Then the name is dropped rather than the confidence, because everything left
    // — the milliseconds and the invoker — is still something the browser measured. Render durations
    // are not part of this test: a production build records none and its names are no worse for it.
    const named = c && !unjoined && namesThisInteraction(c) ? c : null;
    // One script holding nearly all of the total is where the layout happened; several scripts
    // sharing it means no one script is, and then nothing but the commit can name this.
    const holdsMostOfIt = !!charged && charged.forcedLayout >= FORCED_LAYOUT_ONE_SCRIPT_SHARE * forcedWhileHandling;
    /**
     * Everything in the window the sentence is about: the handlers, React's render and commit, and
     * this library's read of what React rendered. That is the window the browser counted the forced
     * layout across, so it is the only one the layout can be subtracted from and leave a true
     * remainder. It is deliberately not `processing`, which has the library's own read taken back
     * out of it and is what the Working phase reports, with `walkMs` beside it. It is said as the time it
     * took to handle the input, since what the browser spent is said inside it: "401 ms of the 474 ms
     * spent handling the click" said spent twice.
     */
    const window = `${ms(handledWindow)} it took to handle the ${kind}`;
    // What is left of that window bounds everything else in it, React's render included, which is the
    // whole of why this outranks a render the build never timed. Unless React's render is itself
    // timed higher than that remainder: the browser charges forced layout to the script it happened
    // in, and that can be a render body reading geometry, so the two overlap and the remainder bounds
    // nothing. Claiming it did would contradict the sentence about the render next.
    const left = Math.max(0, Math.round(handledWindow) - Math.round(forcedWhileHandling));
    // The remainder covers the walk because the window it came from does. Naming the walk only when
    // it is worth a whole millisecond keeps it out of the sentence for every ordinary interaction.
    const ourRead = r.walkMs >= 0.5 ? ", this library's read of what React rendered" : '';
    // Only the render inside that window can overlap it: one between one event's handlers and the next's is left out of both.
    const gapRender = inWorkingTime.filter((x) => inAGap(x.at)).reduce((a, x) => a + x.total, 0);
    const overlapping = hasDurations && renderTotal - gapRender > left;
    const rest = overlapping
      ? "which overlaps React's own render: geometry read inside a render body is charged to both"
      : `leaving ${ms(left)} for React's render and commit, its layout effects${ourRead} and the ${kind} handler together`;
    const spent = `${ms(forcedWhileHandling)} recalculating styles and layout, ${rest}`;
    // Where the layout happened and where React was working are two different records, and the
    // browser's is the one that is never a reading. Naming the subtree without it would point a
    // reader at a file that need have nothing to do with the layout: an observer callback running
    // inside the same window is charged separately and looks identical from the React side. The
    // sentence says it whatever the blame is named after, because the cause is read on its own; and
    // it prints the script's own share whenever the script does not hold nearly all of the total,
    // since the total is several scripts' and the name beside it would claim all of it for one.
    // Not for React's own listener (`reactsOwn`), or the document's where a root is the document or
    // nothing says where the roots are, though: that is the one React dispatched the event from,
    // "charged to #document.onclick" is all the browser alone can say, and it sends nobody anywhere.
    // An observer's callback in the same window is still said, and so is the document's listener on
    // a page whose roots are elsewhere, a tag manager's. The frames keep the listener. Unless the
    // blame is named after it, which the sentence then says.
    const read = whereRead(whileHandling);
    // Nothing names the read that forced the layout. What is held is where it happened: the subtree
    // of the commit this interaction joined, or, failing that, the script the browser charged it to
    // — and that only while one script holds nearly all of it, since `ms` is the whole total and a
    // name beside it is read as owning all of it. Where the sentence puts it outside React, the subtree is
    // not where it happened, and the script is named, by its handler's name where it ran as the handler and no
    // commit in the same event's handlers ran outside it.
    // The subtree is the one the commit in the forcing scripts rendered, where the sentence found one. Where several
    // ran there and none could have held most of it, no subtree and no script is named.
    const subtree = read.untied ? null : read.commit ? (!unjoined && namesThisInteraction(read.commit) ? read.commit : null) : named;
    const inTheSubtree = !!subtree && read.inTheSubtree;
    if (inTheSubtree) layoutOwn = subtree;
    // The commit the cause describes: the one named, else the one that rendered most.
    const told = inTheSubtree ? subtree : c;
    saidAcross = told;
    // The hot path says where the render went, not where the read was, so where the sentence says it went
    // from a component that holds the whole commit (`fromName`) that is the subtree named, with the whole count.
    // Where several roots rendered, the one they sit under, and the sentence says it too.
    const at = inTheSubtree ? fromAbove(subtree) : undefined;
    const whole = inTheSubtree ? (at ?? fromName(subtree)) : null;
    const name = inTheSubtree
      ? (whole ?? leafOf(subtree))
      : !read.untied && holdsMostOfIt && charged
        ? read.inTheSubtree || committedBeside(charged.script)
          ? invoker
          : scriptBlameName(charged.script)
        : null;
    const onDocument = !!charged && charged.script.invoker.startsWith('#document.') && !page.named && (!page.roots.length || page.roots.includes('#document'));
    const dispatchedFrom = !!charged && (onDocument || reactsOwn(charged.script));
    const chargedTo = charged && invoker && (!dispatchedFrom || name === invoker) ? ` ${holdsMostOfIt ? 'It' : `${ms(charged.forcedLayout)} of it`} was charged to ${invoker}.` : '';
    // The clause about React is hedged on the same evidence the name is: a commit this interaction
    // cannot claim, and, where the clause prints a duration, a duration that is not a measurement.
    // A production build's component counts are measured by the walk, so they are not hedged here.
    const sure = told && !unjoined && namesThisInteraction(told) ? told : null;
    const reactSure = !!sure && (!hasDurations || measuredFrom(sure) === 'measured');
    const maybe = reactSure ? '' : `${HEDGE} `;
    // A total over what was left says where the rest went, or 62 ms of rendering beside 28 ms left reads as a contradiction.
    const gapSaid = !overlapping && hasDurations && Math.round(rendersMs) > left && told && severalRenders(told) ? ` Of the ${ms(rendersMs)}, ${ms(gapRender)} came ${whereBetween}, outside the ${ms(handledWindow)}.` : '';
    const rendered = told ? ` ${hasDurations ? `React ${maybe}spent ${renderAcross(told, underOr(renderSpent(told)), at)}` : `React was ${maybe}${renderPhrase(told, at)}`}.${gapSaid}` : '';
    // What forces a layout is said straight after the layout, and React's clause after that: put after the
    // clause, its "That happens" read as about the re-render.
    cause = `Of the ${window}, ${say(confidence, `the browser spent ${spent}.`, `the browser ${HEDGE} spent ${spent}.`)}${chargedTo} ${read.said}${rendered}`;
    blame = {
      kind: 'layout',
      name,
      detail: inTheSubtree ? mostlyOf(subtree, !whole) : null,
      ms: forcedWhileHandling,
      confidence,
    };
  } else if ((c || idleHandler) && handlerWins && !screenOutranks && !waitingWins) {
    const confidence = measuredFrom(...inWorkingTime);
    const renderMs = c ? renderSpent(c) : 0;
    if (renderMs >= RENDER_MIN_MS) saidAcross = c;
    const rest = !c
      ? noneWorking
      : renderMs >= RENDER_MIN_MS
        ? `React spent ${renderAcross(c, ms(renderMs))}`
        : `React's own render took ${renderMs < 0.5 ? 'under 1 ms' : `only ${ms(renderMs)}`}`;
    // Committing and effects React spent beside it, where they would be worth saying. They are the
    // totals, since the render named here need not be the commit that spent them.
    const spent = figures(committing, effects, totalsSaid);
    const also = spent.length ? ` React also spent ${spent.join(' and ')}${whereOf(c, totalsSaid)}.` : '';
    cause = say(confidence, `${cap(outsideName)} ran for about ${ms(outside)}; ${rest}.${also}`, `${cap(outsideName)} ${HEDGE} took about ${ms(outside)}; ${rest}.${also}${profiling}`);
    // A listener React did not attach (a shortcut bound on the document, a library's own listener) has
    // no React name, and "code outside React" sends nobody anywhere. The browser still says which
    // listener it ran and from which file, so the sentence passes that on as what the browser
    // recorded. It is not said to be the 190 ms: the script's time can hold React's render too.
    const listener = handlerName ? null : longestPart(whileHandling);
    const listenerName = listener ? scriptName(listener.script) : null;
    cause += longestSaid(listener);
    // It names the blame only where it covers most of the time being blamed.
    const blamedListener = listener && listener.ms >= WAITED_BEHIND_MIN_SHARE * outside ? listenerName : null;
    // The component is the target's, which is where a React handler lives. A listener on the document
    // lives nowhere in the tree, so a name that came from the browser goes without one.
    blame = { kind: 'handler', name: handlerName ?? blamedListener, detail: blamedListener && !handlerName ? null : component, ms: outside, confidence };
  } else if (c && rc && renderMatters && !screenOutranks && !waitingWins) {
    saidAcross = rc;
    const confidence = measuredFrom(rc);
    // Without durations the blame rests on the component count alone, which is why it is a reading:
    // 600 cheap components can outrank the one expensive component that actually took the time. The
    // working time is what the count is read against, so the sentence gives it: 55 ms hung on a render of
    // 161 components is a claim the reader can weigh, and the same render in 7 ms elsewhere is not. After
    // a comma, so a count's own clause ("31 of them inside DismissableLayer") does not read as what took it.
    // A render that did not run in the working time is not said against it, as in a closed rung's note: a
    // 43 ms render in React's task after 15 ms of handlers read "about 43 ms of the 15 ms of working time".
    const likely = hasDurations
      ? // The measured render is the claim; the working time is context. Saying React spent all of it
        // rendering and then that other code ran for a third of it was two claims that cannot both hold.
        renderRan === 'in'
        ? `React ${HEDGE} spent about ${ms(rc.total)} of the ${ms(r.processing)} of working time ${renderPhrase(rc)}${inAll(rc)}.`
        : `React ${HEDGE} spent about ${ms(rc.total)} ${renderPhrase(rc)}${placed(' ', '')}${inAll(rc)}.`
      : `React was ${HEDGE} ${renderPhrase(rc)}${placed(', ', heldFor ? `within the ${heldFor}` : `in the ${ms(r.processing)} of working time`)}. This React build records no render durations, so that is read from the component counts, not measured.`;
    // A list is the render's at any length, but past 2 ms a row the handler could hold the time as well.
    const listByCount = countOnly && !effectsThen && rc.rendered > 0 && r.processing > RENDER_MAX_MS_PER_COMPONENT_BESIDE_HANDLER * rc.rendered;
    // Where the commit's useEffect callbacks took over half of it, they lead too, and are its detail: a chart that
    // draws in its useEffect after mounting read as its parent's own render, 60 ms against 361 ms of effects, with
    // advice about memoising. The component that mounted with one is named, where the commit mounted one.
    effectsLed = hasDurations && rcEffects * 2 > own(rc);
    // The ones that mounted are counted only where no component that rendered again had one to run too: a chart
    // drawing again beside two tooltips that mounted read as the tooltips' doing.
    const effectMounts = (rc.effectRuns ?? rc.effectMounts) === rc.effectMounts ? (rc.effectMounts ?? 0) : 0;
    // A walk cut short counted only the mounts it reached: the one it named can be one of several.
    const mountedWith = rc.truncated
      ? effectMounts > 0
        ? ` At least ${plural(effectMounts, 'component')} mounted in that commit${effectMounts === 1 ? ' with' : ', each with'} a useEffect of its own.`
        : ''
      : effectMounts === 1 && rc.effectMountName
        ? ` ${rc.effectMountName} mounted in that commit with a useEffect of its own.`
        : effectMounts > 1
          ? ` ${effectMounts} components mounted in that commit, each with a useEffect of its own.`
          : '';
    const effectsDetail = rc.truncated
      ? effectMounts > 0
        ? ` in at least ${plural(effectMounts, 'mounted component')}`
        : ''
      : effectMounts === 1 && rc.effectMountName
        ? ` after mounting ${rc.effectMountName}`
        : effectMounts > 1
          ? ` in ${effectMounts} mounted components`
          : '';
    const effectsFirst = `The commit's useEffect callbacks ${say(confidence, '', `${HEDGE} `)}ran for about ${ms(rcEffects)}${included(rc)} before the screen could update, after React spent ${renderAcross(rc, ms(rc.total))}.${mountedWith}`;
    const stopped = walkStopped(rc);
    if (stopped) cutSaid = rc;
    // A production build times the effects but not the render, so there the effects lead. Where the walk stopped,
    // that comes after the profiling build, which goes with the sentence saying the build records no durations.
    cause = effectsLed
      ? `${effectsFirst}${stopped}${say(confidence, '', profiling)}`
      : !hasDurations && effectsThen
        ? `React was ${HEDGE} ${renderPhrase(rc)}, then ran useEffect callbacks for about ${ms(effectsFigure)} of the ${heldFor ?? `${ms(r.processing)} of working time`}${effectsWhere}, before the screen could update.${profilingRender}${stopped}`
        : say(confidence, `React spent ${renderAcross(rc, ms(rc.total))}.${stopped}`, `${likely}${listByCount ? `${stopped} It could have been ${handler} instead.${tellApart}` : `${profiling}${stopped}`}`);
    // The named commit's figures are said so they add up to the blame's milliseconds.
    const phasesSaid = hasDurations && phasesWorthSaying(rc);
    const tellCommitting = sayCommitting || (phasesSaid && rcCommitting >= 1);
    const tellEffects = sayEffects || (phasesSaid && rcEffects >= 1);
    if (tellCommitting) cause += ` Committing it took about ${ms(rcCommitting)} more: the DOM changes, ref callbacks and layout effects.`;
    if (tellEffects && hasDurations && !effectsLed) cause += ` The commit's useEffect callbacks then ran for about ${ms(rcEffects)} more${included(rc)}, before the screen could update.`;
    const unsaid = own(rc) - rc.total - (tellCommitting ? rcCommitting : 0) - (tellEffects || effectsLed ? rcEffects : 0);
    if (hasDurations && unsaid >= 1) cause += ` That commit took ${ms(own(rc))} with committing and effects.`;
    // The totals only where none of the named commit's own figures are said.
    if (acrossCommits && hasDurations && !tellCommitting && !tellEffects) cause += ` React also spent ${acrossCommits}.`;
    else if (hasDurations) cause += alsoOthers;
    if (outsideMatters) cause += unlisted ? unaccounted : ` On top of that, ${outsideName} ran for about ${ms(outside)}.`;
    // The milliseconds are the commit's in all, its render, committing and effects, which is what it
    // accounts for; the render alone was 5 ms for a commit whose effects ran for 300.
    // Never null: a reader written against 0.3.0 dereferences the name of a render blame.
    const fromStart = namedFromStart(rc);
    blame = { kind: 'render', name: fromStart ? fromName(rc)! : leafOf(rc), detail: effectsLed ? `useEffect callbacks${effectsDetail}` : mostlyOf(rc, !fromStart), ms: hasDurations ? own(rc) : null, confidence };
  } else if (untimedHandler && !waitingWins) {
    // Past the count that would have blamed the render, what kept it from the blame is said: no list
    // among the components, and more of the working time than a tree accounts for.
    const howLittle =
      c.rendered === 0
        ? 'React rendered nothing'
        : c.rendered < RENDER_MIN_COMPONENTS_BESIDE_HANDLER
          ? `React ${renderedVerb(c)} only ${plural(c.rendered, 'component')}`
          : `React ${renderedVerb(c)} ${renderedWhere(c)}, none of them ${RENDER_MIN_COMPONENTS_BESIDE_HANDLER} times over, and ${ms(r.processing)} is more than ${RENDER_MAX_MS_PER_COMPONENT_BESIDE_HANDLER} ms for each of them`;
    const ranEffects = effects >= 1 ? ` and ran useEffect callbacks for ${ms(effects)}${heldAll}` : '';
    if (countOnly) cause = `${cap(handler)} or React's render of ${leafOf(c)} ${HEDGE} took ${untimedTook}, the handler the likelier: ${howLittle}${ranEffects}.${tellApart}`;
    else cause = `${cap(handler)} ${HEDGE} took ${untimedTook}: ${howLittle}${ranEffects}.${profiling}`;
    blame = { kind: 'handler', name: handlerName, detail: component, ms: null, confidence: 'inferred' };
  } else if (waitingWins) {
    // What the input waited behind is usually on record: the long animation frame that was open when
    // it came lists its scripts, and the one that filled the wait is the thing to go and look at. It is
    // counted for its part inside the wait only, since what it did before the input came delayed nobody.
    const behind = longestPart(scriptParts(frames, r.start, processingStart));
    if (behind) {
      const s = behind.script;
      const already = s.start < r.start - STAMP_TOLERANCE;
      const what = aScript(s);
      cause = `The ${kind} waited ${ms(r.inputDelay)} before its handler could start: ${what} ${already ? `was already running when the ${kind} came and` : 'ran first and'} held the main thread for ${Math.round(behind.ms) >= Math.round(r.inputDelay) ? 'all' : ms(behind.ms)} of that wait.`;
    } else {
      cause = `The ${kind} waited ${ms(r.inputDelay)} before its handler could start: the main thread was busy with something else.`;
    }
    // The milliseconds are the wait, so the script only gets its name on them when it filled most of
    // it. A 30 ms timer inside a 400 ms wait is in the sentence, with its own figure, and is not the blame.
    const named = behind && behind.ms >= WAITED_BEHIND_MIN_SHARE * r.inputDelay ? scriptName(behind.script) : null;
    blame = { kind: 'waiting', name: named, detail: null, ms: r.inputDelay, confidence: 'measured' };
  } else if (waitedOnNext) {
    // The frame waited on the next press, which the page handled first. What it did for that press is the
    // next report's, so there is nothing of this interaction's own to blame, and the wait is the answer.
    // The blame is the screen update, this interaction's own phase, and stays measured. It takes a script's
    // name as any painting blame does, only where the script ran for half of the screen update: where only
    // the press's render says the frame waited, a 20 ms timer is the longest script the sentence gives,
    // with its own figure, and is not the blame.
    cause = `After the ${kind} was handled, the screen took another ${ms(r.presentation)} to update${nextClause(!byRender && nextScriptMs >= nextShare)}`;
    blame = { kind: 'painting', name: lateLeads ? scriptName(lateLeads.script) : null, detail: null, ms: r.presentation, confidence: 'measured' };
  } else if (screenOutranks) {
    // The same test the rungs above were closed by, so one of the two always fires: a verdict cannot
    // be refused for the screen update and then fall past it.
    cause = `After the ${kind} was handled, the screen took another ${ms(r.presentation)} to update${lateScriptClause}`;
    // React's own task is named after the port its scheduler posts to, which nobody wrote: where React
    // rendered inside it, the blame names that render's component, and the sentence still names the task.
    // On a phone a cascading effect's 400 rows read "screen took 148 ms to update · MessagePort.onmessage".
    const reactTaskRender = lateLeads?.script.invoker === REACT_TASK && lateRender ? leafName(lateRender) : null;
    blame = { kind: 'painting', name: reactTaskRender ?? (lateLeads ? scriptBlameName(lateLeads.script) : null), detail: null, ms: r.presentation, confidence: 'measured' };
  } else if (unseen) {
    // No react-dom is read, so what React rendered for this input, if anything, is unknown, and with it
    // the split of the working time: a handler and the render its state update sets off run in one
    // script, the listener's, which is all the browser records. Naming the handler for that script read
    // as a finding and put a 326 ms render on handleShowList; with no long task on record the time went
    // to "waiting and painting". The setup is the cause worth saying, and nothing is blamed until it is
    // fixed. The browser's own measurements above, a wait or the screen update, still stand.
    const why = r.reactStatus === 'installed-late' ? 'install() ran after react-dom loaded' : 'no react-dom on this page is being read';
    const recorded = longestPart(whileHandling);
    const held = recorded ? ` The browser recorded ${aScript(recorded.script)} running for ${ms(recorded.ms)} of it, which holds React's render as well as the handler.` : '';
    // Where it was read before it stopped, only the rest is unknown. A react-dom install() ran too late for was never
    // read, whatever another rendered later.
    const unknown = partway ? 'What React did after it stopped being read is unknown,' : `What React did is unknown: ${why}, so whatever it rendered for this ${kind} was not seen,`;
    cause = `${unknown} and the ${ms(r.processing)} of working time cannot be put on ${handler ?? `the ${kind} handler`} or on a render.${held}`;
    blame = { kind: 'none', name: null, detail: null, ms: null, confidence: 'inferred' };
  } else if (ranScript && !(shortOf && ranAsHandler(ranScript.script) && !countAfter)) {
    // A script is what is left once React is ruled out, so a commit that could not be tied to the
    // interaction is exactly what stops this from being a finding. A script that ran as the handler holds
    // React's render as well (the blind rung above says why), so where the count would have named that
    // render but for the bar, the script is not measured in its place: nothing else under the bar is blamed.
    // Where the frame measured that script holding the count, the render rung above took it (`measuredHolder`).
    // A count that committed after the handlers is not in that script, and leaves it the verdict: kept from
    // it, a 28 ms handleSave in 30 ms of working time was said nowhere, where beside no render it was named.
    // A count after the handlers does not leave it the verdict beside one that sat in the working time, though:
    // with 150 rows committed in the handler and 800 after it, a 28 ms handleSave was measured in the 150's place.
    const confidence = unsure ? 'inferred' : 'measured';
    const small = shortOf ?? (c ? `React's render was small (${renderPhrase(c)})` : noneWorking);
    // A script cut by the interaction's edges ran for longer than the part counted here.
    const ofIt = Math.round(ranScript.ms) < Math.round(ranScript.script.duration) ? ' of it' : '';
    // A script that started after the handlers says so wherever it is named: said bare, a 22 ms timer after a
    // Sheet's 49 ms of working time read as the handler's. So does a timer the input waited behind, which with
    // no note on the script after the handlers was said bare too, and then again as the wait. It is the wait,
    // and the note on the wait is left out, only where it held half of it: a 30 ms timer in a 120 ms wait left
    // the other 90 ms said nowhere.
    const s = ranScript.script;
    const where =
      s.start >= processingEnd
        ? ' after the handler finished'
        : s.start + s.duration <= processingStart + STAMP_TOLERANCE
          ? ' before the handler started'
          : '';
    saidBehind = where === ' before the handler started' && ranScript.ms >= WAITED_BEHIND_MIN_SHARE * r.inputDelay;
    const ran = `${scriptPhrase(s)} ran for ${ms(ranScript.ms)}${ofIt}${where}`;
    cause = say(confidence, `${small}; ${ran}.`, `${small}; ${HEDGE} ${ran}.`);
    blame = { kind: 'script', name: scriptBlameName(ranScript.script), detail: ranAsHandler(ranScript.script) ? component : null, ms: ranScript.ms, confidence };
  } else if (pressWaitLeads && waitedOnPress) {
    // Under a long task the wait is still the answer where Event Timing places all of it in the press's screen
    // update and it leads: a release that waited 22 of its 40 ms for the menu its press opened was put down to nothing.
    // Said in the event's own words where both are a key press.
    const released = r.type === 'keyup' ? 'key release' : kind;
    const press = kindOf(waitedOnPress.name, r.pointerType) === released ? waitedOnPress.name : kindOf(waitedOnPress.name, r.pointerType);
    const pressRender = pressed.filter(carriesWork);
    const by = pressRender.length ? ` by ${renderPhrase(heaviest(pressRender))}` : '';
    const unbroken = r.frames?.length === 0 ? ' No long animation frame covered it, so what the browser did in that time is not broken down.' : '';
    cause = `The ${released} waited ${ms(r.inputDelay)} for the ${press}'s screen update before its handler could start: ${HEDGE} the browser restyling and painting what the ${press} changed${by}.${unbroken}`;
    blame = { kind: 'waiting', name: null, detail: null, ms: r.inputDelay, confidence: 'measured' };
  } else if (r.frames) {
    // Long Animation Frames lists frames of 50 ms and up, so no frame over the interaction says its frame
    // was under one, and that what the browser spent in it recalculating styles and layout was never
    // measured. Without durations that is where a count used to name a render: opening a shadcn/ui Sheet
    // on a phone forces four whole-document style recalculations inside 31 ms of working time, no frame
    // reported them, and the report read "re-rendering 59 components inside DismissableLayer". The sentence
    // says what is known instead, and that the working time is under a long task, which is why nothing in
    // it is blamed. Whether the interaction forced any is not known either, so the sentence says "any". A
    // frame that did overlap says the same of the working time, without the clause: the frame was long,
    // and its scripts are either too short to name or the handler's, which holds React's render (above).
    // A count under the library's own bars reads as it did, in any build.
    const unmeasured = r.frames.length === 0 ? ` No long animation frame covered the ${kind}, so how much of the working time went to any styles and layout it forced is unmeasured.` : '';
    // Where the screen update's note names the script after the handlers, 70 ms of it in a 157 ms screen
    // update, or the next press's 44 ms handler in a 90 ms one, the sentence says only that none ran long before it.
    const noLongTask = `no long task was recorded${lateScript ? ` in ${workingOnly ? 'it' : 'the working time'}` : ''}`;
    cause = shortOf
      ? `${shortOf}; the rest went to waiting and painting.${unmeasured}`
      : c
        ? `React's render was small (${renderPhrase(c)}) and ${noLongTask}, so the rest went to waiting and painting.`
        : `${noneWorking} and ${noLongTask}, so the time went to waiting and painting.`;
    // Nothing is named, so there is nothing to hedge; the confidence says whether the absence of a
    // long task was itself observed or merely assumed.
    blame = { kind: 'none', name: null, detail: null, ms: null, confidence: unsure ? 'inferred' : 'measured' };
  } else {
    // Without Long Animation Frames there is no record to say no long task ran.
    cause = c
      ? `${shortOf ?? `React's render was small (${renderPhrase(c)})`}; this browser does not report long tasks, so what else ran is unknown.`
      : `${noneWorking}; this browser does not report long tasks, so what ran instead is unknown.`;
    blame = { kind: 'none', name: null, detail: null, ms: null, confidence: 'inferred' };
  }

  // React stops an event at a boundary it has not hydrated: it never dispatches it, so hardly any
  // working time goes by and the slow part is the wait before it or the paint after. That verdict
  // still holds and stands above; this goes in front of it, because it is the thing worth knowing.
  if (r.hydration?.kind === 'not-hydrated') {
    cause = `This ${kind} landed on server-rendered HTML that React had not hydrated yet, so React did not dispatch it and no React handler ran for it. ${cause}`;
  }

  if (unjoined) {
    notes.push(
      `React committed ${plural(r.unjoinedCommits, 'time')} while this ${kind} was being handled that could not be tied to it, so what it rendered is left out of this report. That happens when the commit landed more than ${ms(joinWindow() ?? DEFAULT_INPUT_WINDOW)} after the last commit inside the ${kind}'s own dispatch, or after the ${kind} itself where React committed nothing inside it, with no way to tell it from an unrelated update.`,
    );
  }
  if (r.reactStatus === 'installed-late') {
    notes.push(
      "React has rendered on this page, but no react-dom registered with this library's DevTools hook: install() ran after react-dom loaded, so nothing React did is in this report. Install ahead of the app: react-inp-blame/vite, react-inp-blame/next or react-inp-blame/astro, or `import 'react-inp-blame/auto'` as the first import of the entry module.",
    );
  } else if (r.reactStatus === 'unreadable') {
    // The page can turn its hook off, or a walk throw, after this interaction's commits were read and before its
    // report was built, and the commits read by then stay in it.
    notes.push(
      partway
        ? `React stopped being read partway through this ${kind}, so only what it did before that is in this report, and stats().unsupportedReason says why.`
        : "No react-dom on this page is being read, so nothing React did is in this report: either no React DevTools hook is in use (hook: 'chain' found none to wrap), or stats().unsupportedReason says why (the page turns its DevTools hook off or locks it, or the react-dom that registered cannot be read).",
    );
  }
  // A report keeps a URL's path only, so a step that changed the query or the hash stays on the page it began on.
  if (r.startedNavigation) notes.push(`It started a navigation ${r.startedNavigation.url === r.navigationURL ? 'within' : 'to'} ${linkText(r.startedNavigation.url, r.navigationURL)}.`);
  if (r.hydration?.kind === 'waited' && blame.kind !== 'hydration') {
    // Saying it was not what took the time is a measurement. Where the build records no durations
    // nobody measured it, and the sentence would be a guess dressed as a finding. Nor is it said where
    // the render blame names the commit that hydrated: the cause has just said it took the time.
    const notTheStory = r.hydration.ms == null || (blame.kind === 'render' && rc === hydrating) ? '' : ' That was not what took the time here.';
    notes.push(`It landed on server-rendered HTML that had not been hydrated yet, and React hydrated ${boundaryPhrase(r.hydration)} during it.${notTheStory}`);
  }
  // What the sentence put on one component's own render: the fix is in what that component computes, not
  // in the components under it. Said of the render the blame names, where it is the advice worth having.
  // Not where more time than it went unaccounted for beside it, which may not have been the render's at all.
  const ownBlamed = blame.kind === 'render' && rc ? ownRender(rc) : undefined;
  if (ownBlamed && !effectsLed && !(unlisted && outsideMatters && outside > ownBlamed.self)) {
    notes.push(`Time in ${ownBlamed.name}'s own render is usually work it does as it renders, like a sort or a filter, which memoising the components under it does not speed up.`);
  }
  // A wait between the handlers is `waiting` too, with where it came as its detail, and the wait before them is
  // not in its sentence.
  const waitIsTheVerdict = blame.kind === 'waiting' && blame.detail === null;
  // A note standing in for a closed render rung names the render that rung would have, and gives its total the same way.
  if (((closedByTheScreen && blame.kind === 'painting') || (closedByTheWait && waitIsTheVerdict)) && !handlerWins && c && rc && renderMatters) saidAcross = rc;
  // Said where two renders count and were not a hydration. A render with little in it counts where its committing or
  // effects were worth saying, or the render blame or the layout blame's subtree names it: a 3 ms render whose useEffect ran for 100 ms and set
  // state is the chain the note is about. A hydration is not a re-render: it is the first render of that HTML on
  // the client, and firing on it would tell every click that waited for one to go looking for an effect that
  // updates state. So it is not counted either, except where a sentence gave React's render time across commits
  // with the hydration among them, and then it counts the renders that sentence did: "React rendered 2 times"
  // beside "rendering across 3 commits", one of them the hydration, read as two counts of the same thing. Counted
  // everywhere, a click that waited for a boundary to hydrate and rendered twice read "React rendered 3 times", in a
  // production build too, where no sentence gives a count.
  const counts = (x: CommitSummary) =>
    carriesWork(x) || committingShows((committingOf.get(x) ?? 0) + (effectsOf.get(x) ?? 0)) || (blame.kind === 'render' && x === rc) || (blame.kind === 'layout' && x === layoutOwn);
  // The renders the sentences count, and one that counts though the build gave it no time.
  const counted = r.commits.filter((x) => rendersAll.includes(x) || (!forcedByScript.includes(x) && !pressed.includes(x) && counts(x)));
  const reRenders = counted.filter((x) => x.hydratedTarget == null);
  const rendersSaid = saidAcross && severalRenders(saidAcross) ? counted : reRenders;
  // The Performance panel's Summary gives the same count, and says why it leaves out the rest.
  const left = r.commits.filter((x) => !rendersSaid.includes(x) && !pressed.includes(x));
  const hydrations = left.filter((x) => x.hydratedTarget != null).length;
  const forced = left.filter((x) => x.hydratedTarget == null && forcedByScript.includes(x)).length;
  countsByReport.set(r, { renders: rendersSaid.length, hydrations, forced, small: left.length - hydrations - forced, between, whereBetween });
  if (reRenders.filter(counts).length > 1) notes.push(`React rendered ${rendersSaid.length} times before the screen updated, which usually means a state update inside an effect or a chain of updates.`);
  if (closedByTheWait && waitIsTheVerdict) notes.push(closedByTheWait);
  // Where the screen update did take the blame, the work it outranked is what this report would otherwise never
  // mention. Only where it took it, though: a rung above the comparison that won anyway had nothing closed off,
  // and its own time is already in the cause. It goes ahead of the wait's note, so its "before that" is not read
  // as before the wait.
  if (closedByTheScreen && blame.kind === 'painting') notes.push(closedByTheScreen);
  // Short of a long task the count has no rung to stand in for, so it is said as it is.
  else if (blame.kind === 'painting' && shortOf && r.processing >= OUTRAN_RENDER_MIN_SHARE * r.presentation) notes.push(`${shortOf}.`);
  // A long wait under any other verdict is said whatever React rendered: a 70 ms wait before a 98 ms handler went
  // unsaid beside a 2 ms render, or none, and was said beside a 10 ms one. Under a verdict that is the wait, it
  // is already said, and so it is under a script said to have run before the handler started.
  if (r.inputDelay > LONG_TASK_MS && !waitIsTheVerdict && !saidBehind) notes.push(`It also waited ${ms(r.inputDelay)} before the handler could start, because the main thread was busy.`);
  if (c?.truncated && c !== cutSaid) notes.push('The component count is partial: the walk stopped at its budget or at its depth limit.');
  const walked = [...r.commits, ...r.followUps];
  if (namesLookMinified(walked)) notes.push(MINIFIED_NAMES_NOTE);
  if (forcedAfterInput >= FORCED_LAYOUT_MIN_MS && blame.kind !== 'layout') {
    // All inside the handlers, it is where the layout rung would put it. Where some was after them, a commit there
    // can be another input's, and a sentence about the handlers' part would be read as about all of it, so the
    // usual place is said.
    const said = forcedAfterInput - forcedWhileHandling < 0.5 ? whereRead(whileHandling).said : USUAL_READ;
    notes.push(`The browser also spent ${ms(forcedAfterInput)} recalculating styles and layout in scripts before the paint. ${said}`);
  }
  // The wait INP leaves out is what the note is for, so a render outside the entries goes first. INP
  // did time a render the release made inside its own entry, so for that one the note says where it ran.
  const f = laterRenderOf(r);
  if (f) {
    // A walk cut short with no count inside its last name stopped at that name, which is where the budget ran out, not
    // where the render went: hyperdx's note named the page root of a cut 4983-component render. The count is said alone.
    const phrase = f.truncated && f.rendered > 0 && insideCount(f) == null ? `${renderVerb(f)} ${renderedCount(f)}` : renderPhrase(f);
    const what = f.hasDurations ? `${ms(f.total)} ${phrase}` : phrase;
    // Only the scripts it committed or ran its effects in: a frame's other scripts force layout of their own.
    const ranIn = (s: ScriptSummary, t: number | null) => t !== null && t > s.start && t <= s.start + s.duration + 1e-6;
    // A script that also holds another commit's stamp or effects' end has one figure for both, which can't be split,
    // so nothing is said: hyperdx's later render was given its whole task's 12 ms where the trace had 1.5 ms of it.
    const holding = (x: CommitSummary, s: ScriptSummary) => ranIn(s, x.at) || ranIn(s, x.effectsEndedAt);
    const others = [...r.commits, ...r.followUps].filter((x) => x !== f);
    const held = (r.laterFrames ?? []).flatMap((x) => x.scripts).filter((s) => holding(f, s));
    const laterForced = held.some((s) => others.some((x) => holding(x, s))) ? 0 : held.reduce((a, s) => a + s.forcedLayout, 0);
    const layout = laterForced >= FORCED_LAYOUT_MIN_MS ? `, and it made the browser recalculate styles and layout for ${ms(laterForced)} on the way` : '';
    const uncounted = !timed(f, r.entries);
    // One before the headline's input landed after the press painted, before the release, and is said so:
    // put after "the screen updated", it read as coming after the paint the report is about.
    const landed =
      f.at < r.end
        ? `A React render landed ${ms(f.at - paintBefore(r.entries, f.at))} after the press updated the screen, before the release`
        : `A second React render landed ${ms(f.at - r.end)} after the screen updated${uncounted ? '' : ', on the release'}`;
    // Nothing ties a render INP didn't time to the interaction but its timing: on hyperdx a live tail's timer and a
    // route change landed there, so the note doesn't say people wait for it.
    notes.push(`${landed}: ${what}${layout}.${uncounted ? " INP doesn't count it, and what started it can't be told." : ''}`);
  }
  // A render the clause ties to the script is said there and nowhere else, so the note is kept for it at
  // any length and whichever phase was the longer: a render the script forced is the script's, as
  // insideLate says, and not left in the working time as an effect's. Over PRESENTATION_NOTE_MS the note
  // is kept with no such render too, the way closedByTheScreen keeps a render the screen update outranked:
  // on twenty's select-all, 762 ms of the screen updating went unsaid behind 947 ms of rendering. Where the
  // frame waited on the next press the note says that at any length, as the blame would: typing fast, the script
  // after the handlers is the next key's handler, and not why this key's screen update was slow. With no listener
  // of that press on record, under PRESENTATION_NOTE_MS its render alone says so (`byRender`). For a next click with
  // only its click in the ring it is not kept at any length, as in 0.18.0, since the verdict can name its script.
  // It is kept at any length too where a script verdict, or none, passed over a longer script after the handlers,
  // or that one went unsaid: an idle click's 22 ms handler took it from a 49 ms timer after it under a 100 ms screen
  // update, and with the next key's 44 ms handler left out of a keydown's verdict, nothing said that handler ran.
  // Where what React did is unknown, the none weighed no script, and passed over none.
  if ((r.presentation > PRESENTATION_NOTE_MS || insideLate.length || (nextNoted && lateScript && !clickOnly) || ((blame.kind === 'script' || (blame.kind === 'none' && !unseen)) && lateScript && lateScript.ms > (ranScript?.ms ?? 0))) && blame.kind !== 'painting') {
    notes.push(`After the handler finished, the screen took another ${ms(r.presentation)} to update${nextNoted ? nextClause(!byRender && nextScriptMs >= nextShare) : lateScriptClause}`);
  }
  if (betweenMatters && !betweenWins) notes.push(`${cap(ms(between))} of the working time also went by ${whereBetween}, with no handler running.`);
  if (r.holdMs >= HOLD_NOTE_MS) {
    notes.push(`The whole ${kind}, from press to release, spanned ${ms(r.duration + r.holdMs)}; INP counts only its slowest part, so the rest is left out of the headline.`);
  }
  if (r.commits.some((x) => x.coarseClock) || r.followUps.some((x) => x.coarseClock)) {
    notes.push("This browser's clock steps in whole milliseconds, too coarse to time each component, so no component's time is shown and React's total is a sum of whole-millisecond readings.");
  }
  // One minifier's name among readable ones is most likely a dependency's component that sets no
  // displayName, which no build step in the app can name: on Twenty, React Router's RouterProvider read "hl".
  // Said where the report sends the reader to it, as the blame or as what React rendered inside anywhere in
  // the text, a whole name ("inside Ta" is not "inside TableBody"), and never as a guess at what it is.
  const said = [cause, ...notes].join(' ');
  const odd = walked.map(leafOf).find((n) => minifiedAmongReadable(walked, n) && (n === blame.name || new RegExp(` inside ${n.replace(/\$/g, '\\$&')}(?![\\w$]|\\.[\\w$])`).test(said)));
  if (odd) notes.push(`The name ${odd} looks like one a minifier left, most likely on a dependency's component, which this library's build steps do not name. Selecting it in React DevTools shows its props and what rendered it, which usually says whose it is.`);

  // Hydrating runs inside the event's own dispatch, so it is part of the working time rather than a
  // fourth phase beside it: the three phases go on adding up to the interaction the way they always did.
  const hydrationMs = waited && waited.boundary.ms != null ? Math.min(waited.boundary.ms, r.processing) : 0;
  return Object.freeze({
    headline,
    blame: Object.freeze(blame),
    rating,
    where,
    cause,
    notes: Object.freeze(notes),
    phases: phasesOf(r, hydrationMs),
  });
}

/** Where the interaction happened, as its verdict names it after 'on': the target, and the component it is in. */
function placeOf(r: InteractionReport): string | null {
  return r.target ? [r.target.label || r.target.selector, r.target.component ? `in ${r.target.component}` : ''].filter(Boolean).join(' ') || null : null;
}

/** Waiting, working and updating the screen, of which `hydrationMs` of the working time went to hydrating. */
function phasesOf(r: InteractionReport, hydrationMs: number): readonly Phase[] {
  const working: Phase = { label: 'Working', ms: r.processing, hint: 'Event handlers and React rendering.' };
  const phases: Phase[] = [
    { label: 'Waiting', ms: r.inputDelay, hint: 'Before the handler could start. The main thread was busy.' },
    hydrationMs > 0 ? { ...working, parts: Object.freeze([Object.freeze({ label: 'Hydrating', ms: hydrationMs, hint: 'React hydrating server-rendered HTML the interaction landed on, before it could be handled.' })]) } : working,
    { label: 'Updating the screen', ms: r.presentation, hint: 'From the end of the handlers to the next painted frame.' },
  ];
  return Object.freeze(phases.map((p) => Object.freeze(p)));
}

/**
 * What a report reads as where building its explanation threw: its headline, where it happened and its
 * phases, nothing blamed, and a cause that says so. It points to the library-error warning (`dropped`)
 * rather than to its own error, since that warning shows once a page and quotes the first error caught.
 */
function unexplained(r: InteractionReport): Explanation {
  const kind = kindOf(r.type, r.pointerType);
  return Object.freeze({
    headline: `${ms(r.duration)} ${kind}`,
    blame: Object.freeze<Blame>({ kind: 'none', name: null, detail: null, ms: null, confidence: 'inferred' }),
    rating: rateInp(r.duration),
    where: placeOf(r),
    cause: `Where the time went is unknown: this library hit an error of its own while it worked that out for this ${kind}, so nothing is blamed. See the library-error warning in the console.`,
    notes: Object.freeze([]),
    phases: phasesOf(r, 0),
  });
}

function toVerdict(x: Explanation): string {
  return `${x.headline}${x.where ? ` on ${x.where}` : ''}. ${x.cause}${x.notes.length ? ' ' + x.notes.join(' ') : ''}`;
}
