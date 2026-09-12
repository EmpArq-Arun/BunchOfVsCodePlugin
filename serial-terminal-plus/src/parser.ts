import { CommandDef, ResponseSpec, Sample, SERIES_COLORS } from './types';

/** Numeric token: signed int/float with optional exponent. */
const NUMBER = '[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?';
const HEXNUM = '(?:0[xX])?[0-9a-fA-F]+';

export interface DataBinding {
  group: string;
  channel: number;
  kind: 'number' | 'hex';
}

export interface Matcher {
  commandId: string;
  regex: RegExp;
  bindings: DataBinding[];
  hasCommandGroup: boolean;
  error?: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compiles a human friendly template such as
 *   `or <COMMAND> ch1:<data> ch2:<data> ch3:<data> ch4:<data>`
 * into a regular expression with named capture groups.
 *
 * Supported placeholders:
 *   <command> | <cmd>          echoed command name
 *   <data> | <value>           next free channel, numeric
 *   <ch3> | <channel3>         explicit channel binding, numeric
 *   <hex> | <hexN>             hexadecimal value
 *   <any> | <*>                ignored filler
 */
export function compileTemplate(template: string): { source: string; bindings: DataBinding[]; hasCommandGroup: boolean } {
  const bindings: DataBinding[] = [];
  const used = new Set<number>();
  let hasCommandGroup = false;
  let groupIndex = 0;
  let out = '';

  const nextFreeChannel = (): number => {
    let c = 1;
    while (used.has(c)) {
      c++;
    }
    return c;
  };

  const bind = (channel: number, kind: 'number' | 'hex'): string => {
    groupIndex++;
    const group = `d${groupIndex}`;
    used.add(channel);
    bindings.push({ group, channel, kind });
    return `(?<${group}>${kind === 'hex' ? HEXNUM : NUMBER})`;
  };

  const tokens = template.split(/(<[^<>]*>)/g);
  for (const token of tokens) {
    if (!token) {
      continue;
    }
    if (token.startsWith('<') && token.endsWith('>')) {
      const name = token.slice(1, -1).trim().toLowerCase();
      if (name === 'cmd' || name.startsWith('command')) {
        hasCommandGroup = true;
        out += '(?<cmd>[^\\s]+)';
        continue;
      }
      const explicit = /^(?:ch|channel)\s*(\d+)$/.exec(name);
      if (explicit) {
        out += bind(Number(explicit[1]), 'number');
        continue;
      }
      const hexExplicit = /^hex\s*(\d+)?$/.exec(name);
      if (hexExplicit) {
        out += bind(hexExplicit[1] ? Number(hexExplicit[1]) : nextFreeChannel(), 'hex');
        continue;
      }
      if (name === 'any' || name === '*' || name === 'skip') {
        out += '.*?';
        continue;
      }
      // data / value / num / anything else -> next free channel
      out += bind(nextFreeChannel(), 'number');
      continue;
    }
    // Literal chunk: escape, but make runs of whitespace flexible.
    out += escapeRegExp(token).replace(/(?:\\?\s)+/g, '\\s+');
  }

  return { source: out, bindings, hasCommandGroup };
}

export function buildMatcher(commandId: string, spec: ResponseSpec): Matcher {
  const flags = normaliseFlags(spec.flags);
  try {
    if (spec.mode === 'regex') {
      const regex = new RegExp(spec.pattern, flags);
      const bindings = inferRegexBindings(spec.pattern);
      return {
        commandId,
        regex,
        bindings,
        hasCommandGroup: /\(\?<cmd>/.test(spec.pattern)
      };
    }
    const { source, bindings, hasCommandGroup } = compileTemplate(spec.pattern);
    return { commandId, regex: new RegExp(source, flags), bindings, hasCommandGroup };
  } catch (err) {
    return {
      commandId,
      regex: /$^/,
      bindings: [],
      hasCommandGroup: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

/** Raw regexes may use `(?<d1>)`/`(?<ch1>)` named groups or fall back to positional groups. */
function inferRegexBindings(pattern: string): DataBinding[] {
  const bindings: DataBinding[] = [];
  const named = pattern.matchAll(/\(\?<((?:d|ch|channel)(\d+))>/g);
  for (const m of named) {
    bindings.push({ group: m[1], channel: Number(m[2]), kind: 'number' });
  }
  if (bindings.length > 0) {
    return bindings;
  }
  // Positional groups: group 1 -> channel 1, etc.
  const groupCount = countCaptureGroups(pattern);
  for (let i = 1; i <= groupCount; i++) {
    bindings.push({ group: String(i), channel: i, kind: 'number' });
  }
  return bindings;
}

function countCaptureGroups(pattern: string): number {
  let count = 0;
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '\\') {
      i++;
      continue;
    }
    if (pattern[i] === '(' && pattern[i + 1] !== '?') {
      count++;
    }
  }
  return count;
}

function normaliseFlags(flags: string): string {
  const allowed = new Set(['i', 'm', 's', 'u']);
  const out = new Set<string>();
  for (const f of flags || '') {
    if (allowed.has(f)) {
      out.add(f);
    }
  }
  return [...out].join('');
}

function toNumber(raw: string, kind: 'number' | 'hex'): number {
  if (kind === 'hex') {
    return parseInt(raw.replace(/^0[xX]/, ''), 16);
  }
  return Number(raw);
}

export function channelLabel(cmd: CommandDef, channel: number): string {
  return cmd.channelLabels?.[String(channel)] || `ch${channel}`;
}

export function seriesColor(cmd: CommandDef, channel: number): string {
  if (cmd.color && cmd.channels.length <= 1) {
    return cmd.color;
  }
  const idx = Math.max(0, cmd.channels.indexOf(channel));
  const base = SERIES_COLORS.indexOf(cmd.color);
  const offset = base >= 0 ? base : 0;
  return SERIES_COLORS[(offset + idx) % SERIES_COLORS.length];
}

/**
 * Applies every enabled matcher to one received line and returns the samples found.
 * A line can feed several commands (useful for shared/broadcast responses).
 */
export function parseLine(
  line: string,
  commands: CommandDef[],
  matchers: Map<string, Matcher>
): Sample[] {
  const trimmed = line.trim();
  if (!trimmed) {
    return [];
  }
  const samples: Sample[] = [];
  const ts = Date.now();

  for (const cmd of commands) {
    const matcher = matchers.get(cmd.id);
    if (!matcher || matcher.error) {
      continue;
    }
    matcher.regex.lastIndex = 0;
    const match = matcher.regex.exec(trimmed);
    if (!match) {
      continue;
    }
    if (matcher.hasCommandGroup) {
      const echoed = (match.groups?.cmd || '').trim();
      const expected = (cmd.name || cmd.payload).trim();
      if (echoed.toLowerCase() !== expected.toLowerCase() &&
          echoed.toLowerCase() !== cmd.payload.trim().toLowerCase()) {
        continue;
      }
    }

    const selected = cmd.channels.length > 0 ? new Set(cmd.channels) : null;
    for (const binding of matcher.bindings) {
      if (selected && !selected.has(binding.channel)) {
        continue;
      }
      const raw = /^\d+$/.test(binding.group)
        ? match[Number(binding.group)]
        : match.groups?.[binding.group];
      if (raw === undefined) {
        continue;
      }
      const value = toNumber(raw, binding.kind);
      if (!Number.isFinite(value)) {
        continue;
      }
      samples.push({
        commandId: cmd.id,
        commandName: cmd.name || cmd.payload,
        channel: binding.channel,
        series: `${cmd.name || cmd.payload}.ch${binding.channel}`,
        label: channelLabel(cmd, binding.channel),
        value,
        ts,
        raw: trimmed,
        window: cmd.graphWindow,
        color: seriesColor(cmd, binding.channel),
        plot: cmd.plot
      });
    }
  }

  return samples;
}
