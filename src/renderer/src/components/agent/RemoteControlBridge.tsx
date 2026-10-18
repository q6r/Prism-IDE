import { useEffect, useRef, useState } from 'react'
import { useStore } from '../../store'
import { useAgentChats } from '../../lib/agentChats'
import { forgetRemoteSnapshot, handleRemoteCommand, pushRemoteSnapshot, remoteOnHost, stopRemoteControl } from '../../lib/remoteControl'

const THROTTLE_MS = 160
// Only one bridge may answer the phone, or a command would run twice.
let owner: symbol | null = null

/** The route of `remote`, read again on every host status change (it moves to the host on `hello`). */
function useRemoteOnHost(): boolean {
  const [onHost, setOnHost] = useState(remoteOnHost)
  useEffect(() => window.prism.host.onStatus(() => setOnHost(remoteOnHost())), [])
  return onHost
}

/**
 * Headless link between the shared agent chats and the phone (/remote-control):
 * pushes each shared chat's snapshot on change (throttled, not debounced, so the
 * phone keeps updating during continuous streaming; identical snapshots are
 * skipped and main forwards only changed turns), answers phone commands with an
 * ack, stops sharing a chat that was deleted or archived, and forgets every
 * shared chat when main takes the tunnel down. Safe to mount more than once;
 * only the first mounted instance is active. Off while the host serves
 * `remote@1` (T09): the host does all of this itself.
 */
export default function RemoteControlBridge(): null {
  const shared = useStore((s) => s.rcEnabledTabs)
  const sharedKey = shared.join('\n')
  const me = useRef(Symbol('rc-bridge'))
  const onHost = useRemoteOnHost()

  useEffect(() => {
    if (onHost || (owner && owner !== me.current)) return
    owner = me.current
    const off = window.prism.remoteControl.onCommand((c) => {
      if (!useStore.getState().rcEnabledTabs.includes(c.tabId)) return
      const res = handleRemoteCommand(c.tabId, c.action, c.payload)
      window.prism.remoteControl.ack({ tabId: c.tabId, action: c.action, ok: res.ok, reason: res.reason })
    })
    // Main took the tunnel down (last chat unshared, tunnel died, error): every
    // link is dead, so the desktop must stop showing chats as shared.
    const offStopped = window.prism.remoteControl.onStopped(({ reason }) => {
      forgetRemoteSnapshot()
      useStore.getState().remoteControlStopped(reason)
    })
    return () => { off(); offStopped(); if (owner === me.current) owner = null }
  }, [onHost])

  useEffect(() => {
    const ids = sharedKey ? sharedKey.split('\n') : []
    if (onHost || !ids.length || owner !== me.current) return
    const seen = new Map<string, unknown[]>()
    const lastAt = new Map<string, number>()
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    const push = (id: string): void => { timers.delete(id); lastAt.set(id, Date.now()); pushRemoteSnapshot(id) }
    const schedule = (id: string): void => {
      if (timers.has(id)) return
      const wait = Math.max(0, THROTTLE_MS - (Date.now() - (lastAt.get(id) ?? 0)))
      if (wait === 0) push(id)
      else timers.set(id, setTimeout(() => push(id), wait))
    }
    const dropped = new Set<string>()
    const check = (state: ReturnType<typeof useAgentChats.getState>): void => {
      for (const id of ids) {
        if (dropped.has(id)) continue
        const chat = state.chats.find((c) => c.id === id)
        if (!chat || chat.archived) {
          // A deleted or archived chat stops sharing: its link is revoked, and
          // the last one takes the tunnel down.
          if (state.ready || chat) { dropped.add(id); stopRemoteControl(id) }
          continue
        }
        const deps = [chat, state.runtime[id]]
        const prev = seen.get(id)
        if (prev && prev[0] === deps[0] && prev[1] === deps[1]) continue
        seen.set(id, deps)
        schedule(id)
      }
    }
    check(useAgentChats.getState())
    const unsubscribe = useAgentChats.subscribe(check)
    return () => { unsubscribe(); for (const t of timers.values()) clearTimeout(t) }
  }, [sharedKey, onHost])

  return null
}
