/**
 * Build the host package to plain JavaScript.
 *
 * The host imports the plugin's shared protocol, rendering, and extraction
 * parser. Build it to JavaScript so cross-package `.ts` paths are replaced by
 * the workspace plugin package before Node executes the evaluator.
 *
 * It also rewrites the relative hops into the plugin package to the linked
 * package path. A `../../dsh-plugin/src/...` import happens to work inside this
 * repository and breaks the moment either package moves, which is exactly the
 * kind of brittleness a build step should absorb instead of a reader.
 *
 *   node scripts/build-host.mjs
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const hostSrc = join(root, 'packages', 'host', 'src');
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

// Clear the output first. Transpiling file by file leaves the compiled form of a
// deleted source in place, so `dist` keeps exporting modules that no longer exist
// in `src` -- which is how a removed provider client stayed importable long after
// it was deleted, and would have kept working if anything had still pointed at it.
rmSync(outRoot, { recursive: true, force: true });
for (const source of sources(hostSrc)) transpile(source, hostSrc, join(outRoot, 'src'));

process.stdout.write(`built host -> ${outRoot}\n`);
