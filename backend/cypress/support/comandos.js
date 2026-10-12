import { API_URL } from './dados';

// ===================== TELAS (servidor simulado com cy.intercept) =====================

// abre uma página do front já com a sessão desejada gravada no localStorage
Cypress.Commands.add('abrirPagina', (pagina, sessao = null) => {
  cy.visit(`/${pagina}`, {
    onBeforeLoad(win) {
      win.localStorage.clear();
      if (sessao) Object.entries(sessao).forEach(([k, v]) => win.localStorage.setItem(k, v));
    }
  });
});

// qualquer chamada /api/* que o teste não simulou devolve uma lista vazia
Cypress.Commands.add('stubApiGeral', () => {
  cy.intercept({ pathname: '/api/**' }, { statusCode: 200, body: [] });
});

// simula uma rota da API:  cy.mockApi('GET', '/api/vagas', [...], { status: 200, alias: 'vagas' })
Cypress.Commands.add('mockApi', (metodo, pathname, body = {}, { status = 200, alias } = {}) => {
  const rota = cy.intercept({ method: metodo, pathname }, { statusCode: status, body });
  if (alias) rota.as(alias);
});

// confere o SweetAlert aberto
Cypress.Commands.add('swal', (titulo, texto) => {
  cy.get('.swal2-popup', { timeout: 10000 }).should('be.visible');
  cy.get('.swal2-title').should('contain.text', titulo);
  if (texto) cy.get('.swal2-html-container').should('contain.text', texto);
});

Cypress.Commands.add('confirmarSwal', () => {
  cy.get('.swal2-confirm').should('be.visible').click();
});

// ===================== API REAL (servidor em modo de teste + banco de teste) =====================

Cypress.Commands.add('api', (metodo, caminho, { token, body, headers = {} } = {}) => {
  return cy.request({
    method: metodo,
    url: `${API_URL}${caminho}`,
    body,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    failOnStatusCode: false
  });
});

Cypress.Commands.add('loginApi', (matricula, senha) => {
  return cy.api('POST', '/api/login', { body: { matricula, senha } });
});

// devolve o token de um usuário-semente
Cypress.Commands.add('tokenDe', (usuario) => {
  return cy.loginApi(usuario.matricula, usuario.senha).then((r) => {
    expect(r.status, `login de ${usuario.matricula}: ${JSON.stringify(r.body)}`).to.eq(200);
    return r.body.token;
  });
});

Cypress.Commands.add('bd', (sql, params = []) => cy.task('bd', { sql, params }));
