/* ==========================================================================
   Pontinho — controle de jogos de baralho (cacheta)
   Dados salvos localmente no dispositivo (localStorage).
   ========================================================================== */

'use strict';

/* ----------------------------- Persistência ------------------------------ */
const STORE_KEY = 'pontinho:v1';

const DB = {
  load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return { partidas: [], jogadores: [] };
      const data = JSON.parse(raw);
      if (!data.partidas) data.partidas = [];
      if (!data.jogadores) data.jogadores = [];
      // Migração leve p/ campos novos
      data.partidas.forEach(p => {
        if (!p.pendingPulgas) p.pendingPulgas = [];
        if (!p.events) p.events = [];
        if (!p.st.fecho) p.st.fecho = {};
        if (p.st.fechado === undefined) p.st.fechado = false;
        p.rounds.forEach(r => { if (!r.voltas) r.voltas = []; });
      });
      return data;
    } catch (e) {
      console.error('Falha ao ler dados', e);
      return { partidas: [], jogadores: [] };
    }
  },
  save(data) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); }
    catch (e) { console.error('Falha ao salvar', e); }
  }
};

let state = DB.load();
let currentScreen = 'home';

/* ------------------------------- Utils ----------------------------------- */
const uid = () => Math.random().toString(36).slice(2, 9);
const money = (n) => (n < 0 ? '-' : '') + Math.abs(n).toFixed(2).replace('.', ',');
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; };

function todayISO() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}
function formatDatePT(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) { t = el('<div class="toast"></div>'); document.body.appendChild(t); }
  t.textContent = msg;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2200);
}

/* --------------------------- Modelo de partida --------------------------- */
function activePlayers(p) { return p.players.filter(pl => p.st.ativo[pl.id]); }
function maxPontosAtivos(p, excludeId) {
  const vals = activePlayers(p).filter(pl => pl.id !== excludeId).map(pl => p.st.pontos[pl.id]);
  return vals.length ? Math.max(...vals) : 0;
}
// Quanto um jogador paga no fim: valor da partida × (nº de voltas + 1)
function dividaFinal(p, playerId) {
  return p.valorPartida * (p.st.voltas[playerId] + 1);
}
// Dinheiro exibido: saldo das rodadas + fecho (só quando a partida terminou)
function saldoExibido(p, playerId) {
  return p.st.saldo[playerId] + (p.st.fechado ? (p.st.fecho[playerId] || 0) : 0);
}
// Pote previsto = soma das dívidas de quem já caiu fora
function poteProjetado(p) {
  if (p.st.fechado) return p.st.fecho[p.vencedorId] || 0;
  return p.players.filter(pl => !p.st.ativo[pl.id])
    .reduce((s, pl) => s + dividaFinal(p, pl.id), 0);
}

function newPartida({ data, valorPartida, valorBatida, players: sel }) {
  // players referenciam o id do cadastro, para o histórico acumular por pessoa
  const players = sel.map(j => ({ id: j.id, nome: j.nome }));
  const zero = (v) => Object.fromEntries(players.map(pl => [pl.id, v]));
  return {
    id: uid(),
    data,
    valorPartida,
    valorBatida,
    players,
    st: {
      pontos: zero(0),
      saldo: zero(0),       // dinheiro das batidas/pulgas (soma zero, ao vivo)
      ativo: zero(true),
      voltas: zero(0),
      pulgas: zero(0),
      fecho: {},            // ajuste do valor da partida, aplicado só no fim
      fechado: false,
    },
    pendingPulgas: [],      // pulgas registradas aguardando a próxima rodada
    events: [],             // registro de ações (fonte da verdade)
    rounds: [],
    finalizada: false,
    vencedorId: null,
    limite: 100,
  };
}

function currentPartida() { return state.partidas.find(p => !p.finalizada) || null; }

/* ------------------------- Cadastro de jogadores ------------------------- */
function addJogador(nome) {
  nome = (nome || '').trim();
  if (!nome) return null;
  if (state.jogadores.some(j => j.nome.toLowerCase() === nome.toLowerCase())) {
    toast('Já existe um jogador com esse nome'); return null;
  }
  const j = { id: uid(), nome };
  state.jogadores.push(j);
  DB.save(state);
  return j;
}
function renameJogador(id, nome) {
  nome = (nome || '').trim();
  if (!nome) return;
  const j = state.jogadores.find(x => x.id === id);
  if (j) { j.nome = nome; DB.save(state); }
}
function removeJogador(id) {
  state.jogadores = state.jogadores.filter(x => x.id !== id);
  DB.save(state);
}
function nomeJogador(id, fallback) {
  const j = state.jogadores.find(x => x.id === id);
  return j ? j.nome : (fallback || '—');
}
// Estatísticas acumuladas por jogador cadastrado (por id)
function computeStats() {
  const stats = {};
  state.partidas.forEach(p => {
    p.players.forEach(pl => {
      const s = stats[pl.id] || (stats[pl.id] = { partidas: 0, vitorias: 0, pulgas: 0, saldo: 0 });
      s.partidas += 1;
      if (p.vencedorId === pl.id) s.vitorias += 1;
      s.pulgas += p.st.pulgas[pl.id] || 0;
      if (p.finalizada) s.saldo += saldoExibido(p, pl.id);
    });
  });
  return stats;
}

/* --------------------------- Backup (export/import) ---------------------- */
function exportBackup() {
  const payload = { tipo: 'pontinho-backup', versao: 1, exportadoEm: new Date().toISOString(), dados: state };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pontinho-backup-${todayISO()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  toast('Backup exportado');
}

function importBackup(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const raw = JSON.parse(reader.result);
      const dados = raw && raw.dados ? raw.dados : raw; // aceita com/sem envelope
      const jog = Array.isArray(dados.jogadores) ? dados.jogadores : [];
      const par = Array.isArray(dados.partidas) ? dados.partidas : [];
      if (!jog.length && !par.length) { toast('Arquivo sem dados do Pontinho'); return; }

      let addJ = 0, addP = 0;
      jog.forEach(j => {
        if (!j || !j.id || !j.nome) return;
        const existe = state.jogadores.some(x => x.id === j.id || x.nome.toLowerCase() === j.nome.toLowerCase());
        if (!existe) { state.jogadores.push({ id: j.id, nome: j.nome }); addJ++; }
      });
      par.forEach(p => {
        if (!p || !p.id) return;
        if (!state.partidas.some(x => x.id === p.id)) { state.partidas.push(p); addP++; }
      });

      DB.save(state);
      state = DB.load(); // reaplica migração/normalização
      render();
      toast(`Importado: +${addJ} jogador(es), +${addP} partida(s)`);
    } catch (e) {
      console.warn(e); toast('Arquivo inválido — não é um backup do Pontinho');
    }
  };
  reader.readAsText(file);
}

/* ======================= Registro de eventos (log) =======================
   Todo o estado (pontos, saldo, ativo, voltas, pulgas, fecho, rodadas) é
   RECALCULADO a partir de p.events. Isso torna editar/desfazer confiável.
   Tipos de evento:
     { type:'pulga',     playerIds:[...] }
     { type:'round',     batedorId, foraIds:[...], pontos:{id:val} }
     { type:'volta',     playerId }
     { type:'eliminar',  playerId }
     { type:'finalizar', vencedorId }
   ========================================================================= */
function recompute(p) {
  const players = p.players;
  const zero = (v) => Object.fromEntries(players.map(pl => [pl.id, v]));
  // Jogadores que entram no meio começam INATIVOS até o evento 'entrar'
  const lateIds = new Set((p.events || []).filter(e => e.type === 'entrar').map(e => e.playerId));
  const st = {
    pontos: zero(0), saldo: zero(0),
    ativo: Object.fromEntries(players.map(pl => [pl.id, !lateIds.has(pl.id)])),
    voltas: zero(0), pulgas: zero(0), fecho: {}, fechado: false,
  };
  const vB = p.valorBatida;
  const rounds = [];
  let pending = [];
  const eliminados = new Set(); // quem já caiu fora (para marcar X nas rodadas seguintes)
  p.finalizada = false;
  p.vencedorId = null;

  const activeIds = () => players.filter(pl => st.ativo[pl.id]).map(pl => pl.id);
  const maxAtivosExcl = (excl) => {
    // Volta com a pontuação do maior jogador que AINDA está na partida (abaixo do limite)
    const v = activeIds().filter(id => id !== excl && st.pontos[id] < p.limite).map(id => st.pontos[id]);
    return v.length ? Math.max(...v) : 0;
  };

  (p.events || []).forEach((ev, evIndex) => {
    if (ev.type === 'pulga') {
      const act = activeIds();
      (ev.playerIds || []).forEach(pid => {
        if (!st.ativo[pid]) return;
        act.forEach(oid => { if (oid === pid) return; st.saldo[pid] += vB; st.saldo[oid] -= vB; });
        st.pulgas[pid] += 1;
        pending.push(pid);
      });
    } else if (ev.type === 'round') {
      const act = activeIds();
      if (ev.batedorId && st.ativo[ev.batedorId]) {
        act.forEach(oid => { if (oid === ev.batedorId) return; st.saldo[ev.batedorId] += vB; st.saldo[oid] -= vB; });
      }
      const pontosDelta = zero(0);
      act.forEach(id => {
        if (id === ev.batedorId) return;
        if ((ev.foraIds || []).includes(id)) return;
        pontosDelta[id] = Number((ev.pontos || {})[id] || 0);
        st.pontos[id] += pontosDelta[id];
      });
      const pulgaIds = [...pending]; pending = [];
      const estourou = act.filter(id => st.pontos[id] >= p.limite);
      rounds.push({
        n: rounds.length + 1, evIndex, activeIds: [...act], foraAcum: [...eliminados],
        batedorId: ev.batedorId || null, pulgaIds,
        foraIds: [...(ev.foraIds || [])], pontos: pontosDelta, voltas: [], estourou,
      });
    } else if (ev.type === 'entrar') {
      // Entra com a maior pontuação e o maior nº de voltas entre os ativos
      const act = activeIds();
      const novoP = act.length ? Math.max(...act.map(id => st.pontos[id])) : 0;
      const novoV = act.length ? Math.max(...act.map(id => st.voltas[id])) : 0;
      st.pontos[ev.playerId] = novoP;
      st.voltas[ev.playerId] = novoV;
      st.ativo[ev.playerId] = true;
    } else if (ev.type === 'volta') {
      const novo = maxAtivosExcl(ev.playerId);
      st.voltas[ev.playerId] += 1;
      st.pontos[ev.playerId] = novo;
      st.ativo[ev.playerId] = true;
      eliminados.delete(ev.playerId);
      const last = rounds[rounds.length - 1];
      if (last) last.voltas.push({ playerId: ev.playerId, pontos: novo });
    } else if (ev.type === 'eliminar') {
      st.ativo[ev.playerId] = false;
      eliminados.add(ev.playerId);
    } else if (ev.type === 'finalizar') {
      if (pending.length) {
        rounds.push({ n: rounds.length + 1, evIndex, activeIds: activeIds(), foraAcum: [...eliminados], batedorId: null, pulgaIds: [...pending], foraIds: [], pontos: zero(0), voltas: [], estourou: [] });
        pending = [];
      }
      const fecho = {}; let total = 0;
      players.forEach(x => {
        if (x.id === ev.vencedorId) return;
        const d = p.valorPartida * (st.voltas[x.id] + 1);
        fecho[x.id] = -d; total += d;
      });
      if (ev.vencedorId) fecho[ev.vencedorId] = total;
      st.fecho = fecho; st.fechado = !!ev.vencedorId;
      p.vencedorId = ev.vencedorId || null;
      p.finalizada = true;
    }
  });

  p.st = st;
  p.rounds = rounds;
  p.pendingPulgas = pending;
}

function pushEvent(p, ev) { p.events.push(ev); recompute(p); persist(p); }

function undoLast(p) {
  if (!p.events.length) return;
  const ev = p.events.pop();
  // Desfazer a entrada de um jogador extra = removê-lo da partida
  if (ev.type === 'entrar' && !p.events.some(e => e.type === 'entrar' && e.playerId === ev.playerId)) {
    p.players = p.players.filter(pl => pl.id !== ev.playerId);
  }
  recompute(p);
  persist(p);
}

/* ----------------------- Ações (criam eventos) --------------------------- */
function registrarPulga(p, ids) { pushEvent(p, { type: 'pulga', playerIds: ids }); }

// Adiciona um jogador no meio da partida
function entrarJogador(p, jogador) {
  if (p.players.some(pl => pl.id === jogador.id)) { toast('Esse jogador já está na partida'); return false; }
  if (p.players.length >= 8) { toast('Máximo de 8 jogadores'); return false; }
  p.players.push({ id: jogador.id, nome: jogador.nome });
  pushEvent(p, { type: 'entrar', playerId: jogador.id });
  return true;
}

function applyRound(p, rodada) {
  pushEvent(p, {
    type: 'round',
    batedorId: rodada.batedorId || null,
    foraIds: [...(rodada.foraIds || [])],
    pontos: { ...(rodada.pontos || {}) },
  });
  const last = p.rounds[p.rounds.length - 1];
  return { estourou: last ? last.estourou : [] };
}

function editarRound(p, evIndex, rodada) {
  p.events[evIndex] = {
    type: 'round',
    batedorId: rodada.batedorId || null,
    foraIds: [...(rodada.foraIds || [])],
    pontos: { ...(rodada.pontos || {}) },
  };
  recompute(p); persist(p);
}

function excluirRound(p, evIndex) {
  p.events.splice(evIndex, 1);
  recompute(p); persist(p);
}

function doVolta(p, playerId) { pushEvent(p, { type: 'volta', playerId }); }

function eliminar(p, playerId) {
  p.events.push({ type: 'eliminar', playerId });
  recompute(p);
  const ativos = activePlayers(p);
  if (ativos.length <= 1 && !p.finalizada) {
    p.events.push({ type: 'finalizar', vencedorId: ativos[0] ? ativos[0].id : null });
    recompute(p);
  }
  persist(p);
}

function finalizar(p, vencedorId) {
  // O vencedor "bate" a última mão: leva a batida de cada jogador ativo; depois encerra.
  if (vencedorId && activePlayers(p).length > 1) {
    p.events.push({ type: 'round', batedorId: vencedorId, foraIds: [], pontos: {} });
  }
  p.events.push({ type: 'finalizar', vencedorId });
  recompute(p);
  persist(p);
}

// Jogadores já resolvidos (volta/cai fora) DESDE a última rodada — não podem repetir na mesma rodada
function resolvedThisRound(p) {
  let lastRound = -1;
  (p.events || []).forEach((e, i) => { if (e.type === 'round') lastRound = i; });
  const s = new Set();
  for (let i = lastRound + 1; i < p.events.length; i++) {
    const e = p.events[i];
    if (e.type === 'volta' || e.type === 'eliminar') s.add(e.playerId);
  }
  return s;
}

/* ========================= Online (Firebase) ============================= */
let fbAuth = null, fbDB = null, fbReady = null;
function initFirebase() {
  if (fbReady) return fbReady;
  if (typeof firebase === 'undefined' || typeof FIREBASE_CONFIG === 'undefined') {
    fbReady = Promise.reject(new Error('Firebase indisponível (offline?)'));
    return fbReady;
  }
  try {
    if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    fbAuth = firebase.auth();
    fbDB = firebase.firestore();
    fbReady = fbAuth.signInAnonymously().then(c => c.user);
  } catch (e) { fbReady = Promise.reject(e); }
  return fbReady;
}

let _toastTs = 0;
function toastOnce(msg) { const n = Date.now(); if (n - _toastTs > 4000) { _toastTs = n; toast(msg); } }

// Salva local e, se for o dono de um jogo online, envia para a nuvem
function persist(p) {
  DB.save(state);
  if (p && p.online && p.online.role === 'host') syncUp(p);
}

function gameDocData(p, uid) {
  return {
    hostUid: uid,
    data: p.data, valorPartida: p.valorPartida, valorBatida: p.valorBatida, limite: p.limite,
    players: p.players.map(pl => ({ id: pl.id, nome: pl.nome })),
    events: JSON.parse(JSON.stringify(p.events)),
    finalizada: !!p.finalizada,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  };
}

async function syncUp(p) {
  try {
    const user = await initFirebase();
    p.online.hostUid = user.uid;
    await fbDB.collection('games').doc(p.online.code).set(gameDocData(p, user.uid));
  } catch (e) { console.warn('sync falhou', e); toastOnce('Sem conexão — sincroniza quando voltar'); }
}

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = ''; for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function goOnline(p) {
  try {
    const user = await initFirebase();
    p.online = { code: genCode(), role: 'host', hostUid: user.uid };
    await fbDB.collection('games').doc(p.online.code).set(gameDocData(p, user.uid));
    DB.save(state); render();
    toast('Ao vivo! Código: ' + p.online.code);
  } catch (e) { console.warn(e); toast('Não foi possível ativar o online'); }
}

/* ---- Espectador (só acompanha) ---- */
let viewerGame = null, viewerUnsub = null, viewerErr = null, viewerCode = '';
function stopViewer() { if (viewerUnsub) { viewerUnsub(); viewerUnsub = null; } viewerGame = null; viewerErr = null; }
function buildViewerGame(d, code) {
  const g = {
    id: 'viewer', data: d.data, valorPartida: d.valorPartida, valorBatida: d.valorBatida,
    limite: d.limite || 100, players: d.players || [], events: d.events || [],
    st: {}, rounds: [], pendingPulgas: [], finalizada: false, vencedorId: null,
    online: { code, role: 'viewer' },
  };
  recompute(g);
  return g;
}
async function joinOnline(code) {
  code = (code || '').trim().toUpperCase();
  if (!code) { toast('Digite o código do jogo'); return; }
  viewerCode = code;
  try {
    await initFirebase();
    stopViewer();
    currentScreen = 'viewer'; render();
    viewerUnsub = fbDB.collection('games').doc(code).onSnapshot(
      snap => {
        if (!snap.exists) { viewerErr = 'Jogo não encontrado. Confira o código.'; viewerGame = null; }
        else { viewerGame = buildViewerGame(snap.data(), code); viewerErr = null; }
        if (currentScreen === 'viewer') render();
      },
      err => { viewerErr = 'Erro ao conectar (verifique as Regras do Firestore).'; console.warn(err); if (currentScreen === 'viewer') render(); }
    );
  } catch (e) { console.warn(e); toast('Não foi possível conectar'); }
}
function leaveViewer() { stopViewer(); currentScreen = 'home'; render(); }

/* ============================== RENDER ==================================== */
const appRoot = () => document.getElementById('app');

function render() {
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.screen === currentScreen && currentScreen !== 'viewer'));
  if (currentScreen === 'viewer') return renderViewer();
  if (currentScreen === 'history') return renderHistory();
  if (currentScreen === 'dinheiro') return renderDinheiro();
  if (currentScreen === 'players') return renderJogadores();
  const p = currentPartida();
  if (!p) return renderSetup();
  return renderGame(p);
}

/* --------------------------- Tela do espectador -------------------------- */
function renderViewer() {
  const root = appRoot();
  root.innerHTML = '';
  const ob = document.querySelector('.fab-bar'); if (ob) ob.remove();

  const top = el(`
    <div class="card" style="display:flex;align-items:center;gap:10px;background:#eaf2ff">
      <span>👁️ <b>Ao vivo</b> — código <b class="codebig">${viewerCode}</b></span>
      <div class="spacer"></div>
      <button class="btn ghost sm" id="leave">Sair</button>
    </div>`);
  top.querySelector('#leave').addEventListener('click', leaveViewer);
  root.appendChild(top);

  if (viewerErr) {
    const c = el(`<div class="card"><p>${viewerErr}</p><button class="btn primary full" id="retry">Tentar de novo</button></div>`);
    c.querySelector('#retry').addEventListener('click', () => joinOnline(viewerCode));
    root.appendChild(c);
    return;
  }
  if (!viewerGame) {
    root.appendChild(el('<div class="empty"><div class="big">📡</div>Conectando ao jogo…</div>'));
    return;
  }

  const p = viewerGame;
  root.appendChild(el(`
    <div class="game-head">
      <div class="pill">Data <b>${formatDatePT(p.data)}</b></div>
      <div class="pill">Partida <b>${money(p.valorPartida)}</b></div>
      <div class="pill">Batida/Pulga <b>${money(p.valorBatida)}</b></div>
      <div class="pill pote">Pote <b>${money(poteProjetado(p))}</b></div>
      <div class="pill">Rodadas <b>${p.rounds.length}</b></div>
    </div>`));
  root.appendChild(buildBoard(p, false));

  const resolvidoV = resolvedThisRound(p);
  const risco = p.players.filter(pl => p.st.ativo[pl.id] && p.st.pontos[pl.id] >= p.limite && !resolvidoV.has(pl.id));
  if (risco.length) {
    const box = el(`<div class="card"><h2>⚠️ Passaram de ${p.limite} pontos</h2></div>`);
    risco.forEach(pl => box.appendChild(el(`<div style="margin-bottom:4px"><b>${pl.nome}</b> — ${p.st.pontos[pl.id]} pts</div>`)));
    root.appendChild(box);
  }
  if (p.finalizada) {
    const v = p.players.find(pl => pl.id === p.vencedorId);
    root.appendChild(el(`<div class="card" style="text-align:center;background:var(--green)"><h2>🏆 Vencedor: ${v ? v.nome : '—'}</h2></div>`));
  }
}

/* ------------------------------ Setup ------------------------------------ */
let setupSel = new Set(); // ids dos jogadores selecionados p/ a próxima partida

function renderSetup() {
  const root = appRoot();
  root.innerHTML = '';
  const oldBar = document.querySelector('.fab-bar'); if (oldBar) oldBar.remove();

  // Mantém na seleção só ids que ainda existem no cadastro
  setupSel = new Set([...setupSel].filter(id => state.jogadores.some(j => j.id === id)));

  const card = el(`
    <div class="card">
      <h2>Nova partida</h2>
      <div class="row wrap" style="gap:10px">
        <label class="field" style="flex:1;min-width:140px">
          <span>Data</span>
          <input type="date" id="f-data" value="${todayISO()}">
        </label>
        <label class="field" style="flex:1;min-width:110px">
          <span>Valor partida</span>
          <input type="number" id="f-partida" inputmode="decimal" step="0.5" value="5">
        </label>
        <label class="field" style="flex:1;min-width:110px">
          <span>Valor batida / pulga</span>
          <input type="number" id="f-batida" inputmode="decimal" step="0.5" value="2">
        </label>
      </div>
      <div class="field"><span>Quem vai jogar? (2 a 8) — toque para selecionar</span></div>
      <div class="chips" id="roster-chips"></div>
      <div class="row" style="gap:8px;margin-top:10px">
        <input type="text" id="quick-name" placeholder="Cadastrar novo jogador">
        <button class="btn ghost sm" id="quick-add">+ Add</button>
      </div>
      <div style="height:14px"></div>
      <button class="btn primary full" id="start-game">Iniciar partida</button>
    </div>
  `);
  root.appendChild(card);

  const chips = card.querySelector('#roster-chips');
  function drawChips() {
    chips.innerHTML = '';
    if (!state.jogadores.length) {
      chips.appendChild(el('<p class="muted">Nenhum jogador cadastrado. Adicione abaixo ou na aba <b>Jogadores</b>.</p>'));
      return;
    }
    state.jogadores.forEach(j => {
      const on = setupSel.has(j.id);
      const chip = el(`<button class="chip ${on ? 'on' : ''}">${j.nome}</button>`);
      chip.addEventListener('click', () => {
        if (on) setupSel.delete(j.id);
        else {
          if (setupSel.size >= 8) { toast('Máximo de 8 jogadores'); return; }
          setupSel.add(j.id);
        }
        drawChips();
      });
      chips.appendChild(chip);
    });
  }
  drawChips();

  function quickAdd() {
    const inp = card.querySelector('#quick-name');
    const j = addJogador(inp.value);
    if (j) { setupSel.add(j.id); inp.value = ''; drawChips(); inp.focus(); }
  }
  card.querySelector('#quick-add').addEventListener('click', quickAdd);
  card.querySelector('#quick-name').addEventListener('keydown', e => { if (e.key === 'Enter') quickAdd(); });

  card.querySelector('#start-game').addEventListener('click', () => {
    const data = card.querySelector('#f-data').value || todayISO();
    const valorPartida = Number(card.querySelector('#f-partida').value);
    const valorBatida = Number(card.querySelector('#f-batida').value);
    const sel = state.jogadores.filter(j => setupSel.has(j.id));
    if (sel.length < 2) { toast('Selecione pelo menos 2 jogadores'); return; }
    if (!valorPartida || !valorBatida) { toast('Informe os valores'); return; }
    const p = newPartida({ data, valorPartida, valorBatida, players: sel });
    state.partidas.push(p);
    DB.save(state);
    setupSel = new Set();
    render();
  });

  // Acompanhar um jogo ao vivo (espectador)
  const watch = el(`
    <div class="card">
      <h2>👁️ Acompanhar um jogo ao vivo</h2>
      <p class="muted">Digite o código que o dono do jogo compartilhou.</p>
      <div class="row" style="gap:8px">
        <input type="text" id="watch-code" placeholder="Ex: ABCDE" maxlength="6" style="text-transform:uppercase;letter-spacing:2px;font-weight:800">
        <button class="btn primary" id="watch-btn">Assistir</button>
      </div>
    </div>`);
  const watchGo = () => joinOnline(watch.querySelector('#watch-code').value);
  watch.querySelector('#watch-btn').addEventListener('click', watchGo);
  watch.querySelector('#watch-code').addEventListener('keydown', e => { if (e.key === 'Enter') watchGo(); });
  root.appendChild(watch);

  if (state.partidas.length) {
    root.appendChild(el(`<p class="muted" style="text-align:center">Você tem ${state.partidas.length} partida(s) no histórico.</p>`));
  }
}

/* -------------------------- Tela de Jogadores ---------------------------- */
function renderJogadores() {
  const root = appRoot();
  root.innerHTML = '';
  const oldBar = document.querySelector('.fab-bar'); if (oldBar) oldBar.remove();

  const addCard = el(`
    <div class="card">
      <h2>Cadastrar jogador</h2>
      <div class="row" style="gap:8px">
        <input type="text" id="new-name" placeholder="Nome do jogador">
        <button class="btn primary" id="add-btn">Adicionar</button>
      </div>
    </div>`);
  function doAdd() {
    const inp = addCard.querySelector('#new-name');
    if (addJogador(inp.value)) { inp.value = ''; render(); inp.focus(); }
  }
  addCard.querySelector('#add-btn').addEventListener('click', doAdd);
  addCard.querySelector('#new-name').addEventListener('keydown', e => { if (e.key === 'Enter') doAdd(); });
  root.appendChild(addCard);

  const stats = computeStats();
  const listCard = el('<div class="card"><h2>Jogadores cadastrados</h2></div>');
  if (!state.jogadores.length) {
    listCard.appendChild(el('<p class="muted">Ninguém cadastrado ainda.</p>'));
  } else {
    state.jogadores.forEach(j => {
      const s = stats[j.id] || { partidas: 0, vitorias: 0, pulgas: 0, saldo: 0 };
      const cls = s.saldo >= 0 ? 'pos' : 'neg';
      const row = el(`
        <div class="jog-row">
          <div class="jog-info">
            <div class="jog-name">${j.nome}</div>
            <div class="muted jog-stats">
              ${s.partidas} partidas · 🏆 ${s.vitorias} · 🐛 ${s.pulgas} ·
              <span class="money ${cls}">${money(s.saldo)}</span>
            </div>
          </div>
          <div class="row" style="gap:6px">
            <button class="btn ghost sm" data-act="edit">Editar</button>
            <button class="btn ghost sm" data-act="del">Excluir</button>
          </div>
        </div>`);
      row.querySelector('[data-act="edit"]').addEventListener('click', () => {
        const novo = prompt('Novo nome:', j.nome);
        if (novo != null) { renameJogador(j.id, novo); render(); }
      });
      row.querySelector('[data-act="del"]').addEventListener('click', () => {
        const msg = s.partidas ? `${j.nome} tem ${s.partidas} partida(s) no histórico. Excluir do cadastro? (o histórico das partidas é mantido)` : `Excluir ${j.nome}?`;
        if (confirm(msg)) { removeJogador(j.id); render(); }
      });
      listCard.appendChild(row);
    });
  }
  root.appendChild(listCard);

  // Backup: exportar / importar
  const backup = el(`
    <div class="card">
      <h2>💾 Backup dos dados</h2>
      <p class="muted">Salve seus jogadores e histórico num arquivo e leve para outro aparelho. A importação <b>soma</b> aos dados atuais (não apaga).</p>
      <div class="row" style="gap:8px;flex-wrap:wrap">
        <button class="btn primary" id="export-btn">⬆️ Exportar backup</button>
        <button class="btn ghost" id="import-btn">⬇️ Importar backup</button>
        <input type="file" id="import-file" accept="application/json,.json" hidden>
      </div>
    </div>`);
  backup.querySelector('#export-btn').addEventListener('click', exportBackup);
  const fileInput = backup.querySelector('#import-file');
  backup.querySelector('#import-btn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files[0]) importBackup(fileInput.files[0]);
    fileInput.value = '';
  });
  root.appendChild(backup);
}

/* ------------------------------ Jogo ------------------------------------- */
function statusOf(p, pl) {
  if (!p.st.ativo[pl.id]) return 'elim';
  if (p.st.pontos[pl.id] >= p.limite) return 'risco';
  return 'ativo';
}

function renderGame(p) {
  const root = appRoot();
  root.innerHTML = '';

  const head = el(`
    <div class="game-head">
      <div class="pill">Data <b>${formatDatePT(p.data)}</b></div>
      <div class="pill">Partida <b>${money(p.valorPartida)}</b></div>
      <div class="pill">Batida/Pulga <b>${money(p.valorBatida)}</b></div>
      <div class="pill pote">Pote <b>${money(poteProjetado(p))}</b></div>
      <div class="pill">Rodadas <b>${p.rounds.length}</b></div>
    </div>`);
  root.appendChild(head);

  if (p.online && p.online.role === 'host') {
    const b = el(`
      <div class="card" style="background:#eaf2ff;display:flex;align-items:center;gap:10px">
        <span>📡 <b>Ao vivo</b> — outros acompanham com o código <b class="codebig">${p.online.code}</b></span>
        <div class="spacer"></div>
        <button class="btn ghost sm" id="copy-code">Copiar</button>
      </div>`);
    b.querySelector('#copy-code').addEventListener('click', () => {
      const link = location.origin + location.pathname + '#ver=' + p.online.code;
      if (navigator.clipboard) navigator.clipboard.writeText(link).then(() => toast('Link copiado!'), () => toast('Código: ' + p.online.code));
      else toast('Código: ' + p.online.code);
    });
    root.appendChild(b);
  }

  if (!p.finalizada) {
    const toolbar = el(`
      <div class="row" style="gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
        <button class="btn ghost sm" id="add-player-btn">+ Jogador</button>
        ${p.online ? '' : '<button class="btn ghost sm" id="online-btn">📡 Jogar online</button>'}
        <span class="muted" style="font-size:12px">Toque no <b>Rx&nbsp;✎</b> para editar a rodada</span>
      </div>`);
    toolbar.querySelector('#add-player-btn').addEventListener('click', () => openAddPlayerModal(p));
    const ob = toolbar.querySelector('#online-btn');
    if (ob) ob.addEventListener('click', () => goOnline(p));
    root.appendChild(toolbar);
  }

  root.appendChild(buildBoard(p, !p.finalizada));

  // Banner de pulgas pendentes
  if (p.pendingPulgas.length) {
    const nomes = p.pendingPulgas.map(id => p.players.find(x => x.id === id).nome).join(', ');
    const banner = el(`
      <div class="card" style="background:#e8f6ec;display:flex;align-items:center;gap:10px">
        <span>🐛 Pulga registrada: <b>${nomes}</b> — entra na próxima rodada.</span>
        <div class="spacer"></div>
        <button class="btn ghost sm" id="undo-pulga">Desfazer</button>
      </div>`);
    banner.querySelector('#undo-pulga').addEventListener('click', () => {
      undoLast(p); render();
    });
    root.appendChild(banner);
  }

  // Aviso: passaram de 100 (volta / cai fora). Quem já resolveu nesta rodada some daqui.
  const resolvido = resolvedThisRound(p);
  const risco = p.players.filter(pl => p.st.ativo[pl.id] && p.st.pontos[pl.id] >= p.limite && !resolvido.has(pl.id));
  if (risco.length) {
    const box = el(`<div class="card"><h2>⚠️ Passaram de ${p.limite} pontos</h2></div>`);
    risco.forEach(pl => {
      const proxVolta = p.valorPartida * (p.st.voltas[pl.id] + 2); // quanto passará a dever se voltar
      const rowEl = el(`
        <div class="row" style="justify-content:space-between;margin-bottom:10px">
          <div><b>${pl.nome}</b> — ${p.st.pontos[pl.id]} pts</div>
          <div class="btnbar">
            <button class="btn yellow sm" data-act="volta" title="Volta com os pontos do maior. No fim pagará ${money(proxVolta)}">Volta</button>
            <button class="btn red sm" data-act="elim">Cai fora</button>
          </div>
        </div>`);
      rowEl.querySelector('[data-act="volta"]').addEventListener('click', () => {
        doVolta(p, pl.id);
        toast(`${pl.nome} voltou (${p.st.voltas[pl.id]}ª vez)`);
        render();
      });
      rowEl.querySelector('[data-act="elim"]').addEventListener('click', () => {
        eliminar(p, pl.id);
        toast(p.finalizada ? 'Partida encerrada!' : `${pl.nome} saiu da partida`);
        if (p.finalizada) currentScreen = 'history';
        render();
      });
      box.appendChild(rowEl);
    });
    root.appendChild(box);
  }

  if (p.finalizada) {
    const v = p.players.find(pl => pl.id === p.vencedorId);
    const card = el(`
      <div class="card" style="text-align:center;background:var(--green);">
        <h2>🏆 Vencedor: ${v ? v.nome : '—'}</h2>
        <p class="muted">Partida encerrada. Saldos finais (com o valor da partida) acima.</p>
        <button class="btn ghost sm" id="reabrir">↺ Reabrir partida</button>
      </div>`);
    card.querySelector('#reabrir').addEventListener('click', () => {
      undoLast(p); toast('Partida reaberta'); render();
    });
    root.appendChild(card);
  }

  // Barra fixa
  const oldBar = document.querySelector('.fab-bar');
  if (oldBar) oldBar.remove();
  if (!p.finalizada) {
    const bar = el(`
      <div class="fab-bar">
        <button class="btn ghost" id="undo" title="Desfazer última ação">↺</button>
        <button class="btn ghost" id="finish">Ganhador</button>
        <button class="btn green" id="pulga-btn">🐛 Pulga</button>
        <button class="btn primary" id="new-round">+ Rodada</button>
      </div>`);
    const undoBtn = bar.querySelector('#undo');
    undoBtn.disabled = !p.events.length;
    undoBtn.style.flex = '0 0 52px';
    undoBtn.addEventListener('click', () => { undoLast(p); render(); });
    bar.querySelector('#new-round').addEventListener('click', () => openRoundModal(p));
    bar.querySelector('#pulga-btn').addEventListener('click', () => openPulgaModal(p));
    bar.querySelector('#finish').addEventListener('click', () => openFinishModal(p));
    document.body.appendChild(bar);
  }
}

function buildBoard(p, editable) {
  const wrap = el('<div class="board-scroll"></div>');
  const table = el('<table class="board"></table>');

  // Cabeçalho PONTOS (totais)
  const theadP = el('<thead class="pontos"></thead>');
  const trTotP = el('<tr></tr>');
  trTotP.appendChild(el('<th style="background:#f2d600">PONTOS</th>'));
  p.players.forEach(pl => trTotP.appendChild(el(`<th class="total-pts">${p.st.pontos[pl.id]}</th>`)));
  const trNameP = el('<tr></tr>');
  trNameP.appendChild(el('<th></th>'));
  p.players.forEach(pl => {
    const s = statusOf(p, pl);
    const winLose = p.st.fechado ? (pl.id === p.vencedorId ? 'win' : 'lose') : '';
    const chip = s === 'elim' ? '<span class="status-chip elim">FORA</span>'
      : s === 'risco' ? '<span class="status-chip risco">+100</span>'
      : `<span class="status-chip ativo">${p.st.voltas[pl.id] ? 'V' + p.st.voltas[pl.id] : 'ok'}</span>`;
    trNameP.appendChild(el(`<th class="name ${winLose}">${pl.nome}<br>${chip}</th>`));
  });
  theadP.appendChild(trTotP);
  theadP.appendChild(trNameP);
  table.appendChild(theadP);

  // Corpo: uma linha por rodada
  const tbody = el('<tbody></tbody>');
  p.rounds.forEach(r => {
    const tr = el('<tr></tr>');
    const pulgaLabel = (r.pulgaIds && r.pulgaIds.length) ? ' 🐛' : '';
    // Só rodadas com batida (evento 'round') podem ser editadas
    const canEdit = editable && r.evIndex != null && r.batedorId;
    const rlabel = el(`<td class="rlabel ${canEdit ? 'editable' : 'muted'}">R${r.n}${pulgaLabel}${canEdit ? ' ✎' : ''}</td>`);
    if (canEdit) rlabel.addEventListener('click', () => openRoundEditModal(p, r.evIndex));
    tr.appendChild(rlabel);
    p.players.forEach(pl => {
      tr.appendChild(el(`<td>${roundMark(p, r, pl.id)}</td>`));
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  // Cabeçalho + totais DINHEIRO
  const theadD = el('<thead class="dinheiro"></thead>');
  const trTotD = el('<tr></tr>');
  trTotD.appendChild(el('<th style="background:#b6e3b6">DINHEIRO</th>'));
  p.players.forEach(pl => {
    const v = saldoExibido(p, pl.id);
    const cls = v >= 0 ? 'pos' : 'neg';
    const winLose = p.st.fechado ? (pl.id === p.vencedorId ? 'win' : 'lose') : '';
    trTotD.appendChild(el(`<th class="money ${cls} ${winLose}">${money(v)}</th>`));
  });
  theadD.appendChild(trTotD);
  table.appendChild(theadD);

  wrap.appendChild(table);
  return wrap;
}

function roundMark(p, r, playerId) {
  // Voltou nesta rodada: célula azul com os pontos do maior
  const volta = (r.voltas || []).find(v => v.playerId === playerId);
  if (volta) return `<span class="cell-volta">${volta.pontos}</span>`;
  // Não estava ativo nesta rodada: se já tinha caído fora, mostra X; se entrou depois, em branco
  if (r.activeIds && !r.activeIds.includes(playerId)) {
    if (r.foraAcum && r.foraAcum.includes(playerId)) return '<span class="round-mark sign">X</span>';
    return '';
  }
  if (r.batedorId === playerId) return '<span class="round-mark sign">–</span>';
  const isPulga = (r.pulgaIds || []).includes(playerId);
  if ((r.foraIds || []).includes(playerId)) return '<span class="round-mark sign">X</span>';
  const v = r.pontos[playerId];
  const base = (v || v === 0) ? `${v}` : '';
  if (isPulga) return `<span class="round-mark">🐛${base && base !== '0' ? ' ' + base : ''}</span>`;
  return base;
}

/* ------------------- Modal: adicionar jogador no meio -------------------- */
function openAddPlayerModal(p) {
  const maxP = Math.max(0, ...activePlayers(p).map(pl => p.st.pontos[pl.id]));
  const maxV = Math.max(0, ...activePlayers(p).map(pl => p.st.voltas[pl.id]));
  const disponiveis = state.jogadores.filter(j => !p.players.some(pl => pl.id === j.id));

  const body = el(`
    <div class="modal">
      <div class="row"><h2>+ Jogador na partida</h2><div class="spacer"></div>
        <button class="btn ghost sm close">Fechar</button></div>
      <p class="muted">Entra com <b>${maxP} pts</b> (a maior pontuação atual)${maxV ? ` e <b>${maxV} volta(s)</b>` : ''}, valendo a partir da próxima rodada.</p>
      <div class="round-players" id="disp-list"></div>
      <div class="row" style="gap:8px;margin-top:10px">
        <input type="text" id="new-extra" placeholder="Ou cadastrar novo jogador">
        <button class="btn ghost sm" id="add-extra">+ Add</button>
      </div>
    </div>`);

  const list = body.querySelector('#disp-list');
  function drawList() {
    list.innerHTML = '';
    const disp = state.jogadores.filter(j => !p.players.some(pl => pl.id === j.id));
    if (!disp.length) { list.appendChild(el('<p class="muted">Todos os jogadores cadastrados já estão na partida.</p>')); return; }
    disp.forEach(j => {
      const b = el(`<button class="rp-toggle" style="text-align:left">${j.nome}</button>`);
      b.addEventListener('click', () => {
        if (entrarJogador(p, j)) { closeModal(); toast(`${j.nome} entrou na partida`); render(); }
      });
      list.appendChild(b);
    });
  }
  drawList();

  function addExtra() {
    const inp = body.querySelector('#new-extra');
    const j = addJogador(inp.value);
    if (j) { if (entrarJogador(p, j)) { closeModal(); toast(`${j.nome} entrou na partida`); render(); } }
  }
  body.querySelector('#add-extra').addEventListener('click', addExtra);
  body.querySelector('#new-extra').addEventListener('keydown', e => { if (e.key === 'Enter') addExtra(); });
  body.querySelector('.close').addEventListener('click', closeModal);
  showModal(body);
}

/* --------------------------- Modal de pulga ------------------------------ */
function openPulgaModal(p) {
  // Só uma pulga por rodada
  if (p.pendingPulgas.length) {
    const nome = p.players.find(x => x.id === p.pendingPulgas[0]).nome;
    toast(`Já há pulga de ${nome} nesta rodada. Use ↺ Desfazer para trocar.`);
    return;
  }
  const ativos = activePlayers(p);
  let selId = null;
  const body = el(`
    <div class="modal">
      <div class="row"><h2>🐛 Registrar pulga</h2><div class="spacer"></div>
        <button class="btn ghost sm close">Fechar</button></div>
      <p class="muted">Quem mostrou a pulguinha? (só uma por rodada) Recebe ${money(p.valorBatida)} de cada jogador ativo. Entra na próxima rodada.</p>
      <div class="round-players"></div>
      <div style="height:14px"></div>
      <button class="btn green full" id="save-pulga">Registrar</button>
    </div>`);
  const listEl = body.querySelector('.round-players');
  ativos.forEach(pl => {
    const b = el(`<button class="rp-toggle pulga" style="text-align:left">${pl.nome}</button>`);
    b.addEventListener('click', () => {
      // seleção única
      selId = (selId === pl.id) ? null : pl.id;
      listEl.querySelectorAll('.rp-toggle').forEach(x => x.classList.remove('on'));
      if (selId) b.classList.add('on');
    });
    listEl.appendChild(b);
  });
  body.querySelector('#save-pulga').addEventListener('click', () => {
    if (!selId) { toast('Selecione quem pegou a pulga'); return; }
    registrarPulga(p, [selId]);
    closeModal(); render();
    toast('Pulga registrada!');
  });
  body.querySelector('.close').addEventListener('click', closeModal);
  showModal(body);
}

/* --------------------------- Modal de rodada ----------------------------- */
// Falta preencher: jogador ativo que não é o batedor, não está "fora" e não tem pontos
function pontoVazio(v) { return v === undefined || v === null || String(v).trim() === ''; }

function openRoundModal(p) {
  const ativos = activePlayers(p);
  const draft = { batedorId: null, foraIds: [], pontos: {} };
  let tentou = false;
  const falta = (pl) => pl.id !== draft.batedorId && !draft.foraIds.includes(pl.id) && pontoVazio(draft.pontos[pl.id]);

  const body = el(`
    <div class="modal">
      <div class="row"><h2>Nova rodada</h2><div class="spacer"></div>
        <button class="btn ghost sm close">Fechar</button></div>
      <p class="muted">Marque quem <b>bateu</b> (–). Cada um dos outros precisa ter os <b>pontos</b> digitados ou o <b>X Fora</b> marcado. <b>X Fora = sai da partida</b> (nas próximas rodadas já aparece fora e não soma mais). Pulga é no botão 🐛.</p>
      <div class="round-players"></div>
      <div style="height:14px"></div>
      <button class="btn primary full" id="save-round">Salvar rodada</button>
    </div>`);

  const listEl = body.querySelector('.round-players');

  function refresh() {
    listEl.innerHTML = '';
    ativos.forEach(pl => {
      const isBat = draft.batedorId === pl.id;
      const isFora = draft.foraIds.includes(pl.id);
      const missing = tentou && falta(pl);
      const rp = el(`
        <div class="rp ${isBat ? 'is-bat' : ''} ${isFora ? 'is-fora' : ''} ${missing ? 'rp-missing' : ''}">
          <div class="rp-name">${pl.nome} <span class="muted">(${p.st.pontos[pl.id]})</span></div>
          <input class="rp-pts" type="number" inputmode="numeric" placeholder="pts"
                 value="${draft.pontos[pl.id] ?? ''}" ${isBat ? 'disabled' : ''}>
          <div class="row" style="gap:6px">
            <button class="rp-toggle bat ${isBat ? 'on' : ''}" data-t="bat">– Bateu</button>
            <button class="rp-toggle fora ${isFora ? 'on' : ''}" data-t="fora">X Fora</button>
          </div>
        </div>`);

      const ptsInput = rp.querySelector('.rp-pts');
      ptsInput.addEventListener('input', () => {
        draft.pontos[pl.id] = ptsInput.value;
        if (tentou) rp.classList.toggle('rp-missing', falta(pl));
      });

      rp.querySelector('[data-t="bat"]').addEventListener('click', () => {
        // Só um batedor: define este e limpa qualquer outro automaticamente
        draft.batedorId = isBat ? null : pl.id;
        if (draft.batedorId === pl.id) {
          draft.foraIds = draft.foraIds.filter(x => x !== pl.id);
          delete draft.pontos[pl.id];
        }
        refresh();
      });
      rp.querySelector('[data-t="fora"]').addEventListener('click', () => {
        if (isFora) draft.foraIds = draft.foraIds.filter(x => x !== pl.id);
        else {
          draft.foraIds.push(pl.id);
          if (draft.batedorId === pl.id) draft.batedorId = null;
          delete draft.pontos[pl.id];
        }
        refresh();
      });

      listEl.appendChild(rp);
    });
  }
  refresh();

  body.querySelector('#save-round').addEventListener('click', () => {
    if (!draft.batedorId) { toast('Marque quem bateu (–)'); return; }
    const faltam = ativos.filter(falta);
    if (faltam.length) {
      tentou = true; refresh();
      toast('Falta pontos ou "Fora": ' + faltam.map(x => x.nome).join(', '));
      return;
    }
    // Registra a rodada; quem levou X Fora SAI da partida (elimina a partir da próxima rodada)
    p.events.push({ type: 'round', batedorId: draft.batedorId, foraIds: [...draft.foraIds], pontos: { ...draft.pontos } });
    draft.foraIds.forEach(id => p.events.push({ type: 'eliminar', playerId: id }));
    recompute(p);
    const rest = activePlayers(p);
    if (rest.length <= 1 && !p.finalizada) {
      p.events.push({ type: 'finalizar', vencedorId: rest[0] ? rest[0].id : null });
      recompute(p);
    }
    persist(p);
    closeModal();
    const estourou = (p.rounds[p.rounds.length - 1] || {}).estourou || [];
    if (p.finalizada) { currentScreen = 'history'; toast('Partida encerrada!'); }
    else if (estourou.length) toast('Alguém passou de ' + p.limite + ' pontos!');
    render();
  });
  body.querySelector('.close').addEventListener('click', closeModal);

  showModal(body);
}

/* ------------------- Editar / excluir uma rodada ------------------------- */
function activeIdsAtEvent(p, evIndex) {
  const ativo = Object.fromEntries(p.players.map(pl => [pl.id, true]));
  for (let i = 0; i < evIndex; i++) {
    const ev = p.events[i];
    if (ev.type === 'eliminar') ativo[ev.playerId] = false;
    else if (ev.type === 'volta') ativo[ev.playerId] = true;
  }
  return p.players.filter(pl => ativo[pl.id]).map(pl => pl.id);
}

function openRoundEditModal(p, evIndex) {
  const ev = p.events[evIndex];
  const ativos = activeIdsAtEvent(p, evIndex).map(id => p.players.find(pl => pl.id === id));
  const draft = {
    batedorId: ev.batedorId || null,
    foraIds: [...(ev.foraIds || [])],
    pontos: { ...(ev.pontos || {}) },
  };

  const body = el(`
    <div class="modal">
      <div class="row"><h2>Editar rodada</h2><div class="spacer"></div>
        <button class="btn ghost sm close">Fechar</button></div>
      <p class="muted">Ajuste quem bateu e os pontos. O placar e o dinheiro recalculam sozinhos.</p>
      <div class="round-players"></div>
      <div style="height:14px"></div>
      <div class="btnbar">
        <button class="btn red" id="del-round">Excluir rodada</button>
        <button class="btn primary" id="save-round">Salvar</button>
      </div>
    </div>`);

  let tentou = false;
  const falta = (pl) => pl.id !== draft.batedorId && !draft.foraIds.includes(pl.id) && pontoVazio(draft.pontos[pl.id]);

  const listEl = body.querySelector('.round-players');
  function refresh() {
    listEl.innerHTML = '';
    ativos.forEach(pl => {
      const isBat = draft.batedorId === pl.id;
      const isFora = draft.foraIds.includes(pl.id);
      const missing = tentou && falta(pl);
      const rp = el(`
        <div class="rp ${isBat ? 'is-bat' : ''} ${isFora ? 'is-fora' : ''} ${missing ? 'rp-missing' : ''}">
          <div class="rp-name">${pl.nome}</div>
          <input class="rp-pts" type="number" inputmode="numeric" placeholder="pts"
                 value="${draft.pontos[pl.id] ?? ''}" ${isBat ? 'disabled' : ''}>
          <div class="row" style="gap:6px">
            <button class="rp-toggle bat ${isBat ? 'on' : ''}" data-t="bat">– Bateu</button>
            <button class="rp-toggle fora ${isFora ? 'on' : ''}" data-t="fora">X Fora</button>
          </div>
        </div>`);
      const ptsInput = rp.querySelector('.rp-pts');
      ptsInput.addEventListener('input', () => {
        draft.pontos[pl.id] = ptsInput.value;
        if (tentou) rp.classList.toggle('rp-missing', falta(pl));
      });
      rp.querySelector('[data-t="bat"]').addEventListener('click', () => {
        draft.batedorId = isBat ? null : pl.id;
        if (draft.batedorId === pl.id) { draft.foraIds = draft.foraIds.filter(x => x !== pl.id); delete draft.pontos[pl.id]; }
        refresh();
      });
      rp.querySelector('[data-t="fora"]').addEventListener('click', () => {
        if (isFora) draft.foraIds = draft.foraIds.filter(x => x !== pl.id);
        else { draft.foraIds.push(pl.id); if (draft.batedorId === pl.id) draft.batedorId = null; delete draft.pontos[pl.id]; }
        refresh();
      });
      listEl.appendChild(rp);
    });
  }
  refresh();

  body.querySelector('#save-round').addEventListener('click', () => {
    if (!draft.batedorId) { toast('Marque quem bateu (–)'); return; }
    const faltam = ativos.filter(falta);
    if (faltam.length) {
      tentou = true; refresh();
      toast('Falta pontos ou "Fora": ' + faltam.map(x => x.nome).join(', '));
      return;
    }
    editarRound(p, evIndex, draft);
    closeModal(); toast('Rodada atualizada'); render();
  });
  body.querySelector('#del-round').addEventListener('click', () => {
    if (confirm('Excluir esta rodada? O placar recalcula.')) {
      excluirRound(p, evIndex);
      closeModal(); toast('Rodada excluída'); render();
    }
  });
  body.querySelector('.close').addEventListener('click', closeModal);
  showModal(body);
}

/* --------------------------- Modal encerrar ------------------------------ */
function openFinishModal(p) {
  const ativos = activePlayers(p);
  const body = el(`
    <div class="modal">
      <div class="row"><h2>Informar ganhador</h2><div class="spacer"></div>
        <button class="btn ghost sm close">Fechar</button></div>
      <p class="muted">Toque no vencedor. Ele fica <b style="color:var(--green-strong)">verde</b>, os demais em <b style="color:var(--red)">vermelho</b>, e cada não-vencedor paga o valor da partida × (nº de voltas + 1).</p>
      <div class="round-players"></div>
      <div style="height:12px"></div>
      <button class="btn red full" id="close-nowin">Encerrar sem vencedor</button>
    </div>`);
  const list = body.querySelector('.round-players');
  ativos.forEach(pl => {
    const b = el(`<button class="btn green full" style="margin-bottom:8px">${pl.nome} venceu</button>`);
    b.addEventListener('click', () => {
      finalizar(p, pl.id); closeModal(); toast(`${pl.nome} venceu!`);
      currentScreen = 'history'; render();
    });
    list.appendChild(b);
  });
  body.querySelector('#close-nowin').addEventListener('click', () => {
    finalizar(p, null); closeModal();
    currentScreen = 'history'; render();
  });
  body.querySelector('.close').addEventListener('click', closeModal);
  showModal(body);
}

/* ------------------------------ Dinheiro --------------------------------- */
let dinheiroPeriodo = 'mes'; // dia | semana | mes | ano | tudo
function inPeriodo(dataISO, periodo) {
  const hoje = todayISO();
  if (periodo === 'tudo') return true;
  if (periodo === 'dia') return dataISO === hoje;
  if (periodo === 'mes') return dataISO.slice(0, 7) === hoje.slice(0, 7);
  if (periodo === 'ano') return dataISO.slice(0, 4) === hoje.slice(0, 4);
  if (periodo === 'semana') {
    const diff = (new Date(hoje + 'T00:00:00') - new Date(dataISO + 'T00:00:00')) / 86400000;
    return diff >= 0 && diff < 7;
  }
  return true;
}

function renderDinheiro() {
  const root = appRoot();
  root.innerHTML = '';
  const ob = document.querySelector('.fab-bar'); if (ob) ob.remove();

  const periodos = [['dia', 'Hoje'], ['semana', 'Semana'], ['mes', 'Mês'], ['ano', 'Ano'], ['tudo', 'Tudo']];
  const sel = el(`<div class="chips" style="margin-bottom:12px">
    ${periodos.map(([k, l]) => `<button class="chip ${dinheiroPeriodo === k ? 'on' : ''}" data-p="${k}">${l}</button>`).join('')}
  </div>`);
  sel.querySelectorAll('[data-p]').forEach(b => b.addEventListener('click', () => { dinheiroPeriodo = b.dataset.p; render(); }));
  root.appendChild(sel);

  const parts = state.partidas.filter(p => p.finalizada && inPeriodo(p.data, dinheiroPeriodo));

  // Ranking do período
  const agg = {};
  parts.forEach(p => p.players.forEach(pl => {
    const s = agg[pl.id] || (agg[pl.id] = { nome: nomeJogador(pl.id, pl.nome), saldo: 0, pulgas: 0, vitorias: 0, partidas: 0 });
    s.saldo += saldoExibido(p, pl.id);
    s.pulgas += p.st.pulgas[pl.id] || 0;
    if (p.vencedorId === pl.id) s.vitorias += 1;
    s.partidas += 1;
  }));
  const rank = Object.values(agg).sort((a, b) => b.saldo - a.saldo);

  const lb = el('<div class="card"><h2>🏆 Ranking do período</h2></div>');
  if (!rank.length) {
    lb.appendChild(el('<p class="muted">Nenhuma partida encerrada neste período.</p>'));
  } else {
    rank.forEach((s, i) => {
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
      const cls = s.saldo >= 0 ? 'pos' : 'neg';
      lb.appendChild(el(`
        <div class="jog-row">
          <div class="jog-info">
            <div class="jog-name">${medal} ${s.nome}</div>
            <div class="muted jog-stats">${s.partidas} partidas · 🏆 ${s.vitorias} · 🐛 ${s.pulgas}</div>
          </div>
          <div class="money ${cls}" style="font-weight:800;font-size:17px">${money(s.saldo)}</div>
        </div>`));
    });
  }
  root.appendChild(lb);

  // Detalhe por dia / partida
  const byDay = {};
  parts.forEach(p => { (byDay[p.data] = byDay[p.data] || []).push(p); });
  const days = Object.keys(byDay).sort().reverse();
  days.forEach((day, di) => {
    const det = el(`<details class="hist-day" ${di === 0 ? 'open' : ''}><summary>${formatDatePT(day)} — ${byDay[day].length} partida(s)</summary></details>`);
    // Numera cronologicamente (1ª, 2ª...) e mostra a mais recente em cima
    const numeradas = byDay[day].map((p, i) => ({ p, n: i + 1 }));
    numeradas.reverse().forEach(({ p, n }) => {
      const venc = p.players.find(x => x.id === p.vencedorId);
      const num = String(n).padStart(2, '0');
      const card = el(`<div class="hist-partida"><div class="h-title">${num}ª Partida · ${money(p.valorPartida)}/${money(p.valorBatida)} ${venc ? `<span class="badge">🏆 ${venc.nome}</span>` : ''}</div></div>`);
      p.players.slice().sort((a, b) => saldoExibido(p, b.id) - saldoExibido(p, a.id)).forEach(pl => {
        const v = saldoExibido(p, pl.id); const cls = v >= 0 ? 'pos' : 'neg';
        const pulga = p.st.pulgas[pl.id] ? ` 🐛${p.st.pulgas[pl.id]}` : '';
        card.appendChild(el(`<div class="row" style="justify-content:space-between;padding:3px 0"><span>${nomeJogador(pl.id, pl.nome)}${pulga}</span><span class="money ${cls}">${money(v)}</span></div>`));
      });
      det.appendChild(card);
    });
    root.appendChild(det);
  });
}

/* ------------------------------ Histórico -------------------------------- */
function renderHistory() {
  const root = appRoot();
  root.innerHTML = '';
  const oldBar = document.querySelector('.fab-bar'); if (oldBar) oldBar.remove();

  if (!state.partidas.length) {
    root.appendChild(el('<div class="empty"><div class="big">🃏</div>Nenhuma partida ainda.<br>Comece um jogo na aba <b>Jogo</b>.</div>'));
    return;
  }

  const byDay = {};
  state.partidas.forEach(p => { (byDay[p.data] = byDay[p.data] || []).push(p); });
  const days = Object.keys(byDay).sort().reverse();

  // Ranking de pulgas (geral) — agrupado por jogador cadastrado
  const pulgaTotals = {};
  state.partidas.forEach(p => p.players.forEach(pl => {
    if (!pulgaTotals[pl.id]) pulgaTotals[pl.id] = { nome: nomeJogador(pl.id, pl.nome), v: 0 };
    pulgaTotals[pl.id].v += p.st.pulgas[pl.id] || 0;
  }));
  const rank = Object.values(pulgaTotals).filter(x => x.v > 0).sort((a, b) => b.v - a.v);
  if (rank.length) {
    const rk = el('<div class="card"><h2>🐛 Ranking de pulguinhas</h2></div>');
    rank.forEach((x, i) => rk.appendChild(el(
      `<div class="row" style="justify-content:space-between;padding:4px 0"><span>${i + 1}. ${x.nome}</span><span class="badge">${x.v}</span></div>`)));
    root.appendChild(rk);
  }

  days.forEach(day => {
    const det = el(`<details class="hist-day" ${day === days[0] ? 'open' : ''}><summary>${formatDatePT(day)} — ${byDay[day].length} partida(s)</summary></details>`);
    // Numera na ordem cronológica (1ª, 2ª...) e exibe a mais recente em cima
    const numeradas = byDay[day].map((p, i) => ({ p, n: i + 1 }));
    numeradas.reverse().forEach(({ p, n }) => det.appendChild(histCard(p, n)));
    root.appendChild(det);
  });

  root.appendChild(el('<div style="height:10px"></div>'));
  const clear = el('<button class="btn ghost full">Apagar todo o histórico</button>');
  clear.addEventListener('click', () => {
    if (confirm('Apagar TODAS as partidas? Esta ação não pode ser desfeita.')) {
      state.partidas = []; DB.save(state); render();
    }
  });
  root.appendChild(clear);
}

function histCard(p, numero) {
  const venc = p.players.find(pl => pl.id === p.vencedorId);
  const num = numero != null ? String(numero).padStart(2, '0') : '';
  const c = el(`<div class="hist-partida">
    <div class="h-title">${p.finalizada ? '✅' : '⏳'} ${num ? num + 'ª Partida' : 'Partida'} · ${money(p.valorPartida)}/${money(p.valorBatida)} — ${p.rounds.length} rodadas
    ${venc ? `<span class="badge">🏆 ${venc.nome}</span>` : ''}</div>
  </div>`);
  c.appendChild(buildBoard(p));
  if (!p.finalizada) {
    const cont = el('<button class="btn primary sm full" style="margin-top:10px">Continuar esta partida</button>');
    cont.addEventListener('click', () => { currentScreen = 'home'; render(); });
    c.appendChild(cont);
  } else {
    const del = el('<button class="btn ghost sm full" style="margin-top:10px">Excluir partida</button>');
    del.addEventListener('click', () => {
      if (confirm('Excluir esta partida?')) {
        state.partidas = state.partidas.filter(x => x.id !== p.id);
        DB.save(state); render();
      }
    });
    c.appendChild(del);
  }
  return c;
}

/* ------------------------------- Modal ----------------------------------- */
let _vvCleanup = null;
function showModal(node) {
  const rootM = document.getElementById('modal-root');
  const overlay = el('<div class="modal-overlay"></div>');
  overlay.appendChild(node);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });

  // Ao focar um campo, rola ele para a área visível (acima do teclado no celular)
  overlay.addEventListener('focusin', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) {
      setTimeout(() => { try { t.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) {} }, 300);
    }
  });

  rootM.appendChild(overlay);

  // Ajusta o modal ao teclado virtual usando visualViewport:
  // encolhe a "folha" para caber na área visível acima do teclado.
  if (window.visualViewport) {
    const vv = window.visualViewport;
    const apply = () => {
      overlay.style.top = vv.offsetTop + 'px';
      overlay.style.height = vv.height + 'px';
      overlay.style.bottom = 'auto';
      node.style.maxHeight = vv.height + 'px';
    };
    apply();
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    _vvCleanup = () => { vv.removeEventListener('resize', apply); vv.removeEventListener('scroll', apply); };
  }
}
function closeModal() {
  if (_vvCleanup) { _vvCleanup(); _vvCleanup = null; }
  document.getElementById('modal-root').innerHTML = '';
}

/* ------------------------------ Navegação -------------------------------- */
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    if (currentScreen === 'viewer') stopViewer();
    currentScreen = tab.dataset.screen;
    render();
  });
});

// Link compartilhado: .../pontinho/#ver=CODIGO abre direto como espectador
function checkDeepLink() {
  const m = (location.hash || '').match(/ver=([A-Za-z0-9]+)/);
  if (m) { joinOnline(m[1]); return true; }
  return false;
}
window.addEventListener('hashchange', checkDeepLink);

if (!checkDeepLink()) render();

/* ------------------------------ PWA -------------------------------------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW falhou', err));
  });
}

let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  if (document.getElementById('install-btn')) return;
  const b = el('<button id="install-btn" class="btn primary sm" style="margin-top:8px;width:100%">⬇️ Instalar o app no aparelho</button>');
  b.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null; b.remove();
  });
  document.querySelector('.topbar').appendChild(b);
});
window.addEventListener('appinstalled', () => {
  const b = document.getElementById('install-btn'); if (b) b.remove();
  toast('App instalado! 🎉');
});
