import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PRESENCE_DEFAULTS, presenceText } from '../src/main/extensions/presenceTemplates.ts'

const editor = {
  file: 'auth.ts', language: 'typescript', workspace: 'Prism',
  folder: 'auth', relativePath: 'src/auth/auth.ts', dirty: false,
  working: false, problems: 1
}

test('English defaults use actual problem counts and recent editing state', () => {
  assert.equal(presenceText('detailsTemplate', {}, editor), 'in Prism - 1 problem found')
  assert.equal(presenceText('detailsTemplate', {}, { ...editor, problems: 2 }), 'in Prism - 2 problems found')
  assert.equal(presenceText('detailsTemplate', {}, { ...editor, problems: 0 }), 'in Prism - 0 problems found')
  assert.equal(presenceText('stateTemplate', {}, editor), 'Viewing auth.ts')
  assert.equal(presenceText('stateTemplate', {}, { ...editor, working: true }), 'Working auth.ts')
  assert.equal(presenceText('stateTemplate', {}, { ...editor, dirty: true }), 'Viewing auth.ts')
})

test('custom labels and file context expand without reinterpreting file names', () => {
  const config = { stateTemplate: '{action} {file} in { folder } ({relativePath}, {language}, {dirty})', workingText: 'Editing' }
  assert.equal(presenceText('stateTemplate', config, { ...editor, working: true, dirty: true }), 'Editing auth.ts in auth (src/auth/auth.ts, typescript, Unsaved)')
  assert.equal(presenceText('stateTemplate', {}, { ...editor, file: '{workspace}.ts' }), 'Viewing {workspace}.ts')
  assert.equal(presenceText('stateTemplate', { stateTemplate: '{unknown}' }, editor), '{unknown}')
})

test('privacy switches hide file and workspace variables in custom templates', () => {
  const config = { showFileName: false, showWorkspace: false, stateTemplate: '{file}|{folder}|{workspace}|{relativePath}' }
  assert.equal(presenceText('stateTemplate', config, editor), 'a file|||')
  assert.equal(presenceText('stateTemplate', { showFileName: false }, editor), 'Viewing a file')
  assert.equal(presenceText('detailsTemplate', { showWorkspace: false }, editor), '1 problem found')
})

test('blank fields, idle state, old configurations and Discord length limits', () => {
  assert.equal(presenceText('stateTemplate', { stateTemplate: ' ' }, editor), undefined)
  assert.equal(presenceText('idleTemplate', {}, { ...editor, file: null }), 'Idle')
  assert.equal(presenceText('detailsTemplate', {}, { file: null, workspace: null, language: null, dirty: false }), 'in No workspace - 0 problems found')
  assert.equal(presenceText('stateTemplate', { stateTemplate: 'x' }, editor), 'x ')
  assert.equal(Array.from(presenceText('stateTemplate', { stateTemplate: '😀'.repeat(200) }, editor)).length, 128)
  assert.equal(presenceText('largeImageTemplate', PRESENCE_DEFAULTS, editor), 'Prism IDE')
})
