import type { ChatImage, UnifiedChat } from './agents'

export type ImageReferenceChat = Pick<UnifiedChat, 'turns' | 'queued'>
export interface ImageReference { number: number; image: ChatImage }
export const MAX_REFERENCED_IMAGES = 8
export const MAX_IMAGE_BASE64_CHARS = 12 * 1024 * 1024

const validNumber = (value: number | undefined): value is number => Number.isSafeInteger(value) && (value ?? 0) > 0
const sameImage = (a: ChatImage, b: ChatImage): boolean => a.mime === b.mime && a.data === b.data

/** Encounter order is also the fallback order for chats created before numbered images. */
function allImages(chat: ImageReferenceChat, pending: readonly ChatImage[]): ChatImage[] {
  const images: ChatImage[] = []
  for (const turn of chat.turns) {
    images.push(...(turn.images ?? []))
    for (const segment of turn.segments ?? []) images.push(...(segment.images ?? []))
  }
  for (const message of chat.queued ?? []) images.push(...(message.images ?? []))
  images.push(...pending)
  return images
}

/** Images retain their assigned number when referenced again or when the chat reopens. */
export function collectChatImages(chat: ImageReferenceChat, pending: readonly ChatImage[] = []): ImageReference[] {
  const images = allImages(chat, pending)
  const reserved = new Set(images.map(image => image.number).filter(validNumber))
  const catalog: ImageReference[] = []
  let next = 1
  for (const image of images) {
    if (validNumber(image.number)) {
      if (!catalog.some(entry => entry.number === image.number)) catalog.push({ number: image.number, image })
      continue
    }
    // Legacy copies of an already encountered attachment identify the same asset.
    if (catalog.some(entry => entry.image === image || sameImage(entry.image, image))) continue
    // A later reference may have persisted the number of an older legacy image.
    // Reuse it instead of reserving it and relabelling the original on reopen.
    const numberedCopy = images.find(other => validNumber(other.number) && sameImage(other, image))
    if (numberedCopy && validNumber(numberedCopy.number)) {
      if (!catalog.some(entry => entry.number === numberedCopy.number)) catalog.push({ number: numberedCopy.number, image })
      continue
    }
    while (reserved.has(next)) next++
    catalog.push({ number: next, image })
    reserved.add(next++)
  }
  return catalog
}

/** Return only the new attachments, assigning monotonically increasing chat numbers. */
export function numberNewImages(chat: ImageReferenceChat, pending: readonly ChatImage[], added: readonly ChatImage[], highWater = 0): ChatImage[] {
  const catalog = collectChatImages(chat, pending)
  // Numbered uploads may be restored after their draft/queue was removed. Reserve
  // the whole batch first so a new unnumbered image cannot steal a restored label.
  let next = Math.max(validNumber(highWater) ? highWater : 0, catalog.reduce((max, entry) => Math.max(max, entry.number), 0), ...added.map(image => validNumber(image.number) ? image.number : 0)) + 1
  return added.map(image => {
    const existing = validNumber(image.number) ? catalog.find(entry => entry.number === image.number) : undefined
    const preserve = validNumber(image.number) && (!existing || sameImage(existing.image, image))
    const number = preserve && validNumber(image.number) ? image.number : next++
    const numbered = { ...image, number }
    if (!existing || !preserve) catalog.push({ number, image: numbered })
    return numbered
  })
}

/** Labels can also be looked up for legacy images without modifying stored history. */
export function imageReferenceNumber(catalog: readonly ImageReference[], image: ChatImage): number | undefined {
  if (validNumber(image.number) && catalog.some(entry => entry.number === image.number)) return image.number
  return catalog.find(entry => entry.image === image)?.number ?? catalog.find(entry => sameImage(entry.image, image))?.number
}

/** Persist legacy fallback labels before a queue reorder/removal changes encounter order. */
export function numberChatImages<T extends ImageReferenceChat>(chat: T): T {
  const catalog = collectChatImages(chat)
  const annotate = (images: ChatImage[] | undefined): ChatImage[] | undefined => {
    if (!images) return images
    let changed = false
    const numbered = images.map(image => {
      const number = imageReferenceNumber(catalog, image)
      if (number === undefined || image.number === number) return image
      changed = true
      return { ...image, number }
    })
    return changed ? numbered : images
  }
  let changed = false
  const turns = chat.turns.map(turn => {
    const images = annotate(turn.images)
    let segmentChanged = false
    const segments = turn.segments?.map(segment => {
      const images = annotate(segment.images)
      if (images === segment.images) return segment
      segmentChanged = true
      return { ...segment, images }
    })
    if (images === turn.images && !segmentChanged) return turn
    changed = true
    return { ...turn, images, ...(segmentChanged ? { segments } : {}) }
  })
  const queued = chat.queued?.map(message => {
    const images = annotate(message.images)
    if (images === message.images) return message
    changed = true
    return { ...message, images }
  })
  return changed ? { ...chat, turns, ...(chat.queued ? { queued } : {}) } : chat
}

/** Keep visible uploads and promote referenced queue assets whose bytes are not yet in history. */
export function imageAttachmentsForHistory(chat: ImageReferenceChat, attached: readonly ChatImage[], resolved: readonly ChatImage[]): ChatImage[] {
  const catalog = collectChatImages(chat, attached)
  const historical = new Set<number>()
  for (const turn of chat.turns) {
    for (const image of [...(turn.images ?? []), ...(turn.segments ?? []).flatMap(segment => segment.images ?? [])]) {
      const number = imageReferenceNumber(catalog, image)
      if (number !== undefined) historical.add(number)
    }
  }
  const images: ChatImage[] = []
  const seen = new Set<number>()
  const append = (image: ChatImage): void => {
    const number = imageReferenceNumber(catalog, image)
    if (number !== undefined && !seen.has(number)) { seen.add(number); images.push({ ...image, number }) }
  }
  for (const image of attached) append(image)
  for (const image of resolved) {
    const number = imageReferenceNumber(catalog, image)
    if (number !== undefined && !historical.has(number)) append(image)
  }
  return images
}

function hideCode(text: string): string {
  let fence: { char: string; length: number } | undefined
  const lines = text.split(/(?<=\n)/).map(line => {
    const body = line.replace(/\r?\n$/, '')
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(body)
    if (fence) {
      if (match && match[1][0] === fence.char && match[1].length >= fence.length && !match[2].trim()) fence = undefined
      return line.replace(/[^\r\n]/g, ' ')
    }
    if (match && (match[1][0] !== '`' || !match[2].includes('`'))) {
      fence = { char: match[1][0], length: match[1].length }
      return line.replace(/[^\r\n]/g, ' ')
    }
    return line
  })
  const chars = lines.join('').split('')
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== '`') continue
    const start = i
    while (chars[i + 1] === '`') i++
    const length = i - start + 1
    for (let j = i + 1; j < chars.length; j++) {
      if (chars[j] !== '`') continue
      const closeStart = j
      while (chars[j + 1] === '`') j++
      if (j - closeStart + 1 !== length) continue
      for (let k = start; k <= j; k++) if (chars[k] !== '\r' && chars[k] !== '\n') chars[k] = ' '
      i = j
      break
    }
  }
  return chars.join('').replace(/(?:https?:\/\/|mailto:|www\.)[^\s<>"']+/gi, match => ' '.repeat(match.length))
}

interface ParsedReference { raw: string; number: number; valid: boolean }
function referenceTokens(text: string): ParsedReference[] {
  const prose = hideCode(text)
  const tokens: ParsedReference[] = []
  const pattern = /(^|[\s([{'"<>:,;!?])#image[ \t]*([+-]?\d+(?:[.,]\d+)?(?:[eE][+-]?\d+)?)(?![\p{L}\p{N}_])/giu
  for (const match of prose.matchAll(pattern)) {
    const after = prose.slice((match.index ?? 0) + match[0].length)
    // A hash in a file name or a path is not a chat reference.
    // Do not let the regex backtrack a fractional identifier to its integer prefix.
    if (/^(?:\.[\p{L}\p{N}_]|,[\p{N}]|[/\\])/u.test(after)) continue
    const raw = match[2]
    const number = Number(raw)
    tokens.push({ raw, number, valid: /^\d+$/.test(raw) && validNumber(number) })
  }
  return tokens
}

/** References in prose, in encounter order; examples in inline/fenced code are ignored. */
export function parseImageReferences(text: string): number[] {
  return [...new Set(referenceTokens(text).filter(token => token.valid).map(token => token.number))]
}

export type ImageReferenceResult = { ok: true; images: ChatImage[]; prompt: string } | { ok: false; error: string }

/** Resend referenced image bytes and make their provider attachment order explicit. */
export function resolveImageReferences(chat: ImageReferenceChat, text: string, attached: readonly ChatImage[] = []): ImageReferenceResult {
  const tokens = referenceTokens(text)
  if (tokens.some(token => !token.valid)) return { ok: false, error: 'Use um número inteiro positivo para referenciar uma imagem, por exemplo #image 1.' }
  const catalog = collectChatImages(chat, attached)
  const images: ChatImage[] = []
  const seen = new Set<number>()
  const append = (image: ChatImage, number: number): void => {
    if (!seen.has(number)) { seen.add(number); images.push({ ...image, number }) }
  }
  for (const image of attached) {
    const number = imageReferenceNumber(catalog, image)
    if (number !== undefined) append(image, number)
  }
  for (const number of new Set(tokens.map(token => token.number))) {
    const entry = catalog.find(image => image.number === number)
    if (!entry) return { ok: false, error: `A imagem #image ${number} não foi encontrada nesta conversa.` }
    append(entry.image, number)
  }
  if (images.length > MAX_REFERENCED_IMAGES) return { ok: false, error: 'Envie no máximo 8 imagens por mensagem, incluindo as referências.' }
  if (images.reduce((size, image) => size + image.data.length, 0) > MAX_IMAGE_BASE64_CHARS) return { ok: false, error: 'As imagens desta mensagem excedem o limite de 12 MiB. Reduza os anexos ou referências.' }
  const mapping = images.map((image, index) => `Anexo ${index + 1} = #image ${image.number}`).join('\n')
  return { ok: true, images, prompt: mapping ? `${text}\n\n[Referências de imagens anexadas]\n${mapping}` : text }
}
