const { test } = require('node:test')
const assert = require('node:assert/strict')
const loadTypescript = require('./helpers/load-typescript.cjs')
const {
  emptyDraft, toggleOption, toggleOther, setOtherText, answerFor, isAnswered,
  answeredCount, buildSubmission, modeHint, digitTarget
} = loadTypescript('src/renderer/src/components/chat/questionDraft.ts')

const q = (question, ...labels) => ({ question, options: labels.map((label) => ({ label })) })

test('emptyDraft starts with no picks and no text', () => {
  assert.deepEqual(emptyDraft(), { picks: [], otherText: '' })
})

test('free questions are answered by text without requiring an Other selection', () => {
  const question = q('Qual caminho devo usar?')
  const draft = setOtherText(emptyDraft(), '  C:\\projeto  ')
  assert.equal(answerFor(question, draft), 'C:\\projeto')
  assert.equal(isAnswered(question, draft), true)
  assert.equal(answeredCount([question], [draft]), 1)
  assert.deepEqual(buildSubmission([question], [draft]), {
    answers: { 'Qual caminho devo usar?': 'C:\\projeto' }, response: 'C:\\projeto'
  })
  assert.equal(isAnswered(question, setOtherText(emptyDraft(), '   ')), false)
})

test('single-select replaces the choice', () => {
  let d = toggleOption(emptyDraft(), 0, false)
  d = toggleOption(d, 2, false)
  assert.deepEqual(d.picks, [2])
  d = toggleOption(d, 2, false)
  assert.deepEqual(d.picks, [2])
})

test('multi-select toggles and keeps pick order', () => {
  let d = emptyDraft()
  d = toggleOption(d, 2, true)
  d = toggleOption(d, 0, true)
  d = toggleOption(d, 1, true)
  assert.deepEqual(d.picks, [2, 0, 1])
  d = toggleOption(d, 0, true)
  assert.deepEqual(d.picks, [2, 1])
})

test('toggleOption does not mutate the previous draft', () => {
  const d = emptyDraft()
  toggleOption(d, 1, true)
  assert.deepEqual(d.picks, [])
})

test('toggleOther single-select replaces and toggles off', () => {
  let d = toggleOption(emptyDraft(), 1, false)
  d = toggleOther(d, false)
  assert.deepEqual(d.picks, ['other'])
  d = toggleOther(d, false)
  assert.deepEqual(d.picks, [])
})

test('toggleOther multi-select appends and removes', () => {
  let d = toggleOption(emptyDraft(), 1, true)
  d = toggleOther(d, true)
  assert.deepEqual(d.picks, [1, 'other'])
  d = toggleOption(d, 0, true)
  assert.deepEqual(d.picks, [1, 'other', 0])
  d = toggleOther(d, true)
  assert.deepEqual(d.picks, [1, 0])
})

test('setOtherText keeps picks', () => {
  const d = setOtherText(toggleOther(emptyDraft(), true), 'abc')
  assert.deepEqual(d, { picks: ['other'], otherText: 'abc' })
})

test('answerFor joins labels in pick order; other uses trimmed text', () => {
  const question = q('Q?', 'A', 'B', 'C')
  let d = emptyDraft()
  d = toggleOption(d, 2, true)
  d = toggleOther(d, true)
  d = setOtherText(d, '  custom  ')
  d = toggleOption(d, 0, true)
  assert.equal(answerFor(question, d), 'C, custom, A')
})

test('answerFor drops empty other, unknown indexes and undefined drafts', () => {
  const question = q('Q?', 'A')
  assert.equal(answerFor(question, undefined), '')
  assert.equal(answerFor(question, { picks: ['other'], otherText: '   ' }), '')
  assert.equal(answerFor(question, { picks: [0, 5], otherText: '' }), 'A')
})

test('isAnswered and answeredCount', () => {
  const qs = [q('1', 'A'), q('2', 'B'), q('3', 'C')]
  const drafts = [toggleOption(emptyDraft(), 0, false), undefined, toggleOther(emptyDraft(), false)]
  assert.equal(isAnswered(qs[0], drafts[0]), true)
  assert.equal(isAnswered(qs[1], drafts[1]), false)
  assert.equal(isAnswered(qs[2], drafts[2]), false)
  assert.equal(answeredCount(qs, drafts), 1)
  drafts[2] = setOtherText(drafts[2], 'x')
  assert.equal(answeredCount(qs, drafts), 2)
})

test('buildSubmission keys answers by question and joins other texts', () => {
  const qs = [q('First?', 'A', 'B'), q('Second?', 'C'), q('Third?', 'D')]
  const drafts = [
    setOtherText(toggleOther(toggleOption(emptyDraft(), 1, true), true), ' one '),
    setOtherText(toggleOther(emptyDraft(), false), 'two'),
    undefined
  ]
  assert.deepEqual(buildSubmission(qs, drafts), {
    answers: { 'First?': 'B, one', 'Second?': 'two', 'Third?': '' },
    response: 'one\ntwo'
  })
})

test('buildSubmission response is undefined without other texts', () => {
  const qs = [q('Q?', 'A')]
  const r = buildSubmission(qs, [toggleOption(emptyDraft(), 0, false)])
  assert.deepEqual(r.answers, { 'Q?': 'A' })
  assert.equal(r.response, undefined)
  const blank = buildSubmission(qs, [{ picks: ['other'], otherText: '  ' }])
  assert.equal(blank.response, undefined)
})

test('modeHint covers the four phrases', () => {
  assert.equal(modeHint(true, true), 'Escolha quantas quiser e envie')
  assert.equal(modeHint(true, false), 'Escolha quantas quiser e avance')
  assert.equal(modeHint(false, true), 'Escolha uma para enviar')
  assert.equal(modeHint(false, false), 'Escolha uma para continuar')
})

test('digitTarget maps digits to options, other, or null', () => {
  assert.equal(digitTarget('1', 3), 0)
  assert.equal(digitTarget('3', 3), 2)
  assert.equal(digitTarget('4', 3), 'other')
  assert.equal(digitTarget('5', 3), null)
  assert.equal(digitTarget('0', 3), null)
  assert.equal(digitTarget('a', 3), null)
  assert.equal(digitTarget('12', 3), null)
  assert.equal(digitTarget('', 3), null)
  assert.equal(digitTarget('9', 8), 'other')
})
