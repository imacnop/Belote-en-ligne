/* ============================================================
   server.js — La Belote en ligne
   Lancer :  npm install   puis   npm start
   Réglages : fichier config.jsonc (pas besoin de toucher au code)
   ============================================================ */
const express = require('express');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const path = require('path');
const { Server } = require('socket.io');
const CFG = require('./config');
const { SUITS, RANKS, orderOf, ptsOf, teamOf, trickWinner, legalMoves, whyIllegal, evalHand, scoreHand } = require('./regles');

const PORT = process.env.PORT || CFG.serveur.port;
const TURN_MS = CFG.temps.delaiTourSecondes * 1000;          // délai avant jeu automatique (joueur absent)
const NEXT_HAND_MS = CFG.temps.pauseEntreDonnesSecondes * 1000;
const ROOM_TTL = CFG.serveur.dureeVieSalleMinutes * 60 * 1000; // purge des salles abandonnées
const LOBBY_GRACE_MS = 60000;   // siège libéré si un joueur quitte la salle d'attente sans revenir
const RULES = { sousCouper: CFG.regles.obligationDeSousCouper };
/* Réglages transmis au navigateur (affichage des règles, aides de jeu) */
const CLIENT_CFG = {
  choixPoints: CFG.partie.choixPoints,
  pointsParDefaut: CFG.partie.pointsParDefaut,
  regles: CFG.regles,
  aides: CFG.aides,
};

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'belote.html')));
app.get('/regles.js', (req, res) => res.sendFile(path.join(__dirname, 'regles.js')));
app.get('/config-client.js', (req, res) =>
  res.type('application/javascript').send('window.BELOTE_CONFIG = ' + JSON.stringify(CLIENT_CFG) + ';'));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const botDelay = () => CFG.temps.reflexionBotsSecondes * 1000 * (0.7 + Math.random() * 0.6);

/* ---------------- IA (bots et coups automatiques) ---------------- */
function aiBidChoice(hand, round, turned){
  if(round===1){
    const v = evalHand(hand.concat([turned]), turned.suit);
    return v >= 51 ? turned.suit : null;
  }
  let best=null, bv=47;
  for(const s of SUITS){
    if(s===turned.suit) continue;   // au second tour, la couleur retournée est exclue
    const v=evalHand(hand,s); if(v>bv){ bv=v; best=s; }
  }
  return best;
}
const beats = (a,b,t) => a.suit===b.suit ? orderOf(a,t)>orderOf(b,t) : a.suit===t;
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
  const legal = legalMoves(room.hands[p], room.trump, room.trick, p, RULES);
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
    phase:'lobby', target:CFG.partie.pointsParDefaut, scores:[0,0], handNo:0, bidRound:1,
    dealer:Math.floor(Math.random()*4),
    deck:[], hands:[[],[],[],[]], turned:null, trump:null, taker:-1,
    trick:[], tricksWon:[[],[]], played:[], lastTrick:null, lastWinner:-1, lastResult:null,
    beloteFirst:[null,null,null,null], beloteScored:[false,false],
    pending:null, gen:0, lastActive:Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}
function deleteRoom(room){
  room.gen++;                                   // arrête la donne en cours
  if(room.pending){ clearTimeout(room.pending.tm); room.pending=null; }
  rooms.delete(room.code);
}
const seatConn = s => !!s && (s.bot || !!(s.sk && s.sk.connected));
const publicSeats = room => room.seats.map((s,i)=>({ seat:i, name:s?s.name:'', bot:s?s.bot:false, connected:seatConn(s) }));
const emitRoom = room => io.to(room.code).emit('room', { players:publicSeats(room), host:room.host, phase:room.phase });

/* Un joueur quitte sa place : en salle d'attente le siège se libère,
   en cours de partie il reste (l'ordinateur joue pour lui). */
function freeSeat(room, idx){
  const s = room.seats[idx];
  if(!s || s.bot) return;
  if(room.phase==='lobby') room.seats[idx] = null;
  else s.sk = null;
  if(room.phase==='lobby' && !room.seats.some(x=>x && !x.bot)){ deleteRoom(room); return; }
  if(room.host===idx){
    const next = room.seats.findIndex(x=>x && !x.bot && x.sk && x.sk.connected);
    if(next>=0) room.host = next;
  }
  emitRoom(room);
}
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
    if(s.bot) pd.tm = setTimeout(()=>pd.resolve(aiBidChoice(room.hands[seat], round, room.turned)), 300+botDelay());
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
    if(s.bot)
      pd.tm = setTimeout(()=>pd.resolve(aiChoose(room,seat), false), 300+botDelay());
    else if(!s.sk || !s.sk.connected)
      pd.tm = setTimeout(()=>pd.resolve(aiChoose(room,seat), true), 6000); // on laisse au joueur le temps de se reconnecter
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

async function runHand(room, gen){
  room.handNo++;
  room.phase='playing';
  room.hands=[[],[],[],[]]; room.deck=[]; room.trump=null; room.taker=-1; room.turned=null; room.bidRound=1;
  room.trick=[]; room.tricksWon=[[],[]]; room.played=[]; room.lastTrick=null; room.lastWinner=-1;
  room.beloteFirst=[null,null,null,null]; room.beloteScored=[false,false]; room.pending=null;
  io.to(room.code).emit('startHand', { handNo:room.handNo, dealer:room.dealer, dealerName:room.seats[room.dealer].name });
  await sleep(500); if(gen!==room.gen) return;

  for(const s of SUITS) for(const r of RANKS) room.deck.push({suit:s, rank:r, id:s+r});
  for(let i=room.deck.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [room.deck[i],room.deck[j]]=[room.deck[j],room.deck[i]]; }

  /* Distribution : 3 puis 2 cartes, en commençant à gauche du donneur */
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

  /* Enchères : 1er tour à la couleur retournée, 2e tour à une autre couleur */
  let taken=null;
  outer: for(let round=1; round<=2; round++){
    room.bidRound = round;
    for(const p of order){
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

  /* Le preneur ramasse la carte retournée et reçoit 2 cartes ; les autres en reçoivent 3 */
  room.hands[room.taker].push(room.turned);
  room.turned=null;
  io.to(room.code).emit('turnedTaken', { seat:room.taker });
  await sleep(150); if(gen!==room.gen) return;
  for(const p of order){
    const n = p===room.taker ? 2 : 3;
    for(let k=0;k<n;k++){
      room.hands[p].push(room.deck.pop());
      io.to(room.code).emit('restStep', { seat:p });
      await sleep(85); if(gen!==room.gen) return;
    }
    await sleep(140); if(gen!==room.gen) return;
  }
  for(let p=0;p<4;p++){ sortHand(room.hands[p], room.trump); sendHand(room,p); }

  await playTricks(room, gen); if(gen!==room.gen) return;

  const res = Object.assign(
    { handNo:room.handNo, trump:room.trump, takerName:room.seats[room.taker].name },
    scoreHand(room, CFG.regles));
  room.scores[0]+=res.add[0]; room.scores[1]+=res.add[1];
  res.scores = room.scores.slice();
  res.target = room.target;
  const top = Math.max(room.scores[0], room.scores[1]);
  // La partie s'achève quand une équipe atteint le score visé et devance l'autre (0 = partie libre)
  res.gameOver = room.target>0 && top>=room.target && room.scores[0]!==room.scores[1];
  res.winner = res.gameOver ? (room.scores[0]>room.scores[1] ? 0 : 1) : -1;
  room.lastResult = res;
  room.phase = res.gameOver ? 'gameOver' : 'handEnd';
  io.to(room.code).emit('handEnd', { result:res });
  emitRoom(room);
  if(res.gameOver) return;
  room.dealer=(room.dealer+1)%4;
  await sleep(NEXT_HAND_MS); if(gen!==room.gen) return;
  return runHand(room, gen);
}

/* ---------------- Connexions ---------------- */
io.on('connection', sk=>{
  let roomRef=null, seatRef=-1;
  const bind = () => (roomRef && seatRef>=0 && rooms.get(roomRef.code)===roomRef) ? {room:roomRef, seat:seatRef} : {};
  const sit = (room, idx) => { roomRef=room; seatRef=idx; room.lastActive=Date.now(); sk.join(room.code); };
  /* Libère la place occupée (avant d'en prendre une autre, ou à la demande du joueur) */
  const unbind = () => {
    const {room, seat} = bind();
    if(room){
      sk.leave(room.code);
      const s = room.seats[seat];
      if(s && s.sk===sk) freeSeat(room, seat);
    }
    roomRef=null; seatRef=-1;
  };

  sk.on('hello', msg=>{
    msg = msg || {};
    const name = String(msg.name||'').trim().slice(0,12) || 'Joueur';
    const code = String(msg.code||'').trim().toUpperCase();
    const token = msg.pid;

    /* Reprise de session (rafraîchissement, écran verrouillé…) */
    if(token && code && rooms.has(code)){
      const room = rooms.get(code);
      const idx = room.seats.findIndex(s=>s && !s.bot && s.pid===token);
      if(idx>=0){
        const cur = bind();
        if(cur.room && (cur.room!==room || cur.seat!==idx)) unbind();
        const seat = room.seats[idx];
        if(seat.sk && seat.sk.id!==sk.id){
          seat.sk.emit('err',{msg:'Cette partie a été reprise sur un autre écran.', fatal:true});
          seat.sk.disconnect(true);
        }
        seat.sk = sk; sit(room, idx);
        sk.emit('joined', { pid:token, code:room.code, seat:idx, host:room.host,
          players:publicSeats(room), phase:room.phase, target:room.target,
          scores:room.scores, sync:room.phase==='lobby'?null:syncPayload(room) });
        sendHand(room, idx);
        if(room.pending && room.pending.seat===idx){
          if(room.pending.type==='bid') sk.emit('bidTurn',{seat:idx, round:room.bidRound});
          else sk.emit('turn',{seat:idx});
        }
        emitRoom(room);
        return;
      }
    }
    /* Rejoindre une salle */
    if(code){
      const room = rooms.get(code);
      if(!room){ sk.emit('err',{msg:'Salle introuvable — vérifiez le code.', fatal:true}); return; }
      if(room.phase!=='lobby'){ sk.emit('err',{msg:'La partie a déjà commencé dans cette salle.', fatal:true}); return; }
      if(bind().room===room) return;
      const idx = room.seats.findIndex(s=>!s);
      if(idx<0){ sk.emit('err',{msg:'Cette salle est déjà complète (4 joueurs).', fatal:true}); return; }
      unbind();
      const t = newPid();
      room.seats[idx] = { pid:t, name, bot:false, sk };
      if(room.host<0 || !room.seats[room.host] || room.seats[room.host].bot) room.host = idx;
      sit(room, idx);
      sk.emit('joined', { pid:t, code:room.code, seat:idx, host:room.host,
        players:publicSeats(room), phase:'lobby', target:room.target, scores:[0,0], sync:null });
      emitRoom(room);
      return;
    }
    /* Créer une salle */
    unbind();
    const room = makeRoom();
    const t = newPid();
    room.seats[0] = { pid:t, name, bot:false, sk };
    room.host = 0;
    sit(room, 0);
    sk.emit('joined', { pid:t, code:room.code, seat:0, host:0,
      players:publicSeats(room), phase:'lobby', target:room.target, scores:[0,0], sync:null });
    emitRoom(room);
  });

  sk.on('addBot', ()=>{
    const {room, seat} = bind(); if(!room) return;
    if(room.host!==seat || room.phase!=='lobby') return;
    const idx = room.seats.findIndex(s=>!s);
    if(idx<0) return;
    const used=new Set(room.seats.filter(Boolean).map(s=>s.name));
    room.seats[idx]={ pid:null, name:CFG.bots.noms.find(n=>!used.has(n))||('Bot '+(idx+1)), bot:true, sk:null };
    emitRoom(room);
  });

  sk.on('start', msg=>{
    const {room, seat} = bind(); if(!room) return;
    if(room.host!==seat || room.phase!=='lobby') return;
    if(room.seats.some(s=>!s)) return;
    const target = msg && msg.target;
    room.target = CFG.partie.choixPoints.includes(target) ? target : CFG.partie.pointsParDefaut;
    room.lastActive = Date.now();
    startMatch(room);
  });

  sk.on('bid', msg=>{
    const {room, seat} = bind(); if(!room) return;
    const pd = room.pending;
    if(!pd || pd.type!=='bid' || pd.seat!==seat) return;
    room.lastActive = Date.now();
    const suit = (msg && msg.suit!=null) ? msg.suit : null;
    if(suit!==null){
      const ok = room.bidRound===1 ? suit===room.turned.suit : (SUITS.includes(suit) && suit!==room.turned.suit);
      if(!ok){
        sk.emit('err', { msg: room.bidRound===1
          ? "Au premier tour, on ne peut prendre qu'à la couleur retournée."
          : "Au second tour, il faut choisir une couleur différente de celle qui a été retournée." });
        sk.emit('bidTurn', { seat, round:room.bidRound });
        return;
      }
    }
    pd.resolve(suit);
  });

  sk.on('play', msg=>{
    const {room, seat} = bind(); if(!room) return;
    const pd = room.pending;
    if(!pd || pd.type!=='play' || pd.seat!==seat) return;
    room.lastActive = Date.now();
    const card = room.hands[seat].find(c=>c.id===(msg && msg.cardId));
    if(!card){ sk.emit('turn', { seat }); return; }
    if(!legalMoves(room.hands[seat], room.trump, room.trick, seat, RULES).some(c=>c.id===card.id)){
      sk.emit('err', { msg:whyIllegal(room.hands[seat], room.trump, room.trick, seat, card, RULES) });
      sk.emit('turn', { seat });     // le joueur peut choisir une autre carte
      return;
    }
    pd.resolve(card, false);
  });

  sk.on('chat', msg=>{
    const {room, seat} = bind(); if(!room) return;
    const t = String((msg && msg.text)||'').slice(0,200).trim(); if(!t) return;
    room.lastActive = Date.now();
    io.to(room.code).emit('chat', { seat, name:(room.seats[seat]&&room.seats[seat].name)||'?', text:t });
  });

  sk.on('rematch', ()=>{
    const {room, seat} = bind(); if(!room) return;
    if(room.host!==seat || room.phase!=='gameOver') return;
    room.lastActive = Date.now();
    startMatch(room);
  });

  sk.on('leave', unbind);

  sk.on('disconnect', ()=>{
    const {room, seat} = bind(); if(!room) return;
    const s = room.seats[seat];
    if(!s || s.bot || s.sk!==sk) return;        // place déjà reprise sur un autre écran
    s.sk = null; room.lastActive = Date.now();
    emitRoom(room);
    if(room.phase==='lobby'){
      const pid = s.pid;
      setTimeout(()=>{
        const cur = room.seats[seat];
        if(rooms.get(room.code)===room && room.phase==='lobby' && cur && cur.pid===pid && !cur.sk) freeSeat(room, seat);
      }, LOBBY_GRACE_MS);
    }
  });
});

/* Suppression des salles restées sans joueur connecté pendant ROOM_TTL */
setInterval(()=>{
  const now = Date.now();
  for(const room of [...rooms.values()]){
    const online = room.seats.some(s=>s && !s.bot && s.sk && s.sk.connected);
    if(online) room.lastActive = now;
    else if(now-room.lastActive > ROOM_TTL) deleteRoom(room);
  }
}, 60000);

server.listen(PORT, ()=>{
  console.log('\n  * La Belote : le serveur est lancé !');
  console.log(`    Sur cet ordinateur : http://localhost:${PORT}`);
  const nets = os.networkInterfaces();
  for(const name of Object.keys(nets))
    for(const net of nets[name])
      if(net.family==='IPv4' && !net.internal)
        console.log(`    Depuis le même Wi-Fi (téléphone, tablette…) : http://${net.address}:${PORT}`);
  console.log('    Réglages : fichier config.jsonc (relancez le serveur après toute modification)');
  console.log("\n  Partagez le code de la salle ou le lien d'invitation. Bonne belote !\n");
});
