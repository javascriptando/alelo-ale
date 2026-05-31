'use client'

import type { Nps } from '@/lib/types'
import { IconSpark } from '@/components/icons'

/**
 * NPS card for the dashboard. Shows the overall score (-100..100), a
 * promoter/passive/detractor split with a segmented bar and counts, and a clean
 * empty state when there are no responses yet (so it never looks broken).
 */
export function NpsCard({ nps }: { nps: Nps | null }) {
  const total = nps?.total ?? 0
  const promoters = nps?.promoters ?? 0
  const detractors = nps?.detractors ?? 0
  const passives = Math.max(0, total - promoters - detractors)
  const score = nps?.nps ?? null
  const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0)

  const scoreColor =
    score === null
      ? 'text-ink-soft'
      : score >= 50
        ? 'text-alelo'
        : score >= 0
          ? 'text-amber-600'
          : 'text-red-600'
  const scoreTag = score === null ? '' : score >= 50 ? 'Excelente' : score >= 0 ? 'Razoável' : 'Crítico'

  return (
    <div className="flex flex-col rounded-2xl border border-line bg-surface p-6 shadow-sm">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">NPS · Satisfação</h2>
        <span className="text-xs text-ink-soft">
          {total} {total === 1 ? 'resposta' : 'respostas'}
        </span>
      </div>

      {total === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1.5 py-6 text-center">
          <span className="grid h-12 w-12 place-items-center rounded-full bg-alelo-mint text-alelo">
            <IconSpark />
          </span>
          <p className="text-sm font-medium text-ink">Ainda sem respostas</p>
          <p className="max-w-[15rem] text-xs text-ink-soft">
            As avaliações dos clientes aparecem aqui após os atendimentos resolvidos.
          </p>
        </div>
      ) : (
        <>
          <div className="mb-4 mt-1 flex items-end gap-2">
            <span className={`text-5xl font-extrabold leading-none ${scoreColor}`}>{score}</span>
            <span className="pb-1.5 text-xs font-semibold text-ink-soft">{scoreTag}</span>
          </div>

          {/* Distribution bar */}
          <div className="mb-3 flex h-3 w-full overflow-hidden rounded-full bg-canvas">
            {promoters > 0 && <div className="h-full bg-alelo" style={{ width: `${pct(promoters)}%` }} />}
            {passives > 0 && <div className="h-full bg-alelo-lime" style={{ width: `${pct(passives)}%` }} />}
            {detractors > 0 && <div className="h-full bg-red-400" style={{ width: `${pct(detractors)}%` }} />}
          </div>

          <div className="grid grid-cols-3 gap-2 text-center text-xs">
            <Seg label="Promotores" value={promoters} dot="bg-alelo" />
            <Seg label="Neutros" value={passives} dot="bg-alelo-lime" />
            <Seg label="Detratores" value={detractors} dot="bg-red-400" />
          </div>
        </>
      )}
    </div>
  )
}

function Seg({ label, value, dot }: { label: string; value: number; dot: string }) {
  return (
    <div className="rounded-lg bg-canvas px-2 py-2">
      <div className="flex items-center justify-center gap-1.5">
        <span className={`h-2 w-2 rounded-full ${dot}`} />
        <span className="font-semibold text-ink">{value}</span>
      </div>
      <div className="mt-0.5 text-ink-soft">{label}</div>
    </div>
  )
}
