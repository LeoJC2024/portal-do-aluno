-- =====================================================================
-- MIGRAÇÃO DA AUDITORIA: índices para os filtros e a paginação da trilha de auditoria.
-- Rode PRIMEIRO no projeto Supabase de TESTE; depois de validar, no de produção.
-- Rode no SQL Editor do Supabase (pode rodar mais de uma vez: usa IF NOT EXISTS).
--
-- Só cria índices: NÃO altera, apaga nem reescreve nenhuma linha da auditoria,
-- e a trigger de imutabilidade (trg_auditoria_imutavel) continua como está.
-- Enquanto cada índice é criado, novos INSERTs na auditoria esperam alguns instantes.
-- =====================================================================

-- ordenação (mais novo primeiro) + paginação + filtro por período
CREATE INDEX IF NOT EXISTS ix_auditoria_data_hora ON auditoria (data_hora DESC, id DESC);

-- filtro por tipo de ação (já ordenado por data dentro de cada ação)
CREATE INDEX IF NOT EXISTS ix_auditoria_acao_data_hora ON auditoria (acao, data_hora DESC);


-- ---------------------------------------------------------------------
-- CONFERÊNCIA (só leitura): deve listar os dois índices acima e a trigger de imutabilidade.
-- ---------------------------------------------------------------------
SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'auditoria' ORDER BY indexname;
SELECT tgname FROM pg_trigger WHERE tgrelid = 'auditoria'::regclass AND NOT tgisinternal;
