// Reuse the backend's pinned compiler for focused Node test/diagnostic entry points.
const fs = require('node:fs');
const ts = require('typescript');

require.extensions['.ts'] = (module, filename) => {
  const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  });
  const errors = result.diagnostics.filter(d => d.category === ts.DiagnosticCategory.Error);
  if (errors.length) { throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
    getCanonicalFileName: f => f, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n',
  })); }
  module._compile(result.outputText, filename);
};
