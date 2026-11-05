const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || '2468';
const SCORER_PIN = process.env.SCORER_PIN || '1357';
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'tournament.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

const emptyState = () => ({ players: [], tournaments: [], activeTournamentId: null });
let state;
try { state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
catch { state = emptyState(); }
function persist() { fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2)); }
function publicState() { return state; }
function broadcast() {
  const payload = JSON.stringify({ type: 'state', data: publicState() });
  for (const client of wss.clients) if (client.readyState === 1) client.send(payload);
}
function changed() { persist(); broadcast(); }
function id(prefix='id') { return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,7)}`; }
function auth(req, res, next) {
  const role = req.headers['x-user-role'];
  const pin = req.headers['x-user-pin'];
  if ((role === 'admin' && pin === ADMIN_PIN) || (role === 'scorer' && pin === SCORER_PIN)) {
    req.role = role; return next();
  }
  return res.status(401).json({ error: 'Authorization required. Sign in with an organizer or scorer PIN.' });
}
function activeTournament() { return state.tournaments.find(t => t.id === state.activeTournamentId); }
function shuffle(items) { const a = [...items]; for (let i=a.length-1;i>0;i--) { const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }
function makeMatch(round, teamA, teamB, index) {
  return { id:id('match'), code:`R${round}-M${index}`, round, teamA, teamB, games:[{a:0,b:0,completed:false}], scoreHistory:[], currentGame:0, status:'upcoming', winner:null, playerOfMatch:null, notes:'' };
}
function roundRobinTeams(teams) {
  const list = [...teams]; if (list.length % 2) list.push(null);
  const rounds=[];
  for(let r=0;r<list.length-1;r++) {
    const matches=[];
    for(let i=0;i<list.length/2;i++) {
      const a=list[i], b=list[list.length-1-i];
      if(a && b) matches.push([a,b]);
    }
    rounds.push(matches);
    const fixed=list[0], rest=list.slice(1); rest.unshift(rest.pop()); list.splice(0,list.length,fixed,...rest);
  }
  return rounds;
}
function generateFixed(tournament, players) {
  const ordered = tournament.teamSelection === 'manual' ? players : shuffle(players);
  const teams=[];
  for(let i=0;i+1<ordered.length;i+=2) teams.push({id:id('team'),name:`Team ${teams.length+1}`,players:[ordered[i].id,ordered[i+1].id]});
  tournament.teams=teams;
  tournament.reserves = ordered.length%2 ? [ordered[ordered.length-1].id] : [];
  let rounds=[];
  if(tournament.format==='knockout') {
    const shuffled=shuffle(teams); const matches=[];
    for(let i=0;i+1<shuffled.length;i+=2) matches.push([shuffled[i],shuffled[i+1]]);
    if(shuffled.length%2) tournament.byeTeam=shuffled[shuffled.length-1].id;
    rounds=[matches];
  } else rounds=roundRobinTeams(teams);
  tournament.matches=rounds.flatMap((r,i)=>r.map((pair,j)=>makeMatch(i+1,pair[0],pair[1],j+1)));
  tournament.roundCount=rounds.length;
}
function generateRotating(tournament, players) {
  const count=players.length;
  const rounds = Math.max(1, Math.min(8, tournament.rounds || Math.floor(count/2)));
  const matches=[]; const partnerCounts={}; const byeCounts={};
  players.forEach(p=>{byeCounts[p.id]=0;});
  for(let r=1;r<=rounds;r++) {
    let pool=shuffle(players);
    // Prioritize players with fewer byes and avoid pairing partners used in earlier rounds.
    pool.sort((a,b)=>(byeCounts[a.id]||0)-(byeCounts[b.id]||0));
    let used=new Set(); let matchIndex=1;
    while(pool.length>=4) {
      const group=pool.splice(0,4);
      const pairOptions=[[[group[0],group[1]],[group[2],group[3]]],[[group[0],group[2]],[group[1],group[3]]],[[group[0],group[3]],[group[1],group[2]]]];
      let chosen=pairOptions[0], best=Infinity;
      for(const option of pairOptions) {
        const score=option.reduce((sum,pair)=>sum+(partnerCounts[[pair[0].id,pair[1].id].sort().join(':')]||0)*100,0);
        if(score<best){best=score;chosen=option;}
      }
      chosen.forEach(pair=>{const key=[pair[0].id,pair[1].id].sort().join(':');partnerCounts[key]=(partnerCounts[key]||0)+1;});
      const teamA={id:id('team'),name:`R${r} Pair ${matchIndex}A`,players:chosen[0].map(p=>p.id)};
      const teamB={id:id('team'),name:`R${r} Pair ${matchIndex}B`,players:chosen[1].map(p=>p.id)};
      matches.push(makeMatch(r,teamA,teamB,matchIndex++));
    }
    pool.forEach(p=>{byeCounts[p.id]=(byeCounts[p.id]||0)+1;});
  }
  tournament.teams=[]; tournament.matches=matches; tournament.roundCount=rounds; tournament.byes=byeCounts;
}
function playerStats(t) {
  const stats={};
  for(const p of state.players) stats[p.id]={playerId:p.id,played:0,wins:0,losses:0,pointsFor:0,pointsAgainst:0,potm:0};
  for(const m of t.matches||[]) {
    if(m.status!=='completed') continue;
    const sides=[m.teamA,m.teamB];
    for(let s=0;s<2;s++) for(const pid of sides[s].players) {
      const st=stats[pid]; if(!st) continue;
      st.played++; if(m.winner===sides[s].id) st.wins++; else st.losses++;
      for(const g of m.games){st.pointsFor += s===0?g.a:g.b; st.pointsAgainst += s===0?g.b:g.a;}
    }
    if(m.playerOfMatch && stats[m.playerOfMatch]) stats[m.playerOfMatch].potm++;
  }
  return Object.values(stats).map(s=>({...s,winRate:s.played?Math.round(s.wins/s.played*100):0,pointDiff:s.pointsFor-s.pointsAgainst})).sort((a,b)=>b.wins-a.wins||b.pointDiff-a.pointDiff||b.potm-a.potm);
}
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, x-user-role, x-user-pin');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json({limit:'8mb'}));
app.use(express.static(path.join(__dirname,'public')));
app.get('/api/state',(req,res)=>res.json(publicState()));
app.post('/api/login',(req,res)=>{
  const {pin}=req.body||{};
  if(pin===ADMIN_PIN) return res.json({role:'admin',pin});
  if(pin===SCORER_PIN) return res.json({role:'scorer',pin});
  res.status(401).json({error:'Incorrect PIN'});
});
app.post('/api/players',auth,(req,res)=>{
  const {name,photo='',nickname=''}=req.body||{};
  if(!name?.trim()) return res.status(400).json({error:'Player name is required'});
  const player={id:id('player'),name:name.trim(),nickname:nickname.trim(),photo,createdAt:new Date().toISOString()};
  state.players.push(player); changed(); res.json(player);
});
app.patch('/api/players/:id',auth,(req,res)=>{
  const p=state.players.find(x=>x.id===req.params.id); if(!p) return res.status(404).json({error:'Player not found'});
  Object.assign(p,{name:req.body.name?.trim()||p.name,nickname:req.body.nickname??p.nickname,photo:req.body.photo??p.photo}); changed(); res.json(p);
});
app.delete('/api/players/:id',auth,(req,res)=>{
  if(state.tournaments.some(t=>t.status==='active' && t.matches?.some(m=>[...m.teamA.players,...m.teamB.players].includes(req.params.id)))) return res.status(409).json({error:'This player is part of the active tournament.'});
  state.players=state.players.filter(p=>p.id!==req.params.id); changed(); res.json({ok:true});
});
app.post('/api/tournaments',auth,(req,res)=>{
  const body=req.body||{};
  const selected=(body.playerIds||[]).map(pid=>state.players.find(p=>p.id===pid)).filter(Boolean);
  if(selected.length<4) return res.status(400).json({error:'At least 4 players are required for doubles.'});
  const t={id:id('tournament'),name:body.name?.trim()||'Badminton Tournament',date:body.date||new Date().toISOString().slice(0,10),venue:body.venue||'',pairingMode:body.pairingMode||'fixed',teamSelection:body.teamSelection||'random',format:body.format||'roundrobin',status:'active',playerIds:selected.map(p=>p.id),matches:[],teams:[],createdAt:new Date().toISOString(),rounds:Number(body.rounds)||Math.max(1,Math.floor(selected.length/2))};
  if(t.pairingMode==='rotating') generateRotating(t,selected); else generateFixed(t,selected);
  state.tournaments.unshift(t); state.activeTournamentId=t.id; changed(); res.json(t);
});
app.post('/api/tournaments/:id/activate',auth,(req,res)=>{
  if(!state.tournaments.some(t=>t.id===req.params.id)) return res.status(404).json({error:'Tournament not found'});
  state.activeTournamentId=req.params.id; changed(); res.json({ok:true});
});
app.post('/api/matches/:id/score',auth,(req,res)=>{
  const t=activeTournament(); if(!t) return res.status(404).json({error:'No active tournament'});
  const m=t.matches.find(x=>x.id===req.params.id); if(!m) return res.status(404).json({error:'Match not found'});
  if(m.status==='completed') return res.status(409).json({error:'Match is already completed. Reopen it to edit.'});
  const game=m.games[m.currentGame]; const side=req.body.side; const delta=Number(req.body.delta||0);
  if(!['a','b'].includes(side)||![-1,1].includes(delta)) return res.status(400).json({error:'Invalid score update'});
  game[side]=Math.max(0,game[side]+delta); m.scoreHistory=m.scoreHistory||[]; m.scoreHistory.push({gameIndex:m.currentGame,side,delta}); m.status='live';
  const a=game.a,b=game.b; const high=Math.max(a,b),diff=Math.abs(a-b);
  if((high>=21&&diff>=2)||high===30) {
    game.completed=true; game.winner=a>b?'a':'b';
    const winsA=m.games.filter(g=>g.winner==='a').length, winsB=m.games.filter(g=>g.winner==='b').length;
    if(winsA>=2||winsB>=2){m.status='completed';m.winner=winsA>winsB?m.teamA.id:m.teamB.id;m.completedAt=new Date().toISOString();}
    else {m.currentGame++;m.games.push({a:0,b:0,completed:false});}
  }
  changed(); res.json(m);
});
app.post('/api/matches/:id/undo',auth,(req,res)=>{
  const t=activeTournament(); const m=t?.matches.find(x=>x.id===req.params.id); if(!m) return res.status(404).json({error:'Match not found'});
  if(m.status==='completed') return res.status(409).json({error:'Reopen the match before undoing.'});
  m.scoreHistory=m.scoreHistory||[];
  const last=m.scoreHistory.pop();
  if(last){
    const g=m.games[last.gameIndex];
    if(g){g[last.side]=Math.max(0,g[last.side]-last.delta);g.completed=false;delete g.winner;}
    m.currentGame=last.gameIndex;
  }
  m.status=m.games.some(x=>x.a||x.b)?'live':'upcoming'; changed(); res.json(m);
});
app.patch('/api/matches/:id',(req,res)=>{
  const t=activeTournament(); const m=t?.matches.find(x=>x.id===req.params.id); if(!m) return res.status(404).json({error:'Match not found'});
  // Scorers may only submit scores through the score endpoint. POTM and admin corrections require organizer role.
  if(req.headers['x-user-role']!=='admin'||req.headers['x-user-pin']!==ADMIN_PIN) return res.status(401).json({error:'Organizer access required'});
  if(req.body.playerOfMatch!==undefined)m.playerOfMatch=req.body.playerOfMatch||null;
  if(req.body.status==='reopen'){m.status='live';m.winner=null;m.games=m.games.slice(0,3);m.games.forEach(g=>{g.completed=false;delete g.winner;});m.currentGame=Math.min(m.games.length-1,m.games.findIndex(g=>!g.winner));if(m.currentGame<0)m.currentGame=m.games.length-1;}
  if(Array.isArray(req.body.games)){m.games=req.body.games;m.currentGame=m.games.length-1;m.status='live';m.winner=null;}
  changed(); res.json(m);
});
app.get('/api/tournaments/:id/stats',(req,res)=>{const t=state.tournaments.find(x=>x.id===req.params.id);if(!t)return res.status(404).json({error:'Tournament not found'});res.json(playerStats(t));});
app.post('/api/tournaments/:id/complete',auth,(req,res)=>{const t=state.tournaments.find(x=>x.id===req.params.id);if(!t)return res.status(404).json({error:'Tournament not found'});t.status='completed';t.completedAt=new Date().toISOString();changed();res.json(t);});
app.get('/api/health',(req,res)=>res.json({ok:true}));
wss.on('connection',ws=>{ws.send(JSON.stringify({type:'state',data:publicState()}));});
server.listen(PORT,()=>console.log(`Badminton Tournament Manager running at http://localhost:${PORT}`));
