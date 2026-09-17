const jwt = require('jsonwebtoken');

/**
 * Toda rota autenticada usa isto. O token carrega { userId, businessId, role }
 * assinado com JWT_SECRET (só o servidor conhece esse segredo). Depois
 * daqui, req.businessId e req.role são a ÚNICA fonte de verdade — nenhuma
 * rota deve aceitar business_id ou role vindo do corpo da requisição ou
 * de query string. O token é emitido só em routes/auth.js, no login/signup.
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ ok: false, mensagem: 'Não autenticado.' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = payload.userId;
    req.businessId = payload.businessId;
    req.role = payload.role;
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, mensagem: 'Sessão inválida ou expirada.' });
  }
}

/* Uso: router.post('/rota-critica', requireAuth, requireRole('owner'), handler)
   Sempre depois de requireAuth — depende de req.role já estar setado. */
function requireRole(...papeisPermitidos) {
  return (req, res, next) => {
    if (!papeisPermitidos.includes(req.role)) {
      return res.status(403).json({ ok: false, mensagem: 'Sua conta não tem permissão para isso — fale com o administrador da empresa.' });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
