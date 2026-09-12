/**
 * Parses Graphviz SVG output (a string) to extract each node's centre position
 * in Graphviz's internal unit space.  No DOM required — works in both the
 * Node.js extension host and the browser webview.
 */
export interface NodePosition { x: number; y: number; }

export function parsePositionsFromSvg(svg: string): Record<string, NodePosition> {
  const positions: Record<string, NodePosition> = {};

  // The top-level <g class="graph"> has a translate(...) that moves the
  // coordinate origin.  Graphviz y-axis points upward, so node cy values
  // are negative; adding ty converts them to SVG-viewport (y-down) coords.
  let tx = 0, ty = 0;
  const tm = svg.match(/translate\(\s*([\d.+-]+)[,\s]+([\d.+-]+)\s*\)/);
  if (tm) { tx = parseFloat(tm[1]); ty = parseFloat(tm[2]); }

  // Each node group: <g id="n1" class="node"> ... </g>
  // The [\s\S]*?<\/g> stops at the FIRST </g> which is the inner <a> wrapper's
  // closing tag — but that comes AFTER the shape elements, so they are included.
  for (const [, id, content] of svg.matchAll(
    /<g id="(n\d+)"[^>]*class="node"[^>]*>([\s\S]*?)<\/g>/g
  )) {
    // Ellipse: entry / exit nodes
    const el = content.match(/cx="([\d.+-]+)"[^>]*cy="([\d.+-]+)"/);
    if (el) {
      positions[id] = { x: tx + parseFloat(el[1]), y: ty + parseFloat(el[2]) };
      continue;
    }
    // Polygon: decision diamond, process box, hexagon, etc.
    const po = content.match(/points="([^"]+)"/);
    if (po) {
      let pts = po[1].trim().split(/\s+/).map(p => {
        const [px, py] = p.split(',').map(Number);
        return { x: px, y: py };
      }).filter(p => !isNaN(p.x) && !isNaN(p.y));
      // Closed paths repeat the first point — remove the duplicate
      if (pts.length > 1 &&
          pts[0].x === pts[pts.length - 1].x &&
          pts[0].y === pts[pts.length - 1].y) {
        pts = pts.slice(0, -1);
      }
      if (pts.length) {
        const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
        const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
        positions[id] = { x: tx + cx, y: ty + cy };
      }
    }
  }
  return positions;
}
