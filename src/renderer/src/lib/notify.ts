// Background notifications for finished agent tasks: a native OS balloon (the
// main process only shows it when the window is unfocused), the taskbar icon
// flashing, and an unread-count badge painted onto the taskbar overlay. The
// count resets the moment the window regains focus.

let unread = 0

// Draw a small red circle with the count for the Windows taskbar overlay icon.
function badgeDataUrl(count: number): string {
  const label = count > 9 ? '9+' : String(count)
  const size = 32
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  ctx.beginPath()
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2)
  ctx.fillStyle = '#e5484d'
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.font = `bold ${label.length > 1 ? 17 : 21}px "Segoe UI", system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, size / 2, size / 2 + 1)
  return canvas.toDataURL('image/png')
}

function pushBadge(): void {
  window.prism.app.setBadge(unread, unread > 0 ? badgeDataUrl(unread) : null)
}

// A short, gentle two-note chime so a finished task is noticeable even when the
// OS balloon is suppressed (e.g. the user is on another chat tab, window focused).
function playChime(): void {
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new Ctx()
    const now = ctx.currentTime
    ;[880, 1318.5].forEach((freq, i) => {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = 'sine'
      o.frequency.value = freq
      o.connect(g)
      g.connect(ctx.destination)
      const t = now + i * 0.12
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22)
      o.start(t)
      o.stop(t + 0.24)
    })
    setTimeout(() => ctx.close(), 600)
  } catch {
    /* audio unavailable */
  }
}

// Fire a "task finished" notification: native balloon (shown by main only when
// unfocused), a chime, the taskbar flash, and an unread badge.
export function notifyTaskDone(title: string, body: string): void {
  window.prism.app.notify(title, body)
  playChime()
  if (!document.hasFocus()) {
    unread += 1
    pushBadge()
  }
}

function clearUnread(): void {
  if (unread === 0) return
  unread = 0
  pushBadge()
}

// The badge represents work the user hasn't seen yet — clear it the moment they
// come back to the window. (Main also clears the overlay/flash on focus.)
window.addEventListener('focus', clearUnread)
