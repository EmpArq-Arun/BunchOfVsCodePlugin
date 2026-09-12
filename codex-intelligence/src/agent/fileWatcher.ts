import * as chokidar from 'chokidar';
import * as path from 'path';
import { VendorProfile } from '../vendor/vendorProfile';

type OnChangeCallback = (filePath: string) => Promise<void>;

export class FileWatcher {
  private watcher: chokidar.FSWatcher | undefined;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly DEBOUNCE_MS = 800;

  constructor(
    private workspaceRoot: string,
    private vendor: VendorProfile,
    private onChange: OnChangeCallback
  ) {}

  start(): void {
    const cfg = this.vendor.getConfig();
    const watchGlobs = cfg.includeExtensions.map(ext =>
      path.join(this.workspaceRoot, '**', `*${ext}`)
    );
    const ignored: string[] = [
      '**/node_modules/**', '**/.codex/**', '**/.git/**',
      ...cfg.excludePaths.map(p => path.join(this.workspaceRoot, p))
    ];
    this.watcher = chokidar.watch(watchGlobs, {
      ignored, persistent: true, ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 }
    });
    this.watcher
      .on('change', (f: string) => this.schedule(f))
      .on('add',    (f: string) => this.schedule(f))
      .on('error',  (e: unknown) => console.error('[Codex FileWatcher]', e));
  }

  stop(): void {
    this.watcher?.close();
    this.debounceTimers.forEach(t => clearTimeout(t));
    this.debounceTimers.clear();
  }

  private schedule(filePath: string): void {
    if (this.vendor.isVendorFile(filePath)) { return; }
    const existing = this.debounceTimers.get(filePath);
    if (existing) { clearTimeout(existing); }
    const timer = setTimeout(async () => {
      this.debounceTimers.delete(filePath);
      try { await this.onChange(filePath); }
      catch (err) { console.error('[Codex] Error indexing', filePath, err); }
    }, this.DEBOUNCE_MS);
    this.debounceTimers.set(filePath, timer);
  }
}
