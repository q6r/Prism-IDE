// Language icons for the Discord presence — pulled straight from the vscord
// repo (https://github.com/leonardssh/vscord) via the jsDelivr CDN. Discord
// renders these when passed as the large/small image *key* (the `large_image`
// field accepts image URLs; the `large_url` field is NOT rendered).
const CDN = 'https://cdn.jsdelivr.net/gh/leonardssh/vscord@main/assets/icons'
const icon = (name: string): string => `${CDN}/${name}.png`

// Monaco language id -> [vscord icon name, display text].
const MAP: Record<string, [string, string]> = {
  typescript: ['ts', 'TypeScript'],
  javascript: ['js', 'JavaScript'],
  json: ['json', 'JSON'],
  html: ['html', 'HTML'],
  css: ['css', 'CSS'],
  scss: ['scss', 'SCSS'],
  less: ['less', 'Less'],
  markdown: ['markdown', 'Markdown'],
  python: ['python', 'Python'],
  ruby: ['ruby', 'Ruby'],
  go: ['go', 'Go'],
  rust: ['rust', 'Rust'],
  java: ['java', 'Java'],
  kotlin: ['kotlin', 'Kotlin'],
  c: ['c', 'C'],
  cpp: ['cpp', 'C++'],
  csharp: ['csharp', 'C#'],
  php: ['php', 'PHP'],
  shell: ['shell', 'Shell'],
  powershell: ['powershell', 'PowerShell'],
  yaml: ['yaml', 'YAML'],
  xml: ['xml', 'XML'],
  sql: ['sql', 'SQL'],
  ini: ['toml', 'INI'],
  dockerfile: ['docker', 'Docker'],
  // Forward-compatible extras (all present in the vscord set):
  vue: ['vue', 'Vue'],
  svelte: ['svelte', 'Svelte'],
  astro: ['astro', 'Astro'],
  swift: ['swift', 'Swift'],
  dart: ['dart', 'Dart'],
  lua: ['lua', 'Lua'],
  luau: ['luau', 'Luau'],
  scala: ['scala', 'Scala'],
  perl: ['perl', 'Perl'],
  r: ['r', 'R'],
  julia: ['julia', 'Julia'],
  elixir: ['elixir', 'Elixir'],
  erlang: ['erlang', 'Erlang'],
  haskell: ['haskell', 'Haskell'],
  clojure: ['clojure', 'Clojure'],
  ocaml: ['ocaml', 'OCaml'],
  fsharp: ['fsharp', 'F#'],
  groovy: ['groovy', 'Groovy'],
  graphql: ['graphql', 'GraphQL'],
  solidity: ['solidity', 'Solidity'],
  zig: ['zig', 'Zig'],
  nim: ['nim', 'Nim'],
  prisma: ['prisma', 'Prisma'],
  plaintext: ['text', 'Texto']
}

export interface LangIcon {
  url: string
  text: string
}

export function languageIcon(language: string | null): LangIcon {
  const entry = MAP[language ?? 'plaintext']
  if (entry) return { url: icon(entry[0]), text: entry[1] }
  return { url: icon('text'), text: language || 'Arquivo' }
}

// Large image of the presence — the Prism app logo, hosted publicly. Passed via
// the `large_image` field (as a URL) so Discord renders it.
export const PRISM_LARGE_ICON =
  'https://cdn.cee.bio/uploads/app_logo-7f2947c6b8fb0a63f0fa31dbdae4a939.png'
