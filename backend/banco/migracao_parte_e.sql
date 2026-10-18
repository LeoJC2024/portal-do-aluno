-- =====================================================================
-- MIGRAÇÃO PARTE E: a mesma prova (polo + disciplina + data + horário) pode existir para
-- cursos diferentes, cada um com o seu limite de vagas.
-- Rode PRIMEIRO no projeto Supabase de TESTE; depois de validar, no de produção.
-- Rode no SQL Editor do Supabase.
--
-- O índice único antigo (uq_vagas_disciplina_data_hora_polo) não tinha o curso, então o banco
-- recusava a vaga do Curso B no mesmo polo, disciplina, data e horário de uma vaga do Curso A.
-- O índice novo é o antigo + o curso (sem diferenciar maiúsculas/minúsculas e espaços nas pontas).
--
-- Não altera nenhuma linha. Não tem como falhar por causa dos dados atuais: tudo que hoje é único
-- no índice antigo continua único no novo, porque o novo só acrescenta uma coluna.
-- A comparação do polo sem diferenciar maiúsculas/minúsculas fica no servidor (com advisory lock);
-- o índice é a proteção extra contra cadastros iguais feitos fora do servidor.
-- =====================================================================

BEGIN;

-- cria o novo primeiro: em nenhum momento a tabela fica sem proteção contra vaga repetida
CREATE UNIQUE INDEX IF NOT EXISTS uq_vagas_polo_disciplina_curso_data_hora
    ON vagas (polo, LOWER(TRIM(disciplina)), LOWER(TRIM(COALESCE(curso, ''))), data_prova, horario);

DROP INDEX IF EXISTS uq_vagas_disciplina_data_hora_polo;

COMMIT;


-- ---------------------------------------------------------------------
-- CONFERÊNCIA (só leitura): deve listar uq_vagas_polo_disciplina_curso_data_hora
-- e NÃO listar mais uq_vagas_disciplina_data_hora_polo.
-- ---------------------------------------------------------------------
SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'vagas' ORDER BY indexname;
