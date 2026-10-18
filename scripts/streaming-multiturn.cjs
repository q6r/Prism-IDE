// Validate the exact multi-turn flow Prism's main process now uses: ONE live
// streaming query, push msg1 -> wait for its result -> push msg2 (idle resume)
// -> wait for its result -> end. Confirms turn boundaries (init=start, result=end)
// and that an idle session cleanly accepts a follow-up as a new turn.
const os = require('os'); const path = require('path')
const EXE = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')

function makePump() {
  const q = []; let wake = null; let done = false
  const gen = (async function* () { while (true) { if (q.length) { yield q.shift(); continue } if (done) return; await new Promise((r) => (wake = r)) } })()
  return { gen, push: (m) => { q.push(m); if (wake) { const w = wake; wake = null; w() } }, end: () => { done = true; if (wake) { const w = wake; wake = null; w() } } }
}
const um = (t) => ({ type: 'user', message: { role: 'user', content: t }, parent_tool_use_id: null })

async function main() {
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  const pump = makePump()
  const t0 = Date.now(); const ts = () => ((Date.now() - t0) / 1000).toFixed(1)
  const q = sdk.query({
    prompt: pump.gen,
    options: { model: 'claude-opus-4-8', permissionMode: 'bypassPermissions', includePartialMessages: true,
      pathToClaudeCodeExecutable: EXE, effort: 'low', thinking: { type: 'disabled' }, settingSources: [] }
  })

  let turn = 0, result = 0, sessionId = null, sawText = ''
  // sequencer: push msg1; on result#1 push msg2; on result#2 end.
  pump.push(um('Reply with exactly: ALPHA'))

  for await (const m of q) {
    if (m.type === 'system' && m.subtype === 'init') { turn++; sessionId = m.session_id; console.log(`[${ts()}] TURN-START #${turn} (init) session=${m.session_id.slice(0,8)}`) }
    else if (m.type === 'stream_event' && m.event?.type === 'content_block_delta' && m.event.delta?.type === 'text_delta') sawText += m.event.delta.text
    else if (m.type === 'result') {
      result++
      console.log(`[${ts()}] RESULT #${result} subtype=${m.subtype} text=${JSON.stringify(sawText.trim().slice(0,40))}`)
      sawText = ''
      if (result === 1) { console.log(`[${ts()}] >>> idle resume: pushing msg2`); pump.push(um('Now reply with exactly: BETA')) }
      else if (result >= 2) { pump.end(); break }
    }
  }
  const ok = turn >= 2 && result >= 2
  console.log(`\nturns=${turn} results=${result} sameSession=${!!sessionId}`)
  console.log(ok ? '[multiturn] ✅ PASS — idle resume starts a clean new turn' : '[multiturn] ❌ FAIL')
  process.exit(ok ? 0 : 1)
}
main().catch((e) => { console.error('err:', e); process.exit(1) })
