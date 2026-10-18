const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const loadTypescript = require('./helpers/load-typescript.cjs')

const ROOT = path.resolve(__dirname, '..')
const HOST_DIR = path.join(ROOT, 'host')
const GENERATED = path.join(ROOT, 'src', 'shared', 'host', 'generated')
const shell = process.platform === 'win32'

const hasCargo = spawnSync('cargo', ['--version'], { shell }).status === 0
const skipCargo = hasCargo ? false : 'cargo não encontrado'

function listFiles(dir, base = dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full, base))
    else out.push(path.relative(base, full).split(path.sep).join('/'))
  }
  return out.sort()
}

const normalize = (text) => text.replace(/\r\n/g, '\n')

test('HOST_PROTOCOL equals PROTOCOL_MAJOR/MINOR in prism-protocol', () => {
  const rust = fs.readFileSync(path.join(HOST_DIR, 'crates', 'prism-protocol', 'src', 'lib.rs'), 'utf8')
  const major = Number(/pub const PROTOCOL_MAJOR:\s*u32\s*=\s*(\d+)\s*;/.exec(rust)?.[1])
  const minor = Number(/pub const PROTOCOL_MINOR:\s*u32\s*=\s*(\d+)\s*;/.exec(rust)?.[1])
  assert.ok(Number.isInteger(major) && Number.isInteger(minor), 'constants found in lib.rs')
  const { HOST_PROTOCOL } = loadTypescript('src/shared/host/version.ts')
  assert.deepEqual({ major: HOST_PROTOCOL.major, minor: HOST_PROTOCOL.minor }, { major, minor })
})

test('generated TypeScript types are up to date with prism-protocol', { skip: skipCargo }, () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-ts-rs-'))
  try {
    const run = spawnSync('cargo', ['test', '--release', '-p', 'prism-protocol', 'export_bindings'], {
      cwd: HOST_DIR, shell, encoding: 'utf8', timeout: 600_000, env: { ...process.env, TS_RS_EXPORT_DIR: out }
    })
    assert.equal(run.status, 0, `cargo test falhou:\n${run.stdout}\n${run.stderr}`)
    const fresh = listFiles(out)
    assert.ok(fresh.length > 0, 'ts-rs exported nothing')
    const committed = listFiles(GENERATED)
    assert.deepEqual(committed, fresh, 'set of generated files differs; run `npm run host:types`')
    for (const file of fresh) {
      assert.equal(
        normalize(fs.readFileSync(path.join(GENERATED, file), 'utf8')),
        normalize(fs.readFileSync(path.join(out, file), 'utf8')),
        `${file} está desatualizado; rode \`npm run host:types\``
      )
    }
  } finally {
    const resolved = path.resolve(out)
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('prism-ts-rs-')) fs.rmSync(resolved, { recursive: true, force: true })
  }
})
