import { EventEmitter } from 'node:events'

/**
 * Process-wide event bus. The Fastify WebSocket layer subscribes and forwards
 * events to connected Alelo operators so the inbox updates live.
 */
export type RealtimeEvent =
  | { type: 'message'; conversationId: string; clientId: string; role: string; content: string; at: string }
  | { type: 'conversation.status'; conversationId: string; clientId: string; status: string }
  | { type: 'ticket.created'; ticketId: string; clientId: string; subject: string; priority: string }
  | { type: 'quote.created'; quoteId: string; clientId: string; monthlyTotal: number }

class RealtimeBus extends EventEmitter {
  constructor() {
    super()
    // Each operator WebSocket tab adds a listener; raise the cap so several
    // open tabs don't trip a false "memory leak" warning (unsub on close).
    this.setMaxListeners(100)
  }
  emitEvent(e: RealtimeEvent) {
    this.emit('event', e)
  }
  onEvent(fn: (e: RealtimeEvent) => void) {
    this.on('event', fn)
    return () => this.off('event', fn)
  }
}

export const bus = new RealtimeBus()
