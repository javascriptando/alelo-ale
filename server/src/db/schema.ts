import { relations, sql } from 'drizzle-orm'
import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

// ── Enums ───────────────────────────────────────────────────
export const companySizeEnum = pgEnum('company_size', ['micro', 'small', 'medium', 'large'])
export const conversationStatusEnum = pgEnum('conversation_status', [
  'bot', // AI is handling
  'waiting_human', // escalated, awaiting operator
  'human', // operator took over
  'closed',
])
export const messageRoleEnum = pgEnum('message_role', ['client', 'bot', 'operator', 'system'])
export const ticketStatusEnum = pgEnum('ticket_status', ['open', 'pending', 'resolved', 'closed'])
export const ticketPriorityEnum = pgEnum('ticket_priority', ['low', 'medium', 'high', 'urgent'])
export const ticketCategoryEnum = pgEnum('ticket_category', [
  'suporte', // generic support
  'financeiro', // billing / payments
  'cartao', // card delivery / blocking
  'comercial', // pricing / contract questions
  'reclamacao', // complaint
  'outro',
])
export const quoteStatusEnum = pgEnum('quote_status', [
  'draft',
  'sent',
  'accepted',
  'rejected',
  'expired',
])
export const contractStatusEnum = pgEnum('contract_status', [
  'created',
  'sent',
  'signed',
  'declined',
  'voided',
])
export const benefitTypeEnum = pgEnum('benefit_type', [
  'refeicao', // meal
  'alimentacao', // food
  'mobilidade', // mobility / transport
  'multibeneficios', // multi-benefit
])

const ts = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

// ── Operators (Alelo internal users) ────────────────────────
export const operators = pgTable('operators', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('operator'), // operator | admin | manager
  active: boolean('active').notNull().default(true),
  // Presence for fair auto-assignment: an operator counts as "online" if
  // lastSeenAt is within the presence window (see assignment-service.ts).
  // availability: online operators receive queue tickets; admins are excluded
  // from auto-assignment (god-mode view only).
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  available: boolean('available').notNull().default(true),
  ...ts(),
})

// ── Sessions (Lucia-pattern, self-hosted) ───────────────────
export const sessions = pgTable('sessions', {
  // id = sha256(token) hex; the raw token lives only in the client cookie
  id: text('id').primaryKey(),
  operatorId: uuid('operator_id')
    .notNull()
    .references(() => operators.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
})

// ── Clients (prospect / customer companies) ─────────────────
export const clients = pgTable('clients', {
  id: uuid('id').defaultRandom().primaryKey(),
  companyName: text('company_name').notNull(),
  cnpj: text('cnpj'),
  contactName: text('contact_name'),
  contactRole: text('contact_role'), // e.g. "RH"
  phone: text('phone').notNull().unique(), // WhatsApp JID number
  email: text('email'),
  size: companySizeEnum('size').default('small'),
  headcount: integer('headcount'),
  // portfolio assignment
  ownerOperatorId: uuid('owner_operator_id').references(() => operators.id),
  stage: text('stage').notNull().default('lead'), // lead | quoting | signing | active | churned
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  ...ts(),
})

// ── Conversations (one open thread per client) ──────────────
export const conversations = pgTable('conversations', {
  id: uuid('id').defaultRandom().primaryKey(),
  clientId: uuid('client_id')
    .notNull()
    .references(() => clients.id, { onDelete: 'cascade' }),
  status: conversationStatusEnum('status').notNull().default('bot'),
  assignedOperatorId: uuid('assigned_operator_id').references(() => operators.id),
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }).defaultNow(),
  summary: text('summary'), // rolling AI summary for context
  ...ts(),
})

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    // When a ticket is active, inbound/outbound messages are tagged to it so the
    // ticket UI can show its own thread while the conversation stays continuous.
    ticketId: uuid('ticket_id'),
    role: messageRoleEnum('role').notNull(),
    content: text('content').notNull(),
    waMessageId: text('wa_message_id'),
    toolName: text('tool_name'), // if this turn invoked a tool
    // Outbound delivery tracking: bot/operator messages get this set once the
    // message is confirmed sent over WhatsApp. NULL = pending (offline/failed),
    // so it is retried automatically the moment the connection comes back.
    // Inbound (client) messages are delivered on arrival → marked at insert.
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // Hard guarantee against duplicate inbound delivery (Evolution can resend
    // the same WA message id within milliseconds). Partial: bot/operator/system
    // messages have a null wa id and don't conflict.
    waMsgUnique: uniqueIndex('messages_wa_message_id_unique')
      .on(t.waMessageId)
      .where(sql`${t.waMessageId} is not null`),
  }),
)

// ── Beneficiaries (employees of the client company) ─────────
export const beneficiaries = pgTable('beneficiaries', {
  id: uuid('id').defaultRandom().primaryKey(),
  clientId: uuid('client_id')
    .notNull()
    .references(() => clients.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  cpf: text('cpf'),
  benefitType: benefitTypeEnum('benefit_type').notNull().default('refeicao'),
  monthlyValue: numeric('monthly_value', { precision: 12, scale: 2 }),
  active: boolean('active').notNull().default(true),
  ...ts(),
})

// ── Quotes (cotação) ────────────────────────────────────────
export const quotes = pgTable('quotes', {
  id: uuid('id').defaultRandom().primaryKey(),
  clientId: uuid('client_id')
    .notNull()
    .references(() => clients.id, { onDelete: 'cascade' }),
  status: quoteStatusEnum('status').notNull().default('draft'),
  headcount: integer('headcount').notNull(),
  // line items + totals computed by the pricing engine
  input: jsonb('input').$type<Record<string, unknown>>().notNull(),
  result: jsonb('result').$type<Record<string, unknown>>().notNull(),
  monthlyTotal: numeric('monthly_total', { precision: 14, scale: 2 }).notNull(),
  validUntil: timestamp('valid_until', { withTimezone: true }),
  ...ts(),
})

// ── Contracts (DocuSign) ────────────────────────────────────
export const contracts = pgTable('contracts', {
  id: uuid('id').defaultRandom().primaryKey(),
  clientId: uuid('client_id')
    .notNull()
    .references(() => clients.id, { onDelete: 'cascade' }),
  quoteId: uuid('quote_id').references(() => quotes.id),
  status: contractStatusEnum('status').notNull().default('created'),
  docusignEnvelopeId: text('docusign_envelope_id'),
  signingUrl: text('signing_url'),
  signedAt: timestamp('signed_at', { withTimezone: true }),
  ...ts(),
})

// ── PIX charges (Asaas) ─────────────────────────────────────
export const pixCharges = pgTable('pix_charges', {
  id: uuid('id').defaultRandom().primaryKey(),
  clientId: uuid('client_id')
    .notNull()
    .references(() => clients.id, { onDelete: 'cascade' }),
  asaasPaymentId: text('asaas_payment_id').notNull(),
  // set when the charge belongs to a recurring subscription
  subscriptionId: uuid('subscription_id'),
  status: text('status').notNull().default('PENDING'), // PENDING | RECEIVED | CONFIRMED | OVERDUE ...
  value: numeric('value', { precision: 14, scale: 2 }).notNull(),
  description: text('description'),
  copyPaste: text('copy_paste'), // PIX "copia e cola"
  invoiceUrl: text('invoice_url'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  ...ts(),
})

// ── Subscriptions (recurring billing via Asaas) ─────────────
export const subscriptions = pgTable('subscriptions', {
  id: uuid('id').defaultRandom().primaryKey(),
  clientId: uuid('client_id')
    .notNull()
    .references(() => clients.id, { onDelete: 'cascade' }),
  asaasSubscriptionId: text('asaas_subscription_id').notNull(),
  status: text('status').notNull().default('ACTIVE'), // ACTIVE | OVERDUE | INACTIVE | CANCELED
  value: numeric('value', { precision: 14, scale: 2 }).notNull(),
  cycle: text('cycle').notNull().default('MONTHLY'),
  description: text('description'),
  nextDueDate: timestamp('next_due_date', { withTimezone: true }),
  ...ts(),
})

// ── Tickets ─────────────────────────────────────────────────
export const tickets = pgTable('tickets', {
  id: uuid('id').defaultRandom().primaryKey(),
  clientId: uuid('client_id')
    .notNull()
    .references(() => clients.id, { onDelete: 'cascade' }),
  conversationId: uuid('conversation_id').references(() => conversations.id),
  assignedOperatorId: uuid('assigned_operator_id').references(() => operators.id),
  subject: text('subject').notNull(),
  status: ticketStatusEnum('status').notNull().default('open'),
  priority: ticketPriorityEnum('priority').notNull().default('medium'),
  category: ticketCategoryEnum('category').notNull().default('suporte'),
  reason: text('reason'), // why escalated
  summary: text('summary'), // AI-captured context of what the client wants (set before handing to human)
  handlingMode: text('handling_mode').notNull().default('ai'), // ai | queue | human
  // queuedAt: when it entered the human queue (for fair ordering / SLA)
  queuedAt: timestamp('queued_at', { withTimezone: true }),
  // Lifecycle timestamps + reopen tracking (see ticket-service.ts for the rules)
  firstResponseAt: timestamp('first_response_at', { withTimezone: true }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  // why it closed: 'manual' | 'resolved_idle' | 'inactivity'. Inactivity closes
  // are RESUMABLE within the resume window (see maybeResumeOnInbound).
  closeReason: text('close_reason'),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).defaultNow(),
  reopenCount: integer('reopen_count').notNull().default(0),
  ...ts(),
})

// ── Ticket events (audit trail of every transition) ─────────
export const ticketEvents = pgTable('ticket_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  ticketId: uuid('ticket_id')
    .notNull()
    .references(() => tickets.id, { onDelete: 'cascade' }),
  type: text('type').notNull(), // created | status_change | assigned | reopened | note | resolved | closed
  fromStatus: text('from_status'),
  toStatus: text('to_status'),
  actor: text('actor').notNull().default('system'), // system | ai | operator:<id> | client
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

// ── NPS surveys ─────────────────────────────────────────────
export const npsResponses = pgTable('nps_responses', {
  id: uuid('id').defaultRandom().primaryKey(),
  clientId: uuid('client_id')
    .notNull()
    .references(() => clients.id, { onDelete: 'cascade' }),
  ticketId: uuid('ticket_id').references(() => tickets.id),
  score: integer('score'), // 0-10, null until answered
  comment: text('comment'),
  sentAt: timestamp('sent_at', { withTimezone: true }).defaultNow(),
  answeredAt: timestamp('answered_at', { withTimezone: true }),
})

// ── Notifications / scheduled reminders (renewals etc.) ─────
export const notifications = pgTable('notifications', {
  id: uuid('id').defaultRandom().primaryKey(),
  clientId: uuid('client_id')
    .notNull()
    .references(() => clients.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(), // renewal | nps | quote_followup | custom
  payload: jsonb('payload').$type<Record<string, unknown>>().default({}),
  scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  ...ts(),
})

// ── Relations ───────────────────────────────────────────────
export const clientsRelations = relations(clients, ({ many, one }) => ({
  conversations: many(conversations),
  beneficiaries: many(beneficiaries),
  quotes: many(quotes),
  contracts: many(contracts),
  tickets: many(tickets),
  owner: one(operators, { fields: [clients.ownerOperatorId], references: [operators.id] }),
}))

export const conversationsRelations = relations(conversations, ({ many, one }) => ({
  client: one(clients, { fields: [conversations.clientId], references: [clients.id] }),
  messages: many(messages),
  operator: one(operators, {
    fields: [conversations.assignedOperatorId],
    references: [operators.id],
  }),
}))

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
}))

export type Client = typeof clients.$inferSelect
export type Conversation = typeof conversations.$inferSelect
export type Message = typeof messages.$inferSelect
export type Quote = typeof quotes.$inferSelect
export type Ticket = typeof tickets.$inferSelect
export type TicketEvent = typeof ticketEvents.$inferSelect
export type Operator = typeof operators.$inferSelect
export type Session = typeof sessions.$inferSelect
export type PixCharge = typeof pixCharges.$inferSelect
export type Subscription = typeof subscriptions.$inferSelect
