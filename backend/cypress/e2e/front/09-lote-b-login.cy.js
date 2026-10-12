// Lote B, item 6: o botão de redefinir senha fica desabilitado enquanto o pedido está em andamento.
const BOTAO = '#formConfirmarCodigo button[type=submit]';

const abrirPasso2 = () => {
  cy.get('#btnEsqueciSenha').click();
  cy.get('#matriculaRecuperar').type('E00005');
  cy.get('#btnJaTenhoSenha').click();
  cy.get('#codigoVerificacao').type('ProvisoriA1');
  cy.get('#novaSenhaRecuperar').type('NovaSenha@1');
};

// resposta demorada para dar tempo de conferir o botão durante o pedido
const simularRecuperar = (resposta) =>
  cy.intercept({ method: 'POST', pathname: '/api/recuperar-senha' }, { delay: 1500, ...resposta }).as('recuperar');

describe('Tela de login: redefinir senha sem clique duplo', () => {
  beforeEach(() => {
    cy.stubApiGeral();
    cy.abrirPagina('login.html');
  });

  it('botão desabilitado durante o pedido: um segundo clique não envia outro pedido', () => {
    simularRecuperar({ statusCode: 200, body: { sucesso: true, mensagem: 'Senha definida com sucesso! Você já pode fazer login.' } });
    abrirPasso2();
    cy.get(BOTAO).click();
    cy.get(BOTAO).should('be.disabled');
    cy.get(BOTAO).click({ force: true }); // segundo clique com o pedido ainda em andamento

    cy.wait('@recuperar');
    cy.swal('Sucesso!', 'Senha definida com sucesso');
    cy.get('@recuperar.all').should('have.length', 1);
    cy.get(BOTAO).should('not.be.disabled');
  });

  it('erro do servidor: o botão volta a ficar habilitado', () => {
    simularRecuperar({ statusCode: 400, body: { sucesso: false, mensagem: 'Código ou senha provisória inválidos ou expirados.' } });
    abrirPasso2();
    cy.get(BOTAO).click();
    cy.get(BOTAO).should('be.disabled');

    cy.wait('@recuperar');
    cy.swal('Erro', 'inválidos ou expirados');
    cy.get(BOTAO).should('not.be.disabled');
  });

  it('falha de rede: o botão volta a ficar habilitado', () => {
    cy.intercept({ method: 'POST', pathname: '/api/recuperar-senha' }, { forceNetworkError: true }).as('recuperar');
    abrirPasso2();
    cy.get(BOTAO).click();

    cy.swal('Erro de Conexão');
    cy.get(BOTAO).should('not.be.disabled');
  });
});
