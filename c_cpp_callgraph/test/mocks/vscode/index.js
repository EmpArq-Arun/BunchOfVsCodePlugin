// Minimal mock of the 'vscode' module surface that WorkspaceIndex touches.
// The test sets `global.__mockFiles = { 'relative/path.c': 'source text', ... }`
// before calling ensureFresh().

function makeUri(relPath) {
  return { __relPath: relPath, fsPath: relPath, toString: () => relPath };
}

const workspace = {
  findFiles: async (_glob, _exclude, _limit) => {
    const files = global.__mockFiles || {};
    return Object.keys(files).map(makeUri);
  },
  fs: {
    readFile: async (uri) => {
      const files = global.__mockFiles || {};
      const text = files[uri.__relPath];
      if (text === undefined) throw new Error(`mock file not found: ${uri.__relPath}`);
      return Buffer.from(text, 'utf8');
    },
  },
  asRelativePath: (uri) => (typeof uri === 'string' ? uri : uri.__relPath),
  getConfiguration: (_section) => ({
    get: (_key, defaultValue) => defaultValue,
  }),
};

module.exports = { workspace };
