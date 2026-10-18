// Lightweight, language-agnostic code navigation for Monaco — no language
// server. A regex symbol parser powers "Go to Symbol" (Ctrl+Shift+O), the
// outline and breadcrumbs; a workspace definition lookup (in the main process)
// powers cross-file Go to Definition (F12 / Ctrl+Click). It won't match a full
// TS server, but it gives the VSCode "jump to a function/file" feel everywhere.
import type * as Monaco from 'monaco-editor'

export interface ParsedSymbol {
  name: string
  detail: string
  kind: number // monaco.languages.SymbolKind
  line: number // 1-based
  col: number // 1-based
}

const reEsc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// One regex per symbol "kind" per language family. Each entry: a RegExp with the
// symbol name in capture group 1, and the monaco SymbolKind to assign.
interface Rule {
  re: RegExp
  kind: keyof typeof KIND
  detail?: string
}

// Resolved against monaco.languages.SymbolKind at registration time.
const KIND = {
  fn: 'Function',
  method: 'Method',
  class: 'Class',
  interface: 'Interface',
  struct: 'Struct',
  enum: 'Enum',
  type: 'TypeParameter',
  const: 'Constant',
  var: 'Variable',
  prop: 'Property'
} as const

function rulesFor(lang: string): Rule[] {
  const id = '([A-Za-z_$][A-Za-z0-9_$]*)'
  const js: Rule[] = [
    { re: new RegExp(`(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${id}`), kind: 'fn' },
    { re: new RegExp(`(?:export\\s+)?(?:abstract\\s+)?class\\s+${id}`), kind: 'class' },
    { re: new RegExp(`(?:export\\s+)?interface\\s+${id}`), kind: 'interface' },
    { re: new RegExp(`(?:export\\s+)?enum\\s+${id}`), kind: 'enum' },
    { re: new RegExp(`(?:export\\s+)?type\\s+${id}\\s*[=<]`), kind: 'type' },
    {
      re: new RegExp(`(?:export\\s+)?const\\s+${id}\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*=>`),
      kind: 'fn'
    },
    { re: new RegExp(`(?:export\\s+)?(?:const|let|var)\\s+${id}\\s*=`), kind: 'const' },
    // class methods / object methods: `name(args) {`  (avoid keywords)
    { re: new RegExp(`^\\s*(?:public|private|protected|static|async|get|set|readonly|\\s)*${id}\\s*\\([^)]*\\)\\s*[:{]`), kind: 'method' }
  ]
  const py: Rule[] = [
    { re: new RegExp(`^\\s*def\\s+${id}`), kind: 'fn' },
    { re: new RegExp(`^\\s*class\\s+${id}`), kind: 'class' }
  ]
  const go: Rule[] = [
    { re: new RegExp(`^\\s*func\\s+(?:\\([^)]*\\)\\s*)?${id}`), kind: 'fn' },
    { re: new RegExp(`^\\s*type\\s+${id}\\s+struct`), kind: 'struct' },
    { re: new RegExp(`^\\s*type\\s+${id}\\s+interface`), kind: 'interface' },
    { re: new RegExp(`^\\s*type\\s+${id}`), kind: 'type' }
  ]
  const rust: Rule[] = [
    { re: new RegExp(`^\\s*(?:pub\\s+)?(?:async\\s+)?fn\\s+${id}`), kind: 'fn' },
    { re: new RegExp(`^\\s*(?:pub\\s+)?struct\\s+${id}`), kind: 'struct' },
    { re: new RegExp(`^\\s*(?:pub\\s+)?enum\\s+${id}`), kind: 'enum' },
    { re: new RegExp(`^\\s*(?:pub\\s+)?trait\\s+${id}`), kind: 'interface' }
  ]
  const cish: Rule[] = [
    { re: new RegExp(`^\\s*(?:public|private|protected|internal|static|final|abstract|virtual|override|async|\\s)*(?:class|struct|enum|interface)\\s+${id}`), kind: 'class' },
    { re: new RegExp(`^\\s*(?:public|private|protected|internal|static|final|abstract|virtual|override|async|[\\w<>\\[\\],.?&*\\s]+?)\\s+${id}\\s*\\([^;]*\\)\\s*[{:]`), kind: 'method' }
  ]
  const ruby: Rule[] = [
    { re: new RegExp(`^\\s*def\\s+(?:self\\.)?${id}`), kind: 'fn' },
    { re: new RegExp(`^\\s*(?:class|module)\\s+${id}`), kind: 'class' }
  ]
  const php: Rule[] = [
    { re: new RegExp(`(?:public|private|protected|static|abstract|final|\\s)*function\\s+${id}`), kind: 'fn' },
    { re: new RegExp(`(?:abstract\\s+|final\\s+)?(?:class|interface|trait)\\s+${id}`), kind: 'class' }
  ]
  switch (lang) {
    case 'typescript':
    case 'javascript':
    case 'typescriptreact':
    case 'javascriptreact':
      return js
    case 'python':
      return py
    case 'go':
      return go
    case 'rust':
      return rust
    case 'java':
    case 'csharp':
    case 'cpp':
    case 'c':
      return cish
    case 'ruby':
      return ruby
    case 'php':
      return php
    default:
      // A reasonable generic fallback for anything else.
      return [
        { re: new RegExp(`\\b(?:function|func|fn|def|sub|method)\\s+${id}`), kind: 'fn' },
        { re: new RegExp(`\\b(?:class|struct|interface|trait|type|enum|module)\\s+${id}`), kind: 'class' }
      ]
  }
}

// Keywords that look like identifiers but never name a symbol.
const KW = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'class', 'const',
  'let', 'var', 'else', 'do', 'new', 'await', 'async', 'typeof', 'in', 'of', 'case',
  'default', 'break', 'continue', 'throw', 'try', 'finally', 'with', 'yield'
])

export function parseSymbols(code: string, lang: string, monaco: typeof Monaco): Monaco.languages.DocumentSymbol[] {
  const rules = rulesFor(lang)
  const SymbolKind = monaco.languages.SymbolKind as unknown as Record<string, number>
  const lines = code.split(/\r?\n/)
  const out: Monaco.languages.DocumentSymbol[] = []
  const seen = new Set<string>()
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]
    if (!text.trim() || text.length > 400) continue
    for (const rule of rules) {
      const m = rule.re.exec(text)
      if (m && m[1] && !KW.has(m[1])) {
        const key = i + ':' + m[1]
        if (seen.has(key)) continue
        seen.add(key)
        const col = Math.max(1, text.indexOf(m[1], m.index) + 1)
        const range = new monaco.Range(i + 1, 1, i + 1, text.length + 1)
        const sel = new monaco.Range(i + 1, col, i + 1, col + m[1].length)
        out.push({
          name: m[1],
          detail: '',
          kind: SymbolKind[KIND[rule.kind]] ?? SymbolKind.Variable,
          tags: [],
          range,
          selectionRange: sel
        })
        break // one symbol per line
      }
    }
  }
  return out
}

let registered = false
export function registerCodeNav(monaco: typeof Monaco): void {
  if (registered) return
  registered = true
  const langs = monaco.languages.getLanguages().map((l) => l.id)
  const provider: Monaco.languages.DocumentSymbolProvider = {
    provideDocumentSymbols: (model) => {
      try {
        return parseSymbols(model.getValue(), model.getLanguageId(), monaco)
      } catch {
        return []
      }
    }
  }
  for (const id of langs) {
    try {
      monaco.languages.registerDocumentSymbolProvider(id, provider)
    } catch {
      /* some virtual languages reject providers */
    }
  }
}

// Build the alternation regex that recognises a *definition* of `word` (used by
// the main-process workspace lookup, mirrored here for the renderer's same-file
// fast path).
export function definitionPatterns(word: string): string[] {
  const w = reEsc(word)
  return [
    `\\b(?:async\\s+)?function\\s*\\*?\\s*${w}\\b`,
    `\\b(?:const|let|var)\\s+${w}\\b`,
    `\\bclass\\s+${w}\\b`,
    `\\b(?:interface|type|enum|trait|struct)\\s+${w}\\b`,
    `\\bdef\\s+${w}\\b`,
    `\\bfunc\\s+(?:\\([^)]*\\)\\s*)?${w}\\b`,
    `\\bfn\\s+${w}\\b`,
    `\\b${w}\\s*[:=]\\s*(?:async\\s*)?(?:function|\\([^)]*\\)\\s*=>|\\([^)]*\\)\\s*\\{)`,
    `^\\s*(?:public|private|protected|static|async|get|set|\\s)*${w}\\s*\\([^)]*\\)\\s*[:{]`
  ]
}
