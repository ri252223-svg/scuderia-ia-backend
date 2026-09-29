const express = require('express');

/**
 * Rotas do cardápio digital do PONTO DE VISTA DO CLIENTE — nunca do dono.
 * Por isso não passam por requireAuth: o cliente não tem conta, não faz
 * login, só escaneia o QR da mesa. O "token" de sessão aqui NÃO é um JWT,
 * é só um identificador aleatório opaco (ver migrations/004) que o
 * navegador do cliente guarda em localStorage — ele nunca carrega
 * business_id nem nenhum dado sensível.
 *
 * GET  /menu/:qr_token       -> escaneou o QR agora: cria sessão nova
 * GET  /menu/sessao/:token   -> já tinha sessão (recarregou a página)
 *
 * Carrinho (sempre amarrado à sessão; preço vem do banco, nunca do cliente):
 * GET    /menu/sessao/:token/carrinho
 * POST   /menu/sessao/:token/carrinho           { produto_id, quantidade, observacao }
 * PATCH  /menu/sessao/:token/carrinho/:itemId   { quantidade }
 * DELETE /menu/sessao/:token/carrinho/:itemId
 *
 * Pedido:
 * POST   /menu/sessao/:token/pedido             { observacao }  -> confirma o carrinho
 * GET    /menu/sessao/:token/pedidos            -> pedidos desta sessão + status
 */
module.exports = function createMenuRouter({ db }) {
  const router = express.Router();

  async function montarCardapio(businessId) {
    const [categorias, produtos] = await Promise.all([
      db.listMenuCategories(businessId),
      db.listMenuProducts(businessId)
    ]);
    // Cliente só pode ver pratos disponíveis — indisponível é informação
    // interna do dono, não da vitrine.
    return { categorias, produtos: produtos.filter(p => p.disponivel) };
  }

  router.get('/:qrToken', async (req, res, next) => {
    try {
      const mesa = await db.findMenuTableByToken(req.params.qrToken);
      if (!mesa) {
        return res.status(404).json({ ok: false, mensagem: 'Mesa não encontrada ou inativa. Chame o atendimento.' });
      }
      const sessao = await db.createMenuSession(mesa.business_id, mesa.id);
      const { categorias, produtos } = await montarCardapio(mesa.business_id);
      res.json({
        ok: true,
        sessao_token: sessao.token,
        mesa: { id: mesa.id, nome: mesa.nome },
        categorias,
        produtos
      });
    } catch (e) { next(e); }
  });

  router.get('/sessao/:token', async (req, res, next) => {
    try {
      const sessao = await db.findMenuSessionByToken(req.params.token);
      if (!sessao) {
        return res.status(404).json({ ok: false, mensagem: 'Sessão não encontrada. Escaneie o QR da mesa de novo.' });
      }
      await db.touchMenuSession(sessao.token);
      const { categorias, produtos } = await montarCardapio(sessao.business_id);
      res.json({
        ok: true,
        sessao_token: sessao.token,
        mesa_id: sessao.mesa_id,
        categorias,
        produtos
      });
    } catch (e) { next(e); }
  });

  // ---- carrinho ----

  async function carrinhoResposta(sessao) {
    const itens = await db.listCartItems(sessao.business_id, sessao.id);
    const total = Math.round(itens.reduce((t, i) => t + i.subtotal, 0) * 100) / 100;
    return { ok: true, itens, total };
  }

  // Resolve a sessão a partir do token da URL; os dados de tenant vêm dela.
  async function exigirSessao(req, res, next) {
    try {
      const sessao = await db.findMenuSessionByToken(req.params.token);
      if (!sessao) {
        return res.status(404).json({ ok: false, mensagem: 'Sessão não encontrada. Escaneie o QR da mesa de novo.' });
      }
      req.sessao = sessao;
      next();
    } catch (e) { next(e); }
  }

  function lerQuantidade(v) {
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 && n <= 50 ? n : null;
  }

  router.get('/sessao/:token/carrinho', exigirSessao, async (req, res, next) => {
    try { res.json(await carrinhoResposta(req.sessao)); } catch (e) { next(e); }
  });

  router.post('/sessao/:token/carrinho', exigirSessao, async (req, res, next) => {
    try {
      const body = req.body || {};
      const { produto_id, observacao } = body;
      const quantidade = lerQuantidade(body.quantidade === undefined ? 1 : body.quantidade);
      if (!produto_id || typeof produto_id !== 'string') {
        return res.status(400).json({ ok: false, mensagem: 'Informe o prato (produto_id).' });
      }
      if (!quantidade || quantidade < 1) {
        return res.status(400).json({ ok: false, mensagem: 'Quantidade inválida (1 a 50).' });
      }
      const obs = typeof observacao === 'string' ? observacao.trim().slice(0, 200) : '';
      const sessao = req.sessao;
      // UUID malformado não pode virar erro 500 do Postgres.
      if (!/^[0-9a-f-]{36}$/i.test(produto_id)) {
        return res.status(404).json({ ok: false, mensagem: 'Prato não encontrado.' });
      }
      const produto = await db.getMenuProductById(sessao.business_id, produto_id);
      if (!produto) return res.status(404).json({ ok: false, mensagem: 'Prato não encontrado.' });
      if (!produto.disponivel) return res.status(409).json({ ok: false, mensagem: 'Esse prato está indisponível no momento.' });
      await db.addCartItem(sessao.business_id, sessao.id, { productId: produto.id, quantidade, observacao: obs });
      await db.touchMenuSession(sessao.token);
      res.json(await carrinhoResposta(sessao));
    } catch (e) { next(e); }
  });

  router.patch('/sessao/:token/carrinho/:itemId', exigirSessao, async (req, res, next) => {
    try {
      const quantidade = lerQuantidade(req.body && req.body.quantidade);
      if (quantidade === null) return res.status(400).json({ ok: false, mensagem: 'Quantidade inválida (0 a 50).' });
      if (!/^[0-9a-f-]{36}$/i.test(req.params.itemId)) {
        return res.status(404).json({ ok: false, mensagem: 'Item não encontrado.' });
      }
      const sessao = req.sessao;
      const achou = quantidade === 0
        ? await db.removeCartItem(sessao.business_id, sessao.id, req.params.itemId)
        : await db.setCartItemQuantity(sessao.business_id, sessao.id, req.params.itemId, quantidade);
      if (!achou) return res.status(404).json({ ok: false, mensagem: 'Item não encontrado.' });
      res.json(await carrinhoResposta(sessao));
    } catch (e) { next(e); }
  });

  router.delete('/sessao/:token/carrinho/:itemId', exigirSessao, async (req, res, next) => {
    try {
      if (!/^[0-9a-f-]{36}$/i.test(req.params.itemId)) {
        return res.status(404).json({ ok: false, mensagem: 'Item não encontrado.' });
      }
      const sessao = req.sessao;
      const achou = await db.removeCartItem(sessao.business_id, sessao.id, req.params.itemId);
      if (!achou) return res.status(404).json({ ok: false, mensagem: 'Item não encontrado.' });
      res.json(await carrinhoResposta(sessao));
    } catch (e) { next(e); }
  });

  // ---- pedido ----

  router.post('/sessao/:token/pedido', exigirSessao, async (req, res, next) => {
    try {
      const body = req.body || {};
      const obs = typeof body.observacao === 'string' ? body.observacao.trim().slice(0, 300) : '';
      const sessao = req.sessao;
      const r = await db.createOrderFromCart(sessao.business_id, sessao.id, obs);
      if (r.erro === 'vazio') return res.status(400).json({ ok: false, mensagem: 'Seu carrinho está vazio.' });
      if (r.erro === 'mesa_inativa') return res.status(403).json({ ok: false, mensagem: 'Esta mesa não está mais ativa. Chame o atendimento.' });
      if (r.erro === 'indisponiveis') {
        return res.status(409).json({ ok: false, mensagem: 'Alguns pratos ficaram indisponíveis: ' + r.itens.join(', ') + '. Remova-os do carrinho para continuar.', itens: r.itens });
      }
      await db.touchMenuSession(sessao.token);
      res.status(201).json({ ok: true, pedido: r.pedido });
    } catch (e) { next(e); }
  });

  router.get('/sessao/:token/pedidos', exigirSessao, async (req, res, next) => {
    try {
      const pedidos = await db.listOrders(req.sessao.business_id, req.sessao.id, 'session');
      res.json({ ok: true, pedidos });
    } catch (e) { next(e); }
  });

  return router;
};
