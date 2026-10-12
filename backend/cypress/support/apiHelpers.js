// Funções auxiliares dos testes de API (cada uma devolve uma cadeia do Cypress).
import { CURSO_A } from './dados';
import { dataSP } from './datas';

const unico = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

// mesma comparação do servidor: apara, junta espaços repetidos e ignora maiúsculas
const mesmoNome = (a, b) => {
  const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  return norm(a) === norm(b);
};

// garante que a disciplina existe e está ativa no cadastro (a vaga só aceita disciplina cadastrada).
// 409 só é aceito se a lista confirmar que é a mesma disciplina e que ela está ativa;
// qualquer outro status (400, 401, 403, 500...) falha o teste. Devolve { id, nome, criada }
export function registrarDisciplina(token, nome) {
  return cy.api('POST', '/api/disciplinas', { token, body: { nome } }).then((r) => {
    if (r.status === 200) {
      expect(r.body.id, `registrarDisciplina "${nome}": ${JSON.stringify(r.body)}`).to.be.a('number');
      return { id: r.body.id, nome, criada: true };
    }
    expect(r.status, `registrarDisciplina "${nome}": ${JSON.stringify(r.body)}`).to.eq(409);
    return cy.api('GET', '/api/disciplinas', { token }).then((lista) => {
      expect(lista.status, `registrarDisciplina: listar disciplinas: ${JSON.stringify(lista.body)}`).to.eq(200);
      const existente = lista.body.find((d) => mesmoNome(d.nome, nome));
      expect(existente, `registrarDisciplina: 409 para "${nome}", mas ela não aparece na lista`).to.exist;
      expect(existente.ativa, `registrarDisciplina: "${existente.nome}" já existe, mas está inativa`).to.eq(true);
      return { id: existente.id, nome: existente.nome, criada: false };
    });
  });
}

// cria uma vaga pelo coordenador (registrando antes a disciplina). Devolve { ...dadosEnviados, id }
export function criarVaga(token, extra = {}) {
  const corpo = {
    polo: 'Polo CY',
    curso: CURSO_A,
    disciplina: `CY-${unico()}`,
    data: dataSP(10),
    horario_inicio: '08:00',
    horario_fim: '10:00',
    limite_vagas: 5,
    ...extra
  };
  return registrarDisciplina(token, corpo.disciplina).then(() =>
    cy.api('POST', '/api/cadastrar-vaga', { token, body: corpo }).then((r) => {
      expect(r.status, `criarVaga: ${JSON.stringify(r.body)}`).to.eq(200);
      return { ...corpo, id: r.body.id };
    })
  );
}

// cadastra um usuário pelo coordenador. Devolve { ...dadosEnviados, matricula, senhaProvisoria }
export function criarUsuario(token, extra = {}) {
  const n = unico();
  const corpo = {
    nome: `Cy Teste ${n}`,
    email: `cy-${n}@teste.local`,
    curso: CURSO_A,
    tipo: 'Aluno',
    ...extra
  };
  return cy.api('POST', '/api/cadastrar-usuario', { token, body: corpo }).then((r) => {
    expect(r.status, `criarUsuario: ${JSON.stringify(r.body)}`).to.eq(200);
    return { ...corpo, id: null, matricula: r.body.matricula, senhaProvisoria: r.body.senha_provisoria };
  });
}

// cadastra e já conclui o primeiro acesso. Devolve o usuário com { senha, id, token }
export function criarUsuarioAtivo(token, extra = {}) {
  const novaSenha = 'Nova@12345';
  return criarUsuario(token, extra).then((u) => {
    return cy.api('POST', '/api/recuperar-senha', {
      body: { matricula: u.matricula, codigo: u.senhaProvisoria, novaSenha }
    }).then((r) => {
      expect(r.status, `primeiro acesso: ${JSON.stringify(r.body)}`).to.eq(200);
      return cy.loginApi(u.matricula, novaSenha).then((login) => {
        expect(login.status, `login: ${JSON.stringify(login.body)}`).to.eq(200);
        return cy.bd('SELECT id FROM usuarios WHERE matricula = $1', [u.matricula]).then((rows) => ({
          ...u, senha: novaSenha, id: rows[0].id, token: login.body.token
        }));
      });
    });
  });
}

// o aluno agenda a vaga. Devolve a resposta (para o teste conferir o status)
export const agendar = (token, vagaId) => cy.api('POST', '/api/agendar', { token, body: { vaga_id: vagaId } });

// lista de logs de auditoria (como coordenador)
export const logsDeAuditoria = (tokenCoord) =>
  cy.api('GET', '/api/auditoria', { token: tokenCoord }).then((r) => r.body);

// insere uma vaga direto no banco de teste (para cenários que a API não permite criar:
// vaga no passado, vaga antiga sem curso etc.). Devolve o id.
export function inserirVagaNoBanco({ curso = CURSO_A, disciplina, data, inicio = '08:00', fim = '10:00', limite = 5, polo = 'Polo CY', agInicio = null, agFim = null }) {
  return cy.bd(
    `INSERT INTO vagas (polo, curso, disciplina, data_prova, horario, horario_fim, limite_vagas, agendamento_inicio, agendamento_fim)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [polo, curso, disciplina, data, inicio, fim, limite, agInicio, agFim]
  ).then((rows) => rows[0].id);
}

// vagas restantes que o aluno enxerga para uma vaga
export const vagasRestantes = (token, vagaId) =>
  cy.api('GET', '/api/vagas', { token }).then((r) => {
    const v = r.body.find((x) => x.id === vagaId);
    return v ? v.vagas_restantes : undefined;
  });
