'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import type { Dashboard, Nps } from '@/lib/types'
import { Badge, PageHeader } from '@/components/ui'
import { NpsCard } from '@/components/nps-card'
import { VolumeChart } from '@/components/volume-chart'
import { useRealtime } from '@/hooks/use-realtime'
import {
  IconUsers,
  IconClock,
  IconBot,
  IconAgent,
  IconDoc,
  IconCard,
  IconCheck,
  IconArrowRight,
} from '@/components/icons'

const brl = (n: number) =>
  n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 })

// Selectable chart periods.
const PERIODS = [
  { value: 7, label: '7d' },
  { value: 30, label: '30d' },
  { value: 90, label: '90d' },
]

export default function DashboardPage() {
  const router = useRouter()
  const [dash, setDash] = useState<Dashboard | null>(null)
  const [nps, setNps] = useState<Nps | null>(null)
  const [wa, setWa] = useState<{ ready: boolean; qr: string | null; canManage: boolean } | null>(null)
  const [days, setDays] = useState(7)

  const load = () => {
    api.dashboard(days).then(setDash).catch(() => {})
    api.nps().then(setNps).catch(() => {})
    api.whatsappStatus().then(setWa).catch(() => {})
  }
  useEffect(() => {
    load()
    const t = setInterval(load, 10000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days])
  useRealtime(() => load())

  const k = dash?.kpis
  // Scale bars by the busiest day's AI+human total (client msgs aren't charted —
  // the chart cruzes "quem ATENDEU": Alê vs operador).
  const totalAi = dash?.volume.reduce((s, v) => s + v.ai, 0) ?? 0
  const totalHuman = dash?.volume.reduce((s, v) => s + v.human, 0) ?? 0

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle={dash?.scope === 'operator' ? 'Sua operação em tempo real' : 'Visão geral da operação em tempo real'}
      >
        <span
          className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold sm:text-sm ${
            wa?.ready ? 'bg-alelo-mint text-alelo' : 'bg-amber-100 text-amber-700'
          }`}
        >
          <span className={`h-2 w-2 rounded-full ${wa?.ready ? 'bg-alelo' : 'bg-amber-500'}`} />
          WhatsApp {wa?.ready ? 'conectado' : 'offline'}
        </span>
      </PageHeader>

      <div className="space-y-6 p-4 sm:p-6 lg:p-8">
        {/* Hero */}
        <div className="alelo-gradient relative overflow-hidden rounded-3xl p-6 text-white shadow-sm sm:p-7">
          <div className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full border-[20px] border-white/10" />
          <div className="relative z-10 flex flex-wrap items-end justify-between gap-6">
            <div>
              <p className="text-sm font-medium text-white/80">Volume contratado (cotações)</p>
              <p className="mt-1 text-3xl font-extrabold sm:text-4xl">{brl(k?.quotesMonthlyTotal ?? 0)}</p>
              <p className="mt-1 text-sm text-white/80">{k?.quotes ?? 0} cotações geradas</p>
            </div>
            <div className="flex flex-wrap gap-6 sm:gap-8">
              <HeroStat icon={<IconCheck />} label="Assinados" value={k?.contractsSigned ?? 0} />
              <HeroStat icon={<IconDoc />} label="Aguardando" value={k?.contractsPending ?? 0} />
              <HeroStat icon={<IconCard />} label="Beneficiários" value={k?.beneficiaries ?? 0} />
            </div>
          </div>
        </div>

        {/* KPIs */}
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          <KpiCard
            label={dash?.scope === 'operator' ? 'Meus atendimentos' : 'Em atendimento'}
            value={k?.mine ?? 0}
            icon={<IconAgent />}
            tone="green"
            onClick={() => router.push('/inbox')}
          />
          <KpiCard
            label="Na fila"
            value={k?.queueDepth ?? 0}
            icon={<IconClock />}
            tone="amber"
            hint={dash?.scope === 'admin' ? `${k?.onlineOperators ?? 0} online` : undefined}
            onClick={() => router.push('/inbox')}
          />
          <KpiCard label="Com a Alê" value={k?.withAI ?? 0} icon={<IconBot />} tone="lime" onClick={() => router.push('/inbox')} />
          <KpiCard
            label={dash?.scope === 'operator' ? 'Minha carteira' : 'Clientes'}
            value={k?.clients ?? 0}
            icon={<IconUsers />}
            tone="green"
            onClick={() => router.push('/carteiras')}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {/* Volume chart — atendimentos por dia, cruzando Alê (IA) vs Humano */}
          <div className="rounded-2xl border border-line bg-surface p-6 shadow-sm lg:col-span-2">
            <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-ink">
                  Atendimentos · últimos {days} dias
                </h2>
                <p className="mt-0.5 text-xs text-ink-soft">{totalAi + totalHuman} mensagens enviadas</p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {/* Period selector */}
                <div className="flex rounded-lg border border-line bg-canvas p-0.5">
                  {PERIODS.map((p) => (
                    <button
                      key={p.value}
                      onClick={() => setDays(p.value)}
                      className={`rounded-md px-2.5 py-1 text-xs font-semibold transition ${
                        days === p.value ? 'bg-alelo text-white shadow-sm' : 'text-ink-soft hover:text-ink'
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-3 text-[11px] font-medium text-ink-soft">
                  <span className="flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-sm bg-alelo" /> Alê {totalAi}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-sm bg-indigo-400" /> Humano {totalHuman}
                  </span>
                </div>
              </div>
            </div>
            {/* Nivo stacked bar chart — atendimentos por dia (Alê vs Humano). */}
            <VolumeChart volume={dash?.volume ?? []} days={days} />
          </div>

          {/* NPS gauge */}
          <NpsCard nps={nps} />
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {/* Activity */}
          <div className="rounded-2xl border border-line bg-surface p-6 shadow-sm lg:col-span-2">
            <h2 className="mb-3 text-sm font-semibold text-ink">Atividade recente</h2>
            <div className="divide-y divide-line">
              {(dash?.recent ?? []).length === 0 && <p className="py-6 text-sm text-ink-soft">Nenhuma atividade ainda.</p>}
              {(dash?.recent ?? []).map((r) => (
                <button
                  key={r.id}
                  onClick={() => router.push(`/tickets/${r.id}`)}
                  className="flex w-full items-center justify-between gap-3 py-2.5 text-left transition hover:opacity-80"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-ink">{r.companyName}</div>
                    <div className="truncate text-xs text-ink-soft">{r.subject}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {r.handlingMode === 'ai' && (
                      <span className="rounded-full bg-alelo-mint px-2 py-0.5 text-[10px] font-semibold text-alelo-dark">
                        Alê
                      </span>
                    )}
                    {/* Only flag priority when it's an actual alert (high/urgent),
                        to avoid badge/color noise on routine tickets. */}
                    {(r.priority === 'high' || r.priority === 'urgent') && <Badge value={r.priority} />}
                    <Badge value={r.status} />
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Ticket status + WhatsApp */}
          <div className="space-y-4">
            <div className="rounded-2xl border border-line bg-surface p-6 shadow-sm">
              <h2 className="mb-3 text-sm font-semibold text-ink-soft">Tickets por status</h2>
              <div className="space-y-2">
                <StatusBar label="Abertos" value={k?.openTickets ?? 0} color="bg-sky-400" />
                <StatusBar label="Pendentes" value={k?.pendingTickets ?? 0} color="bg-amber-400" />
                <StatusBar label="Resolvidos" value={k?.resolvedTickets ?? 0} color="bg-alelo" />
                <StatusBar label="Fechados" value={k?.closedTickets ?? 0} color="bg-neutral-300" />
              </div>
            </div>
            <div className="rounded-2xl border border-line bg-surface p-6 shadow-sm">
              <h2 className="text-sm font-semibold text-ink-soft">Conexão WhatsApp</h2>
              {wa?.ready ? (
                <div className="mt-4 flex items-center gap-3">
                  <span className="grid h-10 w-10 place-items-center rounded-full bg-alelo-mint text-alelo">
                    <IconCheck />
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-alelo">Conectado</p>
                    <p className="text-xs text-ink-soft">A Alê está atendendo.</p>
                  </div>
                </div>
              ) : wa?.canManage && wa?.qr ? (
                <div className="mt-3 flex flex-col items-center">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={wa.qr} alt="QR WhatsApp" className="h-40 w-40 rounded-xl border border-line p-1" />
                  <p className="mt-2 text-xs text-ink-soft">Escaneie em Aparelhos conectados</p>
                </div>
              ) : wa?.canManage ? (
                <a
                  href={`${process.env.NEXT_PUBLIC_API_URL}/whatsapp/qr`}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-alelo hover:underline"
                >
                  Abrir QR para parear <IconArrowRight size={16} />
                </a>
              ) : (
                <div className="mt-4 flex items-center gap-3">
                  <span className="grid h-10 w-10 place-items-center rounded-full bg-amber-100 text-amber-600">
                    <IconClock />
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-amber-700">Offline</p>
                    <p className="text-xs text-ink-soft">Um administrador precisa reconectar.</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function HeroStat({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="grid h-9 w-9 place-items-center rounded-lg bg-white/15 text-white">{icon}</span>
      <div>
        <p className="text-xl font-extrabold leading-none">{value}</p>
        <p className="mt-0.5 text-xs text-white/80">{label}</p>
      </div>
    </div>
  )
}

function KpiCard({
  label,
  value,
  icon,
  tone,
  hint,
  onClick,
}: {
  label: string
  value: number
  icon: React.ReactNode
  tone: 'green' | 'lime' | 'amber'
  hint?: string
  onClick?: () => void
}) {
  const chip =
    tone === 'lime' ? 'bg-alelo-lime-soft text-alelo-dark' : tone === 'amber' ? 'bg-amber-100 text-amber-700' : 'bg-alelo-mint text-alelo'
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-4 text-left shadow-sm transition enabled:hover:border-alelo enabled:hover:shadow sm:p-5"
    >
      <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl ${chip}`}>{icon}</span>
      <div className="min-w-0">
        <div className="text-2xl font-extrabold text-ink">{value}</div>
        <div className="truncate text-xs font-medium text-ink-soft">{label}</div>
        {hint && <div className="truncate text-[10px] text-ink-soft">{hint}</div>}
      </div>
    </button>
  )
}

function StatusBar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-20 text-xs text-ink-soft">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-canvas">
        <div className={`h-full ${color}`} style={{ width: value ? `${Math.min(100, value * 12)}%` : '0%' }} />
      </div>
      <span className="w-6 text-right text-xs font-semibold text-ink">{value}</span>
    </div>
  )
}

// NPS card lives in components/nps-card.tsx (imported above).
