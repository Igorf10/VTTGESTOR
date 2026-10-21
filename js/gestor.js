/* Gestor VTT — pedidos, estoque e histórico (JavaScript puro + Supabase) */
(function () {
  'use strict';

  var CONFIG = window.GESTOR_CONFIG || {};

  var token = '';
  var dados = { pedidos: [], produtos: [], movs: [] };
  var idsConhecidos = null;   // para destacar pedidos que chegaram desde a última atualização
  var novos = {};
  var periodo = 'dia';

  var $ = function (id) { return document.getElementById(id); };
  var reais = function (v) { return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); };
  var pad = function (n) { return ('0' + n).slice(-2); };

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function dataHora(iso) {
    var d = new Date(iso);
    return isNaN(d) ? '' : pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /* ================= Supabase (banco, login e imagens) ================= */

  var BUCKET_IMAGENS = 'produtos';
  var sb = null;
  if (window.supabase && CONFIG.supabaseUrl && CONFIG.supabaseKey) {
    sb = window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
  }

  // Mensagens do Supabase em português
  function traduzirErro(err) {
    var msg = (err && (err.message || err.error_description || err.msg)) || String(err || '');
    if (/Invalid login credentials/i.test(msg)) return 'E-mail ou senha incorretos.';
    if (/Email not confirmed/i.test(msg)) return 'Este usuário ainda não foi confirmado. No Supabase, crie o usuário marcando "Auto Confirm User".';
    if (/Failed to fetch|NetworkError|Load failed|network/i.test(msg)) return 'Sem conexão com o Supabase. Confira a internet.';
    if (/permission denied|not allowed|row-level security/i.test(msg)) return 'Sem permissão. Confira se você está logado e se o script SQL foi rodado no Supabase.';
    if (/Could not find the function|schema cache/i.test(msg)) return 'Função não encontrada no banco. Rode o script SQL de novo no Supabase.';
    return msg.replace(/^Error:\s*/, '');
  }

  function ehSessaoExpirada(err) {
    var msg = (err && err.message) || '';
    return /JWT expired|invalid JWT|Faça login no Gestor|refresh token/i.test(msg) || (err && err.status === 401);
  }

  function checar(res) {
    if (res && res.error) throw res.error;
    return res ? res.data : null;
  }

  function rpc(nome, args) {
    return sb.rpc(nome, args).then(checar);
  }

  // Lê tudo que o Gestor mostra e devolve no mesmo formato que as telas usam
  function carregarDados() {
    return Promise.all([
      sb.from('pedidos').select('*, pedido_itens(*)').order('criado_em', { ascending: false }).limit(5000),
      sb.from('produtos').select('*, categorias(nome)').order('id'),
      sb.from('movimentacoes').select('*').order('criado_em', { ascending: false }).limit(400),
      sb.from('categorias').select('*').order('ordem').order('id'),
      sb.rpc('meu_perfil'),
      sb.from('usuarios_gestor').select('*'),
      sb.auth.getSession(),
      sb.from('produto_fotos').select('*').order('ordem').order('id'),
    ]).then(function (res) {
      var perfil = checar(res[4]);
      if (!perfil || !perfil.ativo) throw new Error('SEM_ACESSO');
      var pedidos = checar(res[0]) || [], produtos = checar(res[1]) || [], movs = checar(res[2]) || [], cats = checar(res[3]) || [];
      var sessao = res[6] && res[6].data && res[6].data.session;
      var fotosPorProduto = {};
      (checar(res[7]) || []).forEach(function (f) {
        (fotosPorProduto[f.produto_id] = fotosPorProduto[f.produto_id] || []).push({ id: f.id, url: f.url, caminho: f.caminho });
      });
      return {
        eu: { id: sessao ? sessao.user.id : '', nome: perfil.nome, email: perfil.email, perfil: perfil.perfil },
        usuarios: checar(res[5]) || [],
        pedidos: pedidos.map(function (p) {
          return {
            id: p.id, data: p.criado_em, cupom: p.cupom || '',
            subtotal: Number(p.subtotal), desconto: Number(p.desconto), total: Number(p.total),
            status: p.status, valorFinal: p.valor_final == null ? null : Number(p.valor_final),
            pagamento: p.pagamento || '', dataConfirmacao: p.confirmado_em || '', obs: p.obs || '',
            itens: (p.pedido_itens || []).sort(function (a, b) { return a.id - b.id; }).map(function (i) {
              return { idProduto: i.produto_id, produto: i.produto_nome, qtd: i.qtd, preco: Number(i.preco) };
            }),
          };
        }),
        produtos: produtos.map(function (v) {
          return {
            id: v.id, produto: v.nome, categoria: v.categorias ? v.categorias.nome : '', preco: Number(v.preco),
            precoPromo: v.preco_promocional == null ? null : Number(v.preco_promocional),
            estoque: v.estoque, minimo: v.minimo, ativo: v.ativo, descricao: v.descricao || '', imagem: v.imagem || '',
            fotos: fotosPorProduto[v.id] || [],
          };
        }),
        movs: movs.map(function (m) {
          return {
            data: m.criado_em, idProduto: m.produto_id || '', produto: m.produto_nome, tipo: m.tipo,
            qtd: m.qtd, estoqueApos: m.estoque_apos, ref: m.referencia || '', obs: m.obs || '',
          };
        }),
        categorias: cats.map(function (c) { return { id: c.id, nome: c.nome, ativa: c.ativa, fixa: !!c.fixa }; }),
      };
    });
  }

  // ---- Imagens: pasta "produtos" do Storage, uma subpasta por ID (P001/1700000000.jpg)

  function base64ParaBlob(base64, tipo) {
    var bin = atob(base64), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: tipo });
  }

  // Grava as fotos do produto: apaga as removidas, envia as novas e salva a ordem (a 1ª é a capa)
  function salvarFotos(idProduto, lista, removidas) {
    var passo = Promise.resolve();
    var ids = [];

    (removidas || []).forEach(function (idFoto) {
      passo = passo
        .then(function () { return rpc('remover_foto', { p_foto: idFoto }); })
        .then(function (caminho) {
          if (!caminho) return;
          // Se o arquivo não apagar, não trava o resto (só sobra um arquivo solto no Storage)
          return sb.storage.from(BUCKET_IMAGENS).remove([caminho]).catch(function () {});
        });
    });

    (lista || []).forEach(function (f, i) {
      passo = passo.then(function () {
        if (!f.novo) { ids.push(f.id); return; }
        // Nome novo a cada envio: o navegador nunca mostra uma foto antiga guardada em cache
        var caminho = idProduto + '/' + Date.now() + '-' + i + '.jpg';
        return sb.storage.from(BUCKET_IMAGENS)
          .upload(caminho, base64ParaBlob(f.base64, f.tipo), { contentType: f.tipo, upsert: false })
          .then(checar)
          .then(function () {
            var url = sb.storage.from(BUCKET_IMAGENS).getPublicUrl(caminho).data.publicUrl;
            return rpc('adicionar_foto', { p_produto: idProduto, p_url: url, p_caminho: caminho });
          })
          .then(function (idFoto) { ids.push(idFoto); });
      });
    });

    return passo.then(function () {
      if (ids.length) return rpc('ordenar_fotos', { p_produto: idProduto, p_ids: ids });
    });
  }

  // ---- Usuários: Edge Function "gerenciar-usuarios" (roda no Supabase com a chave secreta)

  function chamarFuncaoUsuarios(corpo) {
    return sb.functions.invoke('gerenciar-usuarios', { body: corpo }).then(function (res) {
      if (!res.error) {
        if (res.data && res.data.erro) throw new Error(res.data.erro);
        return null;
      }
      var resposta = res.error.context;
      if (resposta && typeof resposta.json === 'function') {
        return resposta.json().catch(function () { return null; }).then(function (j) {
          if (j && j.erro) throw new Error(j.erro);
          if (resposta.status === 404) throw new Error('A função "gerenciar-usuarios" não foi encontrada no Supabase. Confira se ela foi publicada com esse nome.');
          if (resposta.status === 401) throw new Error('A função recusou o acesso. Confira se a verificação de JWT está desligada nela (passo a passo no LEIA-ME).');
          throw res.error;
        });
      }
      throw new Error('Não foi possível falar com a função de usuários. Confira se ela foi publicada no Supabase.');
    });
  }

  // ---- Ações do Gestor. Cada uma grava e depois devolve os dados atualizados.

  function inteiro(v) { var n = parseInt(v, 10); return isNaN(n) ? 0 : n; }
  function numero(v) { var n = parseFloat(String(v).replace(',', '.')); return isNaN(n) ? 0 : n; }

  var ACOES = {
    carregar: function () { return null; },
    confirmar: function (d) {
      return rpc('confirmar_pedido', { p_id: d.id, p_valor: d.valorFinal === '' ? null : numero(d.valorFinal), p_pagamento: d.pagamento || '' });
    },
    cancelar: function (d) { return rpc('cancelar_pedido', { p_id: d.id, p_motivo: d.motivo || '' }); },
    ajustar: function (d) {
      return rpc('ajustar_estoque', { p_produto: d.idProduto, p_tipo: d.tipo, p_qtd: inteiro(d.qtd), p_obs: d.obs || '' });
    },
    novoProduto: function (d) {
      return rpc('novo_produto', {
        p_nome: d.produto, p_categoria: d.categoria, p_preco: numero(d.preco), p_descricao: d.descricao || '',
        p_estoque: inteiro(d.estoque), p_minimo: inteiro(d.minimo), p_ativo: d.ativo !== false,
        p_preco_promocional: d.precoPromo === '' || d.precoPromo == null ? null : numero(d.precoPromo),
      }).then(function (id) { return { novoId: id }; });
    },
    editar: function (d) {
      return rpc('editar_produto', {
        p_id: d.idProduto, p_nome: d.produto, p_categoria: d.categoria, p_preco: numero(d.preco),
        p_descricao: d.descricao || '', p_minimo: inteiro(d.minimo), p_ativo: !!d.ativo,
        p_preco_promocional: d.precoPromo === '' || d.precoPromo == null ? null : numero(d.precoPromo),
      });
    },
    fotos: function (d) { return salvarFotos(d.idProduto, d.lista, d.removidas); },
    categoriaSalvar: function (d) { return rpc('salvar_categoria', { p_nome: d.nome, p_antigo: d.antigo || '' }); },
    categoriaMover: function (d) { return rpc('mover_categoria', { p_nome: d.nome, p_direcao: d.direcao }); },
    categoriaAtivar: function (d) { return rpc('ativar_categoria', { p_nome: d.nome, p_ativa: !!d.ativa }); },
    categoriaExcluir: function (d) { return rpc('excluir_categoria', { p_nome: d.nome }); },
    usuario: function (d) { return chamarFuncaoUsuarios(d); },
  };

  function api(acao, payload, silencioso) {
    if (!sb) {
      return Promise.reject(new Error(window.supabase
        ? 'Preencha supabaseUrl e supabaseKey em js/config.js.'
        : 'A biblioteca do Supabase não carregou. Confira a internet.'));
    }
    if (!ACOES[acao]) return Promise.reject(new Error('Ação desconhecida: ' + acao));
    if (!silencioso) $('carregando').hidden = false;

    var extra = null;
    return Promise.resolve()
      .then(function () { return ACOES[acao](payload || {}); })
      .then(function (r) { extra = r; return carregarDados(); })
      .then(function (r) {
        if (extra && typeof extra === 'object') Object.keys(extra).forEach(function (k) { r[k] = extra[k]; });
        return r;
      })
      .catch(function (err) {
        console.error('[Gestor] ' + acao + ':', err);
        if (/SEM_ACESSO|não tem acesso ao Gestor/.test((err && err.message) || '')) {
          if (sb) sb.auth.signOut().catch(function () {});
          sair(true);
          throw new Error('Seu usuário não tem acesso ao Gestor (desativado ou não cadastrado). Fale com o administrador.');
        }
        if (ehSessaoExpirada(err)) {
          sair(true);
          throw new Error('Sua sessão expirou. Entre de novo.');
        }
        throw new Error(traduzirErro(err));
      })
      .finally(function () { if (!silencioso) $('carregando').hidden = true; });
  }

  function toast(msg, erro) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (erro ? ' toast--erro' : '');
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.hidden = true; }, erro ? 6000 : 2600);
  }

  function aplicar(r) {
    var ids = {};
    r.pedidos.forEach(function (p) { ids[p.id] = true; });
    if (idsConhecidos) {
      var chegaram = r.pedidos.filter(function (p) { return !idsConhecidos[p.id]; });
      chegaram.forEach(function (p) { novos[p.id] = true; });
      if (chegaram.length) toast(chegaram.length === 1 ? 'Novo pedido: ' + chegaram[0].id : chegaram.length + ' pedidos novos');
    }
    idsConhecidos = ids;
    dados = r;
    renderTudo();
  }

  /* ================= Login (Supabase Auth: e-mail e senha) ================= */

  function mostrarApp() {
    $('tela-login').hidden = true;
    $('app').hidden = false;
  }

  function sair(expirou) {
    if (sb && !expirou) sb.auth.signOut().catch(function () {});
    token = '';
    idsConhecidos = null;
    $('app').hidden = true;
    $('tela-login').hidden = false;
    $('senha').value = '';
  }

  $('form-login').addEventListener('submit', function (ev) {
    ev.preventDefault();
    $('erro-login').hidden = true;
    if (!sb) {
      $('erro-login').textContent = 'Preencha supabaseUrl e supabaseKey em js/config.js.';
      $('erro-login').hidden = false;
      return;
    }
    $('btn-entrar').disabled = true;
    sb.auth.signInWithPassword({ email: $('email').value.trim(), password: $('senha').value })
      .then(checar)
      .then(function () {
        token = 'ok';
        return api('carregar');
      })
      .then(function (r) { mostrarApp(); aplicar(r); })
      .catch(function (e) {
        token = '';
        $('erro-login').textContent = traduzirErro(e);
        $('erro-login').hidden = false;
      })
      .finally(function () { $('btn-entrar').disabled = false; });
  });

  $('btn-sair').addEventListener('click', function () { sair(false); });

  // Já estava logado neste navegador? Entra direto.
  if (sb) {
    sb.auth.getSession().then(function (r) {
      if (r && r.data && r.data.session) {
        token = 'ok';
        return api('carregar').then(function (dadosIniciais) { mostrarApp(); aplicar(dadosIniciais); });
      }
    }).catch(function () { token = ''; });
  }

  /* ================= Abas ================= */

  document.querySelectorAll('.tab').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('.tab').forEach(function (x) { x.setAttribute('aria-selected', x === b ? 'true' : 'false'); });
      ['pedidos', 'estoque', 'movs', 'usuarios'].forEach(function (t) { $('tab-' + t).hidden = t !== b.dataset.tab; });
    });
  });

  function atualizar(silencioso) {
    return api('carregar', null, silencioso).then(aplicar);
  }

  $('btn-atualizar').addEventListener('click', function () {
    atualizar().then(function () { toast('Atualizado'); }).catch(function (e) { toast(e.message, true); });
  });

  // Procura pedidos novos sozinho (só com a aba visível e nenhuma janela aberta)
  if (CONFIG.atualizarACada > 0) {
    setInterval(function () {
      if (!token || document.hidden || document.querySelector('dialog[open]')) return;
      atualizar(true).catch(function () {});
    }, CONFIG.atualizarACada * 1000);
  }

  /* ================= Pedidos ================= */

  var hoje = new Date();
  $('f-dia').value = hoje.getFullYear() + '-' + pad(hoje.getMonth() + 1) + '-' + pad(hoje.getDate());
  $('f-mes').value = hoje.getFullYear() + '-' + pad(hoje.getMonth() + 1);

  $('seg-periodo').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-p]');
    if (!b) return;
    periodo = b.dataset.p;
    this.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
    $('f-dia').hidden = periodo !== 'dia';
    $('f-mes').hidden = periodo !== 'mes';
    $('f-ano').hidden = periodo !== 'ano';
    renderPedidos();
  });
  ['f-dia', 'f-mes', 'f-ano', 'f-status'].forEach(function (id) { $(id).addEventListener('change', renderPedidos); });

  function noPeriodo(iso) {
    if (periodo === 'tudo') return true;
    var d = new Date(iso);
    if (isNaN(d)) return false;
    var ano = d.getFullYear(), mes = ano + '-' + pad(d.getMonth() + 1), dia = mes + '-' + pad(d.getDate());
    if (periodo === 'dia') return dia === $('f-dia').value;
    if (periodo === 'mes') return mes === $('f-mes').value;
    return String(ano) === $('f-ano').value;
  }

  // Venda confirmada conta no dia em que foi confirmada; as demais, no dia do pedido
  function dataRef(p) { return p.status === 'Confirmada' && p.dataConfirmacao ? p.dataConfirmacao : p.data; }

  function produtoPorId(id) {
    return dados.produtos.filter(function (v) { return v.id === id; })[0] || null;
  }

  // Situação de cada item de um pedido pendente: bate pelo ID e confere a descrição
  function situacaoItem(i) {
    var v = produtoPorId(i.idProduto);
    if (!v) return { ok: false, texto: 'ID não cadastrado no estoque' };
    if (v.produto.trim().toLowerCase() !== i.produto.trim().toLowerCase()) {
      return { ok: false, texto: 'no estoque esse ID é "' + v.produto + '"' };
    }
    if (v.estoque < i.qtd) return { ok: false, texto: 'estoque atual: ' + v.estoque };
    return { ok: true, texto: '' };
  }

  function linhaItem(i, comSituacao) {
    var s = comSituacao ? situacaoItem(i) : { ok: true };
    return '<li><span class="id">' + esc(i.idProduto) + '</span> ' + i.qtd + '× ' + esc(i.produto) + ' — ' + reais(i.preco * i.qtd) +
      (s.ok ? '' : ' <span class="falta">(' + esc(s.texto) + ')</span>') + '</li>';
  }

  function preencherAnos() {
    var anos = {};
    anos[hoje.getFullYear()] = true;
    dados.pedidos.forEach(function (p) { var d = new Date(p.data); if (!isNaN(d)) anos[d.getFullYear()] = true; });
    var atual = $('f-ano').value || String(hoje.getFullYear());
    $('f-ano').innerHTML = Object.keys(anos).sort().reverse().map(function (a) {
      return '<option' + (a === atual ? ' selected' : '') + '>' + a + '</option>';
    }).join('');
  }

  function renderPedidos() {
    var status = $('f-status').value;
    var conf = dados.pedidos.filter(function (p) { return p.status === 'Confirmada' && noPeriodo(dataRef(p)); });
    var fat = conf.reduce(function (s, p) { return s + (p.valorFinal != null ? p.valorFinal : p.total); }, 0);

    $('r-fat').textContent = reais(fat);
    $('r-qtd').textContent = conf.length;
    $('r-ticket').textContent = conf.length ? reais(fat / conf.length) : '—';
    $('r-pend').textContent = dados.pedidos.filter(function (p) { return p.status === 'Pendente'; }).length;

    var cont = {};
    conf.forEach(function (p) { p.itens.forEach(function (i) { cont[i.produto] = (cont[i.produto] || 0) + i.qtd; }); });
    var top = Object.keys(cont).sort(function (a, b) { return cont[b] - cont[a]; }).slice(0, 5);
    $('top5').innerHTML = top.length
      ? 'Mais vendidos: ' + top.map(function (n) { return '<span><b>' + esc(n) + '</b> ' + cont[n] + ' pç</span>'; }).join('')
      : '';

    // Pendentes aparecem sempre (aguardam ação), mesmo fora do período escolhido
    var lista = dados.pedidos.filter(function (p) {
      return (p.status === 'Pendente' || noPeriodo(dataRef(p))) && (!status || p.status === status);
    });
    lista.sort(function (a, b) {
      if ((a.status === 'Pendente') !== (b.status === 'Pendente')) return a.status === 'Pendente' ? -1 : 1;
      return new Date(dataRef(b)) - new Date(dataRef(a));
    });

    $('lista-pedidos').innerHTML = lista.length ? lista.map(function (p) {
      var valor = p.status === 'Confirmada' && p.valorFinal != null ? p.valorFinal : p.total;
      return '<article class="ped ped--' + esc(p.status) + (novos[p.id] ? ' ped--novo' : '') + '">' +
        '<div><span class="ped__id">' + esc(p.id) + '</span><span class="st st--' + esc(p.status) + '">' + esc(p.status) + '</span>' +
          '<div class="ped__meta">' + dataHora(p.data) +
            (p.cupom ? ' · cupom ' + esc(p.cupom) : '') +
            (p.pagamento ? ' · ' + esc(p.pagamento) : '') +
            (p.obs ? ' · ' + esc(p.obs) : '') +
          '</div></div>' +
        '<div class="ped__total">' + reais(valor) +
          (p.desconto > 0 ? '<small>' + reais(p.subtotal) + ' − ' + reais(p.desconto) + ' de desconto</small>' : '') +
          (p.status === 'Confirmada' && p.valorFinal != null && p.valorFinal !== p.total ? '<small>site: ' + reais(p.total) + '</small>' : '') +
        '</div>' +
        '<ul class="ped__itens">' + p.itens.map(function (i) { return linhaItem(i, p.status === 'Pendente'); }).join('') + '</ul>' +
        (p.status === 'Pendente'
          ? '<div class="ped__acoes"><button class="btn btn--primary btn--sm" data-confirmar="' + esc(p.id) + '">Confirmar venda</button>' +
            '<button class="btn btn--danger btn--sm" data-cancelar="' + esc(p.id) + '">Cancelar</button></div>'
          : p.status === 'Confirmada'
            ? '<div class="ped__acoes"><button class="btn btn--danger btn--sm" data-cancelar="' + esc(p.id) + '">Estornar</button></div>'
            : '') +
      '</article>';
    }).join('') : '<p class="vazio">Nenhum pedido neste período.</p>';
    novos = {};
  }

  var pedidoAtual = null;
  function acharPedido(id) { return dados.pedidos.filter(function (p) { return p.id === id; })[0]; }

  $('lista-pedidos').addEventListener('click', function (ev) {
    var bc = ev.target.closest('[data-confirmar]'), bx = ev.target.closest('[data-cancelar]');
    if (bc) {
      pedidoAtual = acharPedido(bc.dataset.confirmar);
      var problemas = 0;
      $('conf-itens').innerHTML = pedidoAtual.itens.map(function (i) { return linhaItem(i, true); }).join('');
      problemas = pedidoAtual.itens.filter(function (i) { return !situacaoItem(i).ok; }).length;
      $('conf-sub').textContent = pedidoAtual.id + ' · total do site ' + reais(pedidoAtual.total) +
        (pedidoAtual.cupom ? ' (cupom ' + pedidoAtual.cupom + ')' : '') +
        (problemas ? ' · ajuste o estoque antes de confirmar' : '');
      $('conf-ok').disabled = problemas > 0;
      $('conf-valor').value = pedidoAtual.total.toFixed(2);
      $('dlg-confirmar').showModal();
    }
    if (bx) {
      pedidoAtual = acharPedido(bx.dataset.cancelar);
      var estorno = pedidoAtual.status === 'Confirmada';
      $('canc-titulo').textContent = estorno ? 'Estornar venda' : 'Cancelar pedido';
      $('canc-ok').textContent = estorno ? 'Estornar' : 'Cancelar pedido';
      $('canc-sub').textContent = estorno
        ? pedidoAtual.id + ' já foi confirmado: as peças voltam para o estoque.'
        : pedidoAtual.id + ' · ' + reais(pedidoAtual.total);
      $('canc-motivo').value = '';
      $('dlg-cancelar').showModal();
    }
  });

  $('dlg-confirmar').addEventListener('close', function () {
    if (this.returnValue !== 'ok' || !pedidoAtual) return;
    api('confirmar', { id: pedidoAtual.id, valorFinal: $('conf-valor').value, pagamento: $('conf-pag').value })
      .then(function (r) { aplicar(r); toast('Venda confirmada e estoque atualizado'); })
      .catch(function (e) { toast(e.message, true); });
  });

  $('dlg-cancelar').addEventListener('close', function () {
    if (this.returnValue !== 'ok' || !pedidoAtual) return;
    api('cancelar', { id: pedidoAtual.id, motivo: $('canc-motivo').value })
      .then(function (r) { aplicar(r); toast(pedidoAtual.status === 'Confirmada' ? 'Venda estornada' : 'Pedido cancelado'); })
      .catch(function (e) { toast(e.message, true); });
  });

  /* ================= Estoque ================= */

  var SEM_IMAGEM = 'img/sem-imagem.svg';

  // Foto enviada pelo Gestor (link do Supabase) aparece direto.
  // Foto antiga do site (img/produtos/...) aparece se siteUrl estiver no config.js.
  function imagemDe(v) {
    var img = v && v.imagem ? String(v.imagem) : '';
    if (!img) return SEM_IMAGEM;
    if (/^(https?:|data:)/i.test(img)) return img;
    if (CONFIG.siteUrl) return CONFIG.siteUrl.replace(/\/+$/, '') + '/' + img.replace(/^\/+/, '');
    return SEM_IMAGEM;
  }

  // Imagem que não carregou: troca pela genérica
  document.addEventListener('error', function (e) {
    var img = e.target;
    if (img && img.tagName === 'IMG' && img.hasAttribute('data-produto-img') && img.getAttribute('src') !== SEM_IMAGEM) {
      img.src = SEM_IMAGEM;
    }
  }, true);

  function estadoVar(v) {
    if (!v.ativo) return 'inativo';
    if (v.estoque <= 0) return 'zero';
    if (v.estoque <= v.minimo) return 'baixo';
    return '';
  }

  // Peças em pedidos pendentes (só informativo; o estoque só baixa ao confirmar)
  function emPendentes() {
    var m = {};
    dados.pedidos.forEach(function (p) {
      if (p.status !== 'Pendente') return;
      p.itens.forEach(function (i) { m[i.idProduto] = (m[i.idProduto] || 0) + i.qtd; });
    });
    return m;
  }

  function categoriaAtiva(nome) {
    var c = (dados.categorias || []).filter(function (x) { return x.nome.toLowerCase() === String(nome).toLowerCase(); })[0];
    return !c || c.ativa;
  }

  function precoCelula(v) {
    if (v.precoPromo == null) return reais(v.preco);
    return '<span class="promo-tag">PROMO</span> <s class="preco-de">' + reais(v.preco) + '</s> ' + reais(v.precoPromo);
  }

  function renderEstoque() {
    var q = $('busca').value.trim().toLowerCase();
    var soBaixo = $('so-baixo').checked;
    var pend = emPendentes();
    var lista = dados.produtos.filter(function (v) {
      var txt = (v.id + ' ' + v.produto + ' ' + v.categoria).toLowerCase();
      if (q && txt.indexOf(q) < 0) return false;
      var est = estadoVar(v);
      return !soBaixo || est === 'baixo' || est === 'zero';
    }).sort(function (a, b) { return a.id.localeCompare(b.id); });

    var total = dados.produtos.reduce(function (s, v) { return s + v.estoque; }, 0);
    $('lista-estoque').innerHTML = lista.length
      ? '<div class="grupo"><div class="grupo__head"><h3>Produtos</h3><span>' + dados.produtos.length + ' cadastrados · ' + total + ' pç em estoque</span></div>' +
        '<div class="tabela"><table><thead><tr><th></th><th>ID</th><th>Produto</th><th class="m-oculta">Categoria</th><th class="n m-oculta">Preço</th>' +
        '<th class="n">Estoque</th><th class="n m-oculta">Pend.</th><th class="n m-oculta">Mín.</th><th></th></tr></thead><tbody>' +
        lista.map(function (v) {
          var foraDoSite = !v.ativo ? ' (fora do site)' : !categoriaAtiva(v.categoria) ? ' (categoria desativada)' : '';
          return '<tr class="' + estadoVar(v) + '">' +
            '<td><img class="thumb" src="' + esc(imagemDe(v)) + '" alt="" loading="lazy" data-produto-img /></td>' +
            '<td class="id">' + esc(v.id) + '</td><td class="nome">' + esc(v.produto) + esc(foraDoSite) + '</td>' +
            '<td class="m-oculta">' + esc(v.categoria) + '</td><td class="n m-oculta">' + precoCelula(v) + '</td>' +
            '<td class="n est">' + v.estoque + '</td><td class="n m-oculta">' + (pend[v.id] || '—') + '</td><td class="n m-oculta">' + v.minimo + '</td>' +
            '<td class="n"><div class="acoes"><button class="btn btn--sm" data-ajustar="' + esc(v.id) + '">Ajustar</button>' +
            '<button class="btn btn--sm" data-editar="' + esc(v.id) + '">Editar</button></div></td></tr>';
        }).join('') + '</tbody></table></div></div>'
      : '<p class="vazio">' + (dados.produtos.length ? 'Nada encontrado.' : 'Nenhum produto cadastrado ainda. Toque em “Novo produto”.') + '</p>';

    if ($('dlg-categorias').open) renderCategorias();
  }

  $('busca').addEventListener('input', renderEstoque);
  $('so-baixo').addEventListener('change', renderEstoque);

  var varAtual = null, tipoAjuste = 'entrada';
  function produtoPorIdEstoque(id) { return dados.produtos.filter(function (v) { return v.id === id; })[0] || null; }
  function nomeVar(v) { return v.id + ' · ' + v.produto; }

  $('lista-estoque').addEventListener('click', function (ev) {
    var ba = ev.target.closest('[data-ajustar]'), be = ev.target.closest('[data-editar]');
    if (ba) {
      varAtual = produtoPorIdEstoque(ba.dataset.ajustar);
      $('aj-sub').textContent = nomeVar(varAtual) + ' · estoque atual: ' + varAtual.estoque;
      $('aj-qtd').value = '';
      $('aj-obs').value = '';
      definirTipo('entrada');
      $('dlg-ajustar').showModal();
    }
    if (be) abrirProduto(produtoPorIdEstoque(be.dataset.editar));
  });

  /* ---------- Ajuste de estoque ---------- */

  function definirTipo(t) {
    tipoAjuste = t;
    $('aj-tipo').querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.t === t ? 'true' : 'false'); });
    $('aj-label').textContent = { entrada: 'Quantidade que chegou', saida: 'Quantidade que saiu', correcao: 'Quantidade contada na prateleira' }[t];
    previaAjuste();
  }

  function previaAjuste() {
    if (!varAtual) return;
    var q = parseInt($('aj-qtd').value, 10);
    if (isNaN(q)) { $('aj-previa').textContent = ''; return; }
    var novo = tipoAjuste === 'entrada' ? varAtual.estoque + q : tipoAjuste === 'saida' ? varAtual.estoque - q : q;
    $('aj-previa').textContent = 'Estoque vai de ' + varAtual.estoque + ' para ' + novo + (novo < 0 ? ' (inválido)' : '');
  }

  $('aj-tipo').addEventListener('click', function (ev) { var b = ev.target.closest('[data-t]'); if (b) definirTipo(b.dataset.t); });
  $('aj-qtd').addEventListener('input', previaAjuste);

  $('dlg-ajustar').addEventListener('close', function () {
    if (this.returnValue !== 'ok' || !varAtual) return;
    api('ajustar', { idProduto: varAtual.id, tipo: tipoAjuste, qtd: $('aj-qtd').value, obs: $('aj-obs').value })
      .then(function (r) { aplicar(r); toast('Estoque ajustado'); })
      .catch(function (e) { toast(e.message, true); });
  });

  /* ---------- Produto: novo e editar ---------- */

  var produtoEditando = null;          // null = produto novo
  var MAX_FOTOS = 4;
  var fotosEdit = [];                  // fotos no formulário, na ordem: { id, url } ou { novo, dataUrl, base64, tipo }
  var fotosRemovidas = [];             // ids das fotos já salvas que foram removidas
  var ordemOriginal = '';

  // Só para mostrar no formulário; quem define o ID de verdade é a API
  function proximoIdPrevisto() {
    var maior = 0;
    dados.produtos.forEach(function (v) { var m = /^P(\d+)$/.exec(v.id); if (m) maior = Math.max(maior, Number(m[1])); });
    return 'P' + ('000' + (maior + 1)).slice(-3);
  }

  function preencherSelectCategorias(atual) {
    var cats = (dados.categorias || []).filter(function (c) { return !c.fixa; }).map(function (c) { return c.nome; });
    if (atual && cats.every(function (c) { return c.toLowerCase() !== atual.toLowerCase(); })) cats.push(atual);
    $('pr-cat').innerHTML = '<option value="">Escolha…</option>' + cats.map(function (c) {
      return '<option' + (atual && c.toLowerCase() === atual.toLowerCase() ? ' selected' : '') + '>' + esc(c) + '</option>';
    }).join('');
  }

  function abrirProduto(v) {
    produtoEditando = v;
    fotosEdit = v ? v.fotos.map(function (f) { return { id: f.id, url: f.url }; }) : [];
    fotosRemovidas = [];
    ordemOriginal = fotosEdit.map(function (f) { return f.id; }).join(',');
    $('pr-arquivo').value = '';
    var novo = !v;
    $('pr-titulo').textContent = novo ? 'Novo produto' : 'Editar ' + v.id;
    $('pr-sub').textContent = novo
      ? 'O ID é gerado ao salvar (próximo: ' + proximoIdPrevisto() + ').'
      : 'O ID não muda. Estoque atual: ' + v.estoque + ' (use Ajustar para mudar).';
    $('pr-nome').value = novo ? '' : v.produto;
    preencherSelectCategorias(novo ? '' : v.categoria);
    $('pr-preco').value = novo ? '' : v.preco.toFixed(2);
    $('pr-promo').value = novo || v.precoPromo == null ? '' : v.precoPromo.toFixed(2);
    // Promoção é só com o administrador
    var admin = souAdmin();
    $('pr-promo').disabled = !admin;
    $('pr-preco').disabled = !admin && !novo && v.precoPromo != null;
    $('pr-promo-dica').textContent = admin
      ? 'Deixe em branco para vender pelo preço "De". Com valor, o produto aparece também na categoria Promoção do site.'
      : 'Só o administrador coloca ou muda promoção.';
    $('pr-erro').hidden = true;
    $('pr-desc').value = novo ? '' : v.descricao;
    $('pr-est').value = 0;
    $('pr-est-campo').hidden = !novo;
    $('pr-min').value = novo ? 2 : v.minimo;
    $('pr-ativo').checked = novo ? true : v.ativo;
    renderFotosEdit();
    $('dlg-produto').showModal();
  }

  function renderFotosEdit() {
    $('pr-fotos').innerHTML = fotosEdit.map(function (f, i) {
      var ultimo = i === fotosEdit.length - 1;
      return '<li class="pr-foto' + (i === 0 ? ' is-capa' : '') + '">' +
        '<img src="' + esc(f.novo ? f.dataUrl : f.url) + '" alt="Foto ' + (i + 1) + '" data-produto-img />' +
        (i === 0 ? '<span class="pr-foto__capa">Capa</span>' : '') +
        '<div class="pr-foto__bts">' +
          (i > 0 ? '<button type="button" class="cats__bt" data-foto-capa="' + i + '" title="Usar como capa" aria-label="Usar como capa">★</button>' : '') +
          '<button type="button" class="cats__bt" data-foto-mover="' + i + '" data-dir="-1" title="Mover para a esquerda" aria-label="Mover para a esquerda"' + (i === 0 ? ' disabled' : '') + '>◀</button>' +
          '<button type="button" class="cats__bt" data-foto-mover="' + i + '" data-dir="1" title="Mover para a direita" aria-label="Mover para a direita"' + (ultimo ? ' disabled' : '') + '>▶</button>' +
          '<button type="button" class="cats__bt cats__bt--del" data-foto-remover="' + i + '" title="Remover foto" aria-label="Remover foto">✕</button>' +
        '</div>' +
      '</li>';
    }).join('');
    $('pr-fotos-cont').textContent = fotosEdit.length + '/' + MAX_FOTOS;
    var cheio = fotosEdit.length >= MAX_FOTOS;
    $('pr-add-foto').classList.toggle('is-desligado', cheio);
    $('pr-arquivo').disabled = cheio;
    $('pr-add-foto').textContent = cheio ? 'Limite de 4 fotos' : '+ Adicionar fotos';
  }

  $('pr-fotos').addEventListener('click', function (ev) {
    var b = ev.target.closest('button');
    if (!b || b.disabled) return;
    var i, f;
    if (b.hasAttribute('data-foto-capa')) {
      i = Number(b.getAttribute('data-foto-capa'));
      f = fotosEdit.splice(i, 1)[0];
      fotosEdit.unshift(f);
    } else if (b.hasAttribute('data-foto-mover')) {
      i = Number(b.getAttribute('data-foto-mover'));
      var j = i + Number(b.getAttribute('data-dir'));
      f = fotosEdit[i]; fotosEdit[i] = fotosEdit[j]; fotosEdit[j] = f;
    } else if (b.hasAttribute('data-foto-remover')) {
      i = Number(b.getAttribute('data-foto-remover'));
      f = fotosEdit.splice(i, 1)[0];
      if (!f.novo) fotosRemovidas.push(f.id);
    }
    renderFotosEdit();
  });

  function fotosMudaram() {
    return fotosRemovidas.length > 0 ||
      fotosEdit.some(function (f) { return f.novo; }) ||
      fotosEdit.map(function (f) { return f.id; }).join(',') !== ordemOriginal;
  }

  // Reduz a foto para no máximo 1000 px e JPG, para enviar rápido e não pesar no site
  function prepararImagem(arquivo) {
    return new Promise(function (ok, falha) {
      if (!/^image\//.test(arquivo.type)) return falha(new Error('Escolha um arquivo de imagem.'));
      var url = URL.createObjectURL(arquivo);
      var img = new Image();
      img.onload = function () {
        var max = 1000;
        var escala = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        var w = Math.round(img.naturalWidth * escala), h = Math.round(img.naturalHeight * escala);
        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff'; // fundo branco para PNG transparente
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        var dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        ok({ dataUrl: dataUrl, base64: dataUrl.split(',')[1], tipo: 'image/jpeg' });
      };
      img.onerror = function () { URL.revokeObjectURL(url); falha(new Error('Não foi possível ler essa imagem.')); };
      img.src = url;
    });
  }

  $('pr-arquivo').addEventListener('change', function () {
    var arquivos = Array.prototype.slice.call(this.files || []);
    this.value = '';
    if (!arquivos.length) return;
    var vagas = MAX_FOTOS - fotosEdit.length;
    if (arquivos.length > vagas) toast('Cada produto aceita até 4 fotos. ' + (arquivos.length - vagas) + ' foto(s) ficaram de fora.', true);
    arquivos = arquivos.slice(0, Math.max(0, vagas));
    // Uma de cada vez, para manter a ordem escolhida
    arquivos.reduce(function (p, arquivo) {
      return p.then(function () { return prepararImagem(arquivo); })
        .then(function (r) {
          if (fotosEdit.length < MAX_FOTOS) fotosEdit.push({ novo: true, dataUrl: r.dataUrl, base64: r.base64, tipo: r.tipo });
          renderFotosEdit();
        })
        .catch(function (e) { toast(e.message, true); });
    }, Promise.resolve());
  });

  $('btn-novo').addEventListener('click', function () { abrirProduto(null); });

  // Confere De/Por antes de fechar o formulário
  $('form-produto').addEventListener('submit', function (ev) {
    var de = parseFloat($('pr-preco').value), por = $('pr-promo').value.trim();
    var msg = '';
    if (por !== '' && !(parseFloat(por) >= 0)) msg = 'Preço "Por" inválido.';
    else if (por !== '' && parseFloat(por) >= de) msg = 'O preço "Por" precisa ser menor que o preço "De".';
    if (msg) {
      ev.preventDefault();
      $('pr-erro').textContent = msg;
      $('pr-erro').hidden = false;
      $('pr-promo').focus();
    }
  });

  $('dlg-produto').addEventListener('close', function () {
    if (this.returnValue !== 'ok') return;
    var editando = produtoEditando;
    var mudouFotos = fotosMudaram();
    var listaFotos = fotosEdit.slice();
    var removidas = fotosRemovidas.slice();
    var dadosProduto = {
      produto: $('pr-nome').value, categoria: $('pr-cat').value, preco: $('pr-preco').value,
      precoPromo: $('pr-promo').value.trim(),
      descricao: $('pr-desc').value, minimo: $('pr-min').value, ativo: $('pr-ativo').checked,
    };

    var passo;
    if (editando) {
      dadosProduto.idProduto = editando.id;
      passo = api('editar', dadosProduto).then(function (r) { return { r: r, id: editando.id }; });
    } else {
      dadosProduto.estoque = $('pr-est').value;
      passo = api('novoProduto', dadosProduto).then(function (r) { return { r: r, id: r.novoId }; });
    }

    passo
      .then(function (x) {
        aplicar(x.r);
        if (!mudouFotos) return x.id;
        if (listaFotos.some(function (f) { return f.novo; })) toast('Enviando fotos…');
        return api('fotos', { idProduto: x.id, lista: listaFotos, removidas: removidas })
          .then(function (r) { aplicar(r); return x.id; });
      })
      .then(function (id) { toast(editando ? 'Produto ' + id + ' salvo' : 'Produto cadastrado com o ID ' + id); })
      .catch(function (e) { toast(e.message, true); });
  });

  /* ---------- Categorias ---------- */

  function qtdProdutosDaCategoria(nome) {
    return dados.produtos.filter(function (v) { return v.categoria.toLowerCase() === nome.toLowerCase(); }).length;
  }

  var catEditando = null; // nome da categoria sendo renomeada na própria lista

  function renderCategorias() {
    var cats = dados.categorias || [];
    // Se a lista for redesenhada no meio da edição, mantém o que já foi digitado
    var campoAtual = $('lista-cats').querySelector('.cats__input');
    var digitado = campoAtual ? campoAtual.value : null;

    $('lista-cats').innerHTML = cats.length ? cats.map(function (c, i) {
      var qtd = qtdProdutosDaCategoria(c.nome);
      if (c.nome === catEditando) {
        return '<li class="cats__editando" data-cat="' + esc(c.nome) + '">' +
          '<input class="inp cats__input" maxlength="40" value="' + esc(digitado != null ? digitado : c.nome) + '" aria-label="Novo nome da categoria" />' +
          '<button type="button" class="cats__bt cats__bt--ok" data-acao="salvar-nome" aria-label="Salvar nome" title="Salvar (Enter)">✓</button>' +
          '<button type="button" class="cats__bt" data-acao="cancelar-nome" aria-label="Cancelar" title="Cancelar (Esc)">✕</button>' +
          '<span class="cats__dica">Os produtos dessa categoria acompanham o novo nome.</span>' +
        '</li>';
      }
      if (c.fixa) {
        // Categoria fixa "Promoção": não renomeia nem exclui; só o admin oculta/mostra
        var qtdPromo = dados.produtos.filter(function (v) { return v.precoPromo != null && v.ativo; }).length;
        return '<li class="cats__fixa' + (c.ativa ? '' : ' inativa') + '" data-cat="' + esc(c.nome) + '">' +
          '<span class="cats__nome">' + esc(c.nome) + ' <span class="cats__selo">fixa</span></span>' +
          '<span class="cats__qtd">' + qtdPromo + ' em promoção</span>' +
          '<button type="button" class="cats__bt" data-acao="subir" aria-label="Subir"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
          '<button type="button" class="cats__bt" data-acao="descer" aria-label="Descer"' + (i === cats.length - 1 ? ' disabled' : '') + '>↓</button>' +
          '<button type="button" class="cats__bt" data-acao="ativar" aria-label="' + (c.ativa ? 'Ocultar' : 'Mostrar') + '" title="' +
            (souAdmin() ? (c.ativa ? 'Ocultar do site' : 'Mostrar no site') : 'Só o administrador oculta ou mostra') + '"' +
            (souAdmin() ? '' : ' disabled') + '>' + (c.ativa ? '●' : '○') + '</button>' +
        '</li>';
      }
      return '<li class="' + (c.ativa ? '' : 'inativa') + '" data-cat="' + esc(c.nome) + '">' +
        '<span class="cats__nome">' + esc(c.nome) + '</span>' +
        '<span class="cats__qtd">' + qtd + (qtd === 1 ? ' produto' : ' produtos') + '</span>' +
        '<button type="button" class="cats__bt" data-acao="subir" aria-label="Subir"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
        '<button type="button" class="cats__bt" data-acao="descer" aria-label="Descer"' + (i === cats.length - 1 ? ' disabled' : '') + '>↓</button>' +
        '<button type="button" class="cats__bt" data-acao="renomear" aria-label="Renomear" title="Renomear">✎</button>' +
        '<button type="button" class="cats__bt" data-acao="ativar" aria-label="' + (c.ativa ? 'Desativar' : 'Ativar') + '" title="' + (c.ativa ? 'Desativar (some do site)' : 'Ativar') + '">' + (c.ativa ? '●' : '○') + '</button>' +
        '<button type="button" class="cats__bt cats__bt--del" data-acao="excluir" aria-label="Excluir" title="Excluir"' + (qtd ? ' disabled' : '') + '>✕</button>' +
      '</li>';
    }).join('') : '<li>Nenhuma categoria ainda.</li>';

    var campo = $('lista-cats').querySelector('.cats__input');
    if (campo && digitado == null) { campo.focus(); campo.select(); }
  }

  function cancelarRenomear() {
    catEditando = null;
    renderCategorias();
  }

  function salvarRenomear() {
    var campo = $('lista-cats').querySelector('.cats__input');
    if (!campo || !catEditando) return;
    var antigo = catEditando;
    var novo = campo.value.trim();
    if (!novo) { toast('Digite o nome da categoria.', true); campo.focus(); return; }
    if (novo === antigo) { cancelarRenomear(); return; }
    campo.disabled = true;
    api('categoriaSalvar', { nome: novo, antigo: antigo })
      .then(function (r) {
        catEditando = null;
        aplicar(r);
        renderCategorias();
        toast('Categoria renomeada');
      })
      .catch(function (e) {
        // Continua editando para a pessoa corrigir (ex.: nome repetido)
        campo.disabled = false;
        campo.focus();
        toast(e.message, true);
      });
  }

  function acaoCategoria(acao, dadosAcao, msg) {
    return api(acao, dadosAcao)
      .then(function (r) { aplicar(r); renderCategorias(); if (msg) toast(msg); })
      .catch(function (e) { toast(e.message, true); });
  }

  $('btn-categorias').addEventListener('click', function () {
    renderCategorias();
    $('cat-nova').value = '';
    $('dlg-categorias').showModal();
  });

  $('lista-cats').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-acao]');
    if (!b || b.disabled) return;
    var nome = b.closest('[data-cat]').getAttribute('data-cat');
    var c = (dados.categorias || []).filter(function (x) { return x.nome === nome; })[0];
    var acao = b.getAttribute('data-acao');
    if (acao === 'subir' || acao === 'descer') {
      acaoCategoria('categoriaMover', { nome: nome, direcao: acao === 'subir' ? -1 : 1 });
    } else if (acao === 'renomear') {
      catEditando = nome;
      $('lista-cats').innerHTML = ''; // começa a edição com o nome atual
      renderCategorias();
    } else if (acao === 'salvar-nome') {
      salvarRenomear();
    } else if (acao === 'cancelar-nome') {
      cancelarRenomear();
    } else if (acao === 'ativar') {
      acaoCategoria('categoriaAtivar', { nome: nome, ativa: !c.ativa }, c.ativa ? 'Categoria desativada (fora do site)' : 'Categoria ativada');
    } else if (acao === 'excluir') {
      if (window.confirm('Excluir a categoria "' + nome + '"?')) acaoCategoria('categoriaExcluir', { nome: nome }, 'Categoria excluída');
    }
  });

  // Enter salva, Esc cancela (sem fechar a janela de categorias)
  $('lista-cats').addEventListener('keydown', function (e) {
    if (!e.target.classList.contains('cats__input')) return;
    if (e.key === 'Enter') { e.preventDefault(); salvarRenomear(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelarRenomear(); }
  });

  $('dlg-categorias').addEventListener('cancel', function (e) {
    if (catEditando) { e.preventDefault(); cancelarRenomear(); }
  });

  $('dlg-categorias').addEventListener('close', function () { catEditando = null; });

  function adicionarCategoria() {
    var nome = $('cat-nova').value.trim();
    if (!nome) return;
    acaoCategoria('categoriaSalvar', { nome: nome }, 'Categoria criada').then(function () { $('cat-nova').value = ''; });
  }

  $('cat-adicionar').addEventListener('click', adicionarCategoria);
  $('cat-nova').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); adicionarCategoria(); }
  });

  /* ================= Usuários (só administrador) ================= */

  function souAdmin() { return !!(dados.eu && dados.eu.perfil === 'admin'); }

  function renderUsuarios() {
    var eu = dados.eu || {};
    $('top-usuario').textContent = eu.nome || eu.email || '';
    $('tab-btn-usuarios').hidden = !souAdmin();
    if (!souAdmin()) {
      // Perdeu o perfil de admin com a aba aberta: volta para Pedidos
      if (!$('tab-usuarios').hidden) document.querySelector('.tab[data-tab="pedidos"]').click();
      return;
    }

    var lista = (dados.usuarios || []).slice().sort(function (a, b) {
      return (a.nome || a.email).localeCompare(b.nome || b.email, 'pt-BR');
    });
    $('lista-usuarios').innerHTML = lista.length
      ? '<div class="grupo"><div class="grupo__head"><h3>Usuários</h3><span>' + lista.length + ' cadastrados</span></div>' +
        '<div class="tabela"><table><thead><tr><th>Nome</th><th class="m-oculta">E-mail</th><th>Perfil</th><th class="m-oculta">Situação</th><th></th></tr></thead><tbody>' +
        lista.map(function (u) {
          var voce = u.user_id === eu.id;
          return '<tr class="' + (u.ativo ? '' : 'us-inativo') + '">' +
            '<td class="nome">' + esc(u.nome || '—') + (voce ? '<span class="us-voce">(você)</span>' : '') +
              '</td>' +
            '<td class="m-oculta">' + esc(u.email) + '</td>' +
            '<td><span class="perfil perfil--' + esc(u.perfil) + '">' + (u.perfil === 'admin' ? 'Admin' : 'Operador') + '</span></td>' +
            '<td class="m-oculta">' + (u.ativo ? 'Ativo' : 'Desativado') + '</td>' +
            '<td class="n"><div class="acoes acoes--usuario">' +
              '<button class="btn btn--sm" data-us-editar="' + esc(u.user_id) + '">Editar</button>' +
              '<button class="btn btn--sm" data-us-senha="' + esc(u.user_id) + '">Senha</button>' +
              (voce ? '' :
                '<button class="btn btn--sm" data-us-ativar="' + esc(u.user_id) + '">' + (u.ativo ? 'Desativar' : 'Ativar') + '</button>' +
                '<button class="btn btn--sm btn--danger" data-us-excluir="' + esc(u.user_id) + '">Excluir</button>') +
            '</div></td></tr>';
        }).join('') + '</tbody></table></div></div>'
      : '<p class="vazio">Nenhum usuário.</p>';
  }

  function usuarioPorId(id) {
    return (dados.usuarios || []).filter(function (u) { return u.user_id === id; })[0] || null;
  }

  // Botões "Voltar" dos diálogos de usuário
  document.querySelectorAll('[data-fechar-dlg]').forEach(function (b) {
    b.addEventListener('click', function () { b.closest('dialog').close(); });
  });

  function mostrarErro(id, msg) {
    $(id).textContent = msg;
    $(id).hidden = !msg;
  }

  // Executa a ação na Edge Function; se der certo fecha o diálogo, se der errado mostra o erro nele
  function executarUsuario(dialogo, idErro, botao, corpo, msgOk) {
    mostrarErro(idErro, '');
    botao.disabled = true;
    api('usuario', corpo)
      .then(function (r) {
        aplicar(r);
        $(dialogo).close();
        toast(msgOk);
      })
      .catch(function (e) { mostrarErro(idErro, e.message); })
      .finally(function () { botao.disabled = false; });
  }

  var usuarioAtual = null; // null = novo

  function abrirUsuario(u) {
    usuarioAtual = u;
    var novo = !u;
    $('us-titulo').textContent = novo ? 'Novo usuário' : 'Editar usuário';
    $('us-sub').textContent = novo ? 'A pessoa entra no Gestor com este e-mail e esta senha.' : u.email;
    $('us-nome').value = novo ? '' : u.nome;
    $('us-email').value = '';
    $('us-senha').value = '';
    $('us-email-campo').hidden = !novo;
    $('us-senha-campo').hidden = !novo;
    $('us-email').required = novo;
    $('us-senha').required = novo;
    $('us-perfil').value = novo ? 'operador' : u.perfil;
    $('us-perfil').disabled = !novo && u.user_id === (dados.eu || {}).id; // não tira o próprio admin
    mostrarErro('us-erro', '');
    $('dlg-usuario').showModal();
  }

  $('btn-novo-usuario').addEventListener('click', function () { abrirUsuario(null); });

  $('form-usuario').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var corpo = usuarioAtual
      ? { acao: 'editar', id: usuarioAtual.user_id, nome: $('us-nome').value, perfil: $('us-perfil').value }
      : { acao: 'criar', nome: $('us-nome').value, email: $('us-email').value, senha: $('us-senha').value, perfil: $('us-perfil').value };
    executarUsuario('dlg-usuario', 'us-erro', $('us-salvar'), corpo, usuarioAtual ? 'Usuário atualizado' : 'Usuário cadastrado');
  });

  $('form-senha').addEventListener('submit', function (ev) {
    ev.preventDefault();
    if ($('se-senha').value !== $('se-senha2').value) { mostrarErro('se-erro', 'As duas senhas não são iguais.'); return; }
    executarUsuario('dlg-senha', 'se-erro', $('se-salvar'),
      { acao: 'senha', id: usuarioAtual.user_id, senha: $('se-senha').value }, 'Senha alterada');
  });

  $('form-excluir-usuario').addEventListener('submit', function (ev) {
    ev.preventDefault();
    executarUsuario('dlg-excluir-usuario', 'ex-erro', $('ex-confirmar'),
      { acao: 'excluir', id: usuarioAtual.user_id }, 'Usuário excluído');
  });

  $('lista-usuarios').addEventListener('click', function (ev) {
    var b = ev.target.closest('button');
    if (!b) return;
    var id = b.getAttribute('data-us-editar') || b.getAttribute('data-us-senha') || b.getAttribute('data-us-ativar') || b.getAttribute('data-us-excluir');
    var u = usuarioPorId(id);
    if (!u) return;
    usuarioAtual = u;

    if (b.hasAttribute('data-us-editar')) abrirUsuario(u);

    if (b.hasAttribute('data-us-senha')) {
      $('se-sub').textContent = (u.nome || u.email) + ' · ' + u.email;
      $('se-senha').value = '';
      $('se-senha2').value = '';
      mostrarErro('se-erro', '');
      $('dlg-senha').showModal();
    }

    if (b.hasAttribute('data-us-excluir')) {
      $('ex-sub').textContent = 'Excluir ' + (u.nome || u.email) + ' (' + u.email + ')? A pessoa perde o acesso ao Gestor. O histórico de pedidos e estoque continua.';
      mostrarErro('ex-erro', '');
      $('dlg-excluir-usuario').showModal();
    }

    if (b.hasAttribute('data-us-ativar')) {
      b.disabled = true;
      api('usuario', { acao: 'ativar', id: u.user_id, ativo: !u.ativo })
        .then(function (r) { aplicar(r); toast(u.ativo ? 'Usuário desativado: não consegue mais entrar' : 'Usuário ativado'); })
        .catch(function (e) { toast(e.message, true); b.disabled = false; });
    }
  });

  /* ================= Histórico ================= */

  function renderMovs() {
    var q = $('busca-movs').value.trim().toLowerCase();
    var lista = dados.movs.filter(function (m) {
      return !q || (m.idProduto + ' ' + m.produto + ' ' + m.tipo + ' ' + m.ref + ' ' + m.obs).toLowerCase().indexOf(q) >= 0;
    });
    $('lista-movs').innerHTML = lista.length ? lista.map(function (m) {
      return '<tr><td>' + dataHora(m.data) + '</td><td class="id">' + esc(m.idProduto) + '</td><td>' + esc(m.produto) + '</td>' +
        '<td>' + esc(m.tipo) + '</td><td class="n ' + (m.qtd > 0 ? 'pos' : 'neg') + '">' + (m.qtd > 0 ? '+' : '') + m.qtd + '</td>' +
        '<td class="n">' + m.estoqueApos + '</td><td>' + esc(m.ref) + '</td><td>' + esc(m.obs) + '</td></tr>';
    }).join('') : '<tr><td colspan="8" class="vazio">Sem movimentações.</td></tr>';
  }
  $('busca-movs').addEventListener('input', renderMovs);

  /* ================= Tudo ================= */

  function renderTudo() {
    preencherAnos();
    renderPedidos();
    renderEstoque();
    renderMovs();
    renderUsuarios();
    var pend = dados.pedidos.filter(function (p) { return p.status === 'Pendente'; }).length;
    var baixo = dados.produtos.filter(function (v) { var e = estadoVar(v); return e === 'baixo' || e === 'zero'; }).length;
    $('n-pend').textContent = pend;
    $('n-pend').hidden = !pend;
    $('n-baixo').textContent = baixo;
    $('n-baixo').hidden = !baixo;
  }
})();
