import * as vscode from 'vscode';
import * as path from 'node:path';
import type { LiveController } from '../liveUpdate/liveController';

/**
 * Best-effort: not every debug adapter answers `stackTrace` identically, and this can
 * only be exercised against a real, live debug session — there's no way to simulate
 * that outside an actual VS Code Extension Development Host. The structure here follows
 * the standard DAP tracker pattern; treat this as the Phase 7 skeleton to validate
 * against your actual debugger of choice (cppdbg, cppvsdbg, lldb, cortex-debug, ...).
 */
export function registerDebugOverlay(context: vscode.ExtensionContext, liveController: LiveController, postHighlight: (nodeId: string | null) => void): void {
  const factory: vscode.DebugAdapterTrackerFactory = {
    createDebugAdapterTracker(session: vscode.DebugSession): vscode.DebugAdapterTracker {
      return {
        onDidSendMessage: async (message: unknown) => {
          const msg = message as { type?: string; event?: string; body?: { threadId?: number } };
          if (msg.type !== 'event') {
            return;
          }

          if (msg.event === 'continued' || msg.event === 'terminated' || msg.event === 'exited') {
            postHighlight(null);
            return;
          }

          if (msg.event === 'stopped' && msg.body?.threadId !== undefined) {
            try {
              const stack = (await session.customRequest('stackTrace', {
                threadId: msg.body.threadId,
                startFrame: 0,
                levels: 1
              })) as { stackFrames?: Array<{ line: number; source?: { path?: string } }> };

              const frame = stack?.stackFrames?.[0];
              const currentDoc = liveController.getCurrentDocument();
              const graph = liveController.getCurrentGraph();
              if (!frame?.source?.path || !currentDoc || !graph) {
                return;
              }

              if (path.normalize(frame.source.path) !== path.normalize(currentDoc.uri.fsPath)) {
                postHighlight(null);
                return;
              }

              const line = frame.line - 1; // DAP lines are 1-based
              const match = [...graph.nodes.values()].find((n) => line >= n.anchorRange.start.row && line <= n.anchorRange.end.row);
              postHighlight(match ? match.id : null);
            } catch {
              // swallow — the active adapter may not support this exact stackTrace shape
            }
          }
        }
      };
    }
  };

  context.subscriptions.push(vscode.debug.registerDebugAdapterTrackerFactory('*', factory));
}
