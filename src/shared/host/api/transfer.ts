import { HostCallError, type HostCallErrorCode } from '../client'
import type { FilesQuery } from '../generated/FilesQuery'

/**
 * Bytes that do not travel over JSON-RPC go over HTTP to the host's
 * `/files`, authenticated with the session token (`HostClient.http()`).
 * The desktop preload streams with Node (`src/preload/hostTransfer.ts`);
 * `fetchTransfer` serves anything with `fetch` and the host on its origin.
 */
export interface HostTransfer {
  /** The file's bytes (`GET /files?path=`). */
  download(path: string): Promise<Uint8Array>
  /** Writes `body` to `target.path` (or a new temporary file with extension `target.temp`); resolves to the path written. */
  upload(target: FilesQuery, body: Uint8Array): Promise<string>
  /** Streams a file of this machine's disk to the host (desktop only). */
  uploadLocal?(target: FilesQuery, localPath: string): Promise<string>
}

export interface HostHttp {
  readonly base: string
  readonly token: string
}

export function filesUrl(base: string, query: FilesQuery): string {
  const params = new URLSearchParams()
  if (query.path !== undefined) params.set('path', query.path)
  if (query.temp !== undefined) params.set('temp', query.temp)
  return `${base}/files?${params.toString()}`
}

/** The host's answer to a failed `/files` request, as a call error. */
export function filesError(status: number, text: string): HostCallError {
  try {
    const body = JSON.parse(text) as { code?: HostCallErrorCode; message?: string }
    if (body.message) return new HostCallError(body.code ?? 'internal', body.message)
  } catch { /* not JSON */ }
  return new HostCallError(status === 404 ? 'not_found' : 'internal', `O host recusou a transferência (${status}).`)
}

export function notConnected(): HostCallError {
  return new HostCallError('disconnected', 'O host do Prism não está conectado.')
}

export function fetchTransfer(http: () => HostHttp | null, fetchImpl: typeof fetch = fetch): HostTransfer {
  const send = async (method: 'GET' | 'PUT', query: FilesQuery, body?: Uint8Array): Promise<Response> => {
    const target = http()
    if (!target) throw notConnected()
    let response: Response
    try {
      response = await fetchImpl(filesUrl(target.base, query), {
        method,
        headers: { Authorization: `Bearer ${target.token}`, ...(body ? { 'Content-Type': 'application/octet-stream' } : {}) },
        ...(body ? { body: body as unknown as RequestInit['body'] } : {})
      })
    } catch {
      throw notConnected()
    }
    if (!response.ok) throw filesError(response.status, await response.text())
    return response
  }
  return {
    download: async (path) => new Uint8Array(await (await send('GET', { path })).arrayBuffer()),
    upload: async (target, body) => ((await (await send('PUT', target, body)).json()) as { path: string }).path
  }
}

/** Base64 of bytes (what `fs.readFileBytes` has always answered). */
export function toBase64(bytes: Uint8Array): string {
  const NodeBuffer = (globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } }).Buffer
  if (NodeBuffer) return NodeBuffer.from(bytes).toString('base64')
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

export function fromBase64(text: string): Uint8Array {
  const NodeBuffer = (globalThis as { Buffer?: { from(s: string, enc: string): Uint8Array } }).Buffer
  if (NodeBuffer) return new Uint8Array(NodeBuffer.from(text, 'base64'))
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
