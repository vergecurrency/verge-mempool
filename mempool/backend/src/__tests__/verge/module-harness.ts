import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { Script } from 'node:vm';
import ts from 'typescript';

/** Unit-test dependency isolation only. Production modules always use their normal dependencies. */
export function importWithDependencies(filename: string, dependencies: Record<string, unknown>): any {
  const requireFile = createRequire(filename);
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  const requireDependency = (name: string) => Object.prototype.hasOwnProperty.call(dependencies, name) ? dependencies[name] : requireFile(name);
  const run = new Script(`(function(exports, require, module, __filename, __dirname) {\n${code}\n})`, { filename }).runInThisContext();
  run(module.exports, requireDependency, module, filename, dirname(filename));
  return module.exports;
}
