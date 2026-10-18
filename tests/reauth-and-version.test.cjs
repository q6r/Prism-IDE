const { test } = require('node:test')
const assert = require('node:assert/strict')
const load = require('./helpers/load-typescript.cjs')

const usage = load('src/renderer/src/components/settings/usage.ts', { '../../lib/profileAccent': load('src/renderer/src/lib/profileAccent.ts') })
const { needsSignIn, reauthTarget, LOGIN_GONE } = load('src/renderer/src/components/agent/reauth.ts', { '../settings/usage': usage })
const { cliVersionWarning, traycerLinkSignInBlock } = usage

const profile = (over = {}) => ({ id: 'w', provider: 'claude', name: 'Work', enabled: true, ...over })
const chat = (profileId = 'w', provider = 'claude') => ({ selection: { provider, profileId } })

test('needsSignIn só para cli_auth', () => {
  assert.equal(LOGIN_GONE, 'cli_auth')
  assert.equal(needsSignIn({ errorCode: 'cli_auth' }), true)
  assert.equal(needsSignIn({ errorCode: 'other' }), false)
  assert.equal(needsSignIn({}), false)
  assert.equal(needsSignIn({ errorCode: '' }), false)
})

test('reauthTarget: perfil ok → blocked null', () => {
  const p = profile()
  assert.deepEqual(reauthTarget(chat(), [profile({ id: 'x' }), p], false), { profile: p, blocked: null })
})

test('reauthTarget: conta do terminal', () => {
  const r = reauthTarget(chat('ambient-claude'), [profile({ id: 'ambient-claude', ambient: true })], false)
  assert.equal(r.blocked, 'A conta do terminal é gerenciada pelo terminal.')
})

test('reauthTarget: perfil desativado', () => {
  assert.equal(reauthTarget(chat(), [profile({ enabled: false })], false).blocked, 'Ative o perfil para entrar.')
})

test('reauthTarget: vínculo com o Traycer vem antes dos demais motivos', () => {
  const r = reauthTarget(chat(), [profile({ traycerLink: { root: 'r' }, enabled: false })], true)
  assert.equal(r.blocked, 'Este perfil usa o login do Traycer. Desvincule-o para entrar pelo Prism.')
  assert.equal(r.blocked, traycerLinkSignInBlock(profile({ traycerLink: {} })))
})

test('reauthTarget: conversa em andamento', () => {
  assert.equal(reauthTarget(chat(), [profile()], true).blocked, 'Há uma conversa em andamento com este perfil.')
})

test('reauthTarget: removido, desconhecido ou de outro provedor → null', () => {
  assert.equal(reauthTarget(chat(), [profile({ tombstoned: true })], false), null)
  assert.equal(reauthTarget(chat('nope'), [profile()], false), null)
  assert.equal(reauthTarget(chat('w', 'codex'), [profile()], false), null)
  assert.equal(reauthTarget(chat(), [], false), null)
})

test('cliVersionWarning: verified false com warning → o warning', () => {
  assert.equal(cliVersionWarning({ version: '1.0', verified: false, warning: 'Versão antiga.' }), 'Versão antiga.')
})

test('cliVersionWarning: sem warning → texto padrão com a versão', () => {
  assert.equal(cliVersionWarning({ version: '2.3.4', verified: false }), 'A versão 2.3.4 do CLI não foi verificada com o Prism.')
  assert.equal(cliVersionWarning({ version: '', verified: false, warning: '' }), 'A versão instalada do CLI não foi verificada com o Prism.')
})

test('cliVersionWarning: verificado, ausente ou nulo → null', () => {
  assert.equal(cliVersionWarning({ version: '1', verified: true, warning: 'x' }), null)
  assert.equal(cliVersionWarning({ version: '1' }), null)
  assert.equal(cliVersionWarning(null), null)
  assert.equal(cliVersionWarning(undefined), null)
})
