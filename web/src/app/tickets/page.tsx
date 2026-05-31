'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

// Tickets were merged into the Inbox — every conversation is a ticket handled
// there. This route just redirects for any old bookmark.
export default function TicketsRedirect() {
  const router = useRouter()
  useEffect(() => {
    router.replace('/inbox')
  }, [router])
  return <div className="p-8 text-ink-soft">Redirecionando para a Inbox…</div>
}
