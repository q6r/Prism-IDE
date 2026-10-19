import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ArrowUp, ImagePlus, Paperclip, Square, X } from 'lucide-react'
import { useAgentChats, remoteTargetNow } from '../../lib/agentChats'
import { startRemoteControl } from '../../lib/remoteControl'
import { useStore } from '../../store'
import type { AgentSelection, ChatImage, QueuedMessage } from '../../../../shared/agents'
import { sameRemoteTarget } from '../../../../shared/agents'
import { collectChatImages, imageAttachmentsForHistory, imageReferenceNumber, resolveImageReferences } from '../../../../shared/imageReferences'
import { Button, cn, ToolbarChip, Tooltip } from '../ui'
import MessageQueue from '../composer/MessageQueue'
import ModelPicker from '../composer/ModelPicker'
import PermissionPicker from '../composer/PermissionPicker'
import { SubagentComposer } from './SubagentComposer'
import { useComposerMenus } from '../composer/useComposerMenus'
import { catalogKey, normalizeForModel, recordSelection, selectedModelFor, useModelCatalog } from '../../lib/modelCatalog'
import { imageReferenceInsertion, imageReferenceRemoval, rebaseInsertionPoint } from '../../lib/composerMenu'
import '../../styles/composer.css'

const EMPTY_IMAGES: ChatImage[] = []
const EMPTY_QUEUED: QueuedMessage[] = []
/** Keep attached images sane: at most ~8 MB each (base64) and a handful per message. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_IMAGES = 8

/** Read image Files to base64 ChatImages in the renderer (no IPC round-trip). */
async function readImages(files: Iterable<File>): Promise<ChatImage[]> {
  const out: ChatImage[] = []
  for (const file of files) {
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type) || file.size > MAX_IMAGE_BYTES) {
      useStore.getState().addToast('error', 'Use PNG, JPEG, GIF ou WebP com até 8 MB.'); continue
    }
    const data = await new Promise<string | null>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => {
        const result = typeof reader.result === 'string' ? reader.result : ''
        const comma = result.indexOf(',')
        resolve(comma >= 0 ? result.slice(comma + 1) : null)
      }
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(file)
    })
    if (data) out.push({ mime: file.type, data, name: file.name || undefined })
  }
  return out
}

/**
 * Traycer's chat composer (composer-shell.tsx + composer-toolbar.tsx): the
 * card with the editor on top and one toolbar row — attach and access on the
 * left; model picker and send/stop on the right.
 */
export default function AgentComposer({ inputRef, changes, details }: { inputRef: RefObject<HTMLTextAreaElement | null>; changes?: ReactNode; details?: ReactNode }) {
  // Only the fields the composer shows: streaming turns of the active chat
  // must not re-render the composer on every 40 ms flush.
  const chat = useAgentChats(useShallow((s) => {
    const c = s.chats.find((x) => x.id === s.activeId)
    return c ? { id: c.id, draft: c.draft || '', context: c.contextDraft || '', readOnly: !!c.readOnly, cwd: c.cwd,
      selection: c.selection, remoteId: c.remoteId, remoteTarget: c.remoteTarget, nativeAgent: c.nativeAgent } : null
  }))
  const busy = useAgentChats((s) => !!s.activeId && s.runtime[s.activeId]?.busy === true)
  const fastReport = useAgentChats((s) => s.activeId ? s.runtime[s.activeId]?.fast : undefined)
  const attachments = useAgentChats((s) => (s.activeId ? s.attachments[s.activeId] : undefined)) ?? EMPTY_IMAGES
  // Image references keep their object identity when streaming text changes,
  // so the composer does not subscribe to the assistant's prose updates.
  const knownImages = useAgentChats(useShallow((s) => {
    const c = s.chats.find(x => x.id === s.activeId)
    return c ? [
      ...c.turns.flatMap(t => [...(t.images || []), ...(t.segments || []).flatMap(segment => segment.images || [])]),
      ...(c.queued || []).flatMap(item => item.images || [])
    ] : EMPTY_IMAGES
  }))
  const imageCatalog = useMemo(() => collectChatImages({ turns: [{ id: 'image-catalog', role: 'user', text: '', images: knownImages }], queued: [] }, attachments), [knownImages, attachments])
  const queued = useAgentChats((s) => { const c = s.chats.find((x) => x.id === s.activeId); return c?.queued }) ?? EMPTY_QUEUED
  const stopping = useAgentChats(s => !!chat && !!s.stopping[chat.id])
  const steering = useAgentChats(s => chat ? s.steering[chat.id] : undefined)
  const [edit, setEdit] = useState<{ chatId: string; item: QueuedMessage; saved: { text: string; context: string; images: ChatImage[] } } | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const draft = chat?.draft ?? ''
  const context = chat?.context ?? ''
  const readOnly = !!chat?.readOnly
  const catalog = useModelCatalog((s) => chat ? s.entries[catalogKey(chat.remoteId ? 'claude' : chat.selection.provider, chat.remoteId ? 'ambient-claude' : chat.selection.profileId)] : undefined)
  // Commands, workspace files and numbered images over the editor.
  const menus = useComposerMenus({ inputRef, chat, draft, busy, images: imageCatalog })
  const latestMenus = useRef(menus)
  latestMenus.current = menus
  const imageLoads = useRef(new Set<{ chatId: string; text: string; at: number }>())
  const imageLoadTail = useRef<Promise<void>>(Promise.resolve())
  const automaticImageReferences = useRef(new Map<string, Set<number>>())
  const [imageLoadCounts, setImageLoadCounts] = useState<Record<string, number>>({})
  const loadingImages = !!chat && (imageLoadCounts[chat.id] || 0) > 0
  useEffect(() => useAgentChats.subscribe(state => {
    for (const load of imageLoads.current) {
      const next = state.chats.find(c => c.id === load.chatId)?.draft || ''
      if (next === load.text) continue
      load.at = rebaseInsertionPoint(load.text, next, load.at)
      load.text = next
    }
  }), [])

  // A user change: applied to the chat and committed to the picker memory
  // (Traycer's commitSelection), so new chats and switches back restore it.
  const configure = (patch: Partial<AgentSelection>): void => {
    if (!chat || readOnly) return
    const selection = { ...chat.selection, ...patch }
    useAgentChats.getState().configure(chat.id, selection)
    if (!chat.remoteId) recordSelection(selection)
  }
  // Keep the stored effort inside what the selected model honours. This is
  // normalization, not a user choice, so it is not remembered.
  useEffect(() => {
    if (!chat || readOnly || busy || !catalog?.models.length) return
    const patch = normalizeForModel(chat.selection, selectedModelFor(chat.selection, catalog.models))
    if (patch) useAgentChats.getState().configure(chat.id, { ...chat.selection, ...patch })
  }, [chat?.id, chat?.selection.model, chat?.selection.provider, chat?.selection.profileId, catalog?.models, busy, readOnly])
  // The editor grows with its content up to min(50vh, 15rem), then scrolls.
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [draft, chat?.id])

  const restoreDraft = (): void => {
    if (!edit) return
    const state = useAgentChats.getState()
    state.draft(edit.chatId, edit.saved.text); state.contextDraft(edit.chatId, edit.saved.context)
    state.clearAttachments(edit.chatId); if (edit.saved.images.length) state.attachImages(edit.chatId, edit.saved.images)
    state.setEditingQueued(edit.chatId)
    setEdit(null)
  }
  useEffect(() => {
    if (edit && (edit.chatId !== chat?.id || !queued.includes(edit.item))) restoreDraft()
  }, [chat?.id, queued, edit])

  const send = (now = false): void => {
    if (!chat || readOnly || stopping || steering) return
    if ([...imageLoads.current].some(load => load.chatId === chat.id)) {
      useStore.getState().addToast('info', 'Aguarde a imagem terminar de carregar antes de enviar.'); return
    }
    const state = useAgentChats.getState()
    const imgs = state.attachments[chat.id] || EMPTY_IMAGES
    const text = draft.trim()
    if (!text && !imgs.length) return
    const current = state.chats.find(c => c.id === chat.id)
    if (!current) return
    const references = resolveImageReferences(current, text, imgs)
    if (!references.ok) { useStore.getState().addToast('error', references.error); return }
    // References already in history only need their text in the queue. Keep
    // bytes for new attachments and references whose source is still queued.
    const captured = imageAttachmentsForHistory(current, imgs, references.images)
    if (edit?.chatId === chat.id) {
      state.replaceQueued(chat.id, edit.item, { ...edit.item, text, context: context || undefined, images: captured.length ? captured : undefined })
      restoreDraft(); return
    }
    // `/remote-control` shares this chat with a phone instead of reaching the agent.
    if (text === '/remote-control' && !imgs.length) {
      state.draft(chat.id, '')
      void startRemoteControl(chat.id)
      return
    }
    if (!chat.cwd) {
      useStore.getState().addToast('info', 'Abra uma pasta de projeto antes de enviar uma tarefa.')
      void useStore.getState().openFolderDialog()
      return
    }
    const clear = (): void => { state.draft(chat.id, ''); state.contextDraft(chat.id, ''); state.clearAttachments(chat.id) }
    // Busy: queue the message (and its images), sent when the current turn ends — Traycer's send queue.
    if (busy) {
      state.enqueue(chat.id, { text, context: context || undefined, images: captured.length ? captured : undefined }, now)
      clear()
      return
    }
    if (chat.remoteId && (chat.selection.provider !== 'claude' || chat.selection.profileId !== 'ambient-claude' || !sameRemoteTarget(chat.remoteTarget, remoteTargetNow()))) {
      useStore.getState().addToast('error', 'Reconecte o SSH e use Claude com a conta do terminal do servidor.'); return
    }
    // A refused send (an imported chat still binding its folder or account)
    // keeps the message and its attachments.
    if (state.send(chat.id, text, context, imgs.length ? imgs : undefined)) clear()
  }
  const addImages = (files: Iterable<File>): void => {
    if (!chat || readOnly) return
    const id = chat.id
    const state = useAgentChats.getState()
    const text = state.chats.find(c => c.id === id)?.draft || ''
    const el = inputRef.current
    // Capture where the upload happened before FileReader yields. Further
    // typing rebases this point; file read speed never changes upload order.
    const load = { chatId: id, text, at: el && state.activeId === id ? el.selectionStart : text.length }
    imageLoads.current.add(load)
    setImageLoadCounts(counts => ({ ...counts, [id]: (counts[id] || 0) + 1 }))
    const reading = readImages(Array.from(files)).catch(() => {
      useStore.getState().addToast('error', 'Não foi possível ler a imagem.'); return []
    })
    imageLoadTail.current = imageLoadTail.current.then(async () => {
      const imgs = await reading
      if (!imgs.length) return
      const current = useAgentChats.getState().chats.find(c => c.id === id)
      if (!current || current.readOnly) return
      const room = MAX_IMAGES - (useAgentChats.getState().attachments[id]?.length ?? 0)
      if (room <= 0) { useStore.getState().addToast('info', `Máximo de ${MAX_IMAGES} imagens por mensagem.`); return }
      const existing = useAgentChats.getState().attachments[id] || []
      let bytes = existing.reduce((n, image) => n + image.data.length, 0)
      const accepted = imgs.slice(0, room).filter(image => {
        if (bytes + image.data.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3)) {
          useStore.getState().addToast('error', 'Os anexos podem somar até 8 MB por mensagem.'); return false
        }
        bytes += image.data.length; return true
      })
      if (!accepted.length) return
      useAgentChats.getState().attachImages(id, accepted)
      const numbers = (useAgentChats.getState().attachments[id] || []).slice(-accepted.length)
        .map(image => image.number).filter((number): number is number => number !== undefined)
      const automatic = automaticImageReferences.current.get(id) || new Set<number>()
      for (const number of numbers) automatic.add(number)
      automaticImageReferences.current.set(id, automatic)
      const before = useAgentChats.getState().chats.find(c => c.id === id)?.draft || ''
      const at = Math.max(0, Math.min(load.at, before.length))
      const insertion = imageReferenceInsertion(before, at, numbers)
      imageLoads.current.delete(load)
      // Later uploads at the same position follow this one; user typing at
      // that position stays after the image it originally followed.
      for (const pending of imageLoads.current) {
        if (pending.chatId !== id) continue
        pending.at = rebaseInsertionPoint(pending.text, insertion.text, pending.at, 'right')
        pending.text = insertion.text
      }
      if (useAgentChats.getState().activeId !== id || !latestMenus.current.insertImageReferencesAt(numbers, at, id)) {
        useAgentChats.getState().draft(id, insertion.text)
      }
    }).catch(() => {
      useStore.getState().addToast('error', 'Não foi possível anexar a imagem.')
    }).finally(() => {
      imageLoads.current.delete(load)
      setImageLoadCounts(counts => ({ ...counts, [id]: Math.max(0, (counts[id] || 0) - 1) }))
    })
  }
  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>): void => {
    if (e.target.files?.length) addImages(Array.from(e.target.files))
    e.target.value = ''
  }
  const onPasteImages = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = Array.from(e.clipboardData?.items || [])
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile()).filter((f): f is File => !!f)
    if (files.length) { e.preventDefault(); addImages(files) }
  }
  const onDropImages = (e: React.DragEvent): void => {
    const files = Array.from(e.dataTransfer?.files || []).filter((f) => f.type.startsWith('image/'))
    if (files.length) { e.preventDefault(); addImages(files) }
  }
  const onDragOverImages = (e: React.DragEvent): void => {
    if (Array.from(e.dataTransfer?.items || []).some((it) => it.kind === 'file')) e.preventDefault()
  }
  const removeAttachedImage = (index: number, number: number | undefined): void => {
    if (!chat) return
    const state = useAgentChats.getState()
    state.removeImage(chat.id, index)
    if (number === undefined || !automaticImageReferences.current.get(chat.id)?.delete(number)) return
    const current = state.chats.find(c => c.id === chat.id)
    // An image already sent still resolves from history after its redundant
    // draft attachment is removed, so keep any reference to that old image.
    if (current && collectChatImages({ turns: current.turns, queued: [] }).some(image => image.number === number)) return
    if (!latestMenus.current.removeImageReference(number, chat.id)) {
      const text = useAgentChats.getState().chats.find(c => c.id === chat.id)?.draft || ''
      const removal = imageReferenceRemoval(text, number)
      if (removal) useAgentChats.getState().draft(chat.id, removal.text)
    }
  }
  const attachOpenFile = (): void => {
    const store = useStore.getState(); const tab = store.tabs.find((t) => t.path === store.activePath)
    if (tab && chat) useAgentChats.getState().contextDraft(chat.id, `${tab.path}\n\`\`\`${tab.language}\n${tab.content}\n\`\`\``)
    else store.addToast('info', 'Abra um arquivo no editor para anexá-lo.')
  }
  const focusEditor = (): void => { requestAnimationFrame(() => inputRef.current?.focus()) }
  const canSend = !!chat && !readOnly && !stopping && !steering && !loadingImages && (!!draft.trim() || attachments.length > 0)
  const contextName = context.split('\n')[0]?.split(/[\\/]/).at(-1) || 'Contexto'
  const editQueued = (item: QueuedMessage): void => {
    if (!chat || steering || stopping) return
    const state = useAgentChats.getState()
    const current = state.chats.find(c => c.id === chat.id)
    if (!current) return
    const references = collectChatImages(current, state.attachments[chat.id] || EMPTY_IMAGES)
    // Older queue items have no stored number. Resolve their current labels
    // before attachImages runs, so editing them does not mint new labels.
    const preserveNumbers = (images: readonly ChatImage[]): ChatImage[] => images.map(image => {
      const number = imageReferenceNumber(references, image)
      return number === undefined ? image : { ...image, number }
    })
    const saved = edit?.saved ?? { text: draft, context, images: preserveNumbers(attachments) }
    const images = preserveNumbers(item.images || EMPTY_IMAGES)
    state.setEditingQueued(chat.id, item)
    setEdit({ chatId: chat.id, item, saved })
    state.draft(chat.id, item.text); state.contextDraft(chat.id, item.context || '')
    state.clearAttachments(chat.id); if (images.length) state.attachImages(chat.id, images)
    focusEditor()
  }

  if (chat?.nativeAgent) return <SubagentComposer key={chat.id} chatId={chat.id} />

  return <div className="tcm-area">
    <div className="tcm-lower-dock" data-testid="chat-lower-dock">
      <MessageQueue chatId={chat?.id} editing={edit?.item} onEdit={editQueued} />
      {changes}
    </div>
    <div className="tcm-shell" data-composer-shell="" onDrop={onDropImages} onDragOver={onDragOverImages}>
      <div className="tcm-editor-frame">
        {edit ? <div className="tcm-editing"><span>Editando mensagem na fila</span><Button variant="muted" size="xs" onClick={restoreDraft}>Cancelar</Button></div> : null}
        {context ? <div className="tcm-attachments">
          <span className="tcm-attachment" title={context.split('\n')[0]}><Paperclip size={12} /><span className="tr-truncate">{contextName}</span>
            <button type="button" aria-label="Remover contexto" onClick={() => chat && useAgentChats.getState().contextDraft(chat.id, '')}><X size={12} /></button></span>
        </div> : null}
        {loadingImages ? <div className="tcm-attachments"><span className="tcm-attachment" role="status"><ImagePlus size={12} />Lendo imagem…</span></div> : null}
        {attachments.length ? <div className="tcm-thumbs">
          {attachments.map((img, i) => {
            const number = imageReferenceNumber(imageCatalog, img)
            const label = number ? `#image ${number}` : 'Imagem'
            return <span key={i} className="tcm-thumb" title={`${label}${img.name ? ` · ${img.name}` : ''}`}>
              <button type="button" className="tcm-thumb-reference" aria-label={`Inserir referência ${label}`} disabled={!number}
                onMouseDown={e => e.preventDefault()} onClick={() => number && menus.insertImageReference(number)}>
                <img src={`data:${img.mime};base64,${img.data}`} alt={img.name || label} />
                <span className="tcm-thumb-badge">{label}</span>
              </button>
              <button type="button" className="tcm-thumb-remove" aria-label={`Remover ${label}`} onClick={() => removeAttachedImage(i, number)}><X size={10} /></button>
            </span>
          })}
        </div> : null}
        {/* Typing stays open during a turn, as in Traycer; only sending waits. */}
        <textarea ref={inputRef} className="tcm-editor" aria-label="Mensagem para o agente" rows={1}
          placeholder={readOnly ? 'Histórico em leitura — continue no Traycer.' : busy ? 'Enviar outra mensagem… · Ctrl+Enter para enviar neste turno' : 'Peça para o agente fazer algo…'}
          value={draft} disabled={!chat || readOnly} onPaste={onPasteImages} {...menus.inputProps}
          onChange={(e) => { if (chat) useAgentChats.getState().draft(chat.id, e.target.value); menus.onInput(e.target) }}
          onKeyDown={(e) => {
            // An open menu owns arrows, Enter, Tab and Esc first.
            if (menus.onKeyDown(e)) return
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(e.ctrlKey || e.metaKey) }
          }} />
        {menus.menu}
      </div>
      <div className="tcm-toolbar">
        <div className="tcm-toolbar-left">
          <Tooltip label="Anexar arquivo aberto">
            <ToolbarChip square aria-label="Anexar arquivo aberto" disabled={!chat || readOnly}
              onMouseDown={(e) => e.preventDefault()} onClick={attachOpenFile}><Paperclip size={16} /></ToolbarChip>
          </Tooltip>
          <Tooltip label="Anexar imagem">
            <ToolbarChip square aria-label="Anexar imagem" disabled={!chat || readOnly}
              onMouseDown={(e) => e.preventDefault()} onClick={() => fileInput.current?.click()}><ImagePlus size={16} /></ToolbarChip>
          </Tooltip>
          <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={onPickFiles} />
          {chat ? <PermissionPicker value={chat.selection.permissionMode} provider={chat.selection.provider} disabled={readOnly}
            onChange={(permissionMode) => configure({ permissionMode })} onCloseFocus={focusEditor} /> : null}
        </div>
        <div className="tcm-toolbar-right">
          {chat ? <ModelPicker chat={chat} disabled={readOnly} fastReport={chat.selection.provider === 'claude' ? fastReport : undefined}
            onConfigure={configure} onAfterClose={focusEditor} /> : null}
          {busy && !readOnly ? <Tooltip label="Parar o turno do assistente">
            <Button size="icon" className="tcm-send stop" aria-label={stopping ? "Interrompendo" : "Parar"} disabled={stopping} onClick={() => chat && useAgentChats.getState().stop(chat.id)}><Square size={14} fill="currentColor" /></Button>
          </Tooltip> : null}
          <Tooltip label={edit ? 'Salvar mensagem na fila' : busy ? 'Adicionar à fila · Ctrl+Enter para enviar agora' : 'Enviar'}>
            <Button size="icon" className={cn('tcm-send', !canSend && 'idle')} aria-label={busy ? 'Adicionar à fila' : 'Enviar'} aria-keyshortcuts="Enter Control+Enter Meta+Enter" disabled={!canSend} onClick={() => send()}><ArrowUp size={16} /></Button>
          </Tooltip>
        </div>
      </div>
    </div>
    {details}
  </div>
}
