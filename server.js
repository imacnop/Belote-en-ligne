/* ============================================================
   server.js — La Belote en ligne
   Lancer :  npm install   puis   node server.js
   ============================================================ */
const express = require('express');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'belote.html')));

const PORT = process.env.PORT || 3000;
const TURN_MS = 45000;            // délai avant jeu automatique (joueur absent)
const ROOM_TTL = 10 * 60 * 1000;  // purge des salles abandonnées

/* ---------------- Règles ---------------- */
const SUITS = ['s','h','d','c'];
const ORD_T = {'7':0,'8':1,'D':2,'R':3,'10':4,'A':5,'9':6,'V':7};
const ORD_P = {'7':0,'8':1,'9':2,'V':3,'D':4,'R':5,'10':6,'A':7};
const PTS_T = {'7':0,'8':0,'9':14,'V':20,'D':3,'R':4,'10':10,'A':11};
const PTS_P = {'7':0,'8':0,'9':0,'V':2,'D':3,'R':4,'10':10,'A':11};
const orderOf = (c,t) => c.suit===t ? ORD_T[c.rank] : ORD_P[c.rank];
const ptsOf   = (c,t) => c.suit===t ? PTS_T[c.rank] : PTS_P[c.rank];
const beats   = (a,b,t) => a.suit===b.suit ? orderOf(a,t)>orderOf(b,t) : a.suit===t;
const teamOf  = p => p % 2;
const sleep   = ms => new Promise(r => setTimeout(r, ms));

function trickWinner(trick, t){
  let best = trick[0];
  for(let i=1;i<trick.length;i++){
    const c=trick[i].card, b=best.card;
    if(c.suit===b.suit){ if(orderOf(c,t)>orderOf(b,t)) best=trick[i]; }
    else if(c.suit===t) best=trick[i];
  }
  return best.p;
}
function bestTrumpIn(trick, t){
  let best=null;
  for(const x of trick) if(x.card.suit===t && (!best || orderOf(x.card,t)>orderOf(best,t))) best=x.card;
  return best;
}
function legalMoves(hand, t, trick, me){
  if(!trick.length) return hand.slice();
  const lead = trick[0].card.suit;
  const mine = hand.filter(c=>c.suit===lead);
  if(lead===t){
    if(!mine.length) return hand.slice();
    const bt = bestTrumpIn(trick,t);
    const hi = mine.filter(c=>orderOf(c,t)>orderOf(bt,t));
    return hi.length ? hi : mine;
  }
  if(mine.length) return mine;
  const trumps = hand.filter(c=>c.suit===t);
  if(!trumps.length) return hand.slice();
  if(trickWinner(trick,t)===(me+2)%4) return hand.slice();
  const bt = bestTrumpIn(trick,t);
  if(bt){
    const hi = trumps.filter(c=>orderOf(c,t)>orderOf(bt,t));
    return hi.length ? hi : trumps;
  }
  return trumps;
}
function whyIllegal(hand, t, trick, me, card){
  if(!trick.length) return 'La table est libre, jouez ce que vous voulez.';
  const lead = trick[0].card.suit;
  const mine = hand.filter(c=>c.suit===lead);
  if(mine.length && card.suit!==lead)
    return lead===t ? "À l'atout, vous devez monter si vous le pouvez." : 'Vous devez fournir à la couleur demandée.';
  if(!mine.length){
    const trumps = hand.filter(c=>c.suit===t);
    if(trumps.length && trickWinner(trick,t)!==(me+2)%4){
      const bt = bestTrumpIn(trick,t);
      if(bt && trumps.some(c=>orderOf(c,t)>orderOf(bt,t))) return 'Vous devez surcouper.';
      return "Vous devez couper à l'atout.";
    }
  }
  return 'Cette carte ne peut pas être jouée pour le moment.';
}

/* ---------------- IA (bots & coups automatiques) ---------------- */
function evalHand(hand, s){
  const tc = hand.filter(c=>c.suit===s);
  if(!tc.length) return -1;
  const TP = {'V':20,'9':14,'A':11,'10':10,'R':4,'D':3,'8':1,'7':1};
  let v = tc.reduce((a,c)=>a+TP[c.rank],0);
  if(tc.some(c=>c.rank==='R') && tc.some(c=>c.rank==='D')) v += 20;
  v += [0,0,4,9,14][Math.min(tc.length,4)];
  v += hand.filter(c=>c.suit!==s && c.rank==='A').length * 7;
  return v;
}
function aiBidChoice(hand, round, turned){
  if(round===1){
    const v = evalHand(hand.concat([turned]), turned.suit);
    return v >= 51 ? turned.suit : null;
  }
  let best=null, bv=47;
  for(const s of SUITS){ const v=evalHand(hand,s); if(v>bv){ bv=v; best=s; } }
  return best;
}
const smallestBy = (cards,t) => cards.reduce((a,c)=>orderOf(c,t)<orderOf(a,t)?c:a);
function isBossCard(c, t, played){
  if(c.suit===t){
    if(c.rank==='V') return true;
    if(c.rank==='9') return played.some(x=>x.suit===t&&x.rank==='V');
    return false;
  }
  return c.rank==='A' && played.some(x=>x.suit===c.suit&&x.rank==='10');
}
function aiLead(room, p, legal){
  const hand=room.hands[p], t=room.trump;
  const trumps = legal.filter(c=>c.suit===t);
  if(p===room.taker){
    const v = trumps.find(c=>c.rank==='V'); if(v) return v;
    if(trumps.length>=3) return smallestBy(trumps,t);
  }else if(room.taker===(p+2)%4 && trumps.length && trumps.length<=2) return smallestBy(trumps,t);
  const aces = legal.filter(c=>c.rank==='A' && c.suit!==t && hand.filter(x=>x.suit===c.suit).length>=2);
  if(aces.length) return aces[0];
  const nonT = legal.filter(c=>c.suit!==t);
  if(nonT.length){
    const short = nonT.filter(c=>hand.filter(x=>x.suit===c.suit).length===1);
    return short.length ? smallestBy(short,t) : smallestBy(nonT,t);
  }
  return smallestBy(trumps,t);
}
function aiFollow(room, p, legal){
  const t=room.trump, lead=room.trick[0].card.suit;
  const winP = trickWinner(room.trick, t);
  const winCard = room.trick.find(x=>x.p===winP).card;
  const partnerMaster = winP===(p+2)%4, last = room.trick.length===3;
  if(partnerMaster){
    if(last){
      const free = legal.filter(c=>c.suit!==lead);
      const pool = (free.length?free:legal).filter(c=>c.suit!==t);
      const pool2 = pool.length?pool:legal;
      return pool2.reduce((a,c)=>ptsOf(c,t)>ptsOf(a,t)?c:a);
    }
    return smallestBy(legal,t);
  }
  const winners = legal.filter(c=>beats(c,winCard,t));
  if(winners.length){
    const w = smallestBy(winners,t);
    if(last || isBossCard(w,t,room.played)) return w;
    return smallestBy(legal,t);
  }
  const free = legal.filter(c=>c.suit!==lead);
  const pool = (free.length?free:legal).filter(c=>c.suit!==t);
  return smallestBy(pool.length?pool:legal,t);
}
function aiChoose(room, p){
  const legal = legalMoves(room.hands[p], room.trump, room.trick, p);
  if(legal.length===1) return legal[0];
  return room.trick.length ? aiFollow(room,p,legal) : aiLead(room,p,legal);
}

/* ---------------- Salles ---------------- */
const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newPid = () => crypto.randomBytes(12).toString('hex');
function newCode(){
  let c;
  do { c = Array.from({length:4},()=>CODE_CHARS[Math.floor(Math.random()*CODE_CHARS.length)]).join(''); }
  while(rooms.has(c));
  return c;
}
function makeRoom(){
  const room = {
    code:newCode(), seats:[null,null,null,null], host:-1,
    phase:'lobby', target:501, scores:[0,0], handNo:0, bidRound:1,
    dealer:Math.floor(Math.random()*4),
    deck:[], hands:[[],[],[],[]], turned:null, trump:null, taker:-1,
    trick:[], tricksWon:[[],[]], played:[], lastTrick:null, lastWinner:-1, lastResult:null,
    beloteFirst:[null,null,null,null], beloteScored:[false,false],
    pending:null, gen:0, lastActive:Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}
const seatConn = s => !!s && (s.bot || !!(s.sk && s.sk.connected));
const publicSeats = room => room.seats.map((s,i)=>({ seat:i, name:s?s.name:'', bot:s?s.bot:false, connected:seatConn(s) }));
const emitRoom = room => { room.lastActive=Date.now(); io.to(room.code).emit('room', { players:publicSeats(room), host:room.host, phase:room.phase }); };
function sortHand(hand, t){
  const SU={s:1,h:2,d:3,c:4};
  hand.sort((a,b)=>{
    const sa=a.suit===t?0:SU[a.suit], sb=b.suit===t?0:SU[b.suit];
    return sa!==sb ? sa-sb : orderOf(b,t)-orderOf(a,t);
  });
}
const sendHand = (room, p) => {
  const s = room.seats[p];
  if(s && !s.bot && s.sk && s.sk.connected) io.to(s.sk.id).emit('yourHand', { cards:room.hands[p] });
};
function syncPayload(room){
  const t = room.trump || 's';
  return {
    handNo:room.handNo, trump:room.trump, taker:room.taker, turned:room.turned,
    counts:room.hands.map(h=>h.length),
    trick:room.trick.map(x=>({p:x.p, card:x.card})),
    tricks:[room.tricksWon[0].length/4, room.tricksWon[1].length/4],
    pts:[0,1].map(tt=>room.tricksWon[tt].reduce((a,c)=>a+ptsOf(c,t),0)),
    lastTrick:room.lastTrick, lastWinner:room.lastWinner,
    bidRound:room.bidRound, scores:room.scores.slice(), target:room.target,
    dealer:room.dealer,
    result:(room.phase==='handEnd'||room.phase==='gameOver') ? room.lastResult : null,
  };
}

/* ---------------- Déroulé d'une donne ---------------- */
function startMatch(room){
  room.gen++;
  room.scores=[0,0]; room.handNo=0;
  room.phase='playing';
  io.to(room.code).emit('matchStart', { target:room.target, scores:room.scores });
  runHand(room, room.gen);
}

function askBid(room, seat, round){
  return new Promise(resolve=>{
    const s = room.seats[seat];
    const pd = room.pending = { type:'bid', seat, tm:null,
      resolve:v=>{ if(room.pending===pd){ room.pending=null; clearTimeout(pd.tm); resolve(v); } } };
    io.to(room.code).emit('bidTurn', { seat, round });
    if(s.bot) pd.tm = setTimeout(()=>pd.resolve(aiBidChoice(room.hands[seat], round, room.turned)), 500+Math.random()*450);
    else if(!s.sk || !s.sk.connected) pd.tm = setTimeout(()=>pd.resolve(null), 400);
    else pd.tm = setTimeout(()=>pd.resolve(null), TURN_MS);
  });
}
function askPlay(room, seat){
  return new Promise(resolve=>{
    const s = room.seats[seat];
    const pd = room.pending = { type:'play', seat, tm:null,
      resolve:(card,auto)=>{ if(room.pending===pd){ room.pending=null; clearTimeout(pd.tm); resolve({card,auto}); } } };
    io.to(room.code).emit('turn', { seat });
    const isBot = s.bot;
    if(isBot)
      pd.tm = setTimeout(()=>pd.resolve(aiChoose(room,seat), false), 500+Math.random()*450);
    else if(!s.sk || !s.sk.connected)
      pd.tm = setTimeout(()=>pd.resolve(aiChoose(room,seat), true), 6000); // laisse une chance de se reconnecter
    else
      pd.tm = setTimeout(()=>pd.resolve(aiChoose(room,seat), true), TURN_MS);
  });
}

async function applyPlay(room, p, card, auto){
  const hand = room.hands[p];
  hand.splice(hand.findIndex(c=>c.id===card.id), 1);
  if(card.suit===room.trump && (card.rank==='R' || card.rank==='D')){
    const other = card.rank==='R' ? 'D' : 'R';
    if(hand.some(c=>c.suit===room.trump && c.rank===other)){
      room.beloteFirst[p] = card.rank;
      io.to(room.code).emit('belote', { seat:p, kind:'belote' });
    }else if(room.beloteFirst[p]===other){
      room.beloteScored[teamOf(p)] = true;
      io.to(room.code).emit('belote', { seat:p, kind:'rebelote' });
    }
  }
  room.trick.push({ p, card });
  room.played.push(card);
  io.to(room.code).emit('cardPlayed', { seat:p, card, auto:!!auto });
  await sleep(330);
}

async function playTricks(room, gen){
  let leader = (room.dealer+1)%4;
  for(let t=0;t<8;t++){
    room.trick = [];
    let p = leader;
    for(let k=0;k<4;k++){
      const { card, auto } = await askPlay(room, p);
      if(gen!==room.gen) return;
      await applyPlay(room, p, card, auto);
      if(gen!==room.gen) return;
      p = (p+1)%4;
    }
    const w = trickWinner(room.trick, room.trump);
    room.tricksWon[teamOf(w)].push(...room.trick.map(x=>x.card));
    room.lastTrick = room.trick.slice(); room.lastWinner = w;
    const pts = [0,1].map(tt=>room.tricksWon[tt].reduce((a,c)=>a+ptsOf(c,room.trump),0));
    await sleep(800); if(gen!==room.gen) return;
    io.to(room.code).emit('trickWon', { seat:w, team:teamOf(w),
      tricks:[room.tricksWon[0].length/4, room.tricksWon[1].length/4], pts });
    await sleep(320); if(gen!==room.gen) return;
    leader = w;
  }
}

function scoreHand(room){
  const lastT = teamOf(room.lastWinner);
  const base = [0,1].map(t=>room.tricksWon[t].reduce((a,c)=>a+ptsOf(c,room.trump),0));
  const bel = [room.beloteScored[0]?20:0, room.beloteScored[1]?20:0];
  const tk = teamOf(room.taker), df = 1-tk;
  const withLast = [base[0]+(lastT===0?10:0), base[1]+(lastT===1?10:0)];
  const dedans = room.tricksWon[tk].length===0;
  let add=[0,0], status;
  if(dedans){ status='dedans'; add[df]=252; }
  else if(withLast[tk]+bel[tk] > withLast[df]+bel[df]){ status='ok'; add=[withLast[0]+bel[0], withLast[1]+bel[1]]; }
  else { status='ko'; add[df]=162+bel[df]; }
  const rows = [0,1].map(t=>{
    const isTaker = t===tk;
    let total;
    if(status==='ok') total = withLast[t]+bel[t];
    else if(status==='dedans') total = isTaker?0:252;
    else total = isTaker ? withLast[t] : 162+bel[t];
    const r = [['Points de plis', base[t]]];
    if(withLast[t]>base[t]) r.push(['Dernier pli', 10]);
    if(bel[t]) r.push(['Belote & rebelote', (status==='ko'&&isTaker)?0:20, (status==='ko'&&isTaker)]);
    if(status==='dedans' && t===df) r.push(['Dont prime « dedans »','—']);
    r.push(['Total', total, false, true]);
    return r;
  });
  return { handNo:room.handNo, trump:room.trump, takerName:room.seats[room.taker].name,
           status, add, rows };
}

async function runHand(room, gen){
  room.handNo++;
  room.phase='playing';
  room.hands=[[],[],[],[]]; room.deck=[]; room.trump=null; room.taker=-1; room.turned=null;
  room.trick=[]; room.tricksWon=[[],[]]; room.played=[]; room.lastTrick=null; room.lastWinner=null;
  room.beloteFirst=[null,null,null,null]; room.beloteScored=[false,false]; room.pending=null;
  io.to(room.code).emit('startHand', { handNo:room.handNo, dealer:room.dealer, dealerName:room.seats[room.dealer].name });
  await sleep(500); if(gen!==room.gen) return;

  room.deck=[];
  for(const s of SUITS) for(const r of ['7','8','9','10','V','D','R','A']) room.deck.push({suit:s, rank:r, id:s+r});
  for(let i=room.deck.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [room.deck[i],room.deck[j]]=[room.deck[j],room.deck[i]]; }

  const order=[1,2,3,0].map(i=>(room.dealer+i)%4);
  for(const cnt of [3,2]){
    for(const p of order){
      for(let k=0;k<cnt;k++){
        room.hands[p].push(room.deck.pop());
        io.to(room.code).emit('dealStep', { seat:p });
        await sleep(85); if(gen!==room.gen) return;
      }
      await sleep(140); if(gen!==room.gen) return;
    }
  }
  room.turned = room.deck.pop();
  io.to(room.code).emit('turned', { card:room.turned });
  for(let p=0;p<4;p++){ sortHand(room.hands[p], null); sendHand(room,p); }
  await sleep(500); if(gen!==room.gen) return;

  /* Enchères */
  let taken=null;
  outer: for(let round=1; round<=2; round++){
    room.bidRound = round;
    for(let i=1;i<=4;i++){
      const p=(room.dealer+i)%4;
      const suit = await askBid(room, p, round);
      if(gen!==room.gen) return;
      io.to(room.code).emit('bidAction', { seat:p, take:suit!=null, suit });
      if(suit){ taken={p, suit}; break outer; }
      await sleep(300); if(gen!==room.gen) return;
    }
    if(round===1){
      io.to(room.code).emit('allPass1', {});
      await sleep(700); if(gen!==room.gen) return;
    }
  }
  if(!taken){
    io.to(room.code).emit('allPass', {});
    await sleep(1400); if(gen!==room.gen) return;
    room.dealer=(room.dealer+1)%4;
    return runHand(room, gen);
  }
  room.taker=taken.p; room.trump=taken.suit;
  io.to(room.code).emit('taken', { seat:room.taker, suit:room.trump });
  await sleep(650); if(gen!==room.gen) return;

  room.hands[room.taker].push(room.turned);
  room.turned=null;
  io.to(room.code).emit('turnedTaken', { seat:room.taker });
  await sleep(150); if(gen!==room.gen) return;
  for(let i=0;i<4;i++){
    const p=(room.taker+i)%4, n=p===room.taker?2:3;
    for(let k=0;k<n;k++){
      room.hands[p].push(room.deck.pop());
      io.to(room.code).emit('restStep', { seat:p });
      await sleep(85); if(gen!==room.gen) return;
    }
    await sleep(140); if(gen!==room.gen) return;
  }
  for(let p=0;p<4;p++){ sortHand(room.hands[p], room.trump); sendHand(room,p); }

  await playTricks(room, gen); if(gen!==room.gen) return;

  const res = scoreHand(room);
  room.scores[0]+=res.add[0]; room.scores[1]+=res.add[1];
  res.scores = room.scores.slice();
  res.target = room.target;
  res.gameOver = isFinite(room.target) && (room.scores[0]>=room.target || room.scores[1]>=room.target);
  if(res.gameOver) res.winner = room.scores[0]>=room.target ? 0 : 1;
  room.lastResult = res;
  room.phase = res.gameOver ? 'gameOver' : 'handEnd';
  io.to(room.code).emit('handEnd', { result:res });
  emitRoom(room);
  if(res.gameOver) return;
  room.dealer=(room.dealer+1)%4;
  await sleep(7000); if(gen!==room.gen) return;
  return runHand(room, gen);
}

/* ---------------- Connexions ---------------- */
io.on('connection', sk=>{
  let roomRef=null, seatRef=-1;
  const bind = () => (roomRef && seatRef>=0 && rooms.get(roomRef.code)===roomRef) ? {room:roomRef, seat:seatRef} : {};

  sk.on('hello', ({name, code, pid:token})=>{
    name = String(name||'').trim().slice(0,12) || 'Joueur';
    /* Reprise de session (rafraîchissement, écran verrouillé…) */
    if(token && code && rooms.has(code)){
      const room = rooms.get(code);
      const idx = room.seats.findIndex(s=>s && !s.bot && s.pid===token);
      if(idx>=0){
        const seat = room.seats[idx];
        if(seat.sk && seat.sk.id!==sk.id){
          seat.sk.emit('err',{msg:'Cette partie a été reprise sur un autre écran.', fatal:true});
          seat.sk.disconnect(true);
        }
        seat.sk = sk; roomRef = room; seatRef = idx; room.lastActive = Date.now();
        sk.join(room.code);
        sk.emit('joined', { pid:token, code:room.code, seat:idx, host:room.host,
          players:publicSeats(room), phase:room.phase, target:room.target,
          scores:room.scores, sync:room.phase==='lobby'?null:syncPayload(room) });
        sendHand(room, idx);
        if(room.pending && room.pending.seat===idx){
          if(room.pending.type==='bid') io.to(sk.id).emit('bidTurn',{seat:idx, round:room.bidRound});
          else io.to(sk.id).emit('turn',{seat:idx});
        }
        emitRoom(room);
        return;
      }
    }
    /* Rejoindre une salle */
    if(code){
      const room = rooms.get(String(code).toUpperCase());
      if(!room){ sk.emit('err',{msg:'Salle introuvable — vérifiez le code.', fatal:true}); return; }
      if(room.phase!=='lobby'){ sk.emit('err',{msg:'La partie a déjà commencé dans cette salle.', fatal:true}); return; }
      const idx = room.seats.findIndex(s=>!s);
      if(idx<0){ sk.emit('err',{msg:'Cette salle est déjà complète (4 joueurs).', fatal:true}); return; }
      const t = newPid();
      room.seats[idx] = { pid:t, name, bot:false, sk };
      if(room.host<0 || !room.seats[room.host]) room.host = idx;
      roomRef=room; seatRef=idx;
      sk.join(room.code);
      sk.emit('joined', { pid:t, code:room.code, seat:idx, host:room.host,
        players:publicSeats(room), phase:'lobby', target:room.target, scores:[0,0], sync:null });
      emitRoom(room);
      return;
    }
    /* Créer une salle */
    const room = makeRoom();
    const t = newPid();
    room.seats[0] = { pid:t, name, bot:false, sk };
    room.host = 0;
    roomRef=room; seatRef=0;
    sk.join(room.code);
    sk.emit('joined', { pid:t, code:room.code, seat:0, host:0,
      players:publicSeats(room), phase:'lobby', target:room.target, scores:[0,0], sync:null });
    emitRoom(room);
  });

  sk.on('addBot', ()=>{
    const {room, seat} = bind(); if(!room) return;
    if(room.host!==seat || room.phase!=='lobby') return;
    const idx = room.seats.findIndex(s=>!s);
    if(idx<0) return;
    const pool=['Marcel','Gérard','Janine','Huguette','Firmin','Jeanine'];
    const used=new Set(room.seats.filter(Boolean).map(s=>s.name));
    room.seats[idx]={ pid:null, name:pool.find(n=>!used.has(n))||('Bot '+(idx+1)), bot:true, sk:null };
    emitRoom(room);
  });

  sk.on('start', ({target})=>{
    const {room, seat} = bind(); if(!room) return;
    if(room.host!==seat || room.phase!=='lobby') return;
    if(room.seats.some(s=>!s)) return;
    room.target = [251,501,1001,Infinity].includes(target) ? target : 501;
    startMatch(room);
  });

  sk.on('bid', ({suit})=>{
    const {room, seat} = bind(); if(!room) return;
    const pd = room.pending;
    if(!pd || pd.type!=='bid' || pd.seat!==seat) return;
    if(suit!=null && !SUITS.includes(suit)) suit=null;
    pd.resolve(suit);
  });

  sk.on('play', ({cardId})=>{
    const {room, seat} = bind(); if(!room) return;
    const pd = room.pending;
    if(!pd || pd.type!=='play' || pd.seat!==seat) return;
    const card = room.hands[seat].find(c=>c.id===cardId);
    if(!card) return;
    if(!legalMoves(room.hands[seat], room.trump, room.trick, seat).some(c=>c.id===card.id)){
      sk.emit('err', { msg:whyIllegal(room.hands[seat], room.trump, room.trick, seat, card) });
      return;
    }
    pd.resolve(card, false);
  });

  sk.on('chat', ({text})=>{
    const {room, seat} = bind(); if(!room || seat<0) return;
    const t = String(text||'').slice(0,200).trim(); if(!t) return;
    io.to(room.code).emit('chat', { seat, name:(room.seats[seat]&&room.seats[seat].name)||'?', text:t });
  });

  sk.on('rematch', ()=>{
    const {room, seat} = bind(); if(!room) return;
    if(room.host!==seat || room.phase!=='gameOver') return;
    startMatch(room);
  });

  sk.on('disconnect', ()=>{
    if(roomRef && seatRef>=0){
      const room = rooms.get(roomRef.code);
      if(room){
        const s = room.seats[seatRef];
        if(s && !s.bot){ s.sk=null; room.lastActive=Date.now(); emitRoom(room); }
      }
    }
  });
});

/* Purge des salles abandonnées */
setInterval(()=>{
  const now = Date.now();
  for(const [code, room] of rooms){
    const humans = room.seats.filter(s=>s && !s.bot);
    if(!humans.length && now-room.lastActive>ROOM_TTL){ rooms.delete(code); continue; }
    if(!humans.some(s=>s.sk && s.sk.connected) && now-room.lastActive>ROOM_TTL) rooms.delete(code);
  }
}, 60000);

server.listen(PORT, ()=>{
  console.log('\n  * La Belote — serveur demarre !');
  console.log(`    Sur cet ordinateur : http://localhost:${PORT}`);
  const nets = os.networkInterfaces();
  for(const name of Object.keys(nets))
    for(const net of nets[name])
      if(net.family==='IPv4' && !net.internal)
        console.log(`    Meme Wi-Fi (telephone...) : http://${net.address}:${PORT}`);
  console.log('\n  Partagez le code de salle ou le lien d invitation. Bonne belote !\n');
});