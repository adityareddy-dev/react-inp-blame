// Run order for overhead collection, as the protocol fixes it. Kept apart from bench.mjs, which runs
// on import, so it can be tested on its own.
import crypto from 'node:crypto';

// Every permutation of `items`, in a fixed order.
export function permutations(items) {
  if (items.length <= 1) return [items];
  return items.flatMap((x, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [x, ...rest]),
  );
}

/**
 * The slots for one app and CPU condition. Each block holds every permutation of `configs` once,
 * and the permutations inside a block run in the order of SHA-256 of
 * `react-inp-blame-2026-10-14:order:<app>:<cpu>:<block>:<permutation>`. Blocks are numbered from 1.
 * A slot's runIndex is its block and permutation index, so the runs of one slot are paired.
 */
export function blockSchedule(appId, cpu, blocks, configs) {
  const perms = permutations(configs).map((p) => p.join(''));
  const slots = [];
  for (let block = 1; block <= blocks; block++) {
    const ordered = perms
      .map((permutation) => ({
        permutation,
        key: crypto
          .createHash('sha256')
          .update(`react-inp-blame-2026-10-14:order:${appId}:${cpu}:${block}:${permutation}`, 'utf8')
          .digest('hex'),
      }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    for (const { permutation } of ordered) {
      slots.push({
        block,
        permutation,
        order: permutation.split(''),
        runIndex: (block - 1) * perms.length + perms.indexOf(permutation),
      });
    }
  }
  return slots;
}
