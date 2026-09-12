import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { entryFilename, parseEntry, serialiseEntry, FrontmatterError } from './frontmatter.js';
import type { EntryKind, JournalEntry } from './model.js';

/**
 * Storage.
 *
 * Markdown files on disk are the source of truth; the in-memory map is a
 * derived index rebuilt on load. This inverts the original design's
 * `.lens/index.db` for the annotation plane specifically, and the reasoning is
 * in docs/adr/0001-journal-storage.md: annotations are human-authored, small,
 * and need to survive in git and merge sensibly between engineers. A binary
 * database does none of that. Every other plane — symbols, relations, layouts,
 * costs — stays in SQLite from P2 onward, gitignored under .lens/cache/,
 * because those are machine-generated, large, and rebuildable.
 *
 * One anchor may carry several entries: a symbol can be simultaneously a quirk
 * and an open question, and collapsing them would lose information.
 */
export class Journal {
  private byAnchor = new Map<string, JournalEntry[]>();
  private all: JournalEntry[] = [];
  private problems: string[] = [];

  constructor(readonly dir: string) {}

  get entries(): readonly JournalEntry[] {
    return this.all;
  }

  /** Parse failures encountered on the last load, for surfacing to the user. */
  get loadProblems(): readonly string[] {
    return this.problems;
  }

  for(anchor: string): JournalEntry[] {
    return this.byAnchor.get(anchor) ?? [];
  }

  anchors(): Set<string> {
    return new Set(this.byAnchor.keys());
  }

  ofKind(kind: EntryKind): JournalEntry[] {
    return this.all.filter((e) => e.kind === kind);
  }

  /**
   * Rebuild the index from disk. A malformed file is recorded and skipped rather
   * than aborting the load — one bad merge conflict must not cost you the rest
   * of the journal.
   */
  async load(): Promise<void> {
    this.byAnchor.clear();
    this.all = [];
    this.problems = [];

    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw err;
    }

    for (const name of names.filter((n) => n.endsWith('.md')).sort()) {
      const full = path.join(this.dir, name);
      try {
        const entry = parseEntry(await fs.readFile(full, 'utf8'));
        entry.path = full;
        this.index(entry);
      } catch (err) {
        const why = err instanceof FrontmatterError ? err.message : String(err);
        this.problems.push(`${name}: ${why}`);
      }
    }

    this.all.sort((a, b) => b.updated.localeCompare(a.updated));
  }

  private index(entry: JournalEntry): void {
    this.all.push(entry);
    const bucket = this.byAnchor.get(entry.anchor);
    if (bucket) {
      bucket.push(entry);
    } else {
      this.byAnchor.set(entry.anchor, [entry]);
    }
  }

  async save(entry: JournalEntry): Promise<JournalEntry> {
    await fs.mkdir(this.dir, { recursive: true });
    const target = entry.path ?? path.join(this.dir, entryFilename(entry));
    await fs.writeFile(target, serialiseEntry(entry), 'utf8');
    entry.path = target;
    return entry;
  }

  /**
   * Persist an entry whose kind changed, renaming the backing file so the
   * filename keeps matching the content. Falls back to a plain save if the
   * rename fails for any reason — a stale filename is cosmetic, a lost entry is
   * not.
   */
  async saveRenaming(entry: JournalEntry, previousPath?: string): Promise<JournalEntry> {
    const desired = path.join(this.dir, entryFilename(entry));
    if (previousPath && previousPath !== desired) {
      try {
        await fs.unlink(previousPath);
      } catch {
        /* the write below is what matters */
      }
    }
    entry.path = desired;
    return this.save(entry);
  }

  async remove(entry: JournalEntry): Promise<void> {
    if (entry.path) {
      await fs.rm(entry.path, { force: true });
    }
  }

  /**
   * Flatten the journal into a single reviewable document. This is what gets
   * handed to the next engineer who joins the project — the notes a newcomer
   * writes are precisely what the following newcomer needs.
   */
  export(title = 'Lens Journal'): string {
    const out: string[] = [`# ${title}`, ''];
    const groups: EntryKind[] = ['wtf', 'quirk', 'idiom', 'learned', 'todo'];
    const headings: Record<EntryKind, string> = {
      wtf: 'Open questions',
      quirk: 'Quirks',
      idiom: 'Idioms',
      learned: 'Learned',
      todo: 'To do',
    };

    for (const kind of groups) {
      const items = this.all
        .filter((e) => e.kind === kind)
        .sort((a, b) => a.file.localeCompare(b.file) || a.symbol.localeCompare(b.symbol));
      if (items.length === 0) {
        continue;
      }
      out.push(`## ${headings[kind]} (${items.length})`, '');
      for (const e of items) {
        out.push(`### \`${e.symbol}\``);
        const where = e.file ? `${e.file}:${e.line}` : 'unlocated';
        const tags = e.tags.length > 0 ? ` · ${e.tags.map((t) => `\`${t}\``).join(' ')}` : '';
        out.push(`*${e.symbolKind} · ${where} · noted ${e.created.slice(0, 10)}${tags}*`, '');
        out.push(e.body.trim(), '');
      }
    }

    if (out.length === 2) {
      out.push('_No entries yet._', '');
    }
    return out.join('\n');
  }
}
