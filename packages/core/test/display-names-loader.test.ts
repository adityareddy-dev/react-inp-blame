import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const loader = createRequire(import.meta.url)('../display-names-loader.cjs') as {
  stamp(code: string): string;
  [key: symbol]: (code: string) => string;
};
const { stamp } = loader;
/** The pass the Vite plugin runs before any other plugin, which the loader keeps under a symbol rather than a name. */
const hoistDefaultExport = loader[Symbol.for('react-inp-blame.hoistDefaultExport')]!;

/**
 * The components the loader names in a module, read off the lines `stamp` adds after it, in their order.
 * Each case is a whole module, because what the loader will and will not name depends on the lines around it.
 */
const names = (code: string): string[] => Array.from(stamp(code).slice(code.length).matchAll(/\.displayName = ("[^"]*")/g), (m) => JSON.parse(m[1] ?? ''));

test('a function declaration is named, in each of the forms a module can write one', () => {
  for (const code of ['function Cart() {}', 'export function Cart() {}', 'export default function Cart() {}', 'function Cart<T>(props: T) {}']) {
    assert.deepEqual(names(code), ['Cart'], code);
  }
});

test('an arrow or function expression bound to a capitalised const is named, which is how most components are written', () => {
  const written = [
    'const Cart = (props) => null;',
    'const Cart = props => null;',
    'const Cart = async (props) => null;',
    'export const Cart = ({ items }) => null;',
    'const Cart: React.FC<Props> = (props) => null;',
    'const Cart: React.FC = () => null;',
    'const Cart = (props: Props): JSX.Element => null;',
    'const Cart = <T,>(props: T) => null;',
    'const Cart = function (props) { return null; };',
    'const Cart = function Cart(props) { return null; };',
    'const Cart: (p: Props) => JSX.Element = (p) => null;',
  ];
  for (const code of written) assert.deepEqual(names(code), ['Cart'], code);
});

test('a memo or forwardRef wrapper is named whatever it wraps, including the generic TypeScript forms', () => {
  const wrapped = [
    'const Cart = memo(function Cart() {});',
    'export const Cart = React.memo((props) => null);',
    'const Cart = forwardRef((props, ref) => null);',
    'const Cart = forwardRef<HTMLDivElement, Props>((props, ref) => null);',
    'const Cart = memo<Props>(function Cart() {});',
    'const Cart = memo(forwardRef((props, ref) => null));',
    'const Cart = /* @__PURE__ */ forwardRef((props, ref) => null);',
  ];
  for (const code of wrapped) assert.deepEqual(names(code), ['Cart'], code);
});

test('what it leaves alone: a lowercase name, anything indented, a value that is not a function, and a wrapper it does not know', () => {
  const missed = [
    'function formatPrice() {}',
    '  function Nested() {}',
    '  const Nested = () => null;',
    'const MAX_ROWS = 50;',
    'const Cart = observer(Row);',
    'const Cart = styled.div`color: red`;',
    'export default memo(function Row() {});',
    'export default () => null;',
    'class Cart extends Component {}',
    'let Cart = () => null;',
    'var Cart = () => null;',
  ];
  for (const code of missed) assert.deepEqual(names(code), [], code);
});

test('a name that is written to again, declared twice, or already given a displayName is left alone', () => {
  assert.deepEqual(names('const Cart = () => null;\nCart = null;'), []);
  assert.deepEqual(names('function Cart() {}\nCart = wrap(Cart);'), []);
  assert.deepEqual(names('const Cart = () => null;\nCart.displayName = "Shopping cart";'), []);
  assert.deepEqual(names('const Cart = () => null;\nexport const Cart = () => null;'), []);
  // A property of the same name on something else is not the component being renamed.
  assert.deepEqual(names('const Cart = () => null;\nconfig.Cart.displayName = "x";'), ['Cart']);
});

test('a declaration written inside a string, a template, a comment or a regular expression is not a declaration', () => {
  const quoted = [
    'const example = "const Cart = () => null";\nconst Row = () => null;',
    'const example = `\nconst Cart = () => null;\n`;\nconst Row = () => null;',
    '// const Cart = () => null;\nconst Row = () => null;',
    '/*\nconst Cart = () => null;\n*/\nconst Row = () => null;',
    'const pattern = /const Cart = \\(\\) =>/;\nconst Row = () => null;',
  ];
  for (const code of quoted) assert.deepEqual(names(code), ['Row'], code);
});

test('JSX is read as JSX: a self-closing tag and a closing tag do not open a regular expression', () => {
  // `<br />`, `</div>` and `<Icon/>` all put a slash where an expression could start. Read as a regular
  // expression, the first would swallow the rest of the file and nothing after it would be named.
  const code = 'const Icon = () => <svg><path d="M 1 1" /></svg>;\nconst Row = () => (\n  <div>\n    <Icon />\n    <br/>\n  </div>\n);\nconst Cart = () => null;';
  assert.deepEqual(names(code), ['Icon', 'Row', 'Cart']);
});

test('a JSX attribute that spans lines, and an apostrophe in JSX text, do not blank out the rest of the file', () => {
  const code = 'const Icon = () => (\n  <svg>\n    <path\n      d="M 145 75\n         L 10 20"\n    />\n  </svg>\n);\nconst Note = () => <p>that isn\'t a string</p>;\nconst Cart = () => null;';
  assert.deepEqual(names(code), ['Icon', 'Note', 'Cart']);
});

test('the stamps go after the module, one per component, in the form the value calls for', () => {
  // A function is checked with an expression, which Rollup can drop along with a component nobody
  // imported. A memo or forwardRef value is an object, so `typeof` proves nothing about it and the
  // check has to be a try; Rollup keeps those either way, because it cannot drop the wrapper call.
  const code = 'export function Cart() {}\nconst Row = (props) => null;\nconst Badge = memo(() => null);\n';
  assert.equal(
    stamp(code),
    `${code}
typeof Cart === "function" && Object.isExtensible(Cart) && !Object.getOwnPropertyDescriptor(Cart, "displayName") && (Cart.displayName = "Cart");
typeof Row === "function" && Object.isExtensible(Row) && !Object.getOwnPropertyDescriptor(Row, "displayName") && (Row.displayName = "Row");
try { if (Badge.displayName == null) Badge.displayName = "Badge"; } catch (e) {}`,
  );
  assert.equal(stamp('export const price = 1;'), 'export const price = 1;');
});

test('a module whose first statement is "use server" is left alone, and a "use client" one is not', () => {
  const server = '"use server";\nexport const Save = async (data) => data;\nexport async function Load() {}\n';
  assert.deepEqual(names(server), []);
  assert.equal(stamp(server), server);
  assert.deepEqual(names("'use server';\nexport const Save = async (data) => data;\n"), []);
  assert.deepEqual(names('// a note\n"use server";\nexport const Save = async (data) => data;\n'), []);
  assert.deepEqual(names('"use client";\nexport const Cart = () => null;\n'), ['Cart']);
});

test('a called function expression is not a component, whatever it returned', () => {
  // `function () {…}()` and `.call(…)` and `.bind(…)` all bind the result, not the function that was
  // written, and the result may be a number, null, or an object somebody froze.
  for (const code of [
    'const Version = function () { return 5; }();',
    'const Session = function () { return null; }.call(null);',
    'const Theme = function () { return {}; }.bind(null);',
    'const First = function () { return [() => null]; }()[0];',
  ]) {
    assert.deepEqual(names(code), [], code);
  }
  // The shapes that do end there are still named, including the TypeScript ones.
  assert.deepEqual(names('const Cart = function () { return null; };'), ['Cart']);
  assert.deepEqual(names('const Cart = function (): JSX.Element { return null; }'), ['Cart']);
  assert.deepEqual(names('const Cart = function () { return null; }, price = 1;'), ['Cart']);
});

test('a regular expression after an if, and a backtick in JSX text, do not move the rest of the file into a string', () => {
  // `if (s) /}/` puts a brace in a pattern: read as division, that brace closes a block and everything
  // below it looks like the top level. A backtick in prose pairs with the next one in the file, which
  // is usually a real template's opening one, and then the template's contents look like code.
  assert.deepEqual(names('function outer(s) {\n  if (s) /}/.test(s);\nfunction Inner() {}\n  return Inner;\n}\nconst Row = () => null;'), ['Row']);
  assert.deepEqual(names('const Hint = () => <p>Press `Esc` to close</p>;\nconst sample = `\nfunction Example() {}\n`;'), ['Hint']);
  assert.deepEqual(names('const Hint = () => <kbd>`</kbd>;\nconst sample = `\nconst Example = () => 1;\n`;'), ['Hint']);
  // A tagged template is still a template: its contents stay masked.
  assert.deepEqual(names('const style = css`\nfunction Example() {}\n`;\nconst Row = () => null;'), ['Row']);
  assert.deepEqual(names('const Panel = styled.div`\nfunction Example() {}\n`;\nconst Row = () => null;'), ['Row']);
});

test('a named function expression written at column 0 inside a call or an array is not a declaration', () => {
  // Nothing declares it, so the module's last line cannot reach the name at all.
  assert.deepEqual(names('export default memo(\nfunction Inner() { return null; }\n);'), []);
  assert.deepEqual(names('const list = [\nfunction First() {},\nfunction Second() {},\n];'), []);
  assert.deepEqual(names('const Row = () => null;\nregister(\nfunction Inner() {}\n);'), ['Row']);
});

test('a name written to by a logical assignment or a destructuring pattern is left alone', () => {
  assert.deepEqual(names('function Cart() {}\nCart &&= null;'), []);
  assert.deepEqual(names('function Cart() {}\nCart ??= null;'), []);
  assert.deepEqual(names('function Cart() {}\n[Cart] = [null];'), []);
  assert.deepEqual(names('function Cart() {}\n({ Cart } = { Cart: null });'), []);
  // Comparisons are not writes.
  assert.deepEqual(names('const Cart = () => null;\nif (Cart === other) {}\nif (Cart !== other) {}'), ['Cart']);
});

test('a stamped module loads whatever the binding turned out to hold, and the components still get their names', async () => {
  // The rules above read text rather than a syntax tree, so sooner or later they will name something
  // that is not what they took it for. A module is strict: a store that fails takes the page down at
  // load. Every one of these is a shape that did exactly that before the guards went in.
  type Loaded = Record<string, { displayName?: string } | undefined>;
  const cases: Array<{ label: string; body: string; named?: false; check?: (module: Loaded) => void }> = [
    { label: 'a function expression that returns a number', body: 'export const Version = function () { return 5; }();' },
    { label: 'a function expression that returns null', body: 'export const Session = function () { return null; }();' },
    { label: 'a component frozen through a helper', body: 'const deepFreeze = (o) => Object.freeze(o);\nexport function Icons() {}\ndeepFreeze(Icons);' },
    {
      label: 'a displayName defined as read-only',
      body: 'export function Badge() {}\nObject.defineProperties(Badge, { displayName: { value: "Custom" } });',
      check: (m) => assert.equal(m.Badge?.displayName, 'Custom'),
    },
    {
      label: "a memo of the module's own that returns nothing",
      body: 'function memo(fn) { return undefined; }\nexport const Total = memo(() => 5);',
      check: (m) => assert.equal(m.Total, undefined),
    },
    { label: "a memo of the module's own that returns a frozen object", body: 'const memo = (fn) => Object.freeze({ fn });\nexport const Total = memo(() => 5);' },
    { label: 'a component set to null after it is declared', body: 'export function Cart() {}\nCart &&= null;' },
    { label: 'a name the scan read wrong, which no binding answers to', body: 'function done() {}\n`\nfunction Example() { return 1; }\n`;' },
    {
      label: 'a name the module set for itself',
      body: 'export const Badge = () => null;\nObject.assign(Badge, { displayName: "Custom" });',
      check: (m) => assert.equal(m.Badge?.displayName, 'Custom'),
    },
    // Nothing in a "use server" module is stamped at all, so the component after it keeps no name.
    { label: 'a "use server" module', body: '"use server";\nexport const Save = async (data) => data;', named: false },
  ];
  const dir = mkdtempSync(join(tmpdir(), 'inp-display-names-'));
  try {
    for (const [index, { label, body, named, check }] of cases.entries()) {
      // Every module declares the same plain component, so each case also proves that a value the
      // stamp had to step over did not stop the name after it from being set.
      const source = `${body}\nexport const Row = (props) => null;\n`;
      const file = join(dir, `${index}.mjs`);
      writeFileSync(file, stamp(source));
      const loaded = (await import(pathToFileURL(file).href)) as Loaded;
      assert.equal(loaded.Row?.displayName, named === false ? undefined : 'Row', label);
      check?.(loaded);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a declaration at column 0 inside a block, a class or a namespace is not the top level', () => {
  // The module's last line reaches the module's bindings. A name written at column 0 inside braces is
  // not one of them, and stamping it either throws or renames something else entirely.
  assert.deepEqual(names('function outer() {\nfunction Inner() {}\n}\nconst Row = () => null;'), ['Row']);
  assert.deepEqual(names('class Panel {\nRender() {}\n}\nconst Row = () => null;'), ['Row']);
  assert.deepEqual(names('namespace ui {\nconst Inner = () => null;\n}\nconst Row = () => null;'), ['Row']);
  // A brace inside a string or a comment does not open a block: the depth is read from the masked copy.
  assert.deepEqual(names('const open = "{";\nconst Row = () => null;'), ['Row']);
});

test('a name the module imports is never stamped, whatever the file declares further down', () => {
  // The stamp would land on the imported component, naming another module's work after this one's.
  assert.deepEqual(names("import { Row } from './row';\nfunction outer() {\nfunction Row() {}\n}"), []);
  assert.deepEqual(names("import Row from './row';\nconst Card = () => null;"), ['Card']);
  assert.deepEqual(names("import { Row as Card } from './row';\nfunction outer() {\nconst Card = () => null;\n}"), []);
});

test('the name before an `as` in an import is not bound here, so a component of that name is still named', () => {
  // How every shadcn component is written: the primitive is imported under another name, and the
  // file declares its own component under the primitive's.
  assert.deepEqual(names('import { Button as ButtonPrimitive } from "x"\nfunction Button(){}\nexport { Button }'), ['Button']);
  const shadcn = [
    "import * as DialogPrimitive from '@radix-ui/react-dialog';\nfunction Dialog(props) { return null; }",
    "import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';\nfunction Dialog(props) { return null; }",
    "import Menu, { DropdownMenu as DropdownMenuPrimitive } from 'x';\nconst DropdownMenu = (props) => null;",
    "import type { Dialog as DialogProps } from 'x';\nfunction Dialog(props) { return null; }",
    "import { type Dialog as DialogProps, useState } from 'x';\nfunction Dialog(props) { return null; }",
    "import {\n  Dialog as DialogPrimitive,\n  Title as TitlePrimitive,\n} from 'x';\nfunction Dialog(props) { return null; }",
    // An `export … from` binds nothing in this module.
    "export { Dialog as DialogRoot } from 'x';\nfunction Dialog(props) { return null; }",
    "export * as Dialog from 'x';\nexport function DialogTitle(props) { return null; }",
  ];
  for (const code of shadcn) assert.deepEqual(names(code), [code.includes('DropdownMenu =') ? 'DropdownMenu' : code.includes('DialogTitle') ? 'DialogTitle' : 'Dialog'], code);
  // The local side of each form is still an import, and a declaration of it inside a block is left alone.
  for (const clause of ['{ Row as Card }', '* as Card', 'Card', 'Row, { Card }', 'Row, * as Card', 'type { Row as Card }', '{ type Row as Card }']) {
    const code = `import ${clause} from './row';\nfunction outer() {\nfunction Card() {}\n}`;
    assert.deepEqual(names(code), [], code);
  }
  // A nested declaration is left alone for being nested, whatever the imports say. The check on imports
  // is what holds when the scan misreads a brace and takes a declaration for a top-level one, so the
  // cases that pin it declare the imported name at the top level, as the scan would see it after one.
  const clauses = [
    '{ Row as Card }',
    '* as Card',
    'Card',
    'Row, { Card }',
    'Row, * as Card',
    'Card, * as ns',
    'x, { y as Card }',
    'type Card',
    'type * as Card',
    'type { Row as Card }',
    '{ type Row as Card }',
    '{ default as Card }',
    '{ Row /* the base */ as Card }',
    '{\n  Row as Card, // the base\n  Slot,\n}',
    '{\r\n  Row as Card,\r\n}',
    // Names that are strings, which an import may give since ES2022.
    `{ 'row-card' as Card }`,
    '{ "Row" as Card, Slot }',
  ];
  for (const clause of clauses) {
    const code = `import ${clause} from './row';\nfunction Card() {}`;
    assert.deepEqual(names(code), [], code);
  }
  assert.deepEqual(names("import{Row as Card}from'./row';\nfunction Card() {}"), []);
  // The other module's side of each of them is free, comments and line breaks and all.
  for (const clause of ['{ Card /* the base */ as Row }', '{ Card as /* the base */ Row }', '{\n  Card as Row, // the base\n}', '{Card as Row}', `{ Card as Row, 'row-card' as Slot }`, 'x, { Card as Row }', 'type { Card as Row }']) {
    const code = `import ${clause} from './row';\nfunction Card() {}`;
    assert.deepEqual(names(code), ['Card'], code);
  }
  // A module with no names to import binds nothing, and the one after it is still read.
  assert.deepEqual(names("import './styles.css'\nimport { Row as Card } from './row'\nfunction Card() {}\nfunction Row() {}"), ['Row']);
  // And the Vite pass reads the same bindings: a default export named like an aliased import is hoisted.
  const code = "import { Button as ButtonPrimitive } from 'x';\nexport default function Button() {}";
  assert.equal(hoistDefaultExport(code), "import { Button as ButtonPrimitive } from 'x';\nfunction                Button() {}\nexport default Button;");
});

test('a byte order mark does not hide the first declaration in the file', () => {
  assert.deepEqual(names('﻿const Cart = () => null;'), ['Cart']);
  assert.deepEqual(names('﻿function Cart() {}\nconst Row = () => null;'), ['Cart', 'Row']);
});

test('the scan is linear: a file of one long identifier and a file of thousands of components both stay well inside a build', () => {
  // Both of these used to be quadratic: reading an identifier back from every character, and one
  // regular expression pass per name found. A 1 MB identifier never finished at all. The budget is
  // loose on purpose, since a shared CI machine is slower than any developer's.
  const budget = (label: string, code: string, ms: number) => {
    const started = performance.now();
    stamp(code);
    const took = performance.now() - started;
    assert.ok(took < ms, `${label} took ${Math.round(took)} ms, over the ${ms} ms budget`);
  };
  budget('1 MB of word characters', `const x = ${'a'.repeat(1e6)};`, 2000);
  let many = '';
  for (let i = 0; i < 5000; i++) many += `export const Icon${i} = (props: P) => <svg {...props}><path d="M0 0h24v24H0z" /></svg>;\n`;
  budget('5,000 components in one file', many, 2000);
  assert.equal(names(many).length, 5000);
});

test("a component's `export default function` becomes a declaration exported by name, its name where it was", () => {
  const code = "import { useState } from 'react';\n\nexport default function Home() {\n  return <main />;\n}\n";
  const hoisted = hoistDefaultExport(code);
  assert.equal(hoisted, "import { useState } from 'react';\n\nfunction                Home() {\n  return <main />;\n}\n\nexport default Home;");
  // Same lines, and each character from the name on in the same column: the source map the plugin leaves
  // alone stays true.
  assert.equal(hoisted.indexOf('Home()'), code.indexOf('Home()'));
  assert.equal(hoisted.slice(hoisted.indexOf('Home()'), code.length), code.slice(code.indexOf('Home()')));
  // `stamp` names it, and so it does once a wrapping plugin has made the export `withComponentProps(Home)`,
  // where a wrapped function expression has no binding left to name.
  assert.deepEqual(names(hoisted), ['Home']);
  assert.deepEqual(names(hoisted.replace('export default Home;', 'export default withComponentProps(Home);')), ['Home']);
  assert.deepEqual(names(code.replace('export default function Home', 'export default withComponentProps(function Home').replace(/\}\n$/, '});\n')), []);

  // The generic form, line breaks among the words taken out, and a byte order mark in front.
  assert.equal(hoistDefaultExport('export default function List<T>(props: T) {}'), 'function                List<T>(props: T) {}\nexport default List;');
  assert.equal(hoistDefaultExport('export default\nfunction Home() {}'), '\nfunction Home() {}\nexport default Home;');
  assert.equal(hoistDefaultExport('export default\r\nfunction Home() {}'), '\r\nfunction Home() {}\nexport default Home;');
  assert.equal(hoistDefaultExport('export default function\nHome() {}'), '\nfunction Home() {}\nexport default Home;');
  assert.equal(hoistDefaultExport('\uFEFFexport default function Home() {}'), '\uFEFFfunction                Home() {}\nexport default Home;');
});

test('a default export `stamp` would not name is left as written', () => {
  const kept = [
    'export default function home() {}',
    'export function Home() {}',
    'export default () => null;',
    'export default memo(function Home() {});',
    'export default async function Home() {}',
    'export default class Home extends Component {}',
    // Assigned to elsewhere, declared twice (an overload), or named already.
    'export default function Home() {}\nHome = wrap(Home);',
    'export default function Home(a: string): void;\nexport default function Home(a) {}',
    'export default function Home() {}\nHome.displayName = "Start";',
    // Not at the top level, not code, or in a module of endpoints.
    'declare module "x" {\nexport default function Home(): void;\n}',
    'const sample = `\nexport default function Home() {}\n`;',
    '// export default function Home() {}',
    '"use server";\nexport default function Home() {}',
  ];
  for (const code of kept) assert.equal(hoistDefaultExport(code), code, code);
});
