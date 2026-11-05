const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const defaultInitialPlayers = [
  { id: 'player_1', name: 'Arun', nickname: 'Smash Specialist', photo: '' },
  { id: 'player_2', name: 'Mani', nickname: 'Net Play Pro', photo: '' },
  { id: 'player_3', name: 'Shabaree', nickname: 'Ace', photo: '' },
  { id: 'player_4', name: 'Lokesh', nickname: 'Power Play', photo: '' },
  { id: 'player_5', name: 'Nowful', nickname: 'Spin Master', photo: '' },
  { id: 'player_6', name: 'Abishek', nickname: 'Rocket', photo: '' },
  { id: 'player_7', name: 'Pawan', nickname: 'Drop Shot', photo: '' },
  { id: 'player_8', name: 'Karthi', nickname: 'Defense Wall', photo: '' }
];

function loadLocalDb() {
  try {
    const raw = localStorage.getItem('bpl_device_db');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.players) && parsed.players.length > 0) return parsed;
    }
  } catch {}
  const initial = { players: [...defaultInitialPlayers], tournaments: [], activeTournamentId: null };
  saveLocalDb(initial);
  return initial;
}

function saveLocalDb(data) {
  try {
    localStorage.setItem('bpl_device_db', JSON.stringify(data));
  } catch {}
}

let db = loadLocalDb(), session = null, currentView = 'dashboard', ws = null;

function getServerBase() {
  const custom = localStorage.getItem('bpl_server_url');
  if (custom) return custom.replace(/\/+$/, '');
  return '';
}

function fullUrl(path) {
  const base = getServerBase();
  if (!base) return path;
  return `${base}${path.startsWith('/') ? path : '/' + path}`;
}

function updateServerLabel() {
  const s = getServerBase();
  const label = $('#currentServerLabel');
  if (label) {
    if (!s) {
      label.textContent = 'Device (Offline Standalone)';
    } else {
      try { label.textContent = new URL(s).host; }
      catch { label.textContent = s.slice(0, 18); }
    }
  }
  const specLink = $('#spectatorLink');
  if (specLink) {
    specLink.href = s ? `${s}/?view=public` : '/?view=public';
  }
}

function serverConfigModal() {
  const curr = getServerBase();
  modal(`
    <div class="modal-head">
      <h3>⚙️ Tournament Server Settings</h3>
      <button class="modal-close" data-close>×</button>
    </div>
    <p class="muted" style="font-size:11px;margin-bottom:14px;line-height:1.5">
      Connect this mobile app to your tournament backend.<br>
      • Local Wi-Fi: <code>http://192.168.1.50:3000</code><br>
      • Cloud server: <code>https://your-server.onrender.com</code>
    </p>
    <form id="serverConfigForm">
      <div class="field full-span">
        <label>SERVER URL</label>
        <input name="serverUrl" id="serverUrlInput" value="${esc(curr)}" placeholder="http://192.168.1.50:3000" required>
      </div>
      <div id="testServerResult" style="font-size:11px;margin-top:8px;min-height:18px"></div>
      <div class="modal-actions" style="margin-top:16px;flex-wrap:wrap">
        <button type="button" class="btn ghost small" id="testServerBtn">Test connection</button>
        <button type="button" class="btn ghost small" id="resetServerBtn">Reset default</button>
        <button type="submit" class="btn primary small">Save & Connect</button>
      </div>
    </form>
  `);
  $('#testServerBtn').onclick = async () => {
    const val = $('#serverUrlInput').value.trim().replace(/\/+$/, '');
    const out = $('#testServerResult');
    if (!val) { out.textContent = 'Please enter a URL'; out.style.color = '#e15c68'; return; }
    out.textContent = 'Testing connection...';
    out.style.color = '#5278ff';
    try {
      const res = await fetch(`${val}/api/health`, { method: 'GET' });
      if (res.ok) {
        out.textContent = '✓ Successfully connected to tournament server!';
        out.style.color = '#17a879';
      } else {
        out.textContent = '⚠ Server reached but returned HTTP ' + res.status;
        out.style.color = '#e15c68';
      }
    } catch (err) {
      out.textContent = '✗ Connection failed: ' + err.message;
      out.style.color = '#e15c68';
    }
  };
  $('#resetServerBtn').onclick = () => {
    localStorage.removeItem('bpl_server_url');
    closeModal();
    notify('Reset to default server.');
    updateServerLabel();
    if (ws) { ws.close(); }
    connectWS();
    refresh();
  };
  $('#serverConfigForm').onsubmit = async e => {
    e.preventDefault();
    const val = $('#serverUrlInput').value.trim().replace(/\/+$/, '');
    if (!val) return;
    localStorage.setItem('bpl_server_url', val);
    closeModal();
    notify('Server URL saved: ' + val);
    updateServerLabel();
    if (ws) { ws.close(); }
    connectWS();
    refresh();
  };
}

function genId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function localShuffle(items) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function localMakeMatch(round, teamA, teamB, index) {
  return {
    id: genId('match'),
    code: `R${round}-M${index}`,
    round,
    teamA,
    teamB,
    games: [{ a: 0, b: 0, completed: false }],
    scoreHistory: [],
    currentGame: 0,
    status: 'upcoming',
    winner: null,
    playerOfMatch: null,
    notes: ''
  };
}

function localRoundRobinTeams(teams) {
  const list = [...teams];
  if (list.length % 2) list.push(null);
  const rounds = [];
  for (let r = 0; r < list.length - 1; r++) {
    const matches = [];
    for (let i = 0; i < list.length / 2; i++) {
      const a = list[i], b = list[list.length - 1 - i];
      if (a && b) matches.push([a, b]);
    }
    rounds.push(matches);
    const fixed = list[0], rest = list.slice(1);
    rest.unshift(rest.pop());
    list.splice(0, list.length, fixed, ...rest);
  }
  return rounds;
}

function localGenerateFixed(tournament, players) {
  const ordered = tournament.teamSelection === 'manual' ? players : localShuffle(players);
  const teams = [];
  for (let i = 0; i + 1 < ordered.length; i += 2) {
    teams.push({ id: genId('team'), name: `Team ${teams.length + 1}`, players: [ordered[i].id, ordered[i + 1].id] });
  }
  tournament.teams = teams;
  tournament.reserves = ordered.length % 2 ? [ordered[ordered.length - 1].id] : [];
  let rounds = [];
  if (tournament.format === 'knockout') {
    const shuffled = localShuffle(teams);
    const matches = [];
    for (let i = 0; i + 1 < shuffled.length; i += 2) matches.push([shuffled[i], shuffled[i + 1]]);
    if (shuffled.length % 2) tournament.byeTeam = shuffled[shuffled.length - 1].id;
    rounds = [matches];
  } else {
    rounds = localRoundRobinTeams(teams);
  }
  tournament.matches = rounds.flatMap((r, i) => r.map((pair, j) => localMakeMatch(i + 1, pair[0], pair[1], j + 1)));
  tournament.roundCount = rounds.length;
}

function localGenerateRotating(tournament, players) {
  const count = players.length;
  const rounds = Math.max(1, Math.min(8, tournament.rounds || Math.floor(count / 2)));
  const matches = [];
  const partnerCounts = {};
  const byeCounts = {};
  players.forEach(p => { byeCounts[p.id] = 0; });
  for (let r = 1; r <= rounds; r++) {
    let pool = localShuffle(players);
    pool.sort((a, b) => (byeCounts[a.id] || 0) - (byeCounts[b.id] || 0));
    let matchIndex = 1;
    while (pool.length >= 4) {
      const group = pool.splice(0, 4);
      const pairOptions = [
        [[group[0], group[1]], [group[2], group[3]]],
        [[group[0], group[2]], [group[1], group[3]]],
        [[group[0], group[3]], [group[1], group[2]]]
      ];
      let chosen = pairOptions[0], best = Infinity;
      for (const option of pairOptions) {
        const score = option.reduce((sum, pair) => sum + (partnerCounts[[pair[0].id, pair[1].id].sort().join(':')] || 0) * 100, 0);
        if (score < best) { best = score; chosen = option; }
      }
      chosen.forEach(pair => {
        const key = [pair[0].id, pair[1].id].sort().join(':');
        partnerCounts[key] = (partnerCounts[key] || 0) + 1;
      });
      const teamA = { id: genId('team'), name: `R${r} Pair ${matchIndex}A`, players: chosen[0].map(p => p.id) };
      const teamB = { id: genId('team'), name: `R${r} Pair ${matchIndex}B`, players: chosen[1].map(p => p.id) };
      matches.push(localMakeMatch(r, teamA, teamB, matchIndex++));
    }
    pool.forEach(p => { byeCounts[p.id] = (byeCounts[p.id] || 0) + 1; });
  }
  tournament.teams = [];
  tournament.matches = matches;
  tournament.roundCount = rounds;
  tournament.byes = byeCounts;
}

function handleLocalApi(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  let body = {};
  try { if (opts.body) body = JSON.parse(opts.body); } catch {}
  let localDb = loadLocalDb();

  // Login
  if (path === '/api/login' && method === 'POST') {
    const pin = String(body.pin || '').trim();
    if (pin === '2468') return { role: 'admin', name: 'Organizer', pin };
    if (pin === '1357') return { role: 'scorer', name: 'Authorized scorer', pin };
    throw new Error('Incorrect PIN. (Organizer: 2468, Scorer: 1357)');
  }

  // Health and state
  if (path === '/api/health') return { ok: true, mode: 'local' };
  if (path === '/api/state') return localDb;

  // Players
  if (path === '/api/players' && method === 'POST') {
    if (!body.name?.trim()) throw new Error('Player name is required');
    const p = { id: genId('player'), name: body.name.trim(), nickname: (body.nickname || '').trim(), photo: body.photo || '', createdAt: new Date().toISOString() };
    localDb.players.push(p);
    saveLocalDb(localDb);
    db = localDb;
    return p;
  }
  if (path.startsWith('/api/players/') && method === 'PATCH') {
    const pid = path.split('/')[3];
    const p = localDb.players.find(x => x.id === pid);
    if (!p) throw new Error('Player not found');
    Object.assign(p, { name: body.name?.trim() || p.name, nickname: body.nickname ?? p.nickname, photo: body.photo ?? p.photo });
    saveLocalDb(localDb);
    db = localDb;
    return p;
  }
  if (path.startsWith('/api/players/') && method === 'DELETE') {
    const pid = path.split('/')[3];
    localDb.players = localDb.players.filter(x => x.id !== pid);
    saveLocalDb(localDb);
    db = localDb;
    return { ok: true };
  }

  // Tournaments
  if (path === '/api/tournaments' && method === 'POST') {
    const selected = (body.playerIds || []).map(pid => localDb.players.find(p => p.id === pid)).filter(Boolean);
    if (selected.length < 4) throw new Error('At least 4 players are required for doubles.');
    const t = {
      id: genId('tournament'),
      name: body.name?.trim() || 'Badminton Tournament',
      date: body.date || new Date().toISOString().slice(0, 10),
      venue: body.venue || '',
      pairingMode: body.pairingMode || 'fixed',
      teamSelection: body.teamSelection || 'random',
      format: body.format || 'roundrobin',
      status: 'active',
      playerIds: selected.map(p => p.id),
      matches: [],
      teams: [],
      createdAt: new Date().toISOString(),
      rounds: Number(body.rounds) || Math.max(1, Math.floor(selected.length / 2))
    };
    if (t.pairingMode === 'rotating') localGenerateRotating(t, selected);
    else localGenerateFixed(t, selected);
    localDb.tournaments.unshift(t);
    localDb.activeTournamentId = t.id;
    saveLocalDb(localDb);
    db = localDb;
    return t;
  }

  if (path.match(/^\/api\/tournaments\/([^/]+)\/activate$/) && method === 'POST') {
    const tid = path.split('/')[3];
    localDb.activeTournamentId = tid;
    saveLocalDb(localDb);
    db = localDb;
    return { ok: true };
  }

  if (path.match(/^\/api\/tournaments\/([^/]+)\/complete$/) && method === 'POST') {
    const tid = path.split('/')[3];
    const t = localDb.tournaments.find(x => x.id === tid);
    if (t) {
      t.status = 'completed';
      t.completedAt = new Date().toISOString();
      saveLocalDb(localDb);
      db = localDb;
    }
    return t || { ok: true };
  }

  // Matches & live score
  if (path.match(/^\/api\/matches\/([^/]+)\/score$/) && method === 'POST') {
    const mid = path.split('/')[3];
    const t = localDb.tournaments.find(x => x.id === localDb.activeTournamentId);
    if (!t) throw new Error('No active tournament');
    const m = t.matches.find(x => x.id === mid);
    if (!m) throw new Error('Match not found');
    if (m.status === 'completed') throw new Error('Match is already completed. Reopen it to edit.');
    const game = m.games[m.currentGame];
    const side = body.side;
    const delta = Number(body.delta || 0);
    if (!['a', 'b'].includes(side) || ![-1, 1].includes(delta)) throw new Error('Invalid score update');
    game[side] = Math.max(0, game[side] + delta);
    m.scoreHistory = m.scoreHistory || [];
    m.scoreHistory.push({ gameIndex: m.currentGame, side, delta });
    m.status = 'live';
    const a = game.a, b = game.b, high = Math.max(a, b), diff = Math.abs(a - b);
    if ((high >= 21 && diff >= 2) || high === 30) {
      game.completed = true;
      game.winner = a > b ? 'a' : 'b';
      const winsA = m.games.filter(g => g.winner === 'a').length;
      const winsB = m.games.filter(g => g.winner === 'b').length;
      if (winsA >= 2 || winsB >= 2) {
        m.status = 'completed';
        m.winner = winsA > winsB ? m.teamA.id : m.teamB.id;
        m.completedAt = new Date().toISOString();
      } else {
        m.currentGame++;
        m.games.push({ a: 0, b: 0, completed: false });
      }
    }
    saveLocalDb(localDb);
    db = localDb;
    return m;
  }

  if (path.match(/^\/api\/matches\/([^/]+)\/undo$/) && method === 'POST') {
    const mid = path.split('/')[3];
    const t = localDb.tournaments.find(x => x.id === localDb.activeTournamentId);
    const m = t?.matches.find(x => x.id === mid);
    if (!m) throw new Error('Match not found');
    if (m.status === 'completed') throw new Error('Reopen the match before undoing.');
    m.scoreHistory = m.scoreHistory || [];
    const last = m.scoreHistory.pop();
    if (last) {
      const g = m.games[last.gameIndex];
      if (g) {
        g[last.side] = Math.max(0, g[last.side] - last.delta);
        g.completed = false;
        delete g.winner;
      }
      m.currentGame = last.gameIndex;
    }
    m.status = m.games.some(x => x.a || x.b) ? 'live' : 'upcoming';
    saveLocalDb(localDb);
    db = localDb;
    return m;
  }

  if (path.match(/^\/api\/matches\/([^/]+)$/) && method === 'PATCH') {
    const mid = path.split('/')[3];
    const t = localDb.tournaments.find(x => x.id === localDb.activeTournamentId);
    const m = t?.matches.find(x => x.id === mid);
    if (!m) throw new Error('Match not found');
    if (body.playerOfMatch !== undefined) m.playerOfMatch = body.playerOfMatch || null;
    if (body.status === 'reopen') {
      m.status = 'live';
      m.winner = null;
      m.games = m.games.slice(0, 3);
      m.games.forEach(g => { g.completed = false; delete g.winner; });
      m.currentGame = Math.min(m.games.length - 1, m.games.findIndex(g => !g.winner));
      if (m.currentGame < 0) m.currentGame = m.games.length - 1;
    }
    if (Array.isArray(body.games)) {
      m.games = body.games;
      m.currentGame = m.games.length - 1;
      m.status = 'live';
      m.winner = null;
    }
    saveLocalDb(localDb);
    db = localDb;
    return m;
  }

  return { ok: true };
}

const activeT = () => (db?.tournaments || []).find(t => t.id === db?.activeTournamentId) || null;
const player = id => (db?.players || []).find(p => p.id === id) || { name: 'Player', photo: '', nickname: '' };
const headers = () => session ? { 'Content-Type': 'application/json', 'x-user-role': session.role, 'x-user-pin': session.pin } : { 'Content-Type': 'application/json' };

async function api(url, opts = {}) {
  const custom = localStorage.getItem('bpl_server_url');
  if (custom) {
    try {
      const target = fullUrl(url);
      const res = await fetch(target, { ...opts, headers: { ...headers(), ...(opts.headers || {}) } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Request failed');
      return data;
    } catch (err) {
      console.warn('Remote server unreachable, falling back to Device Standalone engine:', err.message);
      return handleLocalApi(url, opts);
    }
  }
  return handleLocalApi(url, opts);
}

function notify(msg, error = false) {
  const n = $('#notice');
  if (!n) return;
  n.textContent = msg;
  n.classList.remove('hidden', 'error');
  if (error) n.classList.add('error');
  setTimeout(() => n.classList.add('hidden'), 3600);
}

function esc(s = '') {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function avatar(p, cls = 'player-avatar') {
  if (!p) return `<span class="${cls}">?</span>`;
  return `<span class="${cls}">${p.photo ? `<img src="${p.photo}" alt="">` : esc((p.name || '?').split(' ').map(x => x[0]).join('').slice(0, 2).toUpperCase())}</span>`;
}

function teamName(team) {
  if (!team || !Array.isArray(team.players)) return 'TBD';
  return team.players.map(id => player(id)?.name || 'Player').join(' + ');
}

function matchScore(m) {
  if (!m || !Array.isArray(m.games) || m.games.length === 0) return { a: 0, b: 0 };
  const g = m.games[m.currentGame] || m.games[m.games.length - 1] || { a: 0, b: 0 };
  return g;
}

function canAdmin() {
  return session?.role === 'admin';
}

function toggleMobileSidebar(open) {
  const sidebar = $('#sidebar');
  const overlay = $('#sidebarOverlay');
  if (!sidebar) return;
  const shouldOpen = open !== undefined ? open : !sidebar.classList.contains('open');
  sidebar.classList.toggle('open', shouldOpen);
  if (overlay) overlay.classList.toggle('hidden', !shouldOpen);
}

function setView(view) {
  currentView = view;
  toggleMobileSidebar(false);
  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $$('.bottom-nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`));
  const titles = {
    dashboard: ['OVERVIEW', 'Tournament overview'],
    players: ['PLAYERS', 'Player directory'],
    tournament: ['TOURNAMENT', 'Tournament setup'],
    matches: ['MATCH CENTRE', 'Matches & scoring'],
    leaderboard: ['STATISTICS', 'Leaderboard'],
    awards: ['RECOGNITION', 'Awards & MVP'],
    history: ['ARCHIVE', 'Tournament history']
  };
  if ($('#pageCrumb') && titles[view]) $('#pageCrumb').textContent = titles[view][0];
  if ($('#pageTitle') && titles[view]) $('#pageTitle').textContent = titles[view][1];
  render();
}

function render() {
  if ($('#publicScreen') && !$('#publicScreen').classList.contains('hidden')) return;
  try {
    const fn = {
      dashboard: renderDashboard,
      players: renderPlayers,
      tournament: renderTournament,
      matches: renderMatches,
      leaderboard: renderLeaderboard,
      awards: renderAwards,
      history: renderHistory
    }[currentView] || renderDashboard;
    fn();
  } catch (err) {
    console.error('Render error in view', currentView, err);
    const root = $(`#view-${currentView}`);
    if (root) {
      root.innerHTML = `
        <div class="panel empty" style="text-align:center;padding:32px 16px">
          <div style="font-size:32px;margin-bottom:8px">⚠️</div>
          <b>Unable to display this view</b>
          <p class="muted" style="margin:8px 0 16px;font-size:12px">${esc(err.message || 'Render error')}</p>
          <button class="btn primary small" onclick="refresh();">↻ Refresh View</button>
        </div>
      `;
    }
  }
}

function matchCard(m) {
  const g = matchScore(m), status = m.status === 'completed' ? 'Completed' : m.status === 'live' ? 'Live' : 'Upcoming';
  const aLead = g.a > g.b;
  const bLead = g.b > g.a;
  return `
    <article class="match-card">
      <div class="match-top">
        <div class="match-tag-group">
          <span class="match-code-badge">${esc(m.code)}</span>
          <span class="round-badge">ROUND ${m.round}</span>
        </div>
        <span class="pill ${m.status === 'live' ? 'green pulse' : m.status === 'completed' ? 'blue' : ''}">${status}</span>
      </div>

      <div class="match-teams-layout">
        <div class="team-block ${m.winner === m.teamA.id ? 'winner-block' : ''}">
          <span class="team-sub">TEAM A</span>
          <b class="team-title">${esc(teamName(m.teamA))}</b>
          <div class="team-big-score ${aLead ? 'score-highlight' : ''}">${g.a}</div>
          ${m.status !== 'completed' ? `
            <div class="score-tap-group">
              <button class="tap-btn plus-tap" data-score="${m.id}" data-side="a" data-delta="1" ${!session ? 'disabled' : ''}>
                +1 A
              </button>
              <button class="tap-btn minus-tap" data-score="${m.id}" data-side="a" data-delta="-1" ${!session ? 'disabled' : ''}>
                −
              </button>
            </div>
          ` : ''}
        </div>

        <div class="vs-center-column">
          <span class="vs-badge">VS</span>
          <span class="set-counter">Game ${(m.currentGame || 0) + 1}</span>
          <span class="race-to">to 21</span>
        </div>

        <div class="team-block ${m.winner === m.teamB.id ? 'winner-block' : ''}">
          <span class="team-sub">TEAM B</span>
          <b class="team-title">${esc(teamName(m.teamB))}</b>
          <div class="team-big-score ${bLead ? 'score-highlight' : ''}">${g.b}</div>
          ${m.status !== 'completed' ? `
            <div class="score-tap-group">
              <button class="tap-btn plus-tap" data-score="${m.id}" data-side="b" data-delta="1" ${!session ? 'disabled' : ''}>
                +1 B
              </button>
              <button class="tap-btn minus-tap" data-score="${m.id}" data-side="b" data-delta="-1" ${!session ? 'disabled' : ''}>
                −
              </button>
            </div>
          ` : ''}
        </div>
      </div>

      <div class="match-meta-bar">
        <div class="sets-history">
          ${m.games.map((set, i) => `
            <span class="set-chip ${set.completed ? 'finished' : i === m.currentGame ? 'ongoing' : ''}">
              G${i+1}: <b>${set.a}–${set.b}</b>
            </span>
          `).join('')}
        </div>
        ${m.status !== 'completed' ? `
          <button class="undo-action-btn" data-undo="${m.id}">↶ Undo last</button>
        ` : `
          <span class="match-winner-note">🏆 Winner: <b>${esc(teamName(m.winner === m.teamA.id ? m.teamA : m.teamB))}</b></span>
        `}
      </div>

      ${m.playerOfMatch || (canAdmin() && m.status === 'completed') ? `
        <div class="match-admin-footer">
          <span>${m.playerOfMatch ? `⭐ POTM: <b>${esc(player(m.playerOfMatch).name)}</b>` : 'POTM pending approval'}</span>
          ${canAdmin() && m.status === 'completed' ? `
            <div class="card-btn-row">
              <button class="btn ghost small" data-potm="${m.id}">✦ ${m.playerOfMatch ? 'Edit POTM' : 'Set POTM'}</button>
              <button class="btn ghost small" data-reopen="${m.id}">Reopen</button>
            </div>
          ` : ''}
        </div>
      ` : ''}
    </article>
  `;
}

function renderDashboard() {
  const t = activeT(), matches = t?.matches || [], played = matches.filter(m => m.status === 'completed').length, live = matches.filter(m => m.status === 'live').length;
  $('#view-dashboard').innerHTML = `
    <div class="hero-panel">
      <div>
        <div class="eyebrow">${t ? 'CURRENT TOURNAMENT' : 'READY FOR THE NEXT GAME'}</div>
        <h3>${t ? esc(t.name) : 'Your court. Your competition.'}</h3>
        <p>${t ? `${t.playerIds.length} players · ${t.pairingMode === 'fixed' ? 'Fixed teams' : 'Rotating partners'} · ${t.format === 'knockout' ? 'Knockout' : t.format === 'league' ? 'League' : 'Round robin'}` : 'Create a tournament, build teams and keep every match moving.'}</p>
      </div>
      <div class="hero-actions">
        ${t ? `<button class="btn primary" data-goto="matches">Open match centre →</button>` : `<button class="btn primary" data-goto="tournament">＋ Create tournament</button>`}
        <a class="btn ghost" href="${getServerBase() ? getServerBase() + '/?view=public' : '/?view=public'}" target="_blank">↗ Live screen</a>
      </div>
    </div>
    <div class="grid stats-grid" style="margin-top:17px">
      <div class="stat-card"><div class="stat-icon">♙</div><small>Registered players</small><strong>${db.players.length}</strong><div class="trend">Player directory</div></div>
      <div class="stat-card"><div class="stat-icon">♜</div><small>Teams / pairings</small><strong>${t ? (t.pairingMode === 'fixed' ? t.teams.length : 'Dynamic') : 0}</strong><div class="trend">${t?.pairingMode === 'rotating' ? 'Partners rotate each round' : 'Current tournament'}</div></div>
      <div class="stat-card"><div class="stat-icon">▤</div><small>Matches completed</small><strong>${played}<span style="color:#a5afbf;font-size:15px"> / ${matches.length}</span></strong><div class="trend">${live} live right now</div></div>
      <div class="stat-card"><div class="stat-icon">🏆</div><small>Tournaments</small><strong>${db.tournaments.length}</strong><div class="trend">Saved tournament history</div></div>
    </div>
    <div class="section-head">
      <div><h3>Match centre</h3><p>Quick access to your latest fixtures and live scores.</p></div>
      <button class="btn ghost small" data-goto="matches">View all matches →</button>
    </div>
    ${matches.length ? `<div class="match-list">${matches.slice(0, 4).map(matchCard).join('')}</div>` : `<div class="panel empty"><div class="empty-icon">🏸</div><b>No tournament matches yet</b><p>Add players and create a tournament to generate fixtures automatically.</p><button class="btn primary" data-goto="tournament">Set up tournament</button></div>`}
  `;
}

function renderPlayers() {
  const root = $('#view-players');
  root.innerHTML = `
    <div class="section-head" style="margin-top:0">
      <div><h3>Player directory <span class="pill blue">${db.players.length} players</span></h3><p>Build your player pool once, then select participants for any tournament.</p></div>
      ${canAdmin() ? '<button class="btn primary" id="addPlayerBtn">＋ Add player</button>' : ''}
    </div>
    ${db.players.length ? `<div class="grid player-grid">${db.players.map(p => `
      <article class="player-card">
        <div class="player-card-top">${avatar(p)}${canAdmin() ? `<div class="card-actions"><button class="icon-btn" data-edit-player="${p.id}" title="Edit">✎</button><button class="icon-btn" data-delete-player="${p.id}" title="Delete">×</button></div>` : ''}</div>
        <h4>${esc(p.name)}</h4><p>${esc(p.nickname || 'Tournament player')}</p>
        <div class="player-meta"><div><b>${statsFor(p.id).played}</b><small>MATCHES</small></div><div><b>${statsFor(p.id).wins}</b><small>WINS</small></div><div><b>${statsFor(p.id).winRate}%</b><small>WIN RATE</small></div></div>
      </article>`).join('')}</div>` : `
      <div class="panel empty"><div class="empty-icon">♙</div><b>Your player list starts here</b><p>Add names and profile photos. The same players can be reused across tournaments.</p>${canAdmin() ? '<button class="btn primary" id="addPlayerEmpty">＋ Add first player</button>' : ''}</div>`}
  `;
  $('#addPlayerBtn')?.addEventListener('click', () => playerModal());
  $('#addPlayerEmpty')?.addEventListener('click', () => playerModal());
}

function statsFor(pid) {
  const t = activeT();
  if (!t) return { played: 0, wins: 0, winRate: 0 };
  const s = calcStats(t).find(x => x.playerId === pid);
  return s || { played: 0, wins: 0, winRate: 0 };
}

function calcStats(t) {
  const stats = {};
  const playerIds = (t?.playerIds && Array.isArray(t.playerIds)) ? t.playerIds : (db?.players || []).map(p => p.id);
  playerIds.forEach(pid => {
    stats[pid] = { playerId: pid, played: 0, wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0, potm: 0 };
  });
  (t?.matches || []).filter(m => m && m.status === 'completed').forEach(m => {
    [m.teamA, m.teamB].forEach((team, idx) => {
      if (!team || !Array.isArray(team.players)) return;
      team.players.forEach(pid => {
        if (!stats[pid]) stats[pid] = { playerId: pid, played: 0, wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0, potm: 0 };
        const s = stats[pid];
        s.played++;
        if (m.winner === team.id) s.wins++; else s.losses++;
        (m.games || []).forEach(g => {
          s.pointsFor += idx === 0 ? (g.a || 0) : (g.b || 0);
          s.pointsAgainst += idx === 0 ? (g.b || 0) : (g.a || 0);
        });
      });
    });
    if (m.playerOfMatch && stats[m.playerOfMatch]) stats[m.playerOfMatch].potm++;
  });
  return Object.values(stats).map(s => ({
    ...s,
    winRate: s.played ? Math.round(s.wins / s.played * 100) : 0,
    pointDiff: s.pointsFor - s.pointsAgainst
  })).sort((a, b) => b.wins - a.wins || b.pointDiff - a.pointDiff || b.potm - a.potm);
}

function playerModal(existing = null) {
  const p = existing || {};
  modal(`
    <div class="modal-head"><h3>${existing ? 'Edit player' : 'Add player'}</h3><button class="modal-close" data-close>×</button></div>
    <form id="playerForm">
      <div class="form-grid">
        <div class="field full-span"><label>PLAYER NAME *</label><input name="name" required value="${esc(p.name || '')}" placeholder="e.g. Arun"></div>
        <div class="field"><label>NICKNAME (OPTIONAL)</label><input name="nickname" value="${esc(p.nickname || '')}" placeholder="Display nickname"></div>
        <div class="field"><label>PROFILE PHOTO</label><input name="photo" type="file" accept="image/*"></div>
      </div>
      <div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">${existing ? 'Save changes' : 'Add player'}</button></div>
    </form>
  `);
  $('#playerForm').onsubmit = async e => {
    e.preventDefault();
    try {
      const f = e.target, file = f.photo.files[0];
      let photo = p.photo || '';
      if (file) photo = await fileToData(file);
      const body = { name: f.name.value, nickname: f.nickname.value, photo };
      if (existing) await api('/api/players/' + p.id, { method: 'PATCH', body: JSON.stringify(body) });
      else await api('/api/players', { method: 'POST', body: JSON.stringify(body) });
      closeModal();
      notify(existing ? 'Player updated' : 'Player added');
    } catch (err) {
      notify(err.message, true);
    }
  };
}

function fileToData(file) {
  return new Promise((resolve, reject) => {
    if (file.size > 2 * 1024 * 1024) return reject(new Error('Please use a photo smaller than 2 MB.'));
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function renderTournament() {
  const root = $('#view-tournament');
  if (!root) return;
  const t = activeT();
  const players = Array.isArray(db.players) && db.players.length ? db.players : defaultInitialPlayers;
  const tMatches = t && Array.isArray(t.matches) ? t.matches : [];
  root.innerHTML = `
    <div class="section-head" style="margin-top:0">
      <div><h3>Create a tournament</h3><p>Choose the players and format. Teams and fixtures are generated for you.</p></div>
      ${t ? '<span class="pill green">Active tournament exists</span>' : ''}
    </div>
    <form id="tournamentForm" class="panel">
      <div class="form-grid">
        <div class="field"><label>TOURNAMENT NAME *</label><input name="name" required placeholder="e.g. BPL Smash Cup" value="BPL Tournament"></div>
        <div class="field"><label>DATE</label><input name="date" type="date" value="${new Date().toISOString().slice(0, 10)}"></div>
        <div class="field full-span"><label>VENUE</label><input name="venue" placeholder="Court / sports centre" value="Badminton Court"></div>
        <div class="field full-span"><label>SELECT PARTICIPATING PLAYERS <span class="muted">(minimum 4 for doubles)</span></label>
          ${players.length ? `<div class="check-list">${players.map(p => `<label class="check-player">${avatar(p, 'player-avatar')}<input type="checkbox" name="playerIds" value="${p.id}" checked> ${esc(p.name)}</label>`).join('')}</div>` : '<p class="muted">Add players in the Players section first.</p>'}
        </div>
        <div class="field full-span"><label>TEAM PAIRING MODE</label>
          <div class="option-row">
            <div class="option"><label><input type="radio" name="pairingMode" value="fixed" checked> Fixed teams</label><small>Partners stay together for the entire tournament.</small></div>
            <div class="option"><label><input type="radio" name="pairingMode" value="rotating"> Rotating partners</label><small>New partner combinations each round. Individual standings.</small></div>
          </div>
        </div>
        <div class="field full-span" id="teamSelectionField"><label>FIXED TEAM DRAW</label>
          <div class="option-row">
            <div class="option"><label><input type="radio" name="teamSelection" value="random" checked> Random draw</label></div>
            <div class="option"><label><input type="radio" name="teamSelection" value="manual"> Registration order</label></div>
          </div>
        </div>
        <div class="field full-span"><label>TOURNAMENT FORMAT</label>
          <div class="option-row">
            <div class="option"><label><input type="radio" name="format" value="roundrobin" checked> Round robin</label><small>Every team plays each other.</small></div>
            <div class="option"><label><input type="radio" name="format" value="knockout"> Knockout</label><small>Lose and you're out.</small></div>
            <div class="option"><label><input type="radio" name="format" value="league"> League</label><small>Standings decide the winner.</small></div>
          </div>
        </div>
        <div class="field hidden" id="roundsField"><label>ROTATING MODE – NUMBER OF ROUNDS</label><input name="rounds" type="number" min="1" max="8" value="${Math.max(1, Math.floor(players.length / 2))}"></div>
      </div>
      <div class="modal-actions"><button class="btn primary" id="generateTournamentBtn" type="submit" ${players.length < 4 ? 'disabled' : ''}>Generate teams & fixtures →</button></div>
    </form>
    ${t ? `<div class="section-head"><div><h3>Current tournament</h3><p>${esc(t.name)} · ${tMatches.length} fixtures generated</p></div><button class="btn ghost small" data-goto="matches">Go to scoring →</button></div>` : ''}
  `;
  const form = $('#tournamentForm');
  if (!form) return;
  form.querySelectorAll('[name=pairingMode]').forEach(x => x.addEventListener('change', () => {
    const rotating = form.pairingMode.value === 'rotating';
    $('#teamSelectionField').classList.toggle('hidden', rotating);
    $('#roundsField').classList.toggle('hidden', !rotating);
  }));
  form.onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(form), ids = fd.getAll('playerIds');
    if (ids.length < 4) return notify('Select at least 4 players for doubles.', true);
    
    const submitBtn = $('#generateTournamentBtn');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Generating fixtures...';
    }

    try {
      await api('/api/tournaments', {
        method: 'POST',
        body: JSON.stringify({
          name: fd.get('name') || 'Badminton Tournament',
          date: fd.get('date'),
          venue: fd.get('venue'),
          playerIds: ids,
          pairingMode: fd.get('pairingMode'),
          teamSelection: fd.get('teamSelection'),
          format: fd.get('format'),
          rounds: fd.get('rounds')
        })
      });
      await refresh();
      notify('Tournament and fixtures generated!');
      setView('matches');
    } catch (err) {
      notify(err.message || 'Failed to generate tournament', true);
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Generate teams & fixtures →';
      }
    }
  };
}

function renderMatches() {
  const t = activeT(), root = $('#view-matches');
  if (!root) return;
  if (!t) {
    root.innerHTML = '<div class="panel empty"><div class="empty-icon">▤</div><b>No active tournament</b><p>Create a tournament to generate match fixtures.</p><button class="btn primary" data-goto="tournament">＋ Create tournament</button></div>';
    return;
  }
  const matches = Array.isArray(t.matches) ? t.matches : [];
  const rounds = [...new Set(matches.map(m => m.round))];
  const playerIds = Array.isArray(t.playerIds) ? t.playerIds : [];
  root.innerHTML = `
    <div class="section-head" style="margin-top:0">
      <div><h3>${esc(t.name)}</h3><p>${playerIds.length} players · ${matches.length} matches · ${t.pairingMode === 'fixed' ? 'Fixed teams' : 'Rotating partners'}</p></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="btn ghost small" data-goto="tournament">＋ New Tournament</button>
        <a class="btn ghost small" href="${getServerBase() ? getServerBase() + '/?view=public' : '/?view=public'}" target="_blank">↗ Live screen</a>
      </div>
    </div>
    <div class="grid stats-grid" style="margin-bottom:20px">
      <div class="stat-card"><small>Total fixtures</small><strong>${matches.length}</strong></div>
      <div class="stat-card"><small>Completed</small><strong>${matches.filter(m => m.status === 'completed').length}</strong></div>
      <div class="stat-card"><small>Live now</small><strong>${matches.filter(m => m.status === 'live').length}</strong></div>
      <div class="stat-card"><small>Remaining</small><strong>${matches.filter(m => m.status !== 'completed').length}</strong></div>
    </div>
    ${rounds.map(r => `<div class="round-title">ROUND ${r}</div><div class="match-list">${matches.filter(m => m.round === r).map(matchCard).join('')}</div>`).join('') || '<div class="panel empty">No fixtures generated.</div>'}
    <div class="section-head"><div><h3>Scoring controls</h3><p>Tap +1 to award a point. Changes save automatically and sync to spectator screens.</p></div></div>
    <div class="panel"><span class="pill green">● Live sync enabled</span> <span class="muted" style="font-size:11px;margin-left:8px">Best of 3 · 21 points · win by 2 · cap at 30</span></div>
  `;
}

function renderLeaderboard() {
  const t = activeT(), root = $('#view-leaderboard');
  if (!t) {
    root.innerHTML = '<div class="panel empty"><b>No statistics yet</b><p>Start a tournament and record match scores to build the leaderboard.</p></div>';
    return;
  }
  const stats = calcStats(t);
  root.innerHTML = `
    <div class="section-head" style="margin-top:0">
      <div><h3>Player Leaderboard</h3><p>Individual performance across completed matches.</p></div>
      <span class="pill blue">${esc(t.name)}</span>
    </div>
    <div class="panel leaderboard-panel">
      <div class="leader-table-head">
        <span class="col-rank">#</span>
        <span class="col-player">PLAYER</span>
        <span class="col-val">P</span>
        <span class="col-val">W</span>
        <span class="col-val">WIN%</span>
        <span class="col-val">DIFF</span>
      </div>
      <div class="leader-table-body">
        ${stats.map((s, i) => {
          const rankClass = i === 0 ? 'gold-rank' : i === 1 ? 'silver-rank' : i === 2 ? 'bronze-rank' : '';
          const diffSign = s.pointDiff > 0 ? '+' : '';
          const diffClass = s.pointDiff > 0 ? 'diff-pos' : s.pointDiff < 0 ? 'diff-neg' : '';
          return `
            <div class="leader-table-row ${rankClass}">
              <div class="col-rank">
                <span class="rank-badge">${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : String(i + 1).padStart(2, '0')}</span>
              </div>
              <div class="col-player">
                ${avatar(player(s.playerId))}
                <div class="player-info-cell">
                  <span class="name-main">${esc(player(s.playerId).name)}</span>
                  <small class="name-nick">${esc(player(s.playerId).nickname || 'Player')}</small>
                </div>
              </div>
              <div class="col-val">${s.played}</div>
              <div class="col-val bold-val">${s.wins}</div>
              <div class="col-val"><span class="rate-badge">${s.winRate}%</span></div>
              <div class="col-val ${diffClass}">${diffSign}${s.pointDiff}</div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

function renderAwards() {
  const t = activeT(), root = $('#view-awards');
  if (!t) {
    root.innerHTML = '<div class="panel empty"><b>Awards appear here</b><p>Complete matches to calculate player awards.</p></div>';
    return;
  }
  const stats = calcStats(t), potms = t.matches.filter(m => m.playerOfMatch), topPotm = [...stats].sort((a, b) => b.potm - a.potm)[0], mvp = [...stats].sort((a, b) => (b.wins * 3 + b.potm * 2 + b.winRate / 10 + b.pointDiff / 100) - (a.wins * 3 + a.potm * 2 + a.winRate / 10 + a.pointDiff / 100))[0];
  root.innerHTML = `
    <div class="section-head" style="margin-top:0">
      <div><h3>Tournament awards</h3><p>Player of the Match is suggested from match performance and confirmed by the organizer.</p></div>
    </div>
    <div class="grid award-grid">
      <div class="panel award-card"><div class="award-icon">🏆</div><h4>Tournament MVP</h4><p>Performance-based leaderboard</p><strong>${mvp && mvp.played ? esc(player(mvp.playerId).name) : 'Pending'}</strong></div>
      <div class="panel award-card"><div class="award-icon">⭐</div><h4>Most POTM Awards</h4><p>Organizer-approved match awards</p><strong>${topPotm && topPotm.potm ? esc(player(topPotm.playerId).name) : 'Pending'}</strong></div>
      <div class="panel award-card"><div class="award-icon">🎯</div><h4>Best Win Rate</h4><p>Minimum one completed match</p><strong>${stats.some(s => s.played) ? stats.find(s => s.played).winRate + '% · ' + esc(player(stats.find(s => s.played).playerId).name) : 'Pending'}</strong></div>
    </div>
    <div class="section-head">
      <div><h3>Player of the Match approvals</h3><p>Suggested player is based on the winning side's individual stats; organizer can change the selection.</p></div>
    </div>
    <div class="panel">
      ${t.matches.filter(m => m.status === 'completed').length ? t.matches.filter(m => m.status === 'completed').map(m => `
        <div class="leader-row" style="grid-template-columns:90px 1fr 1fr auto">
          <span class="rank">${m.code}</span>
          <span>${esc(teamName(m.teamA))} <span class="muted">vs</span> ${esc(teamName(m.teamB))}</span>
          <span class="muted">${m.playerOfMatch ? esc(player(m.playerOfMatch).name) : 'Not approved'}</span>
          ${canAdmin() ? `<button class="btn ghost small" data-potm="${m.id}">Review suggestion</button>` : ''}
        </div>
      `).join('') : '<div class="empty"><b>No completed matches</b><p>Player award suggestions will appear when matches are completed.</p></div>'}
    </div>
  `;
}

function renderHistory() {
  const root = $('#view-history');
  root.innerHTML = `
    <div class="section-head" style="margin-top:0">
      <div><h3>Tournament archive</h3><p>Past tournaments and their final results.</p></div>
    </div>
    ${db.tournaments.length ? `
      <div class="panel table-wrap">
        <table>
          <thead><tr><th>Tournament</th><th>Date</th><th>Players</th><th>Matches</th><th>Status</th><th></th></tr></thead>
          <tbody>
            ${db.tournaments.map(t => `
              <tr>
                <td><b>${esc(t.name)}</b></td>
                <td>${esc(t.date)}</td>
                <td>${t.playerIds.length}</td>
                <td>${t.matches.filter(m => m.status === 'completed').length}/${t.matches.length}</td>
                <td><span class="pill ${t.status === 'completed' ? 'blue' : 'green'}">${t.status}</span></td>
                <td><button class="btn ghost small" data-activate="${t.id}">${t.id === db.activeTournamentId ? 'Active' : 'Open'}</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>` : '<div class="panel empty"><div class="empty-icon">◷</div><b>No tournament history</b><p>Your completed tournaments will be saved here.</p></div>'}
  `;
}

function modal(html) {
  $('#modalRoot').innerHTML = `<div class="modal-backdrop"><div class="modal">${html}</div></div>`;
  $$('[data-close]').forEach(b => b.onclick = closeModal);
  $('#modalRoot .modal-backdrop').onclick = e => {
    if (e.target.classList.contains('modal-backdrop')) closeModal();
  };
}

function closeModal() {
  $('#modalRoot').innerHTML = '';
}

function suggestedPotm(m) {
  const winning = m.winner === m.teamA.id ? m.teamA : m.teamB;
  const stats = calcStats(activeT());
  return winning.players.map(pid => stats.find(s => s.playerId === pid)).filter(Boolean).sort((a, b) => b.wins - a.wins || b.pointDiff - a.pointDiff || b.potm - a.potm)[0]?.playerId || winning.players[0];
}

function potmModal(matchId) {
  const m = activeT().matches.find(x => x.id === matchId);
  if (!m) return;
  const suggested = suggestedPotm(m);
  const winning = m.winner === m.teamA.id ? m.teamA : m.teamB;
  modal(`
    <div class="modal-head"><h3>Player of the Match</h3><button class="modal-close" data-close>×</button></div>
    <p class="muted" style="font-size:11px">Suggested automatically from the winning team's player statistics. Organizer has final approval.</p>
    <form id="potmForm">
      <div class="field"><label>SELECT PLAYER</label>
        <select name="player">
          ${winning.players.map(pid => `<option value="${pid}" ${pid === (m.playerOfMatch || suggested) ? 'selected' : ''}>${esc(player(pid).name)}${pid === suggested ? ' · Suggested' : ''}</option>`).join('')}
        </select>
      </div>
      <div class="modal-actions"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">Approve award</button></div>
    </form>
  `);
  $('#potmForm').onsubmit = async e => {
    e.preventDefault();
    try {
      await api('/api/matches/' + matchId, { method: 'PATCH', body: JSON.stringify({ playerOfMatch: e.target.player.value }) });
      closeModal();
      notify('Player of the Match approved.');
    } catch (err) {
      notify(err.message, true);
    }
  };
}

async function scoreClick(matchId, side, delta) {
  try {
    await api('/api/matches/' + matchId + '/score', { method: 'POST', body: JSON.stringify({ side, delta }) });
  } catch (e) {
    notify(e.message, true);
  }
}

async function undo(matchId) {
  try {
    await api('/api/matches/' + matchId + '/undo', { method: 'POST', body: '{}' });
    notify('Last score update undone.');
  } catch (e) {
    notify(e.message, true);
  }
}

async function reopen(matchId) {
  if (!confirm('Reopen this completed match?')) return;
  try {
    await api('/api/matches/' + matchId, { method: 'PATCH', body: JSON.stringify({ status: 'reopen' }) });
    notify('Match reopened.');
  } catch (e) {
    notify(e.message, true);
  }
}

function publicView() {
  const t = activeT(), root = $('#publicContent');
  if (!t) {
    root.innerHTML = '<div class="public-title"><div><div class="eyebrow">BPL · LIVE BOARD</div><h1>Waiting for the next match</h1><p>The tournament scoreboard will appear here when an organizer creates a tournament.</p></div></div>';
    return;
  }
  const matches = t.matches || [], stats = calcStats(t);
  root.innerHTML = `
    <div class="public-title">
      <div>
        <div class="eyebrow">${esc(t.date)} ${t.venue ? ' · ' + esc(t.venue) : ''}</div>
        <h1>${esc(t.name)}</h1>
        <p>${t.playerIds.length} players · ${t.pairingMode === 'fixed' ? 'Fixed teams' : 'Rotating partners'} · ${matches.filter(m => m.status === 'completed').length}/${matches.length} matches completed</p>
      </div>
      <span class="pill green">● LIVE UPDATES</span>
    </div>
    <div class="public-match-grid">
      ${matches.map(m => {
        const g = matchScore(m);
        return `
          <article class="public-match">
            <div class="match-top"><small>${m.code} · ROUND ${m.round}</small><span class="pill ${m.status === 'live' ? 'green' : ''}">${m.status.toUpperCase()}</span></div>
            <div class="match-teams">
              <div class="team-side"><b>${esc(teamName(m.teamA))}</b><small>TEAM A</small></div>
              <span class="versus">VS</span>
              <div class="team-side"><b>${esc(teamName(m.teamB))}</b><small>TEAM B</small></div>
            </div>
            <div class="score-row"><span class="score-number">${g.a}</span><span class="score-sep">:</span><span class="score-number">${g.b}</span></div>
            <div class="match-foot"><span>GAME ${(m.currentGame || 0) + 1}</span><span>${m.status === 'completed' ? 'Winner: ' + esc(teamName(m.winner === m.teamA.id ? m.teamA : m.teamB)) : 'Best of 3'}</span></div>
          </article>
        `;
      }).join('')}
    </div>
    <div class="public-standings">
      <h3>Player leaderboard</h3>
      <div class="table-wrap">
        <table>
          <thead><tr><th>#</th><th>Player</th><th>Played</th><th>Wins</th><th>Win %</th><th>POTM</th></tr></thead>
          <tbody>
            ${stats.map((s, i) => `<tr><td>${i + 1}</td><td>${esc(player(s.playerId).name)}</td><td>${s.played}</td><td>${s.wins}</td><td>${s.winRate}%</td><td>${s.potm}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

async function refresh() {
  try {
    const data = await api('/api/state');
    if (data && typeof data === 'object') {
      db = {
        players: (Array.isArray(data.players) && data.players.length) ? data.players : (db.players || defaultInitialPlayers),
        tournaments: Array.isArray(data.tournaments) ? data.tournaments : [],
        activeTournamentId: data.activeTournamentId || null
      };
    }
    render();
    if ($('#publicScreen') && !$('#publicScreen').classList.contains('hidden')) publicView();
  } catch (e) {
    console.error('Refresh error:', e);
  }
}

function connectWS() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  const base = getServerBase();
  if (!base) return;
  let wsUrl;
  try {
    const u = new URL(base);
    const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl = `${proto}//${u.host}`;
  } catch {
    return;
  }
  try {
    ws = new WebSocket(wsUrl);
    ws.onmessage = e => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'state') {
          db = msg.data;
          render();
          if ($('#publicScreen') && !$('#publicScreen').classList.contains('hidden')) publicView();
        }
      } catch (err) {
        console.error(err);
      }
    };
    ws.onclose = () => setTimeout(connectWS, 4000);
    ws.onerror = () => ws.close();
  } catch (e) {
    setTimeout(connectWS, 5000);
  }
}

$('#loginForm').onsubmit = async e => {
  e.preventDefault();
  try {
    const pin = $('#pinInput').value;
    session = await api('/api/login', { method: 'POST', body: JSON.stringify({ pin }) });
    localStorage.setItem('rallySession', JSON.stringify(session));
    showApp();
  } catch (err) {
    notify(err.message, true);
  }
};

function showApp() {
  if (!session) return;
  $('#loginScreen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#roleName').textContent = session.role === 'admin' ? 'Organizer' : 'Authorized scorer';
  $('#userAvatar').textContent = session.role === 'admin' ? 'O' : 'S';
  $$('.nav-item').forEach(b => b.onclick = () => setView(b.dataset.view));
  $$('.bottom-nav-item[data-view]').forEach(b => b.onclick = () => setView(b.dataset.view));
  if (!canAdmin()) {
    $$('.nav-item').filter(b => ['players', 'tournament', 'history', 'awards'].includes(b.dataset.view)).forEach(b => b.classList.add('hidden'));
    $$('.bottom-nav-item').filter(b => ['players'].includes(b.dataset.view)).forEach(b => b.classList.add('hidden'));
  }
  updateServerLabel();
  connectWS();
  refresh().then(() => setView('dashboard'));
}

$('#logoutBtn').onclick = () => {
  session = null;
  localStorage.removeItem('rallySession');
  location.reload();
};

$('#serverSettingsBtn')?.addEventListener('click', serverConfigModal);
$('#sidebarServerBtn')?.addEventListener('click', serverConfigModal);
$('#mobileMenuBtn')?.addEventListener('click', () => toggleMobileSidebar(true));
$('#sidebarCloseBtn')?.addEventListener('click', () => toggleMobileSidebar(false));
$('#sidebarOverlay')?.addEventListener('click', () => toggleMobileSidebar(false));
$('#bottomNavMoreBtn')?.addEventListener('click', () => toggleMobileSidebar(true));

document.addEventListener('click', async e => {
  const goto = e.target.closest('[data-goto]');
  if (goto) { setView(goto.dataset.goto); return; }
  const score = e.target.closest('[data-score]');
  if (score) { scoreClick(score.dataset.score, score.dataset.side, Number(score.dataset.delta)); return; }
  const undoBtn = e.target.closest('[data-undo]');
  if (undoBtn) { undo(undoBtn.dataset.undo); return; }
  const potm = e.target.closest('[data-potm]');
  if (potm) { potmModal(potm.dataset.potm); return; }
  const reopenBtn = e.target.closest('[data-reopen]');
  if (reopenBtn) { reopen(reopenBtn.dataset.reopen); return; }
  const edit = e.target.closest('[data-edit-player]');
  if (edit) { playerModal(player(edit.dataset.editPlayer)); return; }
  const del = e.target.closest('[data-delete-player]');
  if (del) {
    if (confirm('Delete this player from the directory?')) {
      try {
        await api('/api/players/' + del.dataset.deletePlayer, { method: 'DELETE' });
        notify('Player deleted.');
      } catch (err) {
        notify(err.message, true);
      }
    }
    return;
  }
  const activate = e.target.closest('[data-activate]');
  if (activate) {
    try {
      await api('/api/tournaments/' + activate.dataset.activate + '/activate', { method: 'POST', body: '{}' });
      notify('Tournament activated.');
    } catch (err) {
      notify(err.message, true);
    }
  }
});

(async () => {
  updateServerLabel();
  if (new URLSearchParams(location.search).get('view') === 'public') {
    $('#loginScreen').classList.add('hidden');
    $('#app').classList.add('hidden');
    $('#publicScreen').classList.remove('hidden');
    await refresh();
    connectWS();
    return;
  }
  try {
    const saved = JSON.parse(localStorage.getItem('rallySession') || 'null');
    if (saved) {
      session = saved;
      try {
        const check = await api('/api/state');
        if (check && typeof check === 'object') {
          db = {
            players: (Array.isArray(check.players) && check.players.length) ? check.players : defaultInitialPlayers,
            tournaments: Array.isArray(check.tournaments) ? check.tournaments : [],
            activeTournamentId: check.activeTournamentId || null
          };
        }
      } catch (err) {
        console.warn('Initial state fetch offline:', err);
      }
      showApp();
    }
  } catch {
    localStorage.removeItem('rallySession');
  }
})();
