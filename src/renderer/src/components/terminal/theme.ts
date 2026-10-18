import type { ITheme } from '@xterm/xterm'

/** Resolve modern CSS colors to concrete RGB; xterm's canvas cannot read var(). */
export function readTerminalAppearance(host: HTMLElement): { theme: ITheme; fontFamily: string } {
  const probe = document.createElement('span')
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none'
  host.appendChild(probe)
  const context = document.createElement('canvas').getContext('2d')
  const resolve = (token: string): string => {
    probe.style.color = `var(${token})`
    const computed = getComputedStyle(probe).color
    if (!context) return computed
    context.clearRect(0, 0, 1, 1)
    context.fillStyle = computed
    context.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data
    return `rgba(${r}, ${g}, ${b}, ${a / 255})`
  }
  const theme: ITheme = {
    background: resolve('--tr-canvas'), foreground: resolve('--tr-foreground'),
    cursor: resolve('--tr-foreground'), cursorAccent: resolve('--tr-canvas'),
    selectionBackground: resolve('--tr-terminal-selection'),
    scrollbarSliderBackground: resolve('--tr-terminal-scrollbar'),
    scrollbarSliderHoverBackground: resolve('--tr-terminal-scrollbar-hover'),
    scrollbarSliderActiveBackground: resolve('--tr-terminal-scrollbar-active'),
    overviewRulerBorder: 'transparent'
  }
  const names = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const
  for (const name of names) {
    theme[name] = resolve(`--tr-terminal-${name}`)
    const bright = `bright${name[0].toUpperCase()}${name.slice(1)}` as
      'brightBlack' | 'brightRed' | 'brightGreen' | 'brightYellow' | 'brightBlue' | 'brightMagenta' | 'brightCyan' | 'brightWhite'
    theme[bright] = resolve(`--tr-terminal-bright-${name}`)
  }
  const fontFamily = getComputedStyle(host).getPropertyValue('--tr-font-mono').trim()
  probe.remove()
  return { theme, fontFamily }
}
