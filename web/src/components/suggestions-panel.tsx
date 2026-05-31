'use client'

import { useState } from 'react'
import { api } from '@/lib/api'
import type { Suggestion } from '@/lib/types'
import { IconSpark } from './icons'

/**
 * AI copilot panel: fetches suggested replies for the operator and lets them
 * insert one into the reply box (via onPick). Read-only — never sends.
 */
export function SuggestionsPanel({
  conversationId,
  onPick,
}: {
  conversationId: string | null
  onPick: (text: string) => void
}) {
  const [items, setItems] = useState<Suggestion[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)

  const load = async () => {
    if (!conversationId) return
    setLoading(true)
    setOpen(true)
    try {
      const r = await api.suggestions(conversationId)
      setItems(r.suggestions)
    } catch {
      setItems([])
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="border-t border-line bg-alelo-mint/40">
      <button
        onClick={load}
        disabled={!conversationId || loading}
        className="flex w-full items-center justify-between px-4 py-2.5 text-xs font-semibold text-alelo transition hover:bg-alelo-mint disabled:opacity-40"
      >
        <span className="flex items-center gap-1.5">
          <IconSpark size={15} /> Sugestões da Alê {loading ? '(gerando…)' : ''}
        </span>
        <span className="text-ink-soft">{open ? 'atualizar' : 'gerar'}</span>
      </button>
      {open && (
        <div className="space-y-2 px-4 pb-3">
          {!loading && items.length === 0 && <p className="text-xs text-ink-soft">Nenhuma sugestão no momento.</p>}
          {items.map((s, i) => (
            <button
              key={i}
              onClick={() => onPick(s.text)}
              className="block w-full rounded-xl border border-line bg-surface p-3 text-left text-sm text-ink shadow-sm transition hover:border-alelo"
            >
              <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-alelo">{s.tone}</span>
              {s.text}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
