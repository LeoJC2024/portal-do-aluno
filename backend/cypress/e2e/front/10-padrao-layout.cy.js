// Padrão visual das telas (melhoria M03 / decisão D07):
// barra de 80 px, mesmo cartão de título, mesma largura do conteúdo e dois tamanhos de modal.
import { SESSOES } from '../../support/dados';
import { abrirCoordenador } from '../../support/telas';

const VERDE_TITULO = 'rgb(5, 150, 105)'; // emerald-600, o mesmo da Coordenação e da Recepção

const TELAS = {
  aluno: () => { cy.stubApiGeral(); cy.abrirPagina('alunoHome.html', SESSOES.aluno); },
  coordenador: () => abrirCoordenador(),
  recepcao: () => { cy.stubApiGeral(); cy.abrirPagina('recepcaoHome.html', SESSOES.recepcao); },
  audit: () => { cy.stubApiGeral(); cy.abrirPagina('auditHome.html', SESSOES.audit); }
};

const MODAIS = {
  aluno: { modalResultados: 'medio', modalAgendamento: 'pequeno', modalComprovante: 'medio' },
  coordenador: { modalVaga: 'medio', modalUsuario: 'medio', modalDisciplina: 'pequeno', modalDetalheVaga: 'medio' },
  recepcao: { modalAluno: 'medio' },
  audit: {}
};

const LARGURA_MODAL = { pequeno: '448px', medio: '640px' };

const semRolagemHorizontal = () =>
  cy.document().then((d) => expect(d.documentElement.scrollWidth).to.be.at.most(d.documentElement.clientWidth));

describe('Padrão de layout das telas logadas', () => {
  Object.entries(TELAS).forEach(([perfil, abrir]) => {
    context(perfil, () => {
      it('barra superior com 80 px de altura e o mesmo bloco de usuário', () => {
        abrir();
        cy.get('header').should('have.css', 'height', '80px').then(($h) => {
          expect($h[0].getBoundingClientRect().height).to.eq(80);
        });
        cy.get('header #userAvatar').should('have.class', 'usuario-avatar').and('have.css', 'width', '40px');
        cy.get('header #userName').should('have.class', 'usuario-nome').and('have.css', 'text-transform', 'uppercase');
        cy.get('#userDropdown').should('contain.text', 'Sair da Conta');
      });

      it('cartão de título com a borda verde superior e a mesma largura máxima do conteúdo', () => {
        abrir();
        cy.get('main').should('have.css', 'max-width', '1280px');
        cy.get('main > div').first().should('have.class', 'cartao-titulo')
          .and('have.css', 'border-top-width', '4px')
          .and('have.css', 'border-top-color', VERDE_TITULO)
          .and('have.css', 'border-top-left-radius', '16px');
      });

      it('todos os modais usam um dos dois tamanhos', () => {
        abrir();
        Object.entries(MODAIS[perfil]).forEach(([id, tamanho]) => {
          cy.get(`#${id} > :first-child`)
            .should('have.class', `modal-${tamanho}`)
            .and('have.css', 'max-width', LARGURA_MODAL[tamanho]);
        });
      });

      it('no celular (360 px) a barra continua com 80 px e nada estoura na horizontal', () => {
        cy.viewport(360, 640);
        abrir();
        cy.get('header').then(($h) => expect($h[0].getBoundingClientRect().height).to.eq(80));
        semRolagemHorizontal();
      });
    });
  });
});

describe('Padrão dos modais no celular', () => {
  beforeEach(() => cy.viewport(360, 640));

  it('modal médio (formulário) cabe na tela e o corpo rola', () => {
    abrirCoordenador();
    cy.get('#btnAdicionarVaga').click();
    cy.get('#modalVaga > .modal-medio').then(($m) => {
      const caixa = $m[0].getBoundingClientRect();
      expect(caixa.width).to.be.at.most(360 - 32 + 1);
      expect(caixa.height).to.be.at.most(640 - 32 + 1);
    });
    cy.get('#modalVaga .modal-corpo').should('have.css', 'overflow-y', 'auto');
    cy.contains('#modalVaga button', 'Cadastrar Vagas no Banco').scrollIntoView().should('be.visible');
    semRolagemHorizontal();
  });

  it('modal pequeno (confirmação) cabe na tela', () => {
    abrirCoordenador();
    cy.get('#btn-disciplinas').click();
    cy.get('#btnAdicionarDisciplina').click();
    cy.get('#modalDisciplina > .modal-pequeno').then(($m) => {
      expect($m[0].getBoundingClientRect().width).to.be.at.most(360 - 32 + 1);
    });
  });

  it('modal do login usa o tamanho pequeno', () => {
    cy.stubApiGeral();
    cy.abrirPagina('login.html');
    cy.get('#btnEsqueciSenha').click();
    cy.get('#modalRecuperar .modal-box').should('have.class', 'modal-pequeno').then(($m) => {
      expect($m[0].getBoundingClientRect().width).to.be.at.most(360 - 32 + 1);
    });
    semRolagemHorizontal();
  });
});
