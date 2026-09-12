/** Shared data model for Serial Terminal Plus. */

import type { LoggerStatus } from './logger';

export type Parity = 'none' | 'even' | 'odd' | 'mark' | 'space';
export type LineEnding = 'none' | '\n' | '\r' | '\r\n';
export type Encoding = 'ascii' | 'hex';

export const MAX_GRAPH_WINDOWS = 16;
export const SIMULATOR_PATH = 'SIMULATOR';

export interface PortConfig {
  path: string;
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  parity: Parity;
  stopBits: 1 | 1.5 | 2;
  rtscts: boolean;
  xon: boolean;
  xoff: boolean;
}

export interface ResponseSpec {
  /** `template` uses <command>/<chN>/<data> placeholders, `regex` is a raw JS regex. */
  mode: 'template' | 'regex';
  pattern: string;
  flags: string;
}

export interface CommandDef {
  id: string;
  name: string;
  /** Raw payload written to the port. Defaults to `name` when empty. */
  payload: string;
  encoding: Encoding;
  lineEnding: LineEnding;
  repeatMs: number;
  /** Auto-start this command when "Start All" is pressed. */
  enabled: boolean;
  plot: boolean;
  graphWindow: number;
  /** Channel numbers (1-based) that are extracted and shown/plotted. */
  channels: number[];
  channelLabels: Record<string, string>;
  response: ResponseSpec;
  color: string;
}

export interface Sample {
  commandId: string;
  commandName: string;
  channel: number;
  /** Stable series key: `<command>.ch<n>`. */
  series: string;
  label: string;
  value: number;
  ts: number;
  raw: string;
  window: number;
  color: string;
  plot: boolean;
}

export interface LogEntry {
  dir: 'rx' | 'tx' | 'info' | 'err';
  text: string;
  ts: number;
}

export interface HubState {
  connected: boolean;
  connecting: boolean;
  portConfig: PortConfig;
  ports: PortInfo[];
  commands: CommandDef[];
  running: string[];
  lineEnding: LineEnding;
  maxGraphWindows: number;
  maxPointsPerSeries: number;
  scrollback: number;
  serialAvailable: boolean;
  logger: LoggerStatus | null;
  lastError?: string;
}

export interface PortInfo {
  path: string;
  manufacturer?: string;
  friendlyName?: string;
  serialNumber?: string;
}

export const SERIES_COLORS = [
  '#4FC3F7', '#FF8A65', '#AED581', '#BA68C8',
  '#FFD54F', '#4DB6AC', '#F06292', '#9575CD',
  '#90A4AE', '#DCE775', '#64B5F6', '#FFB74D',
  '#81C784', '#E57373', '#7986CB', '#4DD0E1'
];

export function defaultPortConfig(): PortConfig {
  return {
    path: '',
    baudRate: 115200,
    dataBits: 8,
    parity: 'none',
    stopBits: 1,
    rtscts: false,
    xon: false,
    xoff: false
  };
}

export function defaultResponseSpec(): ResponseSpec {
  return {
    mode: 'template',
    pattern: 'or <COMMAND> ch1:<data> ch2:<data> ch3:<data> ch4:<data>',
    flags: 'i'
  };
}
