# Alelo — Plataforma de Benefícios via WhatsApp + Painel de Operação

Solução end-to-end onde o RH de uma empresa resolve **tudo pelo WhatsApp** (cotação,
assinatura DocuSign, gestão de conta, renovações, suporte) atendido por uma **IA**,
e a Alelo gerencia tudo por um **painel** com inbox ao vivo, takeover humano,
tickets, NPS e carteiras de clientes por operador.

## Arquitetura

```
WhatsApp (cliente RH)
      │  Baileys (QR)  ── interface WhatsAppGateway (troca p/ Cloud API depois)
      ▼
  Conversation Service  ──►  AI Agent (OpenAI, tool-calling)
      │                         ├─ calcular_cotacao   (pricing engine)
      │                         ├─ consultar_conta
      │                         ├─ iniciar_assinatura (DocuSign)
      │                         ├─ agendar_renovacao
      │                         └─ escalar_humano     (abre ticket)
      ▼
  PostgreSQL (Drizzle)  ◄──►  Fastify REST + WebSocket  ──►  Painel Alelo (Next.js)*
      ▲
  Scheduler (renovações / NPS / follow-up)
```
\* O painel (web) é a próxima fase; o backend já expõe toda a API e o realtime.

## Stack
- Node 22 + TypeScript (ESM), Fastify 5, WebSocket
- Baileys (WhatsApp QR), abstraído atrás de `WhatsAppGateway`
- OpenAI com **auto-detecção do melhor modelo** disponível na conta (runtime)
- Drizzle ORM + PostgreSQL
- Scheduler DB-backed (BullMQ/Redis já nas deps para escalar)

## Pré-requisitos
- Node 22+, PostgreSQL rodando, (Redis opcional p/ escalar filas)

## Como rodar (stack completa, verificada end-to-end)
Pré-requisito: Docker. Tudo usa portas deslocadas para não colidir com outros projetos.

```bash
# 1. Infra: Postgres (5435) + Redis (6380) + Evolution API (8080)
docker compose up -d
#    (o compose cria o DB 'evolution' e aponta o webhook para o backend no host)

# 2. Backend (porta 3333)
cd server
npm install
npm run db:push      # cria as tabelas
npm run db:seed      # cria operadores (admin@alelo.com / admin123)
npm run dev          # sobe API + WS; provisiona a instância na Evolution

# 3. Painel (porta 3000)
cd ../web
npm install
npm run dev          # http://localhost:3000  -> login admin@alelo.com / admin123
```

### Parear o WhatsApp
- Abra o **Dashboard** (após login) — o QR aparece no card "Conexão WhatsApp", ou
- Abra `http://localhost:3333/whatsapp/qr` no navegador.
- WhatsApp ▸ Aparelhos conectados ▸ escaneie. A partir daí, mensagens reais para o
  número pareado fluem: inbound → IA (cota / assina / escala) → resposta no WhatsApp.

### Status de verificação (testado end-to-end)
- `npx tsx src/scripts/test-agent.ts` — IA cota e persiste (gpt-5.2). **PASS**
- `npx tsx src/scripts/e2e-http.ts` — webhook → IA → cotação → API autenticada. **PASS**
- `npx tsx src/scripts/e2e-full.ts` — cotação + assinatura + ticket + escalada. **PASS**
- Login/guard de sessão, **QR da Evolution gerado** (PNG 348×348) e webhook configurado: **OK**

> **Importante (WhatsApp/Evolution):** use a imagem `evoapicloud/evolution-api:latest`
> (v2.3.7+). A v2.1.1 tem um bug de loop de reconexão que **impede a geração do QR**.
> Se um dia o QR parar de gerar (erro 515 / "requesting reconnect"), é o conhecido
> descompasso de versão do WhatsApp Web: fixe `CONFIG_SESSION_PHONE_VERSION` no
> compose com uma versão atual (veja releases do Baileys).

## Endpoints principais (painel)
- `GET  /health`
- `GET  /ws`                                   — eventos realtime do inbox
- `GET  /api/conversations`                    — lista de conversas
- `GET  /api/conversations/:id/messages`
- `POST /api/conversations/:id/reply`          — operador responde (takeover automático)
- `POST /api/conversations/:id/status`         — bot/waiting_human/human/closed
- `GET  /api/tickets` · `POST /api/tickets/:id`
- `GET  /api/clients` · `GET /api/clients/:id` · `POST /api/clients/:id/assign`
- `GET  /api/operators` · `GET /api/nps` · `GET /api/stats`

## Autenticação (operadores)
Padrão **Lucia self-hosted** (Lucia v3 foi descontinuado em mar/2025 e hoje é só
referência de implementação). Sessão = token aleatório em cookie `httpOnly`;
o banco guarda apenas o `sha256` do token. Senha com **argon2id**.
- Tudo sob `/api/` exige sessão, exceto `/api/auth/*`.
- Login seed: **admin@alelo.com / admin123** (rode `npm run db:seed`).
- Painel: `/login` + `AuthGate` (redireciona) + botão "Sair".

## DocuSign (JWT Grant — Service Integration)
Para o bot enviar envelopes sozinho, use **Service Integration + JWT**, NÃO o
"Authorization Code Grant". Na tela do app DocuSign:
1. **Authentication** → use **Service Integration** → **Generate RSA**. Cole a
   private key em `server/docusign_private.key`.
2. Copie a **Integration Key** (já no `.env`: `12c57d5f-...`), o **User ID** (API
   Username, na página do seu usuário admin) e o **Account ID** (API Account ID)
   para o `.env` (`DOCUSIGN_USER_ID`, `DOCUSIGN_ACCOUNT_ID`).
3. Consentimento único: abra `http://localhost:3333/docusign/consent` logado como
   o usuário da integração e aprove.
4. (Opcional) Configure **DocuSign Connect** apontando para
   `POST /webhook/docusign` → marca o contrato como `signed` ao concluir.

Sem credenciais, `iniciar_assinatura` cria o contrato com link placeholder
(degrada graciosamente) — o fluxo de IA funciona ponta a ponta.

## Próximas fases
1. ~~Painel Next.js~~ ✓ · ~~Auth dos operadores~~ ✓ · ~~DocuSign real (JWT)~~ ✓
2. RBAC por papel (admin/manager/operator) nas rotas.
3. Tabelas de preço reais da Alelo (hoje mock em `domain/pricing.ts`).
4. Migração opcional para WhatsApp Cloud API oficial (mesma interface de gateway).
```
