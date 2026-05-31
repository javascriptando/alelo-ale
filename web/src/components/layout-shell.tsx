'use client'

import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { Sidebar } from './sidebar'
import { AuthGate } from './auth-gate'
import { AleloLogo } from './logo'
import { IconMenu } from './icons'

/** Login renders bare; every other route gets the responsive shell. */
export function LayoutShell({ children }: { children: React.ReactNode }) {
  const path = usePathname()
  const [drawer, setDrawer] = useState(false)
  if (path === '/login') return <>{children}</>

  return (
    <div className="flex h-screen overflow-hidden bg-alelo">
      {/* Desktop sidebar */}
      <div className="hidden lg:flex">
        <Sidebar />
      </div>

      {/* Mobile drawer */}
      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setDrawer(false)} />
          <div className="absolute left-0 top-0 h-full">
            <Sidebar onNavigate={() => setDrawer(false)} />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col bg-canvas">
        {/* Mobile top bar */}
        <div className="flex items-center gap-3 border-b border-line bg-alelo px-4 py-3 lg:hidden">
          <button onClick={() => setDrawer(true)} className="rounded-lg p-1.5 text-white hover:bg-white/10">
            <IconMenu />
          </button>
          <AleloLogo size={40} />
        </div>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <AuthGate>{children}</AuthGate>
        </main>
      </div>
    </div>
  )
}
