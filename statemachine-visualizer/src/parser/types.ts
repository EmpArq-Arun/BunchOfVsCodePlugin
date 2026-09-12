// Core data model shared by the parser, sidebar, and webview.
// Kept dependency-free (no `vscode` import) so it can also be loaded
// conceptually on the webview side via the JSON message payload.

export interface SourceLocation {
  /** Workspace-relative or absolute file path */
  file: string;
  /** 1-based line number */
  line: number;
}

export interface StateNode {
  /** The literal enum identifier, e.g. STATE_IDLE */
  name: string;
  /** Numeric or expression value if explicitly assigned in the enum, e.g. "0" or "1 << 2" */
  value?: string;
  isInitial?: boolean;
  location: SourceLocation;
}

export type TransitionKind = 'switch-case' | 'if-else' | 'dispatch-table' | 'unknown';

export interface Transition {
  from: string; // enum identifier
  to: string;   // enum identifier
  /** Short human-readable label: guard condition and/or action call, e.g. "on EVENT_TIMEOUT -> stopTimer()" */
  label?: string;
  kind: TransitionKind;
  location: SourceLocation;
}

export type IODirection = 'input' | 'output' | 'shared' | 'dependency';

export type IOMechanism =
  | 'function-call-in'      // another module calls a function defined here
  | 'function-call-out'     // this module calls a function defined elsewhere
  | 'callback-registration' // a function pointer / callback field assigned
  | 'class-extension'       // C++ base/derived relationship
  | 'global-variable'       // shared global / extern variable
  | 'getter'
  | 'setter'
  | 'include';              // #include dependency

export interface IOPort {
  name: string;
  direction: IODirection;
  mechanism: IOMechanism;
  /** e.g. function signature, variable type, or header name */
  detail?: string;
  location: SourceLocation;
}

export interface StateMachine {
  id: string;             // stable id, e.g. file path + enum name
  name: string;           // enum type name, used as the SM's display name
  file: string;
  enumName: string;
  stateVariable?: string; // the variable of the enum type that holds current state
  states: StateNode[];
  transitions: Transition[];
  io: IOPort[];
  /** confidence 0-1 heuristic gives itself based on how much it could resolve */
  confidence: number;
  detectionKind: TransitionKind;
}

export interface ScanResult {
  machines: StateMachine[];
  filesScanned: number;
  errors: { file: string; message: string }[];
}
