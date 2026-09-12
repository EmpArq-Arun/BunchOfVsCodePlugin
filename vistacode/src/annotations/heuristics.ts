interface HeuristicRule {
  pattern: RegExp;
  label: (match: RegExpMatchArray) => string;
}

// Order matters: more specific patterns first.
const RULES: HeuristicRule[] = [
  {
    // idx < len / i < size / pos <= capacity
    pattern: /^\(?\s*[\w.\->]+\s*(<|<=)\s*[\w.\->]+\s*\)?$/,
    label: () => 'Bounds check'
  },
  {
    // ptr == NULL / ptr != NULL / ptr == nullptr / !ptr
    pattern: /(==|!=)\s*(NULL|nullptr)|^\(?\s*!\s*\w+\s*\)?$/,
    label: () => 'Null check'
  },
  {
    // ret < 0 / result == -1 / status != 0 (common error-code idioms)
    pattern: /^\(?\s*(ret|rc|result|status|err|error)\w*\s*(<|==|!=)\s*-?\d/i,
    label: () => 'Error check'
  }
];

/** Returns a friendly fallback label for a raw condition, or null if no pattern matches. */
export function heuristicLabelFor(rawConditionText: string): string | null {
  const normalized = rawConditionText.trim();
  for (const rule of RULES) {
    const match = normalized.match(rule.pattern);
    if (match) {
      return rule.label(match);
    }
  }
  return null;
}
