// The journal fixtures the Rust host checks itself against must match what the
// TypeScript implementation produces today, and be internally consistent.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const load = require('./helpers/load-typescript.cjs')
const { build, OUT } = require('../scripts/gen-journal-fixtures.cjs')

const agents = load('src/shared/agents.ts')
const { foldJournal } = load('src/shared/agentJournal.ts', { './agents': agents, './subagents': load('src/shared/subagents.ts') })
const rt = (v) => JSON.parse(JSON.stringify(v))
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(OUT, name), 'utf8'))

test('fixtures on disk are up to date with the generator', () => {
  const files = build()
  assert.deepEqual(Object.keys(files).sort(), ['random.json', 'repository-v02.json', 'scenarios.json'])
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(OUT, name)
    assert.ok(fs.existsSync(file), `${name} missing`)
    assert.equal(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), text, `${name} is stale`)
  }
})

for (const name of ['scenarios.json', 'random.json']) {
  test(`${name}: every case folds to its expected chat`, () => {
    const { cases } = readJson(name)
    assert.ok(Array.isArray(cases) && cases.length > 0)
    for (const [i, c] of cases.entries()) {
      const label = `${name}[${i}] ${c.name ?? ''}`
      assert.ok(c.chat && typeof c.chat === 'object', `${label}: chat`)
      assert.ok(Array.isArray(c.records), `${label}: records`)
      assert.ok(c.expected && typeof c.expected === 'object', `${label}: expected`)
      assert.deepEqual(rt(foldJournal(rt(c.chat), rt(c.records))), c.expected, label)
    }
  })
}

test('repository-v02.json: rows and expected shape, interrupted chat-b', () => {
  const f = readJson('repository-v02.json')
  for (const k of ['documents', 'state', 'events']) assert.ok(Array.isArray(f.rows[k]) && f.rows[k].length > 0, `rows.${k}`)
  assert.ok(Array.isArray(f.schema) && f.schema.length > 0)
  assert.ok(Array.isArray(f.expected.chats))
  for (const k of ['tasks', 'profiles', 'taskTabs']) assert.ok(k in f.expected, `expected.${k}`)
  const b = f.expected.chats.find((c) => c.id === 'chat-b')
  assert.ok(b, 'chat-b present')
  assert.equal(b.turns.find((t) => t.id === 'b-t1').interrupted, true)
  assert.equal(b.pendingTurnId, undefined)
})
