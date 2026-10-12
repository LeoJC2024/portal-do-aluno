-- =====================================================================
-- ESQUEMA DO BANCO DE TESTE  (rode UMA vez, SÓ no banco de teste)
-- Reconstruído a partir das colunas que o sistema usa, já com todas as migrações aplicadas.
-- NÃO rode no banco de produção.
-- =====================================================================

CREATE TABLE IF NOT EXISTS usuarios (
  id                  SERIAL PRIMARY KEY,
  nome                TEXT NOT NULL,
  matricula           TEXT NOT NULL UNIQUE,
  curso               TEXT,
  tipo                TEXT NOT NULL,
  senha               TEXT NOT NULL,
  email               TEXT UNIQUE,
  foto_url            TEXT,
  codigo_recuperacao  TEXT,
  codigo_expiracao    TIMESTAMPTZ,
  codigo_tentativas   INTEGER NOT NULL DEFAULT 0,
  polo                TEXT,
  ativo               BOOLEAN NOT NULL DEFAULT true,
  trocar_senha        BOOLEAN NOT NULL DEFAULT false,
  criado_em           TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vagas (
  id           SERIAL PRIMARY KEY,
  polo         TEXT,
  curso        TEXT,
  disciplina   TEXT,
  data_prova   DATE,
  horario      TIME,
  horario_fim  TIME,
  limite_vagas INTEGER
);

CREATE TABLE IF NOT EXISTS agendamentos (
  id                     SERIAL PRIMARY KEY,
  vaga_id                INTEGER REFERENCES vagas(id),
  aluno_nome             TEXT,
  data_agendada          DATE,
  horario_agendado       VARCHAR(50),
  status                 VARCHAR(20) DEFAULT 'ATIVO',
  usuario_id             BIGINT REFERENCES usuarios(id),
  entrada_confirmada_em  TIMESTAMPTZ,
  entrada_confirmada_por TEXT,
  criado_em              TIMESTAMP DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_agendamento_ativo ON agendamentos (usuario_id, vaga_id) WHERE status = 'ATIVO';
CREATE INDEX IF NOT EXISTS ix_agendamentos_vaga ON agendamentos (vaga_id) WHERE status = 'ATIVO';

CREATE TABLE IF NOT EXISTS auditoria (
  id         SERIAL PRIMARY KEY,
  acao       TEXT,
  descricao  TEXT,
  ip         TEXT,
  data_hora  TIMESTAMP DEFAULT now(),
  usuario    TEXT
);

CREATE OR REPLACE FUNCTION auditoria_imutavel() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'A tabela auditoria é imutável (% bloqueado).', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_auditoria_imutavel ON auditoria;
CREATE TRIGGER trg_auditoria_imutavel
  BEFORE UPDATE OR DELETE ON auditoria
  FOR EACH ROW EXECUTE FUNCTION auditoria_imutavel();

CREATE TABLE IF NOT EXISTS notas_alunos (
  id          SERIAL PRIMARY KEY,
  nome_aluno  TEXT,
  matricula   TEXT,
  avaliacao   TEXT,
  polo        TEXT,
  nota        NUMERIC(4,2)
);
