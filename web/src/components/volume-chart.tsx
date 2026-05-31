'use client'

import { ResponsiveBar } from '@nivo/bar'
import type { Dashboard } from '@/lib/types'

// Brand palette (kept out of the semantic/status palette on purpose).
const ALELO_GREEN = '#007858'
const HUMAN_INDIGO = '#818cf8'

/**
 * Stacked daily attendance chart (Alê vs Humano) rendered with Nivo.
 * `days` only affects the label thinning / bottom-axis density.
 */
export function VolumeChart({ volume, days }: { volume: Dashboard['volume']; days: number }) {
  // Map API rows → Nivo data. Keep the raw day for tooltips, derive a short label.
  const data = volume.map((v) => {
    const d = new Date(v.day + 'T12:00')
    const label =
      days <= 10
        ? d.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '')
        : d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
    return { day: v.day, label, Alê: v.ai, Humano: v.human }
  })

  // Thin out bottom labels on long ranges so they don't overlap.
  const step = Math.max(1, Math.ceil(data.length / 12))
  const tickLabels = new Set(data.filter((_, i) => i % step === 0 || i === data.length - 1).map((d) => d.label))

  if (!data.some((d) => d.Alê > 0 || d.Humano > 0)) {
    return (
      <div className="flex h-44 items-center justify-center text-xs text-ink-soft">
        Sem atendimentos no período.
      </div>
    )
  }

  return (
    <div className="h-44">
      <ResponsiveBar
        data={data}
        keys={['Alê', 'Humano']}
        indexBy="label"
        margin={{ top: 8, right: 4, bottom: 22, left: 28 }}
        padding={0.3}
        colors={[ALELO_GREEN, HUMAN_INDIGO]}
        borderRadius={4}
        enableLabel={false}
        enableGridY
        gridYValues={4}
        axisLeft={{ tickSize: 0, tickPadding: 6, tickValues: 4 }}
        axisBottom={{
          tickSize: 0,
          tickPadding: 8,
          format: (v) => (tickLabels.has(String(v)) ? v : ''),
        }}
        theme={{
          text: { fontSize: 10, fill: '#8a8f98' },
          grid: { line: { stroke: '#eceae6', strokeWidth: 1 } },
          tooltip: { container: { fontSize: 12, borderRadius: 8 } },
        }}
        tooltip={({ id, value, indexValue }) => (
          <div className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs shadow-sm">
            <span className="font-semibold text-ink">{indexValue}</span>
            <div className="mt-0.5 flex items-center gap-1.5 text-ink-soft">
              <span
                className="h-2 w-2 rounded-sm"
                style={{ background: id === 'Alê' ? ALELO_GREEN : HUMAN_INDIGO }}
              />
              {id}: <span className="font-semibold text-ink">{value}</span>
            </div>
          </div>
        )}
        animate
        motionConfig="gentle"
      />
    </div>
  )
}
