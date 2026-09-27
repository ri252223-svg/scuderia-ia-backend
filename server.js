require('dotenv').config();
const express = require('express');
const path = require('path');

const db = require('./lib/db');
const { parseCommandChain, CONFIRM_REQUIRED } = require('./lib/ai');
const createActionsLayer = require('./lib/actions');
const { createWhatsappRouter, sendWhatsAppMessage } = require('./routes/whatsapp');
const { createMercadoPagoRouter, createPixCharge } = require('./routes/mercadopago');
const createActionsRouter = require('./routes/actions');
const createAuthRouter = require('./routes/auth');
const createDataRouter = require('./routes/data');
const createMenuRouter = require('./routes/menu');

const app = express();

// O webhook da Meta precisa do corpo "cru" pra validar a assinatura HMAC,
// então capturamos rawBody antes do parser de JSON transformar o corpo.
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf.toString(); }
}));

// A camada de ações recebe as integrações já prontas (dependency injection),
// então lib/actions.js nunca precisa saber como enviar WhatsApp ou criar Pix
// de verdade — só chama a função que foi passada pra ele (ambas simuladas
// nesta fase, ver routes/whatsapp.js e routes/mercadopago.js).
const { runAction, REQUIRES_OWNER } = createActionsLayer({ db, sendWhatsAppMessage, createPixCharge });

// CORS — o frontend (scuderia-app.html) é aberto separadamente do backend,
// então o navegador bloqueia a chamada por padrão sem isso. Liberado pra
// qualquer origem nesta fase de desenvolvimento; ao publicar de verdade,
// trocar '*' pelo domínio real do frontend.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

async function findBusinessByPhoneNumberId(phoneNumberId) {
  // Correção da auditoria: este stub referenciava db.__DEMO_BUSINESS_ID__,
  // uma propriedade que nunca existiu em lib/db.js — sempre retornava
  // undefined. Ainda não há tabela real ligando phone_number_id a uma
  // empresa (isso exige a integração real, fora do escopo desta etapa),
  // então o stub honesto por enquanto é: sempre "não encontrado".
  // TODO: quando a integração for conectada de verdade, trocar por uma
  // consulta à coluna whatsapp_phone_number_id da tabela businesses.
  return null;
}

app.use('/auth', createAuthRouter({ db }));
app.use('/webhooks/whatsapp', createWhatsappRouter({ parseCommandChain, CONFIRM_REQUIRED, runAction, findBusinessByPhoneNumberId }));
app.use('/webhooks/mercadopago', createMercadoPagoRouter({ db }));
app.use('/api/actions', createActionsRouter({ runAction, REQUIRES_OWNER, db }));
app.use('/api/data', createDataRouter({ db }));
app.use('/menu', createMenuRouter({ db }));

app.get('/health', (req, res) => res.json({ ok: true }));

// Serve o próprio frontend (scuderia-app.html) — assim o mesmo endereço do
// Railway abre o app direto, em qualquer dispositivo, sem precisar do
// arquivo local no computador. Fica numa pasta "public" separada das
// rotas de API, então nunca conflita com elas.
app.use(express.static(path.join(__dirname, 'public')));

// Middleware de erro central — nunca vaza detalhe interno pro cliente.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ ok: false, mensagem: 'Erro interno.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('SIKY IA backend rodando na porta ' + PORT));
