import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { StringDecoder } from 'string_decoder'
import { profileEnvironment, providerCommand } from './providers'

export class CodexServer {
  private child: ChildProcessWithoutNullStreams
  private serial = 0
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  readonly ready: Promise<void>
  onMessage: (message: any) => void = () => {}
  onClose: (error: Error) => void = () => {}
  private closed = false
  private failure?: Error
  constructor(profileId: string, cwd?: string) {
    const command = providerCommand('codex', profileId)
    if (!command) throw new Error('Instale o Codex para usar esta conta.')
    this.child = spawn(command.bin, [...command.args, 'app-server', '--listen', 'stdio://',
      '-c', 'features.default_mode_request_user_input=true', '-c', 'tools.experimental_request_user_input.enabled=true',
      ...(!profileId.startsWith('ambient-') ? ['-c', 'cli_auth_credentials_store="file"'] : [])], {
      cwd, env: { ...profileEnvironment('codex', profileId), ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
    })
    const decoder = new StringDecoder('utf8'), errors = new StringDecoder('utf8')
    let buffer = '', stderr = ''
    const line = (raw: string): void => {
      if (!raw.trim()) return
      let msg: any
      try { msg = JSON.parse(raw) } catch { return }
      if (!msg.method && msg.id !== undefined) {
        const request = this.pending.get(msg.id)
        if (!request) return
        this.pending.delete(msg.id); clearTimeout(request.timer)
        if (msg.error) request.reject(new Error(msg.error.message || 'Falha no Codex App Server.'))
        else request.resolve(msg.result)
      } else this.onMessage(msg)
    }
    this.child.stdout.on('data', (chunk: Buffer) => {
      buffer += decoder.write(chunk)
      const lines = buffer.split('\n'); buffer = lines.pop() || ''; lines.forEach(line)
    })
    this.child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + errors.write(chunk)).slice(-4000) })
    this.child.stdin.on('error', (err) => this.fail(err))
    this.child.on('error', (err) => this.fail(err))
    this.child.on('close', () => {
      line(buffer + decoder.end()); stderr += errors.end()
      const error = this.failure || new Error(stderr.trim() || 'Codex App Server desconectado.')
      this.fail(error)
      this.onClose(error)
    })
    this.ready = this.request('initialize', { clientInfo: { name: 'prism', version: '1.0.0' }, capabilities: { experimentalApi: true } })
      .then(() => { this.notify('initialized', {}) })
    // Consumers still receive the failure, without an unhandled rejection while
    // the caller is setting up its notification handler.
    void this.ready.catch(() => {})
  }
  request(method: string, params: unknown): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Codex App Server fechado.'))
    return new Promise((resolve, reject) => {
      const id = ++this.serial
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Tempo esgotado: ${method}`)) }, 30000)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
  }
  notify(method: string, params: unknown): void { if (!this.closed) this.child.stdin.write(JSON.stringify({ method, params }) + '\n') }
  answer(id: number | string, result: unknown): void { if (!this.closed) this.child.stdin.write(JSON.stringify({ id, result }) + '\n') }
  reject(id: number | string): void { if (!this.closed) this.child.stdin.write(JSON.stringify({ id, error: { code: -32601, message: 'Operação não suportada pelo Prism.' } }) + '\n') }
  private fail(error: Error): void {
    if (this.closed) return
    this.closed = true
    this.failure = error
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error) }
    this.pending.clear()
  }
  close(): void {
    this.fail(new Error('Codex App Server encerrado.'))
    if (process.platform === 'win32' && this.child.pid) {
      spawn('taskkill.exe', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => this.child.kill())
    } else this.child.kill()
  }
}
