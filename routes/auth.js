const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { requireAuth, requireRole } = require('../middleware/auth');

const SALT_ROUNDS = 10;

function signToken(user) {
  return jwt.sign(
    { userId: user.id, businessId: user.business_id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}
function publicUser(u) {
  return { id: u.id, nome: u.nome, email: u.email, role: u.role, business_id: u.business_id };
}

module.exports = function createAuthRouter({ db }) {
  const router = express.Router();

  // Cria a empresa (nasce vazia — o onboarding conversacional da
  // Assistente é quem preenche os dados) e o primeiro usuário, sempre
  // como 'owner'. O papel nunca vem do corpo da requisição.
  router.post('/signup', async (req, res) => {
    try {
      const { nome, email, senha } = req.body || {};
      if (!nome || !email || !senha) return res.status(400).json({ ok: false, mensagem: 'Preencha todos os campos.' });

      const existente = await db.findUserByEmail(email);
      if (existente) return res.status(409).json({ ok: false, mensagem: 'Já existe uma conta com esse e-mail.' });

      const businessId = crypto.randomUUID();
      const business = await db.createBusiness(businessId, {});
      const senhaHash = await bcrypt.hash(senha, SALT_ROUNDS);
      const user = await db.createUser({ businessId, nome, email, senhaHash, role: 'owner' });

      const token = signToken(user);
      res.json({ ok: true, token, user: publicUser(user), business });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, mensagem: 'Erro ao criar conta.' });
    }
  });

  router.post('/login', async (req, res) => {
    try {
      const { email, senha } = req.body || {};
      if (!email || !senha) return res.status(400).json({ ok: false, mensagem: 'Preencha e-mail e senha.' });

      const user = await db.findUserByEmail(email);
      if (!user) return res.status(401).json({ ok: false, mensagem: 'E-mail ou senha incorretos.' });

      const confere = await bcrypt.compare(senha, user.senha_hash);
      if (!confere) return res.status(401).json({ ok: false, mensagem: 'E-mail ou senha incorretos.' });

      const business = await db.findBusinessById(user.business_id);
      const token = signToken(user);
      res.json({ ok: true, token, user: publicUser(user), business });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, mensagem: 'Erro ao entrar.' });
    }
  });

  // JWT é stateless — "logout" aqui é simbólico (o cliente descarta o
  // token). Se algum dia precisarmos revogar sessão antes de expirar,
  // é aqui que entraria uma tabela de tokens invalidados — não existe
  // ainda, não foi pedido nesta fase.
  router.post('/logout', requireAuth, (req, res) => {
    res.json({ ok: true, mensagem: 'Sessão encerrada.' });
  });

  router.get('/me', requireAuth, async (req, res) => {
    const business = await db.findBusinessById(req.businessId);
    res.json({ ok: true, userId: req.userId, businessId: req.businessId, role: req.role, business });
  });

  // Gestão de equipe — só o owner convida. Sempre cria como 'staff';
  // não existe forma de criar um segundo owner por essa rota.
  router.get('/team', requireAuth, async (req, res) => {
    const team = await db.listUsersByBusiness(req.businessId);
    res.json({ ok: true, team });
  });
  router.post('/team', requireAuth, requireRole('owner'), async (req, res) => {
    try {
      const { nome, email, senha } = req.body || {};
      if (!nome || !email || !senha) return res.status(400).json({ ok: false, mensagem: 'Preencha todos os campos.' });
      const existente = await db.findUserByEmail(email);
      if (existente) return res.status(409).json({ ok: false, mensagem: 'Já existe uma conta com esse e-mail.' });
      const senhaHash = await bcrypt.hash(senha, SALT_ROUNDS);
      const user = await db.createUser({ businessId: req.businessId, nome, email, senhaHash, role: 'staff' });
      res.json({ ok: true, user: publicUser(user) });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, mensagem: 'Erro ao criar usuário.' });
    }
  });

  return router;
};
