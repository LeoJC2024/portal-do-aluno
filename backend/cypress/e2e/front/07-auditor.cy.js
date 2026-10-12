import { SESSOES } from '../../support/dados';

const resposta = (logs, estatisticas = { totalTransacoes: 1234, registrosInativos: 7, violacoes24h: 2 }) =>
  ({ sucesso: true, estatisticas, logs });

const log = (o = {}) => ({ id: 1, acao: 'ADICAO_VAGAS', descricao: 'ok', usuario: 'Prof. Carlos', ip: '10.0.0.1', data_hora: '2030-05-20T15:30:00.000Z', ...o });

function abrir(corpo, status = 200) {
  cy.stubApiGeral();
  cy.mockApi('GET', '/api/admin/auditoria-completa', corpo, { status, alias: 'auditoria' });
  cy.abrirPagina('auditHome.html', SESSOES.audit);
  cy.wait('@auditoria');
}

describe('Auditoria (perfil AUDIT)', () => {
  it('mostra o usuário logado no cabeçalho', () => {
    abrir(resposta([]));
    cy.get('#userName').should('have.text', 'Auditor Geral');
    cy.get('#userAvatar').should('have.text', 'AU');
  });

  it('preenche os três contadores e marca o banco como OK', () => {
    abrir(resposta([log()]));
    cy.get('#statTotalTransacoes').should('have.text', '1.234');
    cy.get('#statRegistrosInativos').should('have.text', '7');
    cy.get('#statViolacoes').should('have.text', '2');
    cy.get('#dbStatusTexto').should('have.text', 'DB Status: OK');
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

  it('filtra a tabela pela caixa de busca', () => {
    abrir(resposta([log({ id: 1, descricao: 'vagas de ML' }), log({ id: 2, acao: 'LOGIN_FALHA', usuario: null, ip: '8.8.8.8' })]));
    cy.get('#searchInput').type('8.8.8.8');
    cy.get('#auditTable tbody tr:visible').should('have.length', 1).and('contain.text', 'LOGIN_FALHA');
    cy.get('#searchInput').clear();
    cy.get('#auditTable tbody tr:visible').should('have.length', 2);
  });

  it('sem logs mostra mensagem', () => {
    abrir(resposta([]));
    cy.contains('Nenhum log registrado até o momento.');
  });

  it('erro do servidor marca o banco como ERRO e avisa na tabela', () => {
    abrir({ sucesso: false, mensagem: 'Erro interno ao carregar logs de auditoria.' }, 500);
    cy.get('#dbStatusTexto').should('have.text', 'DB Status: ERRO');
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
