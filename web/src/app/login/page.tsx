'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import { AleloLogo } from '@/components/logo'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('admin@alelo.com')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      await api.login(email, password)
      router.replace('/')
    } catch {
      setError('Credenciais inválidas')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="grid h-screen grid-cols-1 lg:grid-cols-2">
      {/* Brand hero */}
      <div className="alelo-gradient relative hidden flex-col overflow-hidden p-12 lg:flex">
        <AleloLogo size={80} />
        <div className="relative z-10 flex flex-1 flex-col items-center justify-center text-center">
          <h2 className="max-w-md text-4xl font-bold leading-tight text-white">
            Benefícios resolvidos no WhatsApp, do orçamento à assinatura.
          </h2>
          <p className="mt-4 max-w-md text-white/85">
            A Alê atende, cota e contrata. Você assume quando precisa. Tudo num só lugar.
          </p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/login-hero.png" alt="" className="mt-8 w-full max-w-md rounded-2xl" />
        </div>
        {/* decorative rings */}
        <div className="pointer-events-none absolute -right-24 -top-24 h-80 w-80 rounded-full border-[24px] border-white/10" />
        <div className="pointer-events-none absolute -bottom-32 -right-10 h-96 w-96 rounded-full border-[28px] border-alelo-lime/30" />
      </div>

      {/* Form */}
      <div className="grid place-items-center bg-canvas px-6">
        <form onSubmit={submit} className="w-full max-w-sm">
          <div className="mb-8 lg:hidden">
            <AleloLogo size={56} />
          </div>
          <h1 className="text-2xl font-bold text-ink">Entrar</h1>
          <p className="mb-8 mt-1 text-sm text-ink-soft">Acesse o painel de operação</p>

          <label className="mb-1.5 block text-xs font-semibold text-ink-soft">E-mail</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mb-4 w-full rounded-xl border border-line bg-surface px-4 py-3 text-sm text-ink outline-none transition focus:border-alelo focus:ring-2 focus:ring-alelo/20"
            required
          />
          <label className="mb-1.5 block text-xs font-semibold text-ink-soft">Senha</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mb-5 w-full rounded-xl border border-line bg-surface px-4 py-3 text-sm text-ink outline-none transition focus:border-alelo focus:ring-2 focus:ring-alelo/20"
            required
          />
          {error && (
            <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>
          )}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-xl bg-alelo py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-alelo-dark disabled:opacity-50"
          >
            {loading ? 'Entrando…' : 'Entrar'}
          </button>
        </form>
      </div>
    </div>
  )
}
