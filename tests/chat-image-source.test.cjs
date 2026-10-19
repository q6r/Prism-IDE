const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const load = require('./helpers/load-typescript.cjs')
const { resolveChatImageSource: resolve, loadChatImage, CHAT_IMAGE_MAX_BASE64 } = load('src/shared/chatImageSource.ts')

test('agent image paths resolve against the owning Windows or SSH chat folder', () => {
  assert.deepEqual(resolve('screens/modal%20preview.png', 'C:\\project'), { kind: 'file', path: 'C:/project/screens/modal preview.png', mime: 'image/png' })
  assert.equal(resolve('../screens/./modal.png', 'C:/project/app').path, 'C:/project/screens/modal.png')
  assert.equal(resolve('./preview.png', '/srv/project').path, '/srv/project/preview.png')
  assert.equal(resolve('C:\\project\\screens\\modal.png').path, 'C:/project/screens/modal.png')
  assert.equal(resolve('C:%5Cproject%5Cmodal.png').path, 'C:/project/modal.png')
  assert.equal(resolve('/C:/project/screens/modal.png').path, 'C:/project/screens/modal.png')
})

test('file URLs decode spaces without changing literal encoded filename characters', () => {
  assert.equal(resolve('file:///C:/project/modal%20preview.png').path, 'C:/project/modal preview.png')
  assert.equal(resolve('file:///tmp/modal%23preview.png').path, '/tmp/modal#preview.png')
  assert.equal(resolve('file://localhost/C:/project/modal.png').path, 'C:/project/modal.png')
  assert.equal(resolve('sandbox:/mnt/data/modal.png').path, '/mnt/data/modal.png')
  assert.equal(resolve('file://other-computer/share/modal.png').kind, 'error')
})

test('safe remote and inline image URLs remain direct sources', () => {
  assert.deepEqual(resolve('https://example.invalid/preview?id=1'), { kind: 'direct', url: 'https://example.invalid/preview?id=1' })
  assert.equal(resolve('http://localhost:8080/preview.png').kind, 'direct')
  assert.equal(resolve('data:image/png;base64,iVBORw0KGgo=').kind, 'direct')
})

test('unsafe schemes, malformed escapes, network shares, and missing workspace do not reach filesystem reads', async () => {
  let reads = 0
  for (const value of ['javascript:evil.png', 'vbscript:evil.png', 'data:text/html;base64,PHNjcmlwdD4=', '%00.png', 'bad%XX.png', '//server/share.png', '\\\\server\\share.png', './preview.png']) {
    const source = resolve(value)
    assert.equal(source.kind, 'error', value)
    await assert.rejects(loadChatImage(source, async () => { reads++; return 'unexpected' }))
  }
  assert.equal(reads, 0)
})

test('local generated previews read real bytes and a missing file reports an actionable error', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-image-test-'))
  const image = Buffer.from('iVBORw0KGgo=', 'base64')
  const file = path.join(dir, 'modal preview.png')
  try {
    await fs.writeFile(file, image)
    const read = async path => (await fs.readFile(path)).toString('base64')
    assert.equal(await loadChatImage(resolve('./modal%20preview.png', dir), read), 'data:image/png;base64,iVBORw0KGgo=')
    await assert.rejects(loadChatImage(resolve('./missing.png', dir), read), /não existe ou não está acessível/)
    await assert.rejects(loadChatImage(resolve('./empty.png', dir), async () => ''), /vazio ou é inválido/)
    await assert.rejects(loadChatImage(resolve('./large.png', dir), async () => 'A'.repeat(CHAT_IMAGE_MAX_BASE64 + 1)), /excede/)
  } finally {
    // Both files are created by this test; avoid recursively deleting a computed directory.
    await fs.unlink(file)
    await fs.rmdir(dir)
  }
})
