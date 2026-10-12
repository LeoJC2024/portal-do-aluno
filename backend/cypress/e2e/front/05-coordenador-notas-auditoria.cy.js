import { abrirCoordenador, irParaAba } from '../../support/telas';

const nota = (o = {}) => ({ id: 1, nome_aluno: 'Leonardo José', matricula: 'E00001', avaliacao: 'Machine Learning (A2)', polo: 'Resende', nota: '9.50', ...o });

describe('Coordenação: sincronização de notas', () => {
  it('mostra mensagem quando não há notas', () => {
    abrirCoordenador();
    irParaAba('sincronizacao');
    cy.contains('Nenhuma nota cadastrada.');
  });

  it('erro do servidor aparece na tabela', () => {
    cy.stubApiGeral();
    cy.mockApi('GET', '/api/notas', { sucesso: false }, { status: 500, alias: 'notas' });
    cy.abrirPagina('coordenadorHome.html', { unifaa_token: 't', usuario_nome: 'C', usuario_curso: 'X', usuario_perfil: 'coordenador', usuario_matricula: 'C1' });
    irParaAba('sincronizacao');
    cy.contains('Erro ao carregar as notas do servidor.');
  });

  it('lista as notas com aluno, matrícula, avaliação, polo e o campo de nota', () => {
    abrirCoordenador({ notas: [nota(), nota({ id: 2, nome_aluno: 'Ana', matricula: 'E00002', nota: null })] });
    irParaAba('sincronizacao');
    cy.get('#page-sincronizacao tbody tr').should('have.length', 2);
    cy.contains('#page-sincronizacao tr', 'Leonardo José').should('contain.text', 'E00001').and('contain.text', 'Resende');
    cy.get('#nota-1').should('have.value', '9.50');
    cy.get('#nota-2').should('have.value', '');
  });

  it('salva uma nota válida enviando {id, nota} e atualiza a auditoria', () => {
    abrirCoordenador({ notas: [nota()] });
    cy.mockApi('POST', '/api/atualizar-nota', { sucesso: true, mensagem: 'Nota salva com sucesso!' }, { alias: 'salvar' });
    irParaAba('sincronizacao');
    cy.get('#nota-1').clear().type('8.5');
    cy.get('[data-salvar-nota="1"]').click();

    cy.wait('@salvar').its('request.body').should('deep.equal', { id: 1, nota: 8.5 });
    cy.swal('Salvo!', 'Nota salva com sucesso!');
    cy.wait('@logs');
  });

  ['11', '-1', ''].forEach((valor) => {
    it(`recusa nota "${valor || '(vazia)'}" na tela, sem chamar o servidor`, () => {
      abrirCoordenador({ notas: [nota()] });
      cy.mockApi('POST', '/api/atualizar-nota', {}, { alias: 'salvar' });
      irParaAba('sincronizacao');
      cy.get('#nota-1').clear();
      if (valor) cy.get('#nota-1').type(valor);
      cy.get('[data-salvar-nota="1"]').click();
      cy.swal('Atenção', 'Informe uma nota entre 0 e 10.');
      cy.get('@salvar.all').should('have.length', 0);
    });
  });

  it('mostra a mensagem quando o servidor recusa', () => {
    abrirCoordenador({ notas: [nota()] });
    cy.mockApi('POST', '/api/atualizar-nota', { sucesso: false, mensagem: 'Registro de nota não encontrado.' }, { status: 404 });
    irParaAba('sincronizacao');
    cy.get('[data-salvar-nota="1"]').click();
    cy.swal('Atenção', 'não encontrado');
  });

  it('"Recarregar notas" busca de novo no servidor', () => {
    abrirCoordenador({ notas: [nota()] });
    irParaAba('sincronizacao');
    cy.wait('@notas');
    cy.contains('button', 'Recarregar notas').click();
    cy.wait('@notas');
  });

  it('não existe mais o botão/alerta falso de importação', () => {
    abrirCoordenador();
    irParaAba('sincronizacao');
    cy.contains('Importação Dinâmica').should('not.exist');
  });

  it('nome com HTML na tabela não executa', () => {
    abrirCoordenador({ notas: [nota({ nome_aluno: '<img src=x onerror="window.__xss=1">' })] });
    irParaAba('sincronizacao');
    cy.get('#page-sincronizacao img').should('not.exist');
    cy.window().its('__xss').should('not.exist');
  });
});

describe('Coordenação: trilha de auditoria', () => {
  const logs = [
    { id: 3, acao: 'SOFT_DELETE', descricao: 'Usuário excluído: Ana (E00001, Aluno)', usuario: 'Prof. Carlos', ip: '10.0.0.5', data_hora: '2030-05-20T15:30:00.000Z' },
    { id: 2, acao: 'ADICAO_VAGAS', descricao: '40 vagas abertas para ML', usuario: 'Prof. Carlos', ip: '10.0.0.5', data_hora: '2030-05-20T15:00:00.000Z' },
    { id: 1, acao: 'CADASTRO_USUARIO', descricao: 'Novo usuário cadastrado: Bia', usuario: null, ip: null, data_hora: '2030-05-20T14:00:00.000Z' }
  ];

  beforeEach(() => {
    abrirCoordenador({ logs });
    irParaAba('auditoria');
  });

  it('lista os logs com ação, descrição, autor, data e IP', () => {
    cy.get('#lista-logs-auditoria > div').should('have.length', 3);
    cy.contains('#lista-logs-auditoria > div', 'LOG #3').should('contain.text', 'SOFT_DELETE').and('contain.text', 'por Prof. Carlos').and('contain.text', 'IP: 10.0.0.5').and('contain.text', '20/05/2030');
    cy.contains('#lista-logs-auditoria > div', 'LOG #1').should('contain.text', 'IP: —').and('not.contain.text', 'por ');
  });

  it('ações de exclusão ficam destacadas em âmbar', () => {
    cy.contains('#lista-logs-auditoria > div', 'SOFT_DELETE').should('have.class', 'border-l-amber-500');
    cy.contains('#lista-logs-auditoria > div', 'ADICAO_VAGAS').should('have.class', 'border-l-emerald-500');
  });

  it('o filtro de ação inclui reativação e troca de foto', () => {
    cy.get('#filtroAcao option[value="REATIVACAO_USUARIO"]').should('exist');
    cy.get('#filtroAcao option[value="ATUALIZACAO_FOTO"]').should('exist');
  });

  it('filtra por texto (usuário ou descrição)', () => {
    cy.get('#filtroUsuario').type('vagas abertas');
    cy.contains('button', 'Filtrar Registros').click();
    cy.get('#lista-logs-auditoria > div').should('have.length', 1).and('contain.text', 'ADICAO_VAGAS');
  });

  it('filtra por ação', () => {
    cy.get('#filtroAcao').select('CADASTRO_USUARIO');
    cy.contains('button', 'Filtrar Registros').click();
    cy.get('#lista-logs-auditoria > div').should('have.length', 1).and('contain.text', 'Bia');
  });

  it('sem resultado mostra mensagem', () => {
    cy.get('#filtroUsuario').type('nada-disso-existe');
    cy.contains('button', 'Filtrar Registros').click();
    cy.contains('Nenhum log encontrado com os filtros selecionados.');
  });

  it('descrição com HTML é exibida como texto', () => {
    abrirCoordenador({ logs: [{ ...logs[0], descricao: '<img src=x onerror="window.__xss=1">' }] });
    irParaAba('auditoria');
    cy.get('#lista-logs-auditoria img').should('not.exist');
    cy.window().its('__xss').should('not.exist');
  });
});
