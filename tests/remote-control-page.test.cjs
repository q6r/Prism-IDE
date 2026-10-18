const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const loadTypescript = require('./helpers/load-typescript.cjs')

// The host serves its own copy of the phone's page (T09). Until the IPC side
// goes away (T12) both must be the same page, byte for byte.
const COPY = path.resolve(__dirname, '../host/crates/prism-host/src/domains/remote/page.html')
const SOURCE = 'src/main/ipc/remoteControlPage.ts'
const REGENERATE = 'PRISM_UPDATE_REMOTE_PAGE'

test('a página do host é idêntica ao mobilePage() do app', () => {
  const page = Buffer.from(loadTypescript(SOURCE).mobilePage(), 'utf8')
  if (process.env[REGENERATE] === '1') fs.writeFileSync(COPY, page)
  const copy = fs.readFileSync(COPY)
  const at = (() => { for (let i = 0; i < Math.min(page.length, copy.length); i++) if (page[i] !== copy[i]) return i; return Math.min(page.length, copy.length) })()
  assert.ok(Buffer.compare(page, copy) === 0, [
    `${path.relative(process.cwd(), COPY)} difere do mobilePage() de ${SOURCE} (byte ${at}; ${copy.length} bytes na cópia, ${page.length} no app).`,
    `Regenere a cópia: ${REGENERATE}=1 node --test tests/remote-control-page.test.cjs`,
    `(PowerShell: $env:${REGENERATE}='1'; node --test tests/remote-control-page.test.cjs; Remove-Item Env:${REGENERATE})`
  ].join('\n'))
})
