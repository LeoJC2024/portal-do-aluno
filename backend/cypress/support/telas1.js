import { SESSOES } from './dados';

// abre a tela do coordenador com a API simulada (as abas carregam tudo ao abrir)
export function abrirCoordenador({ cursos = ['Engenharia de Software', 'Direito'], notas = [], logs = [], usuarios = [] } = {}) {
  cy.stubApiGeral();
  cy.mockApi('GET', '/api/cursos', cursos, { alias: 'cursos' });
  cy.mockApi('GET', '/api/notas', notas, { alias: 'notas' });
  cy.mockApi('GET', '/api/auditoria', logs, { alias: 'logs' });
  cy.mockApi('GET', '/api/usuarios', usuarios, { alias: 'usuarios' });
  cy.abrirPagina('coordenadorHome.html', SESSOES.coordenador);
  cy.wait(['@cursos', '@notas', '@logs', '@usuarios']);
}

export const irParaAba = (aba) => cy.get(`#btn-${aba}`).click();
