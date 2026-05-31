/**
 * Testa a autenticação JWT real da DocuSign e a geração de um envelope.
 * Rodar: npx tsx src/scripts/test-docusign.ts
 *
 * Se faltar consentimento, a DocuSign retorna 'consent_required' — o script
 * imprime a URL de consentimento para você abrir uma vez.
 */
import { env } from '../config/env.js'
import {
  getConsentUrl,
  isDocusignConfigured,
  sendContractForSignature,
} from '../integrations/docusign.js'

async function main() {
  console.log('Configurado?', isDocusignConfigured())
  console.log('Integration Key:', env.DOCUSIGN_INTEGRATION_KEY)
  console.log('User ID:', env.DOCUSIGN_USER_ID)
  console.log('Account ID:', env.DOCUSIGN_ACCOUNT_ID)
  console.log('OAuth base:', env.DOCUSIGN_OAUTH_BASE)
  console.log('API base:', env.DOCUSIGN_BASE_PATH)
  console.log('')

  if (!isDocusignConfigured()) {
    console.log('✗ Falta configuração (key/ids/arquivo). Abortando.')
    process.exit(1)
  }

  try {
    const res = await sendContractForSignature({
      signerName: 'Diego Ferreira',
      signerEmail: 'diegosierravibes@gmail.com',
      clientUserId: 'test-client-1',
      companyName: 'Empresa Teste DocuSign',
      monthlyTotal: 'R$ 3.450,00',
      headcount: 230,
      returnUrl: env.DOCUSIGN_SIGN_RETURN_URL,
    })
    console.log('✓ ENVELOPE CRIADO COM SUCESSO (DocuSign real)')
    console.log('  envelopeId:', res.envelopeId)
    console.log('  signingUrl:', res.signingUrl.slice(0, 90) + '…')
    console.log('\nPASS — DocuSign JWT funcionando ponta a ponta.')
    process.exit(0)
  } catch (err) {
    const msg = (err as Error).message || String(err)
    console.log('✗ ERRO:', msg)
    if (/consent_required|consent/i.test(msg)) {
      const redirect = `${env.DOCUSIGN_OAUTH_BASE}/oauth/auth` // info only
      void redirect
      console.log('\n⚠ CONSENTIMENTO NECESSÁRIO (passo único).')
      console.log('Abra esta URL no navegador, logado na sua conta DocuSign demo, e clique em ACEITAR:')
      console.log('\n' + getConsentUrl(`${env.PUBLIC_BASE_URL}/docusign/callback`))
      console.log('\nDepois rode este teste de novo.')
    }
    process.exit(2)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(3)
})
