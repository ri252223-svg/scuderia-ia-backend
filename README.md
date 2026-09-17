# Scuderia IA — backend (Fase 5 — banco real, autenticação real, multiempresa)

Este backend **roda de verdade** contra um Postgres real (testado neste
ambiente com uma instância local; em produção, aponte `DATABASE_URL` para
Supabase ou qualquer Postgres gerenciado — o código não muda). Login,
cadastro, senha com hash, papéis (owner/staff) e isolamento entre empresas
via Row Level Security estão implementados e testados de ponta a ponta
(ver `test_e2e.js`).

**O que ainda é simulado, deliberadamente (fora do escopo desta fase):**
envio de WhatsApp (`routes/whatsapp.js`) e cobrança Pix (`routes/mercadopago.js`)
não chamam nenhuma API externa de verdade — só registram no console/banco
como se tivessem enviado. Nada de Meta, Mercado Pago, Instagram real.

**O que ainda não está conectado:** o `scuderia-app.html` continua usando
o `DB` em memória, exatamente como antes — o frontend ainda não faz
`fetch()` para este backend. Motivo: este backend só existe rodando aqui,
neste ambiente de desenvolvimento — não há uma URL pública e permanente
para o frontend chamar ainda. Assim que este backend for implantado em
algum host (Railway, Render, Fly.io...), a conexão do frontend é a
próxima etapa natural — a arquitetura (ações com os mesmos nomes,
mesmos parâmetros) já está pronta pra isso.

## Estrutura

```
backend/
  server.js               — bootstrap do Express, monta as rotas
  migrations/
    001_init.sql            — schema (9 tabelas, índices, FKs)
    002_rls.sql              — Row Level Security (isolamento por empresa)
  seeds/
    dev_seed.sql              — dados fictícios, SÓ pra dev/teste (nunca produção)
  middleware/auth.js       — valida o JWT e injeta req.businessId/req.role
  lib/db.js                — camada de dados real (Postgres via `pg`)
  lib/actions.js            — camada de ações controladas (criar_cliente, etc.)
  lib/ai.js                  — interpretador de comando (compartilhado, voz e texto)
  routes/auth.js             — signup, login, logout, /me, /team (convite de staff)
  routes/actions.js           — executa ações (comando de texto/voz, ou clique manual)
  routes/whatsapp.js           — SIMULADO — nunca chama a Meta de verdade
  routes/mercadopago.js         — SIMULADO — nunca chama o Mercado Pago de verdade
  test_e2e.js                    — suíte de testes reais (26 casos, contra o Postgres de verdade)
```

## Rodando localmente

```bash
npm install
cp .env.example .env   # preencher DATABASE_URL e JWT_SECRET
psql "$DATABASE_URL" -f migrations/001_init.sql
psql "$DATABASE_URL" -f migrations/002_rls.sql
psql "$DATABASE_URL" -f seeds/dev_seed.sql   # opcional, só pra ter dado de teste
npm start
node test_e2e.js   # com o servidor já rodando em outro terminal
```

Conta de teste criada pelo seed: `demo@scuderia.ia` / `demo123`.

## Autenticação e papéis

- Senha nunca em texto puro — hash bcrypt (10 rounds), tanto no cadastro
  quanto no seed de desenvolvimento (via `pgcrypto`, formato compatível
  com a lib `bcrypt` do Node).
- JWT carrega `{ userId, businessId, role }`, assinado com `JWT_SECRET`
  (só existe no servidor). Toda rota privada valida esse token em
  `middleware/auth.js` — nenhuma rota aceita `business_id` ou `role`
  vindo do corpo da requisição.
- Dois papéis: `owner` (criado no cadastro, sempre) e `staff` (só um
  `owner` pode convidar, via `POST /auth/team`). Ações em
  `REQUIRES_OWNER` (`lib/actions.js`) ficam bloqueadas pra `staff`,
  checado tanto pra ações avulsas quanto dentro de um comando composto.

## Isolamento entre empresas (multiempresa)

Duas camadas, testadas separadamente:

1. **Aplicação** — toda função de `lib/db.js` recebe `businessId` derivado
   do JWT verificado, nunca do cliente.
2. **Banco (Row Level Security)** — toda tabela de dado operacional tem
   `FORCE ROW LEVEL SECURITY` com uma política que só libera linhas cujo
   `business_id` bate com `current_business_id()` (definido por
   `withTenant()` no início de cada operação). **Verificado na prática**
   neste ambiente: consultar a tabela sem definir o tenant, ou com um
   tenant errado, devolve zero linhas — mesmo havendo dados reais na
   tabela. Falha seguro, não falha aberto.

`users` é a única tabela sem RLS por `business_id` (motivo documentado em
`migrations/002_rls.sql`: o login precisa achar o usuário pelo e-mail
antes de saber a empresa dele) — todo acesso a `users` fora do login já
filtra `business_id` explicitamente no código.

## Segurança

- Segredos (`DATABASE_URL`, `JWT_SECRET`, tokens de integrações futuras)
  só em `.env`, lido só pelo servidor — nunca no frontend.
- Erros internos nunca vazam detalhe pro cliente (middleware de erro
  central em `server.js`).
- Confirmações de ação (agendar, cancelar, etc.) ficam guardadas no
  servidor (`Map` em memória hoje — trocar por Redis se houver mais de
  uma instância do backend rodando), não no cliente, pra ninguém
  conseguir adulterar qual ação vai rodar ao confirmar.
