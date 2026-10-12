async function realizarLogin(event) {
  event.preventDefault();

  const matricula = document.getElementById('matricula').value.trim();
  const senha = document.getElementById('senha').value;
  const botao = event.submitter;
  if (botao) botao.disabled = true;

  try {
    const { ok, dados } = await apiFetch('/api/login', {
      method: 'POST',
      body: JSON.stringify({ matricula, senha })
    });

    if (ok && dados?.sucesso) {
      salvarSessao(dados);

      const destino = ROTAS_POR_PERFIL[dados.perfil];
      if (destino) {
        window.location.href = destino;
      } else {
        limparSessao();
        Swal.fire({
          icon: 'warning',
          title: 'Atenção',
          text: 'Perfil de usuário não reconhecido pelo sistema.',
          confirmButtonColor: '#065f46'
        });
      }
    } else if (dados?.trocar_senha) {
      // senha provisória correta: o acesso só é liberado depois de definir a nova senha
      await Swal.fire({
        icon: 'info',
        title: 'Primeiro acesso',
        text: 'Você precisa definir uma nova senha antes de entrar. Vamos abrir a tela para isso.',
        confirmButtonColor: '#065f46'
      });
      abrirModalRecuperacao(matricula, true);
    } else {
      Swal.fire({
        icon: 'error',
        title: 'Erro no login',
        text: dados?.mensagem || 'Credenciais inválidas.',
        confirmButtonColor: '#065f46'
      });
    }
  } catch (error) {
    console.error('Erro de conexão:', error);
    Swal.fire({
      icon: 'error',
      title: 'Erro de Conexão',
      text: 'Não foi possível conectar ao servidor. Verifique se o backend está rodando.',
      confirmButtonColor: '#065f46'
    });
  } finally {
    if (botao) botao.disabled = false;
  }
}

// PASSO 1: enviar código para o e-mail
async function enviarCodigoEmail(event) {
  event.preventDefault();
  const matricula = document.getElementById('matriculaRecuperar').value.trim();
  const btnEnviar = document.getElementById('btnEnviarCodigo');

  btnEnviar.disabled = true;
  btnEnviar.innerText = 'Enviando...';

  try {
    const { ok, dados } = await apiFetch('/api/solicitar-codigo', {
      method: 'POST',
      body: JSON.stringify({ matricula })
    });

    if (ok) {
      Swal.fire({
        icon: 'success',
        title: 'Solicitação enviada',
        text: dados?.mensagem || 'Verifique sua caixa de entrada para obter o código.',
        confirmButtonColor: '#065f46'
      });
      irParaPasso2();
    } else {
      Swal.fire({
        icon: 'error',
        title: 'Erro',
        text: dados?.mensagem || 'Não foi possível solicitar o código.',
        confirmButtonColor: '#065f46'
      });
    }
  } catch (error) {
    console.error('Erro ao solicitar código:', error);
    Swal.fire({
      icon: 'error',
      title: 'Erro de Conexão',
      text: 'Não foi possível conectar ao servidor para enviar o código.',
      confirmButtonColor: '#065f46'
    });
  } finally {
    btnEnviar.disabled = false;
    btnEnviar.innerText = 'Enviar Código';
  }
}

// PASSO 2: validar código e redefinir a senha
async function enviarRecuperacaoSenha(event) {
  event.preventDefault();
  const matricula = document.getElementById('matriculaRecuperar').value.trim();
  const codigo = document.getElementById('codigoVerificacao').value.trim();
  const novaSenha = document.getElementById('novaSenhaRecuperar').value;

  if (novaSenha.length < 8) {
    Swal.fire({
      icon: 'warning',
      title: 'Senha curta',
      text: 'A nova senha deve ter pelo menos 8 caracteres.',
      confirmButtonColor: '#065f46'
    });
    return;
  }

  try {
    const { ok, dados } = await apiFetch('/api/recuperar-senha', {
      method: 'POST',
      body: JSON.stringify({ matricula, codigo, novaSenha })
    });

    if (ok) {
      Swal.fire({
        icon: 'success',
        title: 'Sucesso!',
        text: dados?.mensagem || 'Senha alterada com sucesso!',
        confirmButtonColor: '#065f46'
      }).then(fecharModalRecuperacao);
    } else {
      Swal.fire({
        icon: 'error',
        title: 'Erro',
        text: dados?.mensagem || 'Código inválido ou expirado.',
        confirmButtonColor: '#065f46'
      });
    }
  } catch (error) {
    console.error('Erro de conexão:', error);
    Swal.fire({
      icon: 'error',
      title: 'Erro de Conexão',
      text: 'Não foi possível conectar ao servidor para redefinir a senha.',
      confirmButtonColor: '#065f46'
    });
  }
}

function irParaPasso2() {
  const matricula = document.getElementById('matriculaRecuperar').value.trim();
  if (!matricula) {
    Swal.fire({ icon: 'warning', title: 'Informe a matrícula', text: 'Digite a sua matrícula primeiro.', confirmButtonColor: '#065f46' });
    return;
  }
  document.getElementById('resumoMatricula').textContent = `Matrícula: ${matricula}`;
  document.getElementById('passo1Solicitar').style.display = 'none';
  document.getElementById('passo2Confirmar').style.display = 'block';
}

function abrirModalRecuperacao(matricula, direto) {
  const modal = document.getElementById('modalRecuperar');
  document.getElementById('matriculaRecuperar').value = matricula || '';
  modal.style.display = 'flex';
  if (direto && matricula) irParaPasso2();
}

function voltarPasso1() {
  document.getElementById('passo2Confirmar').style.display = 'none';
  document.getElementById('passo1Solicitar').style.display = 'block';
  const campoCodigo = document.getElementById('codigoVerificacao');
  const campoNova = document.getElementById('novaSenhaRecuperar');
  if (campoCodigo) campoCodigo.value = '';
  if (campoNova) campoNova.value = '';
}

function fecharModalRecuperacao() {
  const modal = document.getElementById('modalRecuperar');
  if (modal) modal.style.display = 'none';

  voltarPasso1();

  const campoRec = document.getElementById('matriculaRecuperar');
  if (campoRec) campoRec.value = '';
}

window.addEventListener('DOMContentLoaded', () => {
  const campoMatricula = document.getElementById('matricula');
  const campoSenha = document.getElementById('senha');
  if (campoMatricula) campoMatricula.value = '';
  if (campoSenha) campoSenha.value = '';

  const btnEsqueci = document.getElementById('btnEsqueciSenha');
  const modal = document.getElementById('modalRecuperar');
  const fecharModal = document.getElementById('fecharModal');
  const btnCancelar = document.getElementById('btnCancelarModal');
  const btnVoltar = document.getElementById('btnVoltarPasso1');

  if (btnEsqueci && modal) {
    btnEsqueci.addEventListener('click', (e) => {
      e.preventDefault();
      abrirModalRecuperacao(document.getElementById('matricula').value.trim(), false);
    });
  }

  if (fecharModal) fecharModal.addEventListener('click', fecharModalRecuperacao);
  if (btnCancelar) btnCancelar.addEventListener('click', fecharModalRecuperacao);
  if (btnVoltar) btnVoltar.addEventListener('click', voltarPasso1);

  const btnJaTenho = document.getElementById('btnJaTenhoSenha');
  if (btnJaTenho) btnJaTenho.addEventListener('click', (e) => { e.preventDefault(); irParaPasso2(); });

  window.addEventListener('click', (e) => {
    if (e.target === modal) fecharModalRecuperacao();
  });
});
