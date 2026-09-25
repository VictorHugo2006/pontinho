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
}
function onEntrarSub(code) {
  onLimpaSubs();
  ONLINE.code = code; ONLINE.sel = []; ONLINE.mesa = null; ONLINE.mao = null;
  ONLINE.unsubMesa = onMesaRef(code).onSnapshot(
    s => { ONLINE.mesa = s.exists ? s.data() : null; if (currentScreen === 'online') renderOnline(); },
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
  try {
    const batch = fbDB.batch();
    m.jogadores.forEach(j => batch.set(onMaoRef(code, j.uid), { cartas: maos[j.uid] }));
    batch.update(onMesaRef(code), {
      status: 'jogando', coringa, monte: deck, descarte: [], mesaJogos: [],
      turno: primeiro, fase: 'comprar', vencedor: null, maosCount,
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
  const jogos = [...(m.mesaJogos || []), { id: 'j' + Date.now(), dono: myUid, cartas: baixadas }];
  const maosCount = { ...(m.maosCount || {}), [myUid]: resto.length };
  const bateu = resto.length === 0; // baixou tudo = bateu (com as 10)
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

/* ------------------------------ Render --------------------------------- */
function onCardEl(c, onClick) {
  const cls = onCartaVermelha(c.s) ? 'red' : 'black';
  const sel = ONLINE.sel.includes(c.id) ? 'sel' : '';
  const b = el(`<button class="oncard ${cls} ${sel}">${c.r}<span class="np">${c.s}</span></button>`);
  if (onClick) b.addEventListener('click', onClick);
  return b;
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
  if (m.hostUid === myUid) {
    const b = el(`<button class="btn primary full" ${m.jogadores.length < 2 ? 'disabled' : ''}>Iniciar jogo (${m.jogadores.length})</button>`);
    b.addEventListener('click', onIniciar);
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

  const screen = el('<div class="on-screen"></div>');
  const felt = el('<div class="on-felt"></div>');

  // Cabeçalho da mesa: código + vez + botões (tela cheia / sair)
  const topbar = el(`
    <div class="on-topbar">
      <span class="on-code-badge">Mesa ${ONLINE.code}</span>
      <span class="on-turn ${ehMinha ? 'me' : ''}">${ehMinha ? '🟢 Sua vez' : 'Vez de ' + turnoNome}</span>
      <span class="on-topbtns">
        <button class="on-icon" id="on-full" title="Tela cheia">⛶</button>
        <button class="on-icon" id="on-sair" title="Sair da mesa">✕</button>
      </span>
    </div>`);
  topbar.querySelector('#on-full').addEventListener('click', onToggleFull);
  topbar.querySelector('#on-sair').addEventListener('click', onSairMesa);
  felt.appendChild(topbar);

  // Adversários (todos menos eu)
  const opps = el('<div class="on-opps"></div>');
  const outros = m.jogadores.filter(j => j.uid !== myUid);
  outros.forEach(j => {
    const n = (m.maosCount && m.maosCount[j.uid] != null) ? m.maosCount[j.uid] : '';
    const vez = j.uid === m.turno ? 'vez' : '';
    opps.appendChild(el(`
      <div class="on-opp ${vez}">
        <div class="on-backstack"><span class="on-back">🂠</span><span class="on-count">${n}</span></div>
        <div class="on-opp-name">${j.nome}</div>
      </div>`));
  });
  felt.appendChild(opps);

  // Centro: coringa • monte • descarte
  const center = el('<div class="on-center"></div>');
  // Coringa
  const pCor = el('<div class="on-pile"></div>');
  pCor.appendChild(m.coringa ? onCardEl(m.coringa) : el('<div class="oncard vazio">—</div>'));
  pCor.appendChild(el(`<div class="on-plbl">Coringa<br><span>${m.coringa ? corTxt : ''}</span></div>`));
  center.appendChild(pCor);
  // Monte
  const pMonte = el('<div class="on-pile"></div>');
  const monteBtn = el('<button class="oncard back">🂠</button>');
  monteBtn.addEventListener('click', () => onComprar('monte'));
  const monteC = el('<div class="on-pilecard"></div>');
  monteC.appendChild(monteBtn); monteC.appendChild(el(`<span class="on-count">${m.monte.length}</span>`));
  pMonte.appendChild(monteC); pMonte.appendChild(el('<div class="on-plbl">Monte</div>'));
  center.appendChild(pMonte);
  // Descarte — toque para COMPRAR (fase comprar) ou JOGAR FORA (fase descartar)
  const pDesc = el('<div class="on-pile"></div>');
  const topo = (m.descarte && m.descarte.length) ? m.descarte[m.descarte.length - 1] : null;
  const descarteAlvo = ehMinha && m.fase === 'descartar'; // vai jogar fora aqui
  const descCard = topo ? onCardEl(topo) : el('<div class="oncard vazio">—</div>');
  if (descarteAlvo && ONLINE.sel.length === 1) descCard.classList.add('alvo');
  descCard.addEventListener('click', () => { if (m.fase === 'comprar') onComprar('descarte'); else onDescartar(); });
  pDesc.appendChild(descCard);
  pDesc.appendChild(el(`<div class="on-plbl">${descarteAlvo ? '👉 Jogar aqui' : 'Descarte'}</div>`));
  center.appendChild(pDesc);
  felt.appendChild(center);

  if (ehMinha) {
    const dica = m.fase === 'comprar'
      ? 'Toque no <b>Monte</b> ou no <b>Descarte</b> para comprar'
      : 'Baixar: selecione e toque na <b>mesa</b> · Jogar fora: selecione 1 e toque no <b>Descarte</b>';
    felt.appendChild(el(`<div class="on-hint">${dica}</div>`));
  }

  // Jogos baixados — toque na área para BAIXAR as cartas selecionadas
  const jogos = m.mesaJogos || [];
  const jbWrap = el('<div class="on-jogoswrap"></div>');
  const armado = ehMinha && ONLINE.sel.length > 0;
  jbWrap.appendChild(el(`<div class="on-jogos-hint">${ehMinha ? (armado ? '⬇️ Toque para BAIXAR as ' + ONLINE.sel.length + ' selecionadas' : 'Jogos na mesa — toque aqui p/ baixar as selecionadas') : 'Jogos na mesa'}</div>`));
  const jb = el('<div class="on-jogos"></div>');
  if (!jogos.length) jb.appendChild(el('<div class="on-jogos-vazio">Nenhum jogo baixado ainda</div>'));
  jogos.forEach(g => {
    const dono = (m.jogadores.find(j => j.uid === g.dono) || {}).nome || '';
    const grp = el(`<div class="on-jogo" title="${dono}"></div>`);
    g.cartas.forEach(c => grp.appendChild(onCardEl(c)));
    jb.appendChild(grp);
  });
  jbWrap.appendChild(jb);
  if (armado) jbWrap.classList.add('armado');
  if (ehMinha) jbWrap.addEventListener('click', () => { if (ONLINE.sel.length) onBaixar(); });
  felt.appendChild(jbWrap);

  screen.appendChild(felt);

  // Minha mão (em leque) + Ordenar
  const mao = onOrdenaMao((ONLINE.mao && ONLINE.mao.cartas) || []);
  const hw = el('<div class="on-handwrap"></div>');
  const head = el(`<div class="on-hand-head"><span>Sua mão (${mao.length})</span><span class="on-ordena"></span></div>`);
  const ord = head.querySelector('.on-ordena');
  const bN = el(`<button class="chip sm ${ONLINE.ordem === 'naipe' ? 'on' : ''}">♠ Naipe</button>`);
  bN.addEventListener('click', () => { ONLINE.ordem = ONLINE.ordem === 'naipe' ? null : 'naipe'; renderOnline(); });
  const bV = el(`<button class="chip sm ${ONLINE.ordem === 'valor' ? 'on' : ''}">🔢 Seq.</button>`);
  bV.addEventListener('click', () => { ONLINE.ordem = ONLINE.ordem === 'valor' ? null : 'valor'; renderOnline(); });
  ord.appendChild(bN); ord.appendChild(bV);
  hw.appendChild(head);
  const hand = el('<div class="on-hand"></div>');
  mao.forEach(c => hand.appendChild(onCardEl(c, () => {
    const i = ONLINE.sel.indexOf(c.id);
    if (i >= 0) ONLINE.sel.splice(i, 1); else ONLINE.sel.push(c.id);
    renderOnline();
  })));
  hw.appendChild(hand);
  screen.appendChild(hw);

  root.appendChild(screen);
}

// Alterna tela cheia de verdade (esconde a barra do navegador)
function onToggleFull() {
  try {
    if (!document.fullscreenElement) {
      (document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen || (() => {})).call(document.documentElement);
    } else {
      (document.exitFullscreen || document.webkitExitFullscreen || (() => {})).call(document);
    }
  } catch (_) {}
}

function onRenderFim(root) {
  const m = ONLINE.mesa;
  const v = m.jogadores.find(j => j.uid === m.vencedor);
  root.appendChild(el(`
    <div class="card" style="text-align:center;background:var(--green)">
      <h2>🏆 ${v ? v.nome : '—'} bateu!</h2>
      <p class="muted">Mão encerrada. A contagem de pontos e o dinheiro entram na Fase 2.</p>
    </div>`));
  if (m.hostUid === myUid) {
    const nb = el('<button class="btn primary full" style="margin-top:10px">Nova mão</button>');
    nb.addEventListener('click', onIniciar);
    root.appendChild(nb);
  }
  const sair = el('<button class="btn ghost sm full" style="margin-top:10px">Sair da mesa</button>');
  sair.addEventListener('click', onSairMesa);
  root.appendChild(sair);
}
