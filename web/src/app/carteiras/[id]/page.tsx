'use client'

import { useCallback, useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import type { Client360 } from '@/lib/types'
import { ClientContext } from '@/components/client-context'
import { IconBuilding, IconUsers, IconArrowRight } from '@/components/icons'

const brl = (v: string | number | null) => {
  const n = typeof v === 'string' ? Number(v) : (v ?? 0)
  return (n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}
const STAGE_LABEL: Record<string, string> = {
  lead: 'Lead',
  quoting: 'Em cotação',
  signing: 'Assinatura',
  active: 'Cliente ativo',
  churned: 'Perdido',
}
const STAGE_STYLE: Record<string, string> = {
  lead: 'bg-sky-100 text-sky-700',
  quoting: 'bg-amber-100 text-amber-700',
  signing: 'bg-violet-100 text-violet-700',
  active: 'bg-alelo-mint text-alelo',
  churned: 'bg-neutral-100 text-neutral-500',
}
const initials = (name: string) =>
  name.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase()

/**
 * Full-width client detail for the carteira: a hero header (identity + KPIs)
 * spanning the page, then the 360 context (tabs) using the full canvas.
 */
export default function ClientDetailPage() {
  const params = useParams()
  const router = useRouter()
  const id = String(params?.id ?? '')
  const [data, setData] = useState<Client360 | null>(null)

  const load = useCallback(() => {
    if (id) api.client(id).then(setData).catch(() => setData(null))
  }, [id])
  useEffect(() => load(), [load])

  const c = data?.client
  const paidCount = (data?.payments ?? []).filter((p) => p.paidAt).length
  const monthly = data?.subscriptions?.[0]?.value ?? data?.quotes?.at(-1)?.monthlyTotal ?? null

  return (
    <div className="min-h-full bg-canvas">
      <div className="space-y-5 p-4 sm:p-6 lg:p-8">
        <button
          onClick={() => router.push('/carteiras')}
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-alelo hover:underline"
        >
          ← Voltar para carteiras
        </button>

        {!c ? (
          <div className="rounded-2xl border border-line bg-surface p-8 text-center text-sm text-ink-soft shadow-sm">
            Carregando cliente…
          </div>
        ) : (
          <>
            {/* Hero header */}
            <section className="overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
              <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-4">
                  <span className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-alelo text-lg font-bold text-white">
                    {initials(c.companyName)}
                  </span>
                  <div className="min-w-0">
                    <h1 className="truncate text-xl font-bold text-ink">{c.companyName}</h1>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-ink-soft">
                      {c.cnpj && <span>CNPJ {c.cnpj}</span>}
                      <span>{c.contactName ?? 'Sem contato'}</span>
                      <span>{c.phone}</span>
                    </div>
                  </div>
                </div>
                <span
                  className={`shrink-0 self-start rounded-full px-3 py-1 text-xs font-semibold sm:self-center ${STAGE_STYLE[c.stage] ?? 'bg-neutral-100 text-neutral-600'}`}
                >
                  {STAGE_LABEL[c.stage] ?? c.stage}
                </span>
              </div>

              {/* KPI strip */}
              <div className="grid grid-cols-2 gap-px border-t border-line bg-line lg:grid-cols-4">
                <Kpi label="Beneficiários" value={String(data!.beneficiaries.length)} icon={<IconUsers />} />
                <Kpi label="Cotações" value={String(data!.quotes.length)} icon={<IconBuilding />} />
                <Kpi label="Pagamentos pagos" value={String(paidCount)} icon={<IconArrowRight size={16} />} />
                <Kpi label="Mensalidade" value={monthly ? `${brl(monthly)}` : '—'} icon={<IconBuilding />} />
              </div>
            </section>

            {/* 360 context — full width */}
            <section className="rounded-2xl border border-line bg-surface p-5 shadow-sm">
              <ClientContext clientId={id} full onChange={load} />
            </section>
          </>
        )}
      </div>
    </div>
  )
}

function Kpi({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 bg-surface px-5 py-4">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-alelo-mint text-alelo">{icon}</span>
      <div className="min-w-0">
        <div className="truncate text-lg font-extrabold text-ink">{value}</div>
        <div className="truncate text-[11px] font-medium text-ink-soft">{label}</div>
      </div>
    </div>
  )
}
