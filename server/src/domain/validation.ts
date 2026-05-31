/**
 * CNPJ validation (Receita Federal check digits) + normalization helpers.
 * Kept dependency-free so it can be used in tools, HTTP handlers and tests.
 */

/** Strips everything that isn't a digit. */
export function onlyDigits(value: string): string {
  return (value ?? '').replace(/\D/g, '')
}

/** Formats 14 digits as 00.000.000/0000-00 (returns input untouched if not 14). */
export function formatCNPJ(value: string): string {
  const d = onlyDigits(value)
  if (d.length !== 14) return value
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`
}

/**
 * Validates a Brazilian CNPJ by its two check digits. Accepts formatted or raw
 * input. Rejects wrong length and all-equal-digit sequences (e.g. 00000000000000).
 */
export function isValidCNPJ(value: string): boolean {
  const cnpj = onlyDigits(value)
  if (cnpj.length !== 14) return false
  if (/^(\d)\1{13}$/.test(cnpj)) return false

  const calcDigit = (base: string): number => {
    // Weights run 5..2 then 9..2 (length-dependent), per Receita Federal spec.
    let weight = base.length - 7
    let sum = 0
    for (let i = 0; i < base.length; i++) {
      sum += Number(base[i]) * weight
      weight = weight === 2 ? 9 : weight - 1
    }
    const mod = sum % 11
    return mod < 2 ? 0 : 11 - mod
  }

  const d1 = calcDigit(cnpj.slice(0, 12))
  const d2 = calcDigit(cnpj.slice(0, 12) + d1)
  return cnpj.endsWith(`${d1}${d2}`)
}
