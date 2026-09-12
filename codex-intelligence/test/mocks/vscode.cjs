'use strict';
/**
 * vscode.cjs
 *
 * Minimal stand-in for the 'vscode' module, used only so that compiled
 * files which `import * as vscode from 'vscode'` at the top level (even
 * if the test only exercises a pure export from that same file) can be
 * require()'d under plain Node without crashing on module resolution.
 *
 * This is intentionally tiny — just enough surface area for the handful
 * of vscode.workspace.getConfiguration() calls our test targets might
 * incidentally trigger. It is NOT a full vscode API mock.
 */

const configStore = {};

module.exports = {
  workspace: {
    getConfiguration(section) {
      const store = configStore[section] || {};
      return {
        get(key, fallback) {
          return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : fallback;
        }
      };
    },
    workspaceFolders: undefined
  },
  __setConfig(section, values) {
    configStore[section] = values;
  }
};
