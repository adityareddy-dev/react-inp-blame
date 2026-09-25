// Webpack-style loader that stamps `displayName` on React components so their names survive
// minification. Minifiers rename identifiers but never string literals, so appending
// `Foo.displayName = "Foo"` keeps the name in a production build. Works under Turbopack
// (next.config `turbopack.rules`) and webpack (`module.rules`); it needs nothing beyond the
// source string, so no bundler-specific API is touched.
//
// It runs on the untranspiled .tsx/.jsx source, ahead of the TypeScript/JSX transform, and reads it
// as text: no parser, no dependency, no source map to keep in step. What that costs is breadth, so
// the rules below are deliberately narrow, and `mask()` is what makes them safe to apply.
//
// What it names, all at the top level of the module and all capitalised:
//
//   function Foo(…)                       export function Foo(…)      export default function Foo(…)
//   function Foo<T>(…)
//   const Foo = (props) => …              const Foo = function (…) {…}
//   const Foo: React.FC<Props> = (…) => … const Foo = <T,>(…) => …
//   const Foo = memo(…)                   const Foo = forwardRef(…)   const Foo = memo(forwardRef(…))
//   export const Foo = any of those
//
// What it still does not name, and why. Each is a shape where the name is not plainly a component's,
// or where finding it would need the scope information only a parser has:
//
//   export default () => …                no binding to hang a displayName on
//   export default memo(Foo)              the same
//   class Foo extends Component           a class carries its own name through minification poorly,
//                                         but `static displayName` is the shape to add, not this one
//   const Foo = observer(Bar)             any HOC that is not memo or forwardRef: `styled.div`,
//                                         `connect()(Foo)`, `observer(…)`, `withRouter(…)`
//   const Foo = function () {…}()         a called function expression, or one whose result is taken
//                                         with `.call`, `.bind` or an index: the value is not the
//                                         function that was written and may not be an object at all
//   let Foo = …, var Foo = …              a binding that can be reassigned
//   anything in a "use server" module     every export there is an endpoint, not a component
//   anything inside braces                a component declared inside a function, a block, a class
//                                         body or a namespace, even when it is written at column 0
//
// Two things keep a stamp from breaking a build, and they are in that order on purpose: a stamp must
// never be able to throw in a page that ships, and only then should it shake out of a bundle it is
// not needed in. The form itself is the first (see `stamp` at the foot of the file): it checks the
// value before it writes and it never replaces a name that is already there, so a name that this file
// read wrong is a no-op rather than a page that does not load.
//
// The rules are the second, and they are what keeps the names right. Every assignment is appended
// after the module's code, so it can never run before the declaration it names or land inside an
// export list. A name that is assigned to anywhere else in the file, or that already has a
// `displayName` of its own, is left alone, and so is one the module imports, since the binding the
// last line would reach is then another module's component. The declaration has to be at the top
// level, which is read as brace depth and not as indentation, and where a statement can begin. And
// the scan runs over `mask()`'s copy of the source, where the inside of every string, template,
// comment and regular expression has been blanked out, so no line of prose or embedded code sample
// can look like a declaration.

// `function Foo(`, with the export forms and the generic one. Column 0 only: an indented declaration
// is inside something, where the module's last line cannot reach it.
const FUNCTION = /^(?:export\s+(?:default\s+)?)?function\s+([A-Z]\w*)\s*[(<]/gm;
// The `export default` in front of such a declaration.
const DEFAULT_EXPORT = /^export\s+default\s/;
// `const Foo`, up to the name. What follows the name decides whether it is a component.
const CONST = /^(?:export\s+)?const\s+([A-Z]\w*)\s*(?=[:=])/gm;
// The wrappers whose argument is a component by definition, so what is inside them is not examined.
const WRAPPER = /^(?:React\s*\.\s*)?(?:memo|forwardRef)\s*/;
// Characters after which a `/` opens a regular expression. This is the short list rather than the
// usual "anything that is not a value", because these files are full of JSX: `<div />`, `</div>` and
// `<br/>` all put a `/` where an expression could begin, and reading one as a regular expression would
// blank out the rest of the line. The cost is that a regular expression written straight after `}` is
// read as division; the gain is that no JSX tag ever is. `)` is in the list because the scan marks a
// closing bracket as `)` only when it ends an `if (…)`, a `while (…)` or a `for (…)`, where what
// follows is a statement and a `/` therefore opens a pattern: `if (s) /}/.test(s)`.
const REGEX_AFTER = /[=(,:[!&|?;+\-*%^~)]/;
// Keywords a `/` can follow, for the same decision. They end in a word character, so they are matched
// whole rather than by their last letter.
const REGEX_AFTER_WORD = ['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'do', 'else', 'instanceof', 'void', 'yield', 'await'];
// The heads whose closing bracket a statement follows, for the rule above.
const CONTROL_HEAD = ['if', 'while', 'for'];
// Characters after which a backtick opens a template literal rather than being a character of JSX text.
// The same list as for a regular expression, plus `{`, which is where a JSX attribute's value begins,
// and minus `)`, since a template straight after `if (…)` is not a shape anyone writes.
const TEMPLATE_AFTER = /[={(,:[!&|?;+\-*%^~]/;
// Characters before which a tagged template's tag can start, so that the `Ctrl` of `<p>Press `Ctrl`</p>`
// is not read as one. `.` is here for `styled.div`, `;` and `}` for a tag that opens a statement.
const VALUE_BEFORE = /[.;{}()=,:[!&|?+\-*%^~]/;
// The longest of them. An identifier longer than this cannot be one, so the scan never reads back
// further than this: without the cap, a run of word characters costs its own length at every
// character, which is what made a 1 MB file of them take longer than anyone would wait.
const LONGEST_REGEX_WORD = Math.max(...REGEX_AFTER_WORD.map((w) => w.length));

/**
 * The source with the inside of every string, template literal, comment and regular expression
 * replaced by spaces, and every other character and newline left where it was, so an offset into the
 * result is an offset into the source.
 *
 * A quote, a backtick or a `/` that never closes is read as an ordinary character rather than as the
 * start of something, and the scan carries on from the next one. That is not a nicety: a JSX attribute
 * may span lines (`d="M 145 75` and the rest of the path below it) where a JavaScript string may not,
 * and JSX text is full of apostrophes. Reading either as an open string would blank the rest of the
 * file; reading it as an ordinary character leaves a few lines of path data unmasked, and those are
 * indented, where nothing is looked for.
 */
function mask(code) {
  const out = code.split('');
  const blank = (from, to) => {
    for (let j = Math.max(0, from); j < to && j < out.length; j++) if (out[j] !== '\n') out[j] = ' ';
  };
  // The brace depth each open template literal's `${` began at, so that a `}` closing a block inside a
  // substitution is told from the one ending the substitution.
  const templates = [];
  let braces = 0;
  // For each open `(`, whether it is the head of an `if`, a `while` or a `for`.
  const parens = [];
  // The last thing before here that decides whether a `/` divides: a whole identifier, or one
  // character, or one of two made-up tokens: `=>` for an arrow, and `)` for a control statement's
  // closing bracket. An ordinary `)` is recorded as `x`, which decides nothing.
  let before = '';
  // Where the run of identifier characters around `i` began.
  let runStart = 0;
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    const next = code[i + 1];
    if (ch === '/' && next === '/') {
      const end = code.indexOf('\n', i);
      const to = end < 0 ? code.length : end;
      blank(i, to);
      i = to;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = code.indexOf('*/', i + 2);
      blank(i, end < 0 ? code.length : end + 2);
      i = end < 0 ? code.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = endOfQuoted(code, i + 1, ch);
      if (end >= 0) {
        blank(i + 1, end);
        i = end + 1;
        before = 'x';
        continue;
      }
    }
    if (
      (ch === '`' && startsTemplate(code, i, before, runStart)) ||
      (ch === '}' && templates.length && templates[templates.length - 1] === braces)
    ) {
      const resumed = ch === '}';
      const run = blankTemplate(code, blank, i + 1);
      if (run) {
        if (run.closed) {
          if (resumed) templates.pop();
        } else if (!resumed) templates.push(braces);
        i = run.at;
        // Inside `${`, what comes next begins an expression, so a nested template or a regular
        // expression there is one. After the closing backtick a value has just ended.
        before = run.closed ? 'x' : '{';
        continue;
      }
    }
    if (ch === '/' && startsRegex(code, i, before)) {
      const end = endOfRegex(code, i + 1);
      if (end >= 0) {
        blank(i + 1, end);
        i = end + 1;
        before = 'x';
        continue;
      }
    }
    if (ch === '{') braces++;
    else if (ch === '}') braces = Math.max(0, braces - 1);
    // The identifier ending here, so that `return` is told from the `n` of `item n`. Its start is
    // carried along rather than looked for, and only the last few characters of a long one are read.
    if (isRunChar(code.charCodeAt(i))) {
      if (i === 0 || !isRunChar(code.charCodeAt(i - 1))) runStart = i;
    }
    if (!isSpace(ch)) {
      if (ch === '(') {
        parens.push(CONTROL_HEAD.includes(before));
        before = ch;
      } else if (ch === ')') {
        before = parens.pop() === true ? ')' : 'x';
      } else if (ch === '>' && code[i - 1] === '=') {
        before = '=>';
      } else {
        const ident = isWordChar(code.charCodeAt(i)) && i - runStart < LONGEST_REGEX_WORD;
        before = ident ? code.slice(runStart, i + 1) : ch;
      }
    }
    i++;
  }
  return out.join('');
}

// `[A-Za-z0-9_]`, and the same plus `$` for what an identifier may continue with. By code rather than
// by regular expression: this runs at every character of the file.
const isWordChar = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isRunChar = (c) => isWordChar(c) || c === 36;

/** The index of the closing quote of a string opened before `from`, or -1 when the line or the file ends first. */
function endOfQuoted(code, from, quote) {
  for (let i = from; i < code.length; i++) {
    const ch = code[i];
    if (ch === '\\') i++;
    else if (ch === quote) return i;
    else if (ch === '\n') return -1;
  }
  return -1;
}

/**
 * Blanks a template literal's text from `from` to its closing backtick or to the `${` of its next
 * substitution. `at` is where scanning carries on: past the backtick, or past the `{` of the
 * substitution, whose contents are code. Null when the file ends first.
 */
function blankTemplate(code, blank, from) {
  for (let i = from; i < code.length; i++) {
    const ch = code[i];
    if (ch === '\\') i++;
    else if (ch === '`') {
      blank(from, i);
      return { at: i + 1, closed: true };
    } else if (ch === '$' && code[i + 1] === '{') {
      blank(from, i);
      return { at: i + 2, closed: false };
    }
  }
  return null;
}

/** The index of the `/` closing a regular expression opened before `from`, or -1. */
function endOfRegex(code, from) {
  let inClass = false;
  for (let i = from; i < code.length; i++) {
    const ch = code[i];
    if (ch === '\\') i++;
    else if (ch === '\n') return -1;
    else if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) return i;
  }
  return -1;
}

/** Whether the `/` at `i` opens a regular expression rather than dividing or closing a JSX tag. */
function startsRegex(code, i, before) {
  // `/>` ends a JSX element far more often than it is a regular expression matching a greater-than sign.
  if (code[i + 1] === '>') return false;
  if (!before) return true;
  if (before === '=>') return true;
  return REGEX_AFTER_WORD.includes(before) || REGEX_AFTER.test(before.slice(-1));
}

/**
 * Whether the backtick at `i` opens a template literal rather than being one character of JSX text.
 * `runStart` is where the run of identifier characters ending at `i - 1` began, if there is one.
 *
 * The difference matters more than it looks. A backtick in prose is common (`<p>Press `Esc`</p>`), and
 * one read as a template pairs with the next backtick in the file, which is usually the opening one of
 * a real template: everything between them is blanked, and the real template's contents, which may be
 * a code sample with declarations at column 0, are left looking like code. So a backtick opens a
 * template only where a value can begin, and a tagged template is allowed only when its tag itself
 * begins a value: the `Esc` above is preceded by a backtick, which nothing can follow.
 */
function startsTemplate(code, i, before, runStart) {
  if (!before) return true;
  if (before === '=>') return true;
  const prev = code[i - 1];
  if (prev !== undefined && !isSpace(prev)) {
    // ``tag`…`` and ``foo()`…`` and ``list[0]`…``.
    if (prev === ')' || prev === ']') return true;
    if (isRunChar(code.charCodeAt(i - 1))) return canPrecedeValue(tokenBefore(code, runStart));
  }
  return REGEX_AFTER_WORD.includes(before) || TEMPLATE_AFTER.test(before.slice(-1));
}

/** The token before `i`, as a whole identifier or a single character, for the rule above. */
function tokenBefore(code, i) {
  let j = i - 1;
  while (j >= 0 && isSpace(code[j])) j--;
  if (j < 0) return '';
  if (!isRunChar(code.charCodeAt(j))) return code[j];
  // Only the last few characters of an identifier are read, for the reason `mask` reads at most that
  // many: one longer than the longest keyword cannot be one, and reading it whole costs its length.
  const floor = Math.max(0, j - LONGEST_REGEX_WORD);
  let start = j;
  while (start > floor && isRunChar(code.charCodeAt(start - 1))) start--;
  return start > floor || start === 0 ? code.slice(start, j + 1) : code[j];
}

/** Whether a value can begin after `token`. */
function canPrecedeValue(token) {
  return !token || REGEX_AFTER_WORD.includes(token) || VALUE_BEFORE.test(token.slice(-1));
}

const isSpace = (ch) => ch !== undefined && /\s/.test(ch);

/** The first index at or after `i` that is not whitespace. */
function skipSpace(code, i) {
  let j = i;
  while (isSpace(code[j])) j++;
  return j;
}

// How far a parameter list, a type annotation or a generic argument list is read before the shape is
// given up on. A bracket that never closes would otherwise be read to the end of the file, once per
// declaration: 3,000 of them in a 255 KB file cost six seconds. Giving up means the binding is not
// stamped, which is the safe answer, and no real annotation comes close to this.
const MAX_BRACKET_SPAN = 4096;

/**
 * The index just past a run of balanced brackets starting at `i`, which must be on the opener, or -1.
 * `<` and `>` are balanced too, which is true inside a type annotation and inside a generic parameter
 * list, the only places this is asked.
 */
function skipBalanced(code, i) {
  const pairs = { '(': ')', '[': ']', '{': '}' };
  // `<` is a bracket only where the run starts on one, which is a type argument list. Anywhere else a
  // `<` is a comparison or the start of JSX more often than it is a generic.
  if (code[i] === '<') pairs['<'] = '>';
  if (!pairs[code[i]]) return -1;
  const stack = [];
  const limit = Math.min(code.length, i + MAX_BRACKET_SPAN);
  for (let j = i; j < limit; j++) {
    const ch = code[j];
    if (pairs[ch]) stack.push(pairs[ch]);
    else if (ch === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) return j + 1;
    } else if (ch === ')' || ch === ']' || ch === '}') return -1;
  }
  return -1;
}

/** The index of the `=` that opens the initialiser of a `const Foo: Type = …`, starting at the `:`, or -1. */
function skipTypeAnnotation(code, i) {
  let j = i + 1;
  const limit = Math.min(code.length, i + MAX_BRACKET_SPAN);
  while (j < limit) {
    const ch = code[j];
    // `=>` and `==` inside the annotation are a function type and a comparison, not the initialiser.
    if (ch === '=') {
      if (code[j + 1] === '>' || code[j + 1] === '=') {
        j += 2;
        continue;
      }
      return j;
    }
    if (ch === ';') return -1;
    if ('([{<'.includes(ch)) {
      const past = skipBalanced(code, j);
      if (past < 0) return -1;
      j = past;
      continue;
    }
    j++;
  }
  return -1;
}

/** Whether what starts at `i` is an arrow function or a function expression, wrappers already consumed. */
function isFunctionLiteral(code, i) {
  let j = skipSpace(code, i);
  if (code.startsWith('async', j) && !/[\w$]/.test(code[j + 5] ?? '')) j = skipSpace(code, j + 5);
  if (code.startsWith('function', j) && !/[\w$]/.test(code[j + 8] ?? '')) return endsAfterBody(code, j + 8);
  // A generic arrow: `<T,>(props) => …`.
  if (code[j] === '<') {
    const past = skipBalanced(code, j);
    if (past < 0) return false;
    j = skipSpace(code, past);
  }
  if (code[j] === '(') {
    const past = skipBalanced(code, j);
    if (past < 0) return false;
    return arrowAt(code, past);
  }
  // A single parameter without brackets: `props => …`.
  const name = /^[A-Za-z_$][\w$]*/.exec(code.slice(j));
  return name ? arrowAt(code, j + name[0].length) : false;
}

/**
 * Whether the function expression whose keyword ends at `i` is the whole initialiser. A function
 * expression that is called (`function () {…}()`), or whose result is taken (`.call(null)`,
 * `.bind(this)`, `[0]`), initialises the binding with whatever that produced, which may be a number, a
 * frozen object or nothing at all. The name belongs to the function, not to that, so it is not stamped.
 */
function endsAfterBody(code, i) {
  let j = i;
  const limit = Math.min(code.length, i + MAX_BRACKET_SPAN);
  while (j < limit) {
    const ch = code[j];
    if (ch === '(' || ch === '[' || ch === '<') {
      const past = skipBalanced(code, j);
      if (past < 0) return false;
      j = past;
      continue;
    }
    if (ch === '{') {
      const past = skipBalanced(code, j);
      if (past < 0) return false;
      // `function (): { ok: boolean } { … }` puts the return type's braces first: the body is the next pair.
      if (code[skipSpace(code, past)] === '{') {
        j = skipSpace(code, past);
        continue;
      }
      return endsInitialiser(code, past);
    }
    if (ch === ';') return false;
    j++;
  }
  return false;
}

/** Whether an initialiser ends at `i`, rather than carrying on into a call, a member or a tag. */
function endsInitialiser(code, i) {
  const j = skipSpace(code, i);
  const ch = code[j];
  // The end of the statement, the bracket closing a wrapper call, or another declarator.
  if (ch === undefined || ch === ';' || ch === ',' || ch === ')') return true;
  if (ch === '(' || ch === '.' || ch === '[' || ch === '`') return false;
  if (/^(?:as|satisfies)\b/.test(code.slice(j, j + 10))) return true;
  // Anything else that is on a later line is the next statement.
  return /[\r\n]/.test(code.slice(i, j));
}

/** Whether `=>` comes next, past a return type annotation if there is one. */
function arrowAt(code, i) {
  let j = skipSpace(code, i);
  if (code[j] !== ':') return code.startsWith('=>', j);
  // A return type annotation: `(props): JSX.Element => …`. Step over it to the arrow.
  j++;
  const limit = Math.min(code.length, i + MAX_BRACKET_SPAN);
  while (j < limit) {
    if (code.startsWith('=>', j)) return true;
    if ('([{<'.includes(code[j])) {
      const past = skipBalanced(code, j);
      if (past < 0) return false;
      j = past;
      continue;
    }
    if (code[j] === ';' || code[j] === ',' || code[j] === ')') return false;
    j++;
  }
  return false;
}

/**
 * What the initialiser at `i` makes its binding: `'wrapper'` for a memo or forwardRef call, whose
 * value is an object, `'function'` for a function literal, or null. The two are stamped differently.
 */
function isComponentInitialiser(code, i) {
  let j = skipSpace(code, i);
  // memo(forwardRef(…)) and forwardRef<HTMLDivElement, Props>(…) alike; what is inside a wrapper is a
  // component by construction, so it is not examined further.
  const wrapper = WRAPPER.exec(code.slice(j));
  if (wrapper) {
    let past = j + wrapper[0].length;
    if (code[past] === '<') {
      const generics = skipBalanced(code, past);
      if (generics < 0) return null;
      past = skipSpace(code, generics);
    }
    if (code[past] === '(') return 'wrapper';
  }
  return isFunctionLiteral(code, j) ? 'function' : null;
}

/**
 * Every component the module declares at its top level that is safe to stamp, in the order they
 * appear, each with the kind of value its binding holds: `'function'` or `'wrapper'`. `code` is the
 * source; the scanning is done on a masked copy of it.
 *
 * Every test below is one pass over the file, whatever the number of names. A pass per name is what a
 * file of 10,000 components used to cost, and the cost was quadratic in the thing a generated file has
 * most of.
 */
function componentEntries(code) {
  // A byte order mark is not whitespace and not a newline, so a declaration on the first line would
  // sit behind it and `^` would never reach it. It is dropped rather than blanked, because a space
  // there would put the declaration at column 1 and `^` would miss it just the same. Offsets are into
  // this string alone, so shifting the whole file by one character changes nothing.
  const source = code.replace(/^﻿/, '');
  const masked = mask(source);
  // A "use server" module's exports are not components at all: every one of them is an endpoint, and
  // the bundler rewrites the module into a table of them. Nothing here belongs in it. "use client"
  // modules are ordinary modules and are stamped as usual. The directive is the module's first
  // statement, which is the first thing left in the masked copy, since that is where every comment
  // has been blanked; the quotes around it are still there, only its text is gone.
  const first = masked.search(/\S/);
  if (first >= 0 && USE_SERVER.test(source.slice(first))) return [];
  const depth = braceDepths(masked);
  const found = new Map();
  const add = (name, kind, defaultExport = null) => {
    const seen = found.get(name);
    found.set(name, { kind, declarations: (seen ? seen.declarations : 0) + 1, defaultExport });
  };
  // Column 0 is where a top level declaration is, but not only: a declaration inside a block, a
  // namespace or a class body can be written there too, and the module's last line cannot reach it.
  const topLevel = (m) => depth.at(m.index) === 0;
  for (const m of masked.matchAll(FUNCTION)) {
    if (!topLevel(m) || !startsStatement(masked, m.index)) continue;
    // `export default function Foo(`: where it starts and how far in the name is, for `hoistDefaultExport`.
    add(m[1], 'function', DEFAULT_EXPORT.test(m[0]) ? { at: m.index, length: m[0].lastIndexOf(m[1]) } : null);
  }
  for (const m of masked.matchAll(CONST)) {
    if (!topLevel(m)) continue;
    const after = m.index + m[0].length;
    const at = masked[skipSpace(masked, after)] === ':' ? skipTypeAnnotation(masked, skipSpace(masked, after)) : skipSpace(masked, after);
    if (at < 0 || masked[at] !== '=' || masked[at + 1] === '=' || masked[at + 1] === '>') continue;
    const kind = isComponentInitialiser(masked, at + 1);
    if (kind) add(m[1], kind);
  }
  if (!found.size) return [];
  const written = countBy(masked, ASSIGNED);
  for (const m of masked.matchAll(DESTRUCTURED)) {
    for (const id of m[1].matchAll(IDENTIFIER)) written.set(id[0], (written.get(id[0]) ?? 0) + 1);
  }
  const consts = countBy(masked, CONST_DECLARATION);
  const stamped = countBy(masked, DISPLAY_NAME);
  const imported = importedNames(masked);
  const entries = [];
  for (const [name, { kind, declarations, defaultExport }] of found) {
    // Declared twice, assigned to somewhere else, or given a displayName of its own: leave it be. The
    // count of assignments a plain declaration accounts for is one for a const and none for a function.
    if (declarations > 1) continue;
    if ((written.get(name) ?? 0) > (consts.has(name) ? 1 : 0)) continue;
    if (stamped.has(name)) continue;
    // The name the module's last line would reach is the imported one, not the declaration found
    // above, which is inside something. Stamping it would rename another module's component.
    if (imported.has(name)) continue;
    entries.push({ name, kind, defaultExport });
  }
  return entries;
}

/**
 * Whether a statement can begin at `i`. A `function Foo(…)` at column 0 is usually a declaration, but
 * it can also be a named function expression that happens to be written there, inside `memo(` or an
 * array literal, and that name is not a binding the module's last line can reach.
 */
function startsStatement(code, i) {
  let j = i - 1;
  while (j >= 0 && isSpace(code[j])) j--;
  return j < 0 || !CONTINUES_EXPRESSION.test(code[j]);
}

// Every place a name is written to: `Foo =`, `Foo += 1`, `Foo &&= null`, `Foo++`. A declaration is one
// of them. The lookbehind keeps `a.Foo = 1` out, and unlike a leading character class it does not
// swallow the character before the name, so `Foo = Bar = 1` is two writes rather than one. The `=` is
// what every compound assignment ends in; excluding `==` and `=>` keeps comparisons and arrows out.
const ASSIGNED = /(?<![.\w$])([A-Za-z_$][\w$]*)\s*(?:(?:\*\*|&&|\|\||\?\?|<<|>>>?|[-+*/%&|^])?=(?![=>])|\+\+|--)/g;
// A destructuring assignment, `[Foo] = […]` or `({ Foo } = …)`, which the pattern above cannot see
// because the name is inside brackets. Everything named in the pattern is counted as written, `a: b`
// renames and all: over-counting costs a stamp that was never needed.
const DESTRUCTURED = /[[{]([^[\]{}=]*)[\]}]\s*=(?![=>])/g;
const CONST_DECLARATION = /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\b/gm;
const DISPLAY_NAME = /(?<![.\w$])([A-Za-z_$][\w$]*)\s*\.\s*displayName/g;
// An import statement's clause, up to the module it comes from. Everything named in it is a binding
// this module did not declare, `as` and all; reading both sides of an `as` only over-collects, and an
// over-collected name costs one stamp that was never needed.
const IMPORT_CLAUSE = /^import\s+(?:type\s+)?([\w$*{},\s]+?)\s+from\s*['"]/gm;
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;
// The `"use server"` directive, matched at the module's first statement.
const USE_SERVER = /^(['"])use server\1/;
// Characters that carry an expression on, so that what follows them is not a statement: `memo(`,
// `[`, `,`, `=`, and the rest. Everything else, an identifier or `;` or `}` or the start of the file,
// can be the end of the statement before.
const CONTINUES_EXPRESSION = /[([,=:?&|+\-*/%!~<>^]/;

/** How often each name matches `re`, whose first group is the name, in one pass. */
function countBy(code, re) {
  const counts = new Map();
  re.lastIndex = 0;
  for (const m of code.matchAll(re)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  return counts;
}

/** Every name this module imports, so that a declaration elsewhere in the file is never mistaken for it. */
function importedNames(code) {
  const names = new Set();
  for (const m of code.matchAll(IMPORT_CLAUSE)) {
    for (const id of m[1].matchAll(IDENTIFIER)) if (id[0] !== 'as' && id[0] !== 'type') names.add(id[0]);
  }
  return names;
}

/**
 * The brace depth at any index, from the masked source, as the positions where it changes. Reading it
 * from the text is the only way to tell a declaration that is at column 0 and at the top level from one
 * that is at column 0 inside a block, a namespace or a class body.
 */
function braceDepths(code) {
  const at = [];
  const depths = [];
  let depth = 0;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch !== '{' && ch !== '}') continue;
    depth = ch === '{' ? depth + 1 : Math.max(0, depth - 1);
    at.push(i);
    depths.push(depth);
  }
  return {
    at(index) {
      // The depth left by the last brace before `index`: a binary search, so a file with 10,000 of
      // them costs a handful of steps per declaration rather than a scan.
      let lo = 0;
      let hi = at.length - 1;
      let found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (at[mid] < index) {
          found = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      return found < 0 ? 0 : depths[found];
    },
  };
}

/**
 * Returns the source with a displayName assignment per component appended, or the source untouched.
 * The assignments go after the module's own code so that each names a binding that already exists.
 *
 * A stamp must never be able to throw. A module is strict, so a store that fails is not ignored, it
 * takes the page down at load, and the rules above read text rather than a syntax tree: sooner or
 * later they will name something that is not what they took it for. So neither form assumes anything
 * about the value it is naming, and neither replaces a name that is already there.
 *
 * A function's value is a function, and `typeof` is safe even on a name that turns out not to exist,
 * so the guard is an expression. Rollup drops the whole expression along with the component nobody
 * imported, exactly as it dropped a bare assignment: in the seven-export icons fixture it keeps only
 * the one that is used. esbuild keeps all seven, as it did before; it does not drop a property store
 * on a module-level binding whatever it is wrapped in. terser and SWC also keep the unused ones, which
 * a bare assignment let them drop, but they only see what the bundler already decided to keep.
 *
 * A memo or forwardRef value is an object, so `typeof` proves nothing about it, and Rollup keeps those
 * under every form anyway because the wrapper call is not something it can drop. They get a try, which
 * costs nothing that was not already lost. The check inside it reads `displayName` rather than asking
 * for the property descriptor, because React defines `displayName` on a memo object in development as
 * an accessor that starts out undefined: the descriptor is there from the start, so asking for it
 * would mean never naming a memo component in a development build.
 */
function stamp(code) {
  const entries = componentEntries(code);
  if (!entries.length) return code;
  const tail = entries
    .map(({ name, kind }) => {
      const value = JSON.stringify(name);
      return kind === 'wrapper'
        ? `\ntry { if (${name}.displayName == null) ${name}.displayName = ${value}; } catch (e) {}`
        : `\ntypeof ${name} === "function" && Object.isExtensible(${name}) && !Object.getOwnPropertyDescriptor(${name}, "displayName") && (${name}.displayName = ${value});`;
    })
    .join('');
  return code + tail;
}

/**
 * The source with its `export default function Foo(…)` turned into a plain `function Foo(…)` and an
 * `export default Foo;` after the module's code, or the source untouched. Only for a component `stamp`
 * would name, so every rule above about which declarations are safe to touch holds here too.
 *
 * This is for the Vite plugin, which runs it on a module before any other plugin has seen it. Some
 * framework plugins rewrite a default export: React Router's wraps the route component in a component
 * of its own, `export default withComponentProps(function Foo() {…})`, and a function that was a
 * declaration is then an expression inside a call. No binding named `Foo` is left for `stamp`'s line to
 * reach, and the minifier drops a function expression's name that nothing reads, so the component the
 * fiber tree shows has no name at all. Declared on its own and exported by name, the function stays a
 * binding whatever wraps the export, and `stamp` names it after the JSX is compiled as it names any
 * other.
 *
 * `function` goes back to column 0, where `stamp` looks for a declaration, and the name keeps its line
 * and column: the words taken out become spaces after `function`, and the line breaks among them stay.
 * No other character moves, so a source map from before still holds, and the function is still
 * hoisted as before. What moves is when the default export's value is read: at the end of the module
 * rather than as it is declared, which only a module that imports itself in a cycle, and reads its
 * default export before its own code has run, could tell apart. A wrapping plugin already makes it an
 * expression evaluated in order.
 */
function hoistDefaultExport(code) {
  const entry = componentEntries(code).find((e) => e.defaultExport);
  if (!entry) return code;
  // componentEntries reads the source without its byte order mark.
  const at = entry.defaultExport.at + (code.charCodeAt(0) === 0xfeff ? 1 : 0);
  const end = at + entry.defaultExport.length;
  const words = code.slice(at, end);
  const breaks = words.match(/\r?\n|\r/g) ?? [];
  // How far in the name was on its own line, which the spaces after `function` make up.
  const column = words.length - Math.max(words.lastIndexOf('\n'), words.lastIndexOf('\r')) - 1;
  const declaration = `function${' '.repeat(Math.max(1, column - 'function'.length))}`;
  return `${code.slice(0, at)}${breaks.join('')}${declaration}${code.slice(end)}\nexport default ${entry.name};`;
}

function loader(source) {
  const file = (this && this.resourcePath) || '';
  if (file.includes('node_modules')) return source;
  return stamp(typeof source === 'string' ? source : String(source));
}

module.exports = loader;
module.exports.stamp = stamp;
// Not one of the loader's names, which are the loader and `stamp`: a symbol, which no import can name,
// for the Vite plugin in this package alone.
module.exports[Symbol.for('react-inp-blame.hoistDefaultExport')] = hoistDefaultExport;
