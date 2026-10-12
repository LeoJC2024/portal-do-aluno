-- Usuários-semente dos testes (idempotente: também "reseta" as senhas a cada execução).
-- Senhas em texto puro de propósito: o servidor converte para bcrypt no primeiro login.
-- Matrículas "TESTE_*" não seguem o padrão E00000/C00000/AT00000, então não atrapalham a sequência.
INSERT INTO usuarios (nome, matricula, curso, tipo, senha, email, ativo, trocar_senha) VALUES
 ('Teste Coordenador', 'TESTE_COORD',    'CY Curso A', 'coordenador',      'Teste@1234',  'seed-coord@teste.local',  true, false),
 ('Teste Recepcao',    'TESTE_RECEP',    'CY Curso A', 'Recepção do Polo', 'Teste@1234',  'seed-recep@teste.local',  true, false),
 ('Teste Auditor',     'TESTE_AUDIT',    'CY Curso A', 'AUDIT',            'Teste@1234',  'seed-audit@teste.local',  true, false),
 ('Teste Aluno A1',    'TESTE_ALUNO_A1', 'CY Curso A', 'Aluno',            'Teste@1234',  'seed-a1@teste.local',     true, false),
 ('Teste Aluno A2',    'TESTE_ALUNO_A2', 'CY Curso A', 'Aluno',            'Teste@1234',  'seed-a2@teste.local',     true, false),
 ('Teste Aluno B',     'TESTE_ALUNO_B',  'CY Curso B', 'Aluno',            'Teste@1234',  'seed-b@teste.local',      true, false),
 ('Teste Legado',      'TESTE_LEGADO',   'CY Curso A', 'Aluno',            'Legado@1234', 'seed-legado@teste.local', true, false)
ON CONFLICT (matricula) DO UPDATE SET
  nome = EXCLUDED.nome, curso = EXCLUDED.curso, tipo = EXCLUDED.tipo, senha = EXCLUDED.senha,
  email = EXCLUDED.email, ativo = true, trocar_senha = false, polo = NULL,
  codigo_recuperacao = NULL, codigo_expiracao = NULL, codigo_tentativas = 0;
