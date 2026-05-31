'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type AuthUser } from '@/lib/api'
import type { Message, Ticket } from '@/lib/types'
import { Badge, PageHeader } from '@/components/ui'
import { SuggestionsPanel } from '@/components/suggestions-panel'
import { ClientContext } from '@/components/client-context'
import { useRealtime } from '@/hooks/use-realtime'
import { IconEye } from '@/components/icons'

type Tab = 'ai' | 'human'

export default function InboxPage() {
  const [me, setMe] = useState<AuthUser | null>(null)
  const [tab, setTab] = useState<Tab>('human')
  const [aiTickets, setAiTickets] = useState<Ticket[]>([])
  const [humanTickets, setHumanTickets] = useState<Ticket[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [active, setActive] = useState<Ticket | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [panelOpen, setPanelOpen] = useState(true)
  const [clientReload, setClientReload] = useState(0)
  const bottomRef = useRef<HTMLDivElement>(null)

  const isAdmin = me?.role === 'admin'

  const loadLists = useCallback(() => {
    const scope = isAdmin ? 'all' : undefined
    api.tickets({ mode: 'ai', scope }).then(setAiTickets).catch(() => {})
    api.tickets({ mode: 'human', scope }).then(setHumanTickets).catch(() => {})
  }, [isAdmin])

  const loadThread = useCallback((t: Ticket) => {
    setActive(t)
    if (t.conversationId) api.messages(t.conversationId).then(setMessages).catch(() => setMessages([]))
  }, [])

  useEffect(() => {
    api.me().then(setMe).catch(() => {})
  }, [])
  useEffect(() => loadLists(), [loadLists])
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useRealtime((e) => {
    loadLists()
    if ((e.type === 'message' || e.type === 'conversation.status') && active?.conversationId === e.conversationId) {
      if (active.conversationId) api.messages(active.conversationId).then(setMessages).catch(() => {})
    }
    // Live-refresh the client side panel (associados, pagamentos, cotações…)
    // whenever anything happens for the open client.
    const cid = (e as { clientId?: string }).clientId
    if (cid && cid === active?.clientId) setClientReload((n) => n + 1)
  })

  const list = tab === 'ai' ? aiTickets : humanTickets
  const selected = useMemo(() => list.find((t) => t.id === activeId) ?? active, [list, activeId, active])

  const open = (t: Ticket) => {
    setActiveId(t.id)
    loadThread(t)
  }
  const back = () => {
    setActiveId(null)
    setActive(null)
  }
  const take = async () => {
    if (!selected) return
    await api.takeTicket(selected.id).catch(() => {})
    loadLists()
    const fresh = await api.ticket(selected.id).then((d) => d.ticket).catch(() => null)
    if (fresh) setActive({ ...(selected as Ticket), ...(fresh as unknown as Ticket) })
  }
  const returnToAI = async () => {
    if (!selected) return
    await api.returnTicketToAI(selected.id).catch(() => {})
    loadLists()
  }
  const finish = async () => {
    if (!selected) return
    await api.transitionTicket(selected.id, 'closed').catch(() => {})
    loadLists()
    back()
    setMessages([])
  }
  const send = async () => {
    if (!selected?.conversationId || !draft.trim()) return
    setSending(true)
    try {
      await api.reply(selected.conversationId, draft.trim())
      setDraft('')
      api.messages(selected.conversationId).then(setMessages).catch(() => {})
      loadLists()
    } finally {
      setSending(false)
    }
  }

  const mineCount = humanTickets.filter((t) => t.assignedOperatorId === me?.id).length

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Inbox" subtitle="Conversas com a Alê e fila de atendimento">
        {isAdmin && (
          <span className="flex items-center gap-1.5 rounded-full bg-alelo-lime-soft px-3 py-1 text-xs font-semibold text-alelo-dark">
            <IconEye size={14} /> god mode
          </span>
        )}
      </PageHeader>

      <div className="flex min-h-0 flex-1">
        {/* List column — hidden on mobile when a conversation is open */}
        <div
          className={`${selected ? 'hidden md:flex' : 'flex'} w-full shrink-0 flex-col border-r border-line bg-surface md:w-80`}
        >
          <div className="flex gap-1 p-2">
            <button
              onClick={() => setTab('human')}
              className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition ${tab === 'human' ? 'bg-alelo-mint text-alelo' : 'text-ink-soft hover:bg-canvas'}`}
            >
              Atendimento{humanTickets.length ? ` (${humanTickets.length})` : ''}
            </button>
            <button
              onClick={() => setTab('ai')}
              className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition ${tab === 'ai' ? 'bg-alelo-mint text-alelo' : 'text-ink-soft hover:bg-canvas'}`}
            >
              Com a Alê{aiTickets.length ? ` (${aiTickets.length})` : ''}
            </button>
          </div>
          {tab === 'human' && !isAdmin && (
            <div className="px-4 py-1 text-[11px] text-ink-soft">{mineCount} atribuído(s) a você</div>
          )}
          <div className="flex-1 overflow-y-auto">
            {list.length === 0 && (
              <p className="p-6 text-sm text-ink-soft">{tab === 'ai' ? 'Nenhuma conversa com a Alê.' : 'Fila vazia.'}</p>
            )}
            {list.map((t) => {
              const mine = t.assignedOperatorId === me?.id
              const unassigned = t.handlingMode === 'human' && !t.assignedOperatorId
              return (
                <button
                  key={t.id}
                  onClick={() => open(t)}
                  className={`flex w-full flex-col gap-1 border-b border-line px-4 py-3 text-left transition ${
                    t.id === activeId ? 'bg-alelo-mint/50' : 'hover:bg-canvas'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-semibold text-ink">{t.companyName}</span>
                    <Badge value={t.priority} />
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-ink-soft">
                    <span>{t.phone}</span>
                    {mine && <span className="font-semibold text-alelo">• você</span>}
                    {unassigned && <span className="font-semibold text-amber-600">• na fila</span>}
                  </div>
                  {t.summary && <div className="truncate text-xs text-ink-soft">{t.summary}</div>}
                </button>
              )
            })}
          </div>
        </div>

        {/* Thread — full width on mobile when open */}
        <div className={`${selected ? 'flex' : 'hidden md:flex'} chat-pattern min-w-0 flex-1 flex-col bg-canvas`}>
          {!selected ? (
            <div className="grid flex-1 place-items-center text-ink-soft">Selecione uma conversa</div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2 border-b border-line bg-surface px-4 py-3 sm:px-6">
                <div className="flex min-w-0 items-center gap-2">
                  <button onClick={back} className="rounded-lg p-1 text-ink-soft hover:bg-canvas md:hidden">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                      <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                  <div className="min-w-0">
                    <div className="truncate font-semibold text-ink">{selected.companyName}</div>
                    <div className="text-xs text-ink-soft">
                      {selected.phone} · {selected.handlingMode === 'ai' ? 'Atendido pela Alê' : 'Atendimento humano'}
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {/* Toggle client panel (desktop) */}
                  <button
                    onClick={() => setPanelOpen((v) => !v)}
                    className="hidden rounded-xl border border-line bg-surface px-3 py-2 text-xs font-semibold text-ink transition hover:bg-canvas xl:block"
                    title="Mostrar/ocultar dados do cliente"
                  >
                    {panelOpen ? 'Ocultar dados' : 'Dados do cliente'}
                  </button>
                  <Badge value={selected.status} />
                  {selected.handlingMode === 'ai' ? (
                    <button
                      onClick={take}
                      className="rounded-xl bg-alelo px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-alelo-dark"
                    >
                      Assumir
                    </button>
                  ) : (
                    <>
                      <button
                        onClick={returnToAI}
                        className="hidden rounded-xl border border-line bg-surface px-3 py-2 text-xs font-semibold text-ink transition hover:bg-canvas sm:block"
                      >
                        Devolver para Alê
                      </button>
                      <button
                        onClick={finish}
                        className="rounded-xl border border-line bg-surface px-3 py-2 text-xs font-semibold text-ink transition hover:bg-canvas"
                      >
                        Finalizar
                      </button>
                    </>
                  )}
                </div>
              </div>

              {selected.summary && (
                <div className="border-b border-line bg-alelo-lime-soft/50 px-4 py-2 text-xs text-ink sm:px-6">
                  <span className="font-semibold text-alelo-dark">Resumo da Alê:</span> {selected.summary}
                </div>
              )}

              <div className="flex-1 space-y-3 overflow-y-auto p-4 sm:p-6">
                {messages.map((m) => (
                  <div key={m.id} className={`flex ${m.role === 'client' ? 'justify-start' : 'justify-end'}`}>
                    <div className={`max-w-[80%] rounded-2xl px-4 py-2 text-sm shadow-sm sm:max-w-[70%] ${bubble(m.role)}`}>
                      <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide opacity-70">
                        {roleLabel(m.role)}
                        {m.toolName ? ` · ${m.toolName}` : ''}
                      </div>
                      {m.metadata?.image && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={m.metadata.image}
                          alt="anexo"
                          className="mb-1 max-h-56 w-auto rounded-lg border border-line bg-white p-1"
                        />
                      )}
                      {m.content && <div className="whitespace-pre-wrap break-words">{m.content}</div>}
                    </div>
                  </div>
                ))}
                <div ref={bottomRef} />
              </div>

              {selected.handlingMode !== 'ai' && selected.status !== 'closed' && (
                <SuggestionsPanel conversationId={selected.conversationId} onPick={(t) => setDraft(t)} />
              )}

              {selected.handlingMode === 'ai' ? (
                <div className="border-t border-line bg-surface p-4 text-center text-xs text-ink-soft">
                  A Alê está atendendo. Clique em <span className="font-semibold text-alelo">Assumir</span> para responder você mesmo.
                </div>
              ) : (
                <div className="border-t border-line bg-surface p-4">
                  <div className="flex gap-2">
                    <input
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && send()}
                      placeholder="Responder ao cliente…"
                      className="flex-1 rounded-xl border border-line bg-canvas px-4 py-2.5 text-sm text-ink outline-none transition focus:border-alelo focus:ring-2 focus:ring-alelo/20"
                    />
                    <button
                      onClick={send}
                      disabled={sending || !draft.trim()}
                      className="rounded-xl bg-alelo px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-alelo-dark disabled:opacity-40"
                    >
                      Enviar
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Client side panel — auto-fills as the AI captures the client's data
            mid-chat (cotações, contratos, pagamentos, associados, ações). */}
        {selected && panelOpen && (
          <aside className="hidden w-80 shrink-0 flex-col overflow-y-auto border-l border-line bg-surface p-4 xl:flex">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-soft">Dados do cliente</h3>
            <ClientContext
              clientId={selected.clientId}
              ticketId={selected.id}
              onChange={loadLists}
              reloadSignal={clientReload}
            />
          </aside>
        )}
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
