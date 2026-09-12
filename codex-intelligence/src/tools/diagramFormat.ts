/**
 * diagramFormat.ts
 *
 * Single source of truth for diagram rendering in both PlantUML and
 * Mermaid, selected by the codex.diagramFormat setting (R1).
 *
 * The deterministic generators (flow, sequence) live here and emit either
 * syntax from the same call-graph data. LLM-generated diagrams (state,
 * behaviour) instead receive a format-specific prompt fragment + example,
 * exported as promptSpecFor() below.
 *
 * No vscode dependency — directly unit-testable.
 */

export type DiagramFormat = 'plantuml' | 'mermaid';

export interface SymbolLike { name: string; line: number; }
export interface CallEdge { caller: string; callee: string; }

export function fileExtensionFor(format: DiagramFormat): string {
  return format === 'mermaid' ? '.mmd' : '.puml';
}

function sanitiseAlias(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

function isExtern(name: string, externLeafPrefixes: string[]): boolean {
  return externLeafPrefixes.some(p => name.startsWith(p));
}

// ── Flow diagram ───────────────────────────────────────────────────
// Honesty constraint (unchanged from the PlantUML-only version):
// ctags/cflow give CALL ORDER, not CONTROL FLOW. We show call sequence
// with annotated callees and never fabricate if/else branches.

export function generateFlow(
  format: DiagramFormat,
  moduleLabel: string,
  symbols: SymbolLike[],
  calls: CallEdge[],
  externLeafPrefixes: string[]
): string {
  const calleesOf = new Map<string, string[]>();
  for (const { caller, callee } of calls) {
    if (!calleesOf.has(caller)) { calleesOf.set(caller, []); }
    calleesOf.get(caller)!.push(callee);
  }
  const ordered = [...symbols].sort((a, b) => a.line - b.line);

  if (format === 'mermaid') {
    const lines = [
      '```mermaid',
      'flowchart TD',
      `  start(["${moduleLabel} — call flow"])`
    ];
    let prev = 'start';
    for (const sym of ordered) {
      const id = sanitiseAlias(sym.name);
      const callees = calleesOf.get(sym.name) ?? [];
      const note = callees.length
        ? `<br/><small>calls ${callees.map(c => isExtern(c, externLeafPrefixes) ? `${c} [extern]` : c).join(', ')}</small>`
        : '';
      lines.push(`  ${id}["${sym.name}${note}"]`);
      lines.push(`  ${prev} --> ${id}`);
      prev = id;
    }
    lines.push(`  ${prev} --> done([end])`);
    lines.push('```');
    return lines.join('\n');
  }

  const lines = [
    '@startuml',
    '!pragma layout smetana',
    'skinparam monochrome true',
    'skinparam shadowing false',
    `title ${moduleLabel} — call flow (deterministic, from call graph)`,
    '',
    'start'
  ];
  for (const sym of ordered) {
    lines.push(`:${sym.name};`);
    const callees = calleesOf.get(sym.name) ?? [];
    if (callees.length > 0) {
      const annotated = callees.map(c => isExtern(c, externLeafPrefixes) ? `${c} [extern]` : c);
      lines.push(`note right: calls ${annotated.join(', ')}`);
    }
  }
  lines.push('stop', '@enduml');
  return lines.join('\n');
}

// ── Sequence diagram ───────────────────────────────────────────────

export function generateSequence(
  format: DiagramFormat,
  moduleLabel: string,
  symbols: SymbolLike[],
  calls: CallEdge[],
  externLeafPrefixes: string[]
): string {
  const knownNames = new Set(symbols.map(s => s.name));
  const participants = new Map<string, { alias: string; extern: boolean }>();

  function ensure(name: string) {
    if (!participants.has(name)) {
      participants.set(name, {
        alias: sanitiseAlias(name),
        extern: !knownNames.has(name) || isExtern(name, externLeafPrefixes)
      });
    }
    return participants.get(name)!;
  }

  for (const sym of [...symbols].sort((a, b) => a.line - b.line)) { ensure(sym.name); }
  for (const { callee } of calls) { ensure(callee); }

  if (format === 'mermaid') {
    const lines = ['```mermaid', 'sequenceDiagram'];
    for (const [name, info] of participants) {
      const label = info.extern ? `${name} [extern]` : name;
      lines.push(`  participant ${info.alias} as ${label}`);
    }
    for (const { caller, callee } of calls) {
      lines.push(`  ${ensure(caller).alias}->>${ensure(callee).alias}: ${callee}()`);
    }
    lines.push('```');
    return lines.join('\n');
  }

  const lines = [
    '@startuml',
    '!pragma layout smetana',
    'skinparam monochrome true',
    'skinparam shadowing false',
    `title ${moduleLabel} — sequence (deterministic, from call graph)`,
    ''
  ];
  for (const [name, info] of participants) {
    lines.push(`participant ${info.alias}${info.extern ? ' <<extern>>' : ''} as "${name}"`);
  }
  lines.push('');
  for (const { caller, callee } of calls) {
    lines.push(`${ensure(caller).alias} -> ${ensure(callee).alias}: ${callee}()`);
  }
  lines.push('@enduml');
  return lines.join('\n');
}

// ── Prompt specs for LLM-generated diagrams (state, behaviour) ──────

export interface PromptSpec {
  /** Format name to use in the instruction text */
  name: string;
  /** Exact opening/closing tokens the model must produce */
  openToken: string;
  closeToken: string;
  /** A short syntax example, keeps small local models on-format */
  stateExample: string;
  componentExample: string;
}

export function promptSpecFor(format: DiagramFormat): PromptSpec {
  if (format === 'mermaid') {
    return {
      name: 'Mermaid',
      openToken: '```mermaid',
      closeToken: '```',
      stateExample:
        '```mermaid\nstateDiagram-v2\n  [*] --> IDLE\n  IDLE --> BUSY: start() called\n  BUSY --> IDLE: HAL_Done() [extern]\n  BUSY --> ERROR: timeout\n  ERROR --> IDLE: reset()\n```',
      componentExample:
        '```mermaid\nflowchart LR\n  subgraph app[Application]\n    A[uart_driver]\n  end\n  subgraph vendor[Vendor HAL - extern]\n    B[HAL_UART]\n  end\n  A -->|transmit| B\n```'
    };
  }
  return {
    name: 'PlantUML',
    openToken: '@startuml',
    closeToken: '@enduml',
    stateExample:
      '@startuml\n[*] --> IDLE\nIDLE --> BUSY : start() called\nBUSY --> IDLE : HAL_Done() [extern]\nBUSY --> ERROR : timeout\nERROR --> IDLE : reset()\n@enduml',
    componentExample:
      '@startuml\npackage "Application" {\n  [uart_driver]\n}\npackage "Vendor HAL" <<extern>> {\n  [HAL_UART]\n}\n[uart_driver] --> [HAL_UART] : transmit\n@enduml'
  };
}

/** Strips stray prose/fences a small model may wrap around the diagram,
 *  keeping only the content between the format's open/close tokens. */
export function extractDiagram(raw: string, format: DiagramFormat): string {
  const spec = promptSpecFor(format);
  const text = raw.trim();

  if (format === 'mermaid') {
    const fenced = text.match(/```mermaid\s*([\s\S]*?)```/);
    if (fenced) { return '```mermaid\n' + fenced[1].trim() + '\n```'; }
    const bare = text.replace(/```/g, '').trim();
    return '```mermaid\n' + bare + '\n```';
  }

  const start = text.indexOf(spec.openToken);
  const end   = text.lastIndexOf(spec.closeToken);
  if (start !== -1 && end !== -1 && end > start) {
    return text.slice(start, end + spec.closeToken.length);
  }
  return text.replace(/```/g, '').trim();
}
