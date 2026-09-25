/* ==========================================================================
   Pontinho — controle de jogos de baralho (cacheta)
   Dados salvos localmente no dispositivo (localStorage).
   ========================================================================== */

'use strict';

/* ----------------------------- Persistência ------------------------------ */
const APP_VERSION = 'v50';
const STORE_KEY = 'pontinho:v1';

const DB = {
  load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return { partidas: [], jogadores: [] };
      const data = JSON.parse(raw);
      if (!data.partidas) data.partidas = [];
      if (!data.jogadores) data.jogadores = [];
      // Remove partidas quebradas (dados inválidos) para o app não travar
      data.partidas = data.partidas.filter(partidaValida);
      // Migração leve p/ campos novos (defensiva)
      data.partidas.forEach(p => {
        if (!p.pendingPulgas) p.pendingPulgas = [];
        if (!p.events) p.events = [];
        if (!p.st) p.st = {};
        if (!p.st.fecho) p.st.fecho = {};
        if (p.st.fechado === undefined) p.st.fechado = false;
        if (!Array.isArray(p.rounds)) p.rounds = [];
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
const money = (n) => { if (!Number.isFinite(n)) n = 0; return (n < 0 ? '-' : '') + Math.abs(n).toFixed(2).replace('.', ','); };
// Uma partida é válida se tem data, valores numéricos e pelo menos 2 jogadores
function partidaValida(p) {
  return !!p && typeof p === 'object'
    && typeof p.data === 'string' && p.data.indexOf('-') > -1
    && Number.isFinite(p.valorPartida) && Number.isFinite(p.valorBatida)
    && Array.isArray(p.players) && p.players.length >= 2
    && Array.isArray(p.events);
}
// Converte texto em Reais ("5,00", "1.234,50", "5") para número
const parseBRL = (v) => {
  let s = String(v == null ? '' : v).trim().replace(/[^\d.,]/g, '');
  if (s.indexOf(',') > -1) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
};
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; };

function todayISO() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}
// "Dia de jogo": vira só às 6h da manhã, para a madrugada contar como a mesma noite.
const GAME_DAY_CUTOFF_H = 6;
function gameDayISO() {
  const d = new Date();
  if (d.getHours() < GAME_DAY_CUTOFF_H) d.setDate(d.getDate() - 1);
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}
function formatDatePT(iso) {
  if (!iso || typeof iso !== 'string' || iso.indexOf('-') < 0) return '—';
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
// Quanto um jogador paga no fim: dobra a cada volta.
// nunca voltou = valorPartida×1; 1ª volta ×2; 2ª ×4; 3ª ×8... (= valorPartida × 2^voltas)
function dividaFinal(p, playerId) {
  return p.valorPartida * Math.pow(2, p.st.voltas[playerId]);
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
    criadoEm: Date.now(),   // para numerar as partidas na ordem certa
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
  const j = { id: uid(), nome, criadoEm: Date.now() };
  state.jogadores.push(j);
  DB.save(state);
  cloudSetPlayer(j);
  return j;
}
function renameJogador(id, nome) {
  nome = (nome || '').trim();
  if (!nome) return;
  const j = state.jogadores.find(x => x.id === id);
  if (j) { j.nome = nome; DB.save(state); cloudSetPlayer(j); }
}
function removeJogador(id) {
  state.jogadores = state.jogadores.filter(x => x.id !== id);
  DB.save(state);
  cloudDeletePlayer(id);
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
      const s = stats[pl.id] || (stats[pl.id] = { partidas: 0, vitorias: 0, pulgas: 0, batidas: 0, saldo: 0 });
      s.partidas += 1;
      if (p.vencedorId === pl.id) s.vitorias += 1;
      s.pulgas += p.st.pulgas[pl.id] || 0;
      s.batidas += (p.events || []).filter(e => e.type === 'round' && e.batedorId === pl.id).length;
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
    pontos: zero(0), saldo: zero(0), saldoBatida: zero(0),
    ativo: Object.fromEntries(players.map(pl => [pl.id, !lateIds.has(pl.id)])),
    voltas: zero(0), pulgas: zero(0), fecho: {}, fechado: false,
  };
  const vB = p.valorBatida;
  const rounds = [];
  let pending = [];
  const eliminados = new Set(); // quem já caiu fora (para marcar X nas rodadas seguintes)
  p.finalizada = false;
  p.vencedorId = null;
  p.zerou = false;

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
    } else if (ev.type === 'acordo') {
      // "Livro": quem livra (from) PAGA quem foi livrado (to). Soma zero, não dobra.
      const v = Number(ev.valor) || 0;
      if (ev.fromId && ev.toId && st.saldo[ev.fromId] != null && st.saldo[ev.toId] != null) {
        st.saldo[ev.fromId] -= v;
        st.saldo[ev.toId] += v;
      }
    } else if (ev.type === 'round') {
      const act = activeIds();
      if (ev.batedorId && st.ativo[ev.batedorId]) {
        act.forEach(oid => {
          if (oid === ev.batedorId) return;
          st.saldo[ev.batedorId] += vB; st.saldo[oid] -= vB;
          st.saldoBatida[ev.batedorId] += vB; st.saldoBatida[oid] -= vB;
        });
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
      // "Ganhou no zero": vencedor terminou com 0 pontos → tudo dobra (batida e partida)
      const skunk = !!ev.vencedorId && st.pontos[ev.vencedorId] === 0;
      const fecho = {}; let total = 0;
      players.forEach(x => {
        if (x.id === ev.vencedorId) return;
        let d = p.valorPartida * Math.pow(2, st.voltas[x.id]); // partida × dobra das voltas
        if (skunk) d *= 2;                                     // ganhou no zero: dobra a partida
        fecho[x.id] = -d; total += d;
      });
      if (ev.vencedorId) fecho[ev.vencedorId] = total;
      if (skunk) {
        // dobra a batida: aplica de novo o saldo de batida acumulado (soma zero se mantém)
        players.forEach(x => { fecho[x.id] = (fecho[x.id] || 0) + st.saldoBatida[x.id]; });
      }
      st.fecho = fecho; st.fechado = !!ev.vencedorId;
      p.vencedorId = ev.vencedorId || null;
      p.finalizada = true;
      p.zerou = skunk;
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

// "Livro"/acordo: quem livra paga quem foi livrado. deals = [{fromId, toId, valor}]
function registrarAcordo(p, deals) {
  (deals || []).forEach(d => {
    if (d.fromId && d.toId && d.fromId !== d.toId && Number(d.valor) > 0) {
      p.events.push({ type: 'acordo', fromId: d.fromId, toId: d.toId, valor: Number(d.valor) });
    }
  });
  recompute(p); persist(p);
}

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

// Um jogador que caiu fora pode VOLTAR só antes de lançar a próxima rodada
function podeVoltarFora(p, playerId) {
  if (!p || p.finalizada || p.st.ativo[playerId]) return false;
  let lastRound = -1, lastElim = -1;
  (p.events || []).forEach((e, i) => {
    if (e.type === 'round') lastRound = i;
    if (e.type === 'eliminar' && e.playerId === playerId) lastElim = i;
  });
  return lastElim > lastRound; // caiu fora depois da última rodada = antes da próxima
}

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

// Cancela uma partida iniciada por engano: remove tudo e volta para a tela de nova partida.
function cancelarPartida(p) {
  state.partidas = state.partidas.filter(x => x.id !== p.id);
  DB.save(state);
  if (typeof cloudClearLive === 'function') cloudClearLive();      // tira o jogo ao vivo da nuvem
  if (typeof cloudDeletePartida === 'function') cloudDeletePartida(p.id); // garante que não fique gravada
  currentScreen = 'home';
  render();
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

// Salva local e sincroniza com a nuvem
function persist(p) {
  DB.save(state);
  if (p && p.id !== 'viewer' && p.id !== 'live') {
    if (p.finalizada) {
      // Encerrou: vai pro histórico compartilhado e sai do "ao vivo"
      cloudSetPartida(p);
      cloudClearLive();
    } else {
      // Em andamento: vira/atualiza o "jogo ao vivo" pra todos verem
      cloudSetLive(p);
    }
  }
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
let viewerGame = null, viewerUnsub = null, viewerErr = null, viewerCode = '', viewerMe = null;
function stopViewer() { if (viewerUnsub) { viewerUnsub(); viewerUnsub = null; } viewerGame = null; viewerErr = null; }
function loadViewerMe(code) { try { return localStorage.getItem('pontinho:me:' + code) || null; } catch (_) { return null; } }
function setViewerMe(code, id) { viewerMe = id; try { if (id) localStorage.setItem('pontinho:me:' + code, id); else localStorage.removeItem('pontinho:me:' + code); } catch (_) {} }
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
  viewerMe = loadViewerMe(code);
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
    t.classList.toggle('active', t.dataset.screen === currentScreen));
  if (currentScreen === 'online' && typeof renderOnline === 'function') return renderOnline();
  if (currentScreen === 'history') return renderHistory();
  if (currentScreen === 'dinheiro') return renderDinheiro();
  if (currentScreen === 'players') return renderJogadores();
  // Aba Jogo:
  const local = currentPartida();
  // Sou o dono se tenho jogo local E (não há ao vivo de ninguém OU o ao vivo é meu)
  const souDono = local && (!liveDoc || liveDoc.ownerUid === myUid);
  if (souDono) return renderGame(local);                          // estou marcando
  if (liveDoc) return renderLiveViewer(buildLivePartida(liveDoc)); // outro marca → assisto
  return renderSetup();                                            // ninguém marcando → nova partida
}

/* ------------- Assistir ao vivo (aba Jogo, sem código) ------------------- */
function renderLiveViewer(p) {
  const root = appRoot();
  root.innerHTML = '';
  const ob = document.querySelector('.fab-bar'); if (ob) ob.remove();

  root.appendChild(el(`
    <div class="card" style="display:flex;align-items:center;gap:10px;background:#ffecec">
      <span class="live-dot"></span>
      <span><b>AO VIVO</b> — a partida está sendo marcada. Você acompanha em tempo real.</span>
    </div>`));

  // "Quem é você?" (fica salvo) → card pessoal em destaque
  if (viewerMe == null) viewerMe = loadViewerMe('live');
  if (viewerMe && !p.players.some(pl => pl.id === viewerMe)) viewerMe = null;
  if (!viewerMe) {
    const pick = el(`<div class="card"><h2>Quem é você?</h2><p class="muted">Escolha seu nome para ver seus pontos e dinheiro em destaque.</p><div class="chips chips-3" id="me-chips"></div></div>`);
    const chips = pick.querySelector('#me-chips');
    p.players.forEach(pl => {
      const c = el(`<button class="chip">${pl.nome}</button>`);
      c.addEventListener('click', () => { setViewerMe('live', pl.id); render(); });
      chips.appendChild(c);
    });
    root.appendChild(pick);
  } else {
    const me = p.players.find(pl => pl.id === viewerMe);
    const card = el(`
      <div class="me-card">
        <div class="me-top">Você é <b>${me.nome}</b><button class="btn ghost sm" id="me-trocar">Trocar</button></div>
        ${playerCardInner(p, me.id)}
      </div>`);
    card.querySelector('#me-trocar').addEventListener('click', () => { setViewerMe('live', null); render(); });
    root.appendChild(card);
  }

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
}

/* --------------------------- Tela do espectador (antigo) ----------------- */
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

  // "Quem é você?" — se ainda não escolheu, ou o escolhido não existe mais
  if (viewerMe && !p.players.some(pl => pl.id === viewerMe)) viewerMe = null;
  if (!viewerMe) {
    const pick = el(`<div class="card"><h2>Quem é você?</h2><p class="muted">Escolha seu nome para ver seus pontos e dinheiro em destaque.</p><div class="chips chips-3" id="me-chips"></div></div>`);
    const chips = pick.querySelector('#me-chips');
    p.players.forEach(pl => {
      const c = el(`<button class="chip">${pl.nome}</button>`);
      c.addEventListener('click', () => { setViewerMe(viewerCode, pl.id); render(); });
      chips.appendChild(c);
    });
    root.appendChild(pick);
  } else {
    // Card pessoal grande
    const me = p.players.find(pl => pl.id === viewerMe);
    const pts = p.st.pontos[me.id];
    const dinheiro = saldoExibido(p, me.id);
    const ganhando = dinheiro >= 0;
    const eliminado = !p.st.ativo[me.id];
    const risco = !eliminado && pts >= p.limite;
    const statusTxt = eliminado ? 'Fora da partida' : (risco ? `Passou de ${p.limite}!` : `Você se salva com ${p.limite - 1 - pts}`);
    // Previsão do valor final SE NÃO GANHAR: saldo atual - valor da partida (já com a dobra da volta)
    const dFinal = dividaFinal(p, me.id);
    const previsao = dinheiro - dFinal;
    const prevPos = previsao >= 0;
    const extras = [];
    if (p.st.voltas[me.id]) extras.push(`↩ ${p.st.voltas[me.id]} volta(s)`);
    if (p.st.pulgas[me.id]) extras.push(`🐛 ${p.st.pulgas[me.id]}`);
    const card = el(`
      <div class="me-card">
        <div class="me-top">Você é <b>${me.nome}</b><button class="btn ghost sm" id="me-trocar">Trocar</button></div>
        <div class="me-grid">
          <div class="me-box"><div class="me-label">SEUS PONTOS</div><div class="me-num${eliminado ? ' fora-x' : ''}">${eliminado ? 'X' : pts}</div><div class="me-sub">${statusTxt}</div></div>
          <div class="me-box ${ganhando ? 'pos' : 'neg'}"><div class="me-label">${ganhando ? 'GANHANDO' : 'DEVENDO'}</div><div class="me-num">${money(Math.abs(dinheiro))}</div><div class="me-sub">${extras.join(' · ') || ' '}</div></div>
        </div>
        ${p.finalizada ? '' : `
        <div class="me-prev ${prevPos ? 'pos' : 'neg'}">
          <span>Previsão no fim <b>se não ganhar</b></span>
          <b class="me-prev-num">${prevPos ? '+' : '-'} ${money(Math.abs(previsao))}</b>
        </div>
        <div class="me-note">Já inclui o valor da partida (${money(dFinal)}${p.st.voltas[me.id] ? ', com ' + p.st.voltas[me.id] + ' volta(s)' : ''}). Se você ganhar, recebe o total dos outros.</div>`}
      </div>`);
    card.querySelector('#me-trocar').addEventListener('click', () => { setViewerMe(viewerCode, null); render(); });
    root.appendChild(card);
  }

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
    root.appendChild(el(`<div class="card" style="text-align:center;background:var(--green)"><h2>🏆 Vencedor: ${v ? v.nome : '—'}</h2>${p.zerou ? '<p class="zerou-badge">🎯 Ganhou no ZERO — valor dobrado!</p>' : ''}</div>`));
  }
}

/* ------------------------------ Setup ------------------------------------ */
let setupSel = []; // ids selecionados NA ORDEM (ordem da mesa)

function renderSetup() {
  const root = appRoot();
  root.innerHTML = '';
  const oldBar = document.querySelector('.fab-bar'); if (oldBar) oldBar.remove();

  // Mantém na seleção só ids que ainda existem no cadastro (preservando a ordem)
  setupSel = setupSel.filter(id => state.jogadores.some(j => j.id === id));

  const card = el(`
    <div class="card">
      <h2>Nova partida</h2>
      <label class="field">
        <span>Data</span>
        <input type="date" id="f-data" class="data-center" value="${gameDayISO()}">
      </label>
      <div class="row" style="gap:10px;margin-top:10px">
        <label class="field field-valor" style="flex:1">
          <span>Valor partida</span>
          <div class="money-input"><span class="prefix">R$</span>
            <input type="text" id="f-partida" inputmode="decimal" value="5,00">
          </div>
        </label>
        <label class="field field-valor" style="flex:1">
          <span>Valor batida / pulga</span>
          <div class="money-input"><span class="prefix">R$</span>
            <input type="text" id="f-batida" inputmode="decimal" value="2,00">
          </div>
        </label>
      </div>
      <div class="field"><span style="white-space:nowrap">Selecione quem vai jogar (2 a 8).</span></div>
      <div class="chips chips-3" id="roster-chips"></div>
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
    state.jogadores.slice().sort((a, b) => String(a.nome).localeCompare(b.nome, 'pt')).forEach(j => {
      const idx = setupSel.indexOf(j.id);
      const on = idx > -1;
      const chip = el(`<button class="chip ${on ? 'on' : ''}">${on ? `<b class="ord">${idx + 1}</b>` : ''}${j.nome}</button>`);
      chip.addEventListener('click', () => {
        if (on) setupSel = setupSel.filter(x => x !== j.id);
        else {
          if (setupSel.length >= 8) { toast('Máximo de 8 jogadores'); return; }
          setupSel.push(j.id);
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
    if (j) { setupSel.push(j.id); inp.value = ''; drawChips(); inp.focus(); }
  }
  card.querySelector('#quick-add').addEventListener('click', quickAdd);
  card.querySelector('#quick-name').addEventListener('keydown', e => { if (e.key === 'Enter') quickAdd(); });

  // Formata os campos de valor em Reais (ex.: 5 -> 5,00) ao sair do campo
  ['#f-partida', '#f-batida'].forEach(sel => {
    const inp = card.querySelector(sel);
    inp.addEventListener('blur', () => { inp.value = money(parseBRL(inp.value)); });
  });

  card.querySelector('#start-game').addEventListener('click', () => {
    const data = card.querySelector('#f-data').value || gameDayISO();
    const valorPartida = parseBRL(card.querySelector('#f-partida').value);
    const valorBatida = parseBRL(card.querySelector('#f-batida').value);
    // Na ORDEM de seleção (ordem da mesa)
    const sel = setupSel.map(id => state.jogadores.find(j => j.id === id)).filter(Boolean);
    if (sel.length < 2) { toast('Selecione pelo menos 2 jogadores'); return; }
    if (!valorPartida || !valorBatida) { toast('Informe os valores'); return; }
    const p = newPartida({ data, valorPartida, valorBatida, players: sel });
    state.partidas.push(p);
    persist(p); // já publica como "jogo ao vivo" pra todos
    setupSel = [];
    render();
  });

  if (state.partidas.length) {
    root.appendChild(el(`<p class="muted" style="text-align:center">Você tem ${state.partidas.length} partida(s) no histórico.</p>`));
  }

  // Entrada para o modo "Jogar online" (beta) — jogo de cartas de verdade pelo celular
  if (typeof renderOnline === 'function') {
    const onl = el('<button class="btn ghost full" style="margin-top:14px">🌐 Jogar Pontinho online (beta)</button>');
    onl.addEventListener('click', () => { currentScreen = 'online'; render(); });
    root.appendChild(onl);
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
        openNomeModal(j.nome, (novo) => { renameJogador(j.id, novo); render(); });
      });
      row.querySelector('[data-act="del"]').addEventListener('click', () => {
        const msg = s.partidas ? `${j.nome} tem ${s.partidas} partida(s) no histórico. O histórico é mantido, só sai do cadastro.` : `Remover ${j.nome} do cadastro?`;
        openConfirmModal({ title: `Excluir ${j.nome}?`, message: msg, okText: 'Excluir', onOk: () => { removeJogador(j.id); render(); } });
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

  // Versão + atualizar
  const verBox = el(`
    <div class="row" style="justify-content:center;gap:10px;margin-top:6px">
      <span class="muted" style="font-size:12px">Versão ${APP_VERSION}</span>
      <button class="btn ghost sm" id="atualizar-btn">🔄 Atualizar app</button>
    </div>`);
  verBox.querySelector('#atualizar-btn').addEventListener('click', () => forcarAtualizacao());
  root.appendChild(verBox);
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

  if (!p.finalizada && cloudReady) {
    root.appendChild(el(`
      <div class="card" style="background:#ffecec;display:flex;align-items:center;gap:10px;padding:10px 14px">
        <span class="live-dot"></span>
        <span><b>Você está marcando ao vivo</b> — todos acompanham automaticamente.</span>
      </div>`));
  }

  if (!p.finalizada) {
    const toolbar = el(`
      <div class="row" style="gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
        <button class="btn ghost sm" id="add-player-btn">+ Jogador</button>
        <button class="btn ghost sm" id="livro-btn">🤝 Acordo</button>
        <button class="btn ghost sm" id="cancelar-btn" style="color:var(--red);border-color:#f0c0c0">🗑 Cancelar</button>
        <span class="muted" style="font-size:12px">Toque no <b>nome</b> p/ ver pontos e $ · no <b>Rx&nbsp;✎</b> p/ editar</span>
      </div>`);
    toolbar.querySelector('#add-player-btn').addEventListener('click', () => openAddPlayerModal(p));
    toolbar.querySelector('#livro-btn').addEventListener('click', () => openLivroModal(p));
    toolbar.querySelector('#cancelar-btn').addEventListener('click', () => {
      openConfirmModal({
        title: 'Cancelar esta partida?',
        message: 'A partida atual será apagada por completo (pontos, dinheiro e jogadas). Isso não dá pra desfazer. Use quando começou errado e quer recomeçar.',
        okText: 'Cancelar partida',
        onOk: () => { cancelarPartida(p); toast('Partida cancelada'); },
      });
    });
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
      const proxVolta = p.valorPartida * Math.pow(2, p.st.voltas[pl.id] + 1); // quanto pagará se voltar agora
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
        ${p.zerou ? '<p class="zerou-badge">🎯 Ganhou no ZERO — valor dobrado!</p>' : ''}
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

// Soma o dinheiro de um jogador em TODAS as partidas de um dia (financeiro geral do dia)
function financeiroDia(id, data) {
  const parts = state.partidas.filter(x => x.data === data && x.players.some(pl => pl.id === id));
  return { total: parts.reduce((s, x) => s + saldoExibido(x, id), 0), n: parts.length };
}

// Conteúdo do card pessoal de um jogador (pontos, dinheiro, previsão)
function playerCardInner(p, id) {
  const pts = p.st.pontos[id];
  const dinheiro = saldoExibido(p, id);
  const ganhando = dinheiro >= 0;
  const eliminado = !p.st.ativo[id];
  const risco = !eliminado && pts >= p.limite;
  const statusTxt = eliminado ? 'Fora da partida' : (risco ? `Passou de ${p.limite}!` : `Você se salva com ${p.limite - 1 - pts}`);
  const extras = [];
  if (p.st.voltas[id]) extras.push(`↩ ${p.st.voltas[id]} volta(s)`);
  if (p.st.pulgas[id]) extras.push(`🐛 ${p.st.pulgas[id]}`);
  const dFinal = dividaFinal(p, id);
  const previsao = dinheiro - dFinal;
  const prevPos = previsao >= 0;
  // Financeiro geral do dia (só quando as partidas do dia estão neste aparelho — ex.: quem marca)
  const isLocal = state.partidas.some(x => x.id === p.id);
  let geralHtml = '';
  if (isLocal) {
    const g = financeiroDia(id, p.data);
    const gPos = g.total >= 0;
    geralHtml = `
      <div class="me-geral ${gPos ? 'pos' : 'neg'}">
        <div class="me-label">FINANCEIRO GERAL DO DIA</div>
        <div class="me-geral-num">${gPos ? '+' : '-'} ${money(Math.abs(g.total))}</div>
        <div class="me-sub">${g.n} partida(s) · ${formatDatePT(p.data)}</div>
      </div>`;
  }
  return `
    <div class="me-grid">
      <div class="me-box"><div class="me-label">PONTOS</div><div class="me-num${eliminado ? ' fora-x' : ''}">${eliminado ? 'X' : pts}</div><div class="me-sub">${statusTxt}</div></div>
      <div class="me-box ${ganhando ? 'pos' : 'neg'}"><div class="me-label">${ganhando ? 'GANHANDO' : 'DEVENDO'}</div><div class="me-num">${money(Math.abs(dinheiro))}</div><div class="me-sub">${extras.join(' · ') || 'parcial'}</div></div>
    </div>
    ${p.finalizada ? '' : `
    <div class="me-prev ${prevPos ? 'pos' : 'neg'}">
      <span>Previsão no fim <b>se não ganhar</b></span>
      <b class="me-prev-num">${prevPos ? '+' : '-'} ${money(Math.abs(previsao))}</b>
    </div>
    <div class="me-note">Já inclui o valor da partida (${money(dFinal)}${p.st.voltas[id] ? ', com ' + p.st.voltas[id] + ' volta(s)' : ''}). Se ganhar, recebe o total dos outros.</div>`}
    ${geralHtml}
  `;
}

// Modal com o card pessoal (abre ao tocar no nome do jogador no placar)
function openPlayerCard(p, id) {
  const pl = p.players.find(x => x.id === id);
  if (!pl) return;
  // Voltar: só no jogo ao vivo de quem marca, se o jogador caiu fora antes da próxima rodada
  const ehEspectador = p.online && p.online.role === 'viewer';
  const mostrarVoltar = !ehEspectador && podeVoltarFora(p, id);
  const body = el(`
    <div class="modal">
      <div class="row"><h2>${pl.nome}</h2><div class="spacer"></div>
        <button class="btn ghost sm close">Fechar</button></div>
      ${playerCardInner(p, id)}
      ${mostrarVoltar ? `
        <div style="height:14px"></div>
        <button class="btn yellow full" id="voltar-btn">↩ Voltar para a partida (com volta)</button>
        <p class="muted" style="text-align:center;margin-top:6px">Ele volta com os pontos do maior jogador e paga a volta (dobrado). Só dá pra fazer antes da próxima rodada.</p>
      ` : ''}
    </div>`);
  body.querySelector('.close').addEventListener('click', closeModal);
  const vb = body.querySelector('#voltar-btn');
  if (vb) vb.addEventListener('click', () => {
    doVolta(p, id);
    closeModal();
    toast(`${pl.nome} voltou para a partida`);
    render();
  });
  showModal(body);
}

function buildBoard(p, editable) {
  const wrap = el('<div class="board-scroll"></div>');
  const table = el('<table class="board"></table>');

  // Cabeçalho PONTOS (totais)
  const theadP = el('<thead class="pontos"></thead>');
  const trTotP = el('<tr></tr>');
  trTotP.appendChild(el('<th style="background:#f2d600">PONTOS</th>'));
  // Quem está fora da partida mostra X vermelho no lugar dos pontos (não confunde)
  p.players.forEach(pl => trTotP.appendChild(el(p.st.ativo[pl.id]
    ? `<th class="total-pts">${p.st.pontos[pl.id]}</th>`
    : '<th class="total-pts fora-x">X</th>')));
  const trNameP = el('<tr></tr>');
  trNameP.appendChild(el('<th></th>'));
  p.players.forEach(pl => {
    const s = statusOf(p, pl);
    const winLose = p.st.fechado ? (pl.id === p.vencedorId ? 'win' : 'lose') : '';
    const chip = s === 'elim' ? '<span class="status-chip elim">FORA</span>'
      : s === 'risco' ? '<span class="status-chip risco">+100</span>'
      : `<span class="status-chip ativo">${p.st.voltas[pl.id] ? 'V' + p.st.voltas[pl.id] : 'ok'}</span>`;
    const th = el(`<th class="name clickable ${winLose}">${pl.nome}<br>${chip}</th>`);
    th.addEventListener('click', () => openPlayerCard(p, pl.id));
    trNameP.appendChild(th);
  });
  theadP.appendChild(trTotP);
  theadP.appendChild(trNameP);
  table.appendChild(theadP);

  // Corpo: uma linha por rodada
  const tbody = el('<tbody></tbody>');
  p.rounds.forEach(r => {
    const tr = el('<tr></tr>');
    const pulgaLabel = (r.pulgaIds && r.pulgaIds.length) ? ' 🐛' : '';
    // Rodadas registradas (evento 'round') podem ser editadas — inclusive as "ninguém bateu".
    // A linha só-pulga aponta para um evento 'finalizar', então fica de fora naturalmente.
    const canEdit = editable && r.evIndex != null && p.events[r.evIndex] && p.events[r.evIndex].type === 'round';
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
    // Verde = ganhador; azul = positivo (não ganhador); vermelho = negativo
    let cls;
    if (p.st.fechado && pl.id === p.vencedorId) cls = 'win';
    else if (v > 0) cls = 'azul';
    else if (v < 0) cls = 'verm';
    else cls = 'zero';
    trTotD.appendChild(el(`<th class="money ${cls}">${money(v)}</th>`));
  });
  theadD.appendChild(trTotD);
  table.appendChild(theadD);

  wrap.appendChild(table);
  return wrap;
}

function roundMark(p, r, playerId) {
  // Voltou nesta rodada: célula azul com os pontos do maior (com 🐛 se também pegou pulga)
  const volta = (r.voltas || []).find(v => v.playerId === playerId);
  if (volta) {
    const pulgaV = (r.pulgaIds || []).includes(playerId) ? '🐛 ' : '';
    return `<span class="round-mark">${pulgaV}<span class="cell-volta">${volta.pontos}</span></span>`;
  }
  // Não estava ativo nesta rodada: se já tinha caído fora, mostra X; se entrou depois, em branco
  if (r.activeIds && !r.activeIds.includes(playerId)) {
    if (r.foraAcum && r.foraAcum.includes(playerId)) return '<span class="round-mark sign">X</span>';
    return '';
  }
  const isPulga = (r.pulgaIds || []).includes(playerId);
  if (r.batedorId === playerId) return isPulga ? '<span class="round-mark">🐛 <b class="sign">–</b></span>' : '<span class="round-mark sign">–</span>';
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

/* ------------------------- Modal de Livro/Acordo ------------------------- */
function openLivroModal(p, opts = {}) {
  const finalizarVenc = opts.finalizarComVencedor || null; // se veio do fluxo do ganhador
  let payerId = null;
  const valores = {}; // toId -> valor (número)
  const quick = [1, 2, 3, 4].map(n => p.valorPartida * Math.pow(2, n)); // ex: 10, 20, 40, 80

  const body = el(`
    <div class="modal">
      <div class="row"><h2>🤝 Acordo / Livre</h2><div class="spacer"></div>
        <button class="btn ghost sm close">Fechar</button></div>
      ${finalizarVenc ? '<p class="muted">Lance quantos acordos precisar. Ao terminar, toque em <b>Finalizar partida</b>.</p>' : ''}
      <div class="field"><span>Quem livra (paga):</span></div>
      <div class="chips chips-3" id="livro-payer"></div>
      <div id="livro-recebe"></div>
      <div style="height:12px"></div>
      <button class="btn green full" id="save-livro">${finalizarVenc ? '➕ Lançar este acordo' : 'Lançar acordo'}</button>
      ${finalizarVenc ? '<button class="btn primary full" id="finalizar-apos" style="margin-top:8px">✅ Finalizar partida</button>' : ''}
    </div>`);

  const payerBox = body.querySelector('#livro-payer');
  const recebeBox = body.querySelector('#livro-recebe');

  function drawRecebe() {
    recebeBox.innerHTML = '';
    if (!payerId) return;
    recebeBox.appendChild(el('<div class="field" style="margin-top:12px"><span>Quem foi livrado (recebe) e quanto:</span></div>'));
    p.players.filter(pl => pl.id !== payerId).forEach(pl => {
      const row = el(`
        <div class="livro-row">
          <div class="livro-nome">${pl.nome}</div>
          <input class="livro-val" type="text" inputmode="decimal" placeholder="0,00" value="${valores[pl.id] ? money(valores[pl.id]) : ''}">
          <div class="livro-quick">
            ${quick.map((v, i) => `<button class="btn ghost sm" data-v="${v}">${i + 1}</button>`).join('')}
          </div>
        </div>`);
      const inp = row.querySelector('.livro-val');
      inp.addEventListener('input', () => { valores[pl.id] = parseBRL(inp.value); });
      row.querySelectorAll('[data-v]').forEach(b => b.addEventListener('click', () => {
        const v = Number(b.dataset.v);
        valores[pl.id] = v; inp.value = money(v);
      }));
      recebeBox.appendChild(row);
    });
  }

  p.players.forEach(pl => {
    const chip = el(`<button class="chip">${pl.nome}</button>`);
    chip.addEventListener('click', () => {
      payerId = (payerId === pl.id) ? null : pl.id;
      payerBox.querySelectorAll('.chip').forEach(c => c.classList.remove('on'));
      if (payerId) chip.classList.add('on');
      drawRecebe();
    });
    payerBox.appendChild(chip);
  });

  const coletaDeals = () => Object.entries(valores)
    .filter(([toId, v]) => toId !== payerId && Number(v) > 0)
    .map(([toId, v]) => ({ fromId: payerId, toId, valor: Number(v) }));

  body.querySelector('#save-livro').addEventListener('click', () => {
    if (!payerId) { toast('Escolha quem livra (paga)'); return; }
    const deals = coletaDeals();
    if (!deals.length) { toast('Informe o valor de pelo menos um jogador'); return; }
    registrarAcordo(p, deals);
    if (finalizarVenc) {
      // Mantém o modal aberto para lançar outro acordo
      payerId = null;
      Object.keys(valores).forEach(k => delete valores[k]);
      payerBox.querySelectorAll('.chip').forEach(c => c.classList.remove('on'));
      drawRecebe();
      toast('Acordo lançado! Adicione outro ou finalize.');
    } else {
      closeModal(); render();
      toast('Acordo lançado!');
    }
  });

  const finBtn = body.querySelector('#finalizar-apos');
  if (finBtn) finBtn.addEventListener('click', () => {
    // Lança um acordo preenchido mas ainda não confirmado, se houver
    if (payerId) { const deals = coletaDeals(); if (deals.length) registrarAcordo(p, deals); }
    finalizar(p, finalizarVenc);
    closeModal();
    const venc = p.players.find(x => x.id === finalizarVenc);
    toast(venc ? `${venc.nome} venceu!` : 'Partida finalizada');
    currentScreen = 'history'; render();
  });

  body.querySelector('.close').addEventListener('click', closeModal);
  showModal(body);
}

/* --------------------------- Modal de rodada ----------------------------- */
// Falta preencher: jogador ativo que não é o batedor, não está "fora" e não tem pontos
function pontoVazio(v) { return v === undefined || v === null || String(v).trim() === ''; }

function openRoundModal(p) {
  const ativos = activePlayers(p);
  const draft = { batedorId: null, foraIds: [], pontos: {}, semBatedor: false };
  let tentou = false;
  const falta = (pl) => pl.id !== draft.batedorId && !draft.foraIds.includes(pl.id) && pontoVazio(draft.pontos[pl.id]);

  const body = el(`
    <div class="modal">
      <div class="row"><h2>Nova rodada</h2><div class="spacer"></div>
        <button class="btn ghost sm close">Fechar</button></div>
      <p class="muted">Marque quem <b>bateu</b> (–). Cada um dos outros precisa ter os <b>pontos</b> digitados ou o <b>X Fora</b> marcado. <b>X Fora = sai da partida</b> (nas próximas rodadas já aparece fora e não soma mais). Pulga é no botão 🐛.</p>
      <button class="btn ghost sm full nb-btn" id="ninguem-bateu" style="margin-bottom:10px">🃏 Ninguém bateu (acabaram as cartas)</button>
      <div class="round-players"></div>
      <div style="height:14px"></div>
      <button class="btn primary full" id="save-round">Salvar rodada</button>
    </div>`);

  const listEl = body.querySelector('.round-players');
  const nbBtn = body.querySelector('#ninguem-bateu');
  nbBtn.addEventListener('click', () => {
    draft.semBatedor = !draft.semBatedor;
    if (draft.semBatedor) draft.batedorId = null;
    refresh();
  });

  function refresh() {
    nbBtn.classList.toggle('on', draft.semBatedor);
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
            <button class="rp-toggle bat ${isBat ? 'on' : ''}" data-t="bat" ${draft.semBatedor ? 'disabled style="opacity:.35"' : ''}>– Bateu</button>
            <button class="rp-toggle fora ${isFora ? 'on' : ''}" data-t="fora">X Fora</button>
          </div>
        </div>`);

      const ptsInput = rp.querySelector('.rp-pts');
      ptsInput.addEventListener('input', () => {
        draft.pontos[pl.id] = ptsInput.value;
        if (tentou) rp.classList.toggle('rp-missing', falta(pl));
      });
      // Tocar no nome/linha foca a caixa de pontos (facilita no celular)
      rp.querySelector('.rp-name').addEventListener('click', () => { if (!ptsInput.disabled) ptsInput.focus(); });

      rp.querySelector('[data-t="bat"]').addEventListener('click', () => {
        if (draft.semBatedor) return;
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
    if (!draft.semBatedor && !draft.batedorId) { toast('Marque quem bateu (–) ou toque "Ninguém bateu"'); return; }
    const faltam = ativos.filter(falta);
    if (faltam.length) {
      tentou = true; refresh();
      toast('Falta pontos ou "Fora": ' + faltam.map(x => x.nome).join(', '));
      return;
    }
    // Registra a rodada; quem levou X Fora SAI da partida (elimina a partir da próxima rodada)
    // semBatedor => batedorId null: recompute não aplica dinheiro, só soma os pontos
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
    semBatedor: !ev.batedorId,
  };

  const body = el(`
    <div class="modal">
      <div class="row"><h2>Editar rodada</h2><div class="spacer"></div>
        <button class="btn ghost sm close">Fechar</button></div>
      <p class="muted">Ajuste quem bateu e os pontos. O placar e o dinheiro recalculam sozinhos.</p>
      <button class="btn ghost sm full nb-btn" id="ninguem-bateu" style="margin-bottom:10px">🃏 Ninguém bateu (acabaram as cartas)</button>
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
  const nbBtn = body.querySelector('#ninguem-bateu');
  nbBtn.addEventListener('click', () => {
    draft.semBatedor = !draft.semBatedor;
    if (draft.semBatedor) draft.batedorId = null;
    refresh();
  });
  function refresh() {
    nbBtn.classList.toggle('on', draft.semBatedor);
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
            <button class="rp-toggle bat ${isBat ? 'on' : ''}" data-t="bat" ${draft.semBatedor ? 'disabled style="opacity:.35"' : ''}>– Bateu</button>
            <button class="rp-toggle fora ${isFora ? 'on' : ''}" data-t="fora">X Fora</button>
          </div>
        </div>`);
      const ptsInput = rp.querySelector('.rp-pts');
      ptsInput.addEventListener('input', () => {
        draft.pontos[pl.id] = ptsInput.value;
        if (tentou) rp.classList.toggle('rp-missing', falta(pl));
      });
      rp.querySelector('.rp-name').addEventListener('click', () => { if (!ptsInput.disabled) ptsInput.focus(); });
      rp.querySelector('[data-t="bat"]').addEventListener('click', () => {
        if (draft.semBatedor) return;
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
    if (!draft.semBatedor && !draft.batedorId) { toast('Marque quem bateu (–) ou toque "Ninguém bateu"'); return; }
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
    openConfirmModal({
      title: 'Excluir rodada?',
      message: 'A rodada será removida e o placar recalcula sozinho.',
      okText: 'Excluir rodada',
      onOk: () => { excluirRound(p, evIndex); toast('Rodada excluída'); render(); },
    });
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
      closeModal();
      openAcordoDecisionModal(p, pl);
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

// Pergunta se houve acordo antes de finalizar. Sim -> tela de acordo; Não -> finaliza direto.
function openAcordoDecisionModal(p, pl) {
  const body = el(`
    <div class="modal">
      <div class="row"><h2>Houve acordo?</h2><div class="spacer"></div>
        <button class="btn ghost sm close">Fechar</button></div>
      <p class="muted"><b>${pl.nome}</b> venceu. Antes de finalizar, houve algum <b>acordo</b> (livre/acerto) para lançar?</p>
      <button class="btn green full" id="ac-sim" style="margin-bottom:8px">Sim, lançar acordo</button>
      <button class="btn primary full" id="ac-nao">Não, finalizar</button>
    </div>`);
  body.querySelector('#ac-sim').addEventListener('click', () => {
    closeModal();
    openLivroModal(p, { finalizarComVencedor: pl.id });
  });
  body.querySelector('#ac-nao').addEventListener('click', () => {
    finalizar(p, pl.id); closeModal(); toast(`${pl.nome} venceu!`);
    currentScreen = 'history'; render();
  });
  body.querySelector('.close').addEventListener('click', closeModal);
  showModal(body);
}

/* ------------------------------ Dinheiro --------------------------------- */
let dinheiroPeriodo = 'dia'; // dia | semana | mes | ano | tudo
let dinheiroSort = 'saldo';  // saldo | pulgas | batidas | vitorias | partidas
let focusPartidaId = null;   // ao abrir o Histórico, rola/destaca esta partida
let dinheiroDias = [];       // dias da semana marcados (vazio = a semana toda)
let dinheiroMes = null;      // mês selecionado (0-11) na visão Mês (null = atual/último)
let dinheiroAno = null;      // ano selecionado (AAAA) na visão Ano (null = ano atual)
const DIN_DIAS = [[1, 'SEG'], [2, 'TER'], [3, 'QUA'], [4, 'QUI'], [5, 'SEX'], [6, 'SAB'], [0, 'DOM']];
const DIN_MESES = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ'];
function inPeriodo(dataISO, periodo) {
  const hoje = gameDayISO();
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
  const sel = el(`<div class="chips" style="margin-bottom:10px">
    ${periodos.map(([k, l]) => `<button class="chip ${dinheiroPeriodo === k ? 'on' : ''}" data-p="${k}">${l}</button>`).join('')}
  </div>`);
  sel.querySelectorAll('[data-p]').forEach(b => b.addEventListener('click', () => { dinheiroPeriodo = b.dataset.p; render(); }));
  root.appendChild(sel);

  // ----- Sub-filtros (dependem do período escolhido) -----
  const hojeG = gameDayISO();
  const anoAtual = hojeG.slice(0, 4);
  const mesAtual = +hojeG.slice(5, 7) - 1;
  const finalizadas = state.partidas.filter(p => p.finalizada);
  const mesesComJogo = [...new Set(finalizadas.filter(p => p.data.slice(0, 4) === anoAtual).map(p => +p.data.slice(5, 7) - 1))].sort((a, b) => a - b);
  const anosComJogo = [...new Set(finalizadas.map(p => p.data.slice(0, 4)))];
  if (!anosComJogo.includes(anoAtual)) anosComJogo.push(anoAtual);
  anosComJogo.sort();
  const effMes = (dinheiroMes != null && mesesComJogo.includes(dinheiroMes)) ? dinheiroMes
    : mesesComJogo.includes(mesAtual) ? mesAtual
      : (mesesComJogo.length ? mesesComJogo[mesesComJogo.length - 1] : mesAtual);
  const effAno = (dinheiroAno && anosComJogo.includes(dinheiroAno)) ? dinheiroAno : anoAtual;

  if (dinheiroPeriodo === 'semana') {
    const sub = el(`<div class="chips sort-ord" style="margin:0 0 6px">
      ${DIN_DIAS.map(([d, l]) => `<button class="chip ${dinheiroDias.includes(d) ? 'on' : ''}" data-d="${d}">${l}</button>`).join('')}
    </div>`);
    sub.querySelectorAll('[data-d]').forEach(b => b.addEventListener('click', () => {
      const d = +b.dataset.d;
      dinheiroDias = dinheiroDias.includes(d) ? dinheiroDias.filter(x => x !== d) : [...dinheiroDias, d];
      render();
    }));
    root.appendChild(sub);
    root.appendChild(el('<div class="muted" style="font-size:11px;margin:0 0 12px">Nenhum dia marcado = a semana toda</div>'));
  } else if (dinheiroPeriodo === 'mes') {
    if (mesesComJogo.length) {
      const sub = el(`<div class="chips" style="margin:0 0 12px">
        ${mesesComJogo.map(m => `<button class="chip ${effMes === m ? 'on' : ''}" data-m="${m}">${DIN_MESES[m]}</button>`).join('')}
      </div>`);
      sub.querySelectorAll('[data-m]').forEach(b => b.addEventListener('click', () => { dinheiroMes = +b.dataset.m; render(); }));
      root.appendChild(sub);
    }
  } else if (dinheiroPeriodo === 'ano') {
    const sub = el(`<div class="chips" style="margin:0 0 12px">
      ${anosComJogo.map(a => `<button class="chip ${effAno === a ? 'on' : ''}" data-a="${a}">${a}</button>`).join('')}
    </div>`);
    sub.querySelectorAll('[data-a]').forEach(b => b.addEventListener('click', () => { dinheiroAno = b.dataset.a; render(); }));
    root.appendChild(sub);
  }

  const passaFiltro = (p) => {
    const d = p.data;
    if (dinheiroPeriodo === 'tudo') return true;
    if (dinheiroPeriodo === 'dia') return d === hojeG;
    if (dinheiroPeriodo === 'semana') {
      const diff = (new Date(hojeG + 'T00:00:00') - new Date(d + 'T00:00:00')) / 86400000;
      if (!(diff >= 0 && diff < 7)) return false;
      return dinheiroDias.length === 0 || dinheiroDias.includes(new Date(d + 'T00:00:00').getDay());
    }
    if (dinheiroPeriodo === 'mes') return d.slice(0, 4) === anoAtual && (+d.slice(5, 7) - 1) === effMes;
    if (dinheiroPeriodo === 'ano') return d.slice(0, 4) === effAno;
    return true;
  };
  const parts = finalizadas.filter(passaFiltro);

  // Ranking do período
  const agg = {};
  parts.forEach(p => p.players.forEach(pl => {
    const s = agg[pl.id] || (agg[pl.id] = { nome: nomeJogador(pl.id, pl.nome), saldo: 0, pulgas: 0, batidas: 0, vitorias: 0, partidas: 0 });
    s.saldo += saldoExibido(p, pl.id);
    s.pulgas += p.st.pulgas[pl.id] || 0;
    s.batidas += (p.events || []).filter(e => e.type === 'round' && e.batedorId === pl.id).length;
    if (p.vencedorId === pl.id) s.vitorias += 1;
    s.partidas += 1;
  }));
  const rank = Object.values(agg).sort((a, b) => (b[dinheiroSort] - a[dinheiroSort]) || (b.saldo - a.saldo));

  const lb = el('<div class="card"><h2>🏆 Ranking do período</h2></div>');
  // Botões de ordenação
  const ordena = [['pulgas', 'Pulga'], ['batidas', 'Batidas'], ['vitorias', 'Vitórias'], ['partidas', 'Partidas']];
  const sortBar = el(`<div class="chips sort-ord" style="margin:2px 0 12px">
    ${ordena.map(([k, l]) => `<button class="chip ${dinheiroSort === k ? 'on' : ''}" data-s="${k}">${l}</button>`).join('')}
  </div>`);
  // clicar de novo no ativo volta para o padrão (Valor)
  sortBar.querySelectorAll('[data-s]').forEach(b => b.addEventListener('click', () => { dinheiroSort = (dinheiroSort === b.dataset.s) ? 'saldo' : b.dataset.s; render(); }));
  lb.appendChild(sortBar);
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
            <div class="muted jog-stats">${s.partidas} partidas · 🏆 ${s.vitorias} · 🐛 ${s.pulgas} · bat ${s.batidas}</div>
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
    const numeradas = byDay[day].slice().sort((a, b) => (a.criadoEm || 0) - (b.criadoEm || 0)).map((p, i) => ({ p, n: i + 1 }));
    numeradas.reverse().forEach(({ p, n }) => {
      const venc = p.players.find(x => x.id === p.vencedorId);
      const num = String(n).padStart(2, '0');
      const card = el(`<div class="hist-partida clickable"><div class="h-title">${num}ª Partida · ${money(p.valorPartida)}/${money(p.valorBatida)} ${venc ? `<span class="badge">🏆 ${venc.nome}</span>` : ''} <span class="muted" style="float:right;font-weight:600">ver ›</span></div></div>`);
      card.addEventListener('click', () => { focusPartidaId = p.id; currentScreen = 'history'; render(); });
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
    // Abre o dia que contém a partida focada (ou o mais recente por padrão)
    const temFoco = focusPartidaId && byDay[day].some(p => p.id === focusPartidaId);
    const aberto = temFoco || (!focusPartidaId && day === days[0]);
    const det = el(`<details class="hist-day" ${aberto ? 'open' : ''}><summary>${formatDatePT(day)} — ${byDay[day].length} partida(s)</summary></details>`);
    // Numera na ordem cronológica (1ª, 2ª...) e exibe a mais recente em cima
    const numeradas = byDay[day].slice().sort((a, b) => (a.criadoEm || 0) - (b.criadoEm || 0)).map((p, i) => ({ p, n: i + 1 }));
    numeradas.reverse().forEach(({ p, n }) => det.appendChild(histCard(p, n)));
    root.appendChild(det);
  });

  // Rola até a partida focada e destaca
  if (focusPartidaId) {
    const alvo = focusPartidaId; focusPartidaId = null;
    setTimeout(() => {
      const node = root.querySelector(`.hist-partida[data-pid="${alvo}"]`);
      if (node) {
        try { node.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) {}
        node.classList.add('flash');
        setTimeout(() => node.classList.remove('flash'), 1600);
      }
    }, 60);
  }

  root.appendChild(el('<div style="height:10px"></div>'));
  const clear = el('<button class="btn danger-outline full">🗑 Apagar todo o histórico</button>');
  clear.addEventListener('click', () => {
    openConfirmModal({
      title: 'Apagar tudo?',
      message: 'TODAS as partidas serão apagadas. Não dá pra desfazer. (Os jogadores cadastrados são mantidos.)',
      okText: 'Apagar tudo',
      onOk: () => { const ids = state.partidas.filter(x => x.finalizada).map(x => x.id); state.partidas = state.partidas.filter(x => !x.finalizada); DB.save(state); ids.forEach(cloudDeletePartida); render(); },
    });
  });
  root.appendChild(clear);
}

function histCard(p, numero) {
  const venc = p.players.find(pl => pl.id === p.vencedorId);
  const num = numero != null ? String(numero).padStart(2, '0') : '';
  const c = el(`<div class="hist-partida" data-pid="${p.id}">
    <div class="h-title">${p.finalizada ? '✅' : '⏳'} ${num ? num + 'ª Partida' : 'Partida'} · ${money(p.valorPartida)}/${money(p.valorBatida)} — ${p.rounds.length} rodadas
    ${venc ? `<span class="badge">🏆 ${venc.nome}</span>` : ''}${p.zerou ? '<span class="badge" style="background:#ffd24d">🎯 no ZERO (dobrou)</span>' : ''}</div>
  </div>`);
  c.appendChild(buildBoard(p));
  if (!p.finalizada) {
    const cont = el('<button class="btn primary sm full" style="margin-top:10px">Continuar esta partida</button>');
    cont.addEventListener('click', () => { currentScreen = 'home'; render(); });
    c.appendChild(cont);
  } else {
    const del = el('<button class="btn danger-outline sm full" style="margin-top:10px">🗑 Excluir partida</button>');
    del.addEventListener('click', () => {
      openConfirmModal({
        title: 'Excluir partida?',
        message: 'Esta partida será apagada do histórico. Não dá pra desfazer.',
        okText: 'Excluir esta partida',
        onOk: () => { state.partidas = state.partidas.filter(x => x.id !== p.id); DB.save(state); cloudDeletePartida(p.id); render(); },
      });
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

// Modal bonito para editar o nome do jogador (substitui o prompt do navegador)
function openNomeModal(nomeAtual, onOk) {
  const body = el(`
    <div class="modal">
      <div class="row"><h2>Editar nome</h2><div class="spacer"></div>
        <button class="btn ghost sm close">Fechar</button></div>
      <label class="field"><span>Nome do jogador</span>
        <input type="text" id="nome-input" value="${(nomeAtual || '').replace(/"/g, '&quot;')}" autocomplete="off">
      </label>
      <div style="height:14px"></div>
      <div class="btnbar">
        <button class="btn ghost" id="nome-cancel">Cancelar</button>
        <button class="btn primary" id="nome-ok">Salvar</button>
      </div>
    </div>`);
  const input = body.querySelector('#nome-input');
  const ok = () => { const v = input.value.trim(); if (!v) { toast('Digite um nome'); return; } closeModal(); onOk(v); };
  body.querySelector('#nome-ok').addEventListener('click', ok);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
  body.querySelector('#nome-cancel').addEventListener('click', closeModal);
  body.querySelector('.close').addEventListener('click', closeModal);
  showModal(body);
  setTimeout(() => { input.focus(); input.select(); }, 60);
}

// Modal de confirmação bonito (substitui o confirm do navegador)
function openConfirmModal({ title, message, okText, onOk }) {
  const body = el(`
    <div class="modal">
      <div class="row"><h2>${title || 'Confirmar'}</h2><div class="spacer"></div>
        <button class="btn ghost sm close">Fechar</button></div>
      <p style="margin:6px 0 18px;font-size:15px">${message || ''}</p>
      <div class="btnbar">
        <button class="btn ghost" id="cm-cancel">Cancelar</button>
        <button class="btn red" id="cm-ok">${okText || 'Excluir'}</button>
      </div>
    </div>`);
  body.querySelector('#cm-ok').addEventListener('click', () => { closeModal(); onOk(); });
  body.querySelector('#cm-cancel').addEventListener('click', closeModal);
  body.querySelector('.close').addEventListener('click', closeModal);
  showModal(body);
}

/* ============= Histórico + cadastro compartilhados (nuvem) ============== */
let cloudReady = false;
let myUid = null;       // meu id anônimo
let liveDoc = null;     // partida ao vivo compartilhada (live/atual) ou null

// Grava a partida em andamento como "jogo ao vivo" (todos veem; só o dono grava)
function cloudSetLive(p) {
  if (!cloudReady || !myUid) return;
  fbDB.collection('live').doc('atual').set({
    ownerUid: myUid, partidaId: p.id, criadoEm: p.criadoEm || Date.now(),
    data: p.data, valorPartida: p.valorPartida, valorBatida: p.valorBatida, limite: p.limite || 100,
    players: p.players.map(pl => ({ id: pl.id, nome: pl.nome })),
    events: JSON.parse(JSON.stringify(p.events || [])),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  }).catch(e => console.warn('live set', e));
}
function cloudClearLive() {
  if (!cloudReady) return;
  fbDB.collection('live').doc('atual').delete().catch(() => {});
}
function buildLivePartida(d) {
  const p = {
    id: d.partidaId || 'live', criadoEm: d.criadoEm || 0,
    data: d.data, valorPartida: d.valorPartida, valorBatida: d.valorBatida,
    limite: d.limite || 100, players: d.players || [], events: d.events || [],
    st: {}, rounds: [], pendingPulgas: [], finalizada: false, vencedorId: null,
    online: { role: 'viewer' },
  };
  recompute(p);
  return p;
}
function onLiveSnapshot(snap) {
  liveDoc = snap.exists ? snap.data() : null;
  // Atualiza a tela Jogo quando NÃO sou eu marcando (sou espectador)
  const souDono = !!currentPartida();
  if (currentScreen === 'home' && !souDono) cloudMaybeRender(['home']);
}

function cloudMaybeRender(screens) {
  if (!screens.includes(currentScreen)) return;
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return; // não interromper digitação
  render();
}

function cloudSetPlayer(j) {
  if (!cloudReady) return;
  fbDB.collection('roster').doc(j.id).set({ nome: j.nome, criadoEm: j.criadoEm || Date.now() }, { merge: true }).catch(e => console.warn('cloud player', e));
}
function cloudDeletePlayer(id) {
  if (!cloudReady) return;
  fbDB.collection('roster').doc(id).delete().catch(() => {});
}
function partidaToCloud(p) {
  return {
    id: p.id, criadoEm: p.criadoEm || Date.now(),
    data: p.data, valorPartida: p.valorPartida, valorBatida: p.valorBatida,
    limite: p.limite || 100,
    players: p.players.map(pl => ({ id: pl.id, nome: pl.nome })),
    events: JSON.parse(JSON.stringify(p.events || [])),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  };
}
function cloudSetPartida(p) {
  if (!cloudReady) return;
  fbDB.collection('partidas').doc(p.id).set(partidaToCloud(p)).catch(e => console.warn('cloud partida', e));
}
function cloudDeletePartida(id) {
  if (!cloudReady) return;
  fbDB.collection('partidas').doc(id).delete().catch(() => {});
}
function partidaFromCloud(doc) {
  const d = doc.data ? doc.data() : doc; // aceita snapshot do Firestore ou objeto puro
  const p = {
    id: doc.id, criadoEm: d.criadoEm || (d.updatedAt && d.updatedAt.toMillis ? d.updatedAt.toMillis() : 0),
    data: d.data, valorPartida: d.valorPartida, valorBatida: d.valorBatida,
    limite: d.limite || 100, players: d.players || [], events: d.events || [],
    st: {}, rounds: [], pendingPulgas: [], finalizada: false, vencedorId: null,
  };
  recompute(p);
  return p;
}
function mergeCloudRoster(docs) {
  // Nuvem é a fonte da verdade: exclusão/edição de jogador reflete pra todos
  const cloud = docs.map(d => ({ id: d.id, nome: d.data().nome, criadoEm: d.data().criadoEm || 0 }));
  state.jogadores = cloud.sort((a, b) => (a.criadoEm || 0) - (b.criadoEm || 0) || String(a.nome).localeCompare(b.nome));
  DB.save(state);
  cloudMaybeRender(['home', 'players', 'history', 'dinheiro']);
}
function mergeCloudPartidas(docs) {
  const cloud = docs.map(partidaFromCloud).filter(partidaValida);
  const cloudIds = new Set(cloud.map(p => p.id));
  const ongoing = state.partidas.filter(p => !p.finalizada && !cloudIds.has(p.id) && partidaValida(p)); // jogo local em andamento
  state.partidas = [...ongoing, ...cloud];
  DB.save(state);
  cloudMaybeRender(['history', 'dinheiro', 'home']);
}
async function initCloudSync() {
  let user;
  try { user = await initFirebase(); } catch (e) { console.warn('Nuvem indisponível (offline?)', e); return; }
  cloudReady = true;
  myUid = user.uid;
  try {
    // Semeia local→nuvem SÓ na primeira vez (nuvem vazia). Depois a nuvem é a fonte
    // da verdade — evita ressuscitar jogadores/partidas apagados por outro aparelho.
    const [rSnap, pSnap] = await Promise.all([
      fbDB.collection('roster').get(),
      fbDB.collection('partidas').get(),
    ]);
    if (rSnap.empty) state.jogadores.forEach(cloudSetPlayer);
    if (pSnap.empty) state.partidas.filter(p => p.finalizada && p.id !== 'viewer').forEach(cloudSetPartida);
    // Escuta mudanças em tempo real
    fbDB.collection('roster').onSnapshot(s => mergeCloudRoster(s.docs), e => console.warn('roster snap', e));
    fbDB.collection('partidas').onSnapshot(s => mergeCloudPartidas(s.docs), e => console.warn('partidas snap', e));
    // Jogo ao vivo compartilhado (todos veem automaticamente)
    fbDB.collection('live').doc('atual').onSnapshot(onLiveSnapshot, e => console.warn('live snap', e));
    // Se eu tenho um jogo local em andamento, retomo como dono (re-publico ao vivo)
    const meu = currentPartida();
    if (meu) cloudSetLive(meu);
  } catch (e) { console.warn('sync init', e); }
}

/* ------------------------------ Navegação -------------------------------- */
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    currentScreen = tab.dataset.screen;
    if (currentScreen === 'dinheiro') dinheiroPeriodo = 'dia'; // sempre abre em Hoje
    render();
  });
});

render();

// Sincroniza cadastro + histórico com a nuvem (todos os aparelhos veem o mesmo)
initCloudSync();

/* ------------------------------ PWA -------------------------------------- */
// Atualização à prova de falha: limpa caches + remove o SW antigo e recarrega
// buscando tudo novo do servidor (o SW se registra de novo no próximo load).
let _atualizando = false;
async function forcarAtualizacao() {
  if (_atualizando) return;
  _atualizando = true;
  toast('Atualizando…');
  try {
    if (window.caches) {
      const ks = await caches.keys();
      await Promise.all(ks.map(k => caches.delete(k)));
    }
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
  } catch (_) {}
  // querystring nova evita o cache HTTP do navegador servir o index antigo
  const u = new URL(location.href);
  u.searchParams.set('u', Date.now());
  location.replace(u.toString());
}

function mostrarBannerAtualizar() {
  if (document.getElementById('update-banner')) return;
  const b = el('<div id="update-banner">🔄 Nova versão disponível — toque para atualizar</div>');
  b.addEventListener('click', () => forcarAtualizacao());
  document.body.appendChild(b);
}
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then(reg => {
      // Detecta nova versão instalada e avisa o usuário
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) mostrarBannerAtualizar();
        });
      });
      // Checa por atualização de tempos em tempos (a cada 15 min)
      setInterval(() => reg.update().catch(() => {}), 15 * 60 * 1000);
    }).catch(err => console.warn('SW falhou', err));
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
