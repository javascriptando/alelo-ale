'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { api } from '@/lib/api'
import type { Operator, TicketDetail } from '@/lib/types'
import { Badge, ticketRef } from '@/components/ui'
import { SuggestionsPanel } from '@/components/suggestions-panel'
import { ClientContext } from '@/components/client-context'
import { useRealtime } from '@/hooks/use-realtime'

const NEXT_ACTIONS: Record<string, { to: string; label: string; primary?: boolean }[]> = {
  open: [
    { to: 'resolved', label: 'Resolver', primary: true },
    { to: 'closed', label: 'Fechar' },
  ],
  pending: [
    { to: 'resolved', label: 'Resolver', primary: true },
    { to: 'open', label: 'Voltar p/ aberto' },
    { to: 'closed', label: 'Fechar' },
  ],
  resolved: [
    { to: 'open', label: 'Reabrir', primary: true },
    { to: 'closed', label: 'Fechar' },
  ],
  closed: [{ to: 'open', label: 'Reabrir', primary: true }],
}

export default function TicketDetailPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const [data, setData] = useState<TicketDetail | null>(null)
  const [operators, setOperators] = useState<Operator[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [panelTab, setPanelTab] = useState<'context' | 'history'>('context')
  const bottomRef = useRef<HTMLDivElement>(null)

  const load = useCallback(() => {
    api.ticket(id).then(setData).catch(() => setData(null))
  }, [id])

  useEffect(() => load(), [load])
  useEffect(() => {
    api.operators().then(setOperators).catch(() => {})
  }, [])
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [data?.thread.length])

  useRealtime((e) => {
    if ((e.type === 'message' || e.type === 'ticket.created') && data) load()
  })

  if (!data) return <div className="p-8 text-ink-soft">Carregando ticket…</div>
  const { ticket, client, thread, events } = data
  const convId = ticket.conversationId

  const transition = async (to: string) => {
    await api.transitionTicket(ticket.id, to).catch(() => {})
    load()
  }
  const reply = async () => {
    if (!convId || !draft.trim()) return
    setSending(true)
    try {
      await api.reply(convId, draft.trim())
      setDraft('')
      load()
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-line bg-surface px-6 py-4">
        <div className="min-w-0">
          <Link href="/tickets" className="text-xs font-semibold text-ink-soft hover:text-alelo">
            ← Tickets
          </Link>
          <div className="flex items-center gap-2">
            <h1 className="truncate text-lg font-bold text-ink">{ticket.subject}</h1>
            <span className="shrink-0 rounded-md bg-alelo-mint px-2 py-0.5 font-mono text-[11px] font-semibold text-alelo-dark">
              {ticketRef(ticket.id)}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-2 text-xs text-ink-soft">
            <span>{client?.companyName}</span>
            <span>·</span>
            <span>{client?.phone}</span>
            {ticket.reopenCount ? (
              <>
                <span>·</span>
                <span className="font-semibold text-amber-600">reaberto {ticket.reopenCount}x</span>
              </>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge value={ticket.priority} />
          {ticket.category && <Badge value={ticket.category} />}
          <Badge value={ticket.status} />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col-reverse md:flex-row">
        {/* Thread + reply */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-canvas">
          <div className="flex-1 space-y-3 overflow-y-auto p-6">
            {thread.length === 0 && (
              <p className="text-sm text-ink-soft">Sem mensagens vinculadas a este ticket ainda.</p>
            )}
            {thread.map((m) => (
              <div key={m.id} className={`flex ${m.role === 'client' ? 'justify-start' : 'justify-end'}`}>
                <div className={`max-w-[72%] rounded-2xl px-4 py-2 text-sm shadow-sm ${bubble(m.role)}`}>
                  <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide opacity-70">
                    {roleLabel(m.role)}
                    {m.toolName ? ` · ${m.toolName}` : ''}
                  </div>
                  <div className="whitespace-pre-wrap">{m.content}</div>
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          {ticket.status !== 'closed' && (
            <SuggestionsPanel conversationId={convId} onPick={(t) => setDraft(t)} />
          )}

          <div className="border-t border-line bg-surface p-4">
            <div className="flex gap-2">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && reply()}
                placeholder="Responder ao cliente (assume o atendimento)…"
                className="flex-1 rounded-xl border border-line bg-canvas px-4 py-2.5 text-sm text-ink outline-none transition focus:border-alelo focus:ring-2 focus:ring-alelo/20"
              />
              <button
                onClick={reply}
                disabled={sending || !draft.trim() || !convId}
                className="rounded-xl bg-alelo px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-alelo-dark disabled:opacity-40"
              >
                Enviar
              </button>
            </div>
          </div>
        </div>

        {/* Side panel: actions + 360 context / history (stacks on mobile) */}
        <div className="shrink-0 overflow-y-auto border-b border-line bg-surface p-4 md:w-80 md:border-b-0 md:border-l">
          {/* Status actions */}
          <div className="mb-4 flex flex-wrap gap-2">
            {(NEXT_ACTIONS[ticket.status] ?? []).map((a) => (
              <button
                key={a.to}
                onClick={() => transition(a.to)}
                className={`rounded-xl px-3 py-1.5 text-xs font-semibold transition ${
                  a.primary
                    ? 'bg-alelo text-white shadow-sm hover:bg-alelo-dark'
                    : 'border border-line text-ink hover:bg-canvas'
                }`}
              >
                {a.label}
              </button>
            ))}
          </div>

          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-soft">Responsável</h3>
          <select
            value={ticket.assignedOperatorId ?? ''}
            onChange={async (e) => {
              await api.assignTicket(ticket.id, e.target.value || null).catch(() => {})
              load()
            }}
            className="mb-4 w-full rounded-xl border border-line bg-canvas px-3 py-2 text-xs text-ink outline-none focus:border-alelo"
          >
            <option value="">— não atribuído —</option>
            {operators.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>

          {/* Tabs: 360 context vs audit history */}
          <div className="mb-3 flex gap-1 rounded-xl bg-canvas p-1">
            <button
              onClick={() => setPanelTab('context')}
              className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-semibold transition ${panelTab === 'context' ? 'bg-surface text-alelo shadow-sm' : 'text-ink-soft'}`}
            >
              Contexto
            </button>
            <button
              onClick={() => setPanelTab('history')}
              className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-semibold transition ${panelTab === 'history' ? 'bg-surface text-alelo shadow-sm' : 'text-ink-soft'}`}
            >
              Histórico
            </button>
          </div>

          {panelTab === 'context' ? (
            client ? (
              <ClientContext clientId={client.id} ticketId={ticket.id} onChange={load} reloadSignal={data.thread.length} />
            ) : (
              <p className="text-xs text-ink-soft">Sem cliente vinculado.</p>
            )
          ) : (
            <ol className="space-y-3 border-l border-line pl-3">
              {events.map((ev) => (
                <li key={ev.id} className="relative text-xs text-ink-soft">
                  <span className="absolute -left-[1.18rem] top-1 h-2 w-2 rounded-full bg-alelo" />
                  <span className="font-semibold text-ink">{eventLabel(ev.type)}</span>
                  {ev.fromStatus && ev.toStatus ? ` ${ev.fromStatus}→${ev.toStatus}` : ''}
                  <span className="block text-[10px] text-ink-soft/70">
                    {ev.actor} · {new Date(ev.createdAt).toLocaleString('pt-BR')}
                  </span>
                  {ev.note && <span className="block text-ink-soft">{ev.note}</span>}
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  )
}

function bubble(role: string): string {
  switch (role) {
    case 'client':
      return 'bg-surface text-ink border border-line'
    case 'operator':
      return 'bg-alelo text-white'
    case 'bot':
      return 'bg-alelo-mint text-alelo-dark'
    default:
      return 'bg-neutral-100 text-ink-soft'
  }
}
function roleLabel(role: string): string {
  return { client: 'Cliente', bot: 'Alê', operator: 'Operador', system: 'Sistema' }[role] ?? role
}
function eventLabel(type: string): string {
  return (
    {
      created: 'Criado',
      status_change: 'Status',
      reopened: 'Reaberto',
      assigned: 'Atribuído',
      note: 'Nota',
    }[type] ?? type
  )
}
