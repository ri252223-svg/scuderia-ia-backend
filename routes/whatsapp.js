const express = require('express');
const crypto = require('crypto');

/**
 * Fluxo deste arquivo:
 *
 *   cliente → WhatsApp → Meta → webhook (aqui) → IA (lib/ai.js)
 *     → ação controlada (lib/actions.js) → banco → resposta pelo WhatsApp
 *
 * O businessId é resolvido a partir do WHATSAPP_PHONE_NUMBER_ID que a
 * Meta envia no payload — cada número de WhatsApp Business pertence a
 * uma empresa. Troque `findBusinessByPhoneNumberId` por uma consulta
 * real quando existir mais de uma empresa usando WhatsApp.
 */

/* Fase 5 — SIMULADO de propósito (WhatsApp real não entra nesta
   fase). Loga a mensagem e devolve sucesso, com a MESMA assinatura
   que a versão real vai ter — trocar o corpo desta função pela
   chamada de verdade à Graph API é o único passo necessário quando
   chegar a hora, em routes/whatsapp.js e só aqui. */
async function sendWhatsAppMessage(toPhone, texto) {
  console.log('[WhatsApp SIMULADO] para ' + (toPhone || '(sem numero)') + ': ' + texto);
  return { simulado: true, to: toPhone, texto };
}

function verifySignature(req) {
  const signature = req.headers['x-hub-signature-256'];
  if (!signature || !process.env.WHATSAPP_APP_SECRET) return false;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', process.env.WHATSAPP_APP_SECRET)
    .update(req.rawBody || '')
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch (e) {
    return false;
  }
}

function createWhatsappRouter({ parseCommandChain, CONFIRM_REQUIRED, runAction, findBusinessByPhoneNumberId }) {
  const router = express.Router();

  // Passo de verificação exigido pela Meta ao cadastrar o webhook.
  router.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  });

  // Mensagens recebidas de clientes chegam aqui.
  router.post('/webhook', async (req, res) => {
    if (!verifySignature(req)) return res.sendStatus(401);
    res.sendStatus(200); // responde rápido; o processamento continua abaixo

    try {
      const entry = req.body.entry?.[0];
      const change = entry?.changes?.[0]?.value;
      const message = change?.messages?.[0];
      if (!message || message.type !== 'text') return;

      const businessId = await findBusinessByPhoneNumberId(change.metadata.phone_number_id);
      if (!businessId) return; // número não pertence a nenhuma empresa cadastrada

      const texto = message.text.body;
      const clientePhone = message.from;

      const chain = parseCommandChain(texto);
      if (!chain) {
        await sendWhatsAppMessage(clientePhone, 'Desculpa, não entendi. Pode repetir de outro jeito?');
        return;
      }

      // Mensagens vindas do próprio cliente (não do empresário) não devem
      // executar ações administrativas sem revisão — aqui só registramos
      // e sinalizamos para o empresário confirmar dentro do painel.
      const needsConfirm = chain.some(c => CONFIRM_REQUIRED.includes(c.acao));
      if (needsConfirm) {
        await sendWhatsAppMessage(clientePhone, 'Recebi seu pedido! Vou confirmar com a equipe e te aviso por aqui.');
        // TODO: registrar como pendente para o empresário aprovar no painel.
        return;
      }

      for (const c of chain) {
        const r = await runAction(businessId, c.acao, c.params, 'whatsapp', texto);
        await sendWhatsAppMessage(clientePhone, r.mensagem);
      }
    } catch (e) {
      // nunca deixar o webhook derrubar o processo — só logar.
      console.error('Erro processando webhook do WhatsApp:', e);
    }
  });

  return router;
}

module.exports = { createWhatsappRouter, sendWhatsAppMessage };
