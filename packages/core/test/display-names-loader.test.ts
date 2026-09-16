import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const { componentNames, stamp } = createRequire(import.meta.url)('../display-names-loader.cjs') as {
  componentNames(code: string): string[];
  stamp(code: string): string;
};

test('the loader finds the declarations it documents: a function, exported or not, and a const bound to memo or forwardRef', () => {
  const found: Array<[code: string, names: string[]]> = [
    ['function Cart() {}', ['Cart']],
    ['export function Cart() {}', ['Cart']],
    ['export default function Cart() {}', ['Cart']],
    ['const Row = memo(function Row() {});', ['Row']],
    ['export const Row = React.memo((props) => null);', ['Row']],
    ['const Field = forwardRef((props, ref) => null);', ['Field']],
    ['const Field = /* @__PURE__ */ forwardRef((props, ref) => null);', ['Field']],
  ];
  for (const [code, names] of found) assert.deepEqual(componentNames(code), names, code);
});

test('and leaves alone what it does not match: lowercase functions, indented declarations, arrow components, anonymous defaults and generic calls', () => {
  const missed = ['function formatPrice() {}', '  function Nested() {}', 'const Cart = () => null;', 'export default memo(function Row() {});', 'const Row = memo<Props>(function Row() {});'];
  for (const code of missed) assert.deepEqual(componentNames(code), [], code);
});

test('each component it finds gets its name stamped, and a file with none comes back as it was', () => {
  const code = 'export function Cart() {}\nconst Row = memo(function Row() {});\n';
  assert.equal(stamp(code), `${code}\ntry { Cart.displayName = "Cart"; } catch (e) {}\ntry { Row.displayName = "Row"; } catch (e) {}`);
  assert.equal(stamp('export const price = 1;'), 'export const price = 1;');
});
