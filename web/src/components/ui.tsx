import type { ReactNode } from 'react'

export function StatCard({
  label,
  value,
  hint,
  accent,
}: {
  label: string
  value: ReactNode
  hint?: string
  accent?: 'green' | 'lime' | 'amber' | 'plain'
}) {
  const bar =
    accent === 'lime'
      ? 'bg-alelo-lime'
      : accent === 'amber'
        ? 'bg-amber-400'
        : accent === 'plain'
          ? 'bg-line'
          : 'bg-alelo'
  return (
    <div className="relative overflow-hidden rounded-2xl border border-line bg-surface p-5 shadow-sm">
      <span className={`absolute inset-x-0 top-0 h-1 ${bar}`} />
      <div className="text-sm text-ink-soft">{label}</div>
      <div className="mt-2 text-3xl font-bold text-ink">{value}</div>
      {hint && <div className="mt-1 text-xs text-ink-soft">{hint}</div>}
    </div>
  )
}

// Semantic palette (light theme). Rule of thumb:
//  • Brand GREEN = identity/positive only (Alê, resolvido, comercial).
//  • Status uses ONE conventional color each, no overlap:
//      aberto → azul (em andamento) · pendente/aguardando → âmbar (espera)
//      resolvido → verde · fechado → cinza.
//  • Priority escalates: baixa cinza · média slate · alta laranja · urgente vermelho.
//  • Alertas (vermelho) reservados para urgente/reclamação.
const STATUS_STYLES: Record<string, string> = {
  // conversation handling
  bot: 'bg-alelo-mint text-alelo-dark',
  waiting_human: 'bg-amber-100 text-amber-700',
  human: 'bg-indigo-100 text-indigo-700',
  // ticket status
  open: 'bg-sky-100 text-sky-700',
  pending: 'bg-amber-100 text-amber-700',
  resolved: 'bg-alelo-mint text-alelo-dark',
  closed: 'bg-neutral-100 text-neutral-500',
  // priority
  low: 'bg-neutral-100 text-neutral-500',
  medium: 'bg-slate-100 text-slate-600',
  high: 'bg-orange-100 text-orange-700',
  urgent: 'bg-red-100 text-red-700',
  // ticket categories (neutral/cool — never brand-yellow)
  suporte: 'bg-sky-100 text-sky-700',
  financeiro: 'bg-indigo-100 text-indigo-700',
  cartao: 'bg-cyan-100 text-cyan-700',
  comercial: 'bg-alelo-mint text-alelo-dark',
  reclamacao: 'bg-red-100 text-red-700',
  outro: 'bg-neutral-100 text-neutral-500',
}

const STATUS_LABELS: Record<string, string> = {
  bot: 'Alê',
  waiting_human: 'Aguardando',
  human: 'Humano',
  closed: 'Fechado',
  open: 'Aberto',
  pending: 'Pendente',
  resolved: 'Resolvido',
  urgent: 'Urgente',
  high: 'Alta',
  medium: 'Média',
  low: 'Baixa',
  suporte: 'Suporte',
  financeiro: 'Financeiro',
  cartao: 'Cartão',
  comercial: 'Comercial',
  reclamacao: 'Reclamação',
  outro: 'Outro',
}

/**
 * Short, stable, hash-like reference for a ticket — derived from its UUID, like
 * a wallet address shorthand. e.g. "#A1B2C3D4". Deterministic (same ticket →
 * same ref), no DB change needed.
 */
export function ticketRef(id: string): string {
  return '#' + id.replace(/-/g, '').slice(0, 8).toUpperCase()
}

export function Badge({ value }: { value: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
        STATUS_STYLES[value] ?? 'bg-neutral-100 text-neutral-600'
      }`}
    >
      {STATUS_LABELS[value] ?? value}
    </span>
  )
}

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
  return (
    <div className="relative flex items-center justify-between overflow-hidden border-b border-line bg-surface px-8 py-5">
      {/* brand accent strip on the left edge */}
      <span className="absolute inset-y-0 left-0 w-1.5 alelo-gradient" />
      <div>
        <h1 className="text-xl font-bold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-ink-soft">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-3">{children}</div>
    </div>
  )
}

/** Primary brand button. */
export function Button({
  children,
  variant = 'primary',
  className = '',
  ...props
}: {
  children: ReactNode
  variant?: 'primary' | 'ghost' | 'outline'
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const styles =
    variant === 'primary'
      ? 'bg-alelo text-white hover:bg-alelo-dark shadow-sm'
      : variant === 'outline'
        ? 'border border-line bg-surface text-ink hover:bg-canvas'
        : 'text-ink-soft hover:bg-canvas'
  return (
    <button
      className={`rounded-xl px-4 py-2 text-sm font-semibold transition disabled:opacity-40 ${styles} ${className}`}
      {...props}
    >
      {children}
    </button>
  )
}
