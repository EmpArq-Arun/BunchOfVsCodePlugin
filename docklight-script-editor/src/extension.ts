import * as vscode from 'vscode';
import { PtpEditorProvider } from './ptpEditorProvider';

export function activate(context: vscode.ExtensionContext) {
  const provider = PtpEditorProvider.register(context);
  context.subscriptions.push(provider);

  context.subscriptions.push(
    vscode.commands.registerCommand('docklightScriptEditor.addSendCommand', () => {
      PtpEditorProvider.currentProvider?.addSendCommandToActive();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('docklightScriptEditor.openSource', async () => {
      const uri = PtpEditorProvider.currentProvider?.activeDocumentUri;
      if (!uri) return;
      await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('docklightScriptEditor.preview', async (resource?: vscode.Uri) => {
      const uri = resource ?? vscode.window.activeTextEditor?.document.uri;
      if (!uri) {
        vscode.window.showInformationMessage('Open a .ptp file first.');
        return;
      }
      await vscode.commands.executeCommand(
        'vscode.openWith',
        uri,
        'docklightScriptEditor.ptp',
        vscode.ViewColumn.Beside
      );
    })
  );
}

export function deactivate() {}
