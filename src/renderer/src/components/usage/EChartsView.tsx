import { useEffect, useRef, useState } from 'react'
import type { EChartsCoreOption, EChartsType } from 'echarts/core'
import { Spinner } from '../ui'

/**
 * Imperative ECharts lifecycle behind a div (Traycer's echarts-container):
 * the runtime is imported on first mount, `setOption` replaces the option on
 * every change, the chart follows its container's size, and it is disposed
 * on unmount.
 */
export function EChartsView({ option, className, ariaLabel }: { option: EChartsCoreOption | null; className: string; ariaLabel: string }) {
  const container = useRef<HTMLDivElement>(null)
  const chart = useRef<EChartsType | null>(null)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let disposed = false
    let observer: ResizeObserver | undefined
    import('./echartsRuntime').then(({ echarts }) => {
      const node = container.current
      if (disposed || !node) return
      const instance = echarts.init(node, null, { renderer: 'svg' })
      chart.current = instance
      // The node can mount at 0×0 before layout settles; the observer's first
      // callback delivers the real size.
      observer = new ResizeObserver(() => instance.resize())
      observer.observe(node)
      setReady(true)
    }).catch(() => { if (!disposed) setFailed(true) })
    return () => {
      disposed = true
      observer?.disconnect()
      chart.current?.dispose()
      chart.current = null
    }
  }, [])

  // `notMerge`: a window or metric switch replaces the option outright, so no
  // series or formatter from the previous shape lingers.
  useEffect(() => { if (ready && option) chart.current?.setOption(option, { notMerge: true }) }, [ready, option])

  return <div className="usg-echarts-frame">
    <div ref={container} role="img" aria-label={ariaLabel} className={className} />
    {!ready && !failed ? <div className="usg-echarts-pending"><Spinner tone="muted" /></div> : null}
    {failed ? <div className="usg-echarts-pending">Não foi possível carregar o gráfico.</div> : null}
  </div>
}
