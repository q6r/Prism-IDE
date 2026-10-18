// Probe the Claude Agent SDK's streaming-input mode to learn how follow-up
// messages injected mid-turn behave (steer vs queue) and how turn/result
// boundaries are framed — so the Prism refactor maps events correctly.
const os = require('os')
const path = require('path')

const EXE = path.join(os.homedir(), '.local', 'bin', 'win32' === process.platform ? 'claude.exe' : 'claude')

function makePump() {
  const queue = []
  let wake = null
  let done = false
  const gen = (async function* () {
    while (true) {
      if (queue.length) { yield queue.shift(); continue }
      if (done) return
      await new Promise((r) => (wake = r))
    }
  })()
  return {
    gen,
    push: (m) => { queue.push(m); if (wake) { const w = wake; wake = null; w() } },
    end: () => { done = true; if (wake) { const w = wake; wake = null; w() } }
  }
}

function umsg(text, priority) {
  const m = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }
  if (priority) m.priority = priority
  return m
}

async function main() {
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  const pump = makePump()
  const t0 = Date.now()
  const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5)

  const options = {
    model: 'claude-opus-4-8',
    permissionMode: 'bypassPermissions',
    includePartialMessages: true,
    pathToClaudeCodeExecutable: EXE,
    effort: 'low',
    thinking: { type: 'disabled' },
    settingSources: []
  }

  const q = sdk.query({ prompt: pump.gen, options })

  // Push the first (long) task, then steer mid-stream after 2.5s.
  pump.push(umsg('Write a detailed 8-paragraph essay about the history of the ocean. Take your time.'))
  let steered = false
  const steerTimer = setInterval(() => {
    if (!steered && Date.now() - t0 > 2500) {
      steered = true
      console.log(`\n[${ts()}] >>> PUSHING follow-up mid-stream (priority=now): "stop, reply BANANA"`)
      pump.push(umsg('Stop the essay immediately and just reply with the single word BANANA.', 'now'))
    }
  }, 200)

  let textChars = 0
  let results = 0
  let curTurnSawText = 0
  for await (const msg of q) {
    if (msg.type === 'system' && msg.subtype === 'init') {
      console.log(`[${ts()}] system/init session=${msg.session_id} model=${msg.model}`)
    } else if (msg.type === 'stream_event') {
      const ev = msg.event
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        textChars += ev.delta.text.length
        curTurnSawText += ev.delta.text.length
        // sample the steered word
        if (/BANANA/i.test(ev.delta.text)) console.log(`[${ts()}] <<< saw BANANA in stream`)
      } else if (ev?.type === 'message_start') {
        console.log(`[${ts()}] message_start (new assistant message; usage in=${ev.message?.usage?.input_tokens})`)
      }
    } else if (msg.type === 'assistant') {
      const tools = (msg.message?.content || []).filter((b) => b.type === 'tool_use').map((b) => b.name)
      if (tools.length) console.log(`[${ts()}] assistant tool_use: ${tools.join(',')}`)
    } else if (msg.type === 'result') {
      results++
      console.log(`[${ts()}] RESULT #${results} subtype=${msg.subtype} textCharsThisTurn=${curTurnSawText} totalChars=${textChars}`)
      curTurnSawText = 0
      if (results >= 2) { pump.end(); break } // got both turns (or steered into one)
      // if only one result and it already contains BANANA, the steer merged into turn 1
    }
  }
  clearInterval(steerTimer)
  console.log(`\n[${ts()}] DONE — results=${results}, totalTextChars=${textChars}`)
  console.log('Interpretation: 1 result with BANANA => steered into the running turn; 2 results => queued as a new turn.')
  process.exit(0)
}
main().catch((e) => { console.error('probe error:', e); process.exit(1) })
