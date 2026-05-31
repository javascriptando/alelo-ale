'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { api } from '@/lib/api'
import type { Client, Operator } from '@/lib/types'
import { PageHeader } from '@/components/ui'
import { IconBuilding, IconUsers, IconAgent, IconArrowRight } from '@/components/icons'

const STAGE_LABEL: Record<string, string> = {
  lead: 'Lead',
  quoting: 'Em cotação',
  signing: 'Assinatura',
  active: 'Ativo',
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

export default function CarteirasPage() {
  const [clients, setClients] = useState<Client[]>([])
  const [operators, setOperators] = useState<Operator[]>([])
  const [query, setQuery] = useState('')

  const load = () => api.clients().then(setClients).catch(() => {})
  useEffect(() => {
    load()
    api.operators().then(setOperators).catch(() => {})
  }, [])

  const assign = async (id: string, operatorId: string | null) => {
    await api.assignClient(id, operatorId)
    load()
  }

  const ops = operators.filter((o) => o.role !== 'admin')
  const total = clients.length
  const activeCount = clients.filter((c) => c.stage === 'active').length
  const headcount = clients.reduce((s, c) => s + (c.headcount ?? 0), 0)
  const unassigned = clients.filter((c) => !c.ownerOperatorId).length
  const maxLoad = Math.max(1, ...ops.map((o) => clients.filter((c) => c.ownerOperatorId === o.id).length))

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return clients
    return clients.filter(
      (c) =>
        c.companyName.toLowerCase().includes(q) ||
        (c.contactName ?? '').toLowerCase().includes(q) ||
        c.phone.includes(q),
    )
  }, [clients, query])

  return (
    <div>
      <PageHeader title="Carteiras" subtitle="Distribuição e gestão de clientes por operador" />

      <div className="space-y-6 p-4 sm:p-6 lg:p-8">
        {/* Summary */}
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          <SummaryCard icon={<IconBuilding />} label="Clientes" value={total} tone="green" />
          <SummaryCard icon={<IconUsers />} label="Ativos" value={activeCount} tone="green" />
          <SummaryCard icon={<IconUsers />} label="Beneficiários" value={headcount} tone="lime" />
          <SummaryCard icon={<IconAgent />} label="Sem carteira" value={unassigned} tone="amber" />
        </div>

        {/* Carteiras por operador */}
        <section>
          <h2 className="mb-3 text-sm font-semibold text-ink-soft">Carteiras por operador</h2>
          {ops.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-line bg-surface p-6 text-center text-sm text-ink-soft">
              Nenhum operador cadastrado ainda.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {ops
                .map((o) => ({ o, n: clients.filter((c) => c.ownerOperatorId === o.id).length }))
                .sort((a, b) => b.n - a.n)
                .map(({ o, n }) => (
                  <div key={o.id} className="rounded-2xl border border-line bg-surface p-4 shadow-sm">
                    <div className="flex items-center gap-3">
                      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-alelo text-sm font-bold text-white">
                        {initials(o.name)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-semibold text-ink">{o.name}</div>
                        <div className="text-xs text-ink-soft">
                          {n} cliente{n === 1 ? '' : 's'} na carteira
                        </div>
                      </div>
                      <span className="text-2xl font-extrabold text-alelo">{n}</span>
                    </div>
                    <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-canvas">
                      <div className="h-full rounded-full bg-alelo-lime" style={{ width: `${(n / maxLoad) * 100}%` }} />
                    </div>
                  </div>
                ))}
              {unassigned > 0 && (
                <div className="flex items-center gap-3 rounded-2xl border border-dashed border-alelo-lime bg-alelo-lime-soft/30 p-4">
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-alelo-lime text-sm font-bold text-alelo-dark">
                    {unassigned}
                  </span>
                  <div>
                    <div className="font-semibold text-alelo-dark">A distribuir</div>
                    <div className="text-xs text-ink-soft">
                      {unassigned} cliente{unassigned === 1 ? '' : 's'} sem carteira
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        {/* Lista de clientes */}
        <section>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-ink-soft">Todos os clientes ({total})</h2>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar empresa, contato ou telefone…"
              className="w-full max-w-xs rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-alelo focus:ring-2 focus:ring-alelo/20"
            />
          </div>

          {/* Desktop table */}
          <div className="hidden overflow-hidden rounded-2xl border border-line bg-surface shadow-sm md:block">
            <table className="w-full text-sm">
              <thead className="border-b border-line bg-canvas text-left text-ink-soft">
                <tr>
                  <th className="px-4 py-3 font-semibold">Empresa</th>
                  <th className="px-4 py-3 font-semibold">Contato</th>
                  <th className="px-4 py-3 font-semibold">Telefone</th>
                  <th className="px-4 py-3 font-semibold">Estágio</th>
                  <th className="px-4 py-3 font-semibold">Colab.</th>
                  <th className="px-4 py-3 font-semibold">Carteira</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-ink-soft">
                      Nenhum cliente encontrado.
                    </td>
                  </tr>
                )}
                {filtered.map((c) => (
                  <tr key={c.id} className="border-t border-line transition hover:bg-canvas">
                    <td className="px-4 py-3">
                      <Link href={`/carteiras/${c.id}`} className="font-semibold text-ink hover:text-alelo hover:underline">
                        {c.companyName}
                      </Link>
                      {c.cnpj && <div className="text-xs text-ink-soft">{c.cnpj}</div>}
                    </td>
                    <td className="px-4 py-3 text-ink-soft">{c.contactName ?? '—'}</td>
                    <td className="px-4 py-3 text-ink-soft">{c.phone}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${STAGE_STYLE[c.stage] ?? 'bg-neutral-100 text-neutral-600'}`}>
                        {STAGE_LABEL[c.stage] ?? c.stage}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-ink-soft">{c.headcount ?? '—'}</td>
                    <td className="px-4 py-3">
                      <select
                        value={c.ownerOperatorId ?? ''}
                        onChange={(e) => assign(c.id, e.target.value || null)}
                        className="rounded-lg border border-line bg-canvas px-2 py-1.5 text-xs text-ink outline-none focus:border-alelo"
                      >
                        <option value="">— a distribuir —</option>
                        {ops.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link href={`/carteiras/${c.id}`} className="inline-flex items-center gap-1 text-xs font-semibold text-alelo hover:underline">
                        Abrir <IconArrowRight size={14} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="space-y-3 md:hidden">
            {filtered.length === 0 && <p className="py-6 text-center text-sm text-ink-soft">Nenhum cliente encontrado.</p>}
            {filtered.map((c) => (
              <div key={c.id} className="rounded-2xl border border-line bg-surface p-4 shadow-sm">
                <div className="flex items-start justify-between gap-2">
                  <Link href={`/carteiras/${c.id}`} className="min-w-0 truncate font-semibold text-ink hover:text-alelo">
                    {c.companyName}
                  </Link>
                  <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${STAGE_STYLE[c.stage] ?? 'bg-neutral-100 text-neutral-600'}`}>
                    {STAGE_LABEL[c.stage] ?? c.stage}
                  </span>
                </div>
                <div className="mt-2 flex items-center justify-between text-xs text-ink-soft">
                  <span>{c.contactName ?? 'Sem contato'}</span>
                  <span>{c.headcount ?? 0} colab.</span>
                </div>
                <div className="mt-3">
                  <label className="mb-1 block text-[11px] font-semibold text-ink-soft">Carteira</label>
                  <select
                    value={c.ownerOperatorId ?? ''}
                    onChange={(e) => assign(c.id, e.target.value || null)}
                    className="w-full rounded-lg border border-line bg-canvas px-2 py-2 text-sm text-ink outline-none focus:border-alelo"
                  >
                    <option value="">— a distribuir —</option>
                    {ops.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}

function SummaryCard({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode
  label: string
  value: number
  tone: 'green' | 'lime' | 'amber'
}) {
  const chip =
    tone === 'lime'
      ? 'bg-alelo-lime-soft text-alelo-dark'
      : tone === 'amber'
        ? 'bg-amber-100 text-amber-700'
        : 'bg-alelo-mint text-alelo'
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-4 shadow-sm">
      <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${chip}`}>{icon}</span>
      <div className="min-w-0">
        <div className="text-2xl font-extrabold text-ink">{value}</div>
        <div className="truncate text-xs font-medium text-ink-soft">{label}</div>
      </div>
    </div>
  )
}
