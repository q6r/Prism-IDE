import { request } from 'http'
import { createReadStream, promises as fs } from 'fs'
import type { FilesQuery } from '../shared/host/generated/FilesQuery'
import { filesError, filesUrl, notConnected, type HostHttp, type HostTransfer } from '../shared/host/api/transfer'
import type { LocalFiles } from '../shared/host/api/fs'

/**
 * The desktop's `/files` transport: Node's `http` from the preload, so the
 * page's CORS and CSP never apply and the session token stays here. Local
 * files dragged in from the OS are streamed from disk, never held whole.
 */
export function nodeTransfer(http: () => HostHttp | null): HostTransfer {
  const send = (method: 'GET' | 'PUT', query: FilesQuery, body?: Uint8Array | string): Promise<Buffer> => {
    const target = http()
    if (!target) return Promise.reject(notConnected())
    return new Promise<Buffer>((resolve, reject) => {
      const req = request(filesUrl(target.base, query), {
        method,
        headers: { Authorization: `Bearer ${target.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/octet-stream' }) }
      }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('error', () => reject(notConnected()))
        res.on('end', () => {
          const data = Buffer.concat(chunks)
          const status = res.statusCode ?? 0
          if (status >= 200 && status < 300) resolve(data)
          else reject(filesError(status, data.toString('utf8')))
        })
      })
      req.on('error', () => reject(notConnected()))
      if (typeof body === 'string') {
        const file = createReadStream(body)
        file.on('error', (err) => { req.destroy(); reject(err) })
        file.pipe(req)
      } else {
        req.end(body === undefined ? undefined : Buffer.from(body.buffer, body.byteOffset, body.byteLength))
      }
    })
  }
  const written = (data: Buffer): string => (JSON.parse(data.toString('utf8')) as { path: string }).path
  return {
    download: async (path) => new Uint8Array(await send('GET', { path })),
    upload: async (target, body) => written(await send('PUT', target, body)),
    uploadLocal: async (target, localPath) => written(await send('PUT', target, localPath))
  }
}

/** This machine's disk, for files dragged in from the OS. */
export const nodeLocalFiles: LocalFiles = {
  kind: async (path, follow) => {
    try {
      const stat = follow ? await fs.stat(path) : await fs.lstat(path)
      return stat.isFile() ? 'file' : stat.isDirectory() ? 'dir' : null
    } catch {
      return null
    }
  },
  list: (dir) => fs.readdir(dir)
}
