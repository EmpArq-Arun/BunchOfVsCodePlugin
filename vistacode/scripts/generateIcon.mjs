/**
 * Converts the SVG source icon to a 24×24 PNG via resvg-wasm (already a project dependency).
 * VS Code / vsce rejects SVG for activity-bar icons and the top-level "icon" field;
 * a PNG on a transparent background is the required format.
 *
 * The SVG uses `fill="currentColor"` for theming; for the PNG we substitute white (#fff)
 * so VS Code can use the image as a mask and tint it for active/inactive states.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initWasm, Resvg } from '@resvg/resvg-wasm';

const __dir = dirname(fileURLToPath(import.meta.url));
const root  = join(__dir, '..');

await initWasm(readFileSync(join(root, 'node_modules/@resvg/resvg-wasm/index_bg.wasm')));

// Swap currentColor → white so it works as a VS Code icon mask
const svgSrc = readFileSync(join(root, 'media/vistacode-icon.svg'), 'utf8')
  .replace(/currentColor/g, '#ffffff');

const resvg = new Resvg(svgSrc, {
  fitTo: { mode: 'width', value: 48 }   // 2× for retina; VS Code scales down as needed
});
const png = resvg.render().asPng();
const outPath = join(root, 'media/vistacode-icon.png');
writeFileSync(outPath, Buffer.from(png));
console.log(`icon generated: media/vistacode-icon.png (${png.length} bytes)`);
