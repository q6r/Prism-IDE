const test = require('node:test')
const assert = require('node:assert/strict')
const load = require('./helpers/load-typescript.cjs')

const m = load('src/renderer/src/components/browser/browserModel.ts')
const key = (k, mods = {}, code = '') => ({ key: k, code, ctrl: false, meta: false, shift: false, alt: false, ...mods })

test('normalizeBrowserAddressInput: addresses', () => {
  const n = (s) => m.normalizeBrowserAddressInput(s, 'google')
  assert.equal(n('   '), 'about:blank')
  assert.equal(n('localhost:5173'), 'http://localhost:5173')
  assert.equal(n('app.localhost/x'), 'http://app.localhost/x')
  assert.equal(n('127.0.0.1:3000'), 'http://127.0.0.1:3000')
  assert.equal(n('[::1]:8080'), 'http://[::1]:8080')
  assert.equal(n('example.com'), 'https://example.com')
  assert.equal(n('host:8080'), 'https://host:8080')
  assert.equal(n('https://app.localhost:3000'), 'https://app.localhost:3000')
})

test('normalizeBrowserAddressInput: searches', () => {
  const n = (s, e = 'google') => m.normalizeBrowserAddressInput(s, e)
  assert.equal(n('hello world'), 'https://www.google.com/search?q=hello+world')
  assert.equal(n('foo'), 'https://www.google.com/search?q=foo')
  assert.equal(n('site:foo.com bar'), m.browserSearchUrl('site:foo.com bar', 'google'))
  assert.equal(n('user:pass@host.com'), m.browserSearchUrl('user:pass@host.com', 'google'))
  assert.equal(n('a&b=c d', 'duckduckgo'), 'https://duckduckgo.com/?q=a%26b%3Dc+d')
  assert.equal(n('x y', 'bing'), 'https://www.bing.com/search?q=x+y')
  assert.equal(n('x y', 'kagi'), 'https://kagi.com/search?q=x+y')
})

test('navigationPolicy / isSameAddress / addressDisplayValue', () => {
  assert.equal(m.navigationPolicy('https://a.com').kind, 'navigate')
  assert.equal(m.navigationPolicy('http://a.com').kind, 'navigate')
  assert.equal(m.navigationPolicy('').kind, 'blank')
  assert.equal(m.navigationPolicy('about:blank').kind, 'blank')
  assert.equal(m.navigationPolicy('mailto:a@b.c').kind, 'external')
  assert.equal(m.navigationPolicy('tel:123').kind, 'external')
  for (const u of ['file:///x', 'javascript:alert(1)', 'chrome://settings']) assert.equal(m.navigationPolicy(u).kind, 'unsupported')
  assert.ok(m.isSameAddress('https://x.com', 'https://x.com/'))
  assert.ok(!m.isSameAddress('https://x.com', 'https://y.com'))
  assert.equal(m.addressDisplayValue('about:blank'), '')
  assert.equal(m.addressDisplayValue('https://x.com/'), 'https://x.com/')
})

test('tab titles', () => {
  assert.equal(m.resolveTabTitle('x', 'about:blank'), 'Nova aba')
  assert.equal(m.resolveTabTitle('', 'https://www.example.com/a'), 'www.example.com')
  assert.equal(m.resolveTabTitle(null, 'https://example.com/a'), 'example.com')
  for (const t of ['example.com', 'WWW.Example.com', 'https://example.com/', 'example.com/', 'https://example.com/a'])
    assert.equal(m.resolveTabTitle(t, 'https://example.com/a'), 'example.com', t)
  assert.equal(m.resolveTabTitle('www.example.com', 'https://example.com'), 'example.com')
  assert.equal(m.resolveTabTitle('Real Title', 'https://example.com'), 'Real Title')
  assert.equal(m.resolveTabTitle('', 'not a url'), 'Navegador')
  assert.equal(m.meaningfulDocumentTitle('about:blank', 'https://a.com'), null)
})

test('url helpers', () => {
  assert.equal(m.browserTabFaviconUrl('https://a.com/x/y'), 'https://a.com/favicon.ico')
  assert.equal(m.browserTabFaviconUrl('about:blank'), null)
  assert.equal(m.browserTabOrigin('http://a.com:81/x'), 'http://a.com:81')
  assert.equal(m.browserTabOrigin('file:///x'), null)
  assert.equal(m.browserTabHostname('https://a.com/x'), 'a.com')
  assert.equal(m.browserTabHostname('nope'), null)
  assert.equal(m.parseHttpUrl('ftp://a.com'), null)
  assert.equal(m.parseHttpUrl('http://a.com').hostname, 'a.com')
})

test('nextZoomPercent', () => {
  assert.equal(m.nextZoomPercent(100, 1), 110)
  assert.equal(m.nextZoomPercent(100, -1), 90)
  assert.equal(m.nextZoomPercent(500, 1), 500)
  assert.equal(m.nextZoomPercent(25, -1), 25)
  assert.equal(m.nextZoomPercent(104, -1), 100)
  assert.equal(m.nextZoomPercent(104, 1), 110)
  assert.equal(m.nextZoomPercent(10, 1), 25)
  assert.equal(m.nextZoomPercent(999, -1), 500)
})

test('registrableDomain', () => {
  const r = m.registrableDomain
  assert.equal(r('https://a.b.example.com'), 'example.com')
  assert.equal(r('https://x.example.com.br'), 'example.com.br')
  assert.equal(r('https://x.foo.co.uk'), 'foo.co.uk')
  assert.equal(r('https://example.com.'), 'example.com')
  assert.equal(r('http://localhost:3000'), 'localhost')
  assert.equal(r('http://10.1.2.3'), '10.1.2.3')
  assert.equal(r('http://[::1]:80'), '[::1]')
  assert.equal(r('file:///x'), null)
  assert.equal(r('about:blank'), null)
})

test('securityState', () => {
  const s = (u, t = []) => m.securityState(u, t)
  assert.equal(s('about:blank'), 'blank')
  assert.equal(s('https://a.com'), 'secure')
  for (const u of ['http://localhost:3000', 'http://127.0.0.1', 'http://[::1]:80', 'http://x.localhost']) assert.equal(s(u), 'local', u)
  assert.equal(s('http://a.com'), 'insecure')
  assert.equal(s('https://a.com/x', ['https://a.com']), 'certificate')
  assert.equal(s('file:///x'), 'other')
})

test('resolveOverlay', () => {
  for (const c of [true, false]) for (const st of [true, false]) {
    assert.equal(m.resolveOverlay('crashed', c, st), 'crashed')
    assert.equal(m.resolveOverlay('failed', c, st), 'failed')
    assert.equal(m.resolveOverlay('ready', c, st), 'none')
  }
  assert.equal(m.resolveOverlay('loading', false, false), 'loading')
  assert.equal(m.resolveOverlay('loading', false, true), 'stalled')
  assert.equal(m.resolveOverlay('loading', true, true), 'none')
})

test('error labels and find status', () => {
  assert.ok(m.isIgnorableLoadError(-3))
  assert.ok(!m.isIgnorableLoadError(-105))
  assert.equal(m.loadErrorLabel(-105), 'Não foi possível encontrar o endereço do servidor.')
  assert.equal(m.loadErrorLabel(-102), 'A conexão foi recusada. Verifique se o servidor está em execução.')
  assert.match(m.loadErrorLabel(-202), /certificado/)
  assert.equal(m.loadErrorLabel(-9999), 'Ocorreu um erro ao carregar a página.')
  assert.equal(m.crashReasonLabel('oom'), 'A página ficou sem memória.')
  assert.equal(m.crashReasonLabel('zzz'), 'O processo da página parou inesperadamente.')
  assert.equal(m.findStatusLabel('', true, 1, 1), null)
  assert.equal(m.findStatusLabel('a', true, 0, 0), 'Buscando')
  assert.equal(m.findStatusLabel('a', false, 0, 0), 'Nenhum resultado')
  assert.equal(m.findStatusLabel('a', false, 2, 5), '2 de 5')
})

test('browserChordForKey', () => {
  const c = m.browserChordForKey
  const ctrl = { ctrl: true }, cs = { ctrl: true, shift: true }
  assert.equal(c(key('t', ctrl, 'KeyT')), 'newTab')
  assert.equal(c(key('T', cs, 'KeyT')), 'reopenClosedTab')
  assert.equal(c(key('w', ctrl)), 'closeTab')
  assert.equal(c(key('W', cs)), null)
  assert.equal(c(key('l', ctrl)), 'focusAddress')
  assert.equal(c(key('d', { alt: true })), 'focusAddress')
  assert.equal(c(key('F6')), 'focusAddress')
  assert.equal(c(key('f', ctrl)), 'find')
  assert.equal(c(key('F', cs)), null)
  assert.equal(c(key('r', ctrl)), 'reload')
  assert.equal(c(key('R', cs)), 'hardReload')
  assert.equal(c(key('F5', ctrl)), 'hardReload')
  assert.equal(c(key('F5', { shift: true })), 'hardReload')
  assert.equal(c(key('F5')), 'reload')
  assert.equal(c(key('I', cs)), 'devtools')
  assert.equal(c(key('F12')), 'devtools')
  assert.equal(c(key('Tab', ctrl)), 'nextTab')
  assert.equal(c(key('PageDown', ctrl)), 'nextTab')
  assert.equal(c(key('Tab', cs)), 'previousTab')
  assert.equal(c(key('PageUp', ctrl)), 'previousTab')
  assert.equal(c(key('=', ctrl, 'Equal')), 'zoomIn')
  assert.equal(c(key('+', cs, 'Equal')), 'zoomIn')
  assert.equal(c(key('+', ctrl, 'NumpadAdd')), 'zoomIn')
  assert.equal(c(key('-', ctrl, 'Minus')), 'zoomOut')
  assert.equal(c(key('0', ctrl, 'Digit0')), 'zoomReset')
  for (let i = 1; i <= 9; i++) assert.equal(c(key(String(i), ctrl, `Digit${i}`)), `selectTab${i}`)
  assert.equal(c(key('ArrowLeft', { alt: true })), 'back')
  assert.equal(c(key('ArrowRight', { alt: true })), 'forward')
  assert.equal(c(key('t', { meta: true })), 'newTab')
  assert.equal(c(key('b', ctrl)), null)
  assert.equal(c(key('p', ctrl)), null)
  assert.equal(c(key('a')), null)
})

const tab = (id, o = {}) => ({ id, url: 'https://a.com', title: 't', faviconUrl: null, zoomPercent: 100, ...o })

test('persistence round-trip and sanitising', () => {
  const state = { activeId: 'b', tabs: [tab('a'), tab('b', { url: 'about:blank', zoomPercent: 150, faviconUrl: 'https://a.com/favicon.ico' })] }
  assert.deepEqual(m.parsePersistedBrowserState(m.serializeBrowserState(state)), { version: 1, ...state })
  for (const bad of [null, undefined, '', '{', 'null', '[]', JSON.stringify({ version: 2, tabs: [] }), JSON.stringify({ version: 1, tabs: {} })])
    assert.equal(m.parsePersistedBrowserState(bad), null, String(bad))
  const parsed = m.parsePersistedBrowserState(JSON.stringify({
    version: 1, activeId: 'ghost',
    tabs: [{ url: 'https://x.com' }, tab('a'), tab('a', { url: 'https://dup.com' }), tab('f', { url: 'file:///x' }), 5, null,
      tab('z', { zoomPercent: 9999, faviconUrl: 'data:x' }), tab('y', { zoomPercent: 1 }), tab('n', { zoomPercent: 'big' })]
  }))
  assert.deepEqual(parsed.tabs.map((t) => t.id), ['a', 'z', 'y', 'n'])
  assert.equal(parsed.activeId, 'a')
  assert.equal(parsed.tabs[0].url, 'https://a.com')
  assert.equal(parsed.tabs[1].zoomPercent, 500)
  assert.equal(parsed.tabs[1].faviconUrl, null)
  assert.equal(parsed.tabs[2].zoomPercent, 25)
  assert.equal(parsed.tabs[3].zoomPercent, 100)
})

test('serialize: unrestorable urls blank, active fallback, tab cap', () => {
  const out = JSON.parse(m.serializeBrowserState({ activeId: 'nope', tabs: [tab('a', { url: 'blob:https://a.com/1' }), tab('b', { url: 'data:text/html,x' })] }))
  assert.deepEqual(out.tabs.map((t) => t.url), ['about:blank', 'about:blank'])
  assert.equal(out.activeId, 'a')
  const many = Array.from({ length: 80 }, (_, i) => tab(`t${i}`))
  assert.equal(JSON.parse(m.serializeBrowserState({ activeId: 't0', tabs: many })).tabs.length, m.MAX_PERSISTED_TABS)
  const raw = JSON.stringify({ version: 1, activeId: 't0', tabs: many })
  assert.equal(m.parsePersistedBrowserState(raw).tabs.length, 50)
  assert.equal(JSON.parse(m.serializeBrowserState({ activeId: null, tabs: [] })).activeId, null)
})

test('nextActiveAfterClose', () => {
  const f = (ids, a, closing) => m.nextActiveAfterClose(ids, a, new Set(closing))
  assert.equal(f(['a', 'b', 'c'], 'b', ['b']), 'c')
  assert.equal(f(['a', 'b', 'c'], 'c', ['c']), 'b')
  assert.equal(f(['a', 'b', 'c'], 'a', ['b']), 'a')
  assert.equal(f(['a'], 'a', ['a']), null)
  assert.equal(f(['a', 'b', 'c', 'd'], 'b', ['b', 'c']), 'd')
  assert.equal(f(['a', 'b', 'c', 'd'], 'c', ['c', 'd']), 'b')
  assert.equal(f(['a', 'b'], 'a', ['a', 'b']), null)
})

test('moveTabId', () => {
  const ids = ['a', 'b', 'c', 'd']
  assert.deepEqual(m.moveTabId(ids, 'a', 3), ['b', 'c', 'a', 'd'])
  assert.deepEqual(m.moveTabId(ids, 'a', 4), ['b', 'c', 'd', 'a'])
  assert.deepEqual(m.moveTabId(ids, 'd', 0), ['d', 'a', 'b', 'c'])
  assert.deepEqual(m.moveTabId(ids, 'c', 1), ['a', 'c', 'b', 'd'])
  const copy = m.moveTabId(ids, 'zz', 1)
  assert.deepEqual(copy, ids)
  assert.notEqual(copy, ids)
})
