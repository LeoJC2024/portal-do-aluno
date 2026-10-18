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
const VALIDADE_CODIGO_MIN = 15;        // validade do código de recuperação
const INTERVALO_MIN_CODIGO_SEG = 60;   // intervalo mínimo entre dois pedidos de código da mesma matrícula
const MAX_BYTES_SENHA = 72;            // o bcrypt só usa os primeiros 72 bytes da senha

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
// sem corpo JSON (ou sem Content-Type) o Express 5 deixa req.body undefined: as rotas tratam como corpo vazio e respondem 400
app.use((req, res, next) => {
  if (req.body === undefined) req.body = {};
  next();
});

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
  ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
  application_name: 'portal-backend' // identifica as conexões do servidor no banco
});
// conexão ociosa encerrada pelo banco (reinício, timeout do Supabase) não pode derrubar o servidor;
// o pool descarta a conexão e abre outra na próxima consulta
pool.on('error', (err) => {
  console.error('Conexão ociosa com o banco foi encerrada:', err.message);
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
// apara e junta espaços repetidos ("  cy   curso a " -> "cy curso a")
const normalizarEspacos = (t) => String(t ?? '').trim().replace(/\s+/g, ' ');
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

// inteiro >= 0 escrito só com dígitos (número ou texto) e que cabe no INTEGER do Postgres; senão null.
// Recusa "12abc", "5.9", "1e2", "-1" e valores acima de 2147483647 (que dariam erro 500 no banco)
const MAX_INTEGER_PG = 2147483647;
function inteiroEstrito(valor) {
  const texto = typeof valor === 'number' ? String(valor) : typeof valor === 'string' ? valor.trim() : '';
  if (!/^\d{1,10}$/.test(texto)) return null;
  const n = Number(texto);
  return n <= MAX_INTEGER_PG ? n : null;
}

// tamanhos máximos dos campos de texto
const LIMITE = { NOME: 150, EMAIL: 254, CURSO: 100, POLO: 100, BUSCA: 100 };
// teto de linhas das listagens que antes não tinham LIMIT (evita respostas gigantes)
const LIMITE_LISTAGEM = 1000;
function exigirTamanho(rotulo, valor, max) {
  if (valor.length > max) throw new ErroHttp(400, `${rotulo} deve ter no máximo ${max} caracteres.`);
}

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
// data usada como filtro de consulta: o ano 0000 passa no dataValida, mas o Postgres não aceita (daria erro 500)
const dataDeFiltroValida = (s) => dataValida(s) && s >= '1900-01-01';

// início e término da prova de um agendamento, como instantes no fuso de São Paulo. Usam os apelidos
// "a" (agendamentos) e "v" (vagas); "fuso" é o parâmetro da consulta com o FUSO (ex.: '$3').
// A prova "passou" quando o TÉRMINO passa; vaga antiga sem horário de fim termina no horário de início
const sqlInicioProva = (fuso) => `((a.data_agendada::date + a.horario_agendado::time) AT TIME ZONE ${fuso})`;
const sqlTerminoProva = (fuso) =>
  `((a.data_agendada::date + COALESCE(v.horario_fim::time, a.horario_agendado::time)) AT TIME ZONE ${fuso})`;

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

// curso já com espaços normalizados. Se já existe o mesmo curso escrito com outras maiúsculas/minúsculas
// ou espaços (em alunos ou vagas), usa a grafia existente (a mais usada), para não virar um curso separado.
// Os dados antigos não são alterados.
async function cursoCanonico(db, curso) {
  if (!curso) return curso;
  const { rows } = await db.query(
    `SELECT curso FROM (
        SELECT TRIM(curso) AS curso FROM usuarios WHERE curso IS NOT NULL
        UNION ALL
        SELECT TRIM(curso) FROM vagas WHERE curso IS NOT NULL
     ) c
      WHERE LOWER(regexp_replace(curso, '[[:space:]]+', ' ', 'g')) = LOWER($1)
      GROUP BY curso
      ORDER BY COUNT(*) DESC, curso
      LIMIT 1`,
    [curso]
  );
  return rows[0] ? normalizarEspacos(rows[0].curso) : curso;
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

  // daqui para baixo a senha conferiu e a conta existe: a tentativa recusada é registrada em nome dela
  // (sem senha, hash ou token na descrição); falha ao gravar a auditoria não muda a resposta do login
  const registrarLoginRecusado = (acao, motivo) =>
    registrarAuditoria(pool, acao, `Login recusado para ${usuario.nome} (${usuario.matricula}): ${motivo}`, usuario.matricula, req.ip)
      .catch(() => {});

  if (usuario.ativo === false) {
    await registrarLoginRecusado('LOGIN_RECUSADO_CONTA_INATIVA', 'conta desativada');
    return res.status(403).json({ sucesso: false, mensagem: 'Esta conta foi desativada. Procure a coordenação.' });
  }

  if (usuario.trocar_senha) {
    await registrarLoginRecusado('LOGIN_RECUSADO_TROCA_SENHA', 'primeiro acesso, troca de senha pendente');
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
  let curso = normalizarEspacos(req.body.curso);
  const tipo = String(req.body.tipo ?? '').trim();
  // e-mail sempre gravado em minúsculas (o índice único do banco também compara sem maiúsculas)
  const email = String(req.body.email ?? '').trim().toLowerCase();
  const foto = req.body.foto || null;
  const polo = String(req.body.polo ?? '').trim();

  if (!nome || !tipo || !email) {
    return res.status(400).json({ sucesso: false, mensagem: 'Preencha nome, e-mail e tipo de perfil.' });
  }
  exigirTamanho('O nome', nome, LIMITE.NOME);
  exigirTamanho('O e-mail', email, LIMITE.EMAIL);
  exigirTamanho('O curso', curso, LIMITE.CURSO);
  const prefixo = PREFIXO_MATRICULA[tipo];
  if (!prefixo) {
    return res.status(400).json({ sucesso: false, mensagem: 'Tipo de perfil inválido.' });
  }
  if (tipo === 'Aluno' && !curso) {
    return res.status(400).json({ sucesso: false, mensagem: 'Informe o curso do aluno.' });
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
  curso = await cursoCanonico(pool, curso);

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
      // o nome do índice/constraint (ou o detalhe do erro) diz qual campo repetiu
      if (/email/i.test(`${err.constraint || ''} ${err.detail || ''}`)) {
        return res.status(400).json({ sucesso: false, mensagem: 'Este e-mail já está cadastrado (se o usuário foi excluído, reative-o na lista de usuários).' });
      }
      return res.status(409).json({ sucesso: false, mensagem: 'A matrícula gerada para este cadastro já existe. Tente novamente; se o erro continuar, avise o suporte.' });
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
  const id = inteiroEstrito(req.body.id);
  if (id === null || !req.body.foto) {
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
  const id = inteiroEstrito(req.body.id);
  const polo = String(req.body.polo ?? '').trim();
  if (id === null || !polo) {
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
  exigirTamanho('A busca', busca, LIMITE.BUSCA);
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
  const id = inteiroEstrito(req.body.id);
  if (id === null) {
    return res.status(400).json({ sucesso: false, mensagem: 'Usuário inválido.' });
  }
  // só aceita booleano de verdade: "true" (texto) não pode virar exclusão
  if (typeof req.body.ativo !== 'boolean') {
    return res.status(400).json({ sucesso: false, mensagem: 'Informe se o usuário deve ficar ativo (true ou false).' });
  }
  const ativar = req.body.ativo;

  if (!ativar && id === req.usuario.id) {
    return res.status(400).json({ sucesso: false, mensagem: 'Você não pode excluir a sua própria conta.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // exclusões entram uma de cada vez: dois coordenadores excluindo um ao outro ao mesmo tempo
    // não podem os dois passar pela checagem do "último coordenador ativo"
    if (!ativar) await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['exclusao-usuarios']);

    const { rows } = await client.query(
      'SELECT id, nome, matricula, tipo, ativo FROM usuarios WHERE id = $1 FOR UPDATE',
      [id]
    );
    const alvo = rows[0];
    if (!alvo) throw new ErroHttp(404, 'Usuário não encontrado.');
    if (alvo.ativo === ativar) {
      throw new ErroHttp(409, ativar ? 'O usuário já está ativo.' : 'O usuário já está excluído.');
    }

    const ehAluno = normalizar(alvo.tipo) === PERFIL.ALUNO;
    let cancelados = 0;
    let mantidosComEntrada = 0;

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
      if (ehAluno) {
        // libera as vagas só das provas que ainda não terminaram e sem entrada confirmada. Os agendamentos
        // com entrada confirmada e os de provas já terminadas continuam ATIVOS (histórico e lista do dia
        // da portaria preservados). A condição da entrada fica no próprio UPDATE: se a portaria confirmar
        // ao mesmo tempo, a linha travada é reavaliada e o agendamento confirmado não é cancelado
        const r = await client.query(
          `UPDATE agendamentos a SET status = 'INATIVO'
             FROM vagas v
            WHERE v.id = a.vaga_id AND a.usuario_id = $1 AND a.status = 'ATIVO'
              AND a.entrada_confirmada_em IS NULL
              AND ${sqlTerminoProva('$2')} > NOW()`,
          [id, FUSO]
        );
        cancelados = r.rowCount;
        const m = await client.query(
          `SELECT COUNT(*)::int AS n FROM agendamentos
            WHERE usuario_id = $1 AND status = 'ATIVO' AND entrada_confirmada_em IS NOT NULL`,
          [id]
        );
        mantidosComEntrada = m.rows[0].n;
      }
    } else {
      await client.query('UPDATE usuarios SET ativo = true WHERE id = $1', [id]);
    }

    // só a exclusão de aluno fala em agendamentos
    const resumoAgendamentos = `${cancelados} agendamento(s) futuro(s) cancelado(s); ` +
      `${mantidosComEntrada} com entrada confirmada ${mantidosComEntrada === 1 ? 'foi mantido' : 'foram mantidos'}`;

    await registrarAuditoria(
      client,
      ativar ? 'REATIVACAO_USUARIO' : 'SOFT_DELETE',
      ativar
        ? `Usuário reativado: ${alvo.nome} (${alvo.matricula}, ${alvo.tipo})`
        : `Usuário excluído: ${alvo.nome} (${alvo.matricula}, ${alvo.tipo})${ehAluno ? `; ${resumoAgendamentos}` : ''}`,
      req.usuario.nome, req.ip
    );

    await client.query('COMMIT');

    res.json({
      sucesso: true,
      mensagem: ativar
        ? 'Usuário reativado com sucesso.'
        : `Usuário excluído.${ehAluno ? ` ${resumoAgendamentos}.` : ''}`
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

    // - intervalo mínimo entre pedidos: o pedido feito há menos de INTERVALO_MIN_CODIGO_SEG não gera
    //   código novo (a resposta é a mesma, e o código anterior continua valendo);
    // - o contador de tentativas só volta a zero quando o código anterior já venceu (ou não existe),
    //   assim pedir códigos novos não dá mais 5 tentativas a cada pedido.
    // A condição fica no próprio UPDATE para dois pedidos simultâneos não gerarem dois códigos.
    const gerado = await pool.query(
      `UPDATE usuarios
          SET codigo_recuperacao = $1,
              codigo_tentativas = CASE WHEN codigo_expiracao IS NULL OR codigo_expiracao <= NOW()
                                       THEN 0 ELSE codigo_tentativas END,
              codigo_expiracao = NOW() + $3 * INTERVAL '1 minute'
        WHERE id = $2
          AND (codigo_expiracao IS NULL
               OR codigo_expiracao - $3 * INTERVAL '1 minute' <= NOW() - $4 * INTERVAL '1 second')`,
      [hashCodigo(codigo), usuario.id, VALIDADE_CODIGO_MIN, INTERVALO_MIN_CODIGO_SEG]
    );
    if (gerado.rowCount === 0) {
      return res.json({ sucesso: true, mensagem: MENSAGEM });
    }
    codigoTeste = codigo;

    try {
      await transporter.sendMail({
        from: `"Portal UNIFAA" <${process.env.EMAIL_USER}>`,
        to: usuario.email,
        subject: 'Código de Recuperação de Senha - Portal UNIFAA',
        text: `Olá ${usuario.nome},\n\nSeu código de verificação para redefinir a senha é: ${codigo}\n\nEste código é válido por ${VALIDADE_CODIGO_MIN} minutos. Se você não solicitou, ignore este e-mail.`
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
  // o bcrypt ignora o que passa de 72 bytes; letras acentuadas e alguns símbolos ocupam 2 bytes ou mais
  if (Buffer.byteLength(novaSenha, 'utf8') > MAX_BYTES_SENHA) {
    return res.status(400).json({
      sucesso: false,
      mensagem: `A nova senha deve ter no máximo ${MAX_BYTES_SENHA} caracteres (letras acentuadas e alguns símbolos contam como 2 ou mais).`
    });
  }

  const INVALIDO = { sucesso: false, mensagem: 'Código ou senha provisória inválidos ou expirados.' };

  // a tentativa é contada ANTES de comparar, num único UPDATE: pedidos simultâneos entram
  // um de cada vez na linha do usuário e nenhum passa do limite
  const { rows } = await pool.query(
    `UPDATE usuarios
        SET codigo_tentativas = codigo_tentativas + 1
      WHERE LOWER(matricula) = LOWER($1) AND ativo AND codigo_tentativas < $2
      RETURNING id, senha, trocar_senha, codigo_recuperacao, (codigo_expiracao > NOW()) AS valido`,
    [matricula, MAX_TENTATIVAS_CODIGO]
  );
  const usuario = rows[0];

  if (!usuario) {
    const existe = await pool.query('SELECT 1 FROM usuarios WHERE LOWER(matricula) = LOWER($1) AND ativo', [matricula]);
    if (existe.rows.length === 0) return res.status(400).json(INVALIDO);
    return res.status(400).json({
      sucesso: false,
      mensagem: `Muitas tentativas incorretas. Aguarde o código atual vencer (até ${VALIDADE_CODIGO_MIN} minutos) e clique em "Esqueci minha senha" para solicitar um novo código.`
    });
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

  if (!confere) return res.status(400).json(INVALIDO);

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
  let curso = normalizarEspacos(req.body.curso);
  const disciplina = String(req.body.disciplina ?? '').trim();
  const data = String(req.body.data ?? '').trim();
  const inicio = String(req.body.horario_inicio ?? '').trim();
  const fim = String(req.body.horario_fim ?? '').trim();
  const limiteInformado = String(req.body.limite_vagas ?? '').trim();
  const limite = inteiroEstrito(req.body.limite_vagas);
  const agInicio = String(req.body.agendamento_inicio ?? '').trim();
  const agFim = String(req.body.agendamento_fim ?? '').trim();

  if (!polo || !curso || !disciplina || !data || !inicio || !fim || !limiteInformado) {
    return res.status(400).json({ sucesso: false, mensagem: 'Preencha todos os campos da vaga.' });
  }
  exigirTamanho('O polo', polo, LIMITE.POLO);
  exigirTamanho('O curso', curso, LIMITE.CURSO);
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
  const agoraHora = new Date().toLocaleTimeString('sv-SE', { timeZone: FUSO }).slice(0, 5);
  if (data === hoje && inicio <= agoraHora) {
    return res.status(400).json({ sucesso: false, mensagem: 'O horário de início da prova já passou.' });
  }
  if (limite === null || limite < 1 || limite > 5000) {
    return res.status(400).json({ sucesso: false, mensagem: 'O limite de vagas deve ser um número inteiro entre 1 e 5000.' });
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
  curso = await cursoCanonico(pool, curso);

  // vaga repetida = mesmo polo + disciplina + CURSO + data + horário de início (a mesma disciplina pode
  // ser oferecida a cursos diferentes, cada um com o seu limite). Polo, disciplina e curso são comparados
  // sem diferenciar maiúsculas/minúsculas nem espaços nas pontas (no curso, também os espaços repetidos).
  // O advisory lock da mesma chave faz dois cadastros iguais simultâneos entrarem um de cada vez, então a
  // checagem enxerga o anterior; o índice único uq_vagas_polo_disciplina_curso_data_hora é a proteção extra
  const REPETIDA = 'Já existe uma vaga desta disciplina para este curso, neste polo, na mesma data e horário.';
  const chave = ['vaga', polo, nomeDisciplina.trim(), curso, data, inicio].map((s) => String(s).toLowerCase()).join('|');

  const client = await pool.connect();
  let ins;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [chave]);

    const repetida = await client.query(
      `SELECT 1 FROM vagas
        WHERE LOWER(TRIM(polo)) = LOWER($1)
          AND LOWER(TRIM(disciplina)) = LOWER(TRIM($2))
          AND LOWER(regexp_replace(TRIM(COALESCE(curso, '')), '[[:space:]]+', ' ', 'g')) = LOWER($3)
          AND data_prova = $4 AND horario = $5::time
        LIMIT 1`,
      [polo, nomeDisciplina, curso, data, inicio]
    );
    if (repetida.rows.length > 0) throw new ErroHttp(409, REPETIDA);

    ins = await client.query(
      `INSERT INTO vagas (polo, curso, disciplina, data_prova, horario, horario_fim, limite_vagas, agendamento_inicio, agendamento_fim, criado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [polo, curso, nomeDisciplina, data, inicio, fim, limite, agInicio || null, agFim || null, req.usuario.nome]
    );

    await registrarAuditoria(
      client, 'ADICAO_VAGAS',
      `${limite} vagas abertas para ${nomeDisciplina} (${curso}) no ${polo} em ${data}, ${inicio} às ${fim}${agInicio ? `, agendamento de ${agInicio} a ${agFim}` : ''}`,
      req.usuario.nome, req.ip
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return res.status(409).json({ sucesso: false, mensagem: REPETIDA });
    throw err;
  } finally {
    client.release();
  }

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
  const id = inteiroEstrito(req.body.id);
  if (id === null) {
    return res.status(400).json({ sucesso: false, mensagem: 'Disciplina inválida.' });
  }
  // só aceita booleano de verdade: "true" (texto) não pode virar inativação
  if (typeof req.body.ativa !== 'boolean') {
    return res.status(400).json({ sucesso: false, mensagem: 'Informe se a disciplina deve ficar ativa (true ou false).' });
  }
  const ativar = req.body.ativa;

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

// todas as vagas cadastradas (inclusive as passadas), com ocupação e data/hora do cadastro.
// futura = a prova ainda não TERMINOU (prova em andamento não é "realizada"); vaga antiga sem
// horário de fim termina no horário de início, como no resto do sistema
app.get('/api/vagas-gestao', autenticar, exigirPerfil(PERFIL.COORD), rota(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT v.id, v.polo, v.curso, v.disciplina, v.data_prova, v.horario, v.horario_fim, v.limite_vagas,
            v.agendamento_inicio, v.agendamento_fim, v.criado_em, v.criado_por,
            COALESCE(c.qtd, 0)::int AS ocupadas,
            ((v.data_prova + COALESCE(v.horario_fim::time, v.horario::time)) AT TIME ZONE $1) > NOW() AS futura
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
      ORDER BY v.data_prova, v.horario
      LIMIT ${LIMITE_LISTAGEM}`,
    [FUSO, cursoDoAluno]
  );
  res.json(rows);
}));

// ==========================================
// AGENDAMENTOS (aluno)
// ==========================================
app.post('/api/agendar', autenticar, exigirPerfil(PERFIL.ALUNO), rota(async (req, res) => {
  const vagaId = inteiroEstrito(req.body.vaga_id);
  if (vagaId === null) {
    return res.status(400).json({ sucesso: false, mensagem: 'Vaga inválida.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // trava o aluno: pedidos simultâneos dele (mesmo em vagas diferentes da mesma disciplina)
    // entram um de cada vez, então a checagem de duplicidade abaixo enxerga o anterior
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`agendar:${req.usuario.id}`]);

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

    // prova que já terminou sem entrada confirmada (o aluno faltou) não prende a disciplina;
    // o registro antigo continua como está
    const dup = await client.query(
      `SELECT 1 FROM agendamentos a
         JOIN vagas v ON v.id = a.vaga_id
        WHERE a.usuario_id = $1 AND a.status = 'ATIVO' AND LOWER(TRIM(v.disciplina)) = LOWER(TRIM($2))
          AND NOT (a.entrada_confirmada_em IS NULL AND ${sqlTerminoProva('$3')} <= NOW())`,
      [req.usuario.id, vaga.disciplina, FUSO]
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
  const agendamentoId = inteiroEstrito(req.body.agendamento_id);
  const novaVagaId = inteiroEstrito(req.body.nova_vaga_id);
  if (agendamentoId === null || novaVagaId === null) {
    return res.status(400).json({ sucesso: false, mensagem: 'Informe o agendamento e o novo horário.' });
  }

  const atual = await pool.query(
    `SELECT a.id, a.vaga_id, v.disciplina, v.data_prova, v.horario,
            (a.entrada_confirmada_em IS NOT NULL) AS entrou,
            ((a.data_agendada::date + a.horario_agendado::time) AT TIME ZONE $3) <= NOW() AS prova_passou,
            (((a.data_agendada::date + a.horario_agendado::time) AT TIME ZONE $3) - NOW()) >= INTERVAL '24 hours' AS pode_alterar
       FROM agendamentos a
       JOIN vagas v ON v.id = a.vaga_id
      WHERE a.id = $1 AND a.usuario_id = $2 AND a.status = 'ATIVO'`,
    [agendamentoId, req.usuario.id, FUSO]
  );
  const ag = atual.rows[0];
  if (!ag) return res.status(404).json({ sucesso: false, mensagem: 'Agendamento ativo não encontrado.' });

  if (ag.entrou) {
    return res.status(400).json({ sucesso: false, mensagem: 'A entrada nesta prova já foi confirmada pela portaria; não é possível reagendar.' });
  }

  if (ag.prova_passou) {
    await registrarAuditoria(
      pool, 'REAGENDAMENTO_BLOQUEADO',
      `Tentativa de reagendamento negada (prova já iniciada ou passada) de ${ag.disciplina} pelo aluno ${req.usuario.nome}`,
      req.usuario.nome, req.ip
    );
    return res.status(400).json({
      sucesso: false,
      mensagem: 'Ação Bloqueada: o horário desta prova já começou ou já passou; não é possível reagendar este agendamento.'
    });
  }

  const bloquearPor24h = async () => {
    await registrarAuditoria(
      pool, 'REAGENDAMENTO_BLOQUEADO',
      `Tentativa de reagendamento negada (< 24h) de ${ag.disciplina} pelo aluno ${req.usuario.nome}`,
      req.usuario.nome, req.ip
    );
    return res.status(400).json({
      sucesso: false,
      mensagem: 'Ação Bloqueada: o reagendamento só é permitido com mais de 24 horas de antecedência da prova.'
    });
  };

  if (!ag.pode_alterar) return bloquearPor24h();
  if (ag.vaga_id === novaVagaId) {
    return res.status(400).json({ sucesso: false, mensagem: 'Escolha um horário diferente do atual.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // trava o agendamento atual: dois reagendamentos/cancelamentos simultâneos não passam juntos
    const trava = await client.query(
      `SELECT id FROM agendamentos
        WHERE id = $1 AND usuario_id = $2 AND status = 'ATIVO' AND entrada_confirmada_em IS NULL
        FOR UPDATE`,
      [agendamentoId, req.usuario.id]
    );
    if (!trava.rows[0]) throw new ErroHttp(404, 'Agendamento ativo não encontrado.');

    // refaz a regra das 24h já com a linha travada: o agendamento pode ter mudado (ou o tempo passado)
    // entre a checagem acima e o bloqueio. clock_timestamp() é a hora real, não a do início da transação
    const prazo = await client.query(
      `SELECT (((data_agendada::date + horario_agendado::time) AT TIME ZONE $2) - clock_timestamp()) >= INTERVAL '24 hours' AS pode_alterar
         FROM agendamentos WHERE id = $1`,
      [agendamentoId, FUSO]
    );
    if (!prazo.rows[0].pode_alterar) {
      await client.query('ROLLBACK');
      return bloquearPor24h();
    }

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

// situacao: REALIZADA (a portaria confirmou a entrada e a prova já começou), PENDENTE (prova ainda não
// terminou, inclusive em andamento sem entrada ou com entrada confirmada antes do início) ou ENCERRADA
// (terminou sem entrada confirmada). A hora da prova é comparada no fuso de São Paulo
app.get('/api/meus-agendamentos', autenticar, exigirPerfil(PERFIL.ALUNO), rota(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.id, a.vaga_id, a.data_agendada, a.horario_agendado, v.horario_fim, v.disciplina, v.polo,
            (a.entrada_confirmada_em IS NOT NULL) AS entrada_confirmada,
            CASE
              WHEN a.entrada_confirmada_em IS NOT NULL AND ${sqlInicioProva('$2')} <= NOW() THEN 'REALIZADA'
              WHEN ${sqlTerminoProva('$2')} > NOW() THEN 'PENDENTE'
              ELSE 'ENCERRADA'
            END AS situacao
       FROM agendamentos a
       JOIN vagas v ON v.id = a.vaga_id
      WHERE a.usuario_id = $1 AND a.status = 'ATIVO'
      ORDER BY a.data_agendada, a.horario_agendado`,
    [req.usuario.id, FUSO]
  );
  res.json(rows);
}));

// código mostrado ao aluno, derivado do id (AG-000123); não é gravado no banco
const codigoAgendamento = (id) => `AG-${String(id).padStart(6, '0')}`;

// comprovante do próprio agendamento ativo. Tudo vem do banco e a hora de emissão é a do servidor.
// Agendamento de outro aluno, inexistente ou inativo recebem a mesma resposta (não revela quais ids existem)
app.get('/api/agendamentos/:id/comprovante', autenticar, exigirPerfil(PERFIL.ALUNO), rota(async (req, res) => {
  const agendamentoId = inteiroEstrito(req.params.id);
  if (agendamentoId === null) {
    return res.status(400).json({ sucesso: false, mensagem: 'Agendamento inválido.' });
  }

  const { rows } = await pool.query(
    `SELECT a.id, a.status, a.data_agendada, a.horario_agendado, v.horario_fim, v.disciplina, v.polo,
            COALESCE(NULLIF(TRIM(v.curso), ''), u.curso) AS curso, u.nome, u.matricula,
            -- criado_em é TIMESTAMP sem fuso preenchido pelo DEFAULT now() do banco, isto é, no fuso da sessão
            -- (UTC no Supabase); lido no fuso da sessão vira um instante absoluto (timestamptz -> Date)
            a.criado_em AT TIME ZONE current_setting('TimeZone') AS criado_em
       FROM agendamentos a
       JOIN vagas v ON v.id = a.vaga_id
       JOIN usuarios u ON u.id = a.usuario_id
      WHERE a.id = $1 AND a.usuario_id = $2 AND a.status = 'ATIVO'`,
    [agendamentoId, req.usuario.id]
  );
  const ag = rows[0];
  if (!ag) return res.status(404).json({ sucesso: false, mensagem: 'Comprovante não encontrado.' });

  const codigo = codigoAgendamento(ag.id);
  const agora = new Date();
  // "dd/mm/aaaa hh:mm:ss" no fuso de São Paulo
  const emSP = (data) => {
    const [dia, hora] = data.toLocaleString('sv-SE', { timeZone: FUSO }).split(' ');
    return `${dia.split('-').reverse().join('/')} ${hora}`;
  };
  // agendamentos antigos podem não ter criado_em
  const agendadoEm = ag.criado_em ? new Date(ag.criado_em) : null;

  await registrarAuditoria(
    pool, 'COMPROVANTE_EMITIDO',
    `Aluno ${ag.nome} (${ag.matricula}) emitiu o comprovante ${codigo} do agendamento ${ag.id} (${ag.disciplina})`,
    req.usuario.nome, req.ip
  );

  res.json({
    sucesso: true,
    comprovante: {
      codigo,
      agendamento_id: ag.id,
      aluno_nome: ag.nome,
      matricula: ag.matricula,
      disciplina: ag.disciplina,
      curso: ag.curso || null,
      polo: ag.polo || null,
      data_prova: ag.data_agendada,
      horario_inicio: String(ag.horario_agendado).slice(0, 5),
      horario_fim: ag.horario_fim ? String(ag.horario_fim).slice(0, 5) : null,
      situacao: ag.status,
      agendado_em: agendadoEm ? agendadoEm.toISOString() : null,
      agendado_em_local: agendadoEm ? emSP(agendadoEm) : null,
      emitido_em: agora.toISOString(),
      emitido_em_local: emSP(agora),
      fuso: FUSO
    }
  });
}));

app.post('/api/cancelar-agendamento', autenticar, exigirPerfil(PERFIL.ALUNO), rota(async (req, res) => {
  const agendamentoId = inteiroEstrito(req.body.agendamento_id);
  if (agendamentoId === null) {
    return res.status(400).json({ sucesso: false, mensagem: 'Agendamento inválido.' });
  }
  const NAO_ENCONTRADO = { sucesso: false, mensagem: 'Agendamento ativo não encontrado.' };

  // a regra das 24h é calculada no banco, no fuso de São Paulo
  const { rows } = await pool.query(
    `SELECT a.id, v.disciplina,
            (a.entrada_confirmada_em IS NOT NULL) AS entrou,
            ((a.data_agendada::date + a.horario_agendado::time) AT TIME ZONE $3) <= NOW() AS prova_passou,
            (((a.data_agendada::date + a.horario_agendado::time) AT TIME ZONE $3) - NOW()) >= INTERVAL '24 hours' AS pode_cancelar
       FROM agendamentos a
       JOIN vagas v ON v.id = a.vaga_id
      WHERE a.id = $1 AND a.usuario_id = $2 AND a.status = 'ATIVO'`,
    [agendamentoId, req.usuario.id, FUSO]
  );
  const ag = rows[0];
  if (!ag) return res.status(404).json(NAO_ENCONTRADO);

  if (ag.entrou) {
    return res.status(400).json({ sucesso: false, mensagem: 'A entrada nesta prova já foi confirmada pela portaria; não é possível cancelar.' });
  }
  if (ag.prova_passou) {
    await registrarAuditoria(
      pool, 'CANCELAMENTO_BLOQUEADO',
      `Tentativa de cancelamento negada (prova já iniciada ou passada) de ${ag.disciplina} pelo aluno ${req.usuario.nome}`,
      req.usuario.nome, req.ip
    );
    return res.status(400).json({
      sucesso: false,
      mensagem: 'Ação Bloqueada: o horário desta prova já começou ou já passou; não é possível cancelar este agendamento.'
    });
  }
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

  // só cancela se ainda estiver ativo (e sem entrada): pedidos repetidos ao mesmo tempo
  // cancelam uma única vez e geram um único log
  const upd = await pool.query(
    `UPDATE agendamentos SET status = 'INATIVO'
      WHERE id = $1 AND status = 'ATIVO' AND entrada_confirmada_em IS NULL
      RETURNING id`,
    [agendamentoId]
  );
  if (upd.rowCount !== 1) return res.status(404).json(NAO_ENCONTRADO);

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
// nota mínima para aprovação: a situação (resultado) é calculada aqui e a tela só exibe
const NOTA_MINIMA_APROVACAO = 6;
const sqlResultadoNota = (param) =>
  `CASE WHEN nota IS NULL THEN 'Sem nota' WHEN nota >= ${param} THEN 'Aprovado' ELSE 'Reprovado' END AS resultado`;

// resultados do próprio aluno (identificado pela matrícula do token, nunca por nome)
app.get('/api/resultados', autenticar, exigirPerfil(PERFIL.ALUNO), rota(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT *, ${sqlResultadoNota('$2')} FROM notas_alunos WHERE matricula = $1 ORDER BY id DESC`,
    [req.usuario.matricula, NOTA_MINIMA_APROVACAO]
  );
  res.json(rows);
}));

app.get('/api/notas', autenticar, exigirPerfil(PERFIL.COORD), rota(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT *, ${sqlResultadoNota('$1')} FROM notas_alunos ORDER BY id DESC LIMIT 500`,
    [NOTA_MINIMA_APROVACAO]
  );
  res.json(rows);
}));

// só aceita número de verdade (tipo number do JSON), de 0 a 10, com até 2 casas decimais.
// Texto (inclusive "7,5", "1e1", "0x5"), arrays, objetos, nulo e valores fora do intervalo devolvem null
function notaValida(valor) {
  if (typeof valor !== 'number' || !Number.isFinite(valor)) return null;
  if (valor < 0 || valor > 10) return null;
  // String(7.25) = "7.25"; números com mais casas (ou minúsculos, como 1e-7) não passam
  return /^\d{1,2}(\.\d{1,2})?$/.test(String(valor)) ? valor : null;
}

app.post('/api/atualizar-nota', autenticar, exigirPerfil(PERFIL.COORD), rota(async (req, res) => {
  const id = inteiroEstrito(req.body.id);
  const nota = notaValida(req.body.nota);

  if (id === null) {
    return res.status(400).json({ sucesso: false, mensagem: 'Registro inválido.' });
  }
  if (nota === null) {
    return res.status(400).json({
      sucesso: false,
      mensagem: 'Informe uma nota numérica entre 0 e 10, com até 2 casas decimais (ex.: 7.5). Texto, vírgula e outros formatos não são aceitos.'
    });
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
  exigirTamanho('A busca', busca, LIMITE.BUSCA);

  // até 10 alunos; de cada um, TODAS as provas do primeiro dia com prova a partir de hoje (uma linha por
  // prova, em ordem de horário). momento_prova (futura / em_andamento / encerrada) deixa a tela destacar
  // a prova atual ou a próxima quando o aluno tem mais de uma no dia
  const { rows } = await pool.query(
    `WITH alunos AS (
       SELECT u.id, u.nome, u.matricula, u.curso, u.foto_url, (LOWER(u.matricula) = LOWER($1)) AS exato
         FROM usuarios u
        WHERE LOWER(TRIM(u.tipo)) = 'aluno' AND u.ativo
          AND (LOWER(u.matricula) = LOWER($1) OR u.nome ILIKE $3)
        ORDER BY exato DESC, u.nome
        LIMIT 10
     )
     SELECT al.id AS usuario_id, al.nome AS aluno_nome, al.matricula, al.curso, al.foto_url,
            ag.id AS ticket_id, ag.data_agendada, ag.horario_agendado, ag.entrada_confirmada_em,
            ag.disciplina, ag.polo, ag.horario_fim, ag.momento_prova
       FROM alunos al
       LEFT JOIN LATERAL (
         SELECT a.id, a.data_agendada, a.horario_agendado, a.entrada_confirmada_em, v.disciplina, v.polo, v.horario_fim,
                CASE
                  WHEN ${sqlTerminoProva('$4')} <= NOW() THEN 'encerrada'
                  WHEN ${sqlInicioProva('$4')} <= NOW() THEN 'em_andamento'
                  ELSE 'futura'
                END AS momento_prova
           FROM agendamentos a
           JOIN vagas v ON v.id = a.vaga_id
          WHERE a.usuario_id = al.id
            AND a.status = 'ATIVO'
            AND ($2::text IS NULL OR v.polo = $2)
            AND a.data_agendada::date = (
              SELECT MIN(a2.data_agendada::date)
                FROM agendamentos a2
                JOIN vagas v2 ON v2.id = a2.vaga_id
               WHERE a2.usuario_id = al.id
                 AND a2.status = 'ATIVO'
                 AND a2.data_agendada::date >= (NOW() AT TIME ZONE $4)::date
                 AND ($2::text IS NULL OR v2.polo = $2)
            )
       ) ag ON TRUE
      ORDER BY al.exato DESC, al.nome, al.id, ag.horario_agendado, ag.id`,
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
  if (!dataDeFiltroValida(data)) {
    return res.status(400).json({ sucesso: false, mensagem: 'Data inválida. Informe uma data a partir de 01/01/1900 (AAAA-MM-DD ou DD/MM/AAAA).' });
  }
  exigirTamanho('A busca', busca, LIMITE.BUSCA);

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
      ORDER BY a.horario_agendado, u.nome
      LIMIT ${LIMITE_LISTAGEM}`,
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
  const ticketId = inteiroEstrito(req.body.ticket_id);
  if (ticketId === null) {
    return res.status(400).json({ sucesso: false, mensagem: 'Ticket inválido.' });
  }

  // a entrada só pode ser confirmada no dia da prova (fuso de São Paulo), antes do início (aluno que
  // chega cedo) ou durante a prova; depois do término, não
  const upd = await pool.query(
    `UPDATE agendamentos a
        SET entrada_confirmada_em = NOW(), entrada_confirmada_por = $2
       FROM vagas v
      WHERE a.id = $1
        AND v.id = a.vaga_id
        AND a.status = 'ATIVO'
        AND a.entrada_confirmada_em IS NULL
        AND ($3::text IS NULL OR v.polo = $3)
        AND a.data_agendada::date = (NOW() AT TIME ZONE $4)::date
        AND ${sqlTerminoProva('$4')} > NOW()
      RETURNING a.aluno_nome, v.disciplina, a.data_agendada, a.horario_agendado,
                (SELECT u.matricula FROM usuarios u WHERE u.id = a.usuario_id) AS matricula`,
    [ticketId, req.usuario.nome, req.usuario.polo, FUSO]
  );

  if (upd.rows.length === 0) {
    // o motivo só é procurado entre os agendamentos ativos DESTE polo: ticket de outro polo recebe
    // sempre o mesmo 404, esteja confirmado ou não (não revela o estado de tickets de outros polos)
    const NAO_ENCONTRADO = { sucesso: false, mensagem: 'Agendamento ativo não encontrado para este polo.' };
    const { rows } = await pool.query(
      `SELECT a.data_agendada::date AS data,
              (a.entrada_confirmada_em IS NOT NULL) AS ja_entrou,
              (a.data_agendada::date = (NOW() AT TIME ZONE $3)::date) AS eh_hoje,
              (${sqlTerminoProva('$3')} <= NOW()) AS terminou,
              to_char(COALESCE(v.horario_fim::time, a.horario_agendado::time), 'HH24:MI') AS hora_fim
         FROM agendamentos a
         JOIN vagas v ON v.id = a.vaga_id
        WHERE a.id = $1 AND a.status = 'ATIVO' AND ($2::text IS NULL OR v.polo = $2)`,
      [ticketId, req.usuario.polo, FUSO]
    );
    const ag = rows[0];
    if (!ag) return res.status(404).json(NAO_ENCONTRADO);
    if (ag.ja_entrou) {
      return res.status(409).json({ sucesso: false, mensagem: 'A entrada deste aluno já foi confirmada.' });
    }
    if (!ag.eh_hoje) {
      const dataBr = String(ag.data).split('-').reverse().join('/');
      return res.status(400).json({ sucesso: false, mensagem: `A entrada só pode ser confirmada no dia da prova (${dataBr}).` });
    }
    if (ag.terminou) {
      return res.status(400).json({
        sucesso: false,
        mensagem: `O horário desta prova já terminou às ${ag.hora_fim}. A entrada não pode mais ser confirmada.`
      });
    }
    return res.status(404).json(NAO_ENCONTRADO);
  }

  // matrícula, disciplina e data/hora da prova (horário de São Paulo, como nos outros registros)
  // permitem achar a entrada buscando pela matrícula do aluno
  const ent = upd.rows[0];
  await registrarAuditoria(
    pool, 'CONFIRMACAO_ENTRADA',
    `Portaria confirmou entrada do aluno ${ent.aluno_nome}${ent.matricula ? ` (${ent.matricula})` : ''} ` +
      `na prova de ${ent.disciplina} (${ent.data_agendada} ${String(ent.horario_agendado).slice(0, 5)}) (Ticket #${ticketId})`,
    req.usuario.nome, req.ip
  );

  res.json({ sucesso: true, mensagem: 'Entrada confirmada com sucesso!' });
}));

// ==========================================
// AUDITORIA
// ==========================================
const AUDITORIA_POR_PAGINA = 50;
const AUDITORIA_MAX_POR_PAGINA = 100;
const LIMITE_FILTRO_IP = 45;    // maior IPv6 escrito em texto
const LIMITE_FILTRO_ACAO = 50;

// parâmetro de texto da query string: aparado, sem repetição (?x=1&x=2) e sem caracteres de controle
function parametroTexto(query, nome, rotulo, max) {
  const valor = query[nome];
  if (valor === undefined) return '';
  if (typeof valor !== 'string') throw new ErroHttp(400, `Parâmetro "${nome}" repetido ou inválido.`);
  const texto = valor.trim();
  if (/[\u0000-\u001f\u007f]/.test(texto)) throw new ErroHttp(400, `${rotulo} contém caracteres inválidos.`);
  exigirTamanho(rotulo, texto, max);
  return texto;
}

// lê e valida filtros e paginação das rotas de auditoria (tudo vira parâmetro da consulta, nada é concatenado)
function lerFiltrosAuditoria(query) {
  const paginaTexto = parametroTexto(query, 'page', 'A página', 10);
  const pagina = paginaTexto === '' ? 1 : inteiroEstrito(paginaTexto);
  if (pagina === null || pagina < 1) throw new ErroHttp(400, 'A página deve ser um número inteiro maior ou igual a 1.');

  const limiteTexto = parametroTexto(query, 'limite', 'O limite', 10);
  const limite = limiteTexto === '' ? AUDITORIA_POR_PAGINA : inteiroEstrito(limiteTexto);
  if (limite === null || limite < 1 || limite > AUDITORIA_MAX_POR_PAGINA) {
    throw new ErroHttp(400, `O limite deve ser um número inteiro entre 1 e ${AUDITORIA_MAX_POR_PAGINA}.`);
  }

  const dataInicio = parametroTexto(query, 'data_inicio', 'A data inicial', 10);
  const dataFim = parametroTexto(query, 'data_fim', 'A data final', 10);
  if (dataInicio && !dataDeFiltroValida(dataInicio)) throw new ErroHttp(400, 'Data inicial inválida (use AAAA-MM-DD).');
  if (dataFim && !dataDeFiltroValida(dataFim)) throw new ErroHttp(400, 'Data final inválida (use AAAA-MM-DD).');
  if (dataInicio && dataFim && dataInicio > dataFim) {
    throw new ErroHttp(400, 'A data inicial não pode ser depois da data final.');
  }

  const ip = parametroTexto(query, 'ip', 'O IP', LIMITE_FILTRO_IP);
  if (ip && !/^[0-9A-Fa-f.:]+$/.test(ip)) throw new ErroHttp(400, 'O IP deve conter só números, letras de A a F, "." e ":".');

  const acao = parametroTexto(query, 'acao', 'A ação', LIMITE_FILTRO_ACAO).toUpperCase();
  if (acao && !/^[\p{Lu}_]+$/u.test(acao)) throw new ErroHttp(400, 'Tipo de ação inválido.');

  const busca = parametroTexto(query, 'busca', 'A busca', LIMITE.BUSCA);

  return { pagina, limite, dataInicio, dataFim, ip, acao, busca };
}

// busca uma página da auditoria com os filtros. O período é em dias do fuso de São Paulo;
// data_hora é gravada em UTC, então os limites são convertidos para UTC (e o índice em data_hora é usado)
async function consultarAuditoria(f) {
  const condicoes = [];
  const params = [];
  const p = (valor) => { params.push(valor); return `$${params.length}`; };

  if (f.busca) {
    const like = p(`%${escapeLike(f.busca)}%`);
    condicoes.push(`(usuario ILIKE ${like} OR descricao ILIKE ${like} OR acao ILIKE ${like} OR ip ILIKE ${like} OR id::text = ${p(f.busca)})`);
  }
  if (f.dataInicio || f.dataFim) {
    const fuso = p(FUSO);
    if (f.dataInicio) condicoes.push(`data_hora >= (${p(f.dataInicio)}::date::timestamp AT TIME ZONE ${fuso}) AT TIME ZONE 'UTC'`);
    if (f.dataFim) condicoes.push(`data_hora < ((${p(f.dataFim)}::date + 1)::timestamp AT TIME ZONE ${fuso}) AT TIME ZONE 'UTC'`);
  }
  if (f.ip) condicoes.push(`ip ILIKE ${p(`%${escapeLike(f.ip)}%`)}`);
  if (f.acao) condicoes.push(`acao = ${p(f.acao)}`);

  const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';
  const paramsFiltro = [...params];
  const limite = p(f.limite);
  const deslocamento = p((f.pagina - 1) * f.limite);

  const [logs, contagem] = await Promise.all([
    pool.query(
      `SELECT id, acao, descricao, usuario, ip, data_hora FROM auditoria ${where}
        ORDER BY data_hora DESC, id DESC
        LIMIT ${limite} OFFSET ${deslocamento}`,
      params
    ),
    pool.query(`SELECT COUNT(*)::int AS n FROM auditoria ${where}`, paramsFiltro)
  ]);

  const total = contagem.rows[0].n;
  return {
    logs: logs.rows,
    pagina: f.pagina,
    limite: f.limite,
    total,
    totalPaginas: Math.max(1, Math.ceil(total / f.limite))
  };
}

app.get('/api/auditoria', autenticar, exigirPerfil(PERFIL.COORD, PERFIL.AUDIT), rota(async (req, res) => {
  const filtros = lerFiltrosAuditoria(req.query);
  res.json({ sucesso: true, ...(await consultarAuditoria(filtros)) });
}));

app.get('/api/admin/auditoria-completa', autenticar, exigirPerfil(PERFIL.AUDIT), rota(async (req, res) => {
  const filtros = lerFiltrosAuditoria(req.query);
  // os contadores do topo são sempre sobre todos os registros (não dependem dos filtros)
  const [pagina, total, inativos, violacoes] = await Promise.all([
    consultarAuditoria(filtros),
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
    ...pagina
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
  res.status(500).json({ sucesso: false, mensagem: 'Erro interno no servidor.', ...(MODO_TESTE ? { detalhe: err.message } : {}) });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
