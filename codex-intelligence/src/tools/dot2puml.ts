/**
 * dot2puml.ts
 *
 * Deterministic PlantUML generators for flow and sequence diagrams,
 * built directly from ctags symbols + call-graph edges — the same data
 * already extracted for callgraph/*.dot. No LLM call involved, so these
 * are instant, free, and cannot hallucinate.
 *
 * Honesty note: cflow/ctags give us CALL order, not CONTROL flow
 * (if/else/loop branching isn't extractable from a call graph alone).
 * The flow diagram therefore shows call sequence with annotated callees
 * rather than fabricating branches we have no evidence for. The state
 * diagram (LLM-generated, in agentLoop.ts) is where real branching
 * judgment belongs, since it requires reading the source.
 */

export interface SymbolLike { name: string; line: number; }
export interface CallEdge { caller: string; callee: string; }

function sanitiseAlias(name: string): string {
  // PlantUML participant/activity identifiers must be alphanumeric/underscore
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

function isExtern(name: string, externLeafPrefixes: string[]): boolean {
  return externLeafPrefixes.some(p => name.startsWith(p));
}

/** Activity diagram: one block per function, in declaration order, with
 *  a note listing its direct callees. Deterministic — no branching shown. */
export function generateFlowPuml(
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
  const lines: string[] = [
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

/** Sequence diagram: one participant per function involved (caller or
 *  callee), extern/vendor participants marked <<extern>>, one arrow per
 *  call edge in the order cflow/ctags discovered them. Deterministic. */
export function generateSequencePuml(
  moduleLabel: string,
  symbols: SymbolLike[],
  calls: CallEdge[],
  externLeafPrefixes: string[]
): string {
  const knownNames = new Set(symbols.map(s => s.name));
  const participants = new Map<string, { alias: string; extern: boolean }>();

  function ensureParticipant(name: string): { alias: string; extern: boolean } {
    if (!participants.has(name)) {
      participants.set(name, {
        alias: sanitiseAlias(name),
        extern: !knownNames.has(name) || isExtern(name, externLeafPrefixes)
      });
    }
    return participants.get(name)!;
  }

  // Register in declaration order first (so the diagram lists this file's
  // own functions before any extern participants), then any extern callees.
  for (const sym of [...symbols].sort((a, b) => a.line - b.line)) {
    ensureParticipant(sym.name);
  }
  for (const { callee } of calls) { ensureParticipant(callee); }

  const lines: string[] = [
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
    const c = ensureParticipant(caller);
    const e = ensureParticipant(callee);
    lines.push(`${c.alias} -> ${e.alias}: ${callee}()`);
  }

  lines.push('@enduml');
  return lines.join('\n');
}
