'use client'

import { useEffect, useRef } from 'react'
import type { RealtimeEvent } from '@/lib/types'

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:3333/ws'

/** Subscribes to the backend realtime bus; calls `onEvent` for each event. */
export function useRealtime(onEvent: (e: RealtimeEvent) => void) {
  const handlerRef = useRef(onEvent)
  handlerRef.current = onEvent

  useEffect(() => {
    let ws: WebSocket | null = null
    let retry: ReturnType<typeof setTimeout> | undefined
    let disposed = false

    const closeSocket = () => {
      if (!ws) return
      // Closing a socket still in CONNECTING logs "closed before established".
      // Wait until it's OPEN, otherwise close it from its own open handler.
      if (ws.readyState === WebSocket.OPEN) {
        ws.close()
      } else if (ws.readyState === WebSocket.CONNECTING) {
        ws.addEventListener('open', () => ws?.close(), { once: true })
      }
      ws = null
    }

    const connect = () => {
      if (disposed) return
      const sock = new WebSocket(WS_URL)
      ws = sock
      sock.onmessage = (ev) => {
        try {
          handlerRef.current(JSON.parse(ev.data) as RealtimeEvent)
        } catch {
          /* ignore malformed */
        }
      }
      sock.onclose = () => {
        if (!disposed) retry = setTimeout(connect, 2000)
      }
    }
    connect()

    return () => {
      disposed = true
      if (retry) clearTimeout(retry)
      closeSocket()
    }
  }, [])
}
