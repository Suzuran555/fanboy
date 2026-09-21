/* Dragon Arena browser client: lobby, live game, replay viewer. */
(function () {
  'use strict';
  const Eng = window.DragonEngine;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } } };
  const tab = { get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* private mode */ } } };
  const DIRS = 'NESW';
  const MODE_LABEL = { manual: 'Manual', forage: 'Forage', coil: 'Coil', hunt: 'Hunt', goto: 'Go to' };
  const WHY = { W: 'swam into kelp', S: 'hit its own body', O: 'hit another dragon', H: 'head-on collision', A: 'no valid action' };
  const PACE = [[120, '0.12 s'], [250, '0.25 s'], [500, '0.5 s'], [800, '0.8 s'], [1500, '1.5 s']];
  const TIMER = [[0, 'no wait'], [700, '0.7 s'], [1500, '1.5 s'], [3000, '3 s'], [6000, '6 s'], [-1, 'unlimited']];

  const S = {
    ws: null, connected: false, me: null, welcome: null, room: null, preview: null,
    game: null, replay: null, follow: true, splitPick: false, sprint: [], shift: false,
    sideDirty: true, lastPing: null, backTo: 'home',
  };
  const view = new window.BoardView($('board'));
  const previewView = new window.BoardView($('previewCanvas'));

  // ================================================================ network
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    const ws = new WebSocket(proto + location.host + '/ws');
    S.ws = ws;
    ws.onopen = () => {
      S.connected = true;
      const params = new URLSearchParams(location.search);
      if (params.get('key')) store.set('da.key', params.get('key'));
      const named = !!store.get('da.name');
      // A friend opening an invite link for the first time is asked for a name before joining.
      if (params.get('room') && !named) $('codeInput').value = params.get('room');
      send({ t: 'hello', name: store.get('da.name') || '', token: tab.get('da.token') || undefined, lastToken: store.get('da.token') || undefined, key: store.get('da.key') || undefined, room: named ? params.get('room') || undefined : undefined });
      status('');
    };
    ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } const h = on[m.t]; if (h) h(m); };
    ws.onclose = (ev) => {
      S.connected = false;
      if (ev.code === 4001) return;                       // wrong access key: do not hammer the server
      if (ev.code === 4000) { status('This game was opened in another tab — that tab is now in control.'); return; }
      status('Connection lost — reconnecting…');
      setTimeout(connect, 1200);
    };
  }
  function send(m) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(m)); }
  function status(text) { $('homeStatus').textContent = text; $('lobbyStatus').textContent = text; if (text && S.game && !S.replay) toast(text); }

  const on = {
    welcome(m) {
      S.me = m.id; S.welcome = m;
      tab.set('da.token', m.token); store.set('da.token', m.token);
      if (!$('nameInput').value) $('nameInput').value = m.name === 'Player' ? '' : m.name;
      fillSelect($('paceSel'), PACE); fillSelect($('timerSel'), TIMER);
      const rep = new URLSearchParams(location.search).get('replay');
      if (rep && !S.replay) openReplay(rep);
    },
    room(m) {
      const was = S.room;
      S.room = m;
      if (S.replay) return;
      if (m.phase === 'lobby') { S.game = null; show('lobby'); renderLobby(); }
      else if (S.game) { if (m.phase === 'over') showResult(); else $('overlay').hidden = true; S.sideDirty = true; }
      if (!was || was.code !== m.code) history.replaceState(null, '', '?room=' + m.code);
    },
    preview(m) { S.preview = m; renderPreview(); if (S.room && S.room.phase === 'lobby' && !S.replay) renderLobby(); },
    left() { S.room = null; S.game = null; history.replaceState(null, '', location.pathname); show('home'); },
    sync(m) { startGame(m); },
    d(m) { if (S.game && !S.replay) applyDeltas(S.game, m.list, true); },
    ctl(m) { if (S.game) { S.game.ctl = new Map(m.ctl.list.map((c) => [c.id, c])); S.game.childMode = m.ctl.childMode; S.sideDirty = true; } },
    notice(m) { toast(m.text); },
    error(m) { if (S.game && !S.replay) toast(m.msg); else status(m.msg); },
    denied(m) { show('home'); status(m.msg); },
    pong(m) { S.lastPing = Math.round(performance.now() - m.ts); },
  };
  setInterval(() => send({ t: 'ping', ts: performance.now() }), 5000);

  // ================================================================ screens
  function show(name) {
    for (const id of ['home', 'lobby', 'game']) $(id).hidden = id !== name;
    if (name === 'game') requestAnimationFrame(relayout);
    if (name === 'lobby') requestAnimationFrame(renderPreview);
  }
  function fillSelect(sel, pairs) { if (sel.options.length) return; for (const [v, label] of pairs) { const o = document.createElement('option'); o.value = v; o.textContent = label; sel.appendChild(o); } }
  function toast(text) {
    const el = $('toast'); el.textContent = text; el.hidden = false;
    clearTimeout(toast.timer); toast.timer = setTimeout(() => { el.hidden = true; }, 2600);
  }

  // ---------------------------------------------------------------- home
  function myName() { const n = $('nameInput').value.trim() || 'Player'; store.set('da.name', n); return n; }
  $('createBtn').onclick = () => { send({ t: 'name', name: myName() }); send({ t: 'create' }); };
  $('joinBtn').onclick = () => { send({ t: 'name', name: myName() }); send({ t: 'join', code: $('codeInput').value }); };
  $('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinBtn').click(); });
  $('nameInput').addEventListener('change', () => send({ t: 'name', name: myName() }));
  $('replayList').addEventListener('toggle', async () => {
    if (!$('replayList').open) return;
    try {
      const ids = await (await fetch('/replays')).json();
      $('replayItems').innerHTML = ids.length ? ids.map((id) => `<li><a href="?replay=${id}">${id}</a></li>`).join('') : '<li>No games finished yet.</li>';
    } catch (e) { $('replayItems').innerHTML = '<li>Could not load the list.</li>'; }
  });

  // ---------------------------------------------------------------- lobby
  const isHost = () => S.room && S.room.host === S.me;
  const mySeat = () => (S.room ? S.room.seats.findIndex((s) => s.kind === 'human' && s.player === S.me) : -1);
  const memberName = (id) => { const m = S.room && S.room.members.find((x) => x.id === id); return m ? m.name : 'Player'; };

  function renderLobby() {
    const r = S.room; if (!r) return;
    const host = isHost();
    $('roomCode').textContent = r.code;
    $('lobbyScore').textContent = r.score[0] + r.score[1] + r.score[2] ? `Series: A ${r.score[0]} – ${r.score[1]} B${r.score[2] ? ` · ${r.score[2]} drawn` : ''}` : '';
    const styles = S.welcome ? S.welcome.styles : {};
    $('seats').innerHTML = r.seats.map((s, i) => {
      const ids = S.preview && S.preview.mapId === r.settings.mapId ? S.preview.preview.dragons.filter((d) => d.team === i).map((d) => '#' + d.id) : [];
      const team = `Team ${'AB'[i]}` + (ids.length ? ` — starts with ${ids.slice(0, 6).join(' ')}${ids.length > 6 ? ' …' : ''}` : '');
      let who, blurb = '', actions = '';
      const styleSel = `<select class="mini" data-style="${i}">${Object.keys(styles).map((k) => `<option value="${k}"${s.style === k ? ' selected' : ''}>${esc(styles[k].label)} AI</option>`).join('')}</select>`;
      if (s.kind === 'human') {
        who = `<div class="seat-who">${esc(memberName(s.player))}${s.player === S.me ? ' <small>(you)</small>' : ''}</div>`;
        if (s.player === S.me) actions = `<button class="btn small ghost" data-act="spec">Stand up and spectate</button>`;
      } else if (s.kind === 'ai') {
        who = `<div class="seat-who">${esc(styles[s.style].label)} AI</div>`; blurb = `<div class="seat-blurb">${esc(styles[s.style].blurb)}</div>`;
        if (host) actions = `${styleSel}<button class="btn small ghost" data-act="open" data-seat="${i}">Remove AI</button>`;
      } else {
        who = `<div class="seat-who open">Open — waiting for a player</div>`;
        actions = (mySeat() !== i ? `<button class="btn small" data-act="sit" data-seat="${i}">Sit here</button>` : '') + (host ? `${styleSel}<button class="btn small ghost" data-act="ai" data-seat="${i}">Add AI</button>` : '');
      }
      return `<div class="seat ${i ? 'b' : ''}"><div class="seat-top"><span class="seat-team">${team}</span></div>${who}${blurb}<div class="seat-actions">${actions}</div></div>`;
    }).join('') + (host ? `<div><button class="btn small ghost" id="swapBtn">Swap sides</button></div>` : '');
    $('members').textContent = 'In the room: ' + r.members.map((m) => m.name + (m.id === r.host ? ' (host)' : '') + (m.online ? '' : ' (away)')).join(', ');
    const st = r.settings;
    setSelect($('setTurnTimer'), st.turnTimer); setSelect($('setRoundMs'), st.roundMs); setSelect($('setMaxRounds'), st.maxRounds);
    $('setAssist').checked = st.assist;
    for (const id of ['setTurnTimer', 'setRoundMs', 'setMaxRounds', 'setAssist', 'customMapBtn', 'customMapText']) $(id).disabled = !host;
    const ready = !r.seats.some((s) => s.kind === 'open');
    $('startBtn').hidden = !host; $('startBtn').disabled = !ready;
    $('lobbyStatus').textContent = host ? (ready ? '' : 'Fill both sides — share the invite link, or add an AI.') : 'Waiting for the host to start the match.';
    renderMapList();
  }
  function setSelect(sel, value) {
    if (![...sel.options].some((o) => o.value === String(value))) { const o = document.createElement('option'); o.value = value; o.textContent = String(value); sel.appendChild(o); }
    sel.value = String(value);
  }
  function renderMapList() {
    const r = S.room; if (!r || !S.welcome) return;
    const list = S.welcome.maps.slice();
    if (r.settings.mapId === 'custom' && r.map) list.unshift(Object.assign({}, r.map, { id: 'custom', name: (r.map.name || 'Custom') + ' (custom)' }));
    $('mapList').innerHTML = list.map((m) => `<button class="map-item${m.id === r.settings.mapId ? ' sel' : ''}" data-map="${esc(m.id)}"${isHost() ? '' : ' disabled'}><b>${esc(m.name)}</b><small>${m.w}×${m.h} · ${m.perTeam[0]} dragon${m.perTeam[0] === 1 ? '' : 's'} each${m.portals ? ` · ${m.portals} portal pair${m.portals > 1 ? 's' : ''}` : ''}${m.kelp ? '' : ' · open water'}</small></button>`).join('');
  }
  function renderPreview() {
    const p = S.preview; if (!p || $('lobby').hidden) return;
    previewView.setMap(p.preview.map);
    previewView.state = { dragons: new Map(p.preview.dragons.map((d) => [d.id, d])), pearls: new Uint8Array(p.preview.map.w * p.preview.map.h), cd: null };
    previewView.occDirty = true;
    previewView.layout(420, 420);
    previewView.draw(performance.now());
    const i = p.info;
    $('mapInfo').innerHTML = `<b>${esc(i.name)}</b> · ${i.w}×${i.h}${i.symmetry ? ` · symmetry ${i.symmetry}` : ' · no declared symmetry'}<br>${i.perTeam[0]} dragon${i.perTeam[0] === 1 ? '' : 's'} per team, starting length ${i.startLength[0]} · ${i.spawnTiles} pearl tiles · ${i.kelp} kelp edges · ${i.portals} portal pairs<br><span style="color:var(--faint)">Brighter water spawns pearls more often.</span>`;
  }
  $('seats').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const seat = +b.dataset.seat;
    if (b.id === 'swapBtn') send({ t: 'swap' });
    else if (b.dataset.act === 'sit') send({ t: 'seat', seat });
    else if (b.dataset.act === 'spec') send({ t: 'seat', seat: 'spec' });
    else if (b.dataset.act === 'open') send({ t: 'seatKind', seat, kind: 'open' });
    else if (b.dataset.act === 'ai') send({ t: 'seatKind', seat, kind: 'ai', style: document.querySelector(`select[data-style="${seat}"]`).value });
  });
  $('seats').addEventListener('change', (e) => { const s = e.target.closest('select[data-style]'); if (s && S.room.seats[+s.dataset.style].kind === 'ai') send({ t: 'seatKind', seat: +s.dataset.style, kind: 'ai', style: s.value }); });
  $('mapList').addEventListener('click', (e) => { const b = e.target.closest('[data-map]'); if (b && isHost()) send({ t: 'settings', settings: { mapId: b.dataset.map } }); });
  $('setTurnTimer').onchange = (e) => send({ t: 'settings', settings: { turnTimer: +e.target.value } });
  $('setRoundMs').onchange = (e) => send({ t: 'settings', settings: { roundMs: +e.target.value } });
  $('setMaxRounds').onchange = (e) => send({ t: 'settings', settings: { maxRounds: +e.target.value } });
  $('setAssist').onchange = (e) => send({ t: 'settings', settings: { assist: e.target.checked } });
  $('customMapBtn').onclick = () => send({ t: 'customMap', text: $('customMapText').value });
  $('startBtn').onclick = () => send({ t: 'start' });
  $('leaveBtn').onclick = () => send({ t: 'leave' });
  $('copyLink').onclick = async () => {
    const url = location.origin + location.pathname + '?room=' + S.room.code + (store.get('da.key') ? '&key=' + encodeURIComponent(store.get('da.key')) : '');
    try { await navigator.clipboard.writeText(url); $('copyLink').textContent = 'Copied'; } catch (e) { prompt('Invite link', url); }
    setTimeout(() => { $('copyLink').textContent = 'Copy invite link'; }, 1500);
  };

  // ================================================================ game state
  function newGame(map, state, extra) {
    const n = map.w * map.h;
    const G = Object.assign({
      map, n, seat: -1, seats: [], settings: {}, round: state.round, maxRounds: state.maxRounds,
      dragons: new Map(state.dragons.map((d) => [d.id, d])), pearls: new Uint8Array(n), cd: Int32Array.from(state.cd),
      order: state.order || [], turnId: null, paused: false, awaiting: null, result: state.result || null,
      ctl: new Map(), childMode: 'forage', log: [], lastTick: state.inRound ? state.round : state.round - 1, stats: [{ eaten: 0 }, { eaten: 0 }],
    }, extra);
    for (const p of state.pearls) G.pearls[p] = 1;
    return G;
  }

  function startGame(m) {
    const G = newGame(m.map, m.state, { seat: m.you, seats: m.seats, settings: m.settings, paused: m.paused });
    if (m.ctl) { G.ctl = new Map(m.ctl.list.map((c) => [c.id, c])); G.childMode = m.ctl.childMode; }
    if (m.awaiting) G.awaiting = { id: m.awaiting.id, team: m.awaiting.team, start: performance.now(), end: m.awaiting.ms < 0 ? -1 : performance.now() + m.awaiting.ms };
    S.game = G; S.replay = null; S.sprint = []; S.splitPick = false;
    view.setMap(G.map); view.state = G; view.myTeam = G.seat >= 0 ? G.seat : null; view.selected = null; view.occDirty = true;
    $('overlay').hidden = true; $('countdown').hidden = true;
    $('livePanel').hidden = false; $('replayPanel').hidden = true; $('playerPanel').hidden = G.seat < 0;
    $('modeLabel').textContent = 'Round';
    setSelect($('paceSel'), G.settings.roundMs); setSelect($('timerSel'), G.settings.turnTimer);
    $('childModeSel').value = G.childMode;
    $('log').innerHTML = '';
    show('game');
    if (G.seat >= 0) { const mine = myDragons(G); if (mine.length) select(mine[0].id); }
    if (G.result) showResult();
    S.sideDirty = true;
  }

  function myDragons(G) { const out = []; for (const d of G.dragons.values()) if (d.team === G.seat) out.push(d); return out.sort((a, b) => a.id - b.id); }
  function teamSummary(G, team) {
    let count = 0, longest = 0, total = 0;
    for (const d of G.dragons.values()) if (d.team === team) { const L = d.segs.length / 3; count++; total += L; if (L > longest) longest = L; }
    return { count, longest, total };
  }

  function applyDeltas(G, list, live) {
    const now = performance.now();
    for (const x of list) {
      switch (x.k) {
        case 'n': if (live) startCountdown(x.ms); break;
        case 'r': {
          G.round = x.r; G.order = x.order || G.order; G.turnId = null;
          if (x.r > G.lastTick) { G.lastTick = x.r; for (let i = 0; i < G.n; i++) if (G.cd[i] > 0) G.cd[i]--; }
          for (let k = 0; k < x.rs.length; k += 2) G.cd[x.rs[k]] = x.rs[k + 1];
          for (const p of x.sp) G.pearls[p] = 1;
          break;
        }
        case 't': {
          G.turnId = x.id; G.awaiting = null;
          if (x.up) for (const d of x.up) { G.dragons.set(d.id, d); if (live && G.settings.roundMs >= 250) view.flash.set(d.id, now); }
          if (x.child !== undefined && !G.order.includes(x.child)) G.order.push(x.child);
          if (x.pd) for (const p of x.pd) { G.pearls[p] = 0; }
          if (x.dead) for (const dd of x.dead) {
            G.dragons.delete(dd.id);
            logLine(G, dd.team, `#${dd.id} (length ${dd.len}) ${WHY[dd.why] || 'died'}${dd.by !== null && dd.by !== undefined ? ` — #${dd.by}` : ''}`);
            if (view.selected === dd.id) { view.selected = null; if (live && S.follow && G.seat === dd.team) { const mine = myDragons(G); if (mine.length) select(mine[0].id); } }
          }
          if (x.pa) for (const p of x.pa) G.pearls[p] = 1;
          if (x.child !== undefined) { const c = G.dragons.get(x.child); logLine(G, c ? c.team : 0, `#${x.id} split → #${x.child}${c ? ` (length ${c.segs.length / 3})` : ''}${x.note === 'escape-split' ? ' to escape' : ''}`); }
          if (x.note === 'ram' && x.dead) logLine(G, x.dead[x.dead.length - 1].team, x.a.length > 1 ? `#${x.id} rammed it with a ${x.a.length}-step sprint` : `#${x.id} rammed it`);
          view.occDirty = true;
          break;
        }
        case 'w':
          G.awaiting = { id: x.id, team: x.team, start: now, end: x.ms < 0 ? -1 : now + x.ms };
          if (live && S.follow && x.team === G.seat && !S.shift && view.selected !== x.id) { select(x.id); S.autoSelectedAt = now; }
          break;
        case 'e': break;
        case 'p': G.paused = x.on; G.pausedBy = x.by; break;
        case 'c': G.settings = x.settings; setSelect($('paceSel'), x.settings.roundMs); setSelect($('timerSel'), x.settings.turnTimer); break;
        case 'o': G.result = x.result; G.awaiting = null; if (live) showResult(); break;
      }
    }
    S.sideDirty = true;
  }

  function logLine(G, team, text) {
    G.log.push({ r: G.round, team, text });
    if (S.replay) return;
    const el = document.createElement('div');
    el.innerHTML = `<span class="r">${G.round}</span><span class="${team ? 'b' : 'a'}">${esc(text)}</span>`;
    const log = $('log'); log.prepend(el);
    while (log.childElementCount > 120) log.lastElementChild.remove();
  }

  function startCountdown(ms) {
    const el = $('countdown'), end = performance.now() + ms;
    el.hidden = false;
    const tick = () => { const left = end - performance.now(); if (left <= 0 || !S.game) { el.hidden = true; return; } el.textContent = Math.ceil(left / 1000); requestAnimationFrame(tick); };
    tick();
  }

  // ================================================================ sidebar
  function renderSide() {
    const G = S.replay ? S.replay.G : S.game; if (!G) return;
    S.sideDirty = false;
    $('roundText').textContent = `${Math.min(G.round + 1, G.maxRounds)} / ${G.maxRounds}`;
    $('roundBar').style.width = (100 * (G.round + 1) / G.maxRounds) + '%';
    const sums = [teamSummary(G, 0), teamSummary(G, 1)];
    const lead = sums[0].longest !== sums[1].longest ? (sums[0].longest > sums[1].longest ? 0 : 1) : sums[0].total !== sums[1].total ? (sums[0].total > sums[1].total ? 0 : 1) : -1;
    $('teams').innerHTML = sums.map((s, i) => `<div class="team ${i ? 'b' : ''} ${lead === i ? 'lead' : ''}"><div class="team-name"><b>${'AB'[i]}</b> ${esc(G.seats[i] ? G.seats[i].name || '' : '')}${G.seat === i ? ' · you' : ''}</div><div class="team-big">${s.longest}<small>longest</small></div><div class="team-sub">${s.count} dragon${s.count === 1 ? '' : 's'} · ${s.total} total</div></div>`).join('');
    if (S.replay) { renderReplayMeta(); return; }
    // Whose turn: the round's id order, with the dragon acting now marked.
    const cur = G.awaiting ? G.order.indexOf(G.awaiting.id) : G.turnId !== null ? G.order.indexOf(G.turnId) + 1 : 0;
    const from = Math.max(0, Math.min(cur - 2, G.order.length - 12));
    let chips = '';
    for (let k = from; k < Math.min(G.order.length, from + 12); k++) {
      const id = G.order[k], dd = G.dragons.get(id);
      chips += `<span class="oc ${dd ? (dd.team ? 'b' : 'a') : 'dead'}${k < cur ? ' done' : ''}${k === cur ? ' now' : ''}" data-id="${id}">${id}</span>`;
    }
    $('orderStrip').innerHTML = (from > 0 ? '<span class="oc more">…</span>' : '') + chips + (from + 12 < G.order.length ? `<span class="oc more">+${G.order.length - from - 12}</span>` : '');
    $('turnRow').innerHTML = `Turn ${Math.min(cur + 1, G.order.length)} of ${G.order.length} · ascending id order` + (S.lastPing !== null ? ` · ${S.lastPing} ms` : '');
    $('pauseBtn').textContent = G.paused ? 'Resume' : 'Pause'; $('pauseBtn').classList.toggle('on', G.paused);
    $('stepBtn').disabled = $('stepRoundBtn').disabled = !G.paused;
    const canControl = G.seat >= 0 || isHost();
    for (const id of ['pauseBtn', 'paceSel', 'timerSel']) $(id).disabled = !canControl;
    renderBanner(G);
    if (G.seat < 0) return;
    // Selected dragon card
    const d = view.selected !== null ? G.dragons.get(view.selected) : null;
    const card = $('selCard');
    if (d && d.team === G.seat) {
      const c = G.ctl.get(d.id) || { mode: 'manual', q: [] };
      const L = d.segs.length / 3;
      const q = c.q.map((a) => (a.k === 's' ? `✂${a.n === 'half' ? '½' : a.n}` : a.d.map((x) => DIRS[x]).join(''))).join(' ');
      const sprint = S.sprint.length ? ` <b>sprint ${S.sprint.map((x) => DIRS[x]).join('')} (−${S.sprint.length - 1})</b>` : '';
      card.innerHTML = `<div class="sel-title"><span>Dragon #${d.id}</span><small>length ${L} · reach ${Math.max(1, L - 1)} tile${L - 1 > 1 ? 's' : ''} per turn</small></div>
        <div class="mode-row">${['manual', 'forage', 'coil', 'hunt'].map((m, k) => `<button class="btn ${c.mode === m ? 'on' : ''}" data-mode="${m}">${MODE_LABEL[m]}<small>${k + 1}</small></button>`).join('')}</div>
        <div class="split-row"><button class="btn" data-split="half" ${L < 4 ? 'disabled' : ''}>Split ½<small>Q</small></button><button class="btn" data-split="2" ${L < 4 ? 'disabled' : ''}>Split 2<small>E</small></button><button class="btn ${S.splitPick ? 'on' : ''}" data-split="pick" ${L < 4 ? 'disabled' : ''}>Pick…<small>X</small></button><button class="btn" data-clear="1">Clear<small>⌫</small></button></div>
        <div class="queue">${c.mode === 'goto' ? 'swimming to target, then coil' : q || sprint ? `queue: ${esc(q)}${sprint}` : c.mode === 'manual' ? 'no orders queued — it keeps going straight' : MODE_LABEL[c.mode].toLowerCase() + ' autopilot'}</div>`;
    } else if (d) {
      card.innerHTML = `<div class="sel-title"><span>Enemy dragon #${d.id}</span><small>length ${d.segs.length / 3} · reach ${Math.max(1, d.segs.length / 3 - 1)} per turn</small></div><div class="queue">Turn on “Sprint range” to see what it can reach this turn.</div>`;
    } else card.innerHTML = `<div class="queue">Click one of your dragons, or press Tab.</div>`;
    // Dragon list
    const mine = myDragons(G);
    $('dragonList').innerHTML = mine.map((x) => {
      const c = G.ctl.get(x.id) || { mode: 'manual', q: [] };
      return `<div class="drow${x.id === view.selected ? ' sel' : ''}${G.awaiting && G.awaiting.id === x.id ? ' await' : ''}" data-id="${x.id}"><span class="id">#${x.id}</span><span class="len">${x.segs.length / 3}</span><span class="mode ${c.mode}">${MODE_LABEL[c.mode]}</span><span class="q">${c.q.length ? c.q.length + ' queued' : ''}</span></div>`;
    }).join('') || '<div class="queue">All your dragons are gone.</div>';
    view.ghost = d && d.team === G.seat ? { id: d.id, actions: (G.ctl.get(d.id) || { q: [] }).q, sprint: S.sprint } : null;
    const c = d && G.ctl.get(d.id); view.target = c && c.mode === 'goto' ? c.arg : null;
  }

  function renderBanner(G) {
    const el = $('banner');
    if (G.result) { el.hidden = true; return; }
    if (G.paused) { el.hidden = false; el.className = 'banner'; el.innerHTML = `Paused${G.pausedBy ? ' — ' + esc(G.pausedBy) : ''} · <kbd>Space</kbd> resume · <kbd>.</kbd> one turn · <kbd>,</kbd> one round`; return; }
    const a = G.awaiting;
    if (!a) { el.hidden = true; return; }
    el.hidden = false;
    const mine = a.team === G.seat;
    el.className = 'banner' + (mine ? ' mine' : '');
    const d = G.dragons.get(a.id);
    el.innerHTML = (mine ? `Your move — dragon #${a.id}${d ? ` (length ${d.segs.length / 3})` : ''}` : `Waiting for ${esc((G.seats[a.team] && G.seats[a.team].name) || 'the other side')} — dragon #${a.id}`) + `<span class="timer" id="bannerTimer"></span>`;
  }

  // ================================================================ input
  function select(id) { view.selected = id; S.sprint = []; S.splitPick = false; view.splitHover = null; S.sideDirty = true; }
  function selectedMine() { const G = S.game; if (!G || G.seat < 0 || view.selected === null) return null; const d = G.dragons.get(view.selected); return d && d.team === G.seat ? d : null; }

  function lastHeading(G, d) {
    if (S.sprint.length) return S.sprint[S.sprint.length - 1];
    const c = G.ctl.get(d.id);
    if (c) for (let k = c.q.length - 1; k >= 0; k--) if (c.q[k].k === 'm') return c.q[k].d[c.q[k].d.length - 1];
    return d.segs[2];
  }

  function pressDir(dir, shift, force) {
    const G = S.game, d = selectedMine();
    if (!d) { if (G && G.seat >= 0) toast('Select one of your dragons first (click it or press Tab).'); return; }
    // The selection just jumped to the next dragon awaiting orders: this key was meant for the previous one.
    if (S.autoSelectedAt && performance.now() - S.autoSelectedAt < 130) return;
    if (!force) {
      if (((lastHeading(G, d) + 2) & 3) === dir) { toast('A dragon cannot turn back into its own neck. (Ctrl forces it.)'); return; }
      const c = G.ctl.get(d.id);
      if (!S.sprint.length && !(c && c.q.length) && view.nbr[(d.segs[1] * G.map.w + d.segs[0]) * 4 + dir] < 0) { toast('Kelp in the way. (Ctrl forces it.)'); return; }
    }
    if (shift) {
      const L = d.segs.length / 3;
      if (S.sprint.length >= Math.max(1, L - 1)) { toast(`Length ${L} can pay for at most ${Math.max(1, L - 1)} steps.`); return; }
      S.sprint.push(dir); S.sideDirty = true; return;
    }
    send({ t: 'cmd', id: d.id, a: { k: 'm', d: [dir] } });
  }
  function commitSprint() {
    const d = selectedMine();
    if (d && S.sprint.length) send({ t: 'cmd', id: d.id, a: { k: 'm', d: S.sprint.slice() } });
    S.sprint = []; S.sideDirty = true;
  }
  /** Shift-click: sprint the selected dragon along the shortest free path to a tile (or into an enemy head) this turn. */
  function sprintTo(target) {
    const G = S.game, d = selectedMine(); if (!d) return;
    const occ = view.occupancy(), nbr = view.nbr, L = d.segs.length / 3;
    const start = d.segs[1] * G.map.w + d.segs[0];
    const prev = new Map([[start, null]]); let frontier = [start], found = false;
    for (let depth = 1; depth <= Math.max(1, L - 1) && frontier.length && !found; depth++) {
      const next = [];
      for (const t of frontier) {
        for (let dir = 0; dir < 4 && !found; dir++) {
          const nt = nbr[t * 4 + dir];
          if (nt < 0 || prev.has(nt)) continue;
          const blocked = occ[2 * nt] >= 0;
          if (blocked && !(nt === target && occ[2 * nt + 1] === 0 && occ[2 * nt] !== d.id)) continue;   // only a head may be the last step
          prev.set(nt, { from: t, dir });
          if (nt === target) found = true; else if (!blocked) next.push(nt);
        }
        if (found) break;
      }
      frontier = next;
    }
    if (!found) { toast(`Not reachable this turn — length ${L} can travel ${Math.max(1, L - 1)} tile${L > 2 ? 's' : ''} through open water.`); return; }
    const dirs = []; for (let t = target; prev.get(t); t = prev.get(t).from) dirs.unshift(prev.get(t).dir);
    send({ t: 'cmd', id: d.id, a: { k: 'm', d: dirs }, replace: true });
  }

  function doSplit(n) { const d = selectedMine(); if (!d) return; if (d.segs.length / 3 < 4) { toast('A dragon needs length 4 to split (both halves must be at least 2).'); return; } send({ t: 'cmd', id: d.id, a: { k: 's', n } }); }
  function setMode(mode, arg) { const d = selectedMine(); if (d) send({ t: 'mode', ids: [d.id], mode, arg }); }

  const KEY_DIR = { ArrowUp: 0, ArrowRight: 1, ArrowDown: 2, ArrowLeft: 3, w: 0, d: 1, s: 2, a: 3, W: 0, D: 1, S: 2, A: 3 };
  window.addEventListener('keydown', (e) => {
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (!$('help').hidden) { if (e.key === 'Escape' || e.key === '?') $('help').hidden = true; return; }   // no game keys while reading the help
    if ($('game').hidden) return;
    if (S.replay) { replayKey(e); return; }
    const G = S.game; if (!G) return;
    if (e.key === 'Shift') { S.shift = true; return; }
    if (e.key in KEY_DIR && !e.metaKey) { e.preventDefault(); pressDir(KEY_DIR[e.key], e.shiftKey, e.ctrlKey); return; }
    switch (e.key) {
      case 'Tab': {
        e.preventDefault();
        const mine = myDragons(G); if (!mine.length) break;
        const k = mine.findIndex((x) => x.id === view.selected);
        select(mine[(k + (e.shiftKey ? -1 : 1) + mine.length) % mine.length].id); break;
      }
      case 'q': case 'Q': doSplit('half'); break;
      case 'e': case 'E': doSplit(2); break;
      case 'x': case 'X': if (selectedMine()) { S.splitPick = !S.splitPick; view.splitHover = null; S.sideDirty = true; } break;
      case '1': setMode('manual'); break;
      case '2': setMode('forage'); break;
      case '3': setMode('coil'); break;
      case '4': setMode('hunt'); break;
      case 'Backspace': case 'Escape': { e.preventDefault(); S.sprint = []; S.splitPick = false; view.splitHover = null; const d = selectedMine(); if (d && e.key === 'Backspace') send({ t: 'clear', id: d.id }); S.sideDirty = true; break; }
      case ' ': e.preventDefault(); send({ t: 'pause', on: !G.paused }); break;
      case '.': send({ t: 'step', turns: 1 }); break;
      case ',': send({ t: 'step', round: true }); break;
      case 't': case 'T': toggle('timers'); break;
      case 'v': case 'V': toggle('vision'); break;
      case 'r': case 'R': toggle('range'); break;
      case 'h': case 'H': toggle('threat'); break;
      case 'i': case 'I': toggle('ids'); break;
      case 'f': case 'F': S.follow = !S.follow; toast(S.follow ? 'Auto-follow on: the dragon awaiting orders gets selected.' : 'Auto-follow off.'); break;
      case 'c': case 'C': { const d = view.selected !== null && G.dragons.get(view.selected); if (d) view.centerOn(d.segs[0], d.segs[1]); break; }
      case '?': $('help').hidden = false; break;
    }
  });
  window.addEventListener('keyup', (e) => { if (e.key === 'Shift') { S.shift = false; commitSprint(); } });
  window.addEventListener('blur', () => { S.shift = false; S.sprint = []; });

  function toggle(name) {
    view.opt[name] = !view.opt[name];
    const map = { timers: 'tglTimers', vision: 'tglVision', range: 'tglRange', threat: 'tglThreat', ids: 'tglIds' };
    $(map[name]).classList.toggle('on', view.opt[name]);
    store.set('da.opt.' + name, view.opt[name] ? '1' : '0');
  }
  for (const [name, id] of [['timers', 'tglTimers'], ['vision', 'tglVision'], ['range', 'tglRange'], ['threat', 'tglThreat'], ['ids', 'tglIds']]) {
    $(id).onclick = () => toggle(name);
    const saved = store.get('da.opt.' + name);
    if (saved === '1' || (saved === null && name === 'ids')) toggle(name);
  }
  $('orderStrip').addEventListener('click', (e) => { const c = e.target.closest('[data-id]'); const G = S.game; if (c && G && G.dragons.has(+c.dataset.id)) select(+c.dataset.id); });
  $('helpBtn').onclick = () => { $('help').hidden = false; };
  $('helpClose').onclick = () => { $('help').hidden = true; };
  $('help').addEventListener('click', (e) => { if (e.target === $('help')) $('help').hidden = true; });

  // Mouse on the board
  const board = $('board');
  let drag = null;
  board.addEventListener('contextmenu', (e) => e.preventDefault());
  board.addEventListener('mousedown', (e) => {
    const G = S.replay ? S.replay.G : S.game; if (!G) return;
    if (e.button === 1 || (e.button === 0 && e.altKey)) { drag = { x: e.clientX, y: e.clientY }; e.preventDefault(); return; }
    const tile = view.tileAt(e); if (!tile) return;
    const seg = view.segmentAt(tile.i);
    if (e.button === 2) { if (!S.replay && selectedMine()) setMode('goto', tile.i); return; }
    if (e.button === 0 && e.shiftKey && !S.replay && selectedMine()) { e.preventDefault(); sprintTo(tile.i); return; }
    if (S.splitPick && seg && selectedMine() && seg.id === view.selected) {
      const L = G.dragons.get(seg.id).segs.length / 3, n = L - seg.index;
      if (seg.index >= 2 && n >= 2) doSplit(n); else toast('Both parts need at least 2 segments.');
      S.splitPick = false; view.splitHover = null; S.sideDirty = true; return;
    }
    if (seg) select(seg.id);
  });
  window.addEventListener('mousemove', (e) => {
    if (drag) {
      const dx = Math.round((drag.x - e.clientX) / view.cell), dy = Math.round((drag.y - e.clientY) / view.cell);
      if (dx || dy) { view.pan(dx, dy); drag.x -= dx * view.cell; drag.y -= dy * view.cell; }
      return;
    }
    if (S.splitPick && e.target === board) {
      const tile = view.tileAt(e), seg = tile && view.segmentAt(tile.i);
      view.splitHover = seg && seg.id === view.selected && seg.index >= 2 ? seg : null;
    }
  });
  window.addEventListener('mouseup', () => { drag = null; });

  $('selCard').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.mode) setMode(b.dataset.mode);
    else if (b.dataset.split === 'half') doSplit('half');
    else if (b.dataset.split === '2') doSplit(2);
    else if (b.dataset.split === 'pick') { S.splitPick = !S.splitPick; S.sideDirty = true; }
    else if (b.dataset.clear) { const d = selectedMine(); if (d) send({ t: 'clear', id: d.id }); }
  });
  $('dragonList').addEventListener('click', (e) => { const r = e.target.closest('[data-id]'); if (r) { select(+r.dataset.id); const d = S.game.dragons.get(+r.dataset.id); if (d && e.detail === 2) view.centerOn(d.segs[0], d.segs[1]); } });
  $('allForage').onclick = () => { const G = S.game; if (G) send({ t: 'mode', ids: myDragons(G).map((d) => d.id), mode: 'forage' }); };
  $('allManual').onclick = () => { const G = S.game; if (G) send({ t: 'mode', ids: myDragons(G).map((d) => d.id), mode: 'manual' }); };
  $('childModeSel').onchange = (e) => { send({ t: 'childMode', mode: e.target.value }); e.target.blur(); };
  $('pauseBtn').onclick = () => { if (S.game) send({ t: 'pause', on: !S.game.paused }); };
  $('stepBtn').onclick = () => send({ t: 'step', turns: 1 });
  $('stepRoundBtn').onclick = () => send({ t: 'step', round: true });
  $('paceSel').onchange = (e) => { send({ t: 'pace', roundMs: +e.target.value }); e.target.blur(); };
  $('timerSel').onchange = (e) => { send({ t: 'pace', turnTimer: +e.target.value }); e.target.blur(); };

  // ================================================================ result overlay
  function showResult() {
    const G = S.game; if (!G || !G.result || S.replay) return;
    const r = G.result, names = G.seats.map((s, i) => (s && s.name) || 'Team ' + 'AB'[i]);
    const title = r.winner === null ? 'Draw' : `${esc(names[r.winner])} wins`;
    const why = { elimination: r.winner === null ? 'Both teams were wiped out in the same round.' : `${esc(names[1 - r.winner])} has no dragons left.`, longest: 'Longest living dragon after the final round.', total: 'Longest dragons tied — decided on total length.', tie: 'Longest dragon and total length both tied.' }[r.reason];
    const row = (label, f) => `<tr><td>${label}</td><td>${f(r.teams[0])}</td><td>${f(r.teams[1])}</td></tr>`;
    const host = isHost();
    $('overlayCard').innerHTML = `<div class="eyebrow">Round ${r.rounds + 1} of ${G.maxRounds}</div><h1 style="color:${r.winner === null ? 'var(--text)' : window.TEAM_COLORS[r.winner]}">${title}</h1><div class="result-sub">${why}</div>
      <table class="result-table"><tr><th></th><th class="a">${esc(names[0])}</th><th class="b">${esc(names[1])}</th></tr>
      ${row('Longest dragon', (t) => t.longest)}${row('Total length', (t) => t.total)}${row('Dragons alive', (t) => t.count)}${row('Pearls eaten', (t) => t.stats.pearls)}${row('Enemy dragons killed', (t) => t.stats.kills)}${row('Dragons lost', (t) => t.stats.deaths)}${row('Length lost in deaths', (t) => t.stats.lostLength)}${row('Splits', (t) => t.stats.splits)}${row('Segments spent sprinting', (t) => t.stats.sprintCost)}</table>
      <div class="overlay-actions">${S.room && S.room.lastReplay ? `<button class="btn" id="ovReplay">Watch the replay</button>` : '<span class="status">Saving replay…</span>'}${host ? `<button class="btn primary" id="ovAgain">Play again</button><button class="btn" id="ovSwap">Swap sides &amp; play</button><button class="btn ghost" id="ovLobby">Back to lobby</button>` : '<span class="status">The host can start the next game.</span>'}<button class="btn ghost" id="ovHide">Look at the board</button></div>`;
    $('overlay').hidden = false;
    const bind = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
    bind('ovReplay', () => openReplay(S.room.lastReplay));
    bind('ovAgain', () => send({ t: 'start' }));
    bind('ovSwap', () => { send({ t: 'swap' }); send({ t: 'start' }); });
    bind('ovLobby', () => send({ t: 'lobby' }));
    bind('ovHide', () => { $('overlay').hidden = true; });
  }

  // ================================================================ replay viewer
  async function openReplay(id) {
    let rep;
    try { rep = await (await fetch('/replay/' + id)).json(); } catch (e) { status('Could not load that replay.'); toast('Could not load that replay.'); return; }
    S.backTo = !$('game').hidden ? 'game' : !$('lobby').hidden ? 'lobby' : 'home';
    // Rebuild every round's pearls and countdowns once, so seeking is instant.
    const n = rep.map.w * rep.map.h;
    const pearls = new Uint8Array(n); for (const p of rep.initial.pearls) pearls[p] = 1;
    const cd = Int32Array.from(rep.initial.cd);
    const frames = rep.frames.map((f) => {
      for (let i = 0; i < n; i++) if (cd[i] > 0) cd[i]--;
      for (let k = 0; k < f.rs.length; k += 2) cd[f.rs[k]] = f.rs[k + 1];
      for (const p of f.sp) pearls[p] = 1;
      const events = [];
      for (const ev of f.ev) {
        if (ev[0] === 'p') { for (const p of ev[1]) pearls[p] = 1; for (const p of ev[2]) pearls[p] = 0; }
        else if (ev[0] === 'x') events.push({ team: ev[2], text: `#${ev[1]} (length ${ev[5]}) ${WHY[ev[3]] || 'died'}${ev[4] !== null ? ` — #${ev[4]}` : ''}` });
        else if (ev[0] === 's') events.push({ team: -1, text: `#${ev[1]} split → #${ev[2]}` });
      }
      return { r: f.r, pearls: pearls.slice(), cd: cd.slice(), dragons: new Map(f.d.map((a) => [a[0], { id: a[0], team: a[1], segs: a.slice(2) }])), events };
    });
    const G = newGame(rep.map, rep.initial, { seat: -1, seats: rep.seats, settings: rep.settings, maxRounds: rep.initial.maxRounds });
    S.replay = { id, rep, frames, G, at: -1, playing: false, acc: 0, last: 0 };
    view.setMap(rep.map); view.state = G; view.myTeam = null; view.selected = null;
    $('overlay').hidden = true; $('banner').hidden = true; $('countdown').hidden = true;
    $('livePanel').hidden = true; $('replayPanel').hidden = false; $('modeLabel').textContent = 'Replay · round';
    $('rpSeek').max = frames.length - 1;
    // Event list with jump links
    $('log').innerHTML = '';
    frames.forEach((f, k) => f.events.forEach((ev) => { const el = document.createElement('div'); el.className = 'jump'; el.dataset.frame = k; el.innerHTML = `<span class="r">${f.r + 1}</span><span class="${ev.team === 1 ? 'b' : ev.team === 0 ? 'a' : ''}">${esc(ev.text)}</span>`; $('log').prepend(el); }));
    show('game');
    seek(0);
  }
  function seek(k) {
    const R = S.replay; if (!R) return;
    k = Math.max(0, Math.min(R.frames.length - 1, k));
    const f = R.frames[k];
    R.at = k; R.G.round = f.r; R.G.dragons = f.dragons; R.G.pearls = f.pearls; R.G.cd = f.cd;
    view.state = R.G; view.occDirty = true;
    if (view.selected !== null && !f.dragons.has(view.selected)) view.selected = null;
    $('rpSeek').value = k; S.sideDirty = true;
  }
  function renderReplayMeta() {
    const R = S.replay, r = R.rep.result;
    const names = R.rep.seats.map((s, i) => s.name || 'Team ' + 'AB'[i]);
    $('rpMeta').innerHTML = `${esc(R.rep.map.name)} · ${esc(names[0])} vs ${esc(names[1])}<br>${r ? (r.winner === null ? 'Draw' : esc(names[r.winner]) + ' won') + ' (' + r.reason + ')' : ''}`;
    $('rpPlay').textContent = R.playing ? 'Pause' : 'Play';
    $('turnRow').innerHTML = 'End-of-round positions · <kbd>←</kbd><kbd>→</kbd> step · <kbd>Space</kbd> play';
  }
  function replayKey(e) {
    const R = S.replay;
    if (e.key === 'ArrowRight') { e.preventDefault(); R.playing = false; seek(R.at + (e.shiftKey ? 10 : 1)); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); R.playing = false; seek(R.at - (e.shiftKey ? 10 : 1)); }
    else if (e.key === ' ') { e.preventDefault(); $('rpPlay').click(); }
    else if (e.key === 'Escape') $('rpExit').click();
    else if ('tT'.includes(e.key)) toggle('timers'); else if ('vV'.includes(e.key)) toggle('vision'); else if ('rR'.includes(e.key)) toggle('range');
  }
  $('rpPlay').onclick = () => { const R = S.replay; if (!R) return; if (R.at >= R.frames.length - 1) seek(0); R.playing = !R.playing; R.last = performance.now(); R.acc = 0; S.sideDirty = true; };
  $('rpBack').onclick = () => { if (S.replay) { S.replay.playing = false; seek(S.replay.at - 1); } };
  $('rpFwd').onclick = () => { if (S.replay) { S.replay.playing = false; seek(S.replay.at + 1); } };
  $('rpSeek').oninput = (e) => { if (S.replay) { S.replay.playing = false; seek(+e.target.value); } };
  $('log').addEventListener('click', (e) => { const j = e.target.closest('.jump'); if (j && S.replay) { S.replay.playing = false; seek(+j.dataset.frame); } });
  $('rpExit').onclick = () => {
    S.replay = null;
    $('livePanel').hidden = false; $('replayPanel').hidden = true; $('modeLabel').textContent = 'Round';
    if (new URLSearchParams(location.search).get('replay')) history.replaceState(null, '', location.pathname);
    if (S.room && S.room.phase === 'lobby') S.game = null;          // the host moved on while we were watching
    if (S.game) { view.setMap(S.game.map); view.state = S.game; view.myTeam = S.game.seat >= 0 ? S.game.seat : null; view.occDirty = true; $('log').innerHTML = ''; show('game'); if (S.game.result) showResult(); S.sideDirty = true; }
    else if (S.room) { show('lobby'); renderLobby(); } else show('home');
  };

  // ================================================================ frame loop & layout
  function relayout() {
    const wrap = $('boardWrap');
    if ($('game').hidden) return;
    view.layout(wrap.clientWidth - 16, wrap.clientHeight - 4);
  }
  window.addEventListener('resize', relayout);
  function frame(now) {
    if (!$('game').hidden) {
      const R = S.replay;
      if (R && R.playing) {
        R.acc += (now - R.last) * (+$('rpSpeed').value) / 1000; R.last = now;
        if (R.acc >= 1) { const steps = Math.floor(R.acc); R.acc -= steps; if (R.at + steps >= R.frames.length - 1) { seek(R.frames.length - 1); R.playing = false; } else seek(R.at + steps); }
      }
      if (S.sideDirty) renderSide();
      const G = S.game;
      view.awaiting = !R && G && !G.paused ? G.awaiting : null;
      const t = $('bannerTimer');
      if (t && G && G.awaiting) t.textContent = G.awaiting.end < 0 ? '' : ' ' + Math.max(0, (G.awaiting.end - now) / 1000).toFixed(1) + ' s';
      view.draw(now);
    }
    requestAnimationFrame(frame);
  }

  window.__arena = { S, view };
  connect();
  requestAnimationFrame(frame);
})();
