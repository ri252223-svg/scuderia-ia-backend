const express = require('express');
const { requireAuth } = require('../middleware/auth');

/**
 * Rotas de leitura pra popular as telas administrativas (Dashboard,
 * Clientes, Serviços, Equipe, Agenda, Automações, Histórico) — só
 * GET, nada aqui muda dado nenhum. business_id vem do token de sempre
 * (middleware/auth.js), nunca de um parâmetro da requisição.
 */
module.exports = function dataRouter({ db }) {
  const router = express.Router();
  router.use(requireAuth);

  router.get('/customers', async (req, res) => {
    res.json({ ok: true, items: await db.listCustomers(req.businessId) });
  });
  router.get('/services', async (req, res) => {
    res.json({ ok: true, items: await db.listServices(req.businessId) });
  });
  router.get('/professionals', async (req, res) => {
    res.json({ ok: true, items: await db.listProfessionals(req.businessId) });
  });
  router.get('/appointments', async (req, res) => {
    res.json({ ok: true, items: await db.listAppointments(req.businessId, { status: 'confirmado' }) });
  });
  router.get('/automations', async (req, res) => {
    res.json({ ok: true, items: await db.listAutomations(req.businessId) });
  });
  router.get('/history', async (req, res) => {
    res.json({ ok: true, items: await db.listActions(req.businessId) });
  });

  return router;
};
