/**
 * Mock-but-realistic Alelo benefit pricing engine.
 *
 * Pricing model (easy to swap for real Alelo tables later):
 *  - Each benefit has a suggested monthly face value per employee (configurable).
 *  - Alelo charges an administration fee (% over the loaded amount) that shrinks
 *    with volume (more employees -> better rate), reflecting B2B tiering.
 *  - A small fixed monthly platform fee applies, waived above a headcount tier.
 */

export type BenefitType = 'refeicao' | 'alimentacao' | 'mobilidade' | 'multibeneficios'

export interface BenefitLineInput {
  type: BenefitType
  /** monthly face value per employee in BRL; falls back to the suggested default */
  monthlyValuePerEmployee?: number
}

export interface QuoteInput {
  headcount: number
  benefits: BenefitLineInput[]
}

export interface QuoteLine {
  type: BenefitType
  monthlyValuePerEmployee: number
  employees: number
  loadedAmount: number // face value loaded onto cards
  adminFeeRate: number
  adminFee: number
}

export interface QuoteResult {
  headcount: number
  lines: QuoteLine[]
  loadedTotal: number
  adminFeeTotal: number
  platformFee: number
  monthlyTotal: number // what Alelo bills the company
  currency: 'BRL'
  notes: string[]
}

// Suggested default face values per employee (BRL/month).
const DEFAULT_FACE_VALUE: Record<BenefitType, number> = {
  refeicao: 600,
  alimentacao: 500,
  mobilidade: 250,
  multibeneficios: 800,
}

// Volume tiers -> admin fee rate over the loaded amount.
function adminFeeRate(headcount: number): number {
  if (headcount >= 1000) return 0.015
  if (headcount >= 500) return 0.02
  if (headcount >= 200) return 0.025
  if (headcount >= 50) return 0.03
  if (headcount >= 10) return 0.04
  return 0.05
}

function platformFee(headcount: number): number {
  return headcount >= 50 ? 0 : 49.9
}

export function calculateQuote(input: QuoteInput): QuoteResult {
  const headcount = Math.max(1, Math.floor(input.headcount))
  const rate = adminFeeRate(headcount)
  const notes: string[] = []

  const benefits = input.benefits.length
    ? input.benefits
    : [{ type: 'refeicao' as BenefitType }]

  const lines: QuoteLine[] = benefits.map((b) => {
    const value = b.monthlyValuePerEmployee ?? DEFAULT_FACE_VALUE[b.type]
    const loadedAmount = value * headcount
    const adminFee = loadedAmount * rate
    return {
      type: b.type,
      monthlyValuePerEmployee: value,
      employees: headcount,
      loadedAmount,
      adminFeeRate: rate,
      adminFee,
    }
  })

  const loadedTotal = lines.reduce((s, l) => s + l.loadedAmount, 0)
  const adminFeeTotal = lines.reduce((s, l) => s + l.adminFee, 0)
  const fee = platformFee(headcount)
  const monthlyTotal = adminFeeTotal + fee

  notes.push(`Taxa de administração de ${(rate * 100).toFixed(1)}% pela faixa de ${headcount} colaboradores.`)
  if (fee === 0) notes.push('Taxa de plataforma isenta acima de 50 colaboradores.')

  return {
    headcount,
    lines,
    loadedTotal: round(loadedTotal),
    adminFeeTotal: round(adminFeeTotal),
    platformFee: fee,
    monthlyTotal: round(monthlyTotal),
    currency: 'BRL',
    notes,
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

export const brl = (n: number) =>
  n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
