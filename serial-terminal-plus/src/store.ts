import * as vscode from 'vscode';
import {
  CommandDef,
  MAX_GRAPH_WINDOWS,
  SERIES_COLORS,
  defaultResponseSpec
} from './types';

const STORAGE_KEY = 'serialTerminalPlus.commands.v1';

function uid(): string {
  return 'cmd_' + Math.random().toString(36).slice(2, 10);
}

export function normaliseCommand(input: Partial<CommandDef>, index = 0): CommandDef {
  const channels = Array.isArray(input.channels)
    ? [...new Set(input.channels.map((c) => Math.trunc(Number(c))).filter((c) => c >= 1 && c <= 64))].sort((a, b) => a - b)
    : [1, 2, 3, 4];
  const name = (input.name || input.payload || 'CMD').trim();
  return {
    id: input.id || uid(),
    name,
    payload: (input.payload ?? name).toString(),
    encoding: input.encoding === 'hex' ? 'hex' : 'ascii',
    lineEnding: (['none', '\n', '\r', '\r\n'] as const).includes(input.lineEnding as any)
      ? (input.lineEnding as CommandDef['lineEnding'])
      : '\r\n',
    repeatMs: Math.max(0, Math.trunc(Number(input.repeatMs ?? 1000))),
    enabled: input.enabled !== false,
    plot: input.plot !== false,
    graphWindow: Math.min(MAX_GRAPH_WINDOWS - 1, Math.max(0, Math.trunc(Number(input.graphWindow ?? 0)))),
    channels: channels.length ? channels : [1],
    channelLabels: input.channelLabels && typeof input.channelLabels === 'object' ? { ...input.channelLabels } : {},
    response: {
      mode: input.response?.mode === 'regex' ? 'regex' : 'template',
      pattern: input.response?.pattern || defaultResponseSpec().pattern,
      flags: input.response?.flags ?? 'i'
    },
    color: input.color || SERIES_COLORS[index % SERIES_COLORS.length]
  };
}

function seedCommands(): CommandDef[] {
  return [
    normaliseCommand(
      {
        name: 'READ',
        payload: 'READ',
        repeatMs: 500,
        graphWindow: 0,
        channels: [1, 2, 3, 4],
        channelLabels: { '1': 'voltage', '2': 'current', '3': 'temp', '4': 'ramp' },
        response: { mode: 'template', pattern: 'or <COMMAND> ch1:<data> ch2:<data> ch3:<data> ch4:<data>', flags: 'i' }
      },
      0
    ),
    normaliseCommand(
      {
        name: 'STATUS',
        payload: 'STATUS',
        repeatMs: 1000,
        enabled: false,
        graphWindow: 1,
        channels: [1, 2],
        response: { mode: 'template', pattern: 'or <COMMAND> ch1:<data> ch2:<data> ch3:<data> ch4:<data>', flags: 'i' }
      },
      4
    )
  ];
}

export class CommandStore {
  private commands: CommandDef[];
  private readonly emitter = new vscode.EventEmitter<CommandDef[]>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly memento: vscode.Memento) {
    const stored = this.memento.get<CommandDef[]>(STORAGE_KEY);
    this.commands = Array.isArray(stored) && stored.length
      ? stored.map((c, i) => normaliseCommand(c, i))
      : seedCommands();
  }

  all(): CommandDef[] {
    return this.commands;
  }

  get(id: string): CommandDef | undefined {
    return this.commands.find((c) => c.id === id);
  }

  save(input: Partial<CommandDef>): CommandDef {
    const normalised = normaliseCommand(input, this.commands.length);
    const idx = this.commands.findIndex((c) => c.id === normalised.id);
    if (idx >= 0) {
      this.commands[idx] = normalised;
    } else {
      this.commands.push(normalised);
    }
    void this.persist();
    return normalised;
  }

  delete(id: string): void {
    this.commands = this.commands.filter((c) => c.id !== id);
    void this.persist();
  }

  replaceAll(commands: Partial<CommandDef>[]): void {
    this.commands = commands.map((c, i) => normaliseCommand(c, i));
    void this.persist();
  }

  reorder(ids: string[]): void {
    const map = new Map(this.commands.map((c) => [c.id, c]));
    const next: CommandDef[] = [];
    for (const id of ids) {
      const c = map.get(id);
      if (c) {
        next.push(c);
        map.delete(id);
      }
    }
    this.commands = [...next, ...map.values()];
    void this.persist();
  }

  private async persist(): Promise<void> {
    await this.memento.update(STORAGE_KEY, this.commands);
    this.emitter.fire(this.commands);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
