import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inertApi } from '../src/inert.ts';
import { page } from '../src/install-state.ts';
import { buildReport, sealReport } from '../src/join.ts';
import type { CommitSummary, InteractionReport } from '../src/types.ts';
import { attributeINP, generateTarget } from '../src/web-vitals.ts';

// React stores a fiber on a DOM node under a key with the fiber's own random suffix.
const FIBER_KEY = '__reactFiber$r1nd0m';

/** A component fiber as React links them: `return` is the component that rendered this one. */
function component(name: string, parent: Record<string, unknown> | null = null): Record<string, unknown> {
  const fn = Object.defineProperty(function () {}, 'name', { value: name });
  return { tag: 0, flags: 1, mode: 0, elementType: fn, type: fn, memoizedProps: null, memoizedState: null, return: parent, child: null, sibling: null, alternate: null };
}

/** The chain of components enclosing an element, outermost named first, as fibers. */
function owners(...names: string[]): Record<string, unknown> {
  let fiber: Record<string, unknown> | null = null;
  for (const name of names) fiber = component(name, fiber);
  return fiber!;
}

interface ElementOptions {
  attributes?: Record<string, string>;
  classes?: string[];
  id?: string;
  fiber?: Record<string, unknown> | null;
  parentNode?: unknown;
}

/**
 * A DOM element as this entry reads one. Its `textContent` throws: what goes into
 * `interactionTarget` is built from attributes, never from what the element says.
 */
function element(tag: string, { attributes = {}, classes = [], id = '', fiber = null, parentNode = null }: ElementOptions = {}): Record<string, unknown> {
  // The id is an attribute as well, as it is on a page, and the attribute is what the selector reads.
  const named: Record<string, string> = id ? { ...attributes, id } : attributes;
  const el: Record<string, unknown> = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    id,
    classList: classes,
    parentNode,
    parentElement: parentNode,
    getAttribute: (name: string) => named[name] ?? null,
  };
  if (fiber) el[FIBER_KEY] = fiber;
  Object.defineProperty(el, 'textContent', {
    get() {
      throw new Error('the target description read the whole textContent');
    },
  });
  return el;
}

const textNode = (value: string, parentNode: unknown): Record<string, unknown> => ({ nodeType: 3, nodeValue: value, parentNode, parentElement: parentNode, firstChild: null });

const asNode = (x: unknown): Node => x as Node;

test('the target names the components enclosing the element, outermost first, then the element itself', () => {
  const tile = element('button', { attributes: {}, classes: ['tile'], fiber: owners('ProfilePage', 'PhotoTile') });
  assert.equal(generateTarget(asNode(tile)), 'ProfilePage > PhotoTile (button.tile)');
});

test("names a reader could not search their code for make way for the next owner out, unless nothing better is there", () => {
  // A minifier's `Xe` and styled-components' `styled.button` between the element and the app's own components.
  const save = element('button', { classes: ['save'], fiber: owners('App', 'Editor', 'Panel', 'Toolbar', 'SaveButton', 'styled.button', 'Xe') });
  assert.equal(generateTarget(asNode(save)), 'Editor > Panel > Toolbar > SaveButton (button.save)');
  // A chain with no readable name keeps its names as they stand rather than inventing one.
  const minified = element('button', { classes: ['x'], fiber: owners('Qe', 'Styled(div)', 'Xe') });
  assert.equal(generateTarget(asNode(minified)), 'Qe > Styled(div) > Xe (button.x)');
});

test("an icon inside a button is placed by the button, as reports name it", () => {
  // The icon component (lucide's Trash2) sits between the button and the svg that was clicked.
  const button = element('button', { classes: ['delete'], fiber: owners('Toolbar', 'DeleteButton') });
  const icon = element('svg', { classes: ['lucide'], fiber: owners('Toolbar', 'DeleteButton', 'Trash2'), parentNode: button });
  assert.equal(generateTarget(asNode(icon)), 'Toolbar > DeleteButton (svg.lucide)');
});

test('a node with no fiber of its own is placed by the nearest element that has one', () => {
  // React writes an element's only string child in as its text, with no fiber: `<button>Open</button>`.
  const tile = element('button', { classes: ['tile'], fiber: owners('ProfilePage', 'PhotoTile') });
  assert.equal(generateTarget(asNode(textNode('Open', tile))), 'ProfilePage > PhotoTile (button.tile)');
  // An element the app created outside React is described as itself, under the components above it.
  assert.equal(generateTarget(asNode(element('span', { parentNode: tile }))), 'ProfilePage > PhotoTile (span)');
});

test('inside an icon, a node with no fiber of its own is named as the icon is, not by the element holding it', () => {
  // `<button className="delete"><Icon /></button>`, where Icon renders `<span className="icon">` with an
  // svg string set through dangerouslySetInnerHTML, so the `<svg>` has no fiber.
  const buttonFiber: Record<string, unknown> = { tag: 5, elementType: 'button', type: 'button', memoizedProps: {}, return: owners('Toolbar', 'DeleteButton'), sibling: null };
  const iconFiber = component('Icon', buttonFiber);
  const spanFiber: Record<string, unknown> = { tag: 5, elementType: 'span', type: 'span', memoizedProps: {}, return: iconFiber, child: null, sibling: null };
  buttonFiber.child = iconFiber;
  iconFiber.child = spanFiber;
  buttonFiber.stateNode = element('button', { classes: ['delete'], fiber: buttonFiber });
  spanFiber.stateNode = element('span', { classes: ['icon'], fiber: spanFiber, parentNode: buttonFiber.stateNode });
  const svg = element('svg', { classes: ['glyph'], parentNode: spanFiber.stateNode });
  assert.equal(generateTarget(asNode(spanFiber.stateNode)), 'Toolbar > DeleteButton > Icon (span.icon)');
  assert.equal(generateTarget(asNode(svg)), 'Toolbar > DeleteButton (svg.glyph)');
  // Inside means up to five levels in. Artwork nested deeper is outside the icon, and placed by the nearest
  // element that has a fiber, the span Icon renders.
  let g = svg;
  for (let level = 1; level <= 5; level++) g = element('g', { parentNode: g });
  assert.equal(generateTarget(asNode(g)), 'Toolbar > DeleteButton (g)');
  assert.equal(generateTarget(asNode(element('path', { parentNode: g }))), 'Toolbar > DeleteButton > Icon (path)');
});

test('an icon a script drew outside React is placed by the button holding it, under the component that handed the button its onClick', () => {
  // `<IconButton onClick={close} />` in Page, where IconButton renders `<button onClick={onClick}><i data-feather="x" /></button>`
  // and feather.replace() swaps the `<i>` for an `<svg>` React never saw, so the svg has no fiber and the
  // button's is read.
  const close = () => {};
  /**
   * Page's IconButton, whose button holds `inside` in the tree React rendered: a fiber, text React wrote in with
   * none, or nothing. `props` are the button's others.
   */
  const iconButton = (inside: Record<string, unknown> | string | null, props: Record<string, unknown> = {}): Record<string, unknown> => {
    const iconButtonFiber = component('IconButton', component('Page'));
    iconButtonFiber.memoizedProps = { onClick: close };
    const written = typeof inside === 'string';
    const buttonFiber: Record<string, unknown> = { tag: 5, elementType: 'button', type: 'button', memoizedProps: written ? { ...props, onClick: close, children: inside } : { ...props, onClick: close }, return: iconButtonFiber, child: written ? null : inside, sibling: null };
    iconButtonFiber.child = buttonFiber;
    if (inside !== null && !written) inside.return = buttonFiber;
    buttonFiber.stateNode = element('button', { fiber: buttonFiber });
    return buttonFiber.stateNode as Record<string, unknown>;
  };
  const drawnOver = { tag: 5, elementType: 'i', type: 'i', memoizedProps: { 'data-feather': 'x' }, child: null, sibling: null };
  const feather = element('svg', { classes: ['feather', 'feather-x'], parentNode: iconButton(drawnOver) });
  assert.equal(generateTarget(asNode(feather)), 'Page > IconButton (svg.feather.feather-x)');
  // So is an icon a script drew beside the button's text, which React writes in with no fiber for it:
  // twemoji.parse() swaps the emoji in `<button onClick={onClick}>👍 Like</button>` for an `<img class="emoji">`.
  const emoji = element('img', { classes: ['emoji'], parentNode: iconButton('👍 Like') });
  assert.equal(generateTarget(asNode(emoji)), 'Page > IconButton (img.emoji)');
  // And one in a button React rendered nothing in: an svg imported as a string and set through
  // dangerouslySetInnerHTML, or the `<svg>` Font Awesome's searchPseudoElements draws in an empty
  // `<button aria-label="Close">`.
  const setOnButton = element('svg', { parentNode: iconButton(null, { dangerouslySetInnerHTML: { __html: '<svg></svg>' } }) });
  assert.equal(generateTarget(asNode(setOnButton)), 'Page > IconButton (svg)');
  const pseudo = element('svg', { classes: ['svg-inline--fa', 'fa-xmark'], parentNode: iconButton(null, { 'aria-label': 'Close' }) });
  assert.equal(generateTarget(asNode(pseudo)), 'Page > IconButton (svg.svg-inline--fa.fa-xmark)');
  // An svg React rendered in the same button is placed there as well.
  const svgFiber: Record<string, unknown> = { tag: 5, elementType: 'svg', type: 'svg', memoizedProps: {}, child: null, sibling: null };
  svgFiber.stateNode = element('svg', { classes: ['lucide'], fiber: svgFiber, parentNode: iconButton(svgFiber) });
  assert.equal(generateTarget(asNode(svgFiber.stateNode)), 'Page > IconButton (svg.lucide)');
  // So is one set through dangerouslySetInnerHTML in an Icon of the app's own, in that button or in a card
  // that shows it beside a title.
  const setInto = (iconFiber: Record<string, unknown>, holder: () => unknown) => {
    const spanFiber: Record<string, unknown> = { tag: 5, elementType: 'span', type: 'span', memoizedProps: { dangerouslySetInnerHTML: { __html: '<svg></svg>' } }, return: iconFiber, child: null, sibling: null };
    iconFiber.child = spanFiber;
    spanFiber.stateNode = element('span', { fiber: spanFiber, parentNode: holder() });
    return element('svg', { parentNode: spanFiber.stateNode });
  };
  const inButton = component('Icon');
  assert.equal(generateTarget(asNode(setInto(inButton, () => iconButton(inButton)))), 'Page > IconButton (svg)');
  const cardFiber: Record<string, unknown> = { tag: 5, elementType: 'div', type: 'div', memoizedProps: {}, return: component('Card', component('Page')), sibling: null };
  const inCard = component('Icon', cardFiber);
  inCard.sibling = { tag: 5, elementType: 'h3', type: 'h3', memoizedProps: {}, return: cardFiber, child: null, sibling: null };
  cardFiber.child = inCard;
  cardFiber.stateNode = element('div', { fiber: cardFiber });
  assert.equal(generateTarget(asNode(setInto(inCard, () => cardFiber.stateNode))), 'Page > Card (svg)');
});

test('an icon a script drew in an element handed its role with its onClick is placed under the component that wrote them', () => {
  // `<ReactSVG src={trash} role="button" tabIndex={0} onClick={remove} />` beside a label in RemoveRow: react-svg
  // renders an empty `<div>` with the props it was given and SVGInjector draws the svg into it, with no fiber.
  const remove = () => {};
  const reactSvg = (given: Record<string, unknown>) => {
    const rowFiber: Record<string, unknown> = { tag: 5, elementType: 'div', type: 'div', memoizedProps: {}, return: owners('Rows', 'RemoveRow'), sibling: null };
    // A class component.
    const reactSvgFiber = Object.assign(component('ReactSVG', rowFiber), { tag: 1, memoizedProps: { src: 'trash.svg', ...given, onClick: remove } });
    reactSvgFiber.sibling = { tag: 5, elementType: 'span', type: 'span', memoizedProps: {}, return: rowFiber, child: null, sibling: null };
    rowFiber.child = reactSvgFiber;
    const divFiber: Record<string, unknown> = { tag: 5, elementType: 'div', type: 'div', memoizedProps: { ...given, onClick: remove, children: [false, false] }, return: reactSvgFiber, child: null, sibling: null };
    reactSvgFiber.child = divFiber;
    rowFiber.stateNode = element('div', { fiber: rowFiber });
    divFiber.stateNode = element('div', { attributes: typeof given.role === 'string' ? { role: given.role } : {}, fiber: divFiber, parentNode: rowFiber.stateNode });
    return element('path', { parentNode: element('svg', { parentNode: divFiber.stateNode }) });
  };
  assert.equal(generateTarget(asNode(reactSvg({ role: 'button', tabIndex: 0 }))), 'Rows > RemoveRow (path)');
  assert.equal(generateTarget(asNode(reactSvg({}))), 'Rows > RemoveRow (path)');
  // The same where the component that wrote them renders nothing but the ReactSVG, from an onRemove it was
  // given: `<ReactSVG src={trash} role="button" onClick={onRemove} />` in RemoveButton.
  const removeButton = Object.assign(component('RemoveButton', owners('Rows')), { memoizedProps: { onRemove: remove } });
  const alone = Object.assign(component('ReactSVG', removeButton), { tag: 1, memoizedProps: { src: 'trash.svg', role: 'button', onClick: remove } });
  removeButton.child = alone;
  const aloneDiv: Record<string, unknown> = { tag: 5, elementType: 'div', type: 'div', memoizedProps: { role: 'button', onClick: remove, children: [false, false] }, return: alone, child: null, sibling: null };
  alone.child = aloneDiv;
  aloneDiv.stateNode = element('div', { attributes: { role: 'button' }, fiber: aloneDiv });
  assert.equal(generateTarget(asNode(element('path', { parentNode: element('svg', { parentNode: aloneDiv.stateNode }) }))), 'Rows > RemoveButton (path)');
});

test('an icon a script drew in an element handed its role through a styled component stays under the component that gave it the role', () => {
  // IconButton renders `<Clickable role="button" aria-label="Close" onClick={onClick} />`, where
  // `const Clickable = styled.div`, and Font Awesome's searchPseudoElements draws an svg in the empty div. The
  // role came from IconButton, not from what IconButton was given, so the div is a control of IconButton's.
  const close = () => {};
  const headerFiber: Record<string, unknown> = { tag: 5, elementType: 'header', type: 'header', memoizedProps: {}, return: component('Page'), sibling: null };
  const iconButtonFiber = Object.assign(component('IconButton', headerFiber), { memoizedProps: { onClick: close } });
  iconButtonFiber.sibling = { tag: 5, elementType: 'h1', type: 'h1', memoizedProps: {}, return: headerFiber, child: null, sibling: null };
  headerFiber.child = iconButtonFiber;
  const props = { role: 'button', 'aria-label': 'Close', onClick: close };
  const clickable = { $$typeof: Symbol.for('react.forward_ref'), render: () => null, styledComponentId: 'sc-a1b2', target: 'div' };
  const clickableFiber = Object.assign(component('Clickable', iconButtonFiber), { tag: 11, elementType: clickable, type: clickable, memoizedProps: props });
  iconButtonFiber.child = clickableFiber;
  const divFiber: Record<string, unknown> = { tag: 5, elementType: 'div', type: 'div', memoizedProps: props, return: clickableFiber, child: null, sibling: null };
  clickableFiber.child = divFiber;
  headerFiber.stateNode = element('header', { fiber: headerFiber });
  divFiber.stateNode = element('div', { attributes: { role: 'button', 'aria-label': 'Close' }, fiber: divFiber, parentNode: headerFiber.stateNode });
  const drawn = element('svg', { classes: ['svg-inline--fa'], parentNode: divFiber.stateNode });
  assert.equal(generateTarget(asNode(drawn)), 'Page > IconButton (svg.svg-inline--fa)');
});

test('an icon a script drew is placed by what React renders in the element now, not by the fiber cached on it', () => {
  // `<LikeButton role="button" onClick={like} />` beside a title in Page, where LikeButton renders `<div
  // className="like" role={role} onClick={onClick}>{count > 0 && <Count />}{liked && <Liked />}</div>` and a
  // script drew an svg in the div. The div is a control by the role it was handed with its onClick, so it holds
  // the svg while React renders something in it, and the svg is Page's while React renders nothing there, as in
  // the empty div ReactSVG draws in. The fiber cached on the div is the one React made it with, and the div's two
  // fibers take turns being on the screen, so on every other render the cached one holds the render before: no
  // Count before the first like, and no child at all once React has cleared the child list it deleted one from.
  const like = () => {};
  const link = (parent: Record<string, unknown>, ...kids: Record<string, unknown>[]) => {
    parent.child = kids[0] ?? null;
    kids.forEach((kid, i) => Object.assign(kid, { return: parent, sibling: kids[i + 1] ?? null }));
    return parent;
  };
  const hostFiber = (tag: string, props: Record<string, unknown> = {}): Record<string, unknown> => ({ tag: 5, elementType: tag, type: tag, memoizedProps: props, child: null, sibling: null });
  /** One of the two trees React keeps, whose div holds `inside`, the fiber React rendered there, or nothing. */
  const tree = (children: unknown[], inside: Record<string, unknown> | null) => {
    const div = hostFiber('div', { className: 'like', role: 'button', onClick: like, children });
    if (inside) link(div, inside);
    const likeButton = link(Object.assign(component('LikeButton'), { memoizedProps: { role: 'button', onClick: like } }), div);
    const header = link(hostFiber('header'), likeButton, hostFiber('h1'));
    const page = link(component('Page'), header);
    const root = link({ tag: 3, memoizedProps: null, child: null, sibling: null }, page);
    return { root, page, header, likeButton, div };
  };
  const count = { type: 'Count' };
  const liked = { type: 'Liked' };
  /**
   * The svg drawn in the div, when `now` is the tree on the screen and `before` the one from the render before,
   * each fiber paired with its other, and `cached` which of the div's fibers the div holds. `shape` is how
   * React left the two trees. In 'apart' each fiber points at its own tree's parent. In 'bailed out' a commit
   * elsewhere since bailed out at the header, leaving both its fibers one child list, and made the other root
   * current. In 'one parent' the div's two fibers both point at LikeButton's current one, as a bailout can
   * leave them. In 'cleared' the header's child list from the render before is cleared, as React clears it
   * once it deleted a child from it.
   */
  const drawnIn = (now: ReturnType<typeof tree>, before: ReturnType<typeof tree>, cached: 'now' | 'before', shape: 'apart' | 'bailed out' | 'one parent' | 'cleared') => {
    for (const key of Object.keys(now) as (keyof typeof now)[]) {
      now[key].alternate = before[key];
      before[key].alternate = now[key];
    }
    now.root.stateNode = before.root.stateNode = { current: shape === 'bailed out' ? before.root : now.root };
    if (shape === 'bailed out') before.header.child = now.header.child;
    if (shape === 'one parent') before.div.return = now.likeButton;
    if (shape === 'cleared') before.header.child = null;
    const div = element('div', { attributes: { role: 'button' }, classes: ['like'], fiber: cached === 'now' ? now.div : before.div });
    now.div.stateNode = before.div.stateNode = div;
    return element('svg', { parentNode: div });
  };
  const readings: [string, () => ReturnType<typeof tree>, () => ReturnType<typeof tree>, string][] = [
    // The first like: a Count where there was nothing.
    ['a count that appeared', () => tree([count, false], { tag: 0 }), () => tree([false, false], null), 'Page > LikeButton (svg)'],
    // Liked in place of the count: React deleted the Count, and cleared the child list that held it.
    ['a count that made way', () => tree([false, liked], { tag: 0 }), () => tree([count, false], null), 'Page > LikeButton (svg)'],
    // The last unlike: nothing where the Count was, whether React has cleared the old list yet or not.
    ['a count that went', () => tree([false, false], null), () => tree([count, false], { tag: 0 }), 'Page (svg)'],
  ];
  for (const [what, now, before, target] of readings) {
    for (const cached of ['now', 'before'] as const) {
      for (const shape of ['apart', 'bailed out', 'one parent', 'cleared'] as const) {
        assert.equal(generateTarget(asNode(drawnIn(now(), before(), cached, shape))), target, `${what}, the ${cached} fiber cached, ${shape}`);
      }
    }
  }
});

test("an svg an app's Icon sets through dangerouslySetInnerHTML is placed as one it renders, whoever gave the element its role", () => {
  // `<Icon svg={trash} onClick={remove} />` beside a label in RemoveRow, where Icon renders
  // `<span role={onClick ? 'button' : 'img'} onClick={onClick} dangerouslySetInnerHTML={{ __html: svg }} />`. The
  // span is the icon itself, as the `<svg role="button" onClick>` Trash2 renders is, and Icon renders nothing
  // but it.
  const remove = () => {};
  const icon = (given: Record<string, unknown>, own: Record<string, unknown>) => {
    const rowFiber: Record<string, unknown> = { tag: 5, elementType: 'div', type: 'div', memoizedProps: {}, return: owners('Rows', 'RemoveRow'), sibling: null };
    const iconFiber = Object.assign(component('Icon', rowFiber), { memoizedProps: { svg: '<svg></svg>', ...given, onClick: remove } });
    iconFiber.sibling = { tag: 5, elementType: 'span', type: 'span', memoizedProps: {}, return: rowFiber, child: null, sibling: null };
    rowFiber.child = iconFiber;
    const props = { ...given, ...own, onClick: remove };
    const spanFiber: Record<string, unknown> = { tag: 5, elementType: 'span', type: 'span', memoizedProps: props, return: iconFiber, child: null, sibling: null };
    iconFiber.child = spanFiber;
    rowFiber.stateNode = element('div', { fiber: rowFiber });
    spanFiber.stateNode = element('span', { attributes: { role: 'button' }, fiber: spanFiber, parentNode: rowFiber.stateNode });
    return element('svg', { parentNode: spanFiber.stateNode });
  };
  const markup = { dangerouslySetInnerHTML: { __html: '<svg></svg>' } };
  assert.equal(generateTarget(asNode(icon({}, { ...markup, role: 'button' }))), 'Rows > RemoveRow (svg)');
  assert.equal(generateTarget(asNode(icon({ role: 'button' }, markup))), 'Rows > RemoveRow (svg)');
  // Where a script draws the svg in an empty `<span role="button" aria-label="Delete">` that Icon renders, the
  // span is the icon, as Font Awesome's empty `<i>` is, and RemoveRow wrote it.
  assert.equal(generateTarget(asNode(icon({}, { role: 'button', 'aria-label': 'Delete' }))), 'Rows > RemoveRow (svg)');
});

test('text a component returned adds that component to the path of the element holding it', () => {
  const button = { tag: 5, elementType: 'button', type: 'button', memoizedProps: {}, return: owners('ProfilePage', 'PhotoTile') };
  const tile = element('button', { classes: ['tile'], fiber: button });
  // Any other text React creates as a node of its own, with a fiber whose `return` is what returned the text.
  const text = (value: string, returnedBy: Record<string, unknown>): Record<string, unknown> => {
    const node = textNode(value, tile);
    node[FIBER_KEY] = { tag: 6, elementType: null, type: null, memoizedProps: value, return: returnedBy };
    return node;
  };
  // `<button><Label /></button>`, where the component returns a string.
  const label = text('Open', component('Label', button));
  assert.equal(generateTarget(asNode(label)), 'ProfilePage > PhotoTile > Label (button.tile)');
  // Text beside the element's other children is the element's own: `<button>{icon} Open</button>`.
  assert.equal(generateTarget(asNode(text(' Open', button))), 'ProfilePage > PhotoTile (button.tile)');
});

test('the element is described from its attributes, never from the text it shows', () => {
  const save = element('button', { attributes: { 'data-test': 'save' }, id: 'save', classes: ['primary', 'lg'], fiber: owners('Toolbar') });
  assert.equal(generateTarget(asNode(save)), 'Toolbar (button#save[data-test="save"])');
});

test('web-vitals falls back to its own selector when there is no fiber to read', () => {
  // The signature says the node can be null, and web-vitals calls it with whatever an entry carried.
  assert.equal(generateTarget(null), undefined);
  // A page with no React on it, and an element React never rendered.
  assert.equal(generateTarget(asNode(element('div'))), undefined);
  assert.equal(generateTarget(asNode(textNode('plain', null))), undefined);
  // A fiber whose components have no name left worth printing: an anonymous default export, minified away.
  const anonymous = { tag: 0, flags: 1, mode: 0, elementType: null, type: null, memoizedProps: null, memoizedState: null, return: null, child: null, sibling: null, alternate: null };
  assert.equal(generateTarget(asNode(element('button', { fiber: anonymous }))), undefined);
});

test('a node this library cannot read gives up rather than breaking the page metric', () => {
  const throwing = (property: string): Node => {
    const node = element('button', { fiber: owners('Page') });
    Object.defineProperty(node, property, {
      get() {
        throw new Error(`reading ${property} across a document boundary`);
      },
    });
    return asNode(node);
  };
  // A node from another document or a detached tree can throw on any of these.
  for (const property of ['nodeType', 'tagName', 'classList']) {
    assert.equal(generateTarget(throwing(property)), undefined, property);
  }
  const hostile = element('button', { fiber: owners('Page') });
  hostile.getAttribute = () => {
    throw new Error('attribute access refused');
  };
  assert.equal(generateTarget(asNode(hostile)), undefined);

  // The climb to the nearest fiber is where a node from another document usually gives way.
  const detached = element('span');
  Object.defineProperty(detached, 'parentNode', {
    get() {
      throw new Error('reading parentNode across a document boundary');
    },
  });
  assert.equal(generateTarget(asNode(detached)), undefined);
});

test('a deep tree and a long id are capped, keeping the components nearest the element', () => {
  const deep = element('button', { classes: ['tile'], fiber: owners('App', 'Shell', 'Sidebar', 'Filters', 'DateRange', 'Preset') });
  // At most four components, the four nearest the element.
  assert.equal(generateTarget(asNode(deep)), 'Sidebar > Filters > DateRange > Preset (button.tile)');

  const long = element('button', { id: 'x'.repeat(400), fiber: owners('A'.repeat(60), 'B'.repeat(60)) });
  const target = generateTarget(asNode(long));
  assert.ok(target && target.length <= 120, `${target?.length} characters`);
  // The outermost component went first, so the nearest one and the element are both still there.
  assert.ok(target?.startsWith('BBB'), target);
  // The element is shortened to fit rather than cut off the end, so its brackets are never left open.
  assert.ok(target?.includes(' (button#xxx'), target);
  assert.ok(target?.endsWith(')'), target);

  // A component path that fills the cap on its own leaves no room, and the element is dropped whole.
  const wide = element('button', { classes: ['tile'], fiber: owners('C'.repeat(119)) });
  const only = generateTarget(asNode(wide));
  assert.ok(only && only.length <= 120, `${only?.length} characters`);
  assert.equal(only?.includes('('), false, only);
});

test('a long escaped id is shortened to its last whole escape or character, never cut inside one', () => {
  // Each colon of React 18's useId is written as two characters, and the room left for the element runs
  // from 55 to 60, so a slice would end two of these on a backslash that escapes the bracket after it.
  for (let length = 57; length <= 62; length++) {
    const target = generateTarget(asNode(element('button', { id: ':r1:'.repeat(20), fiber: owners('B'.repeat(length)) })));
    assert.match(target?.slice(length) ?? '', /^ \(button#(\\:|r|1)+\)$/, target);
  }
  // A leading digit is written as its code point and a space, four characters kept or dropped together.
  for (let length = 109; length <= 114; length++) {
    const target = generateTarget(asNode(element('tr', { id: '1st-place', fiber: owners('C'.repeat(length)) })));
    assert.match(target?.slice(length) ?? '', /^ \(tr#(\\31 s?)?\)$/, target);
  }
  // A backslash in a test attribute's value is written as two, and a pair the cut ends on is kept whole.
  for (let length = 57; length <= 62; length++) {
    const target = generateTarget(asNode(element('td', { attributes: { 'data-test': 'C:\\'.repeat(20) }, fiber: owners('D'.repeat(length)) })));
    assert.match(target?.slice(length) ?? '', /^ \(td\[data-test="(C|:|\\\\)+\)$/, target);
  }
  // An emoji is two UTF-16 code units, and a cut between them would leave half of one, which UTF-8
  // cannot carry: a beacon would send a replacement character in its place.
  for (let length = 57; length <= 62; length++) {
    const target = generateTarget(asNode(element('button', { id: '\u{1F600}'.repeat(30), fiber: owners('B'.repeat(length)) })));
    assert.match(target?.slice(length) ?? '', /^ \(button#\u{1F600}+\)$/u, target);
  }
});

// Event Timing entries of one slow click, as the observer hands them over: a click at 100 ms that
// took 240 ms, its handlers running from 104 to 330.
const CLICK = [{ name: 'click', interactionId: 7, startTime: 100, duration: 240, processingStart: 104, processingEnd: 330, target: null }];

function commit(opts: Partial<CommitSummary> = {}): CommitSummary {
  return {
    at: 320,
    sinceInput: 220,
    inputTs: 100,
    gestureTs: 100,
    inputType: 'click',
    rendered: 801,
    hydrated: false,
    truncated: false,
    roots: ['OrderSummary'],
    hotPath: ['OrderSummary', 'LineItem'],
    components: Array.from({ length: 8 }, (_, i) => ({ name: `Part${i}`, count: 100 - i, self: 20 - i, total: 20 - i })),
    hasDurations: true,
    coarseClock: false,
    total: 180,
    startedAt: null,
    effectsStartedAt: null,
    effectsEndedAt: null,
    walkMs: 0,
    priority: 1,
    didError: false,
    ...opts,
  };
}

const reportOf = (...args: Parameters<typeof buildReport>): InteractionReport => sealReport(buildReport(...args));

/** Puts `reports` behind the page's installation for the length of one test, as install() would. */
function installed(reports: InteractionReport[]): () => void {
  page.installed = { api: { ...inertApi('none'), reports: () => reports }, reapply: () => {} };
  return () => {
    page.installed = null;
  };
}

/** The metric web-vitals' attribution build hands a callback, in the fields this entry reads. */
const metricWithAttribution = { entries: CLICK, attribution: { interactionTarget: 'OrderSummary > LineItem (button.primary)', inputDelay: 4, processingDuration: 226, presentationDelay: 10 } };

test('the attribution keeps every field web-vitals measured and adds one of its own', (t) => {
  const report = reportOf(CLICK, [commit()], []);
  t.after(installed([report]));

  const attribution = attributeINP(metricWithAttribution);
  assert.equal(attribution.interactionTarget, 'OrderSummary > LineItem (button.primary)');
  assert.equal(attribution.processingDuration, 226);
  assert.equal(attribution.react?.interactionId, 7);
  assert.equal(attribution.react?.schemaVersion, 3);
  assert.deepEqual(attribution.react?.hotPath, ['OrderSummary', 'LineItem']);
  assert.deepEqual(attribution.react?.blame, report.explanation.blame);
  assert.equal(attribution.react?.blame.confidence, 'measured');
  // The heaviest commit's components, capped; the whole list stays on the report.
  assert.deepEqual(
    attribution.react?.components.map((c) => c.name),
    ['Part0', 'Part1', 'Part2', 'Part3', 'Part4'],
  );
  assert.deepEqual(attribution.react?.commits, { count: 1, rendered: 801, ms: 180 });
  assert.deepEqual(attribution.react?.followUps, { count: 0, rendered: 0, ms: null });
});

test('a metric from the build without attribution, as Next.js reports it, still gets the React side', (t) => {
  t.after(installed([reportOf(CLICK, [commit()], [])]));
  // useReportWebVitals imports the non-attribution build, so `attribution` is undefined there.
  const attribution = attributeINP({ entries: CLICK });
  assert.deepEqual(Object.keys(attribution), ['react']);
  assert.equal(attribution.react?.hotPath[0], 'OrderSummary');
});

test('what a caller forwards to analytics is frozen, like the report behind it', (t) => {
  t.after(installed([reportOf(CLICK, [commit()], [])]));
  const { react } = attributeINP(metricWithAttribution);
  assert.ok(react);
  assert.equal(Object.isFrozen(react), true);
  assert.equal(Object.isFrozen(react.components), true);
  assert.equal(Object.isFrozen(react.commits), true);
});

test('a production build measures no render, so the summary says so rather than reporting 0 ms', (t) => {
  t.after(installed([reportOf(CLICK, [commit({ hasDurations: false, total: 0 })], [])]));
  const { react } = attributeINP(metricWithAttribution);
  assert.equal(react?.commits.ms, null);
  assert.equal(react?.commits.rendered, 801);
  assert.equal(react?.blame.confidence, 'inferred');
});

test('the join is on the interactionId, which names one report among several', (t) => {
  const other = [{ name: 'keydown', interactionId: 21, startTime: 900, duration: 56, processingStart: 902, processingEnd: 940, target: null }];
  t.after(installed([reportOf(other, [commit({ at: 930, inputTs: 900, hotPath: ['SearchBox'] })], []), reportOf(CLICK, [commit()], [])]));

  assert.equal(attributeINP({ entries: other }).react?.interactionId, 21);
  assert.equal(attributeINP({ entries: CLICK }).react?.interactionId, 7);
  // web-vitals keeps no entry without an id, so an entry without one matches nothing rather than guessing.
  assert.equal(attributeINP({ entries: [{}] }).react, null);
});

test('react is null rather than a guess: nothing installed, and no report for that interaction', (t) => {
  assert.equal(page.installed, null);
  assert.equal(attributeINP(metricWithAttribution).react, null);

  // An interaction the page kept no report for: under the reporting threshold, or pushed out of the 50 kept.
  t.after(installed([reportOf(CLICK, [commit()], [])]));
  assert.equal(attributeINP({ entries: [{ interactionId: 4242 }] }).react, null);
});

test('a metric this library cannot read gives react null rather than throwing in the page callback', (t) => {
  t.after(installed([reportOf(CLICK, [commit()], [])]));
  const broken = (metric: unknown) => attributeINP(metric as Parameters<typeof attributeINP>[0]);

  // Fields this entry reads, missing or of the wrong shape.
  assert.equal(broken({}).react, null);
  assert.equal(broken({ entries: null }).react, null);
  assert.equal(broken({ entries: 'click' }).react, null);
  assert.equal(broken({ entries: [null, undefined] }).react, null);
  assert.equal(broken(null).react, null);

  // A metric whose getters throw: the attribution it did give up is kept, and react is null.
  const hostile = { attribution: { inputDelay: 4 } };
  Object.defineProperty(hostile, 'entries', {
    get() {
      throw new Error('entries read from a detached observer');
    },
  });
  const result = broken(hostile) as { inputDelay?: number; react: unknown };
  assert.equal(result.react, null);
  assert.equal(result.inputDelay, 4);
});
