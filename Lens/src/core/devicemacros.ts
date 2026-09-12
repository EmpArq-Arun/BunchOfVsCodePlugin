/**
 * Vendor device-selection macros.
 *
 * Every silicon vendor's CMSIS device header opens with the same construct: a
 * preprocessor guard listing every supported part, and an `#error` telling you
 * to pick one.
 *
 *     #if !defined (STM32G431xx) && !defined (STM32G441xx) && ...
 *       #error "Please select first the target STM32G4xx device used in your application"
 *     #endif
 *
 * When a compilation database is generated without the project's `-D` flags,
 * that `#error` fires on the first header and every type in the SDK becomes
 * unknown. The resulting diagnostic wall names hundreds of missing types and
 * never names the one missing macro that caused them.
 *
 * The list of valid macros is right there in the header, so Lens reads it and
 * offers the choice rather than asking the user to go and find it.
 */

export interface DeviceSelection {
  /** The `#error` text, so the user recognises what they saw. */
  message: string;
  /** Every macro the header will accept, in declaration order. */
  candidates: string[];
}

/** Preprocessor identifiers referenced by `defined(...)` in a fragment. */
function definedIdentifiers(fragment: string): string[] {
  const out: string[] = [];
  const re = /defined\s*\(?\s*([A-Za-z_]\w*)\s*\)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fragment)) !== null) {
    if (!out.includes(m[1])) {
      out.push(m[1]);
    }
  }
  return out;
}

/**
 * Find device-selection guards in a header.
 *
 * The search is for an `#error` that sits inside a conditional testing several
 * `defined()` macros — the shape of a "pick your part" guard — rather than for
 * any particular vendor's wording, so it works for ST, NXP, Nordic and anyone
 * else following the same convention.
 */
export function findDeviceSelection(headerText: string): DeviceSelection | undefined {
  const lines = headerText.replace(/\r\n/g, '\n').split('\n');

  for (let i = 0; i < lines.length; i++) {
    const error = /^\s*#\s*error\s+(.*)$/.exec(lines[i]);
    if (!error) {
      continue;
    }

    // Walk back to the opening #if, gathering it and any line continuations.
    let start = -1;
    for (let j = i - 1; j >= 0 && i - j < 40; j--) {
      if (/^\s*#\s*(if|elif)\b/.test(lines[j])) {
        start = j;
        break;
      }
      if (/^\s*#\s*(endif|else)\b/.test(lines[j])) {
        break;
      }
    }
    if (start === -1) {
      continue;
    }

    const candidates = definedIdentifiers(lines.slice(start, i).join('\n'));
    // One or two macros is an ordinary guard; a long list is a part selector.
    if (candidates.length < 3) {
      continue;
    }

    return {
      message: error[1].replace(/^["']|["']\s*$/g, '').trim(),
      candidates,
    };
  }
  return undefined;
}

/**
 * Does a diagnostic look like a device-selection failure?
 *
 * Matched on the vendor's own wording, which is stable across CMSIS packs, plus
 * the generic shape. Used only to decide whether to go looking for the header —
 * a false positive costs one file read.
 */
export function looksLikeDeviceSelection(stderr: string): boolean {
  return (
    /select\s+first\s+the\s+target/i.test(stderr) ||
    /please\s+select.*device\s+used\s+in\s+your\s+application/i.test(stderr) ||
    /define\s+the\s+device\s+part\s+number/i.test(stderr)
  );
}

/**
 * Flags a firmware project almost always needs and a naive generator omits.
 * Offered as suggestions alongside the device macro, never applied silently.
 */
export function commonMissingDefines(headerText: string): string[] {
  const out: string[] = [];
  if (/stm32/i.test(headerText)) {
    out.push('USE_HAL_DRIVER');
  }
  return out;
}
