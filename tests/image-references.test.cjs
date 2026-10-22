const assert = require('node:assert/strict')
const test = require('node:test')
const loadTypescript = require('./helpers/load-typescript.cjs')
const { collectChatImages, numberChatImages, numberNewImages, imageReferenceNumber, imageAttachmentsForHistory, parseImageReferences, imageReferenceRanges, resolveImageReferences, MAX_REFERENCED_IMAGES, MAX_IMAGE_BASE64_CHARS } = loadTypescript('src/shared/imageReferences.ts')

const image = (data, number, extra = {}) => ({ mime: 'image/png', data, ...(number === undefined ? {} : { number }), ...extra })
const turn = (id, images, extra = {}) => ({ id, role: 'user', text: '', images, ...extra })
const chat = (turns = [], queued = []) => ({ turns, queued })

test('cached tool images keep distinct references and deduplicate the same stored asset without base64 in the snapshot', () => {
  const a = image('', undefined, { cacheKey: 'first-asset', cachedPath: 'C:/cache/first.png' })
  const b = image('', undefined, { cacheKey: 'second-asset', cachedPath: 'C:/cache/second.png' })
  const state = chat([turn('generated', undefined, { role: 'assistant', segments: [{ kind: 'tool', images: [a, b, { ...a }] }] })])
  const catalog = collectChatImages(state)
  assert.deepEqual(catalog.map(row => row.number), [1, 2])
  assert.equal(imageReferenceNumber(catalog, b), 2)
  const resolved = resolveImageReferences(state, 'Compare #image 2 com #image 1')
  assert.equal(resolved.ok, true)
  assert.deepEqual(resolved.images.map(row => row.cacheKey), ['second-asset', 'first-asset'])
})

test('stable numbers include user, assistant segment, queue and pending images in order', () => {
  const legacy = image('legacy')
  const assistant = image('generated', 4)
  const queued = image('queued', 6)
  const pending = image('pending', 7)
  const state = chat([turn('first', [legacy]), turn('tool', undefined, { role: 'assistant', segments: [{ kind: 'tool', images: [assistant] }] })], [{ text: '', images: [queued] }])
  const catalog = collectChatImages(state, [pending])
  assert.deepEqual(catalog.map(entry => entry.number), [1, 4, 6, 7])
  assert.equal(imageReferenceNumber(catalog, legacy), 1)
  assert.equal(imageReferenceNumber(catalog, { ...assistant }), 4)
  assert.equal(imageReferenceNumber(catalog, image('missing')), undefined)
  assert.deepEqual(collectChatImages(JSON.parse(JSON.stringify(state)), [{ ...pending }]).map(entry => entry.number), [1, 4, 6, 7])
})

test('reference copies do not create new numbers or relabel legacy originals after reopen', () => {
  const state = chat([turn('first', [image('first')]), turn('second', [image('second')])])
  const first = resolveImageReferences(state, 'compare #image 2 com #image 1')
  assert.equal(first.ok, true)
  const reopened = JSON.parse(JSON.stringify(chat([...state.turns, turn('reference', first.images)])))
  const catalog = collectChatImages(reopened)
  assert.deepEqual(catalog.map(entry => entry.number), [1, 2])
  assert.equal(imageReferenceNumber(catalog, reopened.turns[0].images[0]), 1)
  assert.equal(imageReferenceNumber(catalog, reopened.turns[1].images[0]), 2)
  assert.deepEqual(numberNewImages(reopened, [], [image('next')]).map(img => img.number), [3])
})

test('reserved explicit numbers survive gaps, while independent identical uploads retain explicit labels', () => {
  const state = chat([turn('a', [image('same', 8), image('same', 9), image('old')]), turn('b', [image('same', 8)])])
  assert.deepEqual(collectChatImages(state).map(entry => entry.number), [8, 9, 1])
  assert.deepEqual(numberNewImages(state, [], [image('same'), image('same', 9), image('new', 200)]).map(img => img.number), [201, 9, 200])
})

test('restoring a numbered draft preserves its free label while new uploads avoid the whole batch', () => {
  const state = chat([turn('old', [image('one', 1)])])
  const pending = [image('typed-after-send', 3)]
  assert.deepEqual(numberNewImages(state, pending, [image('refused-send', 2)]), [image('refused-send', 2)])
  assert.deepEqual(numberNewImages(state, pending, [image('new'), image('restored', 4)]).map(img => img.number), [5, 4])
  assert.deepEqual(numberNewImages(state, pending, [image('different-bytes', 1)]), [image('different-bytes', 4)])
  assert.deepEqual(numberNewImages(state, pending, [image('new')], 9), [image('new', 10)])
  assert.deepEqual(numberNewImages(state, pending, [image('restored', 2)], 9), [image('restored', 2)])
})

test('numbering never mutates saved turns, queue items or added objects', () => {
  const old = Object.freeze(image('old', 3))
  const pending = Object.freeze(image('pending', 4))
  const added = Object.freeze(image('new'))
  const state = chat([Object.freeze(turn('old', Object.freeze([old])))])
  const result = numberNewImages(state, Object.freeze([pending]), Object.freeze([added]))
  assert.deepEqual(result, [image('new', 5)])
  assert.equal(added.number, undefined)
  assert.equal(old.number, 3)
})

test('parser accepts prose aliases and deduplicates in encounter order', () => {
  assert.deepEqual(parseImageReferences('Compare #image 2, (#IMAGE1) e #image 2 com [#image 3].'), [2, 1, 3])
  assert.deepEqual(parseImageReferences('foo#image1 name_#image2 /dir/#image3 https://example.invalid/#image4 ?file=#image5 #image 6.png'), [])
  assert.deepEqual(parseImageReferences('#image1.2foo #image2,3bar #image1e3foo #image1_foo'), [])
})

test('inline and fenced examples do not attach images, including tilde fences and unfinished fences', () => {
  const text = 'Referência #image 1. `#image 2` e ``diga `#image 3` aqui``\n```ts\n#image 4\n```\n~~~\n#image 5\n~~~~\n#image 6\n```\n#image 7'
  assert.deepEqual(parseImageReferences(text), [1, 6])
  assert.deepEqual(parseImageReferences('Um backtick sem par ` e #image 2.'), [2])
})

test('reference ranges preserve aliases, original spacing and repeated occurrences without boundary punctuation', () => {
  const text = '#image 8, (#IMAGE\t008) e [#image8] depois #image   12!'
  const literals = ['#image 8', '#IMAGE\t008', '#image8', '#image   12']
  const ranges = imageReferenceRanges(text)
  assert.deepEqual(ranges, literals.map((literal, index) => ({ start: text.indexOf(literal), end: text.indexOf(literal) + literal.length, number: index === 3 ? 12 : 8 })))
  assert.deepEqual(ranges.map(range => text.slice(range.start, range.end)), literals)
  assert.deepEqual(parseImageReferences(text), [8, 12], 'the existing parser still deduplicates')
})

test('reference ranges use source UTF-16 offsets after Unicode, hidden code and CRLF', () => {
  const text = '🖼️ referência `😀 #image 7`\r\n```js\r\n😀 #image 9\r\n```\r\nCompare #IMAGE\t2 com #image 2.'
  const first = text.indexOf('#IMAGE\t2')
  const second = text.lastIndexOf('#image 2')
  assert.deepEqual(imageReferenceRanges(text), [
    { start: first, end: first + '#IMAGE\t2'.length, number: 2 },
    { start: second, end: second + '#image 2'.length, number: 2 }
  ])
  assert.equal(text.slice(first, first + '#IMAGE\t2'.length), '#IMAGE\t2')
})

test('reference ranges share literal exclusions for code, URLs, paths and filename identifiers', () => {
  const text = 'https://example.invalid/#image4 www.example.invalid/#image5 mailto:person#image6@test.invalid foo#image1 /dir/#image3 #image 6.png #image7/path #image8\\file `#image 9`\n~~~\n#image 10\n~~~\nVeja #image 11.'
  const start = text.indexOf('#image 11')
  assert.deepEqual(imageReferenceRanges(text), [{ start, end: start + '#image 11'.length, number: 11 }])
  assert.deepEqual(imageReferenceRanges('```\n#image 1'), [])
  assert.deepEqual(imageReferenceRanges(''), [])
})

test('reference ranges omit invalid numeric identifiers and incomplete references', () => {
  const text = '#image 0 #image -1 #image +1 #image 1.5 #image 1,5 #image 1e2 #image 9007199254740992 #image1.2foo #image2,3bar #image1e3foo #image1_foo #image #imag'
  assert.deepEqual(imageReferenceRanges(text), [])
  assert.deepEqual(imageReferenceRanges('#image 9007199254740991'), [{ start: 0, end: 23, number: 9007199254740991 }])
})

test('attached images come first, then prose references; mapping makes reversed references unambiguous', () => {
  const state = chat([turn('old', [image('one', 1), image('two', 2)])])
  const result = resolveImageReferences(state, 'Compare #image 2 com #image 1 e #image 3', [image('three', 3)])
  assert.equal(result.ok, true)
  assert.deepEqual(result.images, [image('three', 3), image('two', 2), image('one', 1)])
  assert.equal(result.prompt, 'Compare #image 2 com #image 1 e #image 3\n\n[Referências de imagens anexadas]\nAnexo 1 = #image 3\nAnexo 2 = #image 2\nAnexo 3 = #image 1')
  assert.equal(resolveImageReferences(state, 'Texto sem imagens').prompt, 'Texto sem imagens')
  assert.equal(resolveImageReferences(state, 'Um anexo', [image('three', 3)]).prompt.endsWith('Anexo 1 = #image 3'), true)
})

test('references resolve queued and generated images, deduplicating the attached reference', () => {
  const state = chat([turn('generated', undefined, { role: 'assistant', segments: [{ kind: 'tool', images: [image('generated', 5)] }] })], [{ text: 'waiting', images: [image('queued', 6)] }])
  const result = resolveImageReferences(state, '#image 6 e #image 5 e #image 6', [image('generated', 5)])
  assert.equal(result.ok, true)
  assert.deepEqual(result.images.map(img => img.number), [5, 6])
})

test('history stores uploads and newly referenced queue assets without duplicating old references', () => {
  const state = chat([turn('old', [image('one', 1)])], [{ text: 'waiting', images: [image('queued', 2)] }])
  const attached = [image('uploaded', 3)]
  const result = resolveImageReferences(state, '#image 1 e #image 2 e #image 3', attached)
  assert.equal(result.ok, true)
  assert.deepEqual(imageAttachmentsForHistory(state, attached, result.images), [image('uploaded', 3), image('queued', 2)])
  assert.deepEqual(imageAttachmentsForHistory(state, [], resolveImageReferences(state, '#image 1').images), [])
  const committed = chat([...state.turns, turn('used-queue-image', imageAttachmentsForHistory(state, [], resolveImageReferences(state, '#image 2').images))])
  assert.deepEqual(resolveImageReferences(committed, '#image 2').images, [image('queued', 2)])
})

test('history promotion uses full catalog reservations and distinguishes identical numbered assets', () => {
  const state = chat([turn('legacy', [image('legacy')])], [{ text: '', images: [image('queued', 1)] }])
  assert.deepEqual(collectChatImages(state).map(entry => entry.number), [2, 1])
  assert.deepEqual(imageAttachmentsForHistory(state, [], resolveImageReferences(state, '#image 2').images), [])
  const distinct = chat([turn('old', [image('same', 1)])], [{ text: '', images: [image('same', 2)] }])
  assert.deepEqual(imageAttachmentsForHistory(distinct, [], resolveImageReferences(distinct, '#image 2').images), [image('same', 2)])
})

test('legacy labels are persisted before queue mutations and numbered rows retain their identity', () => {
  const original = chat([turn('history', [image('old')])], [{ text: 'first', images: [image('first')] }, { text: 'second', images: [image('second')] }])
  const stable = numberChatImages(original)
  assert.deepEqual(stable.queued.map(row => row.images[0].number), [2, 3])
  assert.equal(stable.turns[0].images[0].number, 1)
  const moved = { ...stable, queued: [stable.queued[1], stable.queued[0]] }
  assert.deepEqual(collectChatImages(moved).map(entry => entry.number), [1, 3, 2])
  const removed = { ...stable, queued: [stable.queued[1]] }
  assert.deepEqual(resolveImageReferences(removed, '#image 3').images, [image('second', 3)])
  assert.equal(numberChatImages(stable), stable)
  assert.equal(numberChatImages(moved), moved)
  assert.equal(original.queued[0].images[0].number, undefined)
})

test('invalid and missing references fail before sending; code examples remain ordinary text', () => {
  const state = chat([turn('first', [image('one', 1)])])
  for (const value of ['0', '-1', '+1', '1.5', '1,5', '1e2', '9007199254740992']) {
    const result = resolveImageReferences(state, '#image ' + value)
    assert.equal(result.ok, false, value)
    assert.match(result.error, /número inteiro positivo/)
  }
  const missing = resolveImageReferences(state, '#image 2')
  assert.equal(missing.ok, false)
  assert.match(missing.error, /#image 2 não foi encontrada/)
  assert.equal(resolveImageReferences(state, 'Exemplo `#image 0`').ok, true)
})

test('combined referenced and attached images respect both submission limits', () => {
  const many = Array.from({ length: MAX_REFERENCED_IMAGES + 1 }, (_, index) => image(String(index), index + 1))
  const state = chat([turn('all', many)])
  assert.equal(resolveImageReferences(state, many.slice(0, 8).map(img => '#image ' + img.number).join(' ')).ok, true)
  const overflow = resolveImageReferences(state, many.map(img => '#image ' + img.number).join(' '))
  assert.equal(overflow.ok, false)
  assert.match(overflow.error, /8 imagens/)
  const bytes = resolveImageReferences(chat(), '', [image('A'.repeat(MAX_IMAGE_BASE64_CHARS), 1), image('AAAA', 2)])
  assert.equal(bytes.ok, false)
  assert.match(bytes.error, /12 MiB/)
  assert.equal(resolveImageReferences(chat(), '', [image('A'.repeat(MAX_IMAGE_BASE64_CHARS), 1)]).ok, true)
})
