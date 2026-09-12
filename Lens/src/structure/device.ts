import { promises as fs } from 'node:fs';
import * as vscode from 'vscode';
import {
  commonMissingDefines,
  findDeviceSelection,
  looksLikeDeviceSelection,
  type DeviceSelection,
} from '../core/devicemacros.js';
import { setExtraCompileFlags } from '../core/compdb.js';

/**
 * Vendor device macro selection.
 *
 * When a compilation database is generated without the project's `-D` flags,
 * the CMSIS device header's `#error` fires and every type in the SDK becomes
 * unknown. The compiler then reports hundreds of missing types and never names
 * the one missing macro that caused all of them.
 *
 * The list of valid macros is in the header the error came from, so Lens reads
 * it and offers the choice, rather than leaving the user to work backwards from
 * a wall of cascading diagnostics.
 */

/** Candidate device headers, cheapest match first. */
const HEADER_GLOBS = [
  '**/Drivers/CMSIS/Device/**/Include/*.h',
  '**/CMSIS/Device/**/Include/*.h',
  '**/Device/**/Include/*.h',
];

export interface DeviceHeader extends DeviceSelection {
  uri: vscode.Uri;
  suggestions: string[];
}

export async function findDeviceHeader(): Promise<DeviceHeader | undefined> {
  for (const glob of HEADER_GLOBS) {
    const hits = await vscode.workspace.findFiles(glob, '**/node_modules/**', 40);
    for (const uri of hits) {
      let text: string;
      try {
        text = await fs.readFile(uri.fsPath, 'utf8');
      } catch {
        continue;
      }
      const selection = findDeviceSelection(text);
      if (selection) {
        return { ...selection, uri, suggestions: commonMissingDefines(text) };
      }
    }
  }
  return undefined;
}

/**
 * Ask which part this project targets and record it.
 *
 * Written to settings rather than applied for one run, because the answer is a
 * property of the project that every lens needs and that will not change.
 */
export async function selectDevice(): Promise<boolean> {
  const header = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Lens: looking for the device header' },
    () => findDeviceHeader(),
  );

  if (!header) {
    void vscode.window.showWarningMessage(
      'Lens: no CMSIS device header with a part-selection guard was found in this workspace. Add the define ' +
        'your project builds with to lens.extraCompileFlags by hand, for example -DSTM32G474xx.',
    );
    return false;
  }

  const picked = await vscode.window.showQuickPick(
    header.candidates.map((c) => ({ label: c, description: `-D${c}` })),
    {
      title: `Lens — which device does this project target?`,
      placeHolder: header.message,
      matchOnDescription: true,
    },
  );
  if (!picked) {
    return false;
  }

  const config = vscode.workspace.getConfiguration('lens');
  const existing = config.get<string[]>('extraCompileFlags', []);
  const wanted = [`-D${picked.label}`, ...header.suggestions.map((s) => `-D${s}`)];
  const merged = [...existing.filter((f) => !/^-D(STM32|NRF|MK|LPC|S32)/i.test(f)), ...wanted].filter(
    (f, i, a) => a.indexOf(f) === i,
  );

  await config.update('extraCompileFlags', merged, vscode.ConfigurationTarget.Workspace);
  setExtraCompileFlags(merged);

  void vscode.window.showInformationMessage(
    `Lens: added ${merged.join(' ')} to lens.extraCompileFlags. Run the lens again.`,
  );
  return true;
}

/**
 * Turn a wall of cascading diagnostics into the one sentence that explains it.
 *
 * Returns undefined when the failure is not a device-selection problem, so the
 * caller falls through to its ordinary message.
 */
export async function diagnoseDeviceSelection(stderr: string): Promise<string | undefined> {
  if (!looksLikeDeviceSelection(stderr)) {
    return undefined;
  }
  const header = await findDeviceHeader();
  const example = header?.candidates[0] ?? 'STM32G474xx';

  return (
    `Your compilation database has no -D flags, so the CMSIS device header cannot tell which part this project ` +
    `targets. Its #error fires on the first include, and every "unknown type name" below is a consequence of ` +
    `that one missing macro rather than a separate problem.\n\n` +
    (header
      ? `${header.uri.fsPath} accepts ${header.candidates.length} device macros. Run "Lens: Select Target Device ` +
        `Macro" to pick one.\n\n`
      : '') +
    `You can also set it by hand:\n\n    "lens.extraCompileFlags": ["-D${example}", "-DUSE_HAL_DRIVER"]\n\n` +
    `The underlying problem is in whatever generated compile_commands.json — clangd reads the same file, so ` +
    `IntelliSense is very likely broken here for the same reason.`
  );
}
