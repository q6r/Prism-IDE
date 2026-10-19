import { memo } from 'react'
import { MarkdownContent } from './MarkdownContent'
import { Check, Copy } from 'lucide-react'
import { cn } from '../ui'
import { useCopy } from './primitives'
import { useHighlighted } from './highlight'
import { useShallow } from 'zustand/react/shallow'
import { useAgentChats } from '../../lib/agentChats'
import { useStore } from '../../store'
import { sameRemoteTarget } from '../../../../shared/agents'
import { ChatImage } from './ChatImage'

const openChatLink = (href: string): void => { void window.prism.app.openExternal(href) }

function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const chat = useAgentChats(useShallow(state => {
    const chat = state.chats.find(chat => chat.id === state.activeId)
    return { cwd: chat?.cwd, remoteId: chat?.remoteId, remoteTarget: chat?.remoteTarget }
  }))
  const remote = useStore(state => state.remote)
  return <ChatImage src={src} alt={alt} route={{ cwd: chat.cwd, remoteId: chat.remoteId,
    remoteReady: !!chat.remoteId && remote?.id === chat.remoteId && sameRemoteTarget(chat.remoteTarget, remote ?? undefined) }} />
}

/** Fenced block: language strip, hover copy, Monaco-coloured body (code-block.tsx). */
function FencedCode({ code, language, streaming }: { code: string; language: string; streaming: boolean }) {
  const [copied, copy] = useCopy(2000)
  const html = useHighlighted(code, language, !streaming)
  return <div className="ch-code" data-language={language}>
    <div className="ch-code-head">
      <span className="ch-code-lang">{language || 'text'}</span>
      <button type="button" className="ch-code-copy" aria-label={copied ? 'Copiado' : 'Copiar código'} onClick={() => copy(code)}>
        {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
      </button>
    </div>
    <div className="ch-code-body">
      {html !== null
        ? <pre><code dangerouslySetInnerHTML={{ __html: html }} /></pre>
        : <pre><code>{code}</code></pre>}
    </div>
  </div>
}

/**
 * Traycer's chat markdown (`prose md-prose`): `normal` is the reply body
 * (prose-base, 16/28), `compact` the reasoning trace (prose-sm, 14/24).
 */
export const Markdown = memo(function Markdown({ text, size = 'normal', muted, streaming = false, className }: {
  text: string
  size?: 'normal' | 'compact'
  muted?: boolean
  streaming?: boolean
  className?: string
}) {
  return <div className={cn('ch-md', size === 'compact' ? 'ch-md-sm' : 'ch-md-base', muted && 'ch-md-muted', className)}>
    <MarkdownContent text={text} streaming={streaming} CodeBlock={FencedCode} openLink={openChatLink} Image={MarkdownImage} />
  </div>
})
