import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { IdeType } from './types';
import { IDE_PRESETS, detectIde, applyPreset } from './idePresets';
import { generateAll } from './generator';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('s32ds-clangd-gen.generate', async () => {
      await runGenerate();
    }),
    vscode.commands.registerCommand('s32ds-clangd-gen.openSettings', () => {
      vscode.commands.executeCommand('workbench.action.openSettings', 'embeddedClangd');
    })
  );
}

async function runGenerate() {
  const cfg = vscode.workspace.getConfiguration('embeddedClangd');

  // ── 1. Resolve project root ───────────────────────────────────────────────
  // Priority: explicit setting > active editor file dir > workspace folder > cwd
  let projectRoot = cfg.get<string>('projectRoot', '').trim();

  if (!projectRoot) {
    // Try the directory of the currently open file
    const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (activeFile) {
      // Walk up from file to find a project marker (.cproject, nbproject/, .mxproject, .git)
      const found = findProjectRoot(path.dirname(activeFile));
      if (found) projectRoot = found;
    }
  }

  if (!projectRoot) {
    // Fall back to first workspace folder
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      projectRoot = folders[0].uri.fsPath;
    }
  }

  if (!projectRoot) {
    vscode.window.showErrorMessage(
      'Embedded clangd Generator: Cannot determine project root. Open a file inside the project or set embeddedClangd.projectRoot in settings.'
    );
    return;
  }

  if (!fs.existsSync(projectRoot)) {
    vscode.window.showErrorMessage(`Embedded clangd Generator: Project root not found: ${projectRoot}`);
    return;
  }

  // ── 2. Resolve IDE type ───────────────────────────────────────────────────
  let ideType = cfg.get<string>('ideType', 'auto');

  let resolvedIde: IdeType;
  if (ideType === 'auto' || !IDE_PRESETS[ideType as IdeType]) {
    const detected = detectIde(projectRoot);
    if (detected) {
      resolvedIde = detected;
      vscode.window.setStatusBarMessage(`Embedded clangd: Auto-detected IDE → ${IDE_PRESETS[detected].displayName}`, 4000);
    } else {
      // Ask user to pick
      const items: Array<vscode.QuickPickItem & { id: IdeType }> = [
        { label: '$(tools) NXP S32 Design Studio',     id: 's32ds'   },
        { label: '$(circuit-board) Microchip MPLAB X', id: 'mplab'   },
        { label: '$(chip) STM32CubeIDE',               id: 'stm32'   },
        { label: '$(gear) Generic / Custom',           id: 'generic' },
      ];
      const pick = await vscode.window.showQuickPick(items,
        { placeHolder: 'Select your embedded IDE (no project markers found for auto-detect)' }
      );
      if (!pick) return; // cancelled
      resolvedIde = pick.id;
    }
  } else {
    resolvedIde = ideType as IdeType;
  }

  const preset = IDE_PRESETS[resolvedIde];

  // ── 3. Merge preset with user overrides ──────────────────────────────────
  const merged = applyPreset(preset, {
    compilerPath:  cfg.get<string>('compilerPath', ''),
    makePath:      cfg.get<string>('makePath', ''),
    buildFolders:  cfg.get<string[]>('buildFolders', []),
    targetTriple:  cfg.get<string>('targetTriple', ''),
    cpuFlags:      cfg.get<string[]>('cpuFlags', []),
    stripFlags:    cfg.get<string[]>('stripFlags', []),
    cStandard:     cfg.get<string>('cStandard', ''),
    extraIncludes: cfg.get<string[]>('extraIncludes', []),
    extraDefines:  cfg.get<string[]>('extraDefines', []),
  });

  const config = {
    projectRoot,
    ideType: resolvedIde,
    ...merged,
    generateCompileFlags: cfg.get<boolean>('generateCompileFlags', true),
    backgroundIndex:      cfg.get<boolean>('backgroundIndex', true),
  };

  // ── 4. Run generator with progress ───────────────────────────────────────
  const out = vscode.window.createOutputChannel('Embedded clangd Generator');

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `[${preset.displayName}] Generating clangd config...`,
      cancellable: false,
    },
    async (progress) => {
      try {
        const result = await generateAll(config, (msg) => {
          progress.report({ message: msg });
          out.appendLine(`  ${msg}`);
        });

        const lines = [
          `━━━ Embedded clangd Generator ━━━`,
          `IDE      : ${preset.displayName}`,
          `Root     : ${projectRoot}`,
          `Build dir: ${result.buildFolder ?? '(none — used fallback parser)'}`,
          `TU count : ${result.entryCount}`,
          ``,
          `Files written:`,
          ...result.filesWritten.map(f => `  ✔ ${f}`),
        ];

        out.appendLine('');
        lines.forEach(l => out.appendLine(l));
        out.show(true);

        const action = await vscode.window.showInformationMessage(
          result.entryCount > 0
            ? `✅ clangd config generated — ${result.entryCount} TUs (${preset.displayName})`
            : `⚠️ clangd config written but 0 TUs found — check Output panel`,
          'Show Output', 'Open Settings'
        );

        if (action === 'Show Output') out.show(true);
        if (action === 'Open Settings') {
          vscode.commands.executeCommand('workbench.action.openSettings', 'embeddedClangd');
        }

      } catch (err: any) {
        out.appendLine(`ERROR: ${err.message}`);
        out.show(true);
        vscode.window.showErrorMessage(`Embedded clangd Generator failed: ${err.message}`);
      }
    }
  );
}

/**
 * Walk up the directory tree from `startDir` looking for known project markers.
 * Stops at filesystem root or after 10 levels.
 */
function findProjectRoot(startDir: string): string | null {
  const MARKERS = [
    '.cproject',          // Eclipse CDT (S32DS, STM32CubeIDE)
    '.mxproject',         // STM32CubeMX
    'nbproject',          // MPLAB X
    '.git',               // generic VCS root
    'compile_commands.json',
  ];

  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    for (const marker of MARKERS) {
      if (fs.existsSync(path.join(dir, marker))) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return null;
}

export function deactivate() {}
