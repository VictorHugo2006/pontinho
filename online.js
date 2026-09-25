/* ===================================================================== *
 * Pontinho Online — MVP (Fase 1)                                          *
 * Mesa entre amigos, na confiança. Cada um joga do seu celular.          *
 * Ainda NÃO confere as regras (a galera confere na tela).                *
 * Usa o Firebase já configurado (fbDB, myUid, cloudReady do app.js).     *
 * Modelo de dados:                                                        *
 *   mesas/{code}                → estado compartilhado (monte, descarte,  *
 *                                 jogos baixados, vez, coringa, status)   *
 *   mesas/{code}/maos/{uid}     → a mão privada de cada jogador           *
 *                                 (só o dono LÊ; qualquer um ESCREVE p/   *
 *                                  o host conseguir distribuir)           *
 * ===================================================================== */

const ONLINE = { code: null, mesa: null, mao: null, unsubMesa: null, unsubMao: null, sel: [], ordem: null };

const ON_NAIPES = ['♠', '♣', '♥', '♦']; // ♠ ♣ ♥ ♦
const ON_VALORES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const ON_RANK = { 'A': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13 };
const ON_NAIPE_ORD = { '♠': 0, '♥': 1, '♦': 2, '♣': 3 }; // ♠ ♥ ♦ ♣

function onCartaVermelha(s) { return s === '♥' || s === '♦'; }

// Reordena uma cópia da mão para exibição (não altera o que está salvo)
function onOrdenaMao(cartas) {
  const cs = cartas.slice();
  if (ONLINE.ordem === 'naipe') {
    cs.sort((a, b) => (ON_NAIPE_ORD[a.s] - ON_NAIPE_ORD[b.s]) || (ON_RANK[a.r] - ON_RANK[b.r]));
  } else if (ONLINE.ordem === 'valor') {
    cs.sort((a, b) => (ON_RANK[a.r] - ON_RANK[b.r]) || (ON_NAIPE_ORD[a.s] - ON_NAIPE_ORD[b.s]));
  }
  return cs;
}

// Dois baralhos de 52 = 104 cartas, cada uma com id único
function onBaralho() {
  const cs = [];
  for (let d = 0; d < 2; d++)
    for (const s of ON_NAIPES)
      for (const r of ON_VALORES)
        cs.push({ r, s, id: `${r}${s}_${d}_${Math.random().toString(36).slice(2, 7)}` });
  return cs;
}
function onEmbaralha(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function onNome() { try { return localStorage.getItem('pontinho:nome') || ''; } catch (_) { return ''; } }
function onSetNome(n) { try { localStorage.setItem('pontinho:nome', n); } catch (_) {} }
function onGeraCodigo() { const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; for (let i = 0; i < 4; i++) s += c[Math.floor(Math.random() * c.length)]; return s; }

function onMesaRef(code) { return fbDB.collection('mesas').doc(code); }
function onMaoRef(code, uid) { return fbDB.collection('mesas').doc(code).collection('maos').doc(uid); }

function onLimpaSubs() {
  if (ONLINE.unsubMesa) { ONLINE.unsubMesa(); ONLINE.unsubMesa = null; }
  if (ONLINE.unsubMao) { ONLINE.unsubMao(); ONLINE.unsubMao = null; }
  if (ONLINE._tick) { clearInterval(ONLINE._tick); ONLINE._tick = null; }
}
// Segundos restantes da janela de 30s para todos entrarem
const ON_ESPERA_SEG = 30;
function onEsperaRestante() {
  const m = ONLINE.mesa;
  if (!m || !m.criadoEm) return 0;
  return Math.max(0, ON_ESPERA_SEG - Math.floor((Date.now() - m.criadoEm) / 1000));
}
function onTick() {
  const m = ONLINE.mesa;
  if (!m || m.status !== 'aguardando') return;
  const restante = onEsperaRestante();
  // Ao zerar, o host começa automaticamente se já tiver 2+ jogadores
  if (restante <= 0 && m.hostUid === myUid && (m.jogadores || []).length >= 2 && !ONLINE._iniciando) {
    ONLINE._iniciando = true;
    onIniciar();
    return;
  }
  if (currentScreen === 'online') renderOnline();
}
function onEntrarSub(code) {
  onLimpaSubs();
  ONLINE.code = code; ONLINE.sel = []; ONLINE.mesa = null; ONLINE.mao = null; ONLINE._iniciando = false;
  ONLINE._tick = setInterval(onTick, 1000);
  ONLINE.unsubMesa = onMesaRef(code).onSnapshot(
    s => { ONLINE.mesa = s.exists ? s.data() : null; onReportarPontos(); if (currentScreen === 'online') renderOnline(); },
    e => { console.warn('mesa snap', e); toast('Erro de conexão (veja as Regras do Firestore)'); }
  );
  ONLINE.unsubMao = onMaoRef(code, myUid).onSnapshot(
    s => { ONLINE.mao = s.exists ? s.data() : null; if (currentScreen === 'online') renderOnline(); },
    e => { console.warn('mao snap', e); }
  );
  currentScreen = 'online'; render();
}
function onSairMesa() { onLimpaSubs(); ONLINE.code = null; ONLINE.mesa = null; ONLINE.mao = null; ONLINE.sel = []; currentScreen = 'home'; render(); }

/* ------------------------------ Lobby ---------------------------------- */
async function onCriarMesa() {
  const nome = (document.getElementById('on-nome')?.value || onNome()).trim();
  if (!nome) { toast('Digite seu nome'); return; }
  onSetNome(nome);
  if (!cloudReady || !myUid) { toast('Sem conexão com a nuvem'); return; }
  const code = onGeraCodigo();
  try {
    await onMesaRef(code).set({
      status: 'aguardando', hostUid: myUid, criadoEm: Date.now(),
      jogadores: [{ uid: myUid, nome }], coringa: null,
      monte: [], descarte: [], mesaJogos: [], turno: null, fase: 'comprar', vencedor: null,
    });
    onEntrarSub(code);
  } catch (e) { console.warn(e); toast('Não foi possível criar (Regras do Firestore?)'); }
}

async function onEntrarMesa() {
  const nome = (document.getElementById('on-nome')?.value || onNome()).trim();
  const code = (document.getElementById('on-code')?.value || '').trim().toUpperCase();
  if (!nome) { toast('Digite seu nome'); return; }
  if (code.length < 4) { toast('Código inválido'); return; }
  onSetNome(nome);
  try {
    const snap = await onMesaRef(code).get();
    if (!snap.exists) { toast('Mesa não encontrada'); return; }
    const m = snap.data();
    if (m.status !== 'aguardando') { toast('Essa mesa já começou'); return; }
    if (!m.jogadores.some(j => j.uid === myUid)) {
      if (m.jogadores.length >= 8) { toast('Mesa cheia'); return; }
      await onMesaRef(code).update({ jogadores: [...m.jogadores, { uid: myUid, nome }] });
    }
    onEntrarSub(code);
  } catch (e) { console.warn(e); toast('Não foi possível entrar'); }
}

/* --------------------------- Iniciar / distribuir ---------------------- */
async function onIniciar() {
  const m = ONLINE.mesa, code = ONLINE.code; if (!m) return;
  if (m.hostUid !== myUid) { toast('Só quem criou a mesa inicia'); return; }
  if (m.jogadores.length < 2) { toast('Precisa de pelo menos 2 jogadores'); return; }
  const deck = onEmbaralha(onBaralho());
  const coringa = deck.pop();                 // vira 1 carta = indicador do coringa
  const maos = {};
  m.jogadores.forEach(j => { maos[j.uid] = deck.splice(0, 9); });
  const primeiro = m.jogadores[Math.floor(Math.random() * m.jogadores.length)].uid;
  const maosCount = {}; m.jogadores.forEach(j => { maosCount[j.uid] = 9; });
  // Acumula os pontos da mão anterior no total da partida
  const totaisAntes = m.pontosTotais || {};
  const ph = m.pontosHand || {};
  const pontosTotais = {};
  m.jogadores.forEach(j => { pontosTotais[j.uid] = (totaisAntes[j.uid] || 0) + (ph[j.uid] || 0); });
  try {
    const batch = fbDB.batch();
    m.jogadores.forEach(j => batch.set(onMaoRef(code, j.uid), { cartas: maos[j.uid] }));
    batch.update(onMesaRef(code), {
      status: 'jogando', coringa, monte: deck, descarte: [], lixo: [], mesaJogos: [],
      turno: primeiro, fase: 'comprar', vencedor: null, maosCount,
      pontosTotais, pontosHand: {}, pulgas: [], ultimaQueima: null,
    });
    await batch.commit();
    ONLINE.sel = [];
  } catch (e) { console.warn(e); toast('Erro ao distribuir'); }
}

/* ------------------------------ Jogadas -------------------------------- */
function onMinhaVez() { return ONLINE.mesa && ONLINE.mesa.status === 'jogando' && ONLINE.mesa.turno === myUid; }

async function onComprar(origem) { // 'monte' | 'descarte'
  const m = ONLINE.mesa, code = ONLINE.code;
  if (!onMinhaVez()) { toast('Não é sua vez'); return; }
  if (m.fase !== 'comprar') { toast('Você já comprou — agora descarte'); return; }
  let carta, campo, valor;
  if (origem === 'monte') {
    if (!m.monte.length) { toast('Monte vazio'); return; }
    const monte = [...m.monte]; carta = monte.pop(); campo = 'monte'; valor = monte;
  } else {
    if (!m.descarte.length) { toast('Descarte vazio'); return; }
    const d = [...m.descarte]; carta = d.pop(); campo = 'descarte'; valor = d;
  }
  const mao = [...((ONLINE.mao && ONLINE.mao.cartas) || []), carta];
  const maosCount = { ...(m.maosCount || {}), [myUid]: mao.length };
  // Atualiza a tela na hora (otimista)
  ONLINE.mesa = { ...m, [campo]: valor, fase: 'descartar', maosCount };
  ONLINE.mao = { cartas: mao };
  renderOnline();
  try {
    const batch = fbDB.batch();
    batch.update(onMesaRef(code), { [campo]: valor, fase: 'descartar', maosCount });
    batch.set(onMaoRef(code, myUid), { cartas: mao });
    await batch.commit();
  } catch (e) { console.warn(e); toast('Erro ao comprar'); }
}

async function onBaixar() {
  const m = ONLINE.mesa, code = ONLINE.code;
  if (!onMinhaVez()) { toast('Não é sua vez'); return; }
  if (!ONLINE.sel.length) { toast('Selecione as cartas para baixar'); return; }
  const selIds = new Set(ONLINE.sel);
  const mao = (ONLINE.mao && ONLINE.mao.cartas) || [];
  const baixadas = mao.filter(c => selIds.has(c.id));
  const resto = mao.filter(c => !selIds.has(c.id));
  const bateu = resto.length === 0; // baixou tudo = bateu (com as 10)
  // Coringa na ponta é permitido quando está batendo (sobra 0 ou 1 carta pra descartar)
  const val = onJogoValido(baixadas, m.coringa, resto.length <= 1);
  if (!val.ok) { toast(val.msg); return; }
  const jogos = [...(m.mesaJogos || []), { id: 'j' + Date.now(), dono: myUid, cartas: onArrumaJogo(baixadas, m.coringa) }];
  const maosCount = { ...(m.maosCount || {}), [myUid]: resto.length };
  const extra = bateu ? { status: 'encerrada', vencedor: myUid } : {};
  ONLINE.sel = [];
  ONLINE.mesa = { ...m, mesaJogos: jogos, maosCount, ...extra };
  ONLINE.mao = { cartas: resto };
  renderOnline();
  if (bateu) toast('Você bateu! 🎉');
  try {
    const batch = fbDB.batch();
    batch.set(onMaoRef(code, myUid), { cartas: resto });
    batch.update(onMesaRef(code), { mesaJogos: jogos, maosCount, ...extra });
    await batch.commit();
  } catch (e) { console.warn(e); toast('Erro ao baixar'); }
}

async function onDescartar() {
  const m = ONLINE.mesa, code = ONLINE.code;
  if (!onMinhaVez()) { toast('Não é sua vez'); return; }
  if (m.fase !== 'descartar') { toast('Compre uma carta primeiro'); return; }
  if (ONLINE.sel.length !== 1) { toast('Selecione 1 carta para descartar'); return; }
  const cid = ONLINE.sel[0];
  const mao = (ONLINE.mao && ONLINE.mao.cartas) || [];
  const carta = mao.find(c => c.id === cid); if (!carta) return;
  if (onEhCoringa(carta, m.coringa)) { toast('Não pode jogar o coringa fora'); return; }
  const resto = mao.filter(c => c.id !== cid);
  const idx = m.jogadores.findIndex(j => j.uid === myUid);
  const prox = m.jogadores[(idx + 1) % m.jogadores.length].uid;
  const descarte = [...(m.descarte || []), carta];
  const maosCount = { ...(m.maosCount || {}), [myUid]: resto.length };
  const bateu = resto.length === 0; // descartou a última = bateu (sobrou 1)
  const upd = bateu
    ? { descarte, maosCount, status: 'encerrada', vencedor: myUid }
    : { descarte, turno: prox, fase: 'comprar', maosCount };
  ONLINE.sel = [];
  ONLINE.mesa = { ...m, ...upd };
  ONLINE.mao = { cartas: resto };
  renderOnline();
  if (bateu) toast('Você bateu! 🎉');
  try {
    const batch = fbDB.batch();
    batch.set(onMaoRef(code, myUid), { cartas: resto });
    batch.update(onMesaRef(code), upd);
    await batch.commit();
  } catch (e) { console.warn(e); toast('Erro ao descartar'); }
}

async function onBati() {
  const code = ONLINE.code;
  if (!onMinhaVez()) { toast('Só dá pra bater na sua vez'); return; }
  try { await onMesaRef(code).update({ status: 'encerrada', vencedor: myUid }); }
  catch (e) { console.warn(e); toast('Erro ao bater'); }
}

// Curingas = as duas cartas do mesmo valor, na COR OPOSTA à carta virada
function onCuringas(cor) {
  if (!cor) return [];
  return onCartaVermelha(cor.s)
    ? [{ r: cor.r, s: '♠' }, { r: cor.r, s: '♣' }]  // virou vermelha → pretos
    : [{ r: cor.r, s: '♥' }, { r: cor.r, s: '♦' }]; // virou preta → vermelhos
}

// Uma carta é coringa se tem o valor da carta virada e a COR OPOSTA
function onEhCoringa(c, cor) {
  return !!cor && c.r === cor.r && (onCartaVermelha(c.s) !== onCartaVermelha(cor.s));
}
// Sequência: valores (mesmo naipe) sem repetir + coringas preenchem os buracos.
// bater=true permite coringa sobrando nas PONTAS; bater=false exige coringa só no MEIO (meiota).
function onSeqOk(ranks, nCoringas, bater) {
  if (new Set(ranks).size !== ranks.length) return false;
  const span = ranks[ranks.length - 1] - ranks[0] + 1;
  if (span > 13) return false;
  const buracos = span - ranks.length;
  return bater ? (nCoringas >= buracos) : (nCoringas === buracos);
}
// Valida um jogo: trinca (3-4 iguais, naipes diferentes, sem coringa) ou sequência (mesmo naipe em ordem, coringa preenche)
function onJogoValido(cartas, cor, bater) {
  if (!cartas || cartas.length < 3) return { ok: false, msg: 'Um jogo tem no mínimo 3 cartas' };
  const coringas = cartas.filter(c => onEhCoringa(c, cor));
  const normais = cartas.filter(c => !onEhCoringa(c, cor));
  // Trinca
  if (coringas.length === 0 && cartas.length <= 4
    && new Set(cartas.map(c => c.r)).size === 1
    && new Set(cartas.map(c => c.s)).size === cartas.length) {
    return { ok: true, tipo: 'trinca' };
  }
  // Sequência (precisa de pelo menos 1 carta normal para definir o naipe)
  if (normais.length >= 1 && new Set(normais.map(c => c.s)).size === 1) {
    const low = normais.map(c => ON_RANK[c.r]).sort((a, b) => a - b);
    if (onSeqOk(low, coringas.length, bater)) return { ok: true, tipo: 'sequencia' };
    if (normais.some(c => c.r === 'A')) { // tenta Ás alto (A depois do K)
      const high = normais.map(c => c.r === 'A' ? 14 : ON_RANK[c.r]).sort((a, b) => a - b);
      if (onSeqOk(high, coringas.length, bater)) return { ok: true, tipo: 'sequencia' };
    }
  }
  const msg = coringas.length ? 'Ao baixar, o coringa só vale no meio (nas pontas só pra bater)' : 'Não é uma trinca nem sequência válida';
  return { ok: false, msg };
}

// Arruma a ordem de exibição do jogo (sequência ordenada, coringas nos buracos)
// Detecta Ás alto (J-Q-K-A) vs Ás baixo (A-2-3).
function onArrumaJogo(cartas, cor) {
  const v = onJogoValido(cartas, cor, true);
  if (!v.ok || v.tipo === 'trinca') return cartas;
  const coringas = cartas.filter(c => onEhCoringa(c, cor));
  const normais = cartas.filter(c => !onEhCoringa(c, cor));
  const rankOf = (c, aceHigh) => (c.r === 'A' ? (aceHigh ? 14 : 1) : ON_RANK[c.r]);
  // decide se o Ás é alto: se com Ás=1 não fecha, tenta Ás=14
  let aceHigh = false;
  const low = normais.map(c => rankOf(c, false)).sort((a, b) => a - b);
  if (!onSeqOk(low, coringas.length, true) && normais.some(c => c.r === 'A')) {
    const high = normais.map(c => rankOf(c, true)).sort((a, b) => a - b);
    if (onSeqOk(high, coringas.length, true)) aceHigh = true;
  }
  const sorted = normais.slice().sort((a, b) => rankOf(a, aceHigh) - rankOf(b, aceHigh));
  const out = []; let ci = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0) {
      let gap = rankOf(sorted[i], aceHigh) - rankOf(sorted[i - 1], aceHigh) - 1;
      while (gap-- > 0 && ci < coringas.length) out.push(coringas[ci++]);
    }
    out.push(sorted[i]);
  }
  while (ci < coringas.length) out.push(coringas[ci++]); // coringa que sobra estende a ponta
  return out;
}

// Encaixa as cartas selecionadas num jogo já baixado (se continuar válido)
async function onEncaixar(groupId) {
  const m = ONLINE.mesa, code = ONLINE.code;
  if (!onMinhaVez()) { toast('Não é sua vez'); return; }
  if (!ONLINE.sel.length) { toast('Selecione as cartas para encaixar'); return; }
  const selIds = new Set(ONLINE.sel);
  const mao = (ONLINE.mao && ONLINE.mao.cartas) || [];
  const add = mao.filter(c => selIds.has(c.id));
  const jogos = (m.mesaJogos || []).map(g => ({ ...g, cartas: [...g.cartas] }));
  const g = jogos.find(x => x.id === groupId); if (!g) return;

  let novaMao = mao.filter(c => !selIds.has(c.id)); // mão sem as selecionadas
  let lixoUpd = null, msg = '', done = false;

  // 1) Encaixe normal (coringa na ponta liberado quando está batendo — sobra 0 ou 1)
  {
    const combinado = [...g.cartas, ...add];
    if (onJogoValido(combinado, m.coringa, novaMao.length <= 1).ok) {
      g.cartas = onArrumaJogo(combinado, m.coringa);
      msg = 'Encaixou!'; done = true;
    }
  }
  // 2) Roubar o coringa: sua carta real ocupa o lugar de um coringa; o coringa volta pra sua mão
  if (!done && add.length >= 1) {
    for (let k = 0; k < g.cartas.length && !done; k++) {
      if (!onEhCoringa(g.cartas[k], m.coringa)) continue;
      const novo = g.cartas.slice(); const cor1 = novo.splice(k, 1)[0]; novo.push(...add);
      if (onJogoValido(novo, m.coringa, false).ok) {
        g.cartas = onArrumaJogo(novo, m.coringa);
        novaMao = [...novaMao, cor1]; // coringa volta pra mão (obrigatório usá-lo depois)
        msg = 'Roubou o coringa! 🃏 Agora baixe ele.'; done = true;
      }
    }
  }
  // 3) Queima: jogo é trinca e as cartas têm o MESMO valor (carta morta) → vai pro monte
  let queimaInfo = null;
  if (!done) {
    const gTipo = onJogoValido(g.cartas, m.coringa, true).tipo;
    const rankTrinca = g.cartas[0] && g.cartas[0].r;
    if (gTipo === 'trinca' && add.every(c => c.r === rankTrinca)) {
      lixoUpd = [...(m.lixo || []), ...add];
      queimaInfo = { uid: myUid, cartas: add.map(c => ({ r: c.r, s: c.s })) };
      msg = 'Queimou! 🔥'; done = true;
    }
  }
  if (!done) {
    const temCoringaSel = add.some(c => onEhCoringa(c, m.coringa));
    toast(temCoringaSel ? 'Coringa não entra em trinca — toque numa sequência' : 'Não encaixa aqui: coringa só no meio (ponta só pra bater)');
    return;
  }

  const maosCount = { ...(m.maosCount || {}), [myUid]: novaMao.length };
  const bateu = novaMao.length === 0;
  const extra = bateu ? { status: 'encerrada', vencedor: myUid } : {};
  const upd = { mesaJogos: jogos, maosCount, ...extra };
  if (lixoUpd) upd.lixo = lixoUpd;
  if (queimaInfo) upd.ultimaQueima = queimaInfo;

  ONLINE.sel = [];
  ONLINE.mesa = { ...m, ...upd };
  ONLINE.mao = { cartas: novaMao };
  renderOnline();
  if (bateu) toast('Você bateu! 🎉'); else toast(msg);
  try {
    const batch = fbDB.batch();
    batch.set(onMaoRef(code, myUid), { cartas: novaMao });
    batch.update(onMesaRef(code), upd);
    await batch.commit();
  } catch (e) { console.warn(e); toast('Erro na jogada'); }
}

// Queimar (lixo): tira 1 carta selecionada da mão e joga fora de jogo
async function onQueimar() {
  const m = ONLINE.mesa, code = ONLINE.code;
  if (!onMinhaVez()) { toast('Não é sua vez'); return; }
  if (ONLINE.sel.length !== 1) { toast('Selecione 1 carta para queimar'); return; }
  const cid = ONLINE.sel[0];
  const mao = (ONLINE.mao && ONLINE.mao.cartas) || [];
  const carta = mao.find(c => c.id === cid); if (!carta) return;
  const resto = mao.filter(c => c.id !== cid);
  const lixo = [...(m.lixo || []), carta];
  const maosCount = { ...(m.maosCount || {}), [myUid]: resto.length };
  const bateu = resto.length === 0;
  const extra = bateu ? { status: 'encerrada', vencedor: myUid } : {};
  ONLINE.sel = [];
  ONLINE.mesa = { ...m, lixo, maosCount, ...extra };
  ONLINE.mao = { cartas: resto };
  renderOnline();
  if (bateu) toast('Você bateu! 🎉'); else toast('Carta queimada');
  try {
    const batch = fbDB.batch();
    batch.set(onMaoRef(code, myUid), { cartas: resto });
    batch.update(onMesaRef(code), { lixo, maosCount, ...extra });
    await batch.commit();
  } catch (e) { console.warn(e); toast('Erro ao queimar'); }
}

/* ------------------------------ Render --------------------------------- */
function onCardEl(c, onClick) {
  const cls = onCartaVermelha(c.s) ? 'red' : 'black';
  const sel = ONLINE.sel.includes(c.id) ? 'sel' : '';
  const b = el(`<button class="oncard ${cls} ${sel}">${c.r}<span class="np">${c.s}</span></button>`);
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

// Ordena a mão de UMA vez (naipe ou sequência) e salva — não é ordem fixa
function onOrdenarMao(modo) {
  const cs = ((ONLINE.mao && ONLINE.mao.cartas) || []).slice();
  if (modo === 'naipe') cs.sort((a, b) => (ON_NAIPE_ORD[a.s] - ON_NAIPE_ORD[b.s]) || (ON_RANK[a.r] - ON_RANK[b.r]));
  else cs.sort((a, b) => (ON_RANK[a.r] - ON_RANK[b.r]) || (ON_NAIPE_ORD[a.s] - ON_NAIPE_ORD[b.s]));
  ONLINE.mao = { cartas: cs };
  renderOnline();
  if (ONLINE.code) onMaoRef(ONLINE.code, myUid).set({ cartas: cs }).catch(() => {});
}

// Arrastar carta da mão para reordenar (toque = selecionar; arrastar = mover)
let onDrag = null;
function onCardPointerDown(e, cid, cardEl, handEl) {
  onDrag = { cid, cardEl, handEl, startX: e.clientX, startY: e.clientY, moved: false };
  try { cardEl.setPointerCapture(e.pointerId); } catch (_) {}
}
function onCardPointerMove(e) {
  if (!onDrag) return;
  if (!onDrag.moved) {
    if (Math.hypot(e.clientX - onDrag.startX, e.clientY - onDrag.startY) < 8) return;
    onDrag.moved = true; onDrag.cardEl.classList.add('dragging');
  }
  e.preventDefault();
  const over = document.elementFromPoint(e.clientX, e.clientY);
  const alvo = over && over.closest('.on-hand .oncard');
  if (alvo && alvo !== onDrag.cardEl && alvo.parentElement === onDrag.handEl) {
    const cards = [...onDrag.handEl.children];
    const from = cards.indexOf(onDrag.cardEl), to = cards.indexOf(alvo);
    if (from < to) onDrag.handEl.insertBefore(onDrag.cardEl, alvo.nextSibling);
    else onDrag.handEl.insertBefore(onDrag.cardEl, alvo);
  }
}
function onCardPointerUp() {
  if (!onDrag) return;
  const d = onDrag; onDrag = null;
  d.cardEl.classList.remove('dragging');
  if (!d.moved) { // toque simples = selecionar
    const i = ONLINE.sel.indexOf(d.cid);
    if (i >= 0) ONLINE.sel.splice(i, 1); else ONLINE.sel.push(d.cid);
    renderOnline();
    return;
  }
  // arrastou: grava a nova ordem a partir do DOM
  const novaIds = [...d.handEl.querySelectorAll('.oncard')].map(x => x.dataset.cid);
  const byId = {}; ((ONLINE.mao && ONLINE.mao.cartas) || []).forEach(c => { byId[c.id] = c; });
  const cs = novaIds.map(id => byId[id]).filter(Boolean);
  ONLINE.mao = { cartas: cs };
  renderOnline();
  if (ONLINE.code) onMaoRef(ONLINE.code, myUid).set({ cartas: cs }).catch(() => {});
}
if (!window.__onDragInit) {
  window.__onDragInit = true;
  document.addEventListener('pointermove', onCardPointerMove, { passive: false });
  document.addEventListener('pointerup', onCardPointerUp);
  document.addEventListener('pointercancel', onCardPointerUp);
}

function renderOnline() {
  const root = appRoot(); root.innerHTML = '';
  const ob = document.querySelector('.fab-bar'); if (ob) ob.remove();
  if (!cloudReady) { root.appendChild(el('<div class="card">Conectando à nuvem… tente de novo em instantes.</div>')); return; }
  if (!ONLINE.code || !ONLINE.mesa) return onRenderLobby(root);
  const m = ONLINE.mesa;
  if (m.status === 'aguardando') return onRenderEspera(root);
  if (m.status === 'jogando') return onRenderMesa(root);
  if (m.status === 'encerrada') return onRenderFim(root);
}

function onRenderLobby(root) {
  const nome = onNome();
  const c = el(`
    <div class="card">
      <h2>🌐 Pontinho Online <span class="badge">beta</span></h2>
      <p class="muted">Jogo de cartas entre amigos, na confiança. Cada um joga do seu celular.</p>
      <label class="field"><span>Seu nome</span><input id="on-nome" type="text" value="${nome}" placeholder="Seu nome"></label>
      <button class="btn primary full" id="on-criar" style="margin:10px 0 14px">Criar mesa</button>
      <div class="field"><span>Ou entrar numa mesa:</span></div>
      <div class="row" style="gap:8px">
        <input id="on-code" type="text" placeholder="Código (4 letras)" style="flex:1;text-transform:uppercase">
        <button class="btn green" id="on-entrar">Entrar</button>
      </div>
      <button class="btn ghost sm full" id="on-voltar" style="margin-top:14px">← Voltar ao marcador</button>
    </div>`);
  c.querySelector('#on-criar').addEventListener('click', onCriarMesa);
  c.querySelector('#on-entrar').addEventListener('click', onEntrarMesa);
  c.querySelector('#on-voltar').addEventListener('click', () => { currentScreen = 'home'; render(); });
  root.appendChild(c);
}

function onRenderEspera(root) {
  const m = ONLINE.mesa;
  root.appendChild(el(`
    <div class="card" style="text-align:center">
      <p class="muted" style="margin:0">Código da mesa</p>
      <div style="font-size:36px;font-weight:900;letter-spacing:6px">${ONLINE.code}</div>
      <p class="muted" style="margin:4px 0 0">Compartilhe com a galera para entrarem</p>
    </div>`));
  const lst = el('<div class="card"><h2>Jogadores</h2></div>');
  m.jogadores.forEach(j => lst.appendChild(el(
    `<div class="jog-row"><div class="jog-name">${j.nome}${j.uid === m.hostUid ? ' 👑' : ''}${j.uid === myUid ? ' <span class="muted">(você)</span>' : ''}</div></div>`)));
  root.appendChild(lst);
  const restante = onEsperaRestante();
  root.appendChild(el(`<p class="muted" style="text-align:center;font-size:15px">${restante > 0 ? '⏳ Começa em <b>' + restante + 's</b> — tempo para todos entrarem' : (m.jogadores.length >= 2 ? 'Pronto para começar!' : 'Aguardando pelo menos 2 jogadores…')}</p>`));
  if (m.hostUid === myUid) {
    const b = el(`<button class="btn primary full" ${m.jogadores.length < 2 ? 'disabled' : ''}>▶ Iniciar agora (${m.jogadores.length})</button>`);
    b.addEventListener('click', () => { ONLINE._iniciando = true; onIniciar(); });
    root.appendChild(b);
  } else {
    root.appendChild(el('<p class="muted" style="text-align:center">Aguardando o host iniciar…</p>'));
  }
  const sair = el('<button class="btn ghost sm full" style="margin-top:10px">Sair da mesa</button>');
  sair.addEventListener('click', onSairMesa);
  root.appendChild(sair);
}

function onRenderMesa(root) {
  const m = ONLINE.mesa;
  const ehMinha = onMinhaVez();
  const turnoNome = (m.jogadores.find(j => j.uid === m.turno) || {}).nome || '—';
  const corTxt = m.coringa ? (onCartaVermelha(m.coringa.s) ? 'pretos' : 'vermelhos') : '';

  const screen = el(`<div class="on-screen land ${ONLINE._girado ? 'girado' : ''}"></div>`);
  const felt = el('<div class="on-felt"></div>');
  const outros = m.jogadores.filter(j => j.uid !== myUid);
  const armado = ehMinha && ONLINE.sel.length > 0;

  // Cabeçalho: CURINGAS (esq) · vez (centro) · código + botões (dir)
  const wilds = onCuringas(m.coringa);
  const wildsHtml = wilds.length
    ? wilds.map(w => `<b class="${onCartaVermelha(w.s) ? 'red' : 'blk'}">${w.r}${w.s}</b>`).join(' ')
    : '—';
  const pulgaHtml = m.coringa ? ` <span class="on-pulga-ind">🐛 <b class="${onCartaVermelha(m.coringa.s) ? 'red' : 'blk'}">${m.coringa.r}${m.coringa.s}</b></span>` : '';
  const topbar = el(`
    <div class="on-topbar">
      <span class="on-curingas">CURINGAS ${wildsHtml}${pulgaHtml}</span>
      <span class="on-turn ${ehMinha ? 'me' : ''}">${ehMinha ? '🟢 Sua vez' : 'Vez de ' + turnoNome}</span>
      <span class="on-topbtns">
        <span class="on-code-badge">${ONLINE.code}</span>
        <button class="on-icon" id="on-full" title="Tela cheia">⛶</button>
        <button class="on-icon" id="on-sair" title="Sair da mesa">✕</button>
      </span>
    </div>`);
  topbar.querySelector('#on-full').addEventListener('click', onToggleFull);
  topbar.querySelector('#on-sair').addEventListener('click', onSairMesa);
  felt.appendChild(topbar);

  // Área da mesa (verde): adversários em volta (topo) + centro com montes
  const table = el('<div class="on-table"></div>');

  // Adversários — leque de cartas viradas + contagem + nome
  const opps = el('<div class="on-opps"></div>');
  outros.forEach(j => {
    const n = (m.maosCount && m.maosCount[j.uid] != null) ? m.maosCount[j.uid] : '';
    const vez = j.uid === m.turno ? 'vez' : '';
    opps.appendChild(el(`
      <div class="on-opp ${vez}">
        <div class="on-fan"><span class="on-mini"></span><span class="on-mini"></span><span class="on-mini"></span><span class="on-count">${n}</span></div>
        <div class="on-opp-name">${j.nome}${(m.pulgas || []).includes(j.uid) ? ' 🐛' : ''}</div>
        <div class="on-opp-pts">${(m.pontosTotais && m.pontosTotais[j.uid]) || 0} pts · R$ ${money((m.saldo && m.saldo[j.uid]) || 0)}</div>
      </div>`));
  });
  table.appendChild(opps);

  // Centro: Monte (com o coringa deitado na diagonal por baixo) + Lixo (jogar fora)
  const center = el('<div class="on-center"></div>');
  // Monte + coringa diagonal
  const pMonte = el('<div class="on-pile"></div>');
  const deckUnit = el('<div class="on-deckunit"></div>');
  if (m.coringa) { const cc = onCardEl(m.coringa); cc.classList.add('on-coringa-diag'); deckUnit.appendChild(cc); }
  const monteBtn = el('<button class="oncard back">🂠</button>');
  monteBtn.addEventListener('click', () => onComprar('monte'));
  deckUnit.appendChild(monteBtn);
  // carta queimada mais recente fica face-up em cima do monte
  if (m.lixo && m.lixo.length) { const q = onCardEl(m.lixo[m.lixo.length - 1]); q.classList.add('on-queimada'); deckUnit.appendChild(q); }
  deckUnit.appendChild(el(`<span class="on-count">${m.monte.length}</span>`));
  pMonte.appendChild(deckUnit);
  center.appendChild(pMonte);
  // Lixo = onde se joga a carta fora (e de onde se compra o topo)
  const pLixo = el('<div class="on-pile"></div>');
  const lixoTop = (m.descarte && m.descarte.length) ? m.descarte[m.descarte.length - 1] : null;
  const alvoLixo = ehMinha && m.fase === 'descartar' && ONLINE.sel.length === 1;
  const lixoBox = el(`<div class="on-lixo ${alvoLixo ? 'alvo' : ''}"></div>`);
  if (lixoTop) lixoBox.appendChild(onCardEl(lixoTop));
  else lixoBox.appendChild(el('<span class="on-lixo-icon">🗑</span>'));
  lixoBox.appendChild(el(`<span class="on-count">${(m.descarte || []).length}</span>`));
  lixoBox.addEventListener('click', () => { if (m.fase === 'comprar') onComprar('descarte'); else onDescartar(); });
  pLixo.appendChild(lixoBox);
  center.appendChild(pLixo);
  table.appendChild(center);

  felt.appendChild(table);

  // Aviso da última queima (todos veem)
  if (m.ultimaQueima) {
    const qn = (m.jogadores.find(j => j.uid === m.ultimaQueima.uid) || {}).nome || '';
    const qc = (m.ultimaQueima.cartas || []).map(c => c.r + c.s).join(', ');
    felt.appendChild(el(`<div class="on-aviso">🔥 ${qn} queimou ${qc}</div>`));
  }

  if (ehMinha) {
    const dica = m.fase === 'comprar'
      ? 'Toque no <b>Monte</b> ou no <b>Lixo</b> para comprar'
      : 'Baixar/encaixar: selecione e toque num <b>jogo</b> · Jogar fora: toque no <b>Lixo</b>';
    felt.appendChild(el(`<div class="on-hint">${dica}</div>`));
  }

  // Jogos baixados — toque na área para BAIXAR as selecionadas
  const jogos = m.mesaJogos || [];
  const jbWrap = el('<div class="on-jogoswrap"></div>');
  jbWrap.appendChild(el(`<div class="on-jogos-hint">${ehMinha ? (armado ? '⬇️ Toque num JOGO p/ encaixar, ou na área vazia p/ criar um novo' : 'Jogos na mesa — baixar/encaixar aqui') : 'Jogos na mesa'}</div>`));
  const jb = el('<div class="on-jogos"></div>');
  if (!jogos.length) jb.appendChild(el('<div class="on-jogos-vazio">Nenhum jogo baixado ainda</div>'));
  jogos.forEach(g => {
    const dono = (m.jogadores.find(j => j.uid === g.dono) || {}).nome || '';
    const grp = el(`<div class="on-jogo ${armado ? 'encaixavel' : ''}" title="${dono}"></div>`);
    onArrumaJogo(g.cartas, m.coringa).forEach(c => grp.appendChild(onCardEl(c)));
    if (ehMinha) grp.addEventListener('click', (e) => { e.stopPropagation(); if (ONLINE.sel.length) onEncaixar(g.id); });
    jb.appendChild(grp);
  });
  jbWrap.appendChild(jb);
  if (armado) jbWrap.classList.add('armado');
  if (ehMinha) jbWrap.addEventListener('click', () => { if (ONLINE.sel.length) onBaixar(); });
  felt.appendChild(jbWrap);

  screen.appendChild(felt);

  // Minha mão (em leque) + Ordenar
  const mao = (ONLINE.mao && ONLINE.mao.cartas) || []; // ordem manual (arrastável)
  const hw = el('<div class="on-handwrap"></div>');
  const head = el(`<div class="on-hand-head"><span>Sua mão (${mao.length}) · ${(m.pontosTotais && m.pontosTotais[myUid]) || 0} pts · R$ ${money((m.saldo && m.saldo[myUid]) || 0)}</span><span class="on-ordena"></span></div>`);
  const ord = head.querySelector('.on-ordena');
  // Botão da pulga: aparece se você tem a carta exata do coringa e ainda não mostrou
  if (onTemPulga() && !(m.pulgas || []).includes(myUid)) {
    const bp = el('<button class="chip sm on-pulga-btn">🐛 Tenho a pulga!</button>');
    bp.addEventListener('click', onDeclararPulga);
    ord.appendChild(bp);
  }
  const bN = el('<button class="chip sm">♠ Naipe</button>');
  bN.addEventListener('click', () => onOrdenarMao('naipe'));
  const bV = el('<button class="chip sm">🔢 Seq.</button>');
  bV.addEventListener('click', () => onOrdenarMao('valor'));
  ord.appendChild(bN); ord.appendChild(bV);
  hw.appendChild(head);
  const hand = el('<div class="on-hand"></div>');
  mao.forEach(c => {
    const ce = onCardEl(c);
    ce.dataset.cid = c.id;
    ce.addEventListener('pointerdown', (e) => onCardPointerDown(e, c.id, ce, hand));
    hand.appendChild(ce);
  });
  hw.appendChild(hand);
  screen.appendChild(hw);

  root.appendChild(screen);
}

// Pulga = ter na mão a carta EXATA que foi virada como coringa (mesmo valor e naipe)
function onTemPulga() {
  const m = ONLINE.mesa;
  if (!m || !m.coringa) return false;
  const mao = (ONLINE.mao && ONLINE.mao.cartas) || [];
  return mao.some(c => c.r === m.coringa.r && c.s === m.coringa.s);
}
// Declara a pulga: mostra a todos e ganha 2,00 de cada jogador
async function onDeclararPulga() {
  const m = ONLINE.mesa, code = ONLINE.code;
  if (!m || !m.coringa) return;
  if ((m.pulgas || []).includes(myUid)) { toast('Você já mostrou a pulga'); return; }
  if (!onTemPulga()) { toast('Você não tem a pulga'); return; }
  const outros = m.jogadores.filter(j => j.uid !== myUid);
  const saldo = { ...(m.saldo || {}) };
  outros.forEach(j => { saldo[j.uid] = (saldo[j.uid] || 0) - 2; });
  saldo[myUid] = (saldo[myUid] || 0) + 2 * outros.length;
  const pulgas = [...(m.pulgas || []), myUid];
  ONLINE.mesa = { ...m, saldo, pulgas };
  renderOnline();
  toast('🐛 Você mostrou a pulga! +' + money(2 * outros.length));
  try { await onMesaRef(code).update({ saldo, pulgas }); } catch (e) { console.warn('pulga', e); }
}

// Valor de uma carta para contagem de pontos
function onValorCarta(c, cor) {
  if (onEhCoringa(c, cor)) return 20;
  if (c.r === 'A') return 15;
  if (c.r === 'K' || c.r === 'Q' || c.r === 'J') return 10;
  return Number(c.r) || 0; // 2..10
}
function onPontosMao(cartas, cor) { return (cartas || []).reduce((s, c) => s + onValorCarta(c, cor), 0); }

// Ao fim da mão, cada jogador reporta os pontos da PRÓPRIA mão (as mãos são privadas)
async function onReportarPontos() {
  const m = ONLINE.mesa, code = ONLINE.code;
  if (!m || m.status !== 'encerrada') return;
  if (!m.jogadores.some(j => j.uid === myUid)) return;      // espectador não pontua
  if (m.pontosHand && m.pontosHand[myUid] !== undefined) return; // já reportei
  const mao = (ONLINE.mao && ONLINE.mao.cartas) || [];
  const pts = onPontosMao(mao, m.coringa);
  try { await onMesaRef(code).update({ ['pontosHand.' + myUid]: pts }); }
  catch (e) { console.warn('reportar pontos', e); }
}

// Gira a própria tela do jogo (CSS) — funciona em qualquer aparelho/navegador,
// sem depender de reinstalar o app nem da API de tela cheia.
function onToggleFull() {
  ONLINE._girado = !ONLINE._girado;
  renderOnline();
}

function onRenderFim(root) {
  const m = ONLINE.mesa;
  const v = m.jogadores.find(j => j.uid === m.vencedor);
  const ph = m.pontosHand || {};
  const tot = m.pontosTotais || {};
  root.appendChild(el(`
    <div class="card" style="text-align:center;background:var(--green)">
      <h2>🏆 ${v ? v.nome : '—'} bateu!</h2>
      <p class="muted">Pontos desta mão (quem bate faz 0). Total acumulado na partida.</p>
    </div>`));

  // Placar: pontos da mão + total (mostra "…" enquanto alguém ainda não reportou)
  const card = el('<div class="card"><h2>Pontos da mão</h2></div>');
  const linhas = m.jogadores.map(j => {
    const reportou = ph[j.uid] !== undefined;
    const ptsMao = reportou ? ph[j.uid] : null;
    const total = (tot[j.uid] || 0) + (ph[j.uid] || 0);
    return { j, ptsMao, total, reportou, estourou: total >= 100 };
  }).sort((a, b) => a.total - b.total);
  linhas.forEach(x => {
    const venceu = x.j.uid === m.vencedor;
    card.appendChild(el(`
      <div class="jog-row">
        <div class="jog-info">
          <div class="jog-name">${venceu ? '🏆 ' : ''}${x.j.nome}${x.j.uid === myUid ? ' <span class="muted">(você)</span>' : ''}${x.estourou ? ' <span class="badge" style="background:#f6d6d6;color:#b00">estourou 100</span>' : ''}</div>
          <div class="muted jog-stats">Mão: ${x.ptsMao === null ? '…' : x.ptsMao} pts</div>
        </div>
        <div style="font-weight:800;font-size:18px">${x.total}</div>
      </div>`));
  });
  const faltam = m.jogadores.filter(j => ph[j.uid] === undefined).length;
  if (faltam) card.appendChild(el(`<p class="muted" style="font-size:12px">Aguardando ${faltam} jogador(es) confirmarem os pontos…</p>`));
  root.appendChild(card);

  if (m.hostUid === myUid) {
    const nb = el('<button class="btn primary full" style="margin-top:10px">Nova mão</button>');
    nb.addEventListener('click', onIniciar);
    root.appendChild(nb);
  } else {
    root.appendChild(el('<p class="muted" style="text-align:center;margin-top:10px">Aguardando o host começar a próxima mão…</p>'));
  }
  const sair = el('<button class="btn ghost sm full" style="margin-top:10px">Sair da mesa</button>');
  sair.addEventListener('click', onSairMesa);
  root.appendChild(sair);
}
