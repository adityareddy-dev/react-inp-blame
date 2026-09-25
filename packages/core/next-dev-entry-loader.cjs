// The loader withInpBlame's Turbopack rule runs on next-dev-turbopack.js, the Pages Router's entry on
// `next dev` from Next.js 15.3. That file requires the module that loads react-dom before the one that
// loads instrumentation-client, so the line there installs too late. This puts the install at its top.
//
// The require goes on the line of the "use strict" directive, after it, so the module stays strict and
// every line keeps its number for the source map. Any other file comes back as it was.

const CLIENT_MODULE = 'react-inp-blame/next-client';
const ENTRY = /[\\/]next[\\/]dist[\\/]client[\\/]next-dev-turbopack\.js$/;
const DIRECTIVE = /^(\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*)(['"])use strict\2;?/;

function addInstall(source, file) {
  if (!ENTRY.test(file) || source.includes(`require(${JSON.stringify(CLIENT_MODULE)})`)) return source;
  const line = `require(${JSON.stringify(CLIENT_MODULE)});`;
  const directive = source.match(DIRECTIVE);
  if (!directive) return `${line} ${source}`;
  return `${directive[0]} ${line}${source.slice(directive[0].length)}`;
}

function loader(source) {
  const file = (this && this.resourcePath) || '';
  return addInstall(typeof source === 'string' ? source : String(source), file);
}

module.exports = loader;
