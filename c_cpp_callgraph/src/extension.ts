import * as vscode from 'vscode';
import { WorkspaceIndex } from './parser/workspaceIndex';
import { CallGraphPanel } from './webviewPanel';
import * as diag from './diagnostics';

const FILE_GLOB = '**/*.{c,cc,cpp,cxx,h,hh,hpp,hxx}';

export function activate(context: vscode.ExtensionContext) {
  diag.initDiagnostics(context);
  diag.logSection('C/C++ Call Graph Visualizer — activated');

  const index = new WorkspaceIndex();

  // Debounced file-change refresh
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleRefresh = (uri: vscode.Uri) => {
    index.markDirty();
    diag.logInfo(`File changed: ${vscode.workspace.asRelativePath(uri)} — refresh scheduled`);
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      refreshTimer = undefined;
      await CallGraphPanel.refreshCurrent(index);
    }, 400);
  };

  const watcher = vscode.workspace.createFileSystemWatcher(FILE_GLOB);
  watcher.onDidChange(scheduleRefresh);
  watcher.onDidCreate(scheduleRefresh);
  watcher.onDidDelete(scheduleRefresh);
  context.subscriptions.push(watcher);

  context.subscriptions.push(
    vscode.commands.registerCommand('callgraph.showForCursor', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage('Open a C/C++ file and place the cursor inside a function first.');
        return;
      }
      if (editor.document.languageId !== 'c' && editor.document.languageId !== 'cpp') {
        vscode.window.showInformationMessage('Call Graph only works on C/C++ files.');
        return;
      }

      await index.ensureFresh();
      const relPath = vscode.workspace.asRelativePath(editor.document.uri, false);
      const line = editor.selection.active.line + 1;
      let fn = index.findFunctionAtLine(relPath, line);

      // Fallback: cursor may be on a function declaration (ends with `;`) or a
      // forward declaration in a header. Extract the function name from the line text.
      if (!fn) {
        const lineText = editor.document.lineAt(editor.selection.active.line).text;
        fn = index.findFunctionByNameOnLine(lineText, relPath);
        if (fn) {
          diag.logInfo(`Cursor was on a declaration; resolved to definition: ${fn.qualifiedName ?? fn.name} at ${fn.location.file}:${fn.location.line}`);
        }
      }

      if (!fn) {
        vscode.window.showInformationMessage(
          'No function detected at the cursor.\n' +
          '• For function definitions: place cursor anywhere inside the function body.\n' +
          '• For declarations (header files): the definition must be in a scanned source file.\n' +
          'Run "Call Graph: Show Diagnostics" and check the indexed function count.',
        );
        return;
      }

      diag.logInfo(`Showing call graph for: ${fn.qualifiedName ?? fn.name} at ${relPath}:${line}`);
      await CallGraphPanel.createOrShow(context, index, fn.id);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('callgraph.refreshIndex', async () => {
      diag.logSection('Manual index rebuild');
      index.markDirty();
      await index.ensureFresh();
      const fnCount = index.getAllFunctions().length;
      const clsCount = index.getAllClasses().length;
      diag.logOk(`Index rebuilt — ${fnCount} functions, ${clsCount} classes`);
      vscode.window.showInformationMessage(`Call graph index rebuilt: ${fnCount} functions, ${clsCount} classes.`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('callgraph.showClassDiagram', async () => {
      const rootId = await findClassAtCursor(index);
      await CallGraphPanel.createOrShowClassDiagram(context, index, 'hierarchy', rootId);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('callgraph.showClassUml', async () => {
      const rootId = await findClassAtCursor(index);
      await CallGraphPanel.createOrShowClassDiagram(context, index, 'uml', rootId);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('callgraph.showUsageDiagram', async () => {
      const rootId = await findClassAtCursor(index);
      await CallGraphPanel.createOrShowClassDiagram(context, index, 'usage', rootId);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('callgraph.showDiagnostics', () => {
      diag.show();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('callgraph.listMacroAliases', async () => {
      diag.show();
      diag.logSection('Listing all detected macro function-aliases');
      await index.ensureFresh();
      const aliases = index.getMacroAliases();
      if (aliases.size === 0) {
        diag.logWarn('No macro aliases found. Ensure that your interface header files (.h/.hpp) are inside the VS Code workspace and not excluded by callgraph settings or the build/ out/ dist/ directories.');
      } else {
        diag.logOk(`${aliases.size} macro alias(es) detected:`);
        for (const [alias, real] of aliases) {
          diag.logInfo(`  ${alias}  →  ${real}`);
        }
      }
    }),
  );
}

export function deactivate() {
  diag.dispose();
}

async function findClassAtCursor(index: WorkspaceIndex): Promise<string | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return undefined;
  if (editor.document.languageId !== 'c' && editor.document.languageId !== 'cpp') return undefined;
  await index.ensureFresh();
  const relPath = vscode.workspace.asRelativePath(editor.document.uri, false);
  const line = editor.selection.active.line + 1;
  return index.findClassAtLine(relPath, line)?.id;
}
