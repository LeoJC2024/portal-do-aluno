import { abrirCoordenador, irParaAba, DISCIPLINAS_PADRAO } from '../../support/telas';

const linha = (nome) => cy.contains('#listaDisciplinas tr', new RegExp(`^\\s*${nome}\\b`));

describe('Coordenação: disciplinas', () => {
  const lista = [...DISCIPLINAS_PADRAO, { id: 4, nome: 'Machine Learning', ativa: false, criado_em: '2030-05-20T15:30:00.000Z', criado_por: 'Prof. Carlos Lima' }];

  beforeEach(() => {
    abrirCoordenador({ disciplinas: lista });
    irParaAba('disciplinas');
  });

  it('lista as disciplinas com status, data de cadastro e quem cadastrou', () => {
    ['Disciplina', 'Status', 'Cadastrada em', 'Ação'].forEach((col) => cy.contains('#page-disciplinas th', col));
    cy.get('#listaDisciplinas tr').should('have.length', 4);
    linha('A').should('contain.text', 'Ativa').and('contain.text', 'Inativar');
    linha('Machine Learning').should('contain.text', 'Inativa').and('contain.text', 'Reativar').and('contain.text', '20/05/2030, 12:30:00').and('contain.text', 'por Prof. Carlos Lima');
  });

  it('a busca filtra a lista e avisa quando nada é encontrado', () => {
    cy.get('#buscaDisciplina').type('machine');
    cy.get('#listaDisciplinas tr').should('have.length', 1);
    cy.get('#buscaDisciplina').clear().type('zzz');
    cy.contains('Nenhuma disciplina encontrada para a busca.');
  });

  it('o texto explica que inativar não apaga as vagas já cadastradas', () => {
    cy.contains('#page-disciplinas p', 'Inativar não apaga nada');
  });

  describe('adicionar', () => {
    beforeEach(() => cy.get('#btnAdicionarDisciplina').click());

    it('abre o modal e fecha por Cancelar, X, Esc e clicando fora', () => {
      cy.get('#modalDisciplina').should('have.class', 'flex').and('contain.text', 'Nova disciplina');
      cy.get('#modalDisciplina').contains('button', 'Cancelar').click();
      cy.get('#modalDisciplina').should('have.class', 'hidden');
      cy.get('#btnAdicionarDisciplina').click();
      cy.get('body').type('{esc}');
      cy.get('#modalDisciplina').should('have.class', 'hidden');
      cy.get('#btnAdicionarDisciplina').click();
      cy.get('#modalDisciplina').click('topLeft');
      cy.get('#modalDisciplina').should('have.class', 'hidden');
    });

    it('cadastra: envia {nome}, fecha o modal e recarrega a lista e o formulário de vagas', () => {
      cy.mockApi('POST', '/api/disciplinas', { sucesso: true, id: 9, mensagem: 'Disciplina cadastrada com sucesso!' }, { alias: 'nova' });
      cy.get('#novaDisciplina').type('  A2 - Redes ');
      cy.contains('#formDisciplina button[type=submit]', 'Cadastrar disciplina').click();
      cy.wait('@nova').its('request.body').should('deep.equal', { nome: 'A2 - Redes' });
      cy.swal('Disciplina cadastrada!');
      cy.get('#modalDisciplina').should('have.class', 'hidden');
      cy.wait('@disciplinas');
    });

    it('nome vazio não é enviado', () => {
      cy.mockApi('POST', '/api/disciplinas', {}, { alias: 'nova' });
      cy.contains('#formDisciplina button[type=submit]', 'Cadastrar disciplina').click();
      cy.get('@nova.all').should('have.length', 0);
    });

    it('erro do servidor (já cadastrada) é exibido e o modal continua aberto', () => {
      cy.mockApi('POST', '/api/disciplinas', { sucesso: false, mensagem: 'Esta disciplina já está cadastrada (ela pode estar inativa).' }, { status: 409 });
      cy.get('#novaDisciplina').type('A');
      cy.contains('#formDisciplina button[type=submit]', 'Cadastrar disciplina').click();
      cy.swal('Não foi possível', 'já está cadastrada');
      cy.confirmarSwal();
      cy.get('#modalDisciplina').should('have.class', 'flex');
    });
  });

  describe('inativar e reativar', () => {
    it('inativar: confirma, envia {id, ativa:false} e mostra a mensagem do servidor', () => {
      cy.mockApi('POST', '/api/alterar-status-disciplina',
        { sucesso: true, vagas_futuras: 2, mensagem: 'Disciplina inativada. Ela deixa de aparecer ao cadastrar novas vagas; as 2 vaga(s) futura(s) já cadastradas continuam valendo.' }, { alias: 'status' });
      linha('B').contains('button', 'Inativar').click();
      cy.swal('Inativar disciplina?', 'continuam valendo');
      cy.confirmarSwal();
      cy.wait('@status').its('request.body').should('deep.equal', { id: 2, ativa: false });
      cy.swal('Pronto!', '2 vaga(s) futura(s)');
      cy.wait('@disciplinas');
    });

    it('cancelar a confirmação não envia nada', () => {
      cy.mockApi('POST', '/api/alterar-status-disciplina', {}, { alias: 'status' });
      linha('B').contains('button', 'Inativar').click();
      cy.get('.swal2-cancel').click();
      cy.get('@status.all').should('have.length', 0);
    });

    it('reativar envia {id, ativa:true}', () => {
      cy.mockApi('POST', '/api/alterar-status-disciplina', { sucesso: true, mensagem: 'Disciplina reativada.' }, { alias: 'status' });
      linha('Machine Learning').contains('button', 'Reativar').click();
      cy.swal('Reativar disciplina?');
      cy.confirmarSwal();
      cy.wait('@status').its('request.body').should('deep.equal', { id: 4, ativa: true });
    });

    it('erro do servidor é exibido', () => {
      cy.mockApi('POST', '/api/alterar-status-disciplina', { sucesso: false, mensagem: 'A disciplina já está inativa.' }, { status: 409 });
      linha('B').contains('button', 'Inativar').click();
      cy.confirmarSwal();
      cy.swal('Não foi possível', 'já está inativa');
    });
  });

  it('depois de inativar, a disciplina some do formulário de vagas', () => {
    cy.mockApi('POST', '/api/alterar-status-disciplina', { sucesso: true, mensagem: 'ok' }, { alias: 'status' });
    cy.mockApi('GET', '/api/disciplinas', DISCIPLINAS_PADRAO.map((d) => (d.nome === 'B' ? { ...d, ativa: false } : d)), { alias: 'disciplinas' });
    linha('B').contains('button', 'Inativar').click();
    cy.confirmarSwal();
    cy.wait('@status');
    cy.wait('@disciplinas');
    cy.confirmarSwal();
    irParaAba('oferta');
    cy.get('#btnAdicionarVaga').click();
    cy.get('#vagaDisciplina option').should(($o) => {
      expect([...$o].map((o) => o.textContent)).to.deep.equal(['Selecione a disciplina...', 'A', 'C']);
    });
  });

  it('sem disciplinas mostra mensagem; erro do servidor também', () => {
    abrirCoordenador({ disciplinas: [] });
    irParaAba('disciplinas');
    cy.contains('Nenhuma disciplina cadastrada ainda.');

    cy.stubApiGeral();
    cy.mockApi('GET', '/api/disciplinas', { sucesso: false }, { status: 500 });
    cy.abrirPagina('coordenadorHome.html', { unifaa_token: 't', usuario_nome: 'C', usuario_curso: 'X', usuario_perfil: 'coordenador', usuario_matricula: 'C1' });
    irParaAba('disciplinas');
    cy.contains('Erro ao carregar as disciplinas do servidor.');
  });
});
