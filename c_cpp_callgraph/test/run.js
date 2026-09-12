// Plain-Node test runner (no extra test framework dependency).
// Bundles every test/*.ts file with esbuild and runs each in its own `node`
// subprocess, with test/mocks on NODE_PATH so `require('vscode')` resolves
// to the lightweight in-memory mock instead of needing a real VS Code host.

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const esbuild = require('esbuild');

const testDir = __dirname;
const files = fs
  .readdirSync(testDir)
  .filter((f) => f.endsWith('.ts'))
  .sort();

let anyFailed = false;

for (const file of files) {
  const entry = path.join(testDir, file);
  // Bundle alongside the source file (not os.tmpdir()) so __dirname inside
  // the bundled test still resolves to test/ — needed for fixture paths.
  const outFile = path.join(testDir, `.bundle-${file.replace(/\.ts$/, '')}.js`);

  console.log(`\n=== ${file} ===`);

  esbuild.buildSync({
    entryPoints: [entry],
    outfile: outFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
    logLevel: 'warning',
  });

  try {
    execFileSync('node', [outFile], {
      stdio: 'inherit',
      env: { ...process.env, NODE_PATH: path.join(testDir, 'mocks') },
    });
  } catch (err) {
    anyFailed = true;
  } finally {
    fs.unlinkSync(outFile);
  }
}

process.exit(anyFailed ? 1 : 0);
