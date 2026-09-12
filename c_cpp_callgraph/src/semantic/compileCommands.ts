import * as fs from 'fs';
import * as path from 'path';

export interface CompileEntry {
  directory: string;
  file: string; // absolute path
  args: string[]; // full compiler invocation, argv[0] included
}

// Flags that don't make sense (or are actively harmful) when we re-invoke the
// compiler ourselves for -fsyntax-only -Xclang -ast-dump=json purposes.
const DROP_FLAG_PREFIXES = ['-c', '-o', '-MF', '-MD', '-MMD', '-MT', '-MQ', '-MP', '--output'];

function shouldDropFlag(arg: string, nextArg: string | undefined): { drop: boolean; alsoDropNext: boolean } {
  if (arg === '-c') return { drop: true, alsoDropNext: false };
  if (arg === '-o' || arg === '--output') return { drop: true, alsoDropNext: true };
  if (arg.startsWith('-o') && arg.length > 2) return { drop: true, alsoDropNext: false }; // -ofoo.o
  if (arg === '-MF' || arg === '-MT' || arg === '-MQ') return { drop: true, alsoDropNext: true };
  if (arg === '-MD' || arg === '-MMD' || arg === '-MP') return { drop: true, alsoDropNext: false };
  return { drop: false, alsoDropNext: false };
}

/** Minimal shell-word tokenizer for compile_commands.json "command" strings (handles simple quoting; not a full shell parser). */
function tokenizeCommand(cmd: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) {
        quote = null;
      } else if (c === '\\' && quote === '"' && i + 1 < cmd.length) {
        current += cmd[++i];
      } else {
        current += c;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (/\s/.test(c)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += c;
  }
  if (current) tokens.push(current);
  return tokens;
}

export class CompileCommandsDb {
  private byFile = new Map<string, CompileEntry>();
  private allFiles: string[] = [];

  static load(compileCommandsPath: string): CompileCommandsDb | undefined {
    try {
      const raw = fs.readFileSync(compileCommandsPath, 'utf8');
      const json = JSON.parse(raw) as any[];
      const db = new CompileCommandsDb();
      for (const entry of json) {
        const directory: string = entry.directory ?? path.dirname(compileCommandsPath);
        const file: string = path.isAbsolute(entry.file) ? entry.file : path.resolve(directory, entry.file);
        let args: string[];
        if (Array.isArray(entry.arguments)) {
          args = entry.arguments;
        } else if (typeof entry.command === 'string') {
          args = tokenizeCommand(entry.command);
        } else {
          continue;
        }
        db.byFile.set(path.normalize(file), { directory, file, args });
        db.allFiles.push(path.normalize(file));
      }
      return db;
    } catch {
      return undefined; // missing, unreadable, or malformed — caller falls back to heuristic mode
    }
  }

  /** Compiler args (cleaned) plus the working directory clang should be invoked from, for a given file. */
  entryFor(filePath: string): { args: string[]; directory: string } | undefined {
    // Normalise path separators; on Windows CMake/clang-tools use forward slashes
    const norm = path.normalize(filePath).replace(/\\/g, '/');
    let entry = this.byFile.get(norm);

    // Case-insensitive fallback for Windows drive letters (f:/ vs F:/)
    if (!entry) {
      const normLower = norm.toLowerCase();
      for (const [k, v] of this.byFile) {
        if (k.toLowerCase() === normLower) { entry = v; break; }
      }
    }

    if (!entry) {
      // Headers usually aren't their own compile_commands.json entry — fall
      // back to any TU in the same directory as a reasonable proxy.
      const dir = path.dirname(norm);
      entry = [...this.byFile.values()].find((e) =>
        path.dirname(e.file.replace(/\\/g, '/')).toLowerCase() === dir.toLowerCase(),
      );
    }
    if (!entry) return undefined;

    const cleaned: string[] = [];
    for (let i = 1; i < entry.args.length; i++) {
      // skip argv[0] (the compiler binary itself — we supply our own)
      const arg = entry.args[i];
      if (arg === entry.file) continue; // drop the original source file; caller appends the actual target file
      const { drop, alsoDropNext } = shouldDropFlag(arg, entry.args[i + 1]);
      if (drop) {
        if (alsoDropNext) i++;
        continue;
      }
      cleaned.push(arg);
    }
    return { args: cleaned, directory: entry.directory };
  }

  /** Compiler args for `filePath`, stripped of flags we don't want when re-invoking ourselves. Prefer entryFor() when you also need the right cwd. */
  argsFor(filePath: string): string[] | undefined {
    return this.entryFor(filePath)?.args;
  }

  hasAnyEntries(): boolean {
    return this.allFiles.length > 0;
  }

  entryCount(): number {
    return this.allFiles.length;
  }

  /** Returns the compiler binary name from the first entry (e.g. "arm-none-eabi-gcc", "clang++"). */
  firstCompiler(): string | undefined {
    if (this.allFiles.length === 0) return undefined;
    const firstFile = this.allFiles[0];
    const entry = this.byFile.get(firstFile);
    if (!entry || entry.args.length === 0) return undefined;
    // The first arg is the compiler binary; return just the filename (strip path)
    return path.basename(entry.args[0]);
  }
}
