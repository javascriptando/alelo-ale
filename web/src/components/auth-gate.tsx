'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'

/** Blocks rendering until a session is confirmed; redirects to /login on 401. */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const [state, setState] = useState<'loading' | 'ok' | 'no'>('loading')

  useEffect(() => {
    api
      .me()
      .then(() => setState('ok'))
      .catch(() => {
        setState('no')
        router.replace('/login')
      })
  }, [router])

  if (state === 'loading')
    return <div className="grid h-full place-items-center text-ink-soft">Carregando…</div>
  if (state === 'no') return null
  return <>{children}</>
}
