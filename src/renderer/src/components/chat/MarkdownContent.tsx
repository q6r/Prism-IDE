import { useMemo, type ComponentProps, type ComponentType, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { isChatImagePath, resolveChatImageSource } from '../../../../shared/chatImageSource'

const REMARK = [remarkGfm]
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && 'props' in node) return textOf((node.props as { children?: ReactNode }).children)
  return ''
}
export interface CodeBlockProps { code: string; language: string; streaming: boolean }
/** Shared safe GFM renderer for the desktop and the phone. Platform handles links and code colour. */
export function MarkdownContent({ text, streaming = false, CodeBlock, openLink, Image }: {
  text: string; streaming?: boolean; CodeBlock: ComponentType<CodeBlockProps>; openLink: (href: string) => void; Image?: ComponentType<{ src?: string; alt?: string }>
}) {
  const components = useMemo<Components>(() => ({
    pre: ({ children }) => <>{children}</>,
    code: ({ className, children }: ComponentProps<'code'>) => {
      const language = /language-(\S+)/.exec(className || '')?.[1] ?? ''
      const code = textOf(children).replace(/\n$/, '')
      if (!className && !code.includes('\n')) return <code>{children}</code>
      return <CodeBlock code={code} language={language} streaming={streaming} />
    },
    // react-markdown treats an own key with `undefined` as a component override.
    // Omit it when the desktop uses the default HTML image renderer.
    ...(Image ? { img: ({ src, alt }: ComponentProps<'img'>) => <Image src={src} alt={alt} /> } : {}),
    a: ({ href, children }) => Image && href && isChatImagePath(href) && !/^https?:/i.test(href)
      ? <Image src={href} alt={textOf(children)} /> : <a href={href} title={href} onClick={e => { e.preventDefault(); if (href && /^(https?:|mailto:)/i.test(href)) openLink(href) }}>{children}</a>,
    table: ({ children }) => <div className="ch-md-table-wrap"><table>{children}</table></div>,
    input: ({ type, checked }) => type === 'checkbox' ? <input type="checkbox" checked={!!checked} readOnly disabled /> : null
  }), [CodeBlock, Image, openLink, streaming])
  return <ReactMarkdown urlTransform={(url, key, node) => {
    if (Image && (key === 'src' || (node.tagName === 'a' && isChatImagePath(url)))) {
      const source = resolveChatImageSource(url, '/')
      if (source.kind !== 'error') return url
    }
    return defaultUrlTransform(url)
  }} remarkPlugins={REMARK} components={components}>{text}</ReactMarkdown>
}
