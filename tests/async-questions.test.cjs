const test = require('node:test')
const assert = require('node:assert/strict')
const load = require('./helpers/load-typescript.cjs')
const { latestStructuredQuestions, buildStructuredQuestionsReply } = load('src/renderer/src/lib/asyncQuestions.ts')
const turn = (segments, id = 'turn-1') => ({ id, role: 'assistant', segments })
const ask = (title = 'Qual cor?', options = ['Azul', 'Verde'], toolId = 'message-1') => ({ kind: 'text', toolId, text: 'Qual cor?', questions: [{ title, options }] })

test('questions come from native metadata rather than prose that looks like options', () => {
  assert.equal(latestStructuredQuestions([turn([{ kind: 'text', text: 'Qual cor?\n\n- Azul\n- Verde' }])]), null)
  const source = latestStructuredQuestions([turn([ask()])])
  assert.equal(source.turnId, 'turn-1')
  assert.equal(source.itemId, 'message-1')
  assert.deepEqual(source.questions, [{ question: 'Qual cor?', header: '', multiSelect: false,
    options: [{ label: 'Azul', description: '' }, { label: 'Verde', description: '' }] }])
})

test('null or absent options become free answers; malformed metadata is safely ignored', () => {
  const source = latestStructuredQuestions([turn([{ kind: 'text', questions: [null, 3, { title: '' }, { title: 'Nota?', options: null },
    { title: 'Outra nota?' }, { title: 'Cor?', options: ['Azul', null, ' ', 'Azul', 'Verde'] }] }])])
  assert.deepEqual(source.questions.map(question => [question.question, question.options.map(option => option.label)]),
    [['Nota?', []], ['Outra nota?', []], ['Cor?', ['Azul', 'Verde']]])
  assert.equal(latestStructuredQuestions([turn([{ kind: 'text', questions: { title: 'invalid' } }])]), null)
})

test('a user message or in-turn follow-up retires previous questions, and a newer question can follow it', () => {
  assert.equal(latestStructuredQuestions([turn([ask()]), { id: 'user-2', role: 'user' }]), null)
  assert.equal(latestStructuredQuestions([turn([ask(), { kind: 'user', text: 'Azul' }])]), null)
  assert.equal(latestStructuredQuestions([turn([ask()]), turn([], 'turn-2')]), null)
  const source = latestStructuredQuestions([turn([ask(), { kind: 'user', text: 'Azul' }, ask('Tamanho?', ['Grande'], 'message-2')])])
  assert.equal(source.itemId, 'message-2')
  assert.equal(source.questions[0].question, 'Tamanho?')
})

test('source keys survive text streaming and stay within the host queue id limit', () => {
  const first = latestStructuredQuestions([turn([ask()])])
  assert.equal(latestStructuredQuestions([turn([{ ...ask(), text: 'Texto atualizado' }])]).key, first.key)
  assert.notEqual(latestStructuredQuestions([turn([ask()], 'turn-2')]).key, first.key)
  assert.notEqual(latestStructuredQuestions([turn([ask('Qual cor?', ['Azul'], 'message-2')])]).key, first.key)
  const long = latestStructuredQuestions([turn([ask('Qual cor?', [], 'x'.repeat(500))], 'y'.repeat(500))])
  assert.ok(`question:${long.key}`.length <= 128)
})

test('reply text carries the visible question and answer, with all answers required', () => {
  const source = latestStructuredQuestions([turn([{ kind: 'text', questions: [{ title: 'Qual cor?', options: ['Azul'] }, { title: 'Nota?', options: null }] }])])
  assert.equal(buildStructuredQuestionsReply(source, { 'Qual cor?': 'Azul', 'Nota?': '  Fazer mais testes  ', extra: 'ignorado' }),
    'Qual cor?\nResposta: Azul\n\nNota?\nResposta: Fazer mais testes')
  assert.equal(buildStructuredQuestionsReply(source, { 'Qual cor?': 'Azul' }), null)
  assert.equal(buildStructuredQuestionsReply(source, { 'Qual cor?': 'Azul', 'Nota?': ' ' }), null)
})
