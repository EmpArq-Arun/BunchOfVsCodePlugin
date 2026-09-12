const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

async function run() {
  const extensionCtx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    external: ['vscode'],
    sourcemap: true,
    logLevel: 'info',
  });

  const webviewCtx = await esbuild.context({
    entryPoints: ['media/webview/main.ts'],
    bundle: true,
    outfile: 'media/webview.js',
    platform: 'browser',
    target: 'es2020',
    format: 'iife',
    sourcemap: true,
    logLevel: 'info',
  });

  const fileGraphCtx = await esbuild.context({
    entryPoints: ['media/fileGraph/main.ts'],
    bundle: true,
    outfile: 'media/fileGraph.js',
    platform: 'browser',
    target: 'es2020',
    format: 'iife',
    sourcemap: true,
    logLevel: 'info',
  });

  if (watch) {
    await extensionCtx.watch();
    await webviewCtx.watch();
    await fileGraphCtx.watch();
    console.log('Watching for changes...');
  } else {
    await extensionCtx.rebuild();
    await webviewCtx.rebuild();
    await fileGraphCtx.rebuild();
    await extensionCtx.dispose();
    await webviewCtx.dispose();
    await fileGraphCtx.dispose();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
