/**
 * Build the host package to plain JavaScript.
 *
 * The host imports the plugin's source, and the two want different extensions:
 * `tsc` and vitest need `./memory.js` to resolve to `memory.ts` under NodeNext,
 * while Node's own TypeScript support needs the literal `.ts` path. Rather than
 * pick one and break the other, this transpiles to JS, where `.js` means `.js`
 * and both consumers agree.
 *
 * It also rewrites the relative hops into the plugin package to the linked
 * package path. A `../../dsh-plugin/src/...` import happens to work inside this
 * repository and breaks the moment either package moves, which is exactly the
 * kind of brittleness a build step should absorb instead of a reader.
 *
 *   node scripts/build-host.mjs
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const hostSrc = join(root, 'packages', 'host', 'src');
const pluginSrc = join(root, 'packages', 'dsh-plugin', 'src');
const outRoot = join(root, 'packages', 'host', 'dist');

/** The package path the plugin's sources are linked at. */
const PLUGIN_PACKAGE = '@companion-memory/dsh-plugin';

/**
 * Transpile one file and write it to its place under `dist`.
 *
 * @param source - absolute path of the TypeScript file.
 * @param fromDir - directory the file's output is relative to.
 * @param toDir - directory to write under.
 */
function transpile(source, fromDir, toDir) {
  const original = readFileSync(source, 'utf8');

  // Point cross-package imports at the linked package rather than a relative
  // hop.
  //
  // Only specifiers that actually traverse out of the file's own package are
  // rewritten. An earlier version replaced every occurrence of the relative
  // prefix, and for a host file the prefix is `./` — so it silently rewrote
  // every sibling import *and* the regex literals in `render.ts`, turning
  // `.replace(/"/g, ...)` into a syntax error. The rule is `../`, which no
  // sibling import uses.
  const body = original.replace(
    /(['"])(?:\.\.\/)+(?:packages\/)?dsh-plugin\/src\/([^'"]+)\1/g,
    (_match, quote, file) => `${quote}${PLUGIN_PACKAGE}/${file}${quote}`,
  );

  const { outputText, diagnostics } = ts.transpileModule(body, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2023,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      verbatimModuleSyntax: false,
      sourceMap: false,
    },
    fileName: source,
    reportDiagnostics: true,
  });

  const errors = (diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors.length > 0) {
    const text = errors
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '))
      .join('; ');
    throw new Error(`${source}: ${text}`);
  }

  const target = join(toDir, relative(fromDir, source)).replace(/\.ts$/, '.js');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, outputText, 'utf8');
}

/** Every `.ts` file under a directory. */
function sources(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts')) continue;
    found.push(join(entry.parentPath ?? dir, entry.name));
  }
  return found;
}

for (const source of sources(hostSrc)) transpile(source, hostSrc, join(outRoot, 'src'));
for (const source of sources(pluginSrc)) transpile(source, pluginSrc, join(outRoot, 'plugin'));

// The plugin's own module name has to resolve for the rewritten imports. The
// built output goes into the plugin package's `dist/plugin`, which is where its
// export map points: the plugin is consumed as source by tsc and vitest, so its
// manifest cannot point only at build output, and Node cannot load a source file
// whose own imports use `.js` extensions.
const pluginDist = join(root, 'packages', 'dsh-plugin', 'dist', 'plugin');
for (const source of sources(pluginSrc)) transpile(source, pluginSrc, pluginDist);

process.stdout.write(`built host -> ${outRoot}\n`);
process.stdout.write(`built plugin -> ${pluginDist}\n`);
