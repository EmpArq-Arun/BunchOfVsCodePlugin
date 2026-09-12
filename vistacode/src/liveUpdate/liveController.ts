import * as vscode from 'vscode';
import type { ParserService } from '../parser/parserService';
import { cfgToDot, extractNodeMetadata, extractEdgeMetadata, prepareDotForLayout,
         type NodeMetadata, type EdgeMetadata, type DisplayMode, type LayoutMode } from '../dot/dotGenerator';
import { buildCFG } from '../parser/cfgBuilder';
import { hashFunctionText, signatureHash, functionDisplayName } from '../parser/functionHash';
import { renderSvgWithEngine } from '../export/exportService';
import { parsePositionsFromSvg, type NodePosition } from '../layout/positionParser';
import type { ControlFlowGraph } from '../parser/cfgTypes';

export interface RenderPayload {
  dot: string;
  functionKey: string;
  nodeData: Record<string, NodeMetadata>;
  edgeData: EdgeMetadata[];
  positions: Record<string, NodePosition>;
  layout: LayoutMode;
}

interface CacheEntry {
  hash: string;
  graph: ControlFlowGraph;
  document: vscode.TextDocument;
}

interface PositionCacheEntry { hash: string; positions: Record<string, NodePosition>; }

const DEBOUNCE_MS  = 200;
const CACHE_LIMIT  = 60;

export class LiveController {
  private readonly cache  = new Map<string, CacheEntry>();
  private readonly dotCache = new Map<string, Map<DisplayMode, string>>();
  private readonly posCache = new Map<string, PositionCacheEntry>(); // key: `fnKey:layout`

  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private currentKey:  string | null  = null;
  private displayMode: DisplayMode    = 'comment';
  private layout:      LayoutMode     = 'vertical';

  constructor(
    private readonly parserService: ParserService,
    private readonly postToWebview: (p: RenderPayload) => void
  ) {}

  async onSelectionChanged(doc: vscode.TextDocument, pos: vscode.Position): Promise<void> {
    await this.refresh(doc, pos);
  }
  onDocumentChanged(doc: vscode.TextDocument, pos: vscode.Position): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.refresh(doc, pos), DEBOUNCE_MS);
  }

  setDisplayMode(mode: DisplayMode): void {
    this.displayMode = mode;
    if (this.currentKey) {
      const entry = this.cache.get(this.currentKey);
      if (entry) void this.emitFromCache(this.currentKey, entry);
    }
  }

  async setLayout(mode: LayoutMode): Promise<void> {
    this.layout = mode;
    if (this.currentKey) {
      const entry = this.cache.get(this.currentKey);
      if (entry) await this.emitFromCache(this.currentKey, entry);
    }
  }

  private getDot(key: string, entry: CacheEntry): string {
    let modeMap = this.dotCache.get(key);
    if (!modeMap) { modeMap = new Map(); this.dotCache.set(key, modeMap); }
    let dot = modeMap.get(this.displayMode);
    if (!dot) { dot = cfgToDot(entry.graph, this.displayMode); modeMap.set(this.displayMode, dot); }
    return dot;
  }

  private async getPositions(key: string, hash: string, dot: string): Promise<Record<string, NodePosition>> {
    const cKey = `${key}:${this.layout}`;
    const cached = this.posCache.get(cKey);
    if (cached?.hash === hash) return cached.positions;

    const { dot: layoutDot, engine } = prepareDotForLayout(dot, this.layout);
    let svg: string;
    try { svg = await renderSvgWithEngine(layoutDot, engine); }
    catch { return {}; }

    const positions = parsePositionsFromSvg(svg);
    this.posCache.set(cKey, { hash, positions });
    return positions;
  }

  private async emitFromCache(key: string, entry: CacheEntry): Promise<void> {
    this.currentKey = key;
    const dot       = this.getDot(key, entry);
    const positions = await this.getPositions(key, entry.hash, dot);
    this.postToWebview({
      dot,
      functionKey: key,
      nodeData:  extractNodeMetadata(entry.graph),
      edgeData:  extractEdgeMetadata(entry.graph),
      positions,
      layout: this.layout
    });
  }

  private async refresh(doc: vscode.TextDocument, pos: vscode.Position): Promise<void> {
    if (doc.languageId !== 'c' && doc.languageId !== 'cpp') return;
    const found = await this.parserService.findEnclosingFunction(doc, pos);
    if (!found) return;

    const key  = `${functionDisplayName(found.node)}@${signatureHash(found.node)}`;
    const hash = hashFunctionText(found.node);
    const cached = this.cache.get(key);

    if (cached?.hash === hash) {
      if (this.currentKey !== key) await this.emitFromCache(key, cached);
      return;
    }

    if (this.cache.size >= CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value as string;
      this.cache.delete(oldest); this.dotCache.delete(oldest);
    }

    const graph = buildCFG(found.node);
    const entry = { hash, graph, document: doc };
    this.cache.set(key, entry);
    this.dotCache.delete(key);
    // Invalidate positions for this key across all layouts
    for (const lk of this.posCache.keys()) { if (lk.startsWith(key+':')) this.posCache.delete(lk); }
    await this.emitFromCache(key, entry);
  }

  getCurrentKey():      string | null                       { return this.currentKey; }
  getCurrentGraph():    ControlFlowGraph | undefined        { return this.currentKey ? this.cache.get(this.currentKey)?.graph : undefined; }
  getCurrentDocument(): vscode.TextDocument | undefined    { return this.currentKey ? this.cache.get(this.currentKey)?.document : undefined; }

  getCurrentPayload(): RenderPayload | undefined {
    const k = this.currentKey, e = k ? this.cache.get(k) : undefined;
    if (!k || !e) return undefined;
    const dot = this.getDot(k, e);
    const positions = this.posCache.get(`${k}:${this.layout}`)?.positions ?? {};
    return { dot, functionKey: k, nodeData: extractNodeMetadata(e.graph),
             edgeData: extractEdgeMetadata(e.graph), positions, layout: this.layout };
  }
}
