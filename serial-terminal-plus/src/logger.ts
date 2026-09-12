import * as fs from 'fs';
import * as path from 'path';
import { LogEntry, Sample } from './types';

export type LogFormat = 'text' | 'csv' | 'jsonl';

export interface LoggerOptions {
  filePath: string;
  format: LogFormat;
  /** Buffer this many bytes before touching the disk. Protects flash from per-sample writes. */
  flushBytes: number;
  /** Safety-net flush so a slow stream is not left in RAM forever. 0 disables it. */
  flushIntervalMs: number;
  /** Rotate to `name.1.ext` once the active file exceeds this size. 0 disables rotation. */
  maxFileBytes: number;
  maxFiles: number;
  includeTx: boolean;
  includeRx: boolean;
  includeInfo: boolean;
  includeSamples: boolean;
  timestamps: boolean;
}

export interface LoggerStatus {
  active: boolean;
  filePath: string;
  format: LogFormat;
  /** Bytes still waiting in RAM. */
  buffered: number;
  /** Bytes handed to the OS for the current file. */
  written: number;
  /** Total bytes since logging started, across rotations. */
  totalWritten: number;
  flushes: number;
  rotations: number;
  droppedBytes: number;
  lastFlushTs: number;
  error?: string;
}

export const DEFAULT_LOGGER_OPTIONS: Omit<LoggerOptions, 'filePath'> = {
  format: 'text',
  flushBytes: 64 * 1024,
  flushIntervalMs: 10000,
  maxFileBytes: 16 * 1024 * 1024,
  maxFiles: 5,
  includeTx: true,
  includeRx: true,
  includeInfo: true,
  includeSamples: false,
  timestamps: true
};

const CSV_HEADER = 'iso_time,epoch_ms,kind,command,channel,series,value,text\r\n';

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

function isoLocal(ts: number): string {
  const d = new Date(ts);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}

function csvField(value: unknown): string {
  const text = value === undefined || value === null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Buffered, append-only file logger.
 *
 * Records are accumulated in memory and handed to the OS only when the buffer
 * reaches `flushBytes` (default 64 KB), when the idle timer expires, or when
 * logging is stopped. This keeps a high-rate serial stream from issuing one
 * write syscall per line, which would cause unnecessary flash wear.
 */
export class FileLogger {
  private fd: number | null = null;
  private chunks: string[] = [];
  private buffered = 0;
  private written = 0;
  private totalWritten = 0;
  private flushes = 0;
  private rotations = 0;
  private droppedBytes = 0;
  private lastFlushTs = 0;
  private timer: NodeJS.Timeout | null = null;
  private lastError: string | undefined;
  private closing = false;

  constructor(private readonly options: LoggerOptions, private readonly onEvent: (message: string, isError: boolean) => void) {}

  get active(): boolean {
    return this.fd !== null && !this.closing;
  }

  get filePath(): string {
    return this.options.filePath;
  }

  start(): void {
    fs.mkdirSync(path.dirname(this.options.filePath), { recursive: true });
    this.openFile();
    const fresh = this.written === 0;

    if (this.options.format === 'csv' && fresh) {
      this.push(CSV_HEADER);
    } else if (this.options.format === 'text') {
      this.push(`# Serial Terminal Plus log — started ${isoLocal(Date.now())}\r\n`);
    }
    this.armTimer();
  }

  private openFile(): void {
    // Append mode, created if missing. The descriptor is kept open for the
    // whole session so each flush is a single write syscall.
    this.fd = fs.openSync(this.options.filePath, 'a');
    this.written = fs.fstatSync(this.fd).size;
  }

  private armTimer(): void {
    if (this.timer || this.options.flushIntervalMs <= 0) {
      return;
    }
    this.timer = setInterval(() => {
      if (this.buffered > 0) {
        this.flush();
      }
    }, this.options.flushIntervalMs);
    // Never hold the extension host open just for the log timer.
    this.timer.unref?.();
  }

  // ------------------------------------------------------------- record input

  appendLog(entry: LogEntry): void {
    if (!this.active) {
      return;
    }
    if (entry.dir === 'tx' && !this.options.includeTx) { return; }
    if (entry.dir === 'rx' && !this.options.includeRx) { return; }
    if ((entry.dir === 'info' || entry.dir === 'err') && !this.options.includeInfo) { return; }

    switch (this.options.format) {
      case 'csv':
        this.push(
          [
            csvField(isoLocal(entry.ts)),
            entry.ts,
            entry.dir,
            '', '', '', '',
            csvField(entry.text)
          ].join(',') + '\r\n'
        );
        break;
      case 'jsonl':
        this.push(JSON.stringify({ t: entry.ts, kind: entry.dir, text: entry.text }) + '\r\n');
        break;
      default: {
        const tag = entry.dir === 'rx' ? '<<' : entry.dir === 'tx' ? '>>' : entry.dir === 'err' ? '!!' : '--';
        const prefix = this.options.timestamps ? `${isoLocal(entry.ts)} ` : '';
        this.push(`${prefix}${tag} ${entry.text}\r\n`);
        break;
      }
    }
  }

  appendSamples(samples: Sample[]): void {
    if (!this.active || !this.options.includeSamples || samples.length === 0) {
      return;
    }
    for (const s of samples) {
      switch (this.options.format) {
        case 'csv':
          this.push(
            [
              csvField(isoLocal(s.ts)),
              s.ts,
              'sample',
              csvField(s.commandName),
              s.channel,
              csvField(s.series),
              s.value,
              ''
            ].join(',') + '\r\n'
          );
          break;
        case 'jsonl':
          this.push(
            JSON.stringify({
              t: s.ts,
              kind: 'sample',
              command: s.commandName,
              channel: s.channel,
              series: s.series,
              value: s.value
            }) + '\r\n'
          );
          break;
        default:
          this.push(
            `${this.options.timestamps ? `${isoLocal(s.ts)} ` : ''}== ${s.series} = ${s.value}\r\n`
          );
          break;
      }
    }
  }

  // --------------------------------------------------------------- buffering

  private push(text: string): void {
    this.chunks.push(text);
    this.buffered += Buffer.byteLength(text, 'utf8');
    if (this.buffered >= this.options.flushBytes) {
      this.flush();
    }
  }

  /** Writes the buffered records out as a single write syscall. */
  flush(): void {
    if (this.fd === null || this.buffered === 0) {
      return;
    }
    const payload = Buffer.from(this.chunks.join(''), 'utf8');
    const bytes = this.buffered;
    this.chunks = [];
    this.buffered = 0;

    try {
      let offset = 0;
      while (offset < payload.length) {
        offset += fs.writeSync(this.fd, payload, offset, payload.length - offset);
      }
      this.written += bytes;
      this.totalWritten += bytes;
      this.flushes += 1;
      this.lastFlushTs = Date.now();
      this.lastError = undefined;
    } catch (err) {
      this.droppedBytes += bytes;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.onEvent(`Log write failed: ${this.lastError}`, true);
      return;
    }

    if (this.options.maxFileBytes > 0 && this.written >= this.options.maxFileBytes) {
      this.rotate();
    }
  }

  private rotate(): void {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }

    const { filePath, maxFiles } = this.options;
    const ext = path.extname(filePath);
    const base = filePath.slice(0, filePath.length - ext.length);

    try {
      const oldest = `${base}.${maxFiles}${ext}`;
      if (fs.existsSync(oldest)) {
        fs.unlinkSync(oldest);
      }
      for (let i = maxFiles - 1; i >= 1; i--) {
        const from = `${base}.${i}${ext}`;
        if (fs.existsSync(from)) {
          fs.renameSync(from, `${base}.${i + 1}${ext}`);
        }
      }
      if (fs.existsSync(filePath)) {
        fs.renameSync(filePath, `${base}.1${ext}`);
      }
      this.rotations += 1;
      this.onEvent(`Log rotated (${this.rotations}) at ${this.written} bytes.`, false);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.onEvent(`Log rotation failed: ${this.lastError}`, true);
    }

    this.openFile();
    if (this.options.format === 'csv') {
      this.push(CSV_HEADER);
    }
  }

  status(): LoggerStatus {
    return {
      active: this.active,
      filePath: this.options.filePath,
      format: this.options.format,
      buffered: this.buffered,
      written: this.written,
      totalWritten: this.totalWritten,
      flushes: this.flushes,
      rotations: this.rotations,
      droppedBytes: this.droppedBytes,
      lastFlushTs: this.lastFlushTs,
      error: this.lastError
    };
  }

  /**
   * Flushes whatever is buffered and closes the file handle.
   * Fully synchronous, so it is safe to call from `deactivate()`.
   */
  stop(): void {
    if (this.closing) {
      return;
    }
    this.closing = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flush();
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // The descriptor is gone already; nothing left to do.
      }
      this.fd = null;
    }
  }
}
