/** Image locations in agent Markdown are resolved against the chat, never the app URL. */
const IMAGE_MIMES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', apng: 'image/apng', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml'
}
export const CHAT_IMAGE_MAX_BASE64 = 16 * 1024 * 1024
export type ChatImageSource = { kind: 'direct'; url: string } | { kind: 'file'; path: string; mime: string } | { kind: 'error'; message: string }
const invalid = (message = 'O endereço desta imagem não é válido.'): ChatImageSource => ({ kind: 'error', message })
const controls = /[\u0000-\u001f\u007f]/

export function isChatImagePath(value: string): boolean {
  return /\.(png|jpe?g|gif|webp|avif|apng|bmp|ico|svg)(?:[?#]|$)/i.test(value)
}

function normalizePath(value: string): string {
  const path = value.replace(/\\/g, '/')
  const drive = /^[A-Za-z]:/.exec(path)?.[0] ?? ''
  const absolute = !!drive || path.startsWith('/')
  const parts: string[] = []
  for (const part of path.slice(drive.length).split('/')) {
    if (!part || part === '.') continue
    if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop()
    else if (part !== '..' || !absolute) parts.push(part)
  }
  return `${drive}${absolute ? '/' : ''}${parts.join('/')}`
}

export function resolveChatImageSource(value: string | undefined, cwd?: string): ChatImageSource {
  const source = value?.trim() ?? ''
  if (!source || controls.test(source)) return invalid()
  if (/^https?:/i.test(source)) {
    try { const url = new URL(source); return url.hostname ? { kind: 'direct', url: url.href } : invalid() } catch { return invalid() }
  }
  if (/^data:/i.test(source)) {
    if (!/^data:image\/(png|jpe?g|gif|webp|avif|apng|bmp|x-icon|svg\+xml);base64,[a-z\d+/]+=*$/i.test(source)) return invalid('Formato de imagem não suportado.')
    return source.length <= CHAT_IMAGE_MAX_BASE64 ? { kind: 'direct', url: source } : invalid('A imagem excede o limite de 12 MB.')
  }
  let path = source
  if (/^file:/i.test(source)) {
    try {
      const url = new URL(source)
      if (url.hostname && url.hostname.toLowerCase() !== 'localhost') return invalid('Imagens em compartilhamentos de rede não são carregadas automaticamente.')
      path = url.pathname
    } catch { return invalid() }
  } else {
    if (/^sandbox:/i.test(path)) path = path.slice('sandbox:'.length)
    else if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[A-Za-z]:(?:[\\/]|%(?:2f|5c))/i.test(path)) return invalid('Este tipo de endereço de imagem não é suportado.')
    path = path.split(/[?#]/, 1)[0]
  }
  try { path = decodeURIComponent(path) } catch { return invalid() }
  if (controls.test(path) || /^(?:\\\\|\/\/)/.test(path)) return invalid()
  path = path.replace(/^\/([A-Za-z]:[\\/])/, '$1')
  const extension = /\.([a-z\d]+)$/i.exec(path)?.[1]?.toLowerCase()
  const mime = extension ? IMAGE_MIMES[extension] : undefined
  if (!mime) return invalid('Formato de imagem não suportado.')
  if (!/^(?:[A-Za-z]:[\\/]|\/)/.test(path)) {
    if (!cwd) return invalid('A pasta desta conversa não está disponível para abrir a imagem.')
    path = `${cwd.replace(/[\\/]+$/, '')}/${path}`
  } else if (path.startsWith('/') && cwd && /^[A-Za-z]:[\\/]/.test(cwd)) {
    path = `${cwd.slice(0, 2)}${path}`
  }
  return { kind: 'file', path: normalizePath(path), mime }
}

/** Reads through the existing desktop/SFTP API; phone callers keep their grant-scoped API. */
export async function loadChatImage(source: ChatImageSource, read: (path: string) => Promise<string>): Promise<string> {
  if (source.kind === 'error') throw new Error(source.message)
  if (source.kind === 'direct') return source.url
  let base64: string
  try { base64 = await read(source.path) } catch { throw new Error('O arquivo da imagem não existe ou não está acessível nesta conversa.') }
  if (!base64 || !/^[a-z\d+/]+=*$/i.test(base64)) throw new Error('O arquivo da imagem está vazio ou é inválido.')
  if (base64.length > CHAT_IMAGE_MAX_BASE64) throw new Error('A imagem excede o limite de 12 MB.')
  return `data:${source.mime};base64,${base64}`
}
