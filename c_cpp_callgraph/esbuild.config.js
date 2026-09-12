const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

const commonOpts = {
  bundle: true,
  sourcemap: true,
  minify: false,
  logLevel: 'info',
};

async function build() {
  const ctxExt = await esbuild.context({
    ...commonOpts,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });

  const ctxWeb = await esbuild.context({
    ...commonOpts,
    entryPoints: ['src/webview/main.ts'],
    outfile: 'media/webview.js',
    platform: 'browser',
    format: 'iife',
  });

  if (watch) {
    await ctxExt.watch();
    await ctxWeb.watch();
    console.log('Watching for changes...');
  } else {
    await ctxExt.rebuild();
    await ctxWeb.rebuild();
    await ctxExt.dispose();
    await ctxWeb.dispose();
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
