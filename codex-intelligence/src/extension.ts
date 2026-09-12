import * as vscode from 'vscode';
import * as path from 'path';
import { FileWatcher } from './agent/fileWatcher';
import { AgentLoop } from './agent/agentLoop';
import { CodexDB } from './db/codexDB';
import { VendorProfile } from './vendor/vendorProfile';
import { ChatViewProvider } from './webview/chatViewProvider';
import { StatusViewProvider } from './webview/statusViewProvider';
import { registerCompletionProvider } from './tools/completionProvider';
import { getAllProviders } from './agent/llmClient';

let fileWatcher: FileWatcher | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('[Codex] Activating...');

  let agent:          AgentLoop      | undefined;
  let db:             CodexDB        | undefined;
  let vendor:         VendorProfile  | undefined;
  let statusProvider: StatusViewProvider | undefined;

  async function getServices(): Promise<{ agent: AgentLoop; db: CodexDB; vendor: VendorProfile; root: string } | null> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      vscode.window.showWarningMessage('Codex: Open a folder first (File → Open Folder).');
      return null;
    }
    if (!vendor) {
      vendor = new VendorProfile(root);
      try { await vendor.load(); }
      catch (e) {
        vscode.window.showErrorMessage(`Codex: Failed to load vendor profile — ${e instanceof Error ? e.message : e}`);
        vendor = undefined; return null;
      }
    }
    if (!db) {
      const fmt = vscode.workspace.getConfiguration('codex').get<string>('diagramFormat', 'plantuml');
      db = new CodexDB(root, fmt === 'mermaid' ? 'mermaid' : 'plantuml');
      try { await db.init(); }
      catch (e) {
        vscode.window.showErrorMessage(`Codex: Failed to initialise .codex — ${e instanceof Error ? e.message : e}`);
        db = undefined; return null;
      }
    }
    if (!agent) { agent = new AgentLoop(root, db, vendor); }
    return { agent, db, vendor, root };
  }

  // ── Views ──────────────────────────────────────────────────────
  const chatProvider = new ChatViewProvider(
    context.extensionUri,
    async (msg, file) => { const s = await getServices(); if (!s) { return 'Open a folder first.'; } return s.agent.chat(msg, file); },
    async (pfx, file) => { const s = await getServices(); if (!s) { return []; } return s.agent.autocomplete(pfx, file); }
  );
  statusProvider = new StatusViewProvider(context.extensionUri, () => db ?? null);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('codex.chatView',   chatProvider),
    vscode.window.registerWebviewViewProvider('codex.statusView', statusProvider)
  );

  // ── Completion & hover ─────────────────────────────────────────
  registerCompletionProvider(
    context,
    async (pfx, file) => { const s = await getServices(); if (!s) { return []; } return s.agent.autocomplete(pfx, file); },
    () => db ?? null
  );

  // ── Commands — registered unconditionally ──────────────────────
  context.subscriptions.push(

    vscode.commands.registerCommand('codex.rebuildAll', async () => {
      const svc = await getServices(); if (!svc) { return; }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Codex: Rebuilding...', cancellable: true },
        async (progress, token) => {
          try {
            await svc.agent.rebuildAll(progress, token);
            statusProvider?.refresh();
            vscode.window.showInformationMessage('Codex: Knowledge DB rebuilt.');
          } catch (e) {
            vscode.window.showErrorMessage(`Codex: Rebuild failed — ${e instanceof Error ? e.message : e}`);
          }
        }
      );
    }),

    vscode.commands.registerCommand('codex.indexFile', async () => {
      const svc = await getServices(); if (!svc) { return; }
      const ed = vscode.window.activeTextEditor;
      if (!ed) { vscode.window.showWarningMessage('Codex: Open a .c or .h file first.'); return; }
      try {
        await svc.agent.indexFile(ed.document.uri.fsPath);
        statusProvider?.refresh();
        vscode.window.showInformationMessage(`Codex: Indexed ${ed.document.fileName.split(/[\\/]/).pop()}`);
      } catch (e) {
        vscode.window.showErrorMessage(`Codex: Index failed — ${e instanceof Error ? e.message : e}`);
      }
    }),

    vscode.commands.registerCommand('codex.openChat', () => {
      void vscode.commands.executeCommand('codex.chatView.focus');
    }),

    vscode.commands.registerCommand('codex.setVendor', async () => {
      const pick = await vscode.window.showQuickPick(['stm32','pic','nxp','custom'], { placeHolder: 'Select vendor profile' });
      if (!pick) { return; }
      await vscode.workspace.getConfiguration('codex').update('vendorProfile', pick, vscode.ConfigurationTarget.Workspace);
      if (vendor) { try { await vendor.load(); } catch { vendor = undefined; } }
      statusProvider?.refresh();
      vscode.window.showInformationMessage(`Codex: Vendor profile set to "${pick}".`);
    }),

    vscode.commands.registerCommand('codex.setProvider', async () => {
      const providers = getAllProviders();
      const picks = providers.map(p => ({
        label:       p.displayName,
        description: p.id,
        detail:      p.notes || (p.requiresKey ? `Requires API key (${p.envVar || 'codex.llmApiKey'})` : 'No API key needed'),
        id:          p.id
      }));
      const choice = await vscode.window.showQuickPick(picks, {
        placeHolder: 'Select LLM provider — add more via codex.customProviders'
      });
      if (!choice) { return; }
      await vscode.workspace.getConfiguration('codex').update('llmProvider', choice.id, vscode.ConfigurationTarget.Workspace);
      statusProvider?.refresh();
      vscode.window.showInformationMessage(`Codex: LLM provider set to "${choice.label}".`);
    }),

    vscode.commands.registerCommand('codex.openArchitecture', async () => {
      const svc = await getServices(); if (!svc) { return; }
      const archPath = vscode.Uri.file(path.join(svc.db.codexDir, 'ARCHITECTURE.md'));
      try {
        await vscode.workspace.fs.stat(archPath);
      } catch {
        vscode.window.showWarningMessage('Codex: No architecture overview yet — run "Codex: Rebuild entire knowledge DB" first.');
        return;
      }
      // Open in markdown preview so links and diagrams render
      await vscode.commands.executeCommand('markdown.showPreview', archPath);
    }),

    vscode.commands.registerCommand('codex.setDiagramFormat', async () => {
      const pick = await vscode.window.showQuickPick(
        [
          { label: 'PlantUML', description: 'plantuml', detail: 'Richer syntax — needs jebbs.plantuml extension + Java' },
          { label: 'Mermaid',  description: 'mermaid',  detail: 'Renders natively in GitHub, GitLab and VS Code markdown preview' }
        ],
        { placeHolder: 'Select diagram format for generated diagrams' }
      );
      if (!pick) { return; }
      await vscode.workspace.getConfiguration('codex').update('diagramFormat', pick.description, vscode.ConfigurationTarget.Workspace);
      db?.setDiagramFormat(pick.description === 'mermaid' ? 'mermaid' : 'plantuml');
      statusProvider?.refresh();
      const rebuild = await vscode.window.showInformationMessage(
        `Codex: Diagram format set to ${pick.label}. Existing diagrams still use the old format.`,
        'Rebuild now'
      );
      if (rebuild === 'Rebuild now') {
        await vscode.commands.executeCommand('codex.rebuildAll');
      }
    }),

    vscode.commands.registerCommand('codex.showDiagram', async () => {
      const svc = await getServices(); if (!svc) { return; }
      const ed = vscode.window.activeTextEditor;
      if (!ed) { vscode.window.showWarningMessage('Codex: Open a .c or .h file first.'); return; }
      const diagPath = svc.db.diagramPathFor(ed.document.uri.fsPath, 'flows');
      if (diagPath) {
        const uri = vscode.Uri.file(diagPath);
        if (diagPath.endsWith('.mmd')) {
          await vscode.commands.executeCommand('markdown.showPreview', uri);
        } else {
          await vscode.commands.executeCommand('plantuml.preview', uri);
        }
      } else {
        vscode.window.showWarningMessage('Codex: No diagram yet — run "Codex: Index current file" first.');
      }
    })

  );

  // ── File watcher ───────────────────────────────────────────────
  async function startWatcher(): Promise<void> {
    const svc = await getServices(); if (!svc) { return; }
    if (!vscode.workspace.getConfiguration('codex').get<boolean>('autoIndexOnSave', true)) { return; }
    fileWatcher?.stop();
    fileWatcher = new FileWatcher(svc.root, svc.vendor, async (f) => {
      try { await svc.agent.indexFile(f); statusProvider?.refresh(); }
      catch (e) { console.error('[Codex] Auto-index error:', e); }
    });
    fileWatcher.start();
  }

  if (vscode.workspace.workspaceFolders?.length) {
    void startWatcher().then(() => statusProvider?.refresh());
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      agent = undefined; db = undefined; vendor = undefined;
      await startWatcher(); statusProvider?.refresh();
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('codex')) { statusProvider?.refresh(); }
    }),
    { dispose: () => fileWatcher?.stop() }
  );

  console.log('[Codex] All commands registered.');
}

export function deactivate(): void { fileWatcher?.stop(); }
