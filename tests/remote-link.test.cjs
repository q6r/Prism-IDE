const assert = require('node:assert/strict')
const test = require('node:test')
const loadTypescript = require('./helpers/load-typescript.cjs')
const { remoteLink, parseRemoteLink, MAX_REMOTE_CHATS } = loadTypescript('src/shared/remoteLink.ts')
const rows = [{ tabId: 'a', token: 'token-a', title: 'Primeira conversa' }, { tabId: 'b/ç', token: 'token-b', title: 'Conversa com código' }]
test('um link reúne somente os tokens explicitamente escolhidos e mantém o ativo', () => {
  const url = new URL(remoteLink('https://example.invalid/', rows, 'b/ç'))
  assert.equal(url.search, '', 'os segredos ficam no fragmento, fora do request HTTP')
  assert.deepEqual(parseRemoteLink(url.hash), { chats: rows, activeId: 'b/ç' })
  assert.ok(!remoteLink('https://example.invalid', rows.slice(0, 1)).includes('token-b'))
})
test('links individuais antigos continuam abrindo uma única conversa', () => {
  assert.deepEqual(parseRemoteLink('#t=old&c=chat'), { chats: [{ tabId: 'chat', token: 'old', title: 'Chat' }], activeId: 'chat' })
  assert.equal(new URL(remoteLink('https://example.invalid', rows.slice(0, 1))).hash.includes('sessions'), false)
  assert.equal(remoteLink('https://example.invalid', []), '')
})
test('coleção inválida usa o token individual e registros sem token não entram', () => {
  assert.equal(parseRemoteLink('#t=old&c=a&sessions=broken').chats.length, 1)
  const hash = '#sessions=' + encodeURIComponent(JSON.stringify([{}, rows[0], rows[0], { tabId: 'fake' }, rows[1]]))
  assert.deepEqual(parseRemoteLink(hash).chats, rows)
})
test('coleção tem limite e ativo inexistente cai na primeira conversa', () => {
  const many = Array.from({ length: MAX_REMOTE_CHATS + 5 }, (_, i) => ({ tabId: String(i), token: 't' + i, title: 'Chat' }))
  const parsed = parseRemoteLink(new URL(remoteLink('https://example.invalid', many, 'absent')).hash)
  assert.equal(parsed.chats.length, MAX_REMOTE_CHATS)
  assert.equal(parsed.activeId, '0')
})
