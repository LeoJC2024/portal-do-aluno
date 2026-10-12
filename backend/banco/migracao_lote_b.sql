-- =====================================================================
-- MIGRAÇÃO DO LOTE B: e-mail único sem diferenciar maiúsculas/minúsculas.
-- Rode PRIMEIRO no projeto Supabase de TESTE; depois de validar, no de produção.
-- Rode em DUAS ETAPAS, no SQL Editor do Supabase.
-- =====================================================================


-- ---------------------------------------------------------------------
-- ETAPA 1 (só leitura): e-mails que só diferem por maiúsculas/minúsculas ou espaços.
-- Se esta consulta devolver alguma linha, resolva esses casos ANTES da etapa 2
-- (por exemplo, corrigindo o e-mail de um dos cadastros). Com linhas aqui, a etapa 2 falha.
-- ---------------------------------------------------------------------
SELECT LOWER(TRIM(email)) AS email_normalizado,
       COUNT(*)           AS quantidade,
       STRING_AGG(
         format('id %s, matrícula %s, e-mail "%s"%s', id, matricula, email, CASE WHEN ativo THEN '' ELSE ' (excluído)' END),
         ' | ' ORDER BY id
       ) AS cadastros
  FROM usuarios
 WHERE email IS NOT NULL
 GROUP BY LOWER(TRIM(email))
HAVING COUNT(*) > 1
 ORDER BY 1;


-- ---------------------------------------------------------------------
-- ETAPA 2: rode só quando a etapa 1 não devolver nenhuma linha.
-- Tudo numa transação: se algo falhar, nada é alterado.
-- ---------------------------------------------------------------------
BEGIN;

-- o servidor passa a gravar o e-mail em minúsculas; aqui os cadastros antigos ficam iguais
UPDATE usuarios
   SET email = LOWER(TRIM(email))
 WHERE email IS NOT NULL AND email <> LOWER(TRIM(email));

CREATE UNIQUE INDEX IF NOT EXISTS uq_usuarios_email_ci ON usuarios (LOWER(email));

COMMIT;
