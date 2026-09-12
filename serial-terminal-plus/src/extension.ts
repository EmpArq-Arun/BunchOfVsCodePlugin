import * as vscode from 'vscode';
import { Hub } from './hub';

let hub: Hub | undefined;

export function activate(context: vscode.ExtensionContext): void {
  hub = new Hub(context);
  context.subscriptions.push(hub);

  const register = (id: string, fn: () => void | Promise<void>) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  register('serialTerminalPlus.open', () => hub?.showAll());
  register('serialTerminalPlus.openTerminal', () => hub?.show('terminal'));
  register('serialTerminalPlus.openResponse', () => hub?.show('response'));
  register('serialTerminalPlus.openGraph', () => hub?.show('graph'));
  register('serialTerminalPlus.connect', () => hub?.connect());
  register('serialTerminalPlus.disconnect', () => hub?.disconnect());
  register('serialTerminalPlus.startAll', () => hub?.startAll());
  register('serialTerminalPlus.stopAll', () => hub?.stopAll());
  register('serialTerminalPlus.exportCommands', () => hub?.exportCommands());
  register('serialTerminalPlus.importCommands', () => hub?.importCommands());
  register('serialTerminalPlus.toggleLogging', () => hub?.toggleLogging());
  register('serialTerminalPlus.startLoggingAs', () => hub?.chooseLogFile());
  register('serialTerminalPlus.stopLogging', () => hub?.stopLogging());
  register('serialTerminalPlus.flushLog', () => hub?.flushLog());
  register('serialTerminalPlus.openLogFile', () => hub?.openLogFile());
}

export function deactivate(): void {
  hub?.dispose();
  hub = undefined;
}
