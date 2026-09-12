const path = require('path');

const root = path.join(__dirname, '..');

class Emitter {
  constructor() { this.listeners = []; }
  get event() {
    return (listener) => {
      this.listeners.push(listener);
      return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); } };
    };
  }
  fire(value) { for (const l of [...this.listeners]) { l(value); } }
  dispose() { this.listeners = []; }
}

function uri(fsPath) {
  return {
    fsPath,
    scheme: 'file',
    path: fsPath.replace(/\\/g, '/'),
    toString: () => 'file:///' + fsPath.replace(/\\/g, '/')
  };
}

/** Captures everything the Hub posts to each webview. */
const captured = { terminal: [], response: [], graph: [] };
/** Handlers registered by the Hub, keyed by view id. */
const handlers = {};
const settings = new Map();
const notifications = [];

function makeVscodeStub() {
  return {
    EventEmitter: Emitter,
    Disposable: class { constructor(fn) { this.dispose = fn || (() => {}); } },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
    Uri: {
      file: uri,
      joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts))
    },
    window: {
      createStatusBarItem: () => ({
        text: '', tooltip: '', command: '', backgroundColor: undefined,
        show() {}, hide() {}, dispose() {}
      }),
      createWebviewPanel: (viewType, title, _opts, _options) => {
        const view = viewType.split('.').pop();
        const panel = {
          title,
          viewColumn: 1,
          webview: {
            cspSource: 'vscode-resource:',
            html: '',
            asWebviewUri: (u) => u,
            onDidReceiveMessage: (fn) => { handlers[view] = fn; return { dispose() {} }; },
            postMessage: (msg) => { captured[view].push(msg); return Promise.resolve(true); }
          },
          reveal() {},
          onDidDispose: () => ({ dispose() {} }),
          dispose() {}
        };
        return panel;
      },
      showErrorMessage: (m) => { notifications.push(['error', m]); return Promise.resolve(undefined); },
      showInformationMessage: (m) => { notifications.push(['info', m]); return Promise.resolve(undefined); },
      showQuickPick: () => Promise.resolve(undefined),
      showSaveDialog: () => Promise.resolve(undefined),
      showOpenDialog: () => Promise.resolve(undefined)
    },
    workspace: {
      getConfiguration: () => ({ get: (key, fallback) => (settings.has(key) ? settings.get(key) : fallback) }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
      fs: { writeFile: async () => {}, readFile: async () => Buffer.from('{}') }
    },
    commands: { registerCommand: () => ({ dispose() {} }) }
  };
}

/** Installs the stub into the CJS loader so `require('vscode')` resolves inside the bundle. */
function install() {
  const Module = require('module');
  const stub = makeVscodeStub();
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') { return stub; }
    return original.apply(this, [request, parent, isMain]);
  };
  return stub;
}

function makeContext() {
  const store = new Map();
  return {
    extensionUri: uri(root),
    extensionPath: root,
    subscriptions: [],
    globalState: {
      get: (key, fallback) => (store.has(key) ? store.get(key) : fallback),
      update: async (key, value) => { store.set(key, value); }
    },
    workspaceState: {
      get: (key, fallback) => (store.has(key) ? store.get(key) : fallback),
      update: async (key, value) => { store.set(key, value); }
    }
  };
}

module.exports = { install, makeContext, captured, handlers, settings, notifications, Emitter };
