import { CommandDef } from './types';

type SendFn = (command: CommandDef) => void;

/**
 * Owns one repeating timer per command. A command with `repeatMs <= 0`
 * is fired once and immediately considered stopped (one-shot).
 */
export class Scheduler {
  private timers = new Map<string, NodeJS.Timeout>();
  private disposed = false;

  constructor(private readonly send: SendFn, private readonly onChange: () => void) {}

  start(command: CommandDef): void {
    if (this.disposed) {
      return;
    }
    this.stop(command.id, true);
    this.send(command);
    if (command.repeatMs > 0) {
      const timer = setInterval(() => this.send(command), Math.max(10, command.repeatMs));
      this.timers.set(command.id, timer);
    }
    this.onChange();
  }

  stop(id: string, silent = false): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(id);
    }
    if (!silent) {
      this.onChange();
    }
  }

  stopAll(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
    this.onChange();
  }

  startAll(commands: CommandDef[]): void {
    for (const command of commands) {
      if (command.enabled) {
        this.start(command);
      }
    }
  }

  isRunning(id: string): boolean {
    return this.timers.has(id);
  }

  running(): string[] {
    return [...this.timers.keys()];
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }
}
