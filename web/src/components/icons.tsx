/** Lightweight inline SVG icon set (no emojis). Inherit color via currentColor. */
type P = { className?: string; size?: number }
const base = (size = 18) => ({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none' as const })

export const IconUsers = ({ className, size }: P) => (
  <svg {...base(size)} className={className}>
    <circle cx="9" cy="8" r="3.2" stroke="currentColor" strokeWidth="2" />
    <path d="M3.5 19a5.5 5.5 0 0 1 11 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <path d="M16 6a3 3 0 0 1 0 6m1.5 7a5 5 0 0 0-3-4.6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
)
export const IconClock = ({ className, size }: P) => (
  <svg {...base(size)} className={className}>
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
    <path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
export const IconBot = ({ className, size }: P) => (
  <svg {...base(size)} className={className}>
    <rect x="4" y="8" width="16" height="11" rx="3" stroke="currentColor" strokeWidth="2" />
    <path d="M12 4v4M8.5 13h.01M15.5 13h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <circle cx="12" cy="4" r="1.4" fill="currentColor" />
  </svg>
)
export const IconAgent = ({ className, size }: P) => (
  <svg {...base(size)} className={className}>
    <circle cx="12" cy="8" r="3.4" stroke="currentColor" strokeWidth="2" />
    <path d="M5 20a7 7 0 0 1 14 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
)
export const IconCheck = ({ className, size }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M5 12.5 10 17l9-10" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
export const IconDoc = ({ className, size }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M6 3h7l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    <path d="M13 3v5h5M8.5 13h7M8.5 16.5h7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
)
export const IconCard = ({ className, size }: P) => (
  <svg {...base(size)} className={className}>
    <rect x="3" y="6" width="18" height="12" rx="2.5" stroke="currentColor" strokeWidth="2" />
    <path d="M3 10h18" stroke="currentColor" strokeWidth="2" />
  </svg>
)
export const IconEye = ({ className, size }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2" />
  </svg>
)
export const IconSpark = ({ className, size }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
  </svg>
)
export const IconArrowRight = ({ className, size }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M5 12h14m-6-6 6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
export const IconMenu = ({ className, size }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
)
export const IconClose = ({ className, size }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
)
export const IconChat = ({ className, size }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-4 3v-3H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
  </svg>
)
export const IconBuilding = ({ className, size }: P) => (
  <svg {...base(size)} className={className}>
    <rect x="5" y="3" width="14" height="18" rx="1.5" stroke="currentColor" strokeWidth="2" />
    <path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
)
