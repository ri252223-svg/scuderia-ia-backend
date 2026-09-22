/**
 * Ferramentas disponíveis para a camada de IA (Fase de IA, item 2).
 *
 * Este arquivo só DESCREVE as ações que já existem em lib/actions.js —
 * não reimplementa nenhuma delas. O modelo de linguagem escolhe qual
 * ferramenta usar e com quais argumentos; a execução de verdade
 * continua 100% em lib/actions.js, através do mesmo runAction() que já
 * existia antes da IA.
 *
 * Duas categorias, tratadas de formas diferentes por lib/agent.js:
 *
 * - MUTATING_ACTIONS: mudam dado ou disparam efeito (agendar, cancelar,
 *   mandar WhatsApp, cobrar...). O agente NUNCA executa essas sozinho —
 *   ele só propõe a chamada, que vira uma `chain` entregue ao mesmo
 *   fluxo de permissão/confirmação que já existia (routes/actions.js).
 *
 * - READONLY_ACTIONS: só consultam (agenda, preços, cliente...). O
 *   agente pode executá-las diretamente durante o próprio raciocínio
 *   (via runAction, igual a qualquer outra chamada — fica registrado
 *   no histórico do mesmo jeito), pra poder decidir o próximo passo
 *   com dado real em vez de adivinhar. Nunca alteram nada.
 *
 * NAME_RESOLVERS: 5 ações (editar/remover) são identificadas por "id"
 * no banco, não por nome — e o modelo nunca vê um id, só nomes em
 * linguagem natural. Por isso essas ferramentas pedem um NOME pro
 * modelo, e lib/agent.js resolve nome → id (usando as mesmas buscas
 * que as ações já usavam) antes de montar a chain no formato que
 * runAction espera. O modelo nunca manipula um id diretamente.
 */

const MUTATING_TOOLS = [
  {
    name: 'criar_cliente',
    description: 'Cadastra um novo cliente. Use quando o empresário pedir para adicionar/cadastrar alguém como cliente.',
    input_schema: {
      type: 'object',
      properties: {
        nome: { type: 'string', description: 'Nome do cliente.' },
        whatsapp: { type: 'string', description: 'Número de WhatsApp do cliente, se foi mencionado.' }
      },
      required: ['nome']
    }
  },
  {
    name: 'editar_cliente',
    description: 'Atualiza dados de um cliente já cadastrado (nome e/ou WhatsApp).',
    input_schema: {
      type: 'object',
      properties: {
        clienteNome: { type: 'string', description: 'Nome do cliente a editar, como o empresário se referiu a ele.' },
        novoNome: { type: 'string', description: 'Novo nome, só se o empresário pediu para mudar o nome.' },
        novoWhatsapp: { type: 'string', description: 'Novo WhatsApp, só se o empresário pediu para mudar o número.' }
      },
      required: ['clienteNome']
    }
  },
  {
    name: 'criar_servico',
    description: 'Cadastra um novo serviço oferecido pela empresa, com preço e duração.',
    input_schema: {
      type: 'object',
      properties: {
        nome: { type: 'string', description: 'Nome do serviço.' },
        preco: { type: 'number', description: 'Preço em reais.' },
        duracao_min: { type: 'integer', description: 'Duração do serviço em minutos.' }
      },
      required: ['nome']
    }
  },
  {
    name: 'editar_servico',
    description: 'Atualiza nome, preço ou duração de um serviço já cadastrado.',
    input_schema: {
      type: 'object',
      properties: {
        servicoNome: { type: 'string', description: 'Nome do serviço a editar.' },
        novoNome: { type: 'string' },
        novoPreco: { type: 'number' },
        novaDuracaoMin: { type: 'integer' }
      },
      required: ['servicoNome']
    }
  },
  {
    name: 'remover_servico',
    description: 'Remove um serviço do catálogo da empresa.',
    input_schema: {
      type: 'object',
      properties: { servicoNome: { type: 'string', description: 'Nome do serviço a remover.' } },
      required: ['servicoNome']
    }
  },
  {
    name: 'criar_categoria_cardapio',
    description: 'Cria uma categoria do cardápio digital (ex: Lanches, Pizzas, Bebidas). Use quando o dono pedir para organizar/adicionar uma seção do cardápio.',
    input_schema: {
      type: 'object',
      properties: {
        nome: { type: 'string', description: 'Nome da categoria.' },
        ordem: { type: 'integer', description: 'Ordem de exibição, se mencionada.' }
      },
      required: ['nome']
    }
  },
  {
    name: 'criar_produto_cardapio',
    description: 'Adiciona um prato/lanche ao cardápio digital, com ingredientes, preço, foto e — quando informadas — as dimensões reais (usadas depois para projetar o prato em tamanho real via realidade aumentada na mesa do cliente). Só registre as dimensões se o dono realmente informou; nunca estime.',
    input_schema: {
      type: 'object',
      properties: {
        categoriaNome: { type: 'string', description: 'Categoria à qual o prato pertence, se mencionada.' },
        nome: { type: 'string', description: 'Nome do prato/lanche.' },
        descricao: { type: 'string', description: 'Descrição curta do prato.' },
        ingredientes: { type: 'string', description: 'Lista de ingredientes, como o dono descreveu.' },
        preco: { type: 'number', description: 'Preço em reais.' },
        foto: { type: 'string', description: 'Foto do prato (URL ou imagem em base64), se foi enviada.' },
        largura_cm: { type: 'number', description: 'Largura real do prato em centímetros, SÓ se o dono informou.' },
        altura_cm: { type: 'number', description: 'Altura real do prato em centímetros, SÓ se o dono informou.' },
        profundidade_cm: { type: 'number', description: 'Profundidade/comprimento real do prato em centímetros, SÓ se o dono informou.' }
      },
      required: ['nome']
    }
  },
  {
    name: 'editar_produto_cardapio',
    description: 'Atualiza dados de um prato já cadastrado no cardápio (preço, descrição, ingredientes, foto, disponibilidade ou dimensões).',
    input_schema: {
      type: 'object',
      properties: {
        produtoNome: { type: 'string', description: 'Nome do prato a editar.' },
        novoNome: { type: 'string' },
        novaDescricao: { type: 'string' },
        novosIngredientes: { type: 'string' },
        novoPreco: { type: 'number' },
        novaFoto: { type: 'string' },
        novaDisponibilidade: { type: 'boolean', description: 'true para disponível, false para esgotado/pausado.' },
        novaLarguraCm: { type: 'number' },
        novaAlturaCm: { type: 'number' },
        novaProfundidadeCm: { type: 'number' }
      },
      required: ['produtoNome']
    }
  },
  {
    name: 'remover_produto_cardapio',
    description: 'Remove um prato do cardápio digital.',
    input_schema: {
      type: 'object',
      properties: { produtoNome: { type: 'string', description: 'Nome do prato a remover.' } },
      required: ['produtoNome']
    }
  },
  {
    name: 'criar_mesa',
    description: 'Cadastra uma nova mesa do estabelecimento, gerando o QR Code de acesso ao cardápio digital dela.',
    input_schema: {
      type: 'object',
      properties: { nome: { type: 'string', description: 'Identificação da mesa, ex: "Mesa 5" ou "Varanda 2".' } },
      required: ['nome']
    }
  },
  {
    name: 'desativar_mesa',
    description: 'Desativa uma mesa (o QR Code dela para de funcionar).',
    input_schema: {
      type: 'object',
      properties: { mesaNome: { type: 'string', description: 'Identificação da mesa a desativar.' } },
      required: ['mesaNome']
    }
  },
  {
    name: 'criar_profissional',
    description: 'Cadastra um novo profissional/membro da equipe.',
    input_schema: {
      type: 'object',
      properties: { nome: { type: 'string', description: 'Nome do profissional.' } },
      required: ['nome']
    }
  },
  {
    name: 'editar_profissional',
    description: 'Atualiza o nome de um profissional já cadastrado.',
    input_schema: {
      type: 'object',
      properties: {
        profissionalNome: { type: 'string', description: 'Nome atual do profissional.' },
        novoNome: { type: 'string', description: 'Novo nome.' }
      },
      required: ['profissionalNome', 'novoNome']
    }
  },
  {
    name: 'remover_profissional',
    description: 'Remove um profissional da equipe.',
    input_schema: {
      type: 'object',
      properties: { profissionalNome: { type: 'string' } },
      required: ['profissionalNome']
    }
  },
  {
    name: 'criar_agendamento',
    description: 'Marca um novo horário/agendamento para um cliente. Use para qualquer pedido de marcar, agendar, encaixar, colocar na agenda, reservar horário etc.',
    input_schema: {
      type: 'object',
      properties: {
        clienteNome: { type: 'string', description: 'Nome do cliente.' },
        servicoNome: { type: 'string', description: 'Nome do serviço, se mencionado. Se não for mencionado, deixe de fora — o sistema usa o serviço padrão.' },
        profissionalNome: { type: 'string', description: 'Profissional específico, se mencionado.' },
        data: { type: 'string', description: 'Data no formato AAAA-MM-DD, calculada a partir da data de referência informada no início da conversa.' },
        hora: { type: 'string', description: 'Hora no formato HH:MM (24h).' }
      },
      required: ['clienteNome', 'data', 'hora']
    }
  },
  {
    name: 'cancelar_agendamento',
    description: 'Cancela um agendamento existente de um cliente.',
    input_schema: {
      type: 'object',
      properties: {
        clienteNome: { type: 'string' },
        data: { type: 'string', description: 'AAAA-MM-DD, se mencionado.' },
        hora: { type: 'string', description: 'HH:MM, se mencionado.' }
      },
      required: ['clienteNome']
    }
  },
  {
    name: 'reagendar_agendamento',
    description: 'Move um agendamento existente de um cliente para uma nova data/hora.',
    input_schema: {
      type: 'object',
      properties: {
        clienteNome: { type: 'string' },
        novaData: { type: 'string', description: 'AAAA-MM-DD' },
        novaHora: { type: 'string', description: 'HH:MM' }
      },
      required: ['clienteNome']
    }
  },
  {
    name: 'criar_automacao',
    description: 'Cria e ativa uma nova automação (ex: lembrete automático, confirmação automática). Só o dono da empresa pode fazer isso — se o usuário atual não puder, o backend já bloqueia.',
    input_schema: {
      type: 'object',
      properties: { label: { type: 'string', description: 'Nome/descrição da automação.' } },
      required: ['label']
    }
  },
  {
    name: 'enviar_whatsapp',
    description: 'Manda uma mensagem de WhatsApp (simulado) para um cliente.',
    input_schema: {
      type: 'object',
      properties: {
        clienteNome: { type: 'string', description: 'Para quem mandar. Se o usuário se referiu a alguém por pronome (ela/ele) e o nome está claro pela conversa, use o nome resolvido, não o pronome.' },
        mensagem: { type: 'string', description: 'Texto da mensagem. Se o empresário não disse o texto exato, componha uma mensagem curta e educada com a intenção dele.' }
      },
      required: ['clienteNome', 'mensagem']
    }
  },
  {
    name: 'criar_cobranca_pix',
    description: 'Cria uma cobrança Pix (simulada) para um cliente.',
    input_schema: {
      type: 'object',
      properties: {
        clienteNome: { type: 'string' },
        valor: { type: 'number', description: 'Valor em reais.' }
      },
      required: ['clienteNome', 'valor']
    }
  }
];

const READONLY_TOOLS = [
  {
    name: 'buscar_clientes',
    description: 'Procura clientes pelo nome (ou parte dele) e devolve TODOS os que baterem — use isso antes de agir sobre um cliente sempre que houver qualquer chance de existir mais de um com nome parecido, para checar ambiguidade antes de agendar/cancelar/mandar mensagem.',
    input_schema: {
      type: 'object',
      properties: { nome: { type: 'string' } },
      required: ['nome']
    }
  },
  {
    name: 'consultar_agenda',
    description: 'Consulta os horários agendados em uma data.',
    input_schema: {
      type: 'object',
      properties: { data: { type: 'string', description: 'AAAA-MM-DD' } },
      required: ['data']
    }
  },
  {
    name: 'consultar_servicos',
    description: 'Lista os serviços oferecidos pela empresa.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'consultar_precos',
    description: 'Consulta o preço de um serviço específico.',
    input_schema: {
      type: 'object',
      properties: { servicoNome: { type: 'string' } },
      required: ['servicoNome']
    }
  },
  {
    name: 'consultar_pagamento',
    description: 'Consulta o status do pagamento/cobrança mais recente de um cliente.',
    input_schema: {
      type: 'object',
      properties: { clienteNome: { type: 'string' } },
      required: ['clienteNome']
    }
  },
  {
    name: 'consultar_cardapio',
    description: 'Lista os pratos/lanches cadastrados no cardápio digital, com categoria, preço e disponibilidade.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'consultar_mesas',
    description: 'Lista as mesas cadastradas e se estão ativas.',
    input_schema: { type: 'object', properties: {} }
  }
];

const TOOLS = [...MUTATING_TOOLS, ...READONLY_TOOLS];
const MUTATING_ACTIONS = MUTATING_TOOLS.map(t => t.name);
const READONLY_ACTIONS = READONLY_TOOLS.map(t => t.name);

/* nome → id: as únicas 5 ferramentas identificadas por uma entidade que
   precisa virar "id" antes de chegar em runAction. O modelo só fornece
   o nome; lib/agent.js faz essa resolução usando as mesmas buscas que
   as ações já usavam por baixo (db.findCustomerByName etc.) — nunca
   inventa nem aceita um id vindo do modelo. */
const NAME_RESOLVERS = {
  editar_cliente: {
    nameParam: 'clienteNome', entidade: 'cliente',
    find: (db, businessId, nome) => db.findCustomerByName(businessId, nome),
    changes: (input) => {
      const c = {};
      if (input.novoNome) c.nome = input.novoNome;
      if (input.novoWhatsapp) c.whatsapp = input.novoWhatsapp;
      return c;
    }
  },
  editar_servico: {
    nameParam: 'servicoNome', entidade: 'serviço',
    find: (db, businessId, nome) => db.findServiceByName(businessId, nome),
    changes: (input) => {
      const c = {};
      if (input.novoNome) c.nome = input.novoNome;
      if (input.novoPreco !== undefined) c.preco = input.novoPreco;
      if (input.novaDuracaoMin !== undefined) c.duracao_min = input.novaDuracaoMin;
      return c;
    }
  },
  remover_servico: {
    nameParam: 'servicoNome', entidade: 'serviço',
    find: (db, businessId, nome) => db.findServiceByName(businessId, nome),
    changes: () => ({})
  },
  editar_profissional: {
    nameParam: 'profissionalNome', entidade: 'profissional',
    find: (db, businessId, nome) => db.findProfessionalByName(businessId, nome),
    changes: (input) => (input.novoNome ? { nome: input.novoNome } : {})
  },
  remover_profissional: {
    nameParam: 'profissionalNome', entidade: 'profissional',
    find: (db, businessId, nome) => db.findProfessionalByName(businessId, nome),
    changes: () => ({})
  },
  editar_produto_cardapio: {
    nameParam: 'produtoNome', entidade: 'prato',
    find: (db, businessId, nome) => db.findMenuProductByName(businessId, nome),
    changes: (input) => {
      const c = {};
      if (input.novoNome) c.nome = input.novoNome;
      if (input.novaDescricao !== undefined) c.descricao = input.novaDescricao;
      if (input.novosIngredientes !== undefined) c.ingredientes = input.novosIngredientes;
      if (input.novoPreco !== undefined) c.preco = input.novoPreco;
      if (input.novaFoto !== undefined) c.foto = input.novaFoto;
      if (input.novaDisponibilidade !== undefined) c.disponivel = input.novaDisponibilidade;
      if (input.novaLarguraCm !== undefined) c.largura_cm = input.novaLarguraCm;
      if (input.novaAlturaCm !== undefined) c.altura_cm = input.novaAlturaCm;
      if (input.novaProfundidadeCm !== undefined) c.profundidade_cm = input.novaProfundidadeCm;
      return c;
    }
  },
  remover_produto_cardapio: {
    nameParam: 'produtoNome', entidade: 'prato',
    find: (db, businessId, nome) => db.findMenuProductByName(businessId, nome),
    changes: () => ({})
  },
  desativar_mesa: {
    nameParam: 'mesaNome', entidade: 'mesa',
    find: (db, businessId, nome) => db.findMenuTableByName(businessId, nome),
    changes: () => ({})
  }
};

module.exports = { TOOLS, MUTATING_ACTIONS, READONLY_ACTIONS, NAME_RESOLVERS };
