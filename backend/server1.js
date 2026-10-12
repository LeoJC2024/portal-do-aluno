// uso normal:  node server.js
// testes:      node server.js --env=.env.teste --modo-teste
const argEnv = process.argv.find((a) => a.startsWith('--env='));
require('dotenv').config({ path: argEnv ? argEnv.slice(6) : '.env' });
const MODO_TESTE = process.argv.includes('--modo-teste');

const express = require('express');
const { Pool, types } = require('pg');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// ==========================================
// CONFIGURAÇÃO
// ==========================================
const JWT_SECRET = process.env.JWT_SECRET || '';
if (JWT_SECRET.length < 32) {
  console.error('JWT_SECRET ausente ou curto demais (mínimo 32 caracteres). Gere com:');
  console.error(`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`);
  process.exit(1);
}

const FUSO = 'America/Sao_Paulo';

// Modo de teste (Cypress): não envia e-mails e devolve senha provisória / código de recuperação
// nas respostas. Só liga se o .env apontar para um banco marcado como de teste.
if (MODO_TESTE) {
  if (process.env.BANCO_DE_TESTE !== 'sim' || process.env.NODE_ENV === 'production') {
    console.error('--modo-teste exige BANCO_DE_TESTE=sim no arquivo .env usado e NODE_ENV diferente de production.');
    process.exit(1);
  }
  console.warn('\n⚠️  MODO DE TESTE ATIVO: e-mails desligados e segredos expostos nas respostas. NUNCA use em produção.\n');
}
const MAX_TENTATIVAS_CODIGO = 5;

// DATE vem como 'YYYY-MM-DD' (sem virar Date e sem deslocar de fuso)
types.setTypeParser(1082, (v) => v);
// TIMESTAMP sem fuso é gravado em UTC pelo Supabase
types.setTypeParser(1114, (v) => new Date(v.replace(' ', 'T') + 'Z'));

const app = express();
app.use(helmet());
const jsonPequeno = express.json({ limit: '100kb' });
const jsonComFoto = express.json({ limit: '1mb' });
const ROTAS_COM_FOTO = ['/api/cadastrar-usuario', '/api/atualizar-foto'];
app.use((req, res, next) => (ROTAS_COM_FOTO.includes(req.path) ? jsonComFoto : jsonPequeno)(req, res, next));

if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY));

const origensPermitidas = (
  process.env.ALLOWED_ORIGINS ||
  'http://localhost:5500,http://127.0.0.1:5500,http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173'
).split(',').map((s) => s.trim());

app.use(cors({
  origin: (origin, cb) => (!origin || origensPermitidas.includes(origin))
    ? cb(null, true)
    : cb(new Error('Origem não permitida pelo CORS.'))
}));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false }
});

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});
if (MODO_TESTE) transporter.sendMail = async () => ({ accepted: [], modoTeste: true });

// ==========================================
// HELPERS
// ==========================================
const PERFIL = {
  ALUNO: 'aluno',
  COORD: 'coordenador',
  RECEPCAO: 'recepção do polo',
  AUDIT: 'audit'
};
const TIPOS_CADASTRAVEIS = ['Aluno', 'coordenador', 'Recepção do Polo'];

const normalizar = (t) => String(t || '').trim().toLowerCase();
const ehHash = (s) => /^\$2[aby]\$/.test(String(s || ''));
const DUMMY_HASH = bcrypt.hashSync('senha-falsa-para-tempo-constante', 10);

class ErroHttp extends Error {
  constructor(status, mensagem) {
    super(mensagem);
    this.status = status;
  }
}

// captura erros de rotas async e manda para o handler global
const rota = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function igualSeguro(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const hashCodigo = (codigo) =>
  crypto.createHmac('sha256', JWT_SECRET).update(String(codigo)).digest('hex');

const escapeLike = (s) => String(s).replace(/[\\%_]/g, (c) => '\\' + c);

// ---------- matrícula automática e senha provisória ----------
const PREFIXO_MATRICULA = { 'Aluno': 'E', 'coordenador': 'C', 'Recepção do Polo': 'AT' };
const ALFABETO_SENHA = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'; // sem 0/O, 1/l/I

function gerarSenhaProvisoria(tamanho = 10) {
  let senha = '';
  for (let i = 0; i < tamanho; i++) senha += ALFABETO_SENHA[crypto.randomInt(ALFABETO_SENHA.length)];
  return senha;
}

// próxima matrícula da sequência (E00000, E00001...). Usa lock para dois cadastros
// simultâneos não receberem o mesmo número. Matrículas de excluídos continuam
// na tabela, então nunca são reaproveitadas.
async function proximaMatricula(client, prefixo) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`matricula:${prefixo}`]);
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(matricula FROM '[0-9]{5}$') AS integer)), -1) + 1 AS prox
       FROM usuarios WHERE matricula ~ $1`,
    [`^${prefixo}[0-9]{5}$`]
  );
  const n = rows[0].prox;
  if (n > 99999) throw new ErroHttp(409, `Limite de matrículas ${prefixo} atingido.`);
  return `${prefixo}${String(n).padStart(5, '0')}`;
}

async function enviarEmailBoasVindas({ nome, email, matricula, senhaProvisoria }) {
  const link = process.env.PORTAL_URL ? `\nEndereço do portal: ${process.env.PORTAL_URL}\n` : '';
  try {
    await transporter.sendMail({
      from: `"Portal UNIFAA" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Seu acesso ao Portal UNIFAA',
      text:
`Olá ${nome},

Seu acesso ao Portal UNIFAA foi criado.

Matrícula: ${matricula}
Senha provisória: ${senhaProvisoria}
${link}
No primeiro acesso é obrigatório definir uma nova senha:
1. Abra a tela de login do portal.
2. Digite a sua matrícula e clique em "Esqueci minha senha".
3. Na janela que abrir, clique em "Já tenho a senha provisória".
4. Informe a senha provisória acima e escolha a sua nova senha (mínimo de 8 caracteres).

Depois disso, entre normalmente com a matrícula e a nova senha.
A senha provisória não permite entrar no sistema.

Se você não esperava este e-mail, pode ignorá-lo.`
    });
  } catch (err) {
    console.error('Falha ao enviar e-mail de boas-vindas:', err.message);
    throw new ErroHttp(502, 'Não foi possível enviar o e-mail com a senha provisória. Usuário não cadastrado; confira o e-mail e tente novamente.');
  }
}

// ---------- fotos (Supabase Storage) ----------
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const BUCKET_FOTOS = process.env.SUPABASE_BUCKET || 'fotos-alunos';
const TAMANHO_MAX_FOTO = 600 * 1024;
const PREFIXO_URL_FOTO = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET_FOTOS}/`;

function decodificarFoto(dataUrl) {
  const m = /^data:(image\/(jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new ErroHttp(400, 'Foto inválida. Use uma imagem JPG, PNG ou WEBP.');

  const buffer = Buffer.from(m[3], 'base64');
  if (buffer.length === 0 || buffer.length > TAMANHO_MAX_FOTO) {
    throw new ErroHttp(400, 'A foto deve ter no máximo 600 KB.');
  }

  // confere o conteúdo real do arquivo, não só o que o navegador declarou
  const ehJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const ehPng = buffer.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const ehWebp = buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  const confere = (m[2] === 'jpeg' && ehJpeg) || (m[2] === 'png' && ehPng) || (m[2] === 'webp' && ehWebp);
  if (!confere) throw new ErroHttp(400, 'O arquivo enviado não é uma imagem válida.');

  return { buffer, mime: m[1], ext: m[2] === 'jpeg' ? 'jpg' : m[2] };
}

async function enviarFoto(dataUrl) {
  const { buffer, mime, ext } = decodificarFoto(dataUrl); // valida primeiro (erro 400 antes de qualquer config)
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new ErroHttp(500, 'Armazenamento de fotos não configurado no servidor (SUPABASE_URL e SUPABASE_SERVICE_KEY).');
  }
  const caminho = `${crypto.randomUUID()}.${ext}`;

  const resp = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET_FOTOS}/${caminho}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      apikey: SUPABASE_SERVICE_KEY,
      'Content-Type': mime,
      'x-upsert': 'false'
    },
    body: buffer
  });

  if (!resp.ok) {
    console.error('Falha ao enviar foto ao Storage:', resp.status, await resp.text().catch(() => ''));
    throw new ErroHttp(502, 'Não foi possível salvar a foto no armazenamento. Confira o bucket e as chaves do Supabase.');
  }
  return { caminho, url: `${PREFIXO_URL_FOTO}${caminho}` };
}

async function removerFoto(caminho) {
  if (!caminho || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET_FOTOS}/${caminho}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, apikey: SUPABASE_SERVICE_KEY }
    });
  } catch (err) {
    console.error('Falha ao remover foto antiga:', err.message);
  }
}

// só apaga arquivos que estão no nosso bucket (fotos colocadas à mão por URL externa são ignoradas)
const caminhoDaFoto = (url) =>
  SUPABASE_URL && String(url || '').startsWith(PREFIXO_URL_FOTO) ? String(url).slice(PREFIXO_URL_FOTO.length) : null;

// valida data (YYYY-MM-DD existente no calendário) e hora (HH:MM entre 00:00 e 23:59)
const dataValida = (s) =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) &&
  new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const horaValida = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

// regras para uma vaga poder receber um aluno (usada em agendar e reagendar)
function validarVagaParaAgendar(vaga, usuario) {
  if (!vaga) throw new ErroHttp(404, 'Vaga não encontrada.');
  if (!vaga.futura) throw new ErroHttp(400, 'Esta prova já ocorreu ou está em andamento.');
  if (vaga.curso && normalizar(vaga.curso) !== normalizar(usuario.curso)) {
    throw new ErroHttp(403, 'Esta avaliação não é do seu curso.');
  }
  if (vaga.nao_abriu) {
    throw new ErroHttp(400, `O agendamento desta avaliação abre em ${String(vaga.agendamento_inicio).split('-').reverse().join('/')}.`);
  }
  if (vaga.encerrou) {
    throw new ErroHttp(400, 'O período de agendamento desta avaliação já foi encerrado.');
  }
}

async function registrarAuditoria(db, acao, descricao, usuario, ip) {
  await db.query(
    'INSERT INTO auditoria (acao, descricao, usuario, ip) VALUES ($1, $2, $3, $4)',
    [acao, descricao, usuario || null, ip || null]
  );
}

// ---------- autenticação / autorização ----------
async function autenticar(req, res, next) {
  const cabecalho = req.headers.authorization || '';
  const token = cabecalho.startsWith('Bearer ') ? cabecalho.slice(7) : null;
  if (!token) return res.status(401).json({ sucesso: false, mensagem: 'Não autenticado.' });

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (_) {
    return res.status(401).json({ sucesso: false, mensagem: 'Sessão inválida ou expirada.' });
  }

  try {
    // usuário excluído perde o acesso na hora, mesmo com token ainda válido;
    // perfil e polo vêm do banco, não do token
    const { rows } = await pool.query('SELECT ativo, tipo, polo, curso FROM usuarios WHERE id = $1', [payload.id]);
    if (!rows[0] || !rows[0].ativo) {
      return res.status(401).json({ sucesso: false, mensagem: 'Conta desativada ou inexistente.' });
    }
    req.usuario = {
      ...payload,
      tipo: String(rows[0].tipo || '').trim(),
      perfil: normalizar(rows[0].tipo),
      polo: rows[0].polo || null,
      curso: rows[0].curso || null
    };
    next();
  } catch (err) {
    next(err);
  }
}

const exigirPerfil = (...perfis) => (req, res, next) => {
  if (!perfis.includes(req.usuario?.perfil)) {
    return res.status(403).json({ sucesso: false, mensagem: 'Seu perfil não tem permissão para esta ação.' });
  }
  next();
};

// ---------- limitadores ----------
const limitadorLogin = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: MODO_TESTE ? 100000 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { sucesso: false, mensagem: 'Muitas tentativas de login. Aguarde 15 minutos.' }
});

const limitadorSenha = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: MODO_TESTE ? 100000 : 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { sucesso: false, mensagem: 'Muitas solicitações. Aguarde alguns minutos.' }
});

// ==========================================
// AUTENTICAÇÃO E CADASTRO
// ==========================================
app.post('/api/login', limitadorLogin, rota(async (req, res) => {
  const matricula = String(req.body.matricula ?? '').trim();
  const senha = String(req.body.senha ?? '');

  if (!matricula || !senha) {
    return res.status(400).json({ sucesso: false, mensagem: 'Informe matrícula e senha.' });
  }

  const { rows } = await pool.query('SELECT * FROM usuarios WHERE LOWER(matricula) = LOWER($1)', [matricula]);
  const usuario = rows[0];
  let ok = false;

  if (usuario && usuario.senha) {
    if (ehHash(usuario.senha)) {
      ok = await bcrypt.compare(senha, usuario.senha);
    } else {
      // senha antiga em texto puro: valida e converte para bcrypt
      ok = igualSeguro(senha, usuario.senha);
      if (ok) {
        await pool.query('UPDATE usuarios SET senha = $1 WHERE id = $2', [await bcrypt.hash(senha, 10), usuario.id]);
      }
    }
  } else {
    await bcrypt.compare(senha, DUMMY_HASH); // mantém o tempo de resposta parecido
  }

  if (!ok) {
    await registrarAuditoria(pool, 'LOGIN_FALHA', `Login inválido para a matrícula ${matricula.slice(0, 30)}`, null, req.ip)
      .catch(() => {});
    return res.status(401).json({ sucesso: false, mensagem: 'Matrícula ou senha incorretas.' });
  }

  if (usuario.ativo === false) {
    return res.status(403).json({ sucesso: false, mensagem: 'Esta conta foi desativada. Procure a coordenação.' });
  }

  if (usuario.trocar_senha) {
    return res.status(403).json({
      sucesso: false,
      trocar_senha: true,
      mensagem: 'Primeiro acesso: é necessário definir uma nova senha. Use a opção "Esqueci minha senha", informe a senha provisória e escolha a sua nova senha.'
    });
  }

  const tipo = String(usuario.tipo || '').trim();
  const perfil = normalizar(tipo);
  const token = jwt.sign(
    { id: usuario.id, nome: usuario.nome, matricula: usuario.matricula, tipo, perfil, polo: usuario.polo || null },
    JWT_SECRET,
    { expiresIn: '8h' }
  );

  res.json({
    sucesso: true,
    token,
    nome: usuario.nome,
    curso: usuario.curso,
    tipo,
    perfil,
    matricula: usuario.matricula
  });
}));

app.post('/api/cadastrar-usuario', autenticar, exigirPerfil(PERFIL.COORD), rota(async (req, res) => {
  const nome = String(req.body.nome ?? '').trim();
  const curso = String(req.body.curso ?? '').trim();
  const tipo = String(req.body.tipo ?? '').trim();
  const email = String(req.body.email ?? '').trim();
  const foto = req.body.foto || null;
  const polo = String(req.body.polo ?? '').trim();

  if (!nome || !curso || !tipo || !email) {
    return res.status(400).json({ sucesso: false, mensagem: 'Preencha nome, e-mail, curso e tipo de perfil.' });
  }
  const prefixo = PREFIXO_MATRICULA[tipo];
  if (!prefixo) {
    return res.status(400).json({ sucesso: false, mensagem: 'Tipo de perfil inválido.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ sucesso: false, mensagem: 'E-mail inválido.' });
  }
  if (foto && tipo !== 'Aluno') {
    return res.status(400).json({ sucesso: false, mensagem: 'A foto é usada apenas para alunos.' });
  }
  if (tipo === 'Recepção do Polo' && !polo) {
    return res.status(400).json({ sucesso: false, mensagem: 'Informe o polo da recepção.' });
  }
  if (polo.length > 100) {
    return res.status(400).json({ sucesso: false, mensagem: 'Nome do polo grande demais.' });
  }

  const senhaProvisoria = gerarSenhaProvisoria();
  const senhaHash = await bcrypt.hash(senhaProvisoria, 10);
  const fotoEnviada = foto ? await enviarFoto(foto) : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const matricula = await proximaMatricula(client, prefixo);

    await client.query(
      `INSERT INTO usuarios (nome, matricula, curso, tipo, senha, email, foto_url, polo, trocar_senha)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)`,
      [nome, matricula, curso, tipo, senhaHash, email, fotoEnviada ? fotoEnviada.url : null, tipo === 'Recepção do Polo' ? polo : null]
    );

    // se o e-mail falhar, nada é gravado (rollback) e o número da matrícula não é consumido
    await enviarEmailBoasVindas({ nome, email, matricula, senhaProvisoria });

    await registrarAuditoria(
      client, 'CADASTRO_USUARIO',
      `Novo usuário cadastrado: ${nome} (${tipo}), matrícula ${matricula}${tipo === 'Recepção do Polo' ? `, polo ${polo}` : ''}`,
      req.usuario.nome, req.ip
    );

    await client.query('COMMIT');
    res.json({
      sucesso: true,
      matricula,
      mensagem: `Usuário cadastrado! Matrícula: ${matricula}. A senha provisória foi enviada para ${email}.`,
      ...(MODO_TESTE ? { senha_provisoria: senhaProvisoria } : {})
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (fotoEnviada) await removerFoto(fotoEnviada.caminho);
    if (err.code === '23505') {
      return res.status(400).json({ sucesso: false, mensagem: 'Este e-mail já está cadastrado (se o usuário foi excluído, reative-o na lista de usuários).' });
    }
    throw err;
  } finally {
    client.release();
  }
}));

// cursos existentes (alimenta o seletor de vagas e a sugestão no cadastro)
app.get('/api/cursos', autenticar, exigirPerfil(PERFIL.COORD), rota(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT curso FROM (
        SELECT TRIM(curso) AS curso FROM usuarios
         WHERE ativo AND LOWER(TRIM(tipo)) = 'aluno'
        UNION
        SELECT TRIM(curso) FROM vagas WHERE curso IS NOT NULL
     ) c
      WHERE curso <> ''
      ORDER BY curso`
  );
  res.json(rows.map((r) => r.curso));
}));

// adiciona ou troca a foto de um aluno já cadastrado
app.post('/api/atualizar-foto', autenticar, exigirPerfil(PERFIL.COORD), rota(async (req, res) => {
  const id = Number.parseInt(req.body.id, 10);
  if (!Number.isInteger(id) || !req.body.foto) {
    return res.status(400).json({ sucesso: false, mensagem: 'Informe o aluno e a foto.' });
  }

  const { rows } = await pool.query(
    'SELECT id, nome, matricula, tipo, foto_url FROM usuarios WHERE id = $1 AND ativo',
    [id]
  );
  const alvo = rows[0];
  if (!alvo) return res.status(404).json({ sucesso: false, mensagem: 'Usuário não encontrado.' });
  if (normalizar(alvo.tipo) !== PERFIL.ALUNO) {
    return res.status(400).json({ sucesso: false, mensagem: 'A foto é usada apenas para alunos.' });
  }

  const nova = await enviarFoto(req.body.foto);
  try {
    await pool.query('UPDATE usuarios SET foto_url = $1 WHERE id = $2', [nova.url, id]);
    await registrarAuditoria(pool, 'ATUALIZACAO_FOTO', `Foto atualizada: ${alvo.nome} (${alvo.matricula})`, req.usuario.nome, req.ip);
  } catch (err) {
    await removerFoto(nova.caminho);
    throw err;
  }

  await removerFoto(caminhoDaFoto(alvo.foto_url));
  res.json({ sucesso: true, mensagem: 'Foto atualizada com sucesso.', foto_url: nova.url });
}));

// dados do próprio usuário logado (cabeçalho das telas e foto)
app.get('/api/perfil', autenticar, rota(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT nome, matricula, curso, tipo, foto_url, polo FROM usuarios WHERE id = $1',
    [req.usuario.id]
  );
  res.json(rows[0] || {});
}));

// define/troca o polo de uma recepção já cadastrada (quem tem polo só vê aquele polo na portaria)
app.post('/api/atualizar-polo', autenticar, exigirPerfil(PERFIL.COORD), rota(async (req, res) => {
  const id = Number.parseInt(req.body.id, 10);
  const polo = String(req.body.polo ?? '').trim();
  if (!Number.isInteger(id) || !polo) {
    return res.status(400).json({ sucesso: false, mensagem: 'Informe o usuário e o polo.' });
  }
  if (polo.length > 100) {
    return res.status(400).json({ sucesso: false, mensagem: 'Nome do polo grande demais.' });
  }

  const { rows } = await pool.query('SELECT id, nome, matricula, tipo, polo FROM usuarios WHERE id = $1 AND ativo', [id]);
  const alvo = rows[0];
  if (!alvo) return res.status(404).json({ sucesso: false, mensagem: 'Usuário não encontrado.' });
  if (normalizar(alvo.tipo) !== PERFIL.RECEPCAO) {
    return res.status(400).json({ sucesso: false, mensagem: 'O polo é usado apenas pela recepção do polo.' });
  }

  await pool.query('UPDATE usuarios SET polo = $1 WHERE id = $2', [polo, id]);
  await registrarAuditoria(
    pool, 'ATUALIZACAO_POLO',
    `Polo de ${alvo.nome} (${alvo.matricula}) alterado de ${alvo.polo || 'todos'} para ${polo}`,
    req.usuario.nome, req.ip
  );
  res.json({ sucesso: true, mensagem: 'Polo atualizado com sucesso.' });
}));

// lista de usuários (nunca devolve a senha)
app.get('/api/usuarios', autenticar, exigirPerfil(PERFIL.COORD), rota(async (req, res) => {
  const busca = String(req.query.busca ?? '').trim();
  const { rows } = await pool.query(
    `SELECT id, nome, matricula, curso, tipo, email, ativo, foto_url, polo
       FROM usuarios
      WHERE ($1::text IS NULL OR nome ILIKE $1 OR matricula ILIKE $1)
      ORDER BY ativo DESC, nome
      LIMIT 200`,
    [busca ? `%${escapeLike(busca)}%` : null]
  );
  res.json(rows);
}));

// exclusão lógica (ativo = false) e reativação; o histórico e os logs são preservados
app.post('/api/alterar-status-usuario', autenticar, exigirPerfil(PERFIL.COORD), rota(async (req, res) => {
  const id = Number.parseInt(req.body.id, 10);
  const ativar = req.body.ativo === true;

  if (!Number.isInteger(id)) {
    return res.status(400).json({ sucesso: false, mensagem: 'Usuário inválido.' });
  }
  if (!ativar && id === req.usuario.id) {
    return res.status(400).json({ sucesso: false, mensagem: 'Você não pode excluir a sua própria conta.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      'SELECT id, nome, matricula, tipo, ativo FROM usuarios WHERE id = $1 FOR UPDATE',
      [id]
    );
    const alvo = rows[0];
    if (!alvo) throw new ErroHttp(404, 'Usuário não encontrado.');
    if (alvo.ativo === ativar) {
      throw new ErroHttp(409, ativar ? 'O usuário já está ativo.' : 'O usuário já está excluído.');
    }

    let cancelados = 0;

    if (!ativar) {
      if (normalizar(alvo.tipo) === PERFIL.COORD) {
        const outros = await client.query(
          `SELECT COUNT(*)::int AS n FROM usuarios
            WHERE ativo AND LOWER(TRIM(tipo)) = 'coordenador' AND id <> $1`,
          [id]
        );
        if (outros.rows[0].n === 0) {
          throw new ErroHttp(400, 'Não é possível excluir o último coordenador ativo.');
        }
      }

      await client.query(
        'UPDATE usuarios SET ativo = false, codigo_recuperacao = NULL, codigo_expiracao = NULL WHERE id = $1',
        [id]
      );
      // libera as vagas que o usuário ocupava
      const r = await client.query(
        `UPDATE agendamentos SET status = 'INATIVO' WHERE usuario_id = $1 AND status = 'ATIVO'`,
        [id]
      );
      cancelados = r.rowCount;
    } else {
      await client.query('UPDATE usuarios SET ativo = true WHERE id = $1', [id]);
    }

    await registrarAuditoria(
      client,
      ativar ? 'REATIVACAO_USUARIO' : 'SOFT_DELETE',
      ativar
        ? `Usuário reativado: ${alvo.nome} (${alvo.matricula}, ${alvo.tipo})`
        : `Usuário excluído: ${alvo.nome} (${alvo.matricula}, ${alvo.tipo}); ${cancelados} agendamento(s) ativo(s) cancelado(s)`,
      req.usuario.nome, req.ip
    );

    await client.query('COMMIT');

    res.json({
      sucesso: true,
      mensagem: ativar
        ? 'Usuário reativado com sucesso.'
        : `Usuário excluído.${cancelados ? ` ${cancelados} agendamento(s) ativo(s) foram cancelados.` : ''}`
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

// ==========================================
// RECUPERAÇÃO DE SENHA
// ==========================================
app.post('/api/solicitar-codigo', limitadorSenha, rota(async (req, res) => {
  const matricula = String(req.body.matricula ?? '').trim();
  if (!matricula) {
    return res.status(400).json({ sucesso: false, mensagem: 'Por favor, informe a matrícula.' });
  }

  // resposta igual exista ou não a matrícula (evita descobrir matrículas válidas)
  const MENSAGEM = 'Se a matrícula estiver cadastrada, enviaremos um código para o e-mail do cadastro.';

  const { rows } = await pool.query('SELECT id, nome, email FROM usuarios WHERE LOWER(matricula) = LOWER($1) AND ativo', [matricula]);
  const usuario = rows[0];
  let codigoTeste = null;

  if (usuario && usuario.email) {
    const codigo = String(crypto.randomInt(100000, 1000000));
    codigoTeste = codigo;

    await pool.query(
      `UPDATE usuarios
          SET codigo_recuperacao = $1,
              codigo_expiracao = NOW() + INTERVAL '15 minutes',
              codigo_tentativas = 0
        WHERE id = $2`,
      [hashCodigo(codigo), usuario.id]
    );

    try {
      await transporter.sendMail({
        from: `"Portal UNIFAA" <${process.env.EMAIL_USER}>`,
        to: usuario.email,
        subject: 'Código de Recuperação de Senha - Portal UNIFAA',
        text: `Olá ${usuario.nome},\n\nSeu código de verificação para redefinir a senha é: ${codigo}\n\nEste código é válido por 15 minutos. Se você não solicitou, ignore este e-mail.`
      });
    } catch (err) {
      console.error('Falha ao enviar e-mail de recuperação:', err.message);
    }

    await registrarAuditoria(pool, 'SOLICITACAO_CODIGO_SENHA', `Código de recuperação solicitado para a matrícula ${matricula}`, matricula, req.ip);
  }

  res.json({ sucesso: true, mensagem: MENSAGEM, ...(MODO_TESTE && codigoTeste ? { codigo_teste: codigoTeste } : {}) });
}));

app.post('/api/recuperar-senha', limitadorSenha, rota(async (req, res) => {
  const matricula = String(req.body.matricula ?? '').trim();
  const codigo = String(req.body.codigo ?? '').trim(); // código do e-mail OU senha provisória (primeiro acesso)
  const novaSenha = String(req.body.novaSenha ?? '');

  if (!matricula || !codigo || !novaSenha) {
    return res.status(400).json({ sucesso: false, mensagem: 'Preencha todos os campos obrigatórios.' });
  }
  if (novaSenha.length < 8) {
    return res.status(400).json({ sucesso: false, mensagem: 'A nova senha deve ter pelo menos 8 caracteres.' });
  }

  const INVALIDO = { sucesso: false, mensagem: 'Código ou senha provisória inválidos ou expirados.' };

  const { rows } = await pool.query(
    `SELECT id, senha, trocar_senha, codigo_recuperacao, codigo_tentativas,
            (codigo_expiracao > NOW()) AS valido
       FROM usuarios WHERE LOWER(matricula) = LOWER($1) AND ativo`,
    [matricula]
  );
  const usuario = rows[0];

  if (!usuario) return res.status(400).json(INVALIDO);
  if (usuario.codigo_tentativas >= MAX_TENTATIVAS_CODIGO) {
    return res.status(400).json({ sucesso: false, mensagem: 'Muitas tentativas incorretas. Clique em "Esqueci minha senha" e solicite um novo código.' });
  }

  let confere = false;

  // primeiro acesso: a senha provisória enviada por e-mail vale como prova
  if (usuario.trocar_senha && ehHash(usuario.senha)) {
    confere = await bcrypt.compare(codigo, usuario.senha);
  }

  // recuperação comum: código de 6 dígitos enviado por e-mail
  if (!confere && usuario.codigo_recuperacao && usuario.valido) {
    const informado = hashCodigo(codigo);
    const esperado = usuario.codigo_recuperacao;
    confere = informado.length === esperado.length &&
      crypto.timingSafeEqual(Buffer.from(informado), Buffer.from(esperado));
  }

  if (!confere) {
    await pool.query('UPDATE usuarios SET codigo_tentativas = codigo_tentativas + 1 WHERE id = $1', [usuario.id]);
    return res.status(400).json(INVALIDO);
  }

  if (novaSenha === codigo) {
    return res.status(400).json({ sucesso: false, mensagem: 'A nova senha deve ser diferente da senha provisória/código informado.' });
  }

  await pool.query(
    `UPDATE usuarios
        SET senha = $1, trocar_senha = false,
            codigo_recuperacao = NULL, codigo_expiracao = NULL, codigo_tentativas = 0
      WHERE id = $2`,
    [await bcrypt.hash(novaSenha, 10), usuario.id]
  );

  await registrarAuditoria(pool, 'REDEFINICAO_SENHA', `Senha definida/redefinida para a matrícula ${matricula}`, matricula, req.ip);
  res.json({ sucesso: true, mensagem: 'Senha definida com sucesso! Você já pode fazer login.' });
}));

// ==========================================
// VAGAS
// ==========================================
app.post('/api/cadastrar-vaga', autenticar, exigirPerfil(PERFIL.COORD), rota(async (req, res) => {
  const polo = String(req.body.polo ?? '').trim();
  const curso = String(req.body.curso ?? '').trim();
  const disciplina = String(req.body.disciplina ?? '').trim();
  const data = String(req.body.data ?? '').trim();
  const inicio = String(req.body.horario_inicio ?? '').trim();
  const fim = String(req.body.horario_fim ?? '').trim();
  const limite = Number.parseInt(req.body.limite_vagas, 10);
  const agInicio = String(req.body.agendamento_inicio ?? '').trim();
  const agFim = String(req.body.agendamento_fim ?? '').trim();

  if (!polo || !curso || !disciplina || !data || !inicio || !fim || !Number.isInteger(limite)) {
    return res.status(400).json({ sucesso: false, mensagem: 'Preencha todos os campos da vaga.' });
  }
  if (!dataValida(data) || !horaValida(inicio) || !horaValida(fim)) {
    return res.status(400).json({ sucesso: false, mensagem: 'Data ou horário em formato inválido.' });
  }
  if (fim <= inicio) {
    return res.status(400).json({ sucesso: false, mensagem: 'O horário de fim deve ser depois do horário de início.' });
  }
  const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: FUSO });
  if (data < hoje) {
    return res.status(400).json({ sucesso: false, mensagem: 'A data da prova não pode estar no passado.' });
  }
  if (limite < 1 || limite > 5000) {
    return res.status(400).json({ sucesso: false, mensagem: 'O limite de vagas deve estar entre 1 e 5000.' });
  }

  // período em que o aluno pode agendar (os dois vazios = sempre aberto)
  if (agInicio || agFim) {
    if (!agInicio || !agFim) {
      return res.status(400).json({ sucesso: false, mensagem: 'Informe o início e o fim do período de agendamento (ou deixe os dois vazios).' });
    }
    if (!dataValida(agInicio) || !dataValida(agFim)) {
      return res.status(400).json({ sucesso: false, mensagem: 'Datas do período de agendamento inválidas.' });
    }
    if (agFim < agInicio) {
      return res.status(400).json({ sucesso: false, mensagem: 'O fim do período de agendamento deve ser igual ou depois do início.' });
    }
    if (agFim > data) {
      return res.status(400).json({ sucesso: false, mensagem: 'O período de agendamento deve terminar até a data da prova.' });
    }
    if (agFim < hoje) {
      return res.status(400).json({ sucesso: false, mensagem: 'O fim do período de agendamento não pode estar no passado.' });
    }
  }

  // a disciplina precisa existir no cadastro de disciplinas e estar ativa
  const disc = await pool.query('SELECT nome, ativa FROM disciplinas WHERE LOWER(TRIM(nome)) = LOWER(TRIM($1))', [disciplina]);
  if (!disc.rows[0]) {
    return res.status(400).json({ sucesso: false, mensagem: 'Disciplina não cadastrada. Cadastre-a na aba Disciplinas.' });
  }
  if (!disc.rows[0].ativa) {
    return res.status(400).json({ sucesso: false, mensagem: 'Esta disciplina está inativa. Reative-a na aba Disciplinas para criar novas vagas.' });
  }
  const nomeDisciplina = disc.rows[0].nome;

  let ins;
  try {
    ins = await pool.query(
      `INSERT INTO vagas (polo, curso, disciplina, data_prova, horario, horario_fim, limite_vagas, agendamento_inicio, agendamento_fim, criado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [polo, curso, nomeDisciplina, data, inicio, fim, limite, agInicio || null, agFim || null, req.usuario.nome]
    );
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ sucesso: false, mensagem: 'Já existe uma agenda para esta disciplina, neste polo, na mesma data e horário.' });
    }
    throw err;
  }

  await registrarAuditoria(
    pool, 'ADICAO_VAGAS',
    `${limite} vagas abertas para ${nomeDisciplina} (${curso}) no ${polo} em ${data}, ${inicio} às ${fim}${agInicio ? `, agendamento de ${agInicio} a ${agFim}` : ''}`,
    req.usuario.nome, req.ip
  );

  res.json({ sucesso: true, mensagem: 'Vagas cadastradas e log gerado com sucesso!', id: ins.rows[0].id });
}));

// ---------- cadastro de disciplinas (gestor): adicionar e inativar, nada é apagado ----------
app.get('/api/disciplinas', autenticar, exigirPerfil(PERFIL.COORD), rota(async (req, res) => {
  const somenteAtivas = req.query.ativas === '1';
  const { rows } = await pool.query(
    `SELECT id, nome, ativa, criado_em, criado_por
       FROM disciplinas
      WHERE ($1::boolean = false OR ativa)
      ORDER BY ativa DESC, LOWER(nome)`,
    [somenteAtivas]
  );
  res.json(rows);
}));

app.post('/api/disciplinas', autenticar, exigirPerfil(PERFIL.COORD), rota(async (req, res) => {
  const nome = String(req.body.nome ?? '').trim().replace(/\s+/g, ' ');
  if (!nome) {
    return res.status(400).json({ sucesso: false, mensagem: 'Informe o nome da disciplina.' });
  }
  if (nome.length > 100) {
    return res.status(400).json({ sucesso: false, mensagem: 'Nome da disciplina grande demais (máximo 100 caracteres).' });
  }

  try {
    const { rows } = await pool.query('INSERT INTO disciplinas (nome, criado_por) VALUES ($1, $2) RETURNING id', [nome, req.usuario.nome]);
    await registrarAuditoria(pool, 'CADASTRO_DISCIPLINA', `Disciplina cadastrada: ${nome}`, req.usuario.nome, req.ip);
    res.json({ sucesso: true, id: rows[0].id, mensagem: 'Disciplina cadastrada com sucesso!' });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ sucesso: false, mensagem: 'Esta disciplina já está cadastrada (ela pode estar inativa).' });
    }
    throw err;
  }
}));

app.post('/api/alterar-status-disciplina', autenticar, exigirPerfil(PERFIL.COORD), rota(async (req, res) => {
  const id = Number.parseInt(req.body.id, 10);
  const ativar = req.body.ativa === true;
  if (!Number.isInteger(id)) {
    return res.status(400).json({ sucesso: false, mensagem: 'Disciplina inválida.' });
  }

  const { rows } = await pool.query('SELECT id, nome, ativa FROM disciplinas WHERE id = $1', [id]);
  const disc = rows[0];
  if (!disc) return res.status(404).json({ sucesso: false, mensagem: 'Disciplina não encontrada.' });
  if (disc.ativa === ativar) {
    return res.status(409).json({ sucesso: false, mensagem: ativar ? 'A disciplina já está ativa.' : 'A disciplina já está inativa.' });
  }

  await pool.query('UPDATE disciplinas SET ativa = $1 WHERE id = $2', [ativar, id]);

  const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: FUSO });
  const futuras = await pool.query(
    'SELECT COUNT(*)::int AS n FROM vagas WHERE LOWER(TRIM(disciplina)) = LOWER(TRIM($1)) AND data_prova >= $2',
    [disc.nome, hoje]
  );
  const n = futuras.rows[0].n;

  await registrarAuditoria(
    pool, ativar ? 'REATIVACAO_DISCIPLINA' : 'INATIVACAO_DISCIPLINA',
    `Disciplina ${ativar ? 'reativada' : 'inativada'}: ${disc.nome}`,
    req.usuario.nome, req.ip
  );

  res.json({
    sucesso: true,
    vagas_futuras: n,
    mensagem: ativar
      ? 'Disciplina reativada. Ela volta a aparecer ao cadastrar novas vagas.'
      : `Disciplina inativada. Ela deixa de aparecer ao cadastrar novas vagas${n ? `; as ${n} vaga(s) futura(s) já cadastradas continuam valendo` : ''}.`
  });
}));

// todas as vagas cadastradas (inclusive as passadas), com ocupação e data/hora do cadastro
app.get('/api/vagas-gestao', autenticar, exigirPerfil(PERFIL.COORD), rota(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT v.id, v.polo, v.curso, v.disciplina, v.data_prova, v.horario, v.horario_fim, v.limite_vagas,
            v.agendamento_inicio, v.agendamento_fim, v.criado_em, v.criado_por,
            COALESCE(c.qtd, 0)::int AS ocupadas,
            ((v.data_prova + v.horario::time) AT TIME ZONE $1) > NOW() AS futura
       FROM vagas v
       LEFT JOIN (
         SELECT vaga_id, COUNT(*)::int AS qtd FROM agendamentos WHERE status = 'ATIVO' GROUP BY vaga_id
       ) c ON c.vaga_id = v.id
      ORDER BY v.criado_em DESC NULLS LAST, v.id DESC
      LIMIT 500`,
    [FUSO]
  );
  res.json(rows);
}));

// vagas futuras, com vagas restantes. O aluno só vê as vagas do próprio curso
// (vagas antigas sem curso continuam visíveis para todos)
app.get('/api/vagas', autenticar, exigirPerfil(PERFIL.ALUNO, PERFIL.COORD), rota(async (req, res) => {
  const cursoDoAluno = req.usuario.perfil === PERFIL.ALUNO ? (req.usuario.curso || '') : null;

  const { rows } = await pool.query(
    `SELECT v.id, v.polo, v.curso, v.disciplina, v.data_prova, v.horario, v.horario_fim, v.limite_vagas,
            v.agendamento_inicio, v.agendamento_fim,
            ((v.agendamento_inicio IS NULL OR v.agendamento_inicio <= (NOW() AT TIME ZONE $1)::date)
             AND (v.agendamento_fim IS NULL OR v.agendamento_fim >= (NOW() AT TIME ZONE $1)::date)) AS agendamento_aberto,
            v.limite_vagas - COALESCE(c.qtd, 0) AS vagas_restantes
       FROM vagas v
       LEFT JOIN (
         SELECT vaga_id, COUNT(*)::int AS qtd
           FROM agendamentos WHERE status = 'ATIVO' GROUP BY vaga_id
       ) c ON c.vaga_id = v.id
      WHERE ((v.data_prova + v.horario::time) AT TIME ZONE $1) > NOW()
        AND ($2::text IS NULL OR v.curso IS NULL OR LOWER(TRIM(v.curso)) = LOWER(TRIM($2)))
        AND ($2::text IS NULL OR v.agendamento_fim IS NULL OR v.agendamento_fim >= (NOW() AT TIME ZONE $1)::date)
      ORDER BY v.data_prova, v.horario`,
    [FUSO, cursoDoAluno]
  );
  res.json(rows);
}));

// ==========================================
// AGENDAMENTOS (aluno)
// ==========================================
app.post('/api/agendar', autenticar, exigirPerfil(PERFIL.ALUNO), rota(async (req, res) => {
  const vagaId = Number.parseInt(req.body.vaga_id, 10);
  if (!Number.isInteger(vagaId)) {
    return res.status(400).json({ sucesso: false, mensagem: 'Vaga inválida.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // trava a linha da vaga: dois alunos não passam do limite ao mesmo tempo
    const vagaQ = await client.query(
      `SELECT v.*, ((v.data_prova + v.horario::time) AT TIME ZONE $2) > NOW() AS futura,
              (v.agendamento_inicio > (NOW() AT TIME ZONE $2)::date) AS nao_abriu,
              (v.agendamento_fim < (NOW() AT TIME ZONE $2)::date) AS encerrou
         FROM vagas v WHERE v.id = $1 FOR UPDATE`,
      [vagaId, FUSO]
    );
    const vaga = vagaQ.rows[0];
    validarVagaParaAgendar(vaga, req.usuario);

    const dup = await client.query(
      `SELECT 1 FROM agendamentos a
         JOIN vagas v2 ON v2.id = a.vaga_id
        WHERE a.usuario_id = $1 AND a.status = 'ATIVO' AND v2.disciplina = $2`,
      [req.usuario.id, vaga.disciplina]
    );
    if (dup.rows.length > 0) throw new ErroHttp(409, 'Você já tem um agendamento ativo para esta avaliação.');

    const ocupadas = await client.query(
      `SELECT COUNT(*)::int AS qtd FROM agendamentos WHERE vaga_id = $1 AND status = 'ATIVO'`,
      [vagaId]
    );
    if (ocupadas.rows[0].qtd >= vaga.limite_vagas) throw new ErroHttp(409, 'Não há mais vagas neste horário.');

    const ins = await client.query(
      `INSERT INTO agendamentos (vaga_id, usuario_id, aluno_nome, data_agendada, horario_agendado, status)
       VALUES ($1, $2, $3, $4, $5, 'ATIVO')
       RETURNING id, vaga_id, data_agendada, horario_agendado`,
      [vagaId, req.usuario.id, req.usuario.nome, vaga.data_prova, vaga.horario]
    );

    await registrarAuditoria(
      client, 'AGENDAMENTO_REALIZADO',
      `Aluno ${req.usuario.nome} agendou ${vaga.disciplina} (vaga ${vagaId}, ${vaga.data_prova} ${String(vaga.horario).slice(0, 5)})`,
      req.usuario.nome, req.ip
    );

    await client.query('COMMIT');
    res.json({ sucesso: true, mensagem: 'Agendamento realizado com sucesso!', agendamento: ins.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') {
      return res.status(409).json({ sucesso: false, mensagem: 'Você já está agendado nesta vaga.' });
    }
    throw err;
  } finally {
    client.release();
  }
}));

// reagendar = trocar o horário da MESMA avaliação. O agendamento antigo vira INATIVO (histórico
// preservado) e um novo é criado, tudo na mesma transação. Vale a regra das 24h do cancelamento.
app.post('/api/reagendar', autenticar, exigirPerfil(PERFIL.ALUNO), rota(async (req, res) => {
  const agendamentoId = Number.parseInt(req.body.agendamento_id, 10);
  const novaVagaId = Number.parseInt(req.body.nova_vaga_id, 10);
  if (!Number.isInteger(agendamentoId) || !Number.isInteger(novaVagaId)) {
    return res.status(400).json({ sucesso: false, mensagem: 'Informe o agendamento e o novo horário.' });
  }

  const atual = await pool.query(
    `SELECT a.id, a.vaga_id, v.disciplina, v.data_prova, v.horario,
            (((a.data_agendada::date + a.horario_agendado::time) AT TIME ZONE $3) - NOW()) >= INTERVAL '24 hours' AS pode_alterar
       FROM agendamentos a
       JOIN vagas v ON v.id = a.vaga_id
      WHERE a.id = $1 AND a.usuario_id = $2 AND a.status = 'ATIVO'`,
    [agendamentoId, req.usuario.id, FUSO]
  );
  const ag = atual.rows[0];
  if (!ag) return res.status(404).json({ sucesso: false, mensagem: 'Agendamento ativo não encontrado.' });

  if (!ag.pode_alterar) {
    await registrarAuditoria(
      pool, 'REAGENDAMENTO_BLOQUEADO',
      `Tentativa de reagendamento negada (< 24h) de ${ag.disciplina} pelo aluno ${req.usuario.nome}`,
      req.usuario.nome, req.ip
    );
    return res.status(400).json({
      sucesso: false,
      mensagem: 'Ação Bloqueada: o reagendamento só é permitido com mais de 24 horas de antecedência da prova.'
    });
  }
  if (ag.vaga_id === novaVagaId) {
    return res.status(400).json({ sucesso: false, mensagem: 'Escolha um horário diferente do atual.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // trava o agendamento atual: dois reagendamentos/cancelamentos simultâneos não passam juntos
    const trava = await client.query(
      `SELECT id FROM agendamentos WHERE id = $1 AND usuario_id = $2 AND status = 'ATIVO' FOR UPDATE`,
      [agendamentoId, req.usuario.id]
    );
    if (!trava.rows[0]) throw new ErroHttp(404, 'Agendamento ativo não encontrado.');

    const vagaQ = await client.query(
      `SELECT v.*, ((v.data_prova + v.horario::time) AT TIME ZONE $2) > NOW() AS futura,
              (v.agendamento_inicio > (NOW() AT TIME ZONE $2)::date) AS nao_abriu,
              (v.agendamento_fim < (NOW() AT TIME ZONE $2)::date) AS encerrou
         FROM vagas v WHERE v.id = $1 FOR UPDATE`,
      [novaVagaId, FUSO]
    );
    const vaga = vagaQ.rows[0];
    validarVagaParaAgendar(vaga, req.usuario);

    if (normalizar(vaga.disciplina) !== normalizar(ag.disciplina)) {
      throw new ErroHttp(400, 'O novo horário precisa ser da mesma avaliação.');
    }

    const ocupadas = await client.query(
      `SELECT COUNT(*)::int AS qtd FROM agendamentos WHERE vaga_id = $1 AND status = 'ATIVO'`,
      [novaVagaId]
    );
    if (ocupadas.rows[0].qtd >= vaga.limite_vagas) throw new ErroHttp(409, 'Não há mais vagas neste horário.');

    await client.query(`UPDATE agendamentos SET status = 'INATIVO' WHERE id = $1`, [agendamentoId]);
    const ins = await client.query(
      `INSERT INTO agendamentos (vaga_id, usuario_id, aluno_nome, data_agendada, horario_agendado, status)
       VALUES ($1, $2, $3, $4, $5, 'ATIVO')
       RETURNING id, vaga_id, data_agendada, horario_agendado`,
      [novaVagaId, req.usuario.id, req.usuario.nome, vaga.data_prova, vaga.horario]
    );

    await registrarAuditoria(
      client, 'REAGENDAMENTO_REALIZADO',
      `Aluno ${req.usuario.nome} reagendou ${ag.disciplina}: ${ag.data_prova} ${String(ag.horario).slice(0, 5)} -> ${vaga.data_prova} ${String(vaga.horario).slice(0, 5)}`,
      req.usuario.nome, req.ip
    );

    await client.query('COMMIT');
    res.json({ sucesso: true, mensagem: 'Reagendamento realizado com sucesso!', agendamento: ins.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') {
      return res.status(409).json({ sucesso: false, mensagem: 'Você já está agendado neste horário.' });
    }
    throw err;
  } finally {
    client.release();
  }
}));

app.get('/api/meus-agendamentos', autenticar, exigirPerfil(PERFIL.ALUNO), rota(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.id, a.vaga_id, a.data_agendada, a.horario_agendado, v.horario_fim, v.disciplina, v.polo
       FROM agendamentos a
       JOIN vagas v ON v.id = a.vaga_id
      WHERE a.usuario_id = $1 AND a.status = 'ATIVO'
      ORDER BY a.data_agendada, a.horario_agendado`,
    [req.usuario.id]
  );
  res.json(rows);
}));

app.post('/api/cancelar-agendamento', autenticar, exigirPerfil(PERFIL.ALUNO), rota(async (req, res) => {
  const agendamentoId = Number.parseInt(req.body.agendamento_id, 10);
  if (!Number.isInteger(agendamentoId)) {
    return res.status(400).json({ sucesso: false, mensagem: 'Agendamento inválido.' });
  }

  // a regra das 24h é calculada no banco, no fuso de São Paulo
  const { rows } = await pool.query(
    `SELECT a.id, v.disciplina,
            (((a.data_agendada::date + a.horario_agendado::time) AT TIME ZONE $3) - NOW()) >= INTERVAL '24 hours' AS pode_cancelar
       FROM agendamentos a
       JOIN vagas v ON v.id = a.vaga_id
      WHERE a.id = $1 AND a.usuario_id = $2 AND a.status = 'ATIVO'`,
    [agendamentoId, req.usuario.id, FUSO]
  );
  const ag = rows[0];
  if (!ag) return res.status(404).json({ sucesso: false, mensagem: 'Agendamento ativo não encontrado.' });

  if (!ag.pode_cancelar) {
    await registrarAuditoria(
      pool, 'CANCELAMENTO_BLOQUEADO',
      `Tentativa de cancelamento negada (< 24h) de ${ag.disciplina} pelo aluno ${req.usuario.nome}`,
      req.usuario.nome, req.ip
    );
    return res.status(400).json({
      sucesso: false,
      mensagem: 'Ação Bloqueada: o cancelamento só é permitido com mais de 24 horas de antecedência da prova.'
    });
  }

  await pool.query(`UPDATE agendamentos SET status = 'INATIVO' WHERE id = $1`, [agendamentoId]);
  await registrarAuditoria(
    pool, 'CANCELAMENTO_REALIZADO',
    `Aluno ${req.usuario.nome} cancelou o agendamento de ${ag.disciplina}`,
    req.usuario.nome, req.ip
  );

  res.json({ sucesso: true, mensagem: 'Agendamento cancelado com sucesso!' });
}));

// ==========================================
// NOTAS
// ==========================================
// resultados do próprio aluno (identificado pela matrícula do token, nunca por nome)
app.get('/api/resultados', autenticar, exigirPerfil(PERFIL.ALUNO), rota(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM notas_alunos WHERE matricula = $1 ORDER BY id DESC',
    [req.usuario.matricula]
  );
  res.json(rows);
}));

app.get('/api/notas', autenticar, exigirPerfil(PERFIL.COORD), rota(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM notas_alunos ORDER BY id DESC LIMIT 500');
  res.json(rows);
}));

app.post('/api/atualizar-nota', autenticar, exigirPerfil(PERFIL.COORD), rota(async (req, res) => {
  const id = Number.parseInt(req.body.id, 10);
  const nota = Number(String(req.body.nota ?? '').replace(',', '.'));

  if (!Number.isInteger(id)) {
    return res.status(400).json({ sucesso: false, mensagem: 'Registro inválido.' });
  }
  if (String(req.body.nota ?? '').trim() === '' || !Number.isFinite(nota) || nota < 0 || nota > 10) {
    return res.status(400).json({ sucesso: false, mensagem: 'Informe uma nota entre 0 e 10.' });
  }

  const { rows } = await pool.query(
    'UPDATE notas_alunos SET nota = $1 WHERE id = $2 RETURNING nome_aluno, matricula, avaliacao',
    [nota, id]
  );
  if (rows.length === 0) {
    return res.status(404).json({ sucesso: false, mensagem: 'Registro de nota não encontrado.' });
  }

  const r = rows[0];
  await registrarAuditoria(
    pool, 'LANÇAMENTO_NOTA',
    `Nota ${nota} lançada para ${r.nome_aluno} (${r.matricula}) em ${r.avaliacao}`,
    req.usuario.nome, req.ip
  );

  res.json({ sucesso: true, mensagem: 'Nota salva com sucesso!' });
}));

// ==========================================
// PORTARIA (recepção)
// ==========================================
app.get('/api/portaria/consultar', autenticar, exigirPerfil(PERFIL.RECEPCAO), rota(async (req, res) => {
  const busca = String(req.query.busca ?? '').trim();
  if (busca.length < 3) {
    return res.status(400).json({ encontrado: false, mensagem: 'Digite ao menos 3 caracteres do nome ou a matrícula.' });
  }

  const { rows } = await pool.query(
    `SELECT u.id AS usuario_id, u.nome AS aluno_nome, u.matricula, u.curso, u.foto_url,
            ag.id AS ticket_id, ag.data_agendada, ag.horario_agendado, ag.entrada_confirmada_em,
            ag.disciplina, ag.polo, ag.horario_fim
       FROM usuarios u
       LEFT JOIN LATERAL (
         SELECT a.id, a.data_agendada, a.horario_agendado, a.entrada_confirmada_em, v.disciplina, v.polo, v.horario_fim
           FROM agendamentos a
           JOIN vagas v ON v.id = a.vaga_id
          WHERE a.usuario_id = u.id
            AND a.status = 'ATIVO'
            AND a.data_agendada::date >= (NOW() AT TIME ZONE $4)::date
            AND ($2::text IS NULL OR v.polo = $2)
          ORDER BY a.data_agendada, a.horario_agendado
          LIMIT 1
       ) ag ON TRUE
      WHERE LOWER(TRIM(u.tipo)) = 'aluno' AND u.ativo
        AND (LOWER(u.matricula) = LOWER($1) OR u.nome ILIKE $3)
      ORDER BY (LOWER(u.matricula) = LOWER($1)) DESC, u.nome
      LIMIT 10`,
    [busca, req.usuario.polo, `%${escapeLike(busca)}%`, FUSO]
  );

  if (rows.length === 0) {
    return res.json({ encontrado: false, mensagem: 'Aluno não encontrado no sistema.' });
  }
  res.json({ encontrado: true, resultados: rows });
}));

app.get('/api/portaria/por-data', autenticar, exigirPerfil(PERFIL.RECEPCAO), rota(async (req, res) => {
  let data = String(req.query.data ?? '').trim();
  const busca = String(req.query.busca ?? '').trim();
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(data)) data = data.split('/').reverse().join('-');
  if (!dataValida(data)) {
    return res.status(400).json({ sucesso: false, mensagem: 'Data inválida.' });
  }

  // mesmo formato de linha da consulta por aluno, para a tela abrir a confirmação ao clicar no nome
  const { rows } = await pool.query(
    `SELECT a.id AS ticket_id, u.id AS usuario_id, COALESCE(u.nome, a.aluno_nome) AS aluno_nome,
            u.matricula, u.curso, u.foto_url,
            v.disciplina, v.polo, a.data_agendada, a.horario_agendado, v.horario_fim,
            a.entrada_confirmada_em,
            CASE WHEN a.entrada_confirmada_em IS NOT NULL THEN 'Presente' ELSE 'Aguardando' END AS status
       FROM agendamentos a
       JOIN vagas v ON v.id = a.vaga_id
       LEFT JOIN usuarios u ON u.id = a.usuario_id
      WHERE a.data_agendada::date = $1
        AND a.status = 'ATIVO'
        AND ($2::text IS NULL OR v.polo = $2)
        AND ($3::text IS NULL OR u.nome ILIKE $3 OR u.matricula ILIKE $3)
      ORDER BY a.horario_agendado, u.nome`,
    [data, req.usuario.polo, busca ? `%${escapeLike(busca)}%` : null]
  );

  res.json({
    sucesso: true,
    total: rows.length,
    presentes: rows.filter((r) => r.status === 'Presente').length,
    alunos: rows
  });
}));

app.post('/api/portaria/confirmar-entrada', autenticar, exigirPerfil(PERFIL.RECEPCAO), rota(async (req, res) => {
  const ticketId = Number.parseInt(req.body.ticket_id, 10);
  if (!Number.isInteger(ticketId)) {
    return res.status(400).json({ sucesso: false, mensagem: 'Ticket inválido.' });
  }

  const upd = await pool.query(
    `UPDATE agendamentos a
        SET entrada_confirmada_em = NOW(), entrada_confirmada_por = $2
       FROM vagas v
      WHERE a.id = $1
        AND v.id = a.vaga_id
        AND a.status = 'ATIVO'
        AND a.entrada_confirmada_em IS NULL
        AND ($3::text IS NULL OR v.polo = $3)
      RETURNING a.aluno_nome`,
    [ticketId, req.usuario.nome, req.usuario.polo]
  );

  if (upd.rows.length === 0) {
    const ja = await pool.query(
      'SELECT entrada_confirmada_em FROM agendamentos WHERE id = $1 AND entrada_confirmada_em IS NOT NULL',
      [ticketId]
    );
    if (ja.rows.length > 0) {
      return res.status(409).json({ sucesso: false, mensagem: 'A entrada deste aluno já foi confirmada.' });
    }
    return res.status(404).json({ sucesso: false, mensagem: 'Agendamento ativo não encontrado para este polo.' });
  }

  await registrarAuditoria(
    pool, 'CONFIRMACAO_ENTRADA',
    `Portaria confirmou entrada do aluno ${upd.rows[0].aluno_nome} (Ticket #${ticketId})`,
    req.usuario.nome, req.ip
  );

  res.json({ sucesso: true, mensagem: 'Entrada confirmada com sucesso!' });
}));

// ==========================================
// AUDITORIA
// ==========================================
app.get('/api/auditoria', autenticar, exigirPerfil(PERFIL.COORD, PERFIL.AUDIT), rota(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM auditoria ORDER BY data_hora DESC LIMIT 50');
  res.json(rows);
}));

app.get('/api/admin/auditoria-completa', autenticar, exigirPerfil(PERFIL.AUDIT), rota(async (req, res) => {
  const [logs, total, inativos, violacoes] = await Promise.all([
    pool.query('SELECT * FROM auditoria ORDER BY data_hora DESC LIMIT 100'),
    pool.query('SELECT COUNT(*)::int AS n FROM auditoria'),
    pool.query(`SELECT COUNT(*)::int AS n FROM agendamentos WHERE status = 'INATIVO'`),
    pool.query(
      `SELECT COUNT(*)::int AS n FROM auditoria
        WHERE (acao ILIKE '%BLOQUEADO%' OR acao ILIKE '%REJECTED%')
          AND data_hora >= NOW() - INTERVAL '24 hours'`
    )
  ]);

  res.json({
    sucesso: true,
    estatisticas: {
      totalTransacoes: total.rows[0].n,
      registrosInativos: inativos.rows[0].n,
      violacoes24h: violacoes.rows[0].n
    },
    logs: logs.rows
  });
}));

// ==========================================
// ERROS
// ==========================================
app.use('/api', (req, res) => {
  res.status(404).json({ sucesso: false, mensagem: 'Rota não encontrada.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof ErroHttp) {
    return res.status(err.status).json({ sucesso: false, mensagem: err.message });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ sucesso: false, mensagem: 'Requisição grande demais.' });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ sucesso: false, mensagem: 'JSON inválido.' });
  }
  if (err.message === 'Origem não permitida pelo CORS.') {
    return res.status(403).json({ sucesso: false, mensagem: err.message });
  }
  console.error(`Erro em ${req.method} ${req.path}:`, err);
  res.status(500).json({ sucesso: false, mensagem: 'Erro interno no servidor.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
