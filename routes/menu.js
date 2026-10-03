const express = require('express');

/**
 * Rotas do cardápio digital do PONTO DE VISTA DO CLIENTE — nunca do dono.
 * Por isso não passam por requireAuth: o cliente não tem conta, não faz
 * login, só escaneia o QR da mesa. O "token" de sessão aqui NÃO é um JWT,
 * é só um identificador aleatório opaco que o navegador do cliente guarda
 * em localStorage.
 *
 * Fluxo completo:
 *   1. GET  /menu/:qr_token                       -> escaneou o QR: cria sessão, SEM comanda ainda
 *   2. POST /menu/sessao/:token/comanda  {numero}  -> digitou a comanda: entra ou cria, devolve cardápio + carrinho
 *   3. GET  /menu/sessao/:token                    -> reabrir depois (página recarregada)
 *
 * Carrinho e pedido são da COMANDA (compartilhados por todo mundo que
 * digitou o mesmo número), não da sessão de uma pessoa só — por isso só
 * funcionam depois do passo 2:
 *   GET    /menu/sessao/:token/carrinho
 *   POST   /menu/sessao/:token/carrinho           { produto_id, quantidade, observacao }
 *   PATCH  /menu/sessao/:token/carrinho/:itemId   { quantidade }
 *   DELETE /menu/sessao/:token/carrinho/:itemId
 *   POST   /menu/sessao/:token/pedido             { observacao }  -> confirma o carrinho
 *   GET    /menu/sessao/:token/pedidos            -> pedidos da comanda inteira + status
 */
module.exports = function createMenuRouter({ db }) {
  const router = express.Router();
  const UUID_RE = /^[0-9a-f-]{36}$/i;
  const NUMERO_COMANDA_RE = /^[a-zA-Z0-9]{1,10}$/;

  async function montarCardapio(businessId) {
    const [categorias, produtos] = await Promise.all([
      db.listMenuCategories(businessId),
      db.listMenuProducts(businessId)
    ]);
    // Cliente só pode ver pratos disponíveis — indisponível é informação
    // interna do dono, não da vitrine.
    return { categorias, produtos: produtos.filter(p => p.disponivel) };
  }

  async function carrinhoAtual(businessId, comandaId) {
    const itens = await db.listCartItems(businessId, comandaId);
    const total = Math.round(itens.reduce((t, i) => t + i.subtotal, 0) * 100) / 100;
    return { itens, total };
  }

  async function comandaResposta(sessao, numeroComanda) {
    const { categorias, produtos } = await montarCardapio(sessao.business_id);
    const carrinho = await carrinhoAtual(sessao.business_id, sessao.comanda_id);
    return { ok: true, comanda: { numero: numeroComanda }, categorias, produtos, carrinho };
  }

  // Resolve a sessão a partir do token da URL. Não exige comanda — quem
  // precisa dela exige explicitamente (exigirComanda), porque a primeira
  // tela do cliente (escolher a comanda) roda sem comanda ainda.
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

  function exigirComanda(req, res, next) {
    if (!req.sessao.comanda_id) {
      return res.status(400).json({ ok: false, mensagem: 'Informe o número da comanda antes de continuar.' });
    }
    next();
  }

  function lerQuantidade(v) {
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 && n <= 50 ? n : null;
  }

  // ---- passo 1: escanear o QR ----
  router.get('/:qrToken', async (req, res, next) => {
    try {
      const mesa = await db.findMenuTableByToken(req.params.qrToken);
      if (!mesa) {
        return res.status(404).json({ ok: false, mensagem: 'Mesa não encontrada ou inativa. Chame o atendimento.' });
      }
      const sessao = await db.createMenuSession(mesa.business_id, mesa.id);
      res.json({
        ok: true,
        sessao_token: sessao.token,
        mesa: { id: mesa.id, nome: mesa.nome },
        precisa_comanda: true
      });
    } catch (e) { next(e); }
  });

  // ---- passo 2: escolher/criar a comanda ----
  router.post('/sessao/:token/comanda', exigirSessao, async (req, res, next) => {
    try {
      const numero = String((req.body && req.body.numero) || '').trim();
      if (!NUMERO_COMANDA_RE.test(numero)) {
        return res.status(400).json({ ok: false, mensagem: 'Número de comanda inválido.' });
      }
      const sessao = req.sessao;
      const comanda = await db.joinOrCreateComanda(sessao.business_id, sessao.mesa_id, numero);
      await db.setSessionComanda(sessao.token, comanda.id);
      sessao.comanda_id = comanda.id;
      res.json(await comandaResposta(sessao, comanda.numero));
    } catch (e) { next(e); }
  });

  // ---- reabrir a sessão (página recarregada) ----
  router.get('/sessao/:token', exigirSessao, async (req, res, next) => {
    try {
      const sessao = req.sessao;
      await db.touchMenuSession(sessao.token);
      if (!sessao.comanda_id) {
        return res.json({ ok: true, sessao_token: sessao.token, mesa_id: sessao.mesa_id, precisa_comanda: true });
      }
      res.json(await comandaResposta(sessao, null));
    } catch (e) { next(e); }
  });

  // ---- carrinho (da comanda) ----

  router.get('/sessao/:token/carrinho', exigirSessao, exigirComanda, async (req, res, next) => {
    try { res.json({ ok: true, ...(await carrinhoAtual(req.sessao.business_id, req.sessao.comanda_id)) }); }
    catch (e) { next(e); }
  });

  router.post('/sessao/:token/carrinho', exigirSessao, exigirComanda, async (req, res, next) => {
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
      if (!UUID_RE.test(produto_id)) {
        return res.status(404).json({ ok: false, mensagem: 'Prato não encontrado.' });
      }
      const produto = await db.getMenuProductById(sessao.business_id, produto_id);
      if (!produto) return res.status(404).json({ ok: false, mensagem: 'Prato não encontrado.' });
      if (!produto.disponivel) return res.status(409).json({ ok: false, mensagem: 'Esse prato está indisponível no momento.' });
      await db.addCartItem(sessao.business_id, sessao.comanda_id, { productId: produto.id, quantidade, observacao: obs });
      await db.touchMenuSession(sessao.token);
      res.json({ ok: true, ...(await carrinhoAtual(sessao.business_id, sessao.comanda_id)) });
    } catch (e) { next(e); }
  });

  router.patch('/sessao/:token/carrinho/:itemId', exigirSessao, exigirComanda, async (req, res, next) => {
    try {
      const quantidade = lerQuantidade(req.body && req.body.quantidade);
      if (quantidade === null) return res.status(400).json({ ok: false, mensagem: 'Quantidade inválida (0 a 50).' });
      if (!UUID_RE.test(req.params.itemId)) {
        return res.status(404).json({ ok: false, mensagem: 'Item não encontrado.' });
      }
      const sessao = req.sessao;
      const achou = quantidade === 0
        ? await db.removeCartItem(sessao.business_id, sessao.comanda_id, req.params.itemId)
        : await db.setCartItemQuantity(sessao.business_id, sessao.comanda_id, req.params.itemId, quantidade);
      if (!achou) return res.status(404).json({ ok: false, mensagem: 'Item não encontrado.' });
      res.json({ ok: true, ...(await carrinhoAtual(sessao.business_id, sessao.comanda_id)) });
    } catch (e) { next(e); }
  });

  router.delete('/sessao/:token/carrinho/:itemId', exigirSessao, exigirComanda, async (req, res, next) => {
    try {
      if (!UUID_RE.test(req.params.itemId)) {
        return res.status(404).json({ ok: false, mensagem: 'Item não encontrado.' });
      }
      const sessao = req.sessao;
      const achou = await db.removeCartItem(sessao.business_id, sessao.comanda_id, req.params.itemId);
      if (!achou) return res.status(404).json({ ok: false, mensagem: 'Item não encontrado.' });
      res.json({ ok: true, ...(await carrinhoAtual(sessao.business_id, sessao.comanda_id)) });
    } catch (e) { next(e); }
  });

  // ---- pedido (da comanda) ----

  router.post('/sessao/:token/pedido', exigirSessao, exigirComanda, async (req, res, next) => {
    try {
      const body = req.body || {};
      const obs = typeof body.observacao === 'string' ? body.observacao.trim().slice(0, 300) : '';
      const sessao = req.sessao;
      const r = await db.createOrderFromCart(sessao.business_id, sessao.comanda_id, obs);
      if (r.erro === 'vazio') return res.status(400).json({ ok: false, mensagem: 'Seu carrinho está vazio.' });
      if (r.erro === 'mesa_inativa') return res.status(403).json({ ok: false, mensagem: 'Esta mesa não está mais ativa. Chame o atendimento.' });
      if (r.erro === 'indisponiveis') {
        return res.status(409).json({ ok: false, mensagem: 'Alguns pratos ficaram indisponíveis: ' + r.itens.join(', ') + '. Remova-os do carrinho para continuar.', itens: r.itens });
      }
      await db.touchMenuSession(sessao.token);
      res.status(201).json({ ok: true, pedido: r.pedido });
    } catch (e) { next(e); }
  });

  router.get('/sessao/:token/pedidos', exigirSessao, exigirComanda, async (req, res, next) => {
    try {
      const pedidos = await db.listOrders(req.sessao.business_id, req.sessao.comanda_id, 'comanda');
      res.json({ ok: true, pedidos });
    } catch (e) { next(e); }
  });

  return router;
};
