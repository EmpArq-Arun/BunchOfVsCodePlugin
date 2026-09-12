// Copies static WASM assets into dist/ at build time.
// - tree-sitter grammars (C, C++) are read directly from disk at extension-host runtime
//   via fs.readFileSync + Language.load(bytes), so they need a stable path inside the
//   packaged extension.
// - web-tree-sitter itself is kept as an esbuild `--external` dependency (not bundled),
//   so its own runtime wasm is auto-located relative to its own node_modules folder —
//   nothing to copy for that one.
// - resvg's wasm (PNG export) is explicitly loaded by our own code too, so it needs a copy.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const distDir = path.join(root, 'dist');
const grammarsDir = path.join(distDir, 'grammars');
const wasmDir = path.join(distDir, 'wasm');

fs.mkdirSync(grammarsDir, { recursive: true });
fs.mkdirSync(wasmDir, { recursive: true });

function copy(from, to) {
  fs.copyFileSync(from, to);
  console.log(`copied ${path.relative(root, from)} -> ${path.relative(root, to)}`);
}

copy(
  path.join(root, 'node_modules', 'tree-sitter-wasms', 'out', 'tree-sitter-c.wasm'),
  path.join(grammarsDir, 'tree-sitter-c.wasm')
);
copy(
  path.join(root, 'node_modules', 'tree-sitter-wasms', 'out', 'tree-sitter-cpp.wasm'),
  path.join(grammarsDir, 'tree-sitter-cpp.wasm')
);
copy(
  path.join(root, 'node_modules', '@resvg', 'resvg-wasm', 'index_bg.wasm'),
  path.join(wasmDir, 'resvg.wasm')
);

