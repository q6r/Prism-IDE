import { useState, type CSSProperties } from 'react'
import type { ProviderProfile } from '../../../../../shared/agents'
import { relativeTime, usageWindows, useProviderUsage, type UsageEntry } from '../../../lib/providerUsage'
import { useStore } from '../../../store'
import { Button, cn, MeterRow, Spinner } from '../../ui'
import { SettingsDialog } from '../layout'
import { settingsWindowDetail } from '../usage'
import { canUseReset, ipcErrorMessage, omittedResetCount, omittedText, RESET_ACTION_LABEL, RESET_CONFIRM_TITLE, RESET_ERROR, resetConfirmDescription,
  resetCountText, resetCreditDetail, resetOutcomeToast, selectResetCredit, visibleResetCredits, type ResetCredit, type ResetCredits } from './resetCredits'

/**
 * The selected profile's usage, Settings variant (provider-rate-limit-views.tsx
 * ProviderRateLimitBody): loading, error, unavailable, a degraded reading kept
 * from the last good check, or one meter per window plus the provider's
 * extra figures and Codex's manual resets. Labels and severity come from the
 * shared usage cache, so the composer picker and this card never disagree.
 */
export function UsageLimitsBody({ profile, entry, now }: { profile: ProviderProfile; entry: UsageEntry | undefined; now: number }) {
  if (profile.enabled === false) return <p className="stg-usage-note">Perfil desativado. Ative-o para consultar os limites de uso.</p>
  const details = entry?.details
  if (!details) {
    return <div className="stg-usage-loading"><Spinner tone="muted" /> Carregando limites de uso</div>
  }
  const windows = usageWindows(details)
  const extras = details.extras ?? []
  const resets = profile.provider === 'codex' ? details.resetCredits : undefined
  if (!windows.length && !extras.length && !resets) {
    if (details.error) return <p className="stg-usage-error" role="alert">Não foi possível carregar os limites de uso. {details.error} Tente atualizar.</p>
    return <p className="stg-usage-note">Limites de uso indisponíveis - {details.unavailable ?? 'o provedor não informou janelas de uso para esta conta.'}</p>
  }
  const degraded = !!details.stale || !!details.error
  const body = <div className="stg-usage-stack">
    {windows.length ? <div className="stg-usage-windows">
      {windows.map((w) => <MeterRow key={w.id} label={w.label} usedPercent={w.usedPercent} severity={w.severity}
        detail={settingsWindowDetail(w.usedPercent, w.resetsAt, now)} />)}
    </div> : details.unavailable ? <p className="stg-usage-note">Limites de uso indisponíveis - {details.unavailable}</p> : null}
    {extras.length ? <dl className="stg-usage-extras">
      {extras.map((e, i) => <div key={`${e.label}:${i}`} className="stg-usage-extra"><dt>{e.label}</dt><dd>{e.value}</dd></div>)}
    </dl> : null}
    {resets ? <CodexResetCreditsRow key={profile.id} profile={profile} resetCredits={resets} now={now} /> : null}
  </div>
  if (!degraded) return body
  return <div className="stg-usage-degraded">
    <p className="stg-usage-note">{details.updatedAt ? `Atualizado ${relativeTime(details.updatedAt, now)} · ` : ''}{details.error ?? 'falha ao atualizar'}. Exibindo a última consulta disponível.</p>
    <div className={cn('stg-usage-dim')}>{body}</div>
  </div>
}

const STYLE: Record<'group' | 'divider' | 'count' | 'list' | 'line' | 'title' | 'warning' | 'redeeming', CSSProperties> = {
  group: { display: 'flex', flexDirection: 'column', gap: 8 },
  divider: { height: 1, background: 'color-mix(in oklab, var(--tr-border) 70%, transparent)' },
  count: { display: 'flex', alignItems: 'center', gap: 8 },
  list: { paddingLeft: 12 },
  line: { fontSize: 12, lineHeight: '16px' },
  title: { minWidth: 0 },
  warning: { color: 'var(--tr-destructive)' },
  redeeming: { display: 'inline-flex', alignItems: 'center', gap: 4 }
}

/**
 * "Redefinições manuais · 2 disponíveis [Usar redefinição]", then one line per
 * credit with its expiry, soonest first (CodexResetCreditsRow, Settings variant).
 */
function CodexResetCreditsRow({ profile, resetCredits, now }: { profile: ProviderProfile; resetCredits: ResetCredits; now: number }) {
  const credits = resetCredits.credits
  const visible = credits ? visibleResetCredits(credits) : []
  const omitted = omittedResetCount(resetCredits)
  return <div style={STYLE.group}>
    <div aria-hidden="true" style={STYLE.divider} />
    <dl className="stg-usage-extras">
      <div className="stg-usage-extra">
        <dt>Redefinições manuais</dt>
        <dd style={STYLE.count}>
          {resetCountText(resetCredits.availableCount)}
          {canUseReset(profile.provider, profile.enabled !== false, resetCredits)
            ? <CodexResetAction profile={profile} selected={credits ? selectResetCredit(credits, now) : null} availableCount={resetCredits.availableCount} now={now} />
            : null}
        </dd>
      </div>
    </dl>
    {visible.length ? <div style={{ ...STYLE.group, ...STYLE.list }}>
      <dl className="stg-usage-extras" aria-label="Redefinições manuais disponíveis">
        {visible.map((credit) => <ResetCreditLine key={credit.id} credit={credit} now={now} />)}
      </dl>
      {omitted > 0 ? <p className="stg-usage-note">{omittedText(omitted)}</p> : null}
    </div> : null}
  </div>
}

function ResetCreditLine({ credit, now }: { credit: ResetCredit; now: number }) {
  const detail = resetCreditDetail(credit, now)
  return <div className="stg-usage-extra" style={STYLE.line}>
    <dt className="tr-truncate" style={STYLE.title}>{credit.title ?? 'Redefinição manual'}</dt>
    <dd style={detail.warning ? STYLE.warning : undefined}>
      {detail.redeeming ? <span style={STYLE.redeeming}><Spinner tone="muted" />{detail.text}</span> : detail.text}
    </dd>
  </div>
}

/**
 * "Usar redefinição" (codex-reset-credit-action.tsx): a fresh idempotency key
 * per opening, kept across retries of that one confirmation, so a retried
 * click can never spend a second reset. Spends a real credit only after the
 * explicit confirmation; then the outcome's toast and a forced usage refresh.
 */
function CodexResetAction({ profile, selected, availableCount, now }: { profile: ProviderProfile; selected: ResetCredit | null; availableCount: number; now: number }) {
  const [open, setOpen] = useState(false)
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const close = (): void => {
    if (pending) return
    setOpen(false); setIdempotencyKey(null); setError('')
  }
  const confirm = async (): Promise<void> => {
    if (idempotencyKey === null || pending) return
    setPending(true); setError('')
    try {
      const { outcome } = await window.prism.providers.codexReset(profile.id, idempotencyKey, selected?.id ?? null)
      const toast = resetOutcomeToast(outcome)
      useStore.getState().addToast(toast.kind, toast.message)
      setOpen(false); setIdempotencyKey(null)
      void useProviderUsage.getState().refresh(profile)
    } catch (err) { setError(`${RESET_ERROR} ${ipcErrorMessage(err)}`) } finally { setPending(false) }
  }
  return <>
    <Button size="xs" variant="outline" disabled={pending} onClick={() => { setIdempotencyKey(crypto.randomUUID()); setError(''); setOpen(true) }}>
      {pending ? <Spinner tone="muted" /> : null}{RESET_ACTION_LABEL}
    </Button>
    <SettingsDialog open={open} onOpenChange={(next) => { if (!next) close() }} locked={pending} title={RESET_CONFIRM_TITLE}
      description={resetConfirmDescription(selected, availableCount, now)}
      footer={<>
        <Button size="sm" variant="ghost" disabled={pending} onClick={close}>Cancelar</Button>
        <Button size="sm" variant="destructive" disabled={pending || idempotencyKey === null} onClick={() => void confirm()}>
          {pending ? <Spinner tone="muted" /> : null}{RESET_ACTION_LABEL}
        </Button>
      </>}>
      {error ? <p className="stg-error" role="alert">{error}</p> : null}
    </SettingsDialog>
  </>
}
