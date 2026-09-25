// The loader withInpBlame's Turbopack rule runs on next-dev-turbopack.js, the Pages Router's entry on
// `next dev` from Next.js 15.3. That file requires the module that loads react-dom before the one that
// loads instrumentation-client, so the line there installs too late. This puts the install at its top.
//
// The require goes on the line of the "use strict" directive, after it, so the module stays strict and
// every line keeps its number for the source map. Any other file comes back as it was.
//
// The install is required by its path from that file rather than by the package name. The file is Next.js's
// own, so the name would be resolved from inside next's folder, which a strict node_modules (pnpm with
// hoisting off) does not allow, and every Pages Router page would fail to compile. The path is relative
// because Turbopack does not take an absolute one there.

const path = require('node:path');

const CLIENT_MODULE = path.join(__dirname, 'dist', 'next-client.js');
const ENTRY = /[\\/]next[\\/]dist[\\/]client[\\/]next-dev-turbopack\.js$/;
const DIRECTIVE = /^(\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*)(['"])use strict\2;?/;

/** The install's path from `file`, with forward slashes and a leading `./` or `../`, as a require takes it. */
function requestFrom(file) {
  const rel = path.relative(path.dirname(file), CLIENT_MODULE).split(path.sep).join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

function addInstall(source, file) {
  if (!ENTRY.test(file)) return source;
  const line = `require(${JSON.stringify(requestFrom(file))});`;
  if (source.includes(line)) return source;
  const directive = source.match(DIRECTIVE);
  if (!directive) return `${line} ${source}`;
  return `${directive[0]} ${line}${source.slice(directive[0].length)}`;
}

function loader(source) {
  const file = (this && this.resourcePath) || '';
  return addInstall(typeof source === 'string' ? source : String(source), file);
}

module.exports = loader;
module.exports.clientModule = CLIENT_MODULE;
module.exports.requestFrom = requestFrom;
