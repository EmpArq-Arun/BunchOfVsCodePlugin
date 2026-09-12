/**
 * Harvesting a cross toolchain's include paths.
 *
 * A compilation database written for `arm-none-eabi-g++` records the project's
 * own `-I` flags and nothing else. The toolchain's own headers — libstdc++ for
 * C++, newlib for C — are found by the GCC driver implicitly, from paths
 * compiled into it. clang has no idea where they are, so the first
 * `#include <limits>` fails with "file not found".
 *
 * This is a different failure from a missing *builtin* header. `stdbool.h`,
 * `stdint.h` and `stddef.h` ship inside clang's own resource directory;
 * `<limits>`, `<vector>` and `<cstdint>` belong to the standard library that
 * came with the cross compiler. Conflating them sends people to check the wrong
 * setting, so the two are told apart by name.
 *
 * The remedy is to ask the compiler named in the database where it looks, and
 * pass those directories to clang explicitly. `-E -Wp,-v` makes any GCC-derived
 * driver print its search list, which is stable across versions and vendors.
 */

/**
 * Extract the system include directories from `gcc -E -Wp,-v` output.
 *
 * The block is delimited by two fixed markers. Quoted-form directories, listed
 * before the angle-bracket block, are deliberately excluded: those are the
 * project's own and already present in the database.
 */
export function parseIncludeSearchList(output: string): string[] {
  const lines = output.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => l.includes('#include <...> search starts here:'));
  if (start === -1) {
    return [];
  }
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].includes('End of search list')) {
      break;
    }
    const dir = lines[i].trim();
    // A framework directory is annotated; the annotation is not part of the path.
    const cleaned = dir.replace(/\s*\(framework directory\)\s*$/, '');
    if (cleaned.length > 0 && !cleaned.startsWith('#')) {
      out.push(cleaned);
    }
  }
  return out;
}

/** Turn directories into flags clang accepts, skipping any that repeat. */
export function asIsystemFlags(dirs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of dirs) {
    const key = dir.replace(/\\/g, '/').toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push('-isystem', dir);
    }
  }
  return out;
}

/** The arguments that make a GCC driver print its search list for a language. */
export function includeProbeArgs(language: 'c' | 'c++'): string[] {
  return ['-x', language, '-E', '-Wp,-v', '-'];
}

/**
 * Headers that live in clang's resource directory rather than in the standard
 * library. Used to tell the two "file not found" failures apart.
 */
const BUILTIN_HEADERS = new Set([
  'stdbool.h',
  'stdint.h',
  'stddef.h',
  'stdarg.h',
  'stdalign.h',
  'stdnoreturn.h',
  'stdatomic.h',
  'float.h',
  'iso646.h',
  'limits.h',
  'varargs.h',
]);

export type MissingHeaderKind = 'builtin' | 'standard-library' | 'project';

/**
 * Classify a "'X' file not found" diagnostic.
 *
 * `limits.h` is a builtin; `limits` is the C++ standard library. The distinction
 * is one character and the two have entirely different fixes.
 */
export function classifyMissingHeader(header: string): MissingHeaderKind {
  const name = header.trim().replace(/^["<]|[">]$/g, '');
  if (BUILTIN_HEADERS.has(name)) {
    return 'builtin';
  }
  // A C++ standard header has no extension: <limits>, <vector>, <cstdint>.
  if (!name.includes('.') && !name.includes('/')) {
    return 'standard-library';
  }
  if (/^(c[a-z]+|.*\.tcc)$/.test(name)) {
    return 'standard-library';
  }
  return 'project';
}

/** Pull the header name out of a compiler diagnostic, if there is one. */
export function missingHeaderFrom(stderr: string): string | undefined {
  const m = /'([^']+)' file not found/.exec(stderr);
  return m ? m[1] : undefined;
}
