const MAP: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'shell',
  bash: 'shell',
  ps1: 'powershell',
  yml: 'yaml',
  yaml: 'yaml',
  xml: 'xml',
  sql: 'sql',
  toml: 'ini',
  ini: 'ini',
  vue: 'html',
  svelte: 'html',
  dockerfile: 'dockerfile'
}

// Media files get a preview (viewer/player) instead of opening as text.
export type MediaKind = 'image' | 'video' | 'audio'
const MEDIA: Record<string, { kind: MediaKind; mime: string }> = {
  png: { kind: 'image', mime: 'image/png' },
  jpg: { kind: 'image', mime: 'image/jpeg' },
  jpeg: { kind: 'image', mime: 'image/jpeg' },
  gif: { kind: 'image', mime: 'image/gif' },
  webp: { kind: 'image', mime: 'image/webp' },
  bmp: { kind: 'image', mime: 'image/bmp' },
  ico: { kind: 'image', mime: 'image/x-icon' },
  avif: { kind: 'image', mime: 'image/avif' },
  apng: { kind: 'image', mime: 'image/apng' },
  svg: { kind: 'image', mime: 'image/svg+xml' },
  mp4: { kind: 'video', mime: 'video/mp4' },
  webm: { kind: 'video', mime: 'video/webm' },
  mov: { kind: 'video', mime: 'video/quicktime' },
  mkv: { kind: 'video', mime: 'video/x-matroska' },
  m4v: { kind: 'video', mime: 'video/mp4' },
  avi: { kind: 'video', mime: 'video/x-msvideo' },
  ogv: { kind: 'video', mime: 'video/ogg' },
  mp3: { kind: 'audio', mime: 'audio/mpeg' },
  wav: { kind: 'audio', mime: 'audio/wav' },
  ogg: { kind: 'audio', mime: 'audio/ogg' },
  flac: { kind: 'audio', mime: 'audio/flac' },
  m4a: { kind: 'audio', mime: 'audio/mp4' },
  aac: { kind: 'audio', mime: 'audio/aac' },
  opus: { kind: 'audio', mime: 'audio/opus' }
}

export function mediaInfo(path: string): { kind: MediaKind; mime: string } | null {
  const ext = path.includes('.') ? path.split('.').pop()!.toLowerCase() : ''
  return MEDIA[ext] ?? null
}

export function languageFromPath(path: string): string {
  const name = path.split(/[\\/]/).pop() || ''
  if (name.toLowerCase() === 'dockerfile') return 'dockerfile'
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  return MAP[ext] || 'plaintext'
}

export function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

export function dirname(path: string): string {
  // Preserve the input's separator so the result still matches keys derived from
  // the same path (e.g. childrenMap keys / tab paths use OS separators on
  // Windows). Joining with '/' here silently broke tree refreshes after
  // delete/rename/move on Windows (C:\… vs C:/…).
  const sep = path.includes('\\') ? '\\' : '/'
  const parts = path.split(/[\\/]/)
  parts.pop()
  return parts.join(sep)
}

export function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') ? '\\' : '/'
  return dir.endsWith(sep) ? dir + name : dir + sep + name
}
