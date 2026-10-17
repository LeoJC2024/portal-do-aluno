import { SESSOES } from '../../support/dados';

const PAGINAS = {
  aluno: { arquivo: 'alunoHome.html', sistema: 'Portal do Aluno' },
  coordenador: { arquivo: 'coordenadorHome.html', sistema: 'Gestão Acadêmica' },
  // a recepção usa a frase completa "Você será desconectado do painel da portaria." (pedido dos testes exploratórios)
  recepcao: { arquivo: 'recepcaoHome.html', sistema: 'painel da portaria', mensagemSair: 'Você será desconectado do painel da portaria.' },
  audit: { arquivo: 'auditHome.html', sistema: 'sistema de auditoria' }
};

describe('Proteção das páginas (sem login)', () => {
  Object.entries(PAGINAS).forEach(([chave, { arquivo }]) => {
    it(`${arquivo} sem login mostra "Acesso Negado" e volta ao login`, () => {
      cy.stubApiGeral();
      cy.abrirPagina(arquivo);
      cy.swal('Acesso Negado', 'Faça login para acessar o painel.');
      cy.confirmarSwal();
      cy.location('pathname').should('eq', '/login.html');
    });
  });
});

describe('Proteção das páginas (perfil errado)', () => {
  Object.entries(PAGINAS).forEach(([paginaAlvo, { arquivo }]) => {
    Object.entries(PAGINAS).forEach(([perfil, { arquivo: paginaDoPerfil }]) => {
      if (perfil === paginaAlvo) return;
      it(`${perfil} em ${arquivo} é mandado para ${paginaDoPerfil}`, () => {
        cy.stubApiGeral();
        cy.abrirPagina(arquivo, SESSOES[perfil]);
        cy.swal('Acesso Negado', 'Seu perfil não tem acesso a esta página.');
        cy.confirmarSwal();
        cy.location('pathname').should('eq', `/${paginaDoPerfil}`);
      });
    });
  });
});

describe('Sessão expirada', () => {
  it('um 401 da API limpa a sessão e leva ao login', () => {
    cy.stubApiGeral();
    cy.mockApi('GET', '/api/vagas', { sucesso: false, mensagem: 'Sessão inválida ou expirada.' }, { status: 401 });
    cy.abrirPagina('alunoHome.html', SESSOES.aluno);

    cy.swal('Sessão expirada');
    cy.confirmarSwal();
    cy.location('pathname').should('eq', '/login.html');
    cy.window().then((win) => expect(win.localStorage.getItem('unifaa_token')).to.be.null);
  });
});

describe('Menu do usuário e sair', () => {
  Object.entries(PAGINAS).forEach(([chave, { arquivo, sistema, mensagemSair }]) => {
    context(arquivo, () => {
      beforeEach(() => {
        cy.stubApiGeral();
        cy.abrirPagina(arquivo, SESSOES[chave]);
        cy.get('#userAvatar').click();
      });

      it('abre o menu e fecha ao clicar fora', () => {
        cy.get('#userDropdown').should('not.have.class', 'hidden');
        cy.get('body').click({ force: true }); // clique fora do menu (o centro do body é coberto por outros elementos)
        cy.get('#userDropdown').should('have.class', 'hidden');
      });

      it('sair pede confirmação, cita o sistema e limpa a sessão', () => {
        cy.get('#userDropdown').contains(/Sair/).click();
        cy.swal('Deseja sair?', mensagemSair || `Será desconectado do ${sistema}.`);
        cy.confirmarSwal();
        cy.location('pathname').should('eq', '/login.html');
        cy.window().then((win) => {
          expect(win.localStorage.getItem('unifaa_token')).to.be.null;
          expect(win.localStorage.getItem('usuario_nome')).to.be.null;
        });
      });

      it('cancelar a saída mantém a sessão', () => {
        cy.get('#userDropdown').contains(/Sair/).click();
        cy.get('.swal2-cancel').click();
        cy.location('pathname').should('eq', `/${arquivo}`);
        cy.window().then((win) => expect(win.localStorage.getItem('unifaa_token')).to.eq('token-falso'));
      });
    });
  });
});
