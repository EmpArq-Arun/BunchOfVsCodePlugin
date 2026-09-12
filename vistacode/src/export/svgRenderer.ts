/**
 * Thin wrapper around @hpcc-js/wasm-graphviz.
 * No vscode dependency — safe to import in both extension and test contexts.
 */
import { Graphviz } from '@hpcc-js/wasm-graphviz';

let _gv: Graphviz | null = null;
async function getGv(): Promise<Graphviz> {
  if (!_gv) _gv = await Graphviz.load();
  return _gv;
}

export async function renderSvgWithEngine(dot: string, engine: 'dot' | 'twopi' = 'dot'): Promise<string> {
  const gv = await getGv();
  return engine === 'twopi' ? gv.twopi(dot, 'svg') : gv.dot(dot, 'svg');
}
