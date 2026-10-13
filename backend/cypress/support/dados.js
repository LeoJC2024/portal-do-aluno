// Dados compartilhados pelos testes.
// Endereço do servidor de teste (npm run servidor:teste): vem da PORT do .env.teste, via cypress.config.js.
export const API_URL = Cypress.expose('API_URL');
// Mude para true só se o projeto de teste tiver um bucket de fotos configurado no .env.teste
export const TESTAR_STORAGE = false;

export const SENHA_PADRAO = 'Teste@1234';
export const CURSO_A = 'CY Curso A';
export const CURSO_B = 'CY Curso B';

// usuários-semente (criados por banco/seed_teste.sql)
export const USUARIOS = {
  coord: { matricula: 'TESTE_COORD', senha: SENHA_PADRAO, nome: 'Teste Coordenador' },
  recepcao: { matricula: 'TESTE_RECEP', senha: SENHA_PADRAO, nome: 'Teste Recepcao' },
  audit: { matricula: 'TESTE_AUDIT', senha: SENHA_PADRAO, nome: 'Teste Auditor' },
  alunoA1: { matricula: 'TESTE_ALUNO_A1', senha: SENHA_PADRAO, nome: 'Teste Aluno A1', curso: CURSO_A },
  alunoA2: { matricula: 'TESTE_ALUNO_A2', senha: SENHA_PADRAO, nome: 'Teste Aluno A2', curso: CURSO_A },
  alunoB: { matricula: 'TESTE_ALUNO_B', senha: SENHA_PADRAO, nome: 'Teste Aluno B', curso: CURSO_B },
  legado: { matricula: 'TESTE_LEGADO', senha: 'Legado@1234', nome: 'Teste Legado', curso: CURSO_A }
};

// sessões falsas usadas nos testes de tela (o servidor é simulado)
export const SESSOES = {
  aluno: {
    unifaa_token: 'token-falso', usuario_nome: 'MARIA CLARA SOUZA', usuario_curso: 'Engenharia de Software',
    usuario_tipo: 'Aluno', usuario_perfil: 'aluno', usuario_matricula: 'E00001'
  },
  coordenador: {
    unifaa_token: 'token-falso', usuario_nome: 'Prof. Carlos Lima', usuario_curso: 'Engenharia de Software',
    usuario_tipo: 'coordenador', usuario_perfil: 'coordenador', usuario_matricula: 'C00000'
  },
  recepcao: {
    unifaa_token: 'token-falso', usuario_nome: 'Recepção Resende', usuario_curso: 'Polo Resende',
    usuario_tipo: 'Recepção do Polo', usuario_perfil: 'recepção do polo', usuario_matricula: 'AT00000'
  },
  audit: {
    unifaa_token: 'token-falso', usuario_nome: 'Auditor Geral', usuario_curso: 'TI',
    usuario_tipo: 'AUDIT', usuario_perfil: 'audit', usuario_matricula: 'TESTE_AUDIT'
  }
};

// imagem 1x1 válida (PNG) e um JPEG mínimo (só os bytes iniciais importam para a validação do servidor)
export const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
export const JPEG_MINIMO_DATAURL =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
export const PNG_DATAURL_COMO_JPEG = `data:image/jpeg;base64,${PNG_1X1_BASE64}`; // declara jpeg mas é png
