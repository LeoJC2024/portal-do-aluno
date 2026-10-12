import { SESSOES } from './dados';

export const DISCIPLINAS_PADRAO = [
  { id: 1, nome: 'A', ativa: true, criado_em: '2030-01-01T10:00:00.000Z', criado_por: 'Sistema' },
  { id: 2, nome: 'B', ativa: true, criado_em: '2030-01-01T10:00:00.000Z', criado_por: 'Sistema' },
  { id: 3, nome: 'C', ativa: true, criado_em: '2030-01-01T10:00:00.000Z', criado_por: 'Sistema' }
];

// resposta paginada de /api/auditoria (e, com estatisticas, de /api/admin/auditoria-completa)
export const respostaAuditoria = (logs, extra = {}) => ({
  sucesso: true, logs, pagina: 1, limite: 50, total: logs.length, totalPaginas: Math.max(1, Math.ceil(logs.length / 50)), ...extra
});

// abre a tela da coordenação com a API simulada (todas as abas carregam ao abrir)
export function abrirCoordenador({
  cursos = ['Engenharia de Software', 'Direito'], disciplinas = DISCIPLINAS_PADRAO, vagas = [], notas = [], logs = [], usuarios = []
} = {}) {
  cy.stubApiGeral();
  cy.mockApi('GET', '/api/cursos', cursos, { alias: 'cursos' });
  cy.mockApi('GET', '/api/disciplinas', disciplinas, { alias: 'disciplinas' });
  cy.mockApi('GET', '/api/vagas-gestao', vagas, { alias: 'vagas' });
  cy.mockApi('GET', '/api/notas', notas, { alias: 'notas' });
  cy.mockApi('GET', '/api/auditoria', Array.isArray(logs) ? respostaAuditoria(logs) : logs, { alias: 'logs' });
  cy.mockApi('GET', '/api/usuarios', usuarios, { alias: 'usuarios' });
  cy.abrirPagina('coordenadorHome.html', SESSOES.coordenador);
  cy.wait(['@cursos', '@disciplinas', '@vagas', '@notas', '@logs', '@usuarios']);
}

export const irParaAba = (aba) => cy.get(`#btn-${aba}`).click();
