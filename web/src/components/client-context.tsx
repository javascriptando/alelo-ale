'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import type { Client360 } from '@/lib/types'
import { Badge, ticketRef } from './ui'

const brl = (v: string | number | null) => {
  const n = typeof v === 'string' ? Number(v) : (v ?? 0)
  return (n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}
const date = (s: string | null) => (s ? new Date(s).toLocaleDateString('pt-BR') : '—')
const BENEFIT_LABEL: Record<string, string> = {
  refeicao: 'Refeição',
  alimentacao: 'Alimentação',
  mobilidade: 'Mobilidade',
  multibeneficios: 'Multibenefícios',
}
const STAGE_LABEL: Record<string, string> = {
  lead: 'Lead',
  quoting: 'Em cotação',
  signing: 'Assinatura',
  active: 'Cliente ativo',
  churned: 'Perdido',
}

type Tab = 'resumo' | 'beneficiarios' | 'historico' | 'acoes'

/**
 * 360º client context. Header with the client data is always visible; the rest
 * (cotações, contratos, pagamentos, beneficiários, histórico e ações) fica em
 * abas para não poluir. Usado no painel do ticket e na carteira (modo `full`).
 */
export function ClientContext({
  clientId,
  ticketId,
  onChange,
  full = false,
  reloadSignal,
}: {
  clientId: string
  ticketId?: string
  onChange?: () => void
  /** Full mode (carteira page) spreads content across the available width. */
  full?: boolean
  /** Bump this (e.g. on a realtime event) to refresh the 360 data live. */
  reloadSignal?: number
}) {
  const [data, setData] = useState<Client360 | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('resumo')

  const load = useCallback(() => {
    api.client(clientId).then(setData).catch(() => setData(null))
  }, [clientId])
  // Reload on mount, on client change, and whenever the parent bumps
  // reloadSignal (realtime: new payment, beneficiary, quote, ticket, etc.).
  useEffect(() => load(), [load, reloadSignal])

  const runAction = async (tool: string, args: Record<string, unknown>, label: string) => {
    setBusy(label)
    setMsg(null)
    try {
      const r = await api.clientAction(clientId, tool, args)
      setMsg(r.message ?? 'Feito.')
      load()
      onChange?.()
    } catch {
      setMsg('Não foi possível executar agora.')
    } finally {
      setBusy(null)
    }
  }

  if (!data) return <div className="p-4 text-sm text-ink-soft">Carregando contexto…</div>
  const { client, quotes, contracts, beneficiaries, tickets } = data
  const payments = data.payments ?? []
  const subscriptions = data.subscriptions ?? []
  const pastTickets = ticketId ? tickets.filter((t) => t.id !== ticketId) : tickets

  return (
    <div className="space-y-4">
      {/* Client header — always visible */}
      <section className="rounded-xl border border-line bg-canvas p-3 text-sm">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate font-semibold text-ink">{client.companyName}</div>
            {client.cnpj && <div className="text-xs text-ink-soft">CNPJ {client.cnpj}</div>}
          </div>
          <span className="shrink-0 rounded-full bg-alelo-mint px-2.5 py-0.5 text-xs font-semibold text-alelo">
            {STAGE_LABEL[client.stage] ?? client.stage}
          </span>
        </div>
        <dl className="mt-2 space-y-0.5 text-xs text-ink-soft">
          <Row k="Contato" v={client.contactName ?? '—'} />
          {client.email && <Row k="E-mail" v={client.email} />}
          <Row k="Telefone" v={client.phone} />
          <Row k="Colaboradores" v={String(client.headcount ?? '—')} />
        </dl>
      </section>

      {/* Tabs */}
      <div className="flex gap-1 rounded-xl bg-canvas p-1 text-xs font-semibold">
        <TabBtn active={tab === 'resumo'} onClick={() => setTab('resumo')}>
          Resumo
        </TabBtn>
        <TabBtn active={tab === 'beneficiarios'} onClick={() => setTab('beneficiarios')}>
          Associados
        </TabBtn>
        <TabBtn active={tab === 'historico'} onClick={() => setTab('historico')}>
          Histórico
        </TabBtn>
        <TabBtn active={tab === 'acoes'} onClick={() => setTab('acoes')}>
          Ações
        </TabBtn>
      </div>

      {/* RESUMO: cotações, contratos, pagamentos */}
      {tab === 'resumo' && (
        <div className={full ? 'grid grid-cols-1 gap-5 lg:grid-cols-3' : 'space-y-5'}>
          <section>
            <H>Pagamentos ({payments.length})</H>
            {subscriptions.length > 0 && (
              <div className="mb-2 rounded-lg border border-alelo-lime bg-alelo-lime-soft/40 px-3 py-2 text-xs">
                <span className="font-semibold text-alelo-dark">
                  Mensalidade ativa: {brl(subscriptions[0].value)}/mês
                </span>
                {subscriptions[0].nextDueDate && (
                  <div className="text-ink-soft">Próx. vencimento: {date(subscriptions[0].nextDueDate)}</div>
                )}
              </div>
            )}
            {payments.length === 0 ? (
              <Empty>Nenhum pagamento registrado.</Empty>
            ) : (
              <ul className="space-y-1">
                {payments.slice(0, 12).map((p) => {
                  const s = (p.status ?? '').toUpperCase()
                  const paid = Boolean(p.paidAt) || ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'].includes(s)
                  const overdue = !paid && s === 'OVERDUE'
                  const label = paid ? 'pago' : overdue ? 'vencido' : 'a pagar'
                  const cls = paid
                    ? 'bg-alelo-mint text-alelo'
                    : overdue
                      ? 'bg-red-100 text-red-700'
                      : 'bg-amber-100 text-amber-700'
                  // Paid → show when it was paid; pending → show the due date.
                  const when = paid
                    ? p.paidAt
                      ? `pago em ${date(p.paidAt)}`
                      : 'pago'
                    : p.expiresAt
                      ? `vence ${date(p.expiresAt)}`
                      : `criado ${date(p.createdAt)}`
                  return (
                    <li
                      key={p.id}
                      className="flex items-center justify-between gap-2 rounded-lg border border-line bg-canvas px-3 py-1.5 text-xs"
                    >
                      <span className="flex flex-col">
                        <span className="font-semibold text-ink">{brl(p.fullValue ?? p.value)}</span>
                        <span className="text-[10px] text-ink-soft">{when}</span>
                      </span>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${cls}`}>
                        {label}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          <section>
            <H>Cotações ({quotes.length})</H>
            {quotes.length === 0 ? (
              <Empty>Nenhuma cotação.</Empty>
            ) : (
              <ul className="space-y-1.5">
                {quotes.slice(0, 6).map((q) => (
                  <li
                    key={q.id}
                    className="flex items-center justify-between rounded-lg border border-line bg-canvas px-3 py-2 text-xs"
                  >
                    <span className="text-ink-soft">
                      {q.headcount} colab. · {date(q.createdAt)}
                    </span>
                    <span className="font-semibold text-ink">{brl(q.monthlyTotal)}/mês</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <H>Contratos ({contracts.length})</H>
            {contracts.length === 0 ? (
              <Empty>Nenhum contrato.</Empty>
            ) : (
              <ul className="space-y-1.5">
                {contracts.slice(0, 6).map((c) => {
                  const signed = c.status === 'signed' || Boolean(c.signedAt)
                  return (
                    <li
                      key={c.id}
                      className="flex items-center justify-between gap-2 rounded-lg border border-line bg-canvas px-3 py-2 text-xs"
                    >
                      <Badge value={c.status} />
                      {signed ? (
                        <span className="text-ink-soft">assinado {c.signedAt ? `em ${date(c.signedAt)}` : ''}</span>
                      ) : c.signingUrl ? (
                        <a
                          href={c.signingUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="font-semibold text-alelo hover:underline"
                        >
                          abrir p/ assinar
                        </a>
                      ) : (
                        <span className="text-ink-soft">—</span>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        </div>
      )}

      {/* ASSOCIADOS — gerenciar individualmente (editar, excluir, adicionar) */}
      {tab === 'beneficiarios' && (
        <BeneficiariesManager
          clientId={clientId}
          beneficiaries={beneficiaries}
          full={full}
          onChange={() => {
            load()
            onChange?.()
          }}
        />
      )}

      {/* HISTÓRICO */}
      {tab === 'historico' && (
        <section>
          <H>Tickets ({pastTickets.length})</H>
          {pastTickets.length === 0 ? (
            <Empty>Sem histórico de atendimentos.</Empty>
          ) : (
            <ul className="space-y-1.5">
              {pastTickets.map((t) => (
                <li
                  key={t.id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-line bg-canvas px-3 py-2 text-xs"
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="font-mono text-[10px] text-alelo">{ticketRef(t.id)}</span>
                    <span className="min-w-0 truncate text-ink-soft">{t.subject}</span>
                  </span>
                  <Badge value={t.status} />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* AÇÕES */}
      {tab === 'acoes' && (
        <section>
          {msg && (
            <p className="mb-2 rounded-lg bg-alelo-mint/60 px-2.5 py-1.5 text-xs text-alelo-dark">{msg}</p>
          )}
          <div className={full ? 'grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3' : 'grid grid-cols-1 gap-2'}>
            <ActionBtn
              busy={busy === 'cotar'}
              onClick={() => {
                const n = Number(prompt('Quantos colaboradores para cotar?') ?? '')
                if (n > 0) runAction('calcular_cotacao', { headcount: n, benefits: [] }, 'cotar')
              }}
            >
              Nova cotação
            </ActionBtn>
            <ActionBtn
              busy={busy === 'assinar'}
              disabled={quotes.length === 0}
              onClick={() => runAction('iniciar_assinatura', {}, 'assinar')}
            >
              {contracts.length ? 'Reenviar contrato p/ assinar' : 'Enviar contrato p/ assinar (DocuSign)'}
            </ActionBtn>
            <ActionBtn
              busy={busy === 'pix'}
              disabled={quotes.length === 0}
              onClick={() => runAction('gerar_pagamento_pix', {}, 'pix')}
            >
              Gerar cobrança PIX
            </ActionBtn>
            <ActionBtn
              busy={busy === 'pagamentos'}
              onClick={() => runAction('consultar_pagamentos', {}, 'pagamentos')}
            >
              Ver / reenviar pagamentos pendentes
            </ActionBtn>
            <ActionBtn
              busy={busy === 'cadastrar'}
              onClick={() => {
                const names = prompt('Colaboradores (um por linha ou separados por vírgula): nome,cpf')
                if (names && names.trim()) {
                  const list = names
                    .split(/[\n,;]+/)
                    .map((n) => n.trim())
                    .filter(Boolean)
                  // pares nome,cpf alternados não são triviais aqui; envia como nomes simples
                  const beneficiaries = list.map((name) => ({ name }))
                  runAction('cadastrar_beneficiarios', { beneficiaries }, 'cadastrar')
                }
              }}
            >
              Cadastrar colaboradores
            </ActionBtn>
            <ActionBtn
              busy={busy === 'renovar'}
              onClick={() => {
                const d = Number(prompt('Agendar lembrete de renovação em quantos dias?') ?? '')
                if (d > 0) runAction('agendar_renovacao', { daysFromNow: d }, 'renovar')
              }}
            >
              Agendar renovação
            </ActionBtn>
          </div>
          <p className="mt-2 text-[11px] text-ink-soft">
            As ações usam as mesmas ferramentas da Alê e enviam ao cliente pelo WhatsApp.
          </p>
        </section>
      )}
    </div>
  )
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 rounded-lg px-2 py-1.5 transition ${
        active ? 'bg-surface text-alelo shadow-sm' : 'text-ink-soft hover:text-ink'
      }`}
    >
      {children}
    </button>
  )
}
function H({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-soft">{children}</h3>
}
function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span>{k}</span>
      <span className="truncate font-medium text-ink">{v}</span>
    </div>
  )
}
function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-ink-soft">{children}</p>
}
function ActionBtn({
  children,
  onClick,
  busy,
  disabled,
}: {
  children: React.ReactNode
  onClick: () => void
  busy?: boolean
  disabled?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy || disabled}
      className="rounded-xl border border-line bg-surface px-3 py-2 text-left text-xs font-semibold text-ink transition hover:border-alelo hover:bg-canvas disabled:opacity-40"
    >
      {busy ? 'Executando…' : children}
    </button>
  )
}

const BENEFIT_OPTS = [
  { v: 'refeicao', l: 'Refeição' },
  { v: 'alimentacao', l: 'Alimentação' },
  { v: 'mobilidade', l: 'Mobilidade' },
  { v: 'multibeneficios', l: 'Multibenefícios' },
]

/** Manage associates one-by-one: search, add, inline edit, delete. */
function BeneficiariesManager({
  clientId,
  beneficiaries,
  full,
  onChange,
}: {
  clientId: string
  beneficiaries: Client360['beneficiaries']
  full: boolean
  onChange: () => void
}) {
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<{ name: string; cpf: string; benefitType: string }>({
    name: '',
    cpf: '',
    benefitType: 'refeicao',
  })
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)

  const filtered = beneficiaries.filter((b) => {
    const s = q.trim().toLowerCase()
    if (!s) return true
    return b.name.toLowerCase().includes(s) || (b.cpf ?? '').includes(s.replace(/\D/g, ''))
  })

  const startEdit = (b: Client360['beneficiaries'][number]) => {
    setEditing(b.id)
    setDraft({ name: b.name, cpf: b.cpf ?? '', benefitType: b.benefitType })
    setAdding(false)
  }
  const save = async (bid: string) => {
    if (!draft.name.trim()) return
    setBusy(true)
    try {
      await api.updateBeneficiary(clientId, bid, draft)
      setEditing(null)
      onChange()
    } finally {
      setBusy(false)
    }
  }
  const create = async () => {
    if (!draft.name.trim()) return
    setBusy(true)
    try {
      await api.addBeneficiary(clientId, draft)
      setAdding(false)
      setDraft({ name: '', cpf: '', benefitType: 'refeicao' })
      onChange()
    } finally {
      setBusy(false)
    }
  }
  const remove = async (bid: string, name: string) => {
    if (!confirm(`Excluir o associado "${name}"? Esta ação é permanente.`)) return
    setBusy(true)
    try {
      await api.deleteBeneficiary(clientId, bid)
      onChange()
    } finally {
      setBusy(false)
    }
  }

  const fields = (onSave: () => void, onCancel: () => void) => (
    <div className="flex flex-col gap-1.5 rounded-lg border border-alelo/40 bg-surface p-2">
      <input
        autoFocus
        value={draft.name}
        onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
        placeholder="Nome completo"
        className="rounded-md border border-line bg-canvas px-2 py-1.5 text-xs outline-none focus:border-alelo"
      />
      <div className="flex gap-1.5">
        <input
          value={draft.cpf}
          onChange={(e) => setDraft((d) => ({ ...d, cpf: e.target.value }))}
          placeholder="CPF"
          className="w-1/2 rounded-md border border-line bg-canvas px-2 py-1.5 text-xs tabular-nums outline-none focus:border-alelo"
        />
        <select
          value={draft.benefitType}
          onChange={(e) => setDraft((d) => ({ ...d, benefitType: e.target.value }))}
          className="w-1/2 rounded-md border border-line bg-canvas px-2 py-1.5 text-xs outline-none focus:border-alelo"
        >
          {BENEFIT_OPTS.map((o) => (
            <option key={o.v} value={o.v}>
              {o.l}
            </option>
          ))}
        </select>
      </div>
      <div className="flex gap-1.5">
        <button
          onClick={onSave}
          disabled={busy || !draft.name.trim()}
          className="flex-1 rounded-md bg-alelo px-2 py-1.5 text-xs font-semibold text-white hover:bg-alelo-dark disabled:opacity-40"
        >
          Salvar
        </button>
        <button
          onClick={onCancel}
          className="rounded-md border border-line px-3 py-1.5 text-xs font-semibold text-ink-soft hover:bg-canvas"
        >
          Cancelar
        </button>
      </div>
    </div>
  )

  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2">
        <H>Associados ({beneficiaries.length})</H>
        <button
          onClick={() => {
            setAdding(true)
            setEditing(null)
            setDraft({ name: '', cpf: '', benefitType: 'refeicao' })
          }}
          className="rounded-lg bg-alelo px-2.5 py-1 text-xs font-semibold text-white hover:bg-alelo-dark"
        >
          + Adicionar
        </button>
      </div>

      {beneficiaries.length > 6 && (
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscar por nome ou CPF…"
          className="mb-2 w-full rounded-lg border border-line bg-canvas px-3 py-1.5 text-xs outline-none focus:border-alelo"
        />
      )}

      {adding && <div className="mb-2">{fields(create, () => setAdding(false))}</div>}

      {beneficiaries.length === 0 && !adding ? (
        <Empty>Nenhum colaborador cadastrado ainda.</Empty>
      ) : (
        <ul
          className={
            full
              ? 'grid max-h-[34rem] grid-cols-1 gap-1.5 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3'
              : 'max-h-[28rem] space-y-1.5 overflow-y-auto'
          }
        >
          {filtered.map((b) =>
            editing === b.id ? (
              <li key={b.id}>{fields(() => save(b.id), () => setEditing(null))}</li>
            ) : (
              <li
                key={b.id}
                className="group flex items-center justify-between gap-2 rounded-lg border border-line bg-canvas px-3 py-1.5 text-xs"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-ink">{b.name}</span>
                  <span className="flex items-center gap-2 text-[10px] text-ink-soft">
                    {b.cpf && <span className="tabular-nums">{b.cpf}</span>}
                    <span>{BENEFIT_LABEL[b.benefitType] ?? b.benefitType}</span>
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1 opacity-0 transition group-hover:opacity-100">
                  <button
                    onClick={() => startEdit(b)}
                    className="rounded-md px-1.5 py-1 text-[11px] font-semibold text-alelo hover:bg-alelo-mint"
                    title="Editar"
                  >
                    Editar
                  </button>
                  <button
                    onClick={() => remove(b.id, b.name)}
                    className="rounded-md px-1.5 py-1 text-[11px] font-semibold text-red-600 hover:bg-red-50"
                    title="Excluir"
                  >
                    Excluir
                  </button>
                </span>
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  )
}
