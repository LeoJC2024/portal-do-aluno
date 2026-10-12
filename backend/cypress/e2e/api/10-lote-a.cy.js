// Lote A da varredura de falhas: cada bloco reproduz um problema encontrado e confere a correção.
import { USUARIOS, API_URL } from '../../support/dados';
import { criarVaga, criarUsuarioAtivo, agendar, inserirVagaNoBanco } from '../../support/apiHelpers';
import { dataSP, hojeSP } from '../../support/datas';

const unico = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

describe('API: lote A da varredura de falhas', () => {
  const t = {};

  before(() => {
    cy.task('prepararBanco');
    cy.tokenDe(USUARIOS.coord).then((x) => { t.coord = x; });
    cy.tokenDe(USUARIOS.recepcao).then((x) => { t.recepcao = x; });
  });

  const cancelar = (token, id) => cy.api('POST', '/api/cancelar-agendamento', { token, body: { agendamento_id: id } });
  const reagendar = (token, agendamentoId, novaVagaId) =>
    cy.api('POST', '/api/reagendar', { token, body: { agendamento_id: agendamentoId, nova_vaga_id: novaVagaId } });
  const confirmar = (ticket) => cy.api('POST', '/api/portaria/confirmar-entrada', { token: t.recepcao, body: { ticket_id: ticket } });

  // ---------------------------------------------------------------------------
  describe('1. agendamentos simultâneos na mesma disciplina', () => {
    it('6 pedidos ao mesmo tempo para vagas da mesma disciplina: só 1 é aceito', () => {
      const disciplina = `CY-corrida-${unico()}`;
      const horarios = ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00'];
      const vagas = [];
      horarios.forEach((h, i) => {
        criarVaga(t.coord, { disciplina, horario_inicio: h, horario_fim: `${String(8 + i).padStart(2, '0')}:30` }).then((v) => vagas.push(v));
      });
      criarUsuarioAtivo(t.coord).then((aluno) => {
        cy.then(() => cy.task('paralelo', vagas.map((v) => ({
          method: 'POST', url: `${API_URL}/api/agendar`, headers: { Authorization: `Bearer ${aluno.token}` }, body: { vaga_id: v.id }
        })))).then((rs) => {
          expect(rs.filter((r) => r.status === 200), JSON.stringify(rs)).to.have.length(1);
          expect(rs.filter((r) => r.status === 409)).to.have.length(5);
        });
        cy.bd(`SELECT COUNT(*)::int AS n FROM agendamentos a JOIN vagas v ON v.id = a.vaga_id
                WHERE a.usuario_id = $1 AND v.disciplina = $2 AND a.status = 'ATIVO'`, [aluno.id, disciplina])
          .then((rows) => expect(rows[0].n, 'agendamentos ativos na disciplina').to.eq(1));
      });
    });

    it('disciplina escrita com maiúsculas/espaços diferentes conta como a mesma', () => {
      const disciplina = `CY-caixa-${unico()}`;
      criarVaga(t.coord, { disciplina }).then((v1) => {
        // vaga antiga gravada direto no banco com outra grafia da mesma disciplina
        inserirVagaNoBanco({ disciplina: `  ${disciplina.toLowerCase()} `, data: dataSP(11), inicio: '15:00', fim: '16:00' }).then((idV2) => {
          criarUsuarioAtivo(t.coord).then((aluno) => {
            agendar(aluno.token, v1.id).its('status').should('eq', 200);
            agendar(aluno.token, idV2).then((r) => {
              expect(r.status, JSON.stringify(r.body)).to.eq(409);
              expect(r.body.mensagem).to.contain('já tem um agendamento ativo');
            });
          });
        });
      });
    });
  });

  // ---------------------------------------------------------------------------
  describe('2. limite de tentativas do código de recuperação', () => {
    const solicitar = (matricula) => cy.api('POST', '/api/solicitar-codigo', { body: { matricula } });
    const tentativa = (matricula, codigo) => ({
      method: 'POST', url: `${API_URL}/api/recuperar-senha`, body: { matricula, codigo, novaSenha: 'NaoImporta@123' }
    });
    const vencerCodigo = (matricula) =>
      cy.bd(`UPDATE usuarios SET codigo_expiracao = NOW() - INTERVAL '1 minute' WHERE matricula = $1`, [matricula]);

    it('20 códigos errados ao mesmo tempo: no máximo 5 são avaliados', () => {
      criarUsuarioAtivo(t.coord).then((u) => {
        solicitar(u.matricula).its('status').should('eq', 200);
        cy.task('paralelo', Array.from({ length: 20 }, (_, i) => tentativa(u.matricula, String(100000 + i)))).then((rs) => {
          const avaliadas = rs.filter((r) => /inválidos ou expirados/.test(r.body?.mensagem || ''));
          const bloqueadas = rs.filter((r) => /Muitas tentativas/.test(r.body?.mensagem || ''));
          expect(avaliadas.length, JSON.stringify(rs.map((r) => r.body?.mensagem))).to.be.at.most(5);
          expect(avaliadas.length + bloqueadas.length).to.eq(20);
        });
        cy.bd('SELECT codigo_tentativas FROM usuarios WHERE matricula = $1', [u.matricula])
          .then((rows) => expect(rows[0].codigo_tentativas).to.be.at.most(5));
      });
    });

    it('pedir novo código não zera o contador enquanto o código atual vale', () => {
      criarUsuarioAtivo(t.coord).then((u) => {
        solicitar(u.matricula);
        cy.bd('UPDATE usuarios SET codigo_tentativas = 5 WHERE matricula = $1', [u.matricula]);
        // libera o intervalo mínimo entre pedidos, mas o código continua válido
        cy.bd(`UPDATE usuarios SET codigo_expiracao = NOW() + INTERVAL '10 minutes' WHERE matricula = $1`, [u.matricula]);
        solicitar(u.matricula).then((s) => {
          expect(s.status).to.eq(200);
          cy.bd('SELECT codigo_tentativas FROM usuarios WHERE matricula = $1', [u.matricula])
            .then((rows) => expect(rows[0].codigo_tentativas, 'contador não pode voltar a 0').to.eq(5));
          cy.api('POST', '/api/recuperar-senha', { body: { matricula: u.matricula, codigo: s.body.codigo_teste, novaSenha: 'OutraSenha@99' } }).then((r) => {
            expect(r.status).to.eq(400);
            expect(r.body.mensagem).to.contain('Muitas tentativas');
          });
        });
      });
    });

    it('depois que o código vence, um novo pedido zera o contador e o novo código vale', () => {
      criarUsuarioAtivo(t.coord).then((u) => {
        solicitar(u.matricula);
        cy.bd('UPDATE usuarios SET codigo_tentativas = 5 WHERE matricula = $1', [u.matricula]);
        vencerCodigo(u.matricula);
        solicitar(u.matricula).then((s) => {
          expect(s.body.codigo_teste).to.match(/^\d{6}$/);
          cy.api('POST', '/api/recuperar-senha', { body: { matricula: u.matricula, codigo: s.body.codigo_teste, novaSenha: 'OutraSenha@99' } })
            .its('status').should('eq', 200);
        });
      });
    });

    it('intervalo mínimo: um segundo pedido logo em seguida não gera novo código (mesma resposta)', () => {
      criarUsuarioAtivo(t.coord).then((u) => {
        solicitar(u.matricula).then((primeiro) => {
          expect(primeiro.body.codigo_teste).to.match(/^\d{6}$/);
          cy.bd('SELECT codigo_recuperacao FROM usuarios WHERE matricula = $1', [u.matricula]).then((antes) => {
            solicitar(u.matricula).then((segundo) => {
              expect(segundo.status).to.eq(200);
              expect(segundo.body.mensagem).to.eq(primeiro.body.mensagem);
              expect(segundo.body).to.not.have.property('codigo_teste');
            });
            cy.bd('SELECT codigo_recuperacao FROM usuarios WHERE matricula = $1', [u.matricula])
              .then((depois) => expect(depois[0].codigo_recuperacao, 'o código anterior continua valendo').to.eq(antes[0].codigo_recuperacao));
          });
          cy.api('POST', '/api/recuperar-senha', { body: { matricula: u.matricula, codigo: primeiro.body.codigo_teste, novaSenha: 'OutraSenha@99' } })
            .its('status').should('eq', 200);
        });
      });
    });
  });

  // ---------------------------------------------------------------------------
  describe('3. portaria só confirma no dia; depois da entrada não cancela nem reagenda', () => {
    afterEach(() => cy.bd('UPDATE usuarios SET polo = NULL WHERE matricula = $1', [USUARIOS.recepcao.matricula]));

    it('prova daqui a 10 dias: confirmar entrada dá 400 e nada é gravado', () => {
      criarVaga(t.coord).then((v) => {
        criarUsuarioAtivo(t.coord).then((aluno) => {
          agendar(aluno.token, v.id).then((r) => {
            const ticket = r.body.agendamento.id;
            confirmar(ticket).then((c) => {
              expect(c.status, JSON.stringify(c.body)).to.eq(400);
              expect(c.body.mensagem).to.contain('no dia da prova');
            });
            cy.bd('SELECT entrada_confirmada_em FROM agendamentos WHERE id = $1', [ticket])
              .then((rows) => expect(rows[0].entrada_confirmada_em).to.be.null);
          });
        });
      });
    });

    it('prova hoje: confirma normalmente', () => {
      criarVaga(t.coord).then((v) => {
        criarUsuarioAtivo(t.coord).then((aluno) => {
          agendar(aluno.token, v.id).then((r) => {
            const ticket = r.body.agendamento.id;
            cy.bd('UPDATE agendamentos SET data_agendada = $2 WHERE id = $1', [ticket, hojeSP()]);
            confirmar(ticket).its('status').should('eq', 200);
          });
        });
      });
    });

    it('entrada já confirmada: o aluno não consegue cancelar nem reagendar', () => {
      const disciplina = `CY-entrada-${unico()}`;
      criarVaga(t.coord, { disciplina }).then((v1) => {
        criarVaga(t.coord, { disciplina, horario_inicio: '14:00', horario_fim: '15:00' }).then((v2) => {
          criarUsuarioAtivo(t.coord).then((aluno) => {
            agendar(aluno.token, v1.id).then((r) => {
              const ag = r.body.agendamento.id;
              // dado legado: entrada registrada num agendamento ainda a mais de 24h da prova
              cy.bd(`UPDATE agendamentos SET entrada_confirmada_em = NOW(), entrada_confirmada_por = 'CY' WHERE id = $1`, [ag]);
              cancelar(aluno.token, ag).then((c) => {
                expect(c.status, JSON.stringify(c.body)).to.eq(400);
                expect(c.body.mensagem).to.contain('entrada');
              });
              reagendar(aluno.token, ag, v2.id).then((c) => {
                expect(c.status, JSON.stringify(c.body)).to.eq(400);
                expect(c.body.mensagem).to.contain('entrada');
              });
              cy.bd('SELECT status FROM agendamentos WHERE id = $1', [ag]).then((rows) => expect(rows[0].status).to.eq('ATIVO'));
            });
          });
        });
      });
    });
  });

  // ---------------------------------------------------------------------------
  describe('4. corpo ausente ou sem Content-Type JSON', () => {
    const semCorpo = (caminho, token, extra = {}) => cy.request({
      method: 'POST', url: `${API_URL}${caminho}`, failOnStatusCode: false,
      headers: token ? { Authorization: `Bearer ${token}` } : {}, ...extra
    });

    it('login sem corpo e com text/plain: 400, nunca 500', () => {
      semCorpo('/api/login').its('status').should('eq', 400);
      semCorpo('/api/login', null, { body: 'matricula=x&senha=y', headers: { 'Content-Type': 'text/plain' } }).its('status').should('eq', 400);
    });

    it('rotas autenticadas sem corpo: 400', () => {
      cy.tokenDe(USUARIOS.alunoA1).then((tokenAluno) => {
        semCorpo('/api/agendar', tokenAluno).its('status').should('eq', 400);
        semCorpo('/api/cancelar-agendamento', tokenAluno).its('status').should('eq', 400);
      });
      semCorpo('/api/alterar-status-usuario', t.coord).its('status').should('eq', 400);
      semCorpo('/api/solicitar-codigo').its('status').should('eq', 400);
    });
  });

  // ---------------------------------------------------------------------------
  describe('5. ids e números inválidos', () => {
    it('id maior que o INTEGER do Postgres: 400 (não 500)', () => {
      cy.tokenDe(USUARIOS.alunoA1).then((tokenAluno) => {
        cy.api('POST', '/api/agendar', { token: tokenAluno, body: { vaga_id: 99999999999 } }).its('status').should('eq', 400);
        cy.api('POST', '/api/cancelar-agendamento', { token: tokenAluno, body: { agendamento_id: '99999999999' } }).its('status').should('eq', 400);
      });
      cy.api('POST', '/api/atualizar-nota', { token: t.coord, body: { id: '99999999999', nota: 5 } }).its('status').should('eq', 400);
      confirmar(99999999999).its('status').should('eq', 400);
      cy.api('POST', '/api/alterar-status-usuario', { token: t.coord, body: { id: 2147483648, ativo: false } }).its('status').should('eq', 400);
    });

    it('números com lixo ou decimais: 400', () => {
      cy.api('POST', '/api/atualizar-nota', { token: t.coord, body: { id: '12abc', nota: 5 } }).its('status').should('eq', 400);
      cy.api('POST', '/api/alterar-status-disciplina', { token: t.coord, body: { id: '3.5', ativa: true } }).its('status').should('eq', 400);
      confirmar('7xyz').its('status').should('eq', 400);
      confirmar(-1).its('status').should('eq', 400);
    });

    it('limite de vagas "5.9xyz" ou 5.9: 400 e nenhuma vaga criada', () => {
      const disciplina = `CY-limite-${unico()}`;
      criarVaga(t.coord, { disciplina }).then((base) => {
        ['5.9xyz', 5.9, '1e2'].forEach((limite, i) => {
          cy.api('POST', '/api/cadastrar-vaga', {
            token: t.coord,
            body: { ...base, horario_inicio: `1${i + 4}:00`, horario_fim: `1${i + 4}:30`, limite_vagas: limite }
          }).then((r) => {
            expect(r.status, `limite ${JSON.stringify(limite)}: ${JSON.stringify(r.body)}`).to.eq(400);
            expect(r.body.mensagem).to.contain('número inteiro');
          });
        });
        cy.bd('SELECT COUNT(*)::int AS n FROM vagas WHERE disciplina = $1', [disciplina]).then((rows) => expect(rows[0].n).to.eq(1));
      });
    });
  });

  // ---------------------------------------------------------------------------
  describe('6. cancelamento repetido', () => {
    it('4 cancelamentos ao mesmo tempo: só 1 vale e só 1 log de auditoria', () => {
      criarVaga(t.coord).then((v) => {
        criarUsuarioAtivo(t.coord).then((aluno) => {
          agendar(aluno.token, v.id).then((r) => {
            const ag = r.body.agendamento.id;
            cy.task('paralelo', [1, 2, 3, 4].map(() => ({
              method: 'POST', url: `${API_URL}/api/cancelar-agendamento`, headers: { Authorization: `Bearer ${aluno.token}` }, body: { agendamento_id: ag }
            }))).then((rs) => {
              expect(rs.filter((x) => x.status === 200), JSON.stringify(rs)).to.have.length(1);
              expect(rs.filter((x) => x.status === 404)).to.have.length(3);
            });
            cy.bd(`SELECT COUNT(*)::int AS n FROM auditoria WHERE acao = 'CANCELAMENTO_REALIZADO' AND descricao LIKE $1`,
              [`%${aluno.nome} cancelou o agendamento de ${v.disciplina}%`])
              .then((rows) => expect(rows[0].n, 'logs de cancelamento').to.eq(1));
          });
        });
      });
    });
  });

  // ---------------------------------------------------------------------------
  describe('7. exclusão simultânea de coordenadores', () => {
    let desativados = [];

    afterEach(() => {
      // devolve os coordenadores que o teste tirou do caminho (inclusive o TESTE_COORD)
      if (desativados.length) cy.bd('UPDATE usuarios SET ativo = true WHERE id = ANY($1)', [desativados]);
      desativados = [];
    });

    it('dois coordenadores excluindo um ao outro ao mesmo tempo: sempre sobra um ativo', () => {
      criarUsuarioAtivo(t.coord, { tipo: 'coordenador', curso: '' }).then((c1) => {
        criarUsuarioAtivo(t.coord, { tipo: 'coordenador', curso: '' }).then((c2) => {
          // deixa só c1 e c2 como coordenadores ativos
          cy.bd(`UPDATE usuarios SET ativo = false
                  WHERE ativo AND LOWER(TRIM(tipo)) = 'coordenador' AND id <> ALL($1) RETURNING id`, [[c1.id, c2.id]])
            .then((rows) => { desativados = rows.map((x) => x.id); });

          cy.task('paralelo', [
            { method: 'POST', url: `${API_URL}/api/alterar-status-usuario`, headers: { Authorization: `Bearer ${c1.token}` }, body: { id: c2.id, ativo: false } },
            { method: 'POST', url: `${API_URL}/api/alterar-status-usuario`, headers: { Authorization: `Bearer ${c2.token}` }, body: { id: c1.id, ativo: false } }
          ]).then((rs) => {
            // quem perde recebe 400 (último coordenador) ou 401 (a própria conta já foi excluída pelo outro)
            const [primeiro, segundo] = rs.map((x) => x.status).sort();
            expect(primeiro, JSON.stringify(rs)).to.eq(200);
            expect(segundo, JSON.stringify(rs)).to.be.oneOf([400, 401]);
          });
          cy.bd(`SELECT COUNT(*)::int AS n FROM usuarios WHERE id = ANY($1) AND ativo`, [[c1.id, c2.id]])
            .then((rows) => expect(rows[0].n, 'coordenadores ativos').to.eq(1));
        });
      });
    });
  });

  // ---------------------------------------------------------------------------
  describe('8. limites de tamanho', () => {
    const email = () => `cy-${unico()}@teste.local`;
    const cadastrar = (body) => cy.api('POST', '/api/cadastrar-usuario', { token: t.coord, body });
    const naoCriou = (mail) =>
      cy.bd('SELECT COUNT(*)::int AS n FROM usuarios WHERE LOWER(email) = LOWER($1)', [mail]).then((rows) => expect(rows[0].n).to.eq(0));

    it('cadastro de usuário: nome > 150, e-mail > 254, curso > 100: 400', () => {
      const casos = [
        { nome: 'N'.repeat(151), email: email(), tipo: 'Aluno', curso: 'CY Curso A' },
        { nome: 'Cy Limite', email: `cy-${'e'.repeat(250)}@teste.local`, tipo: 'Aluno', curso: 'CY Curso A' },
        { nome: 'Cy Limite', email: email(), tipo: 'Aluno', curso: 'C'.repeat(101) }
      ];
      casos.forEach((corpo) => {
        cadastrar(corpo).then((r) => {
          expect(r.status, JSON.stringify(r.body)).to.eq(400);
          expect(r.body.mensagem).to.contain('no máximo');
        });
        naoCriou(corpo.email);
      });
    });

    it('nos limites exatos (nome 150, curso 100) o cadastro passa', () => {
      cadastrar({ nome: 'N'.repeat(150), email: email(), tipo: 'Aluno', curso: 'C'.repeat(100) }).its('status').should('eq', 200);
    });

    it('vaga: polo ou curso > 100: 400', () => {
      const disciplina = `CY-tam-${unico()}`;
      criarVaga(t.coord, { disciplina }).then((base) => {
        [{ polo: 'P'.repeat(101) }, { curso: 'C'.repeat(101) }].forEach((extra, i) => {
          cy.api('POST', '/api/cadastrar-vaga', {
            token: t.coord, body: { ...base, horario_inicio: `1${i + 4}:00`, horario_fim: `1${i + 4}:30`, ...extra }
          }).then((r) => {
            expect(r.status, JSON.stringify(r.body)).to.eq(400);
            expect(r.body.mensagem).to.contain('no máximo');
          });
        });
        cy.bd('SELECT COUNT(*)::int AS n FROM vagas WHERE disciplina = $1', [disciplina]).then((rows) => expect(rows[0].n).to.eq(1));
      });
    });

    it('buscas com mais de 100 caracteres: 400', () => {
      const longa = encodeURIComponent('x'.repeat(101));
      cy.api('GET', `/api/usuarios?busca=${longa}`, { token: t.coord }).its('status').should('eq', 400);
      cy.api('GET', `/api/portaria/consultar?busca=${longa}`, { token: t.recepcao }).its('status').should('eq', 400);
      cy.api('GET', `/api/portaria/por-data?data=${hojeSP()}&busca=${longa}`, { token: t.recepcao }).its('status').should('eq', 400);
    });
  });

  // ---------------------------------------------------------------------------
  describe('9. booleanos com tipo errado', () => {
    it('alterar-status-disciplina com ativa "true" (texto): 400 e a disciplina não muda', () => {
      const nome = `CY-bool-${unico()}`;
      cy.api('POST', '/api/disciplinas', { token: t.coord, body: { nome } }).then((r) => {
        ['true', 'false', 1, null].forEach((ativa) => {
          cy.api('POST', '/api/alterar-status-disciplina', { token: t.coord, body: { id: r.body.id, ativa } })
            .its('status').should('eq', 400);
        });
        cy.api('POST', '/api/alterar-status-disciplina', { token: t.coord, body: { id: r.body.id } }).its('status').should('eq', 400);
        cy.bd('SELECT ativa FROM disciplinas WHERE id = $1', [r.body.id]).then((rows) => expect(rows[0].ativa).to.eq(true));
      });
    });

    it('alterar-status-usuario com ativo "true" (texto): 400 e o usuário não é excluído', () => {
      criarUsuarioAtivo(t.coord).then((u) => {
        ['true', 'false', 0, null].forEach((ativo) => {
          cy.api('POST', '/api/alterar-status-usuario', { token: t.coord, body: { id: u.id, ativo } }).its('status').should('eq', 400);
        });
        cy.api('POST', '/api/alterar-status-usuario', { token: t.coord, body: { id: u.id } }).its('status').should('eq', 400);
        cy.bd('SELECT ativo FROM usuarios WHERE id = $1', [u.id]).then((rows) => expect(rows[0].ativo).to.eq(true));
      });
    });
  });

  // ---------------------------------------------------------------------------
  describe('10. conexão do banco derrubada', () => {
    it('o servidor continua respondendo depois que o banco encerra as conexões dele', () => {
      cy.api('GET', '/api/perfil', { token: t.coord }).its('status').should('eq', 200); // garante conexão ociosa no pool
      // encerra SÓ as conexões do servidor (identificadas pelo application_name do pool)
      cy.bd(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
              WHERE application_name = 'portal-backend' AND pid <> pg_backend_pid()`).then((rows) => {
        expect(rows.length, 'nenhuma conexão do servidor encontrada (application_name)').to.be.greaterThan(0);
      });
      cy.wait(1500);
      cy.api('GET', '/api/perfil', { token: t.coord }).its('status').should('eq', 200);
    });
  });
});
