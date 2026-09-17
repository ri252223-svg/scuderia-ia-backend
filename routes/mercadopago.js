const express = require('express');
const crypto = require('crypto');
const { requireAuth } = require('../middleware/auth');

/**
 * Modelo MARKETPLACE: cada empresa conecta a própria conta do Mercado
 * Pago (OAuth) — a Siky nunca recebe o dinheiro, só facilita a cobrança
 * em nome da empresa. O MP_ACCESS_TOKEN "global" do .env não é usado
 * pra cobrar ninguém; ele só serviria pra uma eventual assinatura da
 * própria Siky no futuro, se um dia isso existir.
 */

function baseUrl() {
  return process.env.PUBLIC_BASE_URL || 'http://localhost:' + (process.env.PORT || 3000);
}
function oauthRedirectUri() {
  return baseUrl() + '/webhooks/mercadopago/oauth-callback';
}

/* Assina o "state" do OAuth com o business_id, pra ter certeza, quando
   o Mercado Pago chamar de volta, de que o token pertence à empresa
   certa — sem isso, alguém poderia manipular esse parâmetro e conectar
   uma conta na empresa errada. */
function signState(businessId) {
  const sig = crypto.createHmac('sha256', process.env.JWT_SECRET).update(businessId).digest('hex');
  return businessId + '.' + sig;
}
function verifyState(state) {
  if (!state || !state.includes('.')) return null;
  const [businessId, sig] = state.split('.');
  const expected = crypto.createHmac('sha256', process.env.JWT_SECRET).update(businessId).digest('hex');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch (e) { return null; }
  return businessId;
}

/**
 * Cria uma cobrança Pix DE VERDADE, usando o access token da PRÓPRIA
 * empresa (nunca um token global) — o dinheiro cai direto na conta dela.
 */
async function createPixCharge({ valor, descricao, accessToken, payerEmail }) {
  const resp = await fetch('https://api.mercadopago.com/v1/payments', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': crypto.randomUUID()
    },
    body: JSON.stringify({
      transaction_amount: valor,
      description: descricao,
      payment_method_id: 'pix',
      // O Mercado Pago exige um e-mail do pagador. Nosso cadastro de
      // cliente hoje só guarda nome/WhatsApp, sem e-mail — usamos um
      // valor genérico por enquanto (funciona pra gerar a cobrança,
      // mas idealmente colete o e-mail do cliente numa etapa futura).
      payer: { email: payerEmail || 'cliente@sikyia.com' }
    })
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.message || ('Mercado Pago respondeu ' + resp.status));
  const pix = (data.point_of_interaction && data.point_of_interaction.transaction_data) || {};
  return { id: String(data.id), qr_code: pix.qr_code || null, qr_code_base64: pix.qr_code_base64 || null };
}

function verifyMpSignature(req) {
  const signature = req.headers['x-signature'];
  if (!signature || !process.env.MP_WEBHOOK_SECRET) return false;
  const parts = Object.fromEntries(signature.split(',').map(p => p.trim().split('=')));
  const manifest = `id:${req.query['data.id']};request-id:${req.headers['x-request-id']};ts:${parts.ts};`;
  const expected = crypto.createHmac('sha256', process.env.MP_WEBHOOK_SECRET).update(manifest).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(parts.v1), Buffer.from(expected));
  } catch (e) {
    return false;
  }
}

function pageHtml(titulo, mensagem, ok) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
  <title>${titulo}</title>
  <style>body{background:#050A14;color:#F5F7FA;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:24px;}
  .card{max-width:420px;} h1{font-size:20px;color:${ok ? '#5AA9FF' : '#ff6b6b'};} p{color:#8B98AA;line-height:1.6;}</style>
  </head><body><div class="card"><h1>${titulo}</h1><p>${mensagem}</p><p>Pode fechar esta aba e voltar para a Siky.</p></div></body></html>`;
}

function createMercadoPagoRouter({ db }) {
  const router = express.Router();

  /* Chamado pelo frontend (autenticado) quando o dono clica em "Conectar
     Mercado Pago" — devolve a URL de autorização, já com o state
     assinado. O navegador é quem navega até essa URL, não o backend. */
  router.post('/connect-url', requireAuth, (req, res) => {
    if (!process.env.MP_CLIENT_ID) return res.status(500).json({ ok: false, mensagem: 'MP_CLIENT_ID não configurado no servidor.' });
    const params = new URLSearchParams({
      client_id: process.env.MP_CLIENT_ID,
      response_type: 'code',
      platform_id: 'mp',
      redirect_uri: oauthRedirectUri(),
      state: signState(req.businessId)
    });
    res.json({ ok: true, url: 'https://auth.mercadopago.com.br/authorization?' + params.toString() });
  });

  /* O Mercado Pago traz o dono de volta pra cá depois que ele autoriza
     no site deles. Essa rota é pública (não dá pra mandar Authorization
     header numa navegação de página inteira) — a segurança vem do
     "state" assinado, não de um token de sessão. */
  router.get('/oauth-callback', async (req, res) => {
    const { code, state, error } = req.query;
    if (error) return res.status(400).send(pageHtml('Conexão cancelada', 'Você não autorizou a conexão, ou algo deu errado no Mercado Pago.', false));
    const businessId = verifyState(state);
    if (!code || !businessId) return res.status(400).send(pageHtml('Link inválido', 'Esse link de conexão não é válido ou expirou. Tente conectar de novo pela tela de Integrações.', false));

    try {
      const resp = await fetch('https://api.mercadopago.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: process.env.MP_CLIENT_ID,
          client_secret: process.env.MP_CLIENT_SECRET,
          grant_type: 'authorization_code',
          code,
          redirect_uri: oauthRedirectUri()
        })
      });
      const tokenData = await resp.json();
      if (!resp.ok) throw new Error(tokenData.message || ('Mercado Pago respondeu ' + resp.status));

      await db.saveMercadoPagoConnection(businessId, {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        mp_user_id: tokenData.user_id,
        public_key: tokenData.public_key
      });
      res.send(pageHtml('Conta conectada! ✅', 'Sua conta do Mercado Pago foi conectada com sucesso. As cobranças Pix criadas pela Siky agora caem direto na sua conta.', true));
    } catch (e) {
      console.error('Erro no OAuth do Mercado Pago:', e);
      res.status(500).send(pageHtml('Não consegui conectar', 'Algo deu errado ao confirmar a conexão: ' + e.message, false));
    }
  });

  /* Desconectar — o dono decide remover o acesso a qualquer momento. */
  router.post('/disconnect', requireAuth, async (req, res) => {
    await db.disconnectMercadoPago(req.businessId);
    res.json({ ok: true, mensagem: 'Mercado Pago desconectado.' });
  });

  /* Status da conexão, pra tela de Integrações saber o que mostrar —
     nunca devolve o token em si, só se está conectado. */
  router.get('/status', requireAuth, async (req, res) => {
    const integracoes = await db.getBusinessIntegracoes(req.businessId);
    const mp = integracoes.mercado_pago || {};
    res.json({ ok: true, conectado: !!mp.conectado, conectado_em: mp.conectado_em || null });
  });

  // Notificações de status de pagamento chegam aqui. Primeiro descobrimos
  // de qual empresa é o pagamento (pelo nosso próprio registro), só
  // depois usamos O TOKEN DAQUELA EMPRESA pra confirmar os detalhes —
  // nunca um token global, já que cada empresa tem a própria conta.
  router.post('/webhook', async (req, res) => {
    if (!verifyMpSignature(req)) return res.sendStatus(401);
    res.sendStatus(200);

    try {
      const paymentId = req.query['data.id'];
      const registro = await db.findPaymentByExternalId(paymentId);
      if (!registro) { console.error('Webhook MP: pagamento não encontrado no nosso banco:', paymentId); return; }

      const integracoes = await db.getBusinessIntegracoes(registro.business_id);
      const mp = integracoes.mercado_pago || {};
      if (!mp.access_token) { console.error('Webhook MP: empresa sem token conectado:', registro.business_id); return; }

      const resp = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
        headers: { 'Authorization': 'Bearer ' + mp.access_token }
      });
      const payment = await resp.json();
      await db.updatePaymentStatus(paymentId, payment.status);
    } catch (e) {
      console.error('Erro processando webhook do Mercado Pago:', e);
    }
  });

  return router;
}

module.exports = { createMercadoPagoRouter, createPixCharge };
