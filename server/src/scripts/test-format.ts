import { toWhatsApp } from '../whatsapp/format.js'

const cases: [string, string][] = [
  ['**negrito**', '*negrito*'],
  ['Olá **Diego**, tudo bem?', 'Olá *Diego*, tudo bem?'],
  ['### Cotação', '*Cotação*'],
  ['- item um\n- item dois', '• item um\n• item dois'],
  ['veja [aqui](https://x.com/a)', 'veja aqui: https://x.com/a'],
  ['~~cancelado~~', '~cancelado~'],
  ['valor `R$ 600`', 'valor R$ 600'],
  ['**Total:** R$ 3.450,00', '*Total:* R$ 3.450,00'],
]

let pass = 0
for (const [input, expected] of cases) {
  const got = toWhatsApp(input)
  const ok = got === expected
  if (ok) pass++
  console.log(`${ok ? '✓' : '✗'} ${JSON.stringify(input)} -> ${JSON.stringify(got)}${ok ? '' : ` (esperado ${JSON.stringify(expected)})`}`)
}
console.log(`\n${pass}/${cases.length} ${pass === cases.length ? 'PASS' : 'FALHOU'}`)
process.exit(pass === cases.length ? 0 : 1)
