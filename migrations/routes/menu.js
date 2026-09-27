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

  return router;
};
