import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/** The extension bundle: CommonJS, node platform, vscode left external. */
const extension = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  minify: !watch,
  logLevel: 'info',
};

/**
 * Core modules transpiled separately as ESM so the node test runner can import
 * them directly. They carry no `vscode` import precisely so this is possible.
 */
const core = {
  entryPoints: [
    'src/core/model.ts',
    'src/core/anchor.ts',
    'src/core/frontmatter.ts',
    'src/core/review.ts',
    'src/core/journal.ts',
    'src/core/structure.ts',
    'src/core/clanguml.ts',
    'src/core/constructs.ts',
    'src/core/render.ts',
    'src/core/flow.ts',
    'src/core/flowfindings.ts',
    'src/core/flowrender.ts',
    'src/core/ast.ts',
    'src/core/rosetta.ts',
    'src/core/compdb.ts',
    'src/core/devicemacros.ts',
    'src/core/sysinclude.ts',
    'src/core/recordlayout.ts',
    'src/core/pahole.ts',
    'src/core/dwarfdump.ts',
    'src/core/layoutmerge.ts',
    'src/core/layoutrender.ts',
    'src/core/elf.ts',
    'src/core/mangling.ts',
    'src/core/cost.ts',
    'src/core/uftrace.ts',
    'src/core/sequence.ts',
    'src/core/lifetime.ts',
    'src/core/complexity.ts',
    'src/core/narrative.ts',
    'src/clanguml/runner.ts',
  ],
  // clanguml/runner is bundled for tests too: its database staging is pure
  // filesystem work with no vscode dependency, and it is worth covering.

  outdir: 'out-test',
  outbase: 'src',
  format: 'esm',
  platform: 'node',
  target: 'node18',
  logLevel: 'warning',
};

if (watch) {
  const ctx = await esbuild.context(extension);
  await ctx.watch();
} else {
  await esbuild.build(extension);
  await esbuild.build(core);
}
