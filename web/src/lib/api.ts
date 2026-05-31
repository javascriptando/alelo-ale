import type {
  Client,
  Client360,
  Conversation,
  Dashboard,
  Message,
  Nps,
  Operator,
  Stats,
  Suggestion,
  Ticket,
  TicketDetail,
} from './types'

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3333'

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { cache: 'no-store', credentials: 'include' })
  if (!res.ok) throw new Error(`${path} -> ${res.status}`)
  return res.json() as Promise<T>
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${path} -> ${res.status}`)
  return res.json() as Promise<T>
}

export interface AuthUser {
  id: string
  name: string
  email: string
  role: string
}

export const api = {
  login: (email: string, password: string) =>
    post<AuthUser>('/api/auth/login', { email, password }),
  logout: () => post('/api/auth/logout', {}),
  me: () => get<AuthUser>('/api/auth/me'),
  stats: () => get<Stats>('/api/stats'),
  dashboard: () => get<Dashboard>('/api/dashboard'),
  nps: () => get<Nps>('/api/nps'),
  conversations: () => get<Conversation[]>('/api/conversations'),
  messages: (id: string) => get<Message[]>(`/api/conversations/${id}/messages`),
  reply: (id: string, text: string) => post(`/api/conversations/${id}/reply`, { text }),
  setStatus: (id: string, status: string, operatorId?: string) =>
    post(`/api/conversations/${id}/status`, { status, operatorId }),
  tickets: (params?: { status?: string; mode?: string; scope?: string }) => {
    const qs = new URLSearchParams()
    if (params?.status) qs.set('status', params.status)
    if (params?.mode) qs.set('mode', params.mode)
    if (params?.scope) qs.set('scope', params.scope)
    const s = qs.toString()
    return get<Ticket[]>(`/api/tickets${s ? `?${s}` : ''}`)
  },
  ticket: (id: string) => get<TicketDetail>(`/api/tickets/${id}`),
  updateTicket: (id: string, patch: Record<string, unknown>) => post(`/api/tickets/${id}`, patch),
  transitionTicket: (id: string, to: string, note?: string) =>
    post(`/api/tickets/${id}/transition`, { to, note }),
  assignTicket: (id: string, operatorId: string | null) =>
    post(`/api/tickets/${id}/assign`, { operatorId }),
  takeTicket: (id: string) => post(`/api/tickets/${id}/take`, {}),
  returnTicketToAI: (id: string) => post(`/api/tickets/${id}/return-to-ai`, {}),
  ticketNote: (id: string, note: string) => post(`/api/tickets/${id}/note`, { note }),
  suggestions: (conversationId: string) =>
    get<{ suggestions: Suggestion[] }>(`/api/conversations/${conversationId}/suggestions`),
  clients: () => get<Client[]>('/api/clients'),
  client: (id: string) => get<Client360>(`/api/clients/${id}`),
  assignClient: (id: string, operatorId: string | null) =>
    post(`/api/clients/${id}/assign`, { operatorId }),
  clientAction: (id: string, tool: string, args: Record<string, unknown>) =>
    post<{ ok: boolean; message: string; data?: unknown }>(`/api/clients/${id}/action`, { tool, args }),
  operators: () => get<Operator[]>('/api/operators'),
  whatsappStatus: () =>
    get<{ ready: boolean; qr: string | null; canManage: boolean }>('/api/whatsapp/status'),
  reconnectWhatsapp: () =>
    post<{ ok: boolean; ready: boolean; qr: string | null }>('/api/whatsapp/reconnect', {}),
  disconnectWhatsapp: () =>
    post<{ ok: boolean; ready: boolean; qr: string | null }>('/api/whatsapp/disconnect', {}),
  whatsappProfile: () =>
    get<{ name: string; about: string; pictureUrl?: string }>('/api/whatsapp/profile'),
  saveWhatsappProfile: (p: { name: string; about: string; pictureUrl?: string }) =>
    post<{ ok: boolean; profile: { name: string; about: string; pictureUrl?: string } }>(
      '/api/whatsapp/profile',
      p,
    ),
}
