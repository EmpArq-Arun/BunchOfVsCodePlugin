const esbuild = require('esbuild');
const path = require('path');

const root = path.join(__dirname, '..');

/** Bundles extension modules for node:test, keeping `vscode` external (stubbed by the tests). */
Promise.all([
  esbuild.build({
    entryPoints: [path.join(root, 'src', 'parser.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    outfile: path.join(root, 'out-test', 'parser.js'),
    logLevel: 'info'
  }),
  esbuild.build({
    entryPoints: [path.join(root, 'src', 'logger.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
    outfile: path.join(root, 'out-test', 'logger.js'),
    logLevel: 'info'
  }),
  esbuild.build({
    entryPoints: [path.join(root, 'src', 'hub.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode', 'serialport'],
    outfile: path.join(root, 'out-test', 'hub.js'),
    logLevel: 'info'
  })
]).catch(() => process.exit(1));
