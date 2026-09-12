import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_LOGGER_OPTIONS, FileLogger, LogFormat, LoggerOptions } from './logger';
import { PanelManager, ViewId } from './panels';
import { Matcher, buildMatcher, parseLine } from './parser';
import { Scheduler } from './scheduler';
import { SerialConnection, isSerialAvailable } from './serial';
import { CommandStore, normaliseCommand } from './store';
import {
  CommandDef,
  HubState,
  LineEnding,
  LogEntry,
  MAX_GRAPH_WINDOWS,
  PortConfig,
  PortInfo,
  Sample,
  defaultPortConfig
} from './types';

const FLUSH_INTERVAL_MS = 60;

export class Hub implements vscode.Disposable {
  private readonly serial = new SerialConnection();
  private readonly store: CommandStore;
  private readonly panels: PanelManager;
  private readonly scheduler: Scheduler;
  private readonly status: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  private matchers = new Map<string, Matcher>();
  private ports: PortInfo[] = [];
  private portConfig: PortConfig = defaultPortConfig();
  private lineEnding: LineEnding = '\r\n';
  private connecting = false;
  private lastError: string | undefined;

  private pendingLogs: LogEntry[] = [];
  private pendingSamples: Sample[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private logger: FileLogger | null = null;
  private loggerOptions: LoggerOptions | null = null;
  private statusTimer: NodeJS.Timeout | null = null;

  constructor(context: vscode.ExtensionContext) {
    this.store = new CommandStore(context.globalState);
    this.panels = new PanelManager(
      context,
      (view, message) => this.handleMessage(view, message),
      (view) => this.onViewReady(view)
    );
    this.scheduler = new Scheduler(
      (command) => this.transmit(command),
      () => this.pushState()
    );

    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.status.command = 'serialTerminalPlus.open';
    this.disposables.push(this.status);

    this.loadSettings();
    this.rebuildMatchers();

    this.disposables.push(
      this.store.onDidChange(() => {
        this.rebuildMatchers();
        this.pushState();
      })
    );

    this.serial.on('open', () => {
      this.connecting = false;
      this.lastError = undefined;
      this.log('info', `Connected to ${this.serial.path}`);
      const autoStart = vscode.workspace.getConfiguration('serialTerminalPlus').get<boolean>('logging.autoStart');
      if (autoStart && !this.logger) {
        void this.startLogging();
      }
      this.pushState();
    });
    this.serial.on('close', () => {
      this.connecting = false;
      this.scheduler.stopAll();
      this.log('info', 'Disconnected');
      this.pushState();
    });
    this.serial.on('error', (err: Error) => {
      this.lastError = err.message;
      this.log('err', err.message);
      this.pushState();
    });
    this.serial.on('line', (line: string) => this.handleLine(line));

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('serialTerminalPlus')) {
          this.loadSettings();
          this.pushState();
        }
      })
    );

    this.updateStatusBar();
    this.status.show();
    void this.refreshPorts();

    // Keeps the "buffered bytes" readout live while logging is active.
    this.statusTimer = setInterval(() => {
      if (this.logger) {
        this.panels.post('terminal', { type: 'loggerStatus', logger: this.logger.status() });
      }
    }, 1000);
    this.statusTimer.unref?.();
  }

  // ---------------------------------------------------------------- settings

  private loadSettings(): void {
    const cfg = vscode.workspace.getConfiguration('serialTerminalPlus');
    const defaults = cfg.get<Partial<PortConfig>>('defaultPortConfig') ?? {};
    this.portConfig = { ...defaultPortConfig(), ...defaults, path: this.portConfig.path || defaults.path || '' };
    const le = cfg.get<string>('lineEnding') ?? '\\r\\n';
    this.lineEnding = decodeLineEnding(le);
  }

  private get maxGraphWindows(): number {
    const v = vscode.workspace.getConfiguration('serialTerminalPlus').get<number>('maxGraphWindows') ?? MAX_GRAPH_WINDOWS;
    return Math.min(MAX_GRAPH_WINDOWS, Math.max(1, Math.trunc(v)));
  }

  // ------------------------------------------------------------------- views

  showAll(): void {
    this.panels.show('terminal', vscode.ViewColumn.One);
    this.panels.show('graph', vscode.ViewColumn.Two);
    this.panels.show('response', vscode.ViewColumn.Three);
  }

  show(view: ViewId): void {
    const column = view === 'terminal' ? vscode.ViewColumn.One : vscode.ViewColumn.Beside;
    this.panels.show(view, column);
  }

  private onViewReady(view: ViewId): void {
    this.panels.post(view, { type: 'state', state: this.buildState() });
    if (view === 'terminal') {
      void this.refreshPorts();
    }
  }

  // ------------------------------------------------------------------- state

  private buildState(): HubState {
    const cfg = vscode.workspace.getConfiguration('serialTerminalPlus');
    return {
      connected: this.serial.isOpen,
      connecting: this.connecting,
      portConfig: { ...this.portConfig, path: this.serial.isOpen ? this.serial.path : this.portConfig.path },
      ports: this.ports,
      commands: this.store.all(),
      running: this.scheduler.running(),
      lineEnding: this.lineEnding,
      maxGraphWindows: this.maxGraphWindows,
      maxPointsPerSeries: cfg.get<number>('maxPointsPerSeries') ?? 600,
      scrollback: cfg.get<number>('terminalScrollback') ?? 2000,
      serialAvailable: isSerialAvailable(),
      logger: this.logger ? this.logger.status() : null,
      lastError: this.lastError
    };
  }

  private pushState(): void {
    const state = this.buildState();
    this.panels.broadcast({ type: 'state', state });
    this.updateStatusBar();
  }

  private updateStatusBar(): void {
    const running = this.scheduler.running().length;
    const rec = this.logger ? ' $(record)' : '';
    if (this.serial.isOpen) {
      this.status.text = `$(plug) ${this.serial.path}${running ? ` · ${running} running` : ''}${rec}`;
      this.status.tooltip = this.logger
        ? `Serial Terminal Plus — connected, logging to ${this.logger.filePath}`
        : 'Serial Terminal Plus — connected';
      this.status.backgroundColor = undefined;
    } else {
      this.status.text = `$(debug-disconnect) Serial${rec}`;
      this.status.tooltip = 'Serial Terminal Plus — disconnected';
    }
  }

  private rebuildMatchers(): void {
    this.matchers = new Map();
    for (const cmd of this.store.all()) {
      const matcher = buildMatcher(cmd.id, cmd.response);
      if (matcher.error) {
        this.log('err', `Invalid response pattern for "${cmd.name}": ${matcher.error}`);
      }
      this.matchers.set(cmd.id, matcher);
    }
  }

  // ------------------------------------------------------------------ serial

  async refreshPorts(): Promise<void> {
    this.ports = await this.serial.listPorts();
    this.panels.post('terminal', { type: 'ports', ports: this.ports });
  }

  async connect(config?: Partial<PortConfig>): Promise<void> {
    if (config) {
      this.portConfig = { ...this.portConfig, ...config };
    }
    if (!this.portConfig.path) {
      await this.pickPort();
      if (!this.portConfig.path) {
        return;
      }
    }
    this.connecting = true;
    this.lastError = undefined;
    this.pushState();
    try {
      await this.serial.open(this.portConfig);
    } catch (err) {
      this.connecting = false;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.log('err', `Open failed: ${this.lastError}`);
      void vscode.window.showErrorMessage(`Serial Terminal+: ${this.lastError}`);
      this.pushState();
    }
  }

  async disconnect(): Promise<void> {
    this.scheduler.stopAll();
    await this.serial.close();
    this.pushState();
  }

  private async pickPort(): Promise<void> {
    await this.refreshPorts();
    const pick = await vscode.window.showQuickPick(
      this.ports.map((p) => ({
        label: p.path,
        description: p.friendlyName || p.manufacturer || ''
      })),
      { placeHolder: 'Select a serial port' }
    );
    if (pick) {
      this.portConfig.path = pick.label;
    }
  }

  private encodePayload(command: CommandDef): Buffer {
    const payload = command.payload || command.name;
    const ending = command.lineEnding === 'none' ? '' : command.lineEnding;
    if (command.encoding === 'hex') {
      const hex = payload.replace(/[^0-9a-fA-F]/g, '');
      const body = Buffer.from(hex.length % 2 ? '0' + hex : hex, 'hex');
      return Buffer.concat([body, Buffer.from(ending, 'ascii')]);
    }
    return Buffer.from(payload + ending, 'utf8');
  }

  private transmit(command: CommandDef): void {
    if (!this.serial.isOpen) {
      this.log('err', `Cannot send "${command.name}": port is not open.`);
      this.scheduler.stop(command.id);
      return;
    }
    try {
      this.serial.write(this.encodePayload(command));
      this.log('tx', command.payload || command.name);
    } catch (err) {
      this.log('err', err instanceof Error ? err.message : String(err));
      this.scheduler.stop(command.id);
    }
  }

  sendRaw(text: string): void {
    if (!this.serial.isOpen) {
      this.log('err', 'Cannot send: port is not open.');
      return;
    }
    const ending = this.lineEnding === 'none' ? '' : this.lineEnding;
    try {
      this.serial.write(Buffer.from(text + ending, 'utf8'));
      this.log('tx', text);
    } catch (err) {
      this.log('err', err instanceof Error ? err.message : String(err));
    }
  }

  private handleLine(line: string): void {
    this.log('rx', line);
    const samples = parseLine(line, this.store.all(), this.matchers);
    if (samples.length) {
      this.pendingSamples.push(...samples);
      this.scheduleFlush();
    }
  }

  private log(dir: LogEntry['dir'], text: string): void {
    this.pendingLogs.push({ dir, text, ts: Date.now() });
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, FLUSH_INTERVAL_MS);
  }

  private flush(): void {
    if (this.pendingLogs.length) {
      const logs = this.pendingLogs;
      this.pendingLogs = [];
      this.panels.post('terminal', { type: 'logs', logs });
      if (this.logger) {
        for (const entry of logs) {
          this.logger.appendLog(entry);
        }
      }
    }
    if (this.pendingSamples.length) {
      const samples = this.pendingSamples;
      this.pendingSamples = [];
      this.panels.post('response', { type: 'samples', samples });
      this.panels.post('graph', { type: 'samples', samples: samples.filter((s) => s.plot) });
      this.logger?.appendSamples(samples);
    }
  }

  // ------------------------------------------------------------ file logging

  private loggerSettings(): Omit<LoggerOptions, 'filePath'> {
    const cfg = vscode.workspace.getConfiguration('serialTerminalPlus');
    const kb = cfg.get<number>('logging.flushKiB') ?? 64;
    return {
      format: (cfg.get<LogFormat>('logging.format') ?? 'text'),
      flushBytes: Math.max(1, Math.min(4096, Math.trunc(kb))) * 1024,
      flushIntervalMs: Math.max(0, Math.trunc(cfg.get<number>('logging.flushIntervalMs') ?? 10000)),
      maxFileBytes: Math.max(0, Math.trunc(cfg.get<number>('logging.maxFileMiB') ?? 16)) * 1024 * 1024,
      maxFiles: Math.max(1, Math.trunc(cfg.get<number>('logging.maxFiles') ?? 5)),
      includeTx: cfg.get<boolean>('logging.includeTx') ?? true,
      includeRx: cfg.get<boolean>('logging.includeRx') ?? true,
      includeInfo: cfg.get<boolean>('logging.includeInfo') ?? true,
      includeSamples: cfg.get<boolean>('logging.includeSamples') ?? false,
      timestamps: cfg.get<boolean>('logging.timestamps') ?? true
    };
  }

  private defaultLogPath(format: LogFormat): string {
    const cfg = vscode.workspace.getConfiguration('serialTerminalPlus');
    const configured = (cfg.get<string>('logging.directory') ?? '').trim();
    const dir = configured || path.join(
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir(),
      'serial-logs'
    );
    const now = new Date();
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    const stamp =
      `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-` +
      `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
    const ext = format === 'csv' ? 'csv' : format === 'jsonl' ? 'jsonl' : 'log';
    const port = (this.serial.path || this.portConfig.path || 'serial').replace(/[^\w.-]+/g, '_');
    return path.join(dir, `${port}-${stamp}.${ext}`);
  }

  async startLogging(filePath?: string, overrides?: Partial<LoggerOptions>): Promise<void> {
    this.stopLogging(true);
    const settings = { ...DEFAULT_LOGGER_OPTIONS, ...this.loggerSettings(), ...overrides };
    const target = filePath?.trim() || this.defaultLogPath(settings.format);
    const options: LoggerOptions = { ...settings, filePath: target };

    try {
      const logger = new FileLogger(options, (message, isError) => {
        this.log(isError ? 'err' : 'info', message);
        this.pushState();
      });
      logger.start();
      this.logger = logger;
      this.loggerOptions = options;
      this.log(
        'info',
        `Logging to ${target} (${options.format}, buffered ${Math.round(options.flushBytes / 1024)} KiB / ` +
        `${Math.round(options.flushIntervalMs / 1000)} s)`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger = null;
      this.loggerOptions = null;
      this.log('err', `Could not start logging: ${message}`);
      void vscode.window.showErrorMessage(`Serial Terminal+: could not start logging — ${message}`);
    }
    this.pushState();
  }

  stopLogging(silent = false): void {
    const logger = this.logger;
    if (!logger) {
      return;
    }
    // Drain anything still queued in the hub before closing the file.
    this.flush();
    const status = logger.status();
    this.logger = null;
    logger.stop();
    if (!silent) {
      this.loggerOptions = null;
      this.log(
        'info',
        `Logging stopped — ${status.totalWritten + status.buffered} bytes in ${status.flushes + (status.buffered ? 1 : 0)} writes ` +
        `(${status.rotations} rotation${status.rotations === 1 ? '' : 's'}).`
      );
      this.pushState();
    }
  }

  async toggleLogging(): Promise<void> {
    if (this.logger) {
      this.stopLogging();
    } else {
      await this.startLogging();
    }
  }

  /** Forces buffered records to disk without stopping the session. */
  flushLog(): void {
    this.flush();
    this.logger?.flush();
    this.pushState();
  }

  async chooseLogFile(): Promise<void> {
    const format = (this.loggerOptions?.format ?? this.loggerSettings().format) as LogFormat;
    const uri = await vscode.window.showSaveDialog({
      saveLabel: 'Log to this file',
      defaultUri: vscode.Uri.file(this.defaultLogPath(format)),
      filters: { 'Log files': ['log', 'txt', 'csv', 'jsonl'] }
    });
    if (!uri) {
      return;
    }
    await this.startLogging(uri.fsPath);
  }

  async openLogFile(): Promise<void> {
    const target = this.logger?.filePath ?? this.loggerOptions?.filePath;
    if (!target) {
      void vscode.window.showInformationMessage('Serial Terminal+: no log file has been created yet.');
      return;
    }
    this.flushLog();
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  // --------------------------------------------------------------- scheduler

  startAll(): void {
    this.scheduler.startAll(this.store.all());
  }

  stopAll(): void {
    this.scheduler.stopAll();
  }

  // ------------------------------------------------------------ import/export

  async exportCommands(): Promise<void> {
    const uri = await vscode.window.showSaveDialog({
      filters: { JSON: ['json'] },
      saveLabel: 'Export commands',
      defaultUri: vscode.Uri.file('serial-commands.json')
    });
    if (!uri) {
      return;
    }
    const payload = JSON.stringify({ version: 1, commands: this.store.all() }, null, 2);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(payload, 'utf8'));
    void vscode.window.showInformationMessage(`Exported ${this.store.all().length} commands.`);
  }

  async importCommands(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      filters: { JSON: ['json'] },
      canSelectMany: false,
      openLabel: 'Import commands'
    });
    if (!uris?.length) {
      return;
    }
    try {
      const raw = await vscode.workspace.fs.readFile(uris[0]);
      const parsed = JSON.parse(Buffer.from(raw).toString('utf8'));
      const commands = Array.isArray(parsed) ? parsed : parsed.commands;
      if (!Array.isArray(commands)) {
        throw new Error('File does not contain a command array.');
      }
      this.store.replaceAll(commands);
      void vscode.window.showInformationMessage(`Imported ${commands.length} commands.`);
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Import failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // ---------------------------------------------------------- webview router

  private handleMessage(view: ViewId, message: any): void {
    switch (message?.type) {
      case 'listPorts':
        void this.refreshPorts();
        break;
      case 'connect':
        void this.connect(message.config);
        break;
      case 'disconnect':
        void this.disconnect();
        break;
      case 'send':
        this.sendRaw(String(message.text ?? ''));
        break;
      case 'sendOnce': {
        const cmd = this.store.get(message.id);
        if (cmd) {
          this.transmit(cmd);
        }
        break;
      }
      case 'toggleRun': {
        const cmd = this.store.get(message.id);
        if (!cmd) {
          break;
        }
        if (message.run) {
          this.scheduler.start(cmd);
        } else {
          this.scheduler.stop(cmd.id);
        }
        break;
      }
      case 'startAll':
        this.startAll();
        break;
      case 'stopAll':
        this.stopAll();
        break;
      case 'saveCommand': {
        const saved = this.store.save(normaliseCommand(message.command));
        if (this.scheduler.isRunning(saved.id)) {
          this.scheduler.start(saved);
        }
        break;
      }
      case 'deleteCommand':
        this.scheduler.stop(message.id, true);
        this.store.delete(message.id);
        break;
      case 'reorder':
        this.store.reorder(message.ids ?? []);
        break;
      case 'setLineEnding':
        this.lineEnding = decodeLineEnding(message.value);
        this.pushState();
        break;
      case 'openView':
        this.show(message.view as ViewId);
        break;
      case 'exportCommands':
        void this.exportCommands();
        break;
      case 'importCommands':
        void this.importCommands();
        break;
      case 'startLogging':
        void this.startLogging(message.filePath, message.options);
        break;
      case 'stopLogging':
        this.stopLogging();
        break;
      case 'toggleLogging':
        void this.toggleLogging();
        break;
      case 'chooseLogFile':
        void this.chooseLogFile();
        break;
      case 'flushLog':
        this.flushLog();
        break;
      case 'openLogFile':
        void this.openLogFile();
        break;
      case 'testPattern':
        this.panels.post(view, {
          type: 'testResult',
          id: message.id,
          result: this.testPattern(message.command, String(message.sample ?? ''))
        });
        break;
      case 'log':
        this.log(message.dir ?? 'info', String(message.text ?? ''));
        break;
      default:
        break;
    }
  }

  private testPattern(commandInput: Partial<CommandDef>, sample: string): {
    ok: boolean;
    error?: string;
    values?: { channel: number; label: string; value: number }[];
  } {
    const cmd = normaliseCommand(commandInput);
    const matcher = buildMatcher(cmd.id, cmd.response);
    if (matcher.error) {
      return { ok: false, error: matcher.error };
    }
    const samples = parseLine(sample, [cmd], new Map([[cmd.id, matcher]]));
    if (!samples.length) {
      return { ok: false, error: 'No match for the given sample line.' };
    }
    return {
      ok: true,
      values: samples.map((s) => ({ channel: s.channel, label: s.label, value: s.value }))
    };
  }

  dispose(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
    }
    // Drain the hub queues and close the log file without losing buffered data.
    this.flush();
    const logger = this.logger;
    this.logger = null;
    logger?.stop();
    this.scheduler.dispose();
    this.serial.dispose();
    this.panels.dispose();
    this.store.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function decodeLineEnding(value: string | undefined): LineEnding {
  switch (value) {
    case 'none':
      return 'none';
    case '\\n':
    case '\n':
      return '\n';
    case '\\r':
    case '\r':
      return '\r';
    case '\\r\\n':
    case '\r\n':
    default:
      return '\r\n';
  }
}
