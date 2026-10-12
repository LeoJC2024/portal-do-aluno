-- =====================================================================
-- Deixa o banco de TESTE no esquema atual do sistema.
-- Pode rodar quantas vezes quiser (tudo é "IF NOT EXISTS").
-- >>> RODE SÓ NO PROJETO SUPABASE DE TESTE. NUNCA NO DE PRODUÇÃO. <<<
-- =====================================================================

-- limpa dados de teste antigos que poderiam impedir a criação dos índices únicos
DELETE FROM agendamentos WHERE vaga_id IN (SELECT id FROM vagas WHERE disciplina LIKE 'CY-%');
DELETE FROM vagas WHERE disciplina LIKE 'CY-%';

-- usuarios
ALTER TABLE usuarios ALTER COLUMN senha TYPE text;
ALTER TABLE usuarios ALTER COLUMN codigo_recuperacao TYPE text;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS codigo_tentativas integer NOT NULL DEFAULT 0;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS polo text;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ativo boolean NOT NULL DEFAULT true;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS trocar_senha boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS uq_usuarios_matricula_ci ON usuarios (LOWER(matricula));

-- agendamentos
ALTER TABLE agendamentos ADD COLUMN IF NOT EXISTS usuario_id bigint REFERENCES usuarios(id);
ALTER TABLE agendamentos ADD COLUMN IF NOT EXISTS entrada_confirmada_em timestamptz;
ALTER TABLE agendamentos ADD COLUMN IF NOT EXISTS entrada_confirmada_por text;
CREATE UNIQUE INDEX IF NOT EXISTS uq_agendamento_ativo ON agendamentos (usuario_id, vaga_id) WHERE status = 'ATIVO';

-- auditoria (tabela imutável)
ALTER TABLE auditoria ADD COLUMN IF NOT EXISTS usuario text;
CREATE OR REPLACE FUNCTION auditoria_imutavel() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'A tabela auditoria é imutável (% bloqueado).', TG_OP;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_auditoria_imutavel ON auditoria;
CREATE TRIGGER trg_auditoria_imutavel BEFORE UPDATE OR DELETE ON auditoria
  FOR EACH ROW EXECUTE FUNCTION auditoria_imutavel();

-- vagas
ALTER TABLE vagas ADD COLUMN IF NOT EXISTS horario_fim time;
ALTER TABLE vagas ADD COLUMN IF NOT EXISTS curso text;
ALTER TABLE vagas ADD COLUMN IF NOT EXISTS agendamento_inicio date;
ALTER TABLE vagas ADD COLUMN IF NOT EXISTS agendamento_fim date;
ALTER TABLE vagas ADD COLUMN IF NOT EXISTS criado_em timestamptz;
ALTER TABLE vagas ADD COLUMN IF NOT EXISTS criado_por text;
ALTER TABLE vagas ALTER COLUMN criado_em SET DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS uq_vagas_disciplina_data_hora_polo
    ON vagas (polo, LOWER(TRIM(disciplina)), data_prova, horario);

-- disciplinas
CREATE TABLE IF NOT EXISTS disciplinas (
  id         SERIAL PRIMARY KEY,
  nome       TEXT NOT NULL,
  ativa      BOOLEAN NOT NULL DEFAULT true,
  criado_em  TIMESTAMPTZ NOT NULL DEFAULT now(),
  criado_por TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_disciplinas_nome_ci ON disciplinas (LOWER(TRIM(nome)));
INSERT INTO disciplinas (nome) VALUES ('A'), ('B'), ('C') ON CONFLICT DO NOTHING;

-- sobras dos scripts da varredura de falhas (as vagas CY-PROBE-* já saem no começo deste arquivo):
-- usuários de teste inativos (e-mail cy-probe-*@exemplo.com ou nome gigante), disciplinas CY-PROBE-*
-- e o código de recuperação pendente do TESTE_ALUNO_B. Os logs de auditoria ficam (tabela imutável).
DELETE FROM agendamentos
 WHERE usuario_id IN (SELECT id FROM usuarios
                       WHERE NOT ativo AND (LOWER(email) LIKE 'cy-probe-%@exemplo.com' OR char_length(nome) > 150));
DELETE FROM usuarios
 WHERE NOT ativo AND (LOWER(email) LIKE 'cy-probe-%@exemplo.com' OR char_length(nome) > 150);
DELETE FROM disciplinas WHERE nome LIKE 'CY-PROBE%';
UPDATE usuarios
   SET codigo_recuperacao = NULL, codigo_expiracao = NULL, codigo_tentativas = 0
 WHERE matricula = 'TESTE_ALUNO_B';
