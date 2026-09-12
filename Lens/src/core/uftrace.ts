/**
 * uftrace ingest.
 *
 * `uftrace replay` output is the dynamic sequence plane: what actually ran, in
 * order, nested. It is the counterpart to the static call graph, and the gap
 * between the two is where the learning is — static analysis says a virtual call
 * may reach any of five overriders; the trace says which one it did.
 *
 * uftrace runs on Linux userspace only, so on firmware this is the host
 * unit-test and simulation build. The same event shape is produced by an
 * on-target `-finstrument-functions` decoder, which is why `TraceEvent` is
 * deliberately free of anything uftrace-specific.
 *
 * Format, from real output:
 *
 *   # DURATION     TID     FUNCTION
 *               [   534] | main() {
 *      0.059 us [   534] |   fw::Registry::Registry();
 *    287.132 us [   534] | } /* main *\/
 *
 * Names arrive already demangled. Duration is blank on an entry that has
 * children and reported on its exit line instead.
 */

export interface TraceEvent {
  kind: 'enter' | 'exit' | 'leaf';
  name: string;
  depth: number;
  tid: number;
  /** Microseconds. Present on leaf and exit lines. */
  durationUs?: number;
}

export interface TraceStream {
  events: TraceEvent[];
  tids: number[];
  /** Lines the parser did not recognise, kept so silence never means success. */
  skipped: number;
}

const LINE = /^\s*(?:([\d.]+)\s*(us|ms|ns|s))?\s*\[\s*(\d+)\]\s*\|(\s*)(.*)$/;

const UNIT_TO_US: Record<string, number> = { ns: 0.001, us: 1, ms: 1000, s: 1_000_000 };

export function parseUftrace(text: string): TraceStream {
  const events: TraceEvent[] = [];
  const tids = new Set<number>();
  let skipped = 0;

  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    if (raw.trim().length === 0 || raw.trimStart().startsWith('#')) {
      continue;
    }
    const m = LINE.exec(raw);
    if (!m) {
      skipped += 1;
      continue;
    }
    const [, value, unit, tidText, indent, body] = m;
    const tid = Number(tidText);
    tids.add(tid);
    // Indentation is two spaces per nesting level, after the bar.
    const depth = Math.max(0, Math.floor((indent.length - 1) / 2));
    const durationUs = value !== undefined ? Number(value) * (UNIT_TO_US[unit ?? 'us'] ?? 1) : undefined;

    const exit = /^\}\s*\/\*\s*(.+?)\s*\*\/\s*$/.exec(body);
    if (exit) {
      events.push({ kind: 'exit', name: exit[1], depth, tid, ...(durationUs !== undefined ? { durationUs } : {}) });
      continue;
    }
    const enter = /^(.+?)\(\)\s*\{\s*$/.exec(body);
    if (enter) {
      events.push({ kind: 'enter', name: enter[1], depth, tid, ...(durationUs !== undefined ? { durationUs } : {}) });
      continue;
    }
    const leaf = /^(.+?)\(\)\s*;\s*$/.exec(body);
    if (leaf) {
      events.push({ kind: 'leaf', name: leaf[1], depth, tid, ...(durationUs !== undefined ? { durationUs } : {}) });
      continue;
    }
    skipped += 1;
  }

  return { events, tids: [...tids].sort((a, b) => a - b), skipped };
}

export interface TraceCall {
  name: string;
  depth: number;
  tid: number;
  durationUs?: number;
  children: TraceCall[];
}

/**
 * Rebuild the call tree from the flat event stream.
 *
 * An unmatched exit is tolerated rather than fatal: a trace truncated by a reset
 * or a buffer overrun is the normal case on real hardware, and half a sequence
 * is still worth reading.
 */
export function buildTraceTree(stream: TraceStream, tid?: number): TraceCall[] {
  const roots: TraceCall[] = [];
  const stack: TraceCall[] = [];

  for (const e of stream.events) {
    if (tid !== undefined && e.tid !== tid) {
      continue;
    }
    if (e.kind === 'exit') {
      const done = stack.pop();
      if (done && e.durationUs !== undefined) {
        done.durationUs = e.durationUs;
      }
      continue;
    }
    const call: TraceCall = {
      name: e.name,
      depth: e.depth,
      tid: e.tid,
      ...(e.durationUs !== undefined ? { durationUs: e.durationUs } : {}),
      children: [],
    };
    const parent = stack[stack.length - 1];
    if (parent) {
      parent.children.push(call);
    } else {
      roots.push(call);
    }
    if (e.kind === 'enter') {
      stack.push(call);
    }
  }
  return roots;
}

/** Flatten a tree back into the order calls were made, for sequence rendering. */
export function flattenTrace(calls: TraceCall[]): TraceCall[] {
  const out: TraceCall[] = [];
  const walk = (list: TraceCall[]) => {
    for (const c of list) {
      out.push(c);
      walk(c.children);
    }
  };
  walk(calls);
  return out;
}

/** Total time attributed to each function, and how often it ran. */
export function traceHotspots(calls: TraceCall[]): { name: string; totalUs: number; calls: number }[] {
  const totals = new Map<string, { totalUs: number; calls: number }>();
  for (const c of flattenTrace(calls)) {
    const hit = totals.get(c.name) ?? { totalUs: 0, calls: 0 };
    hit.totalUs += c.durationUs ?? 0;
    hit.calls += 1;
    totals.set(c.name, hit);
  }
  return [...totals.entries()]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.totalUs - a.totalUs);
}
