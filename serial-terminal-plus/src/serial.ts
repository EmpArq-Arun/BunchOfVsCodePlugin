import { EventEmitter } from 'events';
import { PortConfig, PortInfo, SIMULATOR_PATH } from './types';

type SerialPortModule = {
  SerialPort: any;
};

let cachedModule: SerialPortModule | null | undefined;

function loadSerialPort(): SerialPortModule | null {
  if (cachedModule !== undefined) {
    return cachedModule;
  }
  try {
    // Loaded lazily so the extension still works (simulator only) when the
    // native binding is missing or was built for a different Electron ABI.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cachedModule = require('serialport') as SerialPortModule;
  } catch {
    cachedModule = null;
  }
  return cachedModule;
}

export function isSerialAvailable(): boolean {
  return loadSerialPort() !== null;
}

/**
 * Deterministic-ish waveform generator used by the SIMULATOR port so the whole
 * workbench (terminal / response / plot) can be exercised without hardware.
 */
class Simulator {
  private readonly t0 = Date.now();
  private counters = new Map<string, number>();

  respond(line: string): string | null {
    const name = line.trim().split(/\s+/)[0];
    if (!name) {
      return null;
    }
    const n = (this.counters.get(name) ?? 0) + 1;
    this.counters.set(name, n);
    const t = (Date.now() - this.t0) / 1000;
    const seed = [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 17;
    const ch1 = (Math.sin(t * (0.5 + seed * 0.05)) * 100).toFixed(3);
    const ch2 = (Math.cos(t * 0.8) * 50 + 25).toFixed(3);
    const ch3 = (Math.random() * 10 + seed).toFixed(3);
    const ch4 = ((n % 200) * 0.5).toFixed(3);
    return `or ${name.toUpperCase()} ch1:${ch1} ch2:${ch2} ch3:${ch3} ch4:${ch4}`;
  }
}

export interface SerialEvents {
  line: (line: string) => void;
  raw: (chunk: Buffer) => void;
  open: () => void;
  close: () => void;
  error: (err: Error) => void;
}

export class SerialConnection extends EventEmitter {
  private port: any = null;
  private simulator: Simulator | null = null;
  private simTimers = new Set<NodeJS.Timeout>();
  private buffer = '';
  private currentPath = '';

  get isOpen(): boolean {
    return this.simulator !== null || (this.port !== null && this.port.isOpen === true);
  }

  get path(): string {
    return this.currentPath;
  }

  async listPorts(): Promise<PortInfo[]> {
    const ports: PortInfo[] = [{ path: SIMULATOR_PATH, friendlyName: 'Simulator (no hardware)' }];
    const mod = loadSerialPort();
    if (!mod) {
      return ports;
    }
    try {
      const found = await mod.SerialPort.list();
      for (const p of found) {
        ports.push({
          path: p.path,
          manufacturer: p.manufacturer,
          friendlyName: p.friendlyName || p.pnpId,
          serialNumber: p.serialNumber
        });
      }
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
    return ports;
  }

  async open(config: PortConfig): Promise<void> {
    await this.close();
    this.buffer = '';
    this.currentPath = config.path;

    if (config.path === SIMULATOR_PATH) {
      this.simulator = new Simulator();
      this.emit('open');
      return;
    }

    const mod = loadSerialPort();
    if (!mod) {
      throw new Error(
        'The native "serialport" module is not available. Run `npm install` in the extension folder, ' +
        'or use the SIMULATOR port.'
      );
    }

    await new Promise<void>((resolve, reject) => {
      const port = new mod.SerialPort(
        {
          path: config.path,
          baudRate: Number(config.baudRate),
          dataBits: Number(config.dataBits),
          parity: config.parity,
          stopBits: Number(config.stopBits),
          rtscts: !!config.rtscts,
          xon: !!config.xon,
          xoff: !!config.xoff,
          autoOpen: false
        },
        (err: Error | null) => {
          if (err) {
            reject(err);
          }
        }
      );

      port.on('data', (chunk: Buffer) => this.handleChunk(chunk));
      port.on('error', (err: Error) => this.emit('error', err));
      port.on('close', () => {
        this.port = null;
        this.emit('close');
      });

      port.open((err: Error | null) => {
        if (err) {
          reject(err);
          return;
        }
        this.port = port;
        this.emit('open');
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    for (const timer of this.simTimers) {
      clearTimeout(timer);
    }
    this.simTimers.clear();

    if (this.simulator) {
      this.simulator = null;
      this.currentPath = '';
      this.emit('close');
      return;
    }
    const port = this.port;
    this.port = null;
    this.currentPath = '';
    if (!port) {
      return;
    }
    await new Promise<void>((resolve) => {
      if (!port.isOpen) {
        resolve();
        return;
      }
      port.close(() => resolve());
    });
    this.emit('close');
  }

  write(data: Buffer | string): void {
    if (this.simulator) {
      const text = typeof data === 'string' ? data : data.toString('utf8');
      const reply = this.simulator.respond(text);
      if (reply) {
        const timer = setTimeout(() => {
          this.simTimers.delete(timer);
          this.handleChunk(Buffer.from(reply + '\r\n', 'utf8'));
        }, 25 + Math.random() * 25);
        this.simTimers.add(timer);
      }
      return;
    }
    if (!this.port || !this.port.isOpen) {
      throw new Error('Port is not open.');
    }
    this.port.write(data);
  }

  private handleChunk(chunk: Buffer): void {
    this.emit('raw', chunk);
    this.buffer += chunk.toString('utf8');
    // Keep an unterminated tail in the buffer, but never let it grow unbounded.
    if (this.buffer.length > 1_000_000) {
      this.buffer = this.buffer.slice(-100_000);
    }
    const parts = this.buffer.split(/\r\n|\n|\r/);
    this.buffer = parts.pop() ?? '';
    for (const line of parts) {
      this.emit('line', line);
    }
  }

  dispose(): void {
    void this.close();
    this.removeAllListeners();
  }
}
