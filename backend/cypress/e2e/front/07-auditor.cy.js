import { SESSOES } from '../../support/dados';
import { respostaAuditoria } from '../../support/telas';

const ESTATISTICAS = { totalTransacoes: 1234, registrosInativos: 7, violacoes24h: 2 };
const resposta = (logs, estatisticas = ESTATISTICAS, paginacao = {}) =>
  respostaAuditoria(logs, { estatisticas, ...paginacao });

const log = (o = {}) => ({ id: 1, acao: 'ADICAO_VAGAS', descricao: 'ok', usuario: 'Prof. Carlos', ip: '10.0.0.1', data_hora: '2030-05-20T15:30:00.000Z', ...o });

function abrir(corpo, status = 200) {
  cy.stubApiGeral();
  cy.mockApi('GET', '/api/admin/auditoria-completa', corpo, { status, alias: 'auditoria' });
  cy.abrirPagina('auditHome.html', SESSOES.audit);
  cy.wait('@auditoria');
}

// troca a resposta simulada das próximas chamadas (a definição mais nova tem prioridade)
const simular = (corpo, alias, status = 200) =>
  cy.mockApi('GET', '/api/admin/auditoria-completa', corpo, { status, alias });

// Escolhe uma data como o navegador faz: valor completo + evento "change" na hora.
// Não use cy.type() aqui: em <input type="date"> o Cypress grava o valor e dispara só "input";
// o "change" fica pendente até o PRÓXIMO comando que interage com a página (ou um blur),
// então a tela não recebe o "change" a tempo do cy.wait() e o próximo comando ainda dispara um "change" atrasado.
const escolherData = (seletor, valor) =>
  cy.get(seletor).invoke('val', valor).trigger('change').should('have.value', valor);

describe('Auditoria (perfil AUDIT)', () => {
  it('mostra o usuário logado no cabeçalho', () => {
    abrir(resposta([]));
    cy.get('#userName').should('have.text', 'Auditor Geral');
    // padrão M03: a bolinha mostra só a inicial, como nas outras telas (antes eram 2 letras: "AU")
    cy.get('#userAvatar').should('have.text', 'A');
  });

  it('tem o cartão de título com nome e matrícula, no mesmo padrão das outras telas', () => {
    abrir(resposta([]));
    cy.get('main > div').first().should('have.class', 'cartao-titulo');
    cy.get('#tituloAvatar').should('have.text', 'A');
    cy.get('#tituloNome').should('have.text', 'Auditor Geral');
    cy.get('#tituloMatricula').should('have.text', 'Matrícula TESTE_AUDIT').and('have.class', 'font-mono');
  });

  it('preenche os três contadores e marca o banco como OK', () => {
    abrir(resposta([log()]));
    cy.get('#statTotalTransacoes').should('have.text', '1.234');
    cy.get('#statRegistrosInativos').should('have.text', '7');
    cy.get('#statViolacoes').should('have.text', '2');
    cy.get('#dbStatusTexto').should('have.text', 'Banco de dados: conectado');
    cy.get('#dbStatusDot').should('have.class', 'bg-emerald-500');
  });

  it('lista os logs com data no fuso de São Paulo, usuário, ação, IP e detalhes', () => {
    abrir(resposta([log({ data_hora: '2030-05-20T15:30:00.000Z' })]));
    cy.get('#auditTable tbody tr').should('have.length', 1).first().within(() => {
      cy.contains('20/05/2030, 12:30:00'); // 15:30 UTC = 12:30 em São Paulo
      cy.contains('Prof. Carlos');
      cy.contains('ADICAO_VAGAS');
      cy.contains('10.0.0.1');
    });
  });

  // a API devolve data_hora em UTC (ISO com "Z") e a tela mostra no fuso de São Paulo:
  // o rótulo da coluna precisa dizer Brasília, não UTC
  it('a coluna de data diz "Data e hora (Brasília)" e não "UTC"', () => {
    abrir(resposta([log()]));
    cy.get('#auditTable thead th').first().should('have.text', 'Data e hora (Brasília)');
    cy.get('#auditTable thead').should('not.contain.text', 'UTC');
  });

  it('log sem usuário aparece como "sistema"', () => {
    abrir(resposta([log({ usuario: null })]));
    cy.get('#auditTable tbody').should('contain.text', 'sistema');
  });

  it('classifica as ações: ATIVO, INATIVO, BLOQUEADO e FALHA', () => {
    abrir(resposta([
      log({ id: 1, acao: 'ADICAO_VAGAS' }),
      log({ id: 2, acao: 'CANCELAMENTO_REALIZADO' }),
      log({ id: 3, acao: 'CANCELAMENTO_BLOQUEADO' }),
      log({ id: 4, acao: 'LOGIN_FALHA' })
    ]));
    cy.contains('tr', 'ADICAO_VAGAS').should('contain.text', 'ATIVO');
    cy.contains('tr', 'CANCELAMENTO_REALIZADO').should('contain.text', 'INATIVO');
    cy.contains('tr', 'CANCELAMENTO_BLOQUEADO').should('contain.text', 'BLOQUEADO').and('not.contain.text', 'INATIVO');
    cy.contains('tr', 'LOGIN_FALHA').should('contain.text', 'FALHA');
  });

  // a busca agora é feita no servidor: o teste confere o que a tela pediu e simula a resposta filtrada
  it('filtra a tabela pela caixa de busca', () => {
    const todos = [log({ id: 1, descricao: 'vagas de ML' }), log({ id: 2, acao: 'LOGIN_FALHA', usuario: null, ip: '8.8.8.8' })];
    abrir(resposta(todos));
    simular(resposta([todos[1]]), 'busca');
    cy.get('#searchInput').type('8.8.8.8');
    cy.wait('@busca').its('request.query').should('deep.equal', { page: '1', busca: '8.8.8.8' });
    cy.get('#auditTable tbody tr:visible').should('have.length', 1).and('contain.text', 'LOGIN_FALHA');
    simular(resposta(todos), 'semBusca');
    cy.get('#searchInput').clear();
    cy.wait('@semBusca').its('request.query').should('deep.equal', { page: '1' });
    cy.get('#auditTable tbody tr:visible').should('have.length', 2);
  });

  it('sem logs mostra mensagem', () => {
    abrir(resposta([]));
    cy.contains('Nenhum log registrado até o momento.');
  });

  it('erro do servidor marca o banco como ERRO e avisa na tabela', () => {
    abrir({ sucesso: false, mensagem: 'Erro interno ao carregar logs de auditoria.' }, 500);
    cy.get('#dbStatusTexto').should('have.text', 'Banco de dados: fora do ar');
    cy.get('#dbStatusDot').should('have.class', 'bg-rose-500');
    cy.contains('Erro ao carregar os logs do servidor.');
  });

  it('textos com HTML nos logs não executam', () => {
    abrir(resposta([log({ descricao: '<img src=x onerror="window.__xss=1">', usuario: '<b>x</b>' })]));
    cy.get('#auditTable img').should('not.exist');
    cy.get('#auditTable b').should('not.exist');
    cy.window().its('__xss').should('not.exist');
  });
});

describe('Auditoria (perfil AUDIT): filtros no servidor', () => {
  it('ao abrir pede a página 1 sem filtros', () => {
    abrir(resposta([log()]));
    cy.get('@auditoria').its('request.query').should('deep.equal', { page: '1' });
  });

  it('tem filtros de data inicial, data final, IP e tipo de ação (com as ações de segurança)', () => {
    abrir(resposta([]));
    cy.get('#filtroDataInicio').should('have.attr', 'type', 'date');
    cy.get('#filtroDataFim').should('have.attr', 'type', 'date');
    cy.get('#filtroIp').should('exist');
    ['LOGIN_FALHA', 'CANCELAMENTO_BLOQUEADO', 'REAGENDAMENTO_BLOQUEADO', 'SOFT_DELETE', 'LANÇAMENTO_NOTA', 'COMPROVANTE_EMITIDO'].forEach((acao) => {
      cy.get(`#filtroAcao option[value="${acao}"]`).should('exist');
    });
  });

  it('cada filtro vai para o servidor e se soma aos anteriores', () => {
    abrir(resposta([log()]));
    simular(resposta([log()]), 'acao');
    cy.get('#filtroAcao').select('LOGIN_FALHA');
    cy.wait('@acao').its('request.query').should('deep.equal', { page: '1', acao: 'LOGIN_FALHA' });

    simular(resposta([log()]), 'inicio');
    escolherData('#filtroDataInicio', '2030-05-01');
    cy.wait('@inicio').its('request.query').should('deep.equal', { page: '1', acao: 'LOGIN_FALHA', data_inicio: '2030-05-01' });

    simular(resposta([log()]), 'fim');
    escolherData('#filtroDataFim', '2030-05-31');
    cy.wait('@fim').its('request.query').should('deep.include', { data_inicio: '2030-05-01', data_fim: '2030-05-31' });

    simular(resposta([log({ ip: '10.0.0.9' })]), 'ip');
    cy.get('#filtroIp').type('10.0.0');
    cy.wait('@ip').its('request.query').should('deep.equal', {
      page: '1', acao: 'LOGIN_FALHA', data_inicio: '2030-05-01', data_fim: '2030-05-31', ip: '10.0.0'
    });
    cy.get('#auditTable tbody tr').should('have.length', 1).and('contain.text', '10.0.0.9');
  });

  it('com filtro e sem resultado mostra a mensagem de filtro (não a de "nenhum log")', () => {
    abrir(resposta([log()]));
    simular(resposta([]), 'vazio');
    cy.get('#filtroIp').type('1.2.3.4');
    cy.wait('@vazio');
    cy.contains('Nenhum log encontrado com os filtros selecionados.');
    cy.contains('Nenhum log registrado até o momento.').should('not.exist');
  });

  it('erro de validação (400) aparece na tabela, sem marcar o banco como fora do ar', () => {
    abrir(resposta([log()]));
    simular({ sucesso: false, mensagem: 'A data inicial não pode ser depois da data final.' }, 'invalido', 400);
    escolherData('#filtroDataInicio', '2030-05-10');
    cy.wait('@invalido');
    cy.get('#auditTable tbody').should('contain.text', 'A data inicial não pode ser depois da data final.');
    cy.get('#dbStatusTexto').should('have.text', 'Banco de dados: conectado');
    cy.get('#auditoriaAnterior').should('be.disabled');
    cy.get('#auditoriaProxima').should('be.disabled');
  });

  it('mensagem de erro do servidor com HTML é exibida como texto', () => {
    abrir(resposta([log()]));
    simular({ sucesso: false, mensagem: '<img src=x onerror="window.__xss=1">' }, 'invalido', 400);
    cy.get('#filtroIp').type('1');
    cy.wait('@invalido');
    cy.get('#auditTable img').should('not.exist');
    cy.window().its('__xss').should('not.exist');
  });

  it('"Limpar filtros" apaga todos os campos e recarrega a página 1 sem filtros', () => {
    abrir(resposta([log()]));
    simular(resposta([log()]), 'filtrado');
    cy.get('#filtroAcao').select('SOFT_DELETE');
    cy.wait('@filtrado');
    // preenche sem disparar eventos; só a digitação da busca gera a próxima chamada (com tudo junto)
    cy.get('#filtroIp').invoke('val', '10.0');
    cy.get('#filtroDataInicio').invoke('val', '2030-05-01');
    cy.get('#filtroDataFim').invoke('val', '2030-05-31');
    cy.get('#searchInput').type('Carlos');
    cy.wait('@filtrado').its('request.query').should('deep.equal', {
      page: '1', busca: 'Carlos', acao: 'SOFT_DELETE', ip: '10.0', data_inicio: '2030-05-01', data_fim: '2030-05-31'
    });

    simular(resposta([log()]), 'limpo');
    cy.get('#btnLimparFiltros').click();
    cy.wait('@limpo').its('request.query').should('deep.equal', { page: '1' });
    ['#searchInput', '#filtroDataInicio', '#filtroDataFim', '#filtroIp', '#filtroAcao'].forEach((sel) => {
      cy.get(sel).should('have.value', '');
    });
  });
});

describe('Auditoria (perfil AUDIT): paginação', () => {
  const pagina = (n, totalPaginas = 3, total = 120) => resposta([log({ id: n, descricao: `log ${n}` })], ESTATISTICAS, { pagina: n, total, totalPaginas });

  it('uma página só: "Página 1 de 1" e os dois botões desativados', () => {
    abrir(resposta([log()]));
    cy.get('#auditoriaPaginaInfo').should('have.text', 'Página 1 de 1');
    cy.get('#auditoriaTotal').should('have.text', '1 registro');
    cy.get('#auditoriaAnterior').should('be.disabled');
    cy.get('#auditoriaProxima').should('be.disabled');
  });

  it('Próxima e Anterior navegam e mostram "Página X de Y"', () => {
    abrir(pagina(1));
    cy.get('#auditoriaPaginaInfo').should('have.text', 'Página 1 de 3');
    cy.get('#auditoriaTotal').should('have.text', '120 registros');
    cy.get('#auditoriaAnterior').should('be.disabled');

    simular(pagina(2), 'p2');
    cy.get('#auditoriaProxima').should('be.enabled').click();
    cy.wait('@p2').its('request.query.page').should('eq', '2');
    cy.get('#auditoriaPaginaInfo').should('have.text', 'Página 2 de 3');
    cy.get('#auditTable tbody').should('contain.text', 'log 2');
    cy.get('#auditoriaAnterior').should('be.enabled');

    simular(pagina(3), 'p3');
    cy.get('#auditoriaProxima').click();
    cy.wait('@p3').its('request.query.page').should('eq', '3');
    cy.get('#auditoriaPaginaInfo').should('have.text', 'Página 3 de 3');
    cy.get('#auditoriaProxima').should('be.disabled');

    simular(pagina(2), 'volta');
    cy.get('#auditoriaAnterior').click();
    cy.wait('@volta').its('request.query.page').should('eq', '2');
    cy.get('#auditoriaPaginaInfo').should('have.text', 'Página 2 de 3');
  });

  it('mudar um filtro volta para a página 1; a paginação mantém o filtro', () => {
    abrir(pagina(1));
    simular(pagina(2), 'p2');
    cy.get('#auditoriaProxima').click();
    cy.wait('@p2');

    simular(pagina(1, 2, 60), 'filtro');
    cy.get('#filtroAcao').select('LOGIN_FALHA');
    cy.wait('@filtro').its('request.query').should('deep.equal', { page: '1', acao: 'LOGIN_FALHA' });
    cy.get('#auditoriaPaginaInfo').should('have.text', 'Página 1 de 2');

    simular(pagina(2, 2, 60), 'filtroP2');
    cy.get('#auditoriaProxima').click();
    cy.wait('@filtroP2').its('request.query').should('deep.equal', { page: '2', acao: 'LOGIN_FALHA' });
  });

  it('os contadores do topo vêm do servidor (sobre todos os registros), mesmo com filtro e em outra página', () => {
    abrir(pagina(1));
    cy.get('#statTotalTransacoes').should('have.text', '1.234');
    simular(resposta([log()], ESTATISTICAS, { total: 1, totalPaginas: 1 }), 'filtro');
    cy.get('#filtroAcao').select('SOFT_DELETE');
    cy.wait('@filtro');
    cy.get('#auditoriaTotal').should('have.text', '1 registro');
    cy.get('#statTotalTransacoes').should('have.text', '1.234');
    cy.get('#statRegistrosInativos').should('have.text', '7');
    cy.get('#statViolacoes').should('have.text', '2');
  });

  it('erro do servidor trava a paginação', () => {
    abrir(pagina(1));
    simular({ sucesso: false, mensagem: 'Erro interno.' }, 'erro', 500);
    cy.get('#auditoriaProxima').click();
    cy.wait('@erro');
    cy.contains('Erro ao carregar os logs do servidor.');
    cy.get('#auditoriaProxima').should('be.disabled');
    cy.get('#auditoriaAnterior').should('be.disabled');
  });
});

// Correções encontradas no teste exploratório do perfil AUDITOR (A1, A2, A3, A4)
describe('Auditoria (perfil AUDIT): correções do teste exploratório', () => {
  // A1: o status é calculado na tela a partir do nome da ação; SOFT_DELETE (exclusão de usuário) aparecia como ATIVO verde
  it('A1: SOFT_DELETE aparece como "INATIVADO" em cor neutra; as demais ações seguem como antes', () => {
    abrir(resposta([
      log({ id: 1, acao: 'SOFT_DELETE', descricao: 'Usuário excluído: Fulano' }),
      log({ id: 2, acao: 'ADICAO_VAGAS' }),
      log({ id: 3, acao: 'REATIVACAO_USUARIO' }),
      log({ id: 4, acao: 'CONFIRMACAO_ENTRADA' }),
      log({ id: 5, acao: 'CANCELAMENTO_REALIZADO' })
    ]));
    cy.contains('tr', 'SOFT_DELETE').find('td').eq(3).find('span')
      .should('have.text', 'INATIVADO')
      .and('have.class', 'bg-slate-700/80')
      .and('not.have.class', 'bg-emerald-950/80');
    ['ADICAO_VAGAS', 'REATIVACAO_USUARIO', 'CONFIRMACAO_ENTRADA'].forEach((acao) => {
      cy.contains('tr', acao).find('td').eq(3).find('span').should('have.text', 'ATIVO').and('have.class', 'bg-emerald-950/80');
    });
    cy.contains('tr', 'CANCELAMENTO_REALIZADO').find('td').eq(3).should('have.text', 'INATIVO');
  });

  it('A3: logins recusados aparecem como "RECUSADO" em vermelho (não como inativação)', () => {
    abrir(resposta([
      log({ id: 1, acao: 'LOGIN_RECUSADO_CONTA_INATIVA' }),
      log({ id: 2, acao: 'LOGIN_RECUSADO_TROCA_SENHA' })
    ]));
    ['LOGIN_RECUSADO_CONTA_INATIVA', 'LOGIN_RECUSADO_TROCA_SENHA'].forEach((acao) => {
      cy.contains('tr', acao).find('td').eq(3).find('span').should('have.text', 'RECUSADO').and('have.class', 'bg-rose-950/80');
    });
  });

  it('A3: o filtro de ação lista as ações novas de login recusado e as envia ao servidor', () => {
    abrir(resposta([log()]));
    cy.get('#filtroAcao option[value="LOGIN_RECUSADO_CONTA_INATIVA"]').should('exist');
    cy.get('#filtroAcao option[value="LOGIN_RECUSADO_TROCA_SENHA"]').should('exist');
    simular(resposta([log({ acao: 'LOGIN_RECUSADO_CONTA_INATIVA' })]), 'acao');
    cy.get('#filtroAcao').select('LOGIN_RECUSADO_CONTA_INATIVA');
    cy.wait('@acao').its('request.query').should('deep.equal', { page: '1', acao: 'LOGIN_RECUSADO_CONTA_INATIVA' });
  });

  const pagina1de250 = () => resposta([log()], ESTATISTICAS, { pagina: 1, total: 12478, totalPaginas: 250 });

  it('A2: depois de erro de validação (400) o rodapé mostra "—" e a paginação fica travada', () => {
    abrir(pagina1de250());
    cy.get('#auditoriaTotal').should('have.text', '12.478 registros');
    cy.get('#auditoriaPaginaInfo').should('have.text', 'Página 1 de 250');
    cy.get('#auditoriaProxima').should('be.enabled');

    simular({ sucesso: false, mensagem: 'A data inicial não pode ser depois da data final.' }, 'invalido', 400);
    escolherData('#filtroDataInicio', '2030-05-10');
    cy.wait('@invalido');
    cy.get('#auditoriaTotal').should('have.text', '—');
    cy.get('#auditoriaPaginaInfo').should('have.text', '—');
    cy.get('#auditoriaAnterior').should('be.disabled');
    cy.get('#auditoriaProxima').should('be.disabled');

    // a próxima busca bem-sucedida volta a preencher o rodapé
    simular(resposta([log()], ESTATISTICAS, { pagina: 1, total: 120, totalPaginas: 3 }), 'ok');
    cy.get('#btnLimparFiltros').click();
    cy.wait('@ok');
    cy.get('#auditoriaTotal').should('have.text', '120 registros');
    cy.get('#auditoriaPaginaInfo').should('have.text', 'Página 1 de 3');
    cy.get('#auditoriaProxima').should('be.enabled');
  });

  it('A2: com a API fora do ar (falha de rede) o rodapé mostra "—" e a paginação fica travada', () => {
    abrir(pagina1de250());
    cy.get('#auditoriaTotal').should('have.text', '12.478 registros');
    cy.intercept({ method: 'GET', pathname: '/api/admin/auditoria-completa' }, { forceNetworkError: true }).as('foraDoAr');
    cy.get('#auditoriaProxima').click();
    cy.wait('@foraDoAr');
    cy.contains('Erro ao carregar os logs do servidor.');
    cy.get('#dbStatusTexto').should('have.text', 'Banco de dados: fora do ar');
    cy.get('#auditoriaTotal').should('have.text', '—');
    cy.get('#auditoriaPaginaInfo').should('have.text', '—');
    cy.get('#auditoriaAnterior').should('be.disabled');
    cy.get('#auditoriaProxima').should('be.disabled');
  });

  it('A2: erro 500 também limpa o rodapé', () => {
    abrir(pagina1de250());
    simular({ sucesso: false, mensagem: 'Erro interno.' }, 'erro', 500);
    cy.get('#auditoriaProxima').click();
    cy.wait('@erro');
    cy.get('#auditoriaTotal').should('have.text', '—');
    cy.get('#auditoriaPaginaInfo').should('have.text', '—');
  });

  it('A4: a confirmação de entrada com matrícula e disciplina é exibida como texto (escapeHtml)', () => {
    const descricao = 'Portaria confirmou entrada do aluno <b>Ana</b> (2030123) na prova de <img src=x onerror="window.__xss=1"> (2030-05-20 08:00) (Ticket #7)';
    abrir(resposta([log({ acao: 'CONFIRMACAO_ENTRADA', descricao })]));
    cy.contains('tr', 'CONFIRMACAO_ENTRADA').should('contain.text', descricao);
    cy.get('#auditTable img').should('not.exist');
    cy.get('#auditTable b').should('not.exist');
    cy.window().its('__xss').should('not.exist');
  });

  it('A4: buscar pela matrícula com a ação CONFIRMACAO_ENTRADA envia os dois filtros ao servidor', () => {
    abrir(resposta([log()]));
    simular(resposta([log()]), 'acao');
    cy.get('#filtroAcao').select('CONFIRMACAO_ENTRADA');
    cy.wait('@acao');
    simular(resposta([log({ acao: 'CONFIRMACAO_ENTRADA', descricao: 'Portaria confirmou entrada do aluno Ana (2030123) na prova de X (2030-05-20 08:00) (Ticket #7)' })]), 'busca');
    cy.get('#searchInput').type('2030123');
    cy.wait('@busca').its('request.query').should('deep.equal', { page: '1', busca: '2030123', acao: 'CONFIRMACAO_ENTRADA' });
    cy.get('#auditTable tbody tr').should('have.length', 1).and('contain.text', '2030123');
  });
});
