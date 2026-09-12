import * as vscode from 'vscode';
import { WorkspaceScanner } from './scanner';
import { SidebarProvider } from './sidebar/sidebarProvider';
import { PanelManager, exportViaGraphviz } from './webview/panelManager';
import { FileGraphPanel } from './fileGraph/panel';

export async function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('State Machine Visualizer');
  context.subscriptions.push(output);

  const scanner = new WorkspaceScanner(output);
  context.subscriptions.push(scanner);

  const sidebarProvider = new SidebarProvider(scanner);
  const treeView = vscode.window.createTreeView('statemachineVisualizer.sidebar', {
    treeDataProvider: sidebarProvider,
  });
  context.subscriptions.push(treeView);

  const panelManager = new PanelManager(context.extensionUri, output);
  const fileGraphPanel = new FileGraphPanel(context.extensionUri, output, scanner);

  context.subscriptions.push(
    vscode.commands.registerCommand('statemachineVisualizer.openFileGraph', async (uri?: vscode.Uri) => {
      await fileGraphPanel.open(uri?.fsPath);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('statemachineVisualizer.refresh', async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Scanning workspace for state machines…' },
        async () => {
          const result = await scanner.scanWorkspace();
          if (result.machines.length === 0) {
            vscode.window.setStatusBarMessage(
              'No state machines detected yet. Heuristic mode looks for enums driven by switch/if-else/dispatch-table logic.',
              6000,
            );
          }
        },
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('statemachineVisualizer.openVisualization', (machineId: string) => {
      const machine = scanner.getMachine(machineId);
      if (!machine) {
        vscode.window.showWarningMessage('That state machine is no longer available — try refreshing the scan.');
        return;
      }
      panelManager.show(machine);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('statemachineVisualizer.revealInFile', (item: any) => {
      const machine = item?.machine;
      if (!machine) return;
      vscode.workspace.openTextDocument(machine.file).then((doc) =>
        vscode.window.showTextDocument(doc, { selection: new vscode.Range(0, 0, 0, 0) }),
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('statemachineVisualizer.openSMForFile', (filePath: string) => {
      const machines = scanner.getMachinesForFile(filePath);
      if (machines.length === 0) {
        vscode.window.showInformationMessage(`No state machines detected in ${filePath.split(/[/\\]/).pop()}.`);
        return;
      }
      // If there are multiple, open the first one (could prompt the user in future)
      panelManager.show(machines[0]);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('statemachineVisualizer.exportGraphviz', async (item: any) => {
      const machine = item?.machine;
      if (!machine) {
        vscode.window.showWarningMessage('Select a state machine in the sidebar first.');
        return;
      }
      await exportViaGraphviz(machine, output);
    }),
  );

  scanner.startWatching();

  // Auto-reparse on save: rescan SM detection and refresh file graph if open
  const C_EXTS = new Set(['.c','.cpp','.h','.hpp','.cc','.cxx','.hxx']);
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (!C_EXTS.has(doc.uri.fsPath.slice(doc.uri.fsPath.lastIndexOf('.')).toLowerCase())) return;
      await scanner.scanFile(doc.uri);
      if (fileGraphPanel.isOpen()) {
        await fileGraphPanel.onFileSaved(doc.uri);
      }
    }),
  );
  // Initial scan shortly after activation so the sidebar isn't empty on first open.
  void vscode.commands.executeCommand('statemachineVisualizer.refresh');
}

export function deactivate() {
  // Nothing to clean up beyond what's registered in context.subscriptions.
}
