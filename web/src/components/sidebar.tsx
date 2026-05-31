'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { api, type AuthUser } from '@/lib/api'
import { AleloLogo } from './logo'
import { IconUsers, IconChat, IconClose } from './icons'

const NAV = [
  { href: '/', label: 'Dashboard', icon: DashboardIcon },
  { href: '/inbox', label: 'Inbox', icon: IconChat },
  { href: '/carteiras', label: 'Carteiras', icon: IconUsers },
]

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const path = usePathname()
  const router = useRouter()
  const [me, setMe] = useState<AuthUser | null>(null)

  useEffect(() => {
    api.me().then(setMe).catch(() => {})
  }, [])

  const logout = async () => {
    await api.logout().catch(() => {})
    router.replace('/login')
  }

  const initials = (me?.name ?? 'A')
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col bg-alelo text-white">
      <div className="relative flex items-center justify-center">
        <AleloLogo size={80} />
        {onNavigate && (
          <button
            onClick={onNavigate}
            className="absolute right-3 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-white/80 hover:bg-white/10 lg:hidden"
          >
            <IconClose />
          </button>
        )}
      </div>

      <nav className="flex-1 space-y-1 px-3">
        {NAV.map((item) => {
          const active = item.href === '/' ? path === '/' : path.startsWith(item.href)
          const Icon = item.icon
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition ${
                active ? 'bg-white text-alelo shadow-sm' : 'text-white/80 hover:bg-white/10 hover:text-white'
              }`}
            >
              <Icon className={active ? 'text-alelo' : 'text-alelo-lime'} />
              {item.label}
            </Link>
          )
        })}
        {me?.role === 'admin' && (
          <Link
            href="/settings"
            onClick={onNavigate}
            className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition ${
              path.startsWith('/settings')
                ? 'bg-white text-alelo shadow-sm'
                : 'text-white/80 hover:bg-white/10 hover:text-white'
            }`}
          >
            <GearIcon className={path.startsWith('/settings') ? 'text-alelo' : 'text-alelo-lime'} />
            Configurações
          </Link>
        )}
      </nav>

      <div className="border-t border-white/15 p-3">
        <div className="flex items-center gap-3 rounded-xl px-3 py-2">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-alelo-lime text-sm font-bold text-alelo-dark">
            {initials}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-white">{me?.name ?? '—'}</div>
            <div className="truncate text-xs text-white/70">
              {me?.role === 'admin' ? 'Administrador' : 'Operador'}
            </div>
          </div>
        </div>
        <button
          onClick={logout}
          className="mt-1 flex w-full items-center gap-2 rounded-xl border border-white/20 px-3 py-2 text-sm font-semibold text-white transition hover:bg-white/10"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M15 12H3m0 0 4-4m-4 4 4 4M21 3v18"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Sair
        </button>
      </div>
    </aside>
  )
}

function GearIcon({ className = '' }: { className?: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className={className}>
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2" />
      <path
        d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
function DashboardIcon({ className = '' }: { className?: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className={className}>
      <rect x="3" y="3" width="7" height="9" rx="2" fill="currentColor" />
      <rect x="14" y="3" width="7" height="5" rx="2" fill="currentColor" opacity="0.55" />
      <rect x="14" y="11" width="7" height="10" rx="2" fill="currentColor" />
      <rect x="3" y="15" width="7" height="6" rx="2" fill="currentColor" opacity="0.55" />
    </svg>
  )
}
