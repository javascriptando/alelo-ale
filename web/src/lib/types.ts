export type ConversationStatus = 'bot' | 'waiting_human' | 'human' | 'closed'

export interface Conversation {
  id: string
  status: ConversationStatus
  lastMessageAt: string | null
  assignedOperatorId: string | null
  clientId: string
  companyName: string
  phone: string
  stage: string
  ownerOperatorId: string | null
}

export interface Message {
  id: string
  conversationId: string
  ticketId?: string | null
  role: 'client' | 'bot' | 'operator' | 'system'
  content: string
  toolName: string | null
  /** Optional attachment, e.g. a PIX QR image rendered in the panel. */
  metadata?: { image?: string } | null
  createdAt: string
}

export type TicketStatus = 'open' | 'pending' | 'resolved' | 'closed'
export type TicketCategory =
  | 'suporte'
  | 'financeiro'
  | 'cartao'
  | 'comercial'
  | 'reclamacao'
  | 'outro'

export type HandlingMode = 'ai' | 'queue' | 'human'

export interface Ticket {
  id: string
  subject: string
  status: TicketStatus
  priority: 'low' | 'medium' | 'high' | 'urgent'
  category?: TicketCategory
  reason: string | null
  summary?: string | null
  handlingMode?: HandlingMode
  reopenCount?: number
  createdAt: string
  queuedAt?: string | null
  lastActivityAt?: string | null
  clientId: string
  companyName: string
  phone?: string
  conversationId: string | null
  assignedOperatorId: string | null
}

export interface TicketEvent {
  id: string
  ticketId: string
  type: string
  fromStatus: string | null
  toStatus: string | null
  actor: string
  note: string | null
  createdAt: string
}

export interface TicketDetail {
  ticket: Ticket & {
    firstResponseAt: string | null
    resolvedAt: string | null
    closedAt: string | null
  }
  client: Client | null
  thread: Message[]
  events: TicketEvent[]
}

export interface Suggestion {
  text: string
  tone: string
}

export interface Client {
  id: string
  companyName: string
  cnpj: string | null
  contactName: string | null
  email?: string | null
  phone: string
  stage: string
  size: string | null
  headcount: number | null
  ownerOperatorId: string | null
}

export interface Beneficiary {
  id: string
  name: string
  cpf: string | null
  benefitType: string
  monthlyValue: string | null
  active: boolean
}

export interface Quote {
  id: string
  status: string
  headcount: number
  monthlyTotal: string
  createdAt: string
}

export interface Contract {
  id: string
  status: string
  signingUrl: string | null
  signedAt: string | null
  createdAt: string
}

export interface Payment {
  id: string
  asaasPaymentId: string
  status: string
  value: string
  description: string | null
  paidAt: string | null
  expiresAt: string | null
  createdAt: string
}

export interface SubscriptionInfo {
  id: string
  status: string
  value: string
  cycle: string
  nextDueDate: string | null
  createdAt: string
}

export interface Client360 {
  client: Client
  quotes: Quote[]
  contracts: Contract[]
  tickets: Ticket[]
  beneficiaries: Beneficiary[]
  payments: Payment[]
  subscriptions: SubscriptionInfo[]
}

export interface Operator {
  id: string
  name: string
  email: string
  role: string
  active: boolean
}

export interface Stats {
  clients: number
  openTickets: number
  waitingHuman: number
  signedContracts: number
}

export interface Nps {
  nps: number | null
  total: number
  promoters: number
  detractors: number
}

export interface Dashboard {
  scope: 'admin' | 'operator'
  kpis: {
    clients: number
    openTickets: number
    pendingTickets: number
    resolvedTickets: number
    closedTickets: number
    withAI: number
    humanHandling: number
    mine: number
    queueDepth: number
    onlineOperators: number
    quotes: number
    quotesMonthlyTotal: number
    contractsSigned: number
    contractsPending: number
    beneficiaries: number
  }
  recent: {
    id: string
    subject: string
    status: string
    priority: string
    handlingMode: string
    lastActivityAt: string | null
    companyName: string
  }[]
  volume: { day: string; n: number; ai: number; human: number; client: number }[]
}

export type RealtimeEvent =
  | { type: 'message'; conversationId: string; clientId: string; role: string; content: string; at: string }
  | { type: 'conversation.status'; conversationId: string; clientId: string; status: string }
  | { type: 'ticket.created'; ticketId: string; clientId: string; subject: string; priority: string }
  | { type: 'quote.created'; quoteId: string; clientId: string; monthlyTotal: number }
