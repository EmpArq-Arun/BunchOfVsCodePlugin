import type { Finding, Severity } from './constructs.js';
import type { JournalEntry } from './model.js';

/**
 * Narrative.
 *
 * Turns the accumulated findings into a document a person can read start to
 * finish: "the C++ in this module, explained". The audience is a C engineer
 * arriving at the codebase, which includes you in six months.
 *
 * Two constraints shape it.
 *
 * The primer is assembled from findings that were actually computed, never from
 * general knowledge about C++. Every claim traces to something a lens measured
 * in this codebase, and the manifest at the end says exactly which lenses ran
 * and what they read. A primer that quietly mixes in textbook material would be
 * more fluent and less trustworthy, and trustworthiness is the entire product.
 *
 * Second, the journal comes first. Notes a human wrote outrank anything
 * generated, because they carry the thing no analysis can: what actually
 * confused a person, and what resolved it.
 */

export interface LensRun {
  lens: string;
  /** What it read, in the user's terms — file paths, binaries, trace files. */
  inputs: string[];
  ran: boolean;
  /** Why it did not run, when it did not. */
  skipped?: string;
  findingCount: number;
}

export interface PrimerInput {
  module: string;
  findings: Finding[];
  journal: JournalEntry[];
  runs: LensRun[];
  generatedAt: Date;
}

const SEVERITY_HEADING: Record<Severity, string> = {
  trap: 'Where a C instinct gives the wrong answer',
  new: 'Unfamiliar, but ordinary',
  familiar: 'Already familiar from C',
};

const SEVERITY_LEAD: Record<Severity, string> = {
  trap:
    'These are the places where reading this code with a C model in mind produces a confident, wrong conclusion. ' +
    'They are worth the most attention and they are the reason this document exists.',
  new: 'Constructs with no C equivalent, but which behave predictably once you know what the compiler builds.',
  familiar:
    'Listed so you can stop spending attention on them. These behave exactly as they would in C, or close enough ' +
    'that the difference will not bite you.',
};

function groupBySeverity(findings: Finding[]): Map<Severity, Finding[]> {
  const out = new Map<Severity, Finding[]>();
  for (const f of findings) {
    (out.get(f.severity) ?? out.set(f.severity, []).get(f.severity)!).push(f);
  }
  return out;
}

/** Collapse repeats: one entry per construct, with the places it occurs. */
function collapse(findings: Finding[]): { representative: Finding; occurrences: Finding[] }[] {
  const byConstruct = new Map<string, Finding[]>();
  for (const f of findings) {
    (byConstruct.get(f.construct) ?? byConstruct.set(f.construct, []).get(f.construct)!).push(f);
  }
  return [...byConstruct.values()]
    .map((list) => ({ representative: list[0], occurrences: list }))
    .sort((a, b) => b.occurrences.length - a.occurrences.length);
}

function where(f: Finding): string {
  if (!f.file) {
    return f.qualifiedName;
  }
  return f.line ? `${f.file}:${f.line}` : f.file;
}

export function generatePrimer(input: PrimerInput): string {
  const out: string[] = [];
  const bySeverity = groupBySeverity(input.findings);
  const traps = bySeverity.get('trap')?.length ?? 0;

  out.push(`# ${input.module} — the C++ in here, explained`, '');
  out.push(
    `Written for someone fluent in C reading this module for the first time. Everything below was measured in ` +
      `this codebase, not recalled from general knowledge about C++ — the manifest at the end says what was read ` +
      `to produce it.`,
    '',
  );

  if (input.findings.length === 0 && input.journal.length === 0) {
    out.push('Nothing in this module behaves differently from the C you already read. That is a real answer.', '');
    out.push(...manifest(input));
    return out.join('\n');
  }

  out.push(
    `${input.findings.length} construct${input.findings.length === 1 ? '' : 's'} found` +
      (traps > 0 ? `, ${traps} of which will mislead a C reader` : '') +
      `.`,
    '',
  );

  // The journal leads. A human noticed these.
  if (input.journal.length > 0) {
    out.push('## What people who read this before you wrote down', '');
    const open = input.journal.filter((e) => e.kind === 'wtf');
    const known = input.journal.filter((e) => e.kind !== 'wtf');

    for (const e of known) {
      out.push(`**\`${e.symbol}\`** — ${e.body.split('\n')[0]}`, '');
    }
    if (open.length > 0) {
      out.push(
        `### Still unresolved`,
        '',
        'Questions someone recorded and did not answer. If you work one out, that is the most valuable thing you ' +
          'can add to this document.',
        '',
      );
      for (const e of open) {
        out.push(`- **\`${e.symbol}\`** — ${e.body.split('\n')[0]}`);
      }
      out.push('');
    }
  }

  for (const severity of ['trap', 'new', 'familiar'] as Severity[]) {
    const list = bySeverity.get(severity);
    if (!list || list.length === 0) {
      continue;
    }
    out.push(`## ${SEVERITY_HEADING[severity]}`, '', SEVERITY_LEAD[severity], '');

    for (const { representative, occurrences } of collapse(list)) {
      const count = occurrences.length;
      out.push(`### ${representative.title}${count > 1 ? ` — and ${count - 1} more like it` : ''}`, '');
      out.push(`**What the compiler emits.** ${representative.emits}`, '');
      out.push(`**In C you would write.** ${representative.cEquivalent}`, '');

      const places = occurrences
        .map(where)
        .filter((w, i, arr) => arr.indexOf(w) === i)
        .slice(0, 8);
      if (places.length > 0) {
        out.push(`Found at: ${places.map((p) => `\`${p}\``).join(', ')}${count > 8 ? ', and elsewhere' : ''}.`, '');
      }
    }
  }

  out.push(...manifest(input));
  return out.join('\n');
}

/**
 * The context manifest.
 *
 * Placed at the end and never omitted. A reader has to be able to tell the
 * difference between "no exceptions in this module" and "the cost lens did not
 * run", and those look identical in a document that lists only what it found.
 */
function manifest(input: PrimerInput): string[] {
  const out: string[] = ['---', '', '## What was read to produce this', ''];
  out.push(`Generated ${input.generatedAt.toISOString().slice(0, 16).replace('T', ' ')}.`, '');

  const ran = input.runs.filter((r) => r.ran);
  const skipped = input.runs.filter((r) => !r.ran);

  if (ran.length > 0) {
    out.push('| Lens | Read | Found |', '| --- | --- | --- |');
    for (const r of ran) {
      out.push(`| ${r.lens} | ${r.inputs.map((i) => `\`${i}\``).join(', ') || '—'} | ${r.findingCount} |`);
    }
    out.push('');
  }

  if (skipped.length > 0) {
    out.push(
      '**Did not run.** Anything these would have found is absent from this document, which is not the same as ' +
        'absent from the code.',
      '',
    );
    for (const r of skipped) {
      out.push(`- **${r.lens}** — ${r.skipped ?? 'not run'}`);
    }
    out.push('');
  }

  return out;
}

/** One-paragraph summary for a folder index or a pull request comment. */
export function summarise(input: PrimerInput): string {
  const traps = input.findings.filter((f) => f.severity === 'trap');
  const open = input.journal.filter((e) => e.kind === 'wtf').length;

  if (input.findings.length === 0) {
    return `${input.module}: nothing here behaves differently from C.`;
  }
  const lead =
    traps.length > 0
      ? `${input.module}: ${traps.length} construct${traps.length === 1 ? '' : 's'} here will mislead a C reader — ` +
        `${[...new Set(traps.map((t) => t.construct))].slice(0, 3).join(', ')}.`
      : `${input.module}: ${input.findings.length} C++ constructs, none of them traps.`;
  return open > 0 ? `${lead} ${open} question${open === 1 ? '' : 's'} still open in the journal.` : lead;
}
