const BASE = 'http://localhost:3000';
let passed = 0, failed = 0;

function check(label, cond, extra) {
  if (cond) { passed++; console.log('✅ ' + label); }
  else { failed++; console.log('❌ ' + label + (extra ? ' -> ' + JSON.stringify(extra) : '')); }
}

async function post(path, body, token) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body || {})
  });
  let json = null;
  try { json = await r.json(); } catch (e) {}
  return { status: r.status, json };
}
async function get(path, token) {
  const r = await fetch(BASE + path, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
  let json = null;
  try { json = await r.json(); } catch (e) {}
  return { status: r.status, json };
}

async function run() {
  const emailA = 'owner.a.' + Date.now() + '@teste.com';
  const emailB = 'owner.b.' + Date.now() + '@teste.com';
  const emailStaff = 'staff.a.' + Date.now() + '@teste.com';

  // 1 + 2. Criar empresa A + usuário owner
  let r = await post('/auth/signup', { nome: 'Dona A', email: emailA, senha: '123456' });
  check('1/2. Criar empresa A + owner (signup)', r.status === 200 && r.json.ok && r.json.user.role === 'owner', r.json);
  const tokenOwnerA = r.json.token;
  const businessIdA = r.json.business.id;

  // 3. Login
  r = await post('/auth/login', { email: emailA, senha: '123456' });
  check('3. Login do owner A', r.status === 200 && r.json.ok && r.json.token, r.json);

  // senha errada deve falhar
  r = await post('/auth/login', { email: emailA, senha: 'errada' });
  check('3b. Login com senha errada é rejeitado', r.status === 401 && !r.json.ok);

  // 4. Criar segundo usuário (staff) na mesma empresa
  r = await post('/auth/team', { nome: 'Funcionária A', email: emailStaff, senha: '123456' }, tokenOwnerA);
  check('4. Owner cria staff na mesma empresa', r.status === 200 && r.json.ok && r.json.user.role === 'staff', r.json);

  r = await post('/auth/login', { email: emailStaff, senha: '123456' });
  const tokenStaffA = r.json.token;
  check('4b. Login do staff recém-criado', r.status === 200 && !!tokenStaffA);

  // staff não pode convidar outro usuário
  r = await post('/auth/team', { nome: 'Outra', email: 'x' + Date.now() + '@teste.com', senha: '123456' }, tokenStaffA);
  check('4c. Staff NÃO pode convidar novo usuário (403 esperado)', r.status === 403, r.json);

  // 5. Criar segunda empresa
  r = await post('/auth/signup', { nome: 'Dona B', email: emailB, senha: '123456' });
  const tokenOwnerB = r.json.token;
  const businessIdB = r.json.business.id;
  check('5. Criar empresa B + owner', r.status === 200 && r.json.ok && businessIdB !== businessIdA, r.json);

  // 7. Criar cliente (empresa A)
  r = await post('/api/actions/criar_cliente', { nome: 'Ana', whatsapp: '11999990001' }, tokenOwnerA);
  check('7. Criar cliente na empresa A', r.status === 200 && r.json.ok, r.json);
  const clienteAnaId = r.json.data && r.json.data.id;

  // cliente também na empresa B, pra testar isolamento de verdade (nome igual)
  await post('/api/actions/criar_cliente', { nome: 'Ana', whatsapp: '11888880002' }, tokenOwnerB);

  // 8. Criar serviço
  r = await post('/api/actions/criar_servico', { nome: 'Corte', preco: 60, duracao_min: 40 }, tokenOwnerA);
  check('8. Criar serviço na empresa A', r.status === 200 && r.json.ok, r.json);

  // 9. Criar profissional
  r = await post('/api/actions/criar_profissional', { nome: 'Carla' }, tokenOwnerA);
  check('9. Criar profissional na empresa A', r.status === 200 && r.json.ok, r.json);

  // 10. Criar agendamento
  const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  r = await post('/api/actions/criar_agendamento', { clienteNome: 'Ana', servicoNome: 'Corte', profissionalNome: 'Carla', data: amanha, hora: '15:00' }, tokenOwnerA);
  check('10. Criar agendamento na empresa A', r.status === 200 && r.json.ok, r.json);

  // 11. Editar dados (cliente)
  r = await post('/api/actions/editar_cliente', { id: clienteAnaId, changes: { whatsapp: '11999999999' } }, tokenOwnerA);
  check('11. Editar cliente na empresa A', r.status === 200 && r.json.ok && r.json.data.whatsapp === '11999999999', r.json);

  // 12. Remover dado quando permitido (serviço)
  r = await post('/api/actions/criar_servico', { nome: 'Temporário', preco: 10, duracao_min: 15 }, tokenOwnerA);
  const servTempId = r.json.data.id;
  r = await post('/api/actions/remover_servico', { id: servTempId }, tokenOwnerA);
  check('12. Remover serviço na empresa A', r.status === 200 && r.json.ok, r.json);

  // criar_automacao: staff NÃO pode (REQUIRES_OWNER), owner pode
  r = await post('/api/actions/criar_automacao', { label: 'Confirmação automática' }, tokenStaffA);
  check('12b. Staff NÃO pode criar automação (403 esperado)', r.status === 403, r.json);
  r = await post('/api/actions/criar_automacao', { label: 'Confirmação automática' }, tokenOwnerA);
  check('12c. Owner PODE criar automação', r.status === 200 && r.json.ok, r.json);

  // staff PODE fazer operações comuns (cadastrar cliente)
  r = await post('/api/actions/criar_cliente', { nome: 'Beatriz' }, tokenStaffA);
  check('12d. Staff PODE cadastrar cliente (operacional, permitido)', r.status === 200 && r.json.ok, r.json);

  // 6 + 15. Isolamento entre empresas — o teste mais importante
  r = await post('/api/actions/buscar_cliente', { nome: 'Ana' }, tokenOwnerB);
  const clienteEncontradoPorB = r.json.data;
  check('6/15. Empresa B busca "Ana" e NÃO encontra a Ana da empresa A (ids diferentes)',
    clienteEncontradoPorB && clienteEncontradoPorB.id !== clienteAnaId);

  r = await post('/api/actions/editar_cliente', { id: clienteAnaId, changes: { nome: 'HACKEADO' } }, tokenOwnerB);
  check('15b. Empresa B tentando editar cliente da empresa A pelo ID direto -> não encontrado/sem efeito',
    r.json && (r.json.ok === false || !r.json.data));

  // confirma que o dado da empresa A não foi alterado por B
  r = await post('/api/actions/buscar_cliente', { nome: 'Ana' }, tokenOwnerA);
  check('15c. Cliente da empresa A continua intacto após tentativa de B', r.json.data && r.json.data.nome === 'Ana');

  // sem token nenhum
  r = await post('/api/actions/criar_cliente', { nome: 'Sem Token' }, null);
  check('15d. Requisição sem token é rejeitada (401 esperado)', r.status === 401, r.json);

  // token de empresa A tentando usar business_id de B manualmente no corpo (deve ser ignorado)
  r = await post('/api/actions/criar_cliente', { nome: 'Tentativa Injeção', business_id: businessIdB }, tokenOwnerA);
  const rBusca = await post('/api/actions/buscar_cliente', { nome: 'Tentativa Injeção' }, tokenOwnerB);
  check('15e. business_id enviado no corpo é ignorado (cliente não aparece na empresa B)',
    !rBusca.json.data || rBusca.json.data.nome !== 'Tentativa Injeção');

  // 13. Registrar ação da assistente (via comando de texto, testando parseCommandChain -> executeChain -> runAction)
  r = await post('/api/actions/comando', { texto: 'Cadastre a Fernanda como cliente.', origem: 'texto' }, tokenOwnerA);
  check('13/16. Comando de texto (parser) cria cliente e registra ação', r.status === 200 && r.json.ok, r.json);

  // comando composto com confirmação (agendar + confirmar)
  r = await post('/api/actions/comando', { texto: 'Agenda a Ana amanhã às 16h e manda uma confirmação para ela.', origem: 'texto' }, tokenOwnerA);
  check('16b. Comando composto retorna needsConfirm', r.json.ok && r.json.needsConfirm && r.json.confirmationId, r.json);
  if (r.json.confirmationId) {
    const rc = await post('/api/actions/confirmar', { confirmationId: r.json.confirmationId, confirmado: true }, tokenOwnerA);
    check('16c. Confirmar executa a cadeia (agendamento + whatsapp simulado)', rc.json.ok, rc.json);
  }

  // 14. Sessão autenticada (/auth/me)
  r = await get('/auth/me', tokenOwnerA);
  check('14. /auth/me retorna business_id e role corretos', r.status === 200 && r.json.businessId === businessIdA && r.json.role === 'owner', r.json);

  // token inválido/adulterado
  r = await get('/auth/me', tokenOwnerA + 'x');
  check('14b. Token adulterado é rejeitado', r.status === 401);

  console.log('\n--- RESUMO ---');
  console.log(passed + ' passaram, ' + failed + ' falharam');
  process.exit(failed > 0 ? 1 : 0);
}
run().catch(e => { console.error('ERRO FATAL NO TESTE:', e); process.exit(1); });
