import { useEffect, useMemo, useState } from 'react'
import { Gauge } from 'lucide-react'
import { AccentDot, Badge, MeterRow, Spinner } from '../ui'
import { RefreshIconButton } from '../settings/layout'
import { profileAccentColor } from '../../lib/profileAccent'
import { projectUsage, relativeTime, resetLabel, useProviderUsage } from '../../lib/providerUsage'
import { providerLabel } from '../../lib/usageAnalytics/format'
import type { ProviderProfile } from '../../../../shared/agents'
import { UsageCard } from './parts'

/**
 * "Limites das contas": the current rate-limit windows of every enabled
 * profile, read from the shared usage cache (lib/providerUsage).
 */
export function UsageAccountLimits({ delay }: { delay: number }) {
  const [profiles, setProfiles] = useState<ProviderProfile[] | null>(null)
  const entries = useProviderUsage((s) => s.entries)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    window.prism.providers.list().then(setProfiles).catch(() => setProfiles([]))
    // The host announces every change to the accounts (T08).
    return window.prism.providers.onChanged?.(setProfiles)
  }, [])
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer) }, [])
  const live = useMemo(() => (profiles ?? []).filter((p) => !p.tombstoned && p.enabled !== false), [profiles])
  useEffect(() => {
    const ensure = (): void => { if (!document.hidden) for (const p of live) useProviderUsage.getState().ensure(p) }
    ensure()
    const timer = setInterval(ensure, 60_000)
    window.addEventListener('focus', ensure)
    return () => { clearInterval(timer); window.removeEventListener('focus', ensure) }
  }, [live])
  const refresh = async (): Promise<void> => { await Promise.all(live.map((p) => useProviderUsage.getState().refresh(p))) }
  return <UsageCard title="Limites das contas" icon={Gauge} delay={delay} data-settings-anchor="usage-limits" subtitle="Janelas de uso atuais de cada conta conectada."
    actions={live.length ? <RefreshIconButton label="Atualizar limites" onRefresh={refresh} refreshing={live.some((p) => entries[p.id]?.fetching)} /> : null}>
    {profiles === null ? <div className="usg-loading"><Spinner tone="muted" />Carregando contas…</div>
      : !live.length ? <p className="usg-empty">Nenhuma conta ativa. Conecte contas em Provedores.</p>
      : <div className="usg-limits">
        {live.map((p) => {
          const entry = entries[p.id]
          const projection = projectUsage(entry, now)
          return <div key={p.id} className="usg-limit">
            <div className="usg-limit-head">
              <AccentDot variant="inline" color={profileAccentColor(p.id, p.color)} />
              <span className="usg-limit-name" title={p.name}>{p.name}</span>
              <Badge variant="muted" size="xs">{providerLabel(p.provider)}</Badge>
            </div>
            {projection.kind === 'detail' || projection.kind === 'stale'
              ? projection.windows.map((w) => {
                const reset = resetLabel(w.resetsAt, now)
                return <MeterRow key={w.id} label={w.label} usedPercent={w.usedPercent} severity={w.severity}
                  detail={`${Math.round(Math.min(100, Math.max(0, w.usedPercent)))}% usado${reset ? ` · ${reset}` : ''}`} />
              })
              : projection.kind === 'unavailable'
                ? <span className="usg-limit-msg">{projection.message || 'O provedor não informou janelas de uso para esta conta.'}</span>
                : <span className="usg-limit-msg">{entry?.fetching ? 'Consultando…' : 'Ainda não consultado.'}</span>}
            {projection.checkedAt ? <span className="usg-limit-foot">
              Atualizado {relativeTime(projection.checkedAt, now)}{projection.kind === 'stale' ? ' · pode estar desatualizado' : ''}
            </span> : null}
          </div>
        })}
      </div>}
  </UsageCard>
}
