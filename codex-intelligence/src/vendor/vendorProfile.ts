import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { minimatch } from 'minimatch';

export interface VendorConfig {
  name: string;
  excludePaths: string[];
  excludePrefixes: string[];
  externLeafPrefixes: string[];
  includeExtensions: string[];
  notes: string;
}

/** Pure matcher — no vscode dependency, directly unit-testable. */
export function matchesAnyPattern(relPath: string, patterns: string[]): boolean {
  const normalised = relPath.replace(/\\/g, '/');
  return patterns.some(p => minimatch(normalised, p, { matchBase: true, dot: true }));
}

export class VendorProfile {
  private config!: VendorConfig;
  private profileName = 'stm32';

  constructor(private workspaceRoot: string) {}

  async load(): Promise<void> {
    this.profileName = vscode.workspace.getConfiguration('codex').get<string>('vendorProfile', 'stm32');
    const builtinPath = path.join(__dirname, '..', 'profiles', 'vendors.json');
    const builtins: Record<string, VendorConfig> = JSON.parse(fs.readFileSync(builtinPath, 'utf8'));
    const overridePath = path.join(this.workspaceRoot, '.codex', 'vendor.json');
    let override: Partial<VendorConfig> = {};
    if (fs.existsSync(overridePath)) {
      try { override = JSON.parse(fs.readFileSync(overridePath, 'utf8')); } catch { /* ignore */ }
    }
    const base = builtins[this.profileName] ?? builtins['custom'];
    this.config = { ...base, ...override };
  }

  /** Test hook — bypass vscode/fs and set config directly. */
  setConfigForTest(config: VendorConfig, profileName = 'test'): void {
    this.config = config;
    this.profileName = profileName;
  }

  getProfileName(): string { return this.profileName; }
  getConfig(): VendorConfig { return this.config; }

  isVendorFile(filePath: string): boolean {
    const rel = path.relative(this.workspaceRoot, filePath);
    return matchesAnyPattern(rel, this.config.excludePaths);
  }

  isVendorSymbol(name: string): boolean {
    return this.config.excludePrefixes.some(p => name.startsWith(p));
  }

  isExternLeaf(name: string): boolean {
    return this.config.externLeafPrefixes.some(p => name.startsWith(p));
  }

  filterUserFiles(files: string[]): string[] {
    return files.filter(f => {
      if (this.isVendorFile(f)) { return false; }
      return this.config.includeExtensions.includes(path.extname(f).toLowerCase());
    });
  }
}
