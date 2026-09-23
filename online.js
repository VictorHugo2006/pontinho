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

const ONLINE = { code: null, mesa: null, mao: null, unsubMesa: null, unsubMao: null, sel: [] };

const ON_NAIPES = ['♠', '♣', '♥', '♦']; // ♠ ♣ ♥ ♦
const ON_VALORES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function onCartaVermelha(s) { return s === '♥' || s === '♦'; }

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
  try {
    const batch = fbDB.batch();
    m.jogadores.forEach(j => batch.set(onMaoRef(code, j.uid), { cartas: maos[j.uid] }));
    batch.update(onMesaRef(code), {
      status: 'jogando', coringa, monte: deck, descarte: [], mesaJogos: [],
      turno: primeiro, fase: 'comprar', vencedor: null,
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
  let carta;
  try {
    if (origem === 'monte') {
      if (!m.monte.length) { toast('Monte vazio'); return; }
      const monte = [...m.monte]; carta = monte.pop();
      await onMesaRef(code).update({ monte, fase: 'descartar' });
    } else {
      if (!m.descarte.length) { toast('Descarte vazio'); return; }
      const d = [...m.descarte]; carta = d.pop();
      await onMesaRef(code).update({ descarte: d, fase: 'descartar' });
    }
    const mao = [...((ONLINE.mao && ONLINE.mao.cartas) || []), carta];
    await onMaoRef(code, myUid).set({ cartas: mao });
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
  ONLINE.sel = [];
  try {
    await onMaoRef(code, myUid).set({ cartas: resto });
    await onMesaRef(code).update({ mesaJogos: jogos });
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
  ONLINE.sel = [];
  try {
    await onMaoRef(code, myUid).set({ cartas: resto });
    await onMesaRef(code).update({ descarte: [...(m.descarte || []), carta], turno: prox, fase: 'comprar' });
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
  const cor = m.coringa ? (onCartaVermelha(m.coringa.s) ? 'os pretos' : 'os vermelhos') : '';

  root.appendChild(el(`
    <div class="card">
      <div class="row" style="gap:10px;flex-wrap:wrap;align-items:center">
        <div>Coringa: <b>${m.coringa ? (m.coringa.r + m.coringa.s) : '—'}</b> <span class="muted" style="font-size:12px">(coringas = ${m.coringa ? m.coringa.r + ' ' + cor : '—'})</span></div>
        <div class="spacer"></div>
        <div>Vez: <b>${turnoNome}</b>${ehMinha ? ' <span class="badge" style="background:#b6e3b6">SUA VEZ</span>' : ''}</div>
      </div>
    </div>`));

  // Monte + Descarte
  const linha = el('<div class="row" style="gap:16px;align-items:flex-start;justify-content:center;margin:8px 0"></div>');
  const monteWrap = el('<div style="text-align:center"></div>');
  const monteBtn = el('<button class="oncard back">🂠</button>');
  monteBtn.addEventListener('click', () => onComprar('monte'));
  monteWrap.appendChild(monteBtn);
  monteWrap.appendChild(el(`<div class="muted" style="font-size:12px">Monte (${m.monte.length})</div>`));
  const descWrap = el('<div style="text-align:center"></div>');
  const topo = (m.descarte && m.descarte.length) ? m.descarte[m.descarte.length - 1] : null;
  if (topo) { descWrap.appendChild(onCardEl(topo, () => onComprar('descarte'))); }
  else { descWrap.appendChild(el('<button class="oncard vazio">—</button>')); }
  descWrap.appendChild(el('<div class="muted" style="font-size:12px">Descarte</div>'));
  linha.appendChild(monteWrap); linha.appendChild(descWrap);
  root.appendChild(linha);

  if (ehMinha) {
    root.appendChild(el(`<p class="muted" style="text-align:center;font-size:13px">${m.fase === 'comprar' ? '1) Compre do monte ou do descarte' : '2) Baixe jogos (opcional) e descarte 1 carta'}</p>`));
  }

  // Jogos baixados na mesa
  const jb = el('<div class="card"><h2>Jogos na mesa</h2></div>');
  if (!(m.mesaJogos || []).length) jb.appendChild(el('<p class="muted">Nada baixado ainda.</p>'));
  (m.mesaJogos || []).forEach(g => {
    const dono = (m.jogadores.find(j => j.uid === g.dono) || {}).nome || '';
    const row = el(`<div style="margin:6px 0"><div class="muted" style="font-size:11px">${dono}</div><div class="row" style="gap:4px;flex-wrap:wrap"></div></div>`);
    const cont = row.querySelector('.row');
    g.cartas.forEach(c => cont.appendChild(onCardEl(c)));
    jb.appendChild(row);
  });
  root.appendChild(jb);

  // Minha mão
  const mao = (ONLINE.mao && ONLINE.mao.cartas) || [];
  const mh = el(`<div class="card"><h2>Sua mão (${mao.length})</h2></div>`);
  const grid = el('<div class="row" style="gap:6px;flex-wrap:wrap"></div>');
  mao.forEach(c => grid.appendChild(onCardEl(c, () => {
    const i = ONLINE.sel.indexOf(c.id);
    if (i >= 0) ONLINE.sel.splice(i, 1); else ONLINE.sel.push(c.id);
    renderOnline();
  })));
  mh.appendChild(grid);
  root.appendChild(mh);

  // Barra de ações
  const bar = el('<div class="fab-bar"></div>');
  const bBaixar = el('<button class="btn ghost">⬇️ Baixar</button>');
  bBaixar.addEventListener('click', onBaixar);
  const bDesc = el('<button class="btn primary">Descartar</button>');
  bDesc.addEventListener('click', onDescartar);
  const bBati = el('<button class="btn green">Bati!</button>');
  bBati.addEventListener('click', () => openConfirmModal({ title: 'Bati?', message: 'Confirma que você bateu e encerrou a mão?', okText: 'Bati!', onOk: onBati }));
  bar.appendChild(bBaixar); bar.appendChild(bDesc); bar.appendChild(bBati);
  document.body.appendChild(bar);
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
