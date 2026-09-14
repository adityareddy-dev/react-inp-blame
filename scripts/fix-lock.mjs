// Rewrites tarball URLs in package-lock.json back to the public registry.
// Installs on a machine that points npm at a private mirror record the mirror's
// URLs in `resolved`; the integrity hashes are identical, so only the host changes.
import fs from 'node:fs';
const file = new URL('../package-lock.json', import.meta.url);
const before = fs.readFileSync(file, 'utf8');
const after = before.replace(/https:\/\/[^"]*?\/api\/npm\/npm\//g, 'https://registry.npmjs.org/');
if (after !== before) { fs.writeFileSync(file, after); console.log('package-lock.json: mirror URLs rewritten to registry.npmjs.org'); }
else console.log('package-lock.json: nothing to rewrite');
