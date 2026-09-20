import { memo, useState } from 'react';
import { burn } from '../burn';

/** 250 sections at 10 ms each: about 2.5 seconds of rendering from one click, none of it in the handler. */
const SECTIONS = 250;
const MS_EACH = 10;

/**
 * Anti-pattern: everything is rebuilt during render. The handler sets one number and returns, and then
 * React renders for seconds, so every millisecond of the interaction is React's own render phase.
 *
 * It is also the case that used to defeat the attribution: React commits this inside the click's own
 * dispatch, seconds after the click, and a commit was only joined to an input it landed close behind.
 * The report said React had not rendered anything, which was both wrong and stated as a measurement.
 */
export function SlowRender() {
  const [runs, setRuns] = useState(0);
  const [archived, setArchived] = useState(false);
  const [tag, setTag] = useState('');
  // Named handlers, so the report can show what a development build knows about them.
  const rebuild = () => setRuns((n) => n + 1);
  const includeArchived = (e: { target: { checked: boolean } }) => setArchived(e.target.checked);
  // React runs this from the native `input` event inside the keystroke's dispatch, not from the
  // keydown, so a commit during it has to be read as the key press's work.
  const retitle = (e: { target: { value: string } }) => setTag(e.target.value);
  return (
    <>
      <button className="primary" data-test="trigger" onClick={rebuild}>
        Rebuild report ({runs})
      </button>
      <label className="opt">
        <input type="checkbox" data-test="archived" checked={archived} onChange={includeArchived} />
        Include archived
      </label>
      <label className="opt">
        Tag
        <input type="text" data-test="tag" value={tag} onChange={retitle} />
      </label>
      <ul className="grid">
        {Array.from({ length: SECTIONS }, (_, i) => (
          <Section key={i} index={i} runs={runs} archived={archived} tag={tag} />
        ))}
      </ul>
    </>
  );
}

const Section = memo(function Section({ index, runs, archived, tag }: { index: number; runs: number; archived: boolean; tag: string }) {
  // Sorting, formatting and totalling a section, done again on every render.
  burn(MS_EACH);
  return (
    <li>
      <b>Section {index}</b> · run {runs}
      {archived ? ' · with archived' : ''}
      {tag ? ` · ${tag}` : ''}
    </li>
  );
});
