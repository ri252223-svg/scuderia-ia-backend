const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { resolveIntent, CONFIRM_REQUIRED } = require('../lib/ai');

module.exports = function actionsRouter({ runAction, REQUIRES_OWNER, db }) {
  const router = express.Router();
  router.use(requireAuth);

  /**
   * Confirmações pendentes ficam no servidor, não no cliente — o
   * frontend recebe só um confirmationId. Isso evita que alguém
   * manipule a requisição de confirmação para rodar uma ação diferente
   * da que foi de fato interpretada e mostrada ao empresário.
   * Em produção, troque este Map por Redis (múltiplas instâncias).
   */
  const pending = new Map();
  const TTL_MS = 2 * 60 * 1000;
  function cleanup() {
    const now = Date.now();
    for (const [id, entry] of pending) if (now - entry.criadoEm > TTL_MS) pending.delete(id);
  }

  /* Uma ação restrita a owner numa cadeia composta bloqueia a cadeia
     inteira — não executamos "só a metade permitida" silenciosamente. */
  function acaoNegada(chain, role) {
    return chain.find(c => REQUIRES_OWNER.includes(c.acao) && role !== 'owner');
  }

  router.post('/comando', (req, res) => {
    cleanup();
    const { texto, origem } = req.body || {};
    if (!texto) return res.status(400).json({ ok: false, mensagem: 'Comando vazio.' });

    /* Fase de IA — item 2: resolveIntent tenta o agente de verdade
       (lib/agent.js) e cai no parser de regras se ele falhar por
       qualquer motivo. runAction e db são passados como contexto só
       para a IA poder consultar (ferramentas de leitura) e resolver
       nome→id — ela nunca recebe business_id/user_id do modelo, só o
       que o backend já validou pelo token. */
    resolveIntent(texto, { businessId: req.businessId, userId: req.userId, role: req.role, runAction, db })
      .then(({ chain, resposta, fonte }) => {
        if (!chain) return res.json({ ok: !!resposta, mensagem: resposta || 'Não entendi esse comando.', fonte });

        const negada = acaoNegada(chain, req.role);
        if (negada) return res.status(403).json({ ok: false, mensagem: 'Essa ação (' + negada.acao + ') só pode ser feita pelo administrador da empresa.' });

        const needsConfirm = chain.some(c => CONFIRM_REQUIRED.includes(c.acao));
        if (needsConfirm) {
          const confirmationId = 'conf_' + Math.random().toString(36).slice(2, 10);
          pending.set(confirmationId, { businessId: req.businessId, userId: req.userId, chain, texto, origem, criadoEm: Date.now() });
          return res.json({ ok: true, needsConfirm: true, confirmationId, chain, fonte });
        }

        executeChain(req.businessId, chain, origem, texto, req.userId).then(resultado => res.json(Object.assign({ fonte }, resultado)));
      });
  });

  /* Mesma lógica exata do /comando acima, só que a resposta viaja em
     tempo real via Server-Sent Events em vez de esperar tudo pronto.
     Eventos: "delta" (pedaço de texto, só quando a resposta é só
     conversa — nunca durante uma chamada de ferramenta, pra não vazar
     raciocínio interno) e "done" (o mesmo payload que /comando sempre
     devolveu, sempre por último — o frontend pode tratar os dois
     iguais, usando os deltas só pro efeito visual de digitação ao
     vivo). Se o texto cair no fallback de regras (sem IA disponível),
     não tem delta nenhum — vai direto pro "done", já que o parser é
     síncrono e instantâneo mesmo. */
  router.post('/comando-stream', (req, res) => {
    cleanup();
    const { texto, origem } = req.body || {};
    if (!texto) return res.status(400).json({ ok: false, mensagem: 'Comando vazio.' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    let closed = false;
    res.on('close', () => { closed = true; });
    function sendEvent(nome, dados) {
      if (closed) return;
      res.write('event: ' + nome + '\ndata: ' + JSON.stringify(dados) + '\n\n');
    }

    resolveIntent(
      texto,
      { businessId: req.businessId, userId: req.userId, role: req.role, runAction, db },
      (chunk) => sendEvent('delta', { text: chunk })
    ).then(({ chain, resposta, fonte }) => {
      if (!chain) {
        sendEvent('done', { ok: !!resposta, mensagem: resposta || 'Não entendi esse comando.', fonte });
        return res.end();
      }

      const negada = acaoNegada(chain, req.role);
      if (negada) {
        sendEvent('done', { ok: false, mensagem: 'Essa ação (' + negada.acao + ') só pode ser feita pelo administrador da empresa.' });
        return res.end();
      }

      const needsConfirm = chain.some(c => CONFIRM_REQUIRED.includes(c.acao));
      if (needsConfirm) {
        const confirmationId = 'conf_' + Math.random().toString(36).slice(2, 10);
        pending.set(confirmationId, { businessId: req.businessId, userId: req.userId, chain, texto, origem, criadoEm: Date.now() });
        sendEvent('done', { ok: true, needsConfirm: true, confirmationId, chain, fonte });
        return res.end();
      }

      executeChain(req.businessId, chain, origem, texto, req.userId).then(resultado => {
        sendEvent('done', Object.assign({ fonte }, resultado));
        res.end();
      });
    }).catch(e => {
      sendEvent('done', { ok: false, mensagem: 'Erro inesperado: ' + e.message });
      res.end();
    });
  });

  router.post('/confirmar', (req, res) => {
    const { confirmationId, confirmado } = req.body || {};
    const entry = pending.get(confirmationId);
    pending.delete(confirmationId);

    if (!entry || entry.businessId !== req.businessId) {
      return res.status(404).json({ ok: false, mensagem: 'Confirmação não encontrada ou expirada.' });
    }
    if (!confirmado) return res.json({ ok: true, mensagem: 'Ação cancelada.' });

    executeChain(entry.businessId, entry.chain, entry.origem, entry.texto, entry.userId).then(resultado => res.json(resultado));
  });

  // Telas manuais (ex: botão "+ Novo cliente") chamam uma ação diretamente,
  // sem passar pelo interpretador — o clique já é a confirmação do empresário.
  router.post('/:nome', async (req, res) => {
    if (REQUIRES_OWNER.includes(req.params.nome) && req.role !== 'owner') {
      return res.status(403).json({ ok: false, mensagem: 'Essa ação só pode ser feita pelo administrador da empresa.' });
    }
    const resultado = await runAction(req.businessId, req.params.nome, req.body || {}, 'manual', '', req.userId);
    res.json(resultado);
  });

  async function executeChain(businessId, chain, origem, comandoTexto, userId) {
    const results = [];
    for (const c of chain) results.push(await runAction(businessId, c.acao, c.params, origem, comandoTexto, userId));
    return { ok: results.every(r => r.ok), mensagens: results.map(r => r.mensagem) };
  }

  return router;
};
