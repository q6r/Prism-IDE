const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

// Compile the real module without loading Electron, profiles, or a provider CLI.
// Every runtime dependency must be supplied explicitly by the test.
module.exports = function loadTypescript(relativePath, dependencies = {}, runtimeProcess = process) {
  const filename = path.resolve(__dirname, '../..', relativePath)
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename
  })
  const module = { exports: {} }
  const requireMock = (name) => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name]
    throw new Error(`Unexpected runtime dependency: ${name}`)
  }
  vm.runInThisContext(`(function(require, module, exports, process, Buffer) {\n${outputText}\n})`, {
    filename
  })(requireMock, module, module.exports, runtimeProcess, Buffer)
  return module.exports
}
