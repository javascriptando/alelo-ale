/* eslint-disable @next/next/no-img-element */
/**
 * Official Alelo logo (full brand colors) from /public/alelo-logo.svg.
 * `size` is the HEIGHT in px; the width scales automatically to preserve the
 * logo's aspect ratio (it's ~1.58:1, so forcing a square would distort it).
 * The `variant` prop is kept only for call-site compatibility (no tint).
 */
export function AleloLogo({ size = 80 }: { size?: number; variant?: 'color' | 'white' }) {
  return <img src="/alelo-logo.svg" alt="Alelo" style={{ height: size, width: 'auto' }} />
}
