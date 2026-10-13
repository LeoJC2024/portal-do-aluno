import './comandos';

// nas telas, a API passa a ser "a própria origem" (o servidor de arquivos de teste),
// e os testes simulam as respostas com cy.intercept. Não usa o backend real.
Cypress.on('window:before:load', (win) => {
  win.API_URL = win.location.origin;
});

// testes de API: antes de tudo, confere se a URL e o banco são os de TESTE (ver cypress.config.js)
before(() => {
  if (/(^|\/)e2e\/api\//.test(Cypress.spec.relative.replace(/\\/g, '/'))) {
    cy.task('conferirAmbienteApi', null, { log: false });
  }
});
