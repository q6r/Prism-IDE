// Standalone validation of the remote-control transport: start a tiny HTTP+WS
// server, open a Cloudflare quick tunnel, fetch the page through the PUBLIC url,
// and round-trip a WebSocket message. Mirrors what remoteControl.ts does.
const http = require('http')
const path = require('path')
const fs = require('fs')
const { WebSocketServer, WebSocket } = require('ws')
const { Tunnel, use, install, bin } = require('cloudflared')

async function main() {
  const dir = path.join(__dirname, '..', '.cloudflared-test')
  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')
  use(target)
  if (!fs.existsSync(target)) {
    console.log('[test] downloading cloudflared →', target)
    await install(target)
  }
  console.log('[test] cloudflared bin:', bin, 'exists:', fs.existsSync(bin))

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<!doctype html><meta name=viewport content="width=device-width"><h1>PRISM_RC_OK</h1>')
  })
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, sock, head) => {
    const t = new URL(req.url, 'http://x').searchParams.get('t')
    if (t !== 'secret') {
      sock.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      sock.destroy()
      return
    }
    wss.handleUpgrade(req, sock, head, (ws) => wss.emit('connection', ws))
  })
  wss.on('connection', (ws) => {
    ws.on('message', (m) => ws.send('echo:' + m.toString()))
  })

  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)))
  console.log('[test] local server on', port)

  const tunnel = Tunnel.quick('http://localhost:' + port)
  const url = await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('timeout waiting for url')), 60000)
    tunnel.once('url', (u) => {
      clearTimeout(to)
      resolve(u.replace(/\/$/, ''))
    })
    tunnel.once('error', reject)
  })
  console.log('[test] PUBLIC URL:', url)

  // Cloudflare edge can take a couple seconds to be routable.
  await new Promise((r) => setTimeout(r, 4000))

  let html = ''
  for (let i = 0; i < 6; i++) {
    try {
      const res = await fetch(url + '/', { headers: { 'User-Agent': 'prism-test' } })
      html = await res.text()
      if (html.includes('PRISM_RC_OK')) break
    } catch (e) {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 2500))
  }
  console.log('[test] HTTP through tunnel OK:', html.includes('PRISM_RC_OK'))

  const wsProto = url.replace(/^https/, 'wss')
  const wsOk = await new Promise((resolve) => {
    const ws = new WebSocket(wsProto + '/?t=secret')
    const to = setTimeout(() => resolve(false), 15000)
    ws.on('open', () => ws.send('hello'))
    ws.on('message', (m) => {
      clearTimeout(to)
      ws.close()
      resolve(m.toString() === 'echo:hello')
    })
    ws.on('error', () => {
      clearTimeout(to)
      resolve(false)
    })
  })
  console.log('[test] WebSocket round-trip OK:', wsOk)

  // Auth rejection check.
  const authReject = await new Promise((resolve) => {
    const ws = new WebSocket(wsProto + '/?t=wrong')
    const to = setTimeout(() => resolve(false), 10000)
    ws.on('open', () => {
      clearTimeout(to)
      ws.close()
      resolve(false)
    })
    ws.on('error', () => {
      clearTimeout(to)
      resolve(true)
    })
  })
  console.log('[test] bad token rejected:', authReject)

  tunnel.stop()
  wss.close()
  server.close()
  const pass = html.includes('PRISM_RC_OK') && wsOk && authReject
  console.log(pass ? '\n[test] ✅ ALL PASS' : '\n[test] ❌ FAIL')
  process.exit(pass ? 0 : 1)
}
main().catch((e) => {
  console.error('[test] error:', e)
  process.exit(1)
})
