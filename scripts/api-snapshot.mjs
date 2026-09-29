// The types every entry point publishes, against the copy of them committed in api/.
//
//   node scripts/api-snapshot.mjs            # fail when the types differ from api/
//   node scripts/api-snapshot.mjs --write    # write them into api/
//
// Each entry's types file is the one packages/core/package.json's exports map names. The ones under dist/ are
// made here the way the build makes them, with tsc's declaration emit, so neither needs a build first, and the
// files they import are followed from there, relative imports only. Comments are left out and each file is
// printed the same way, so a JSDoc edit changes nothing here and a change to a type always does. api/ holds one
// file per declaration file, named as it is published with dist/ dropped. The unit tests run the check.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const core = path.join(root, 'packages/core');
export const API_DIR = path.join(root, 'api');

/** The types file of every entry in the exports map, relative to packages/core. */
function entryTypes() {
  const { exports } = JSON.parse(fs.readFileSync(path.join(core, 'package.json'), 'utf8'));
  return [...new Set(Object.values(exports).flatMap((target) => (typeof target === 'object' && target.types ? [path.posix.normalize(target.types)] : [])))];
}

/** What tsc's declaration emit writes for packages/core/src, by path relative to packages/core. */
function emitDeclarations() {
  const config = ts.getParsedCommandLineOfConfigFile(path.join(core, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n')); } });
  const program = ts.createProgram(config.fileNames, { ...config.options, declaration: true, emitDeclarationOnly: true, noEmit: false });
  const emitted = new Map();
  const result = program.emit(undefined, (file, text) => emitted.set(path.relative(core, file).split(path.sep).join('/'), text), undefined, true);
  if (result.emitSkipped) throw new Error('tsc emitted no declarations for packages/core');
  return emitted;
}

/** The declaration file a relative import in `from` names: './types.js' from dist/index.d.ts is dist/types.d.ts. */
function declarationOf(from, specifier) {
  const file = path.posix.join(path.posix.dirname(from), specifier);
  return file.replace(/\.(m|c)?js$/, (_, kind) => `.d.${kind ?? ''}ts`);
}

/** `text` without its comments, printed the one way the printer knows. */
function normalise(name, text) {
  const source = ts.createSourceFile(name, text.replace(/\r\n/g, '\n'), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  return ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed }).printFile(source);
}

/** Every published declaration file an entry reaches, by its name in api/, with its normalised text. */
export function snapshot() {
  const emitted = emitDeclarations();
  const read = (file) => emitted.get(file) ?? (fs.existsSync(path.join(core, file)) ? fs.readFileSync(path.join(core, file), 'utf8') : null);
  const files = new Map();
  const pending = entryTypes();
  while (pending.length) {
    const file = pending.pop();
    const name = file.replace(/^dist\//, '');
    if (files.has(name)) continue;
    const text = read(file);
    if (text === null) throw new Error(`packages/core/${file} is named in the exports map or imported by a types file, and nothing makes it`);
    files.set(name, normalise(name, text));
    for (const { fileName } of ts.preProcessFile(text, true, true).importedFiles) {
      if (fileName.startsWith('.')) pending.push(declarationOf(file, fileName));
    }
  }
  return new Map([...files].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** The files of api/, by name. */
export function committed(dir = API_DIR) {
  if (!fs.existsSync(dir)) return new Map();
  return new Map(fs.readdirSync(dir).sort().map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf8')]));
}

/** How `current` differs from `saved`, one line a file; line endings are not a difference. */
export function differences(current, saved) {
  const found = [];
  for (const [name, text] of current) {
    const was = saved.get(name);
    if (was === undefined) found.push(`${name} is published and not in api/`);
    else if (was.replace(/\r\n/g, '\n') !== text) found.push(`${name} differs from api/${name}`);
  }
  for (const name of saved.keys()) if (!current.has(name)) found.push(`api/${name} is no longer published`);
  return found;
}

/** Makes api/ hold `current` and nothing else. */
export function write(current, dir = API_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(dir)) if (!current.has(name)) fs.rmSync(path.join(dir, name));
  for (const [name, text] of current) fs.writeFileSync(path.join(dir, name), text);
}

function main() {
  const { values } = parseArgs({ options: { write: { type: 'boolean', default: false } } });
  const current = snapshot();
  if (values.write) {
    write(current);
    console.log(`api/ holds the types of ${current.size} declaration files.`);
    return;
  }
  const found = differences(current, committed());
  if (found.length) {
    console.error(`${found.join('\n')}\n\nThe published types changed. If that is meant, run \`node scripts/api-snapshot.mjs --write\`, commit api/ and say why in the pull request.`);
    process.exitCode = 1;
  } else {
    console.log(`The types of ${current.size} declaration files match api/.`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
