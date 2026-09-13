/* ============================================================
   regles.js — Règles de la belote, écrites à un seul endroit
   Ce fichier est chargé à la fois par le serveur (require) et par le
   navigateur (<script>) : la page et l'arbitre appliquent ainsi
   exactement les mêmes règles.
   ============================================================ */
(function(root){
'use strict';

const SUITS = ['s','h','d','c'];
const RANKS = ['7','8','9','10','V','D','R','A'];
const SUIT_NAME = {s:'pique', h:'cœur', d:'carreau', c:'trèfle'};
const ORD_T = {'7':0,'8':1,'D':2,'R':3,'10':4,'A':5,'9':6,'V':7};
const ORD_P = {'7':0,'8':1,'9':2,'V':3,'D':4,'R':5,'10':6,'A':7};
const PTS_T = {'7':0,'8':0,'9':14,'V':20,'D':3,'R':4,'10':10,'A':11};
const PTS_P = {'7':0,'8':0,'9':0,'V':2,'D':3,'R':4,'10':10,'A':11};
const CARD_POINTS = 152;          // total des cartes, hors dix de der

const orderOf   = (c,t) => c.suit===t ? ORD_T[c.rank] : ORD_P[c.rank];
const ptsOf     = (c,t) => c.suit===t ? PTS_T[c.rank] : PTS_P[c.rank];
const teamOf    = p => p % 2;
const partnerOf = p => (p + 2) % 4;

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

/* Cartes autorisées. opts.sousCouper : quand un adversaire a coupé et qu'on ne peut pas
   surcouper, faut-il tout de même jouer un atout plus faible ? (true = règle officielle) */
function legalMoves(hand, t, trick, me, opts){
  const sousCouper = !opts || opts.sousCouper!==false;
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
  if(trickWinner(trick,t)===partnerOf(me)) return hand.slice();
  const bt = bestTrumpIn(trick,t);
  if(!bt) return trumps;
  const hi = trumps.filter(c=>orderOf(c,t)>orderOf(bt,t));
  if(hi.length) return hi;
  return sousCouper ? trumps : hand.slice();
}

/* Motif du refus d'une carte (appelée uniquement pour une carte interdite) */
function whyIllegal(hand, t, trick, me, card, opts){
  if(!trick.length) return "C'est à vous d'entamer : jouez la carte de votre choix.";
  const lead = trick[0].card.suit;
  if(card.suit!==lead && hand.some(c=>c.suit===lead))
    return 'Vous devez fournir du ' + SUIT_NAME[lead] + '.';
  if(lead===t) return "À l'atout, vous devez monter dès que vous le pouvez.";
  const bt = bestTrumpIn(trick,t);
  if(bt && hand.some(c=>c.suit===t && orderOf(c,t)>orderOf(bt,t)))
    return "L'adversaire a coupé : vous devez surcouper.";
  if(bt) return "L'adversaire a coupé : vous devez tout de même jouer atout.";
  return "Vous n'avez plus de " + SUIT_NAME[lead] + ' : vous devez couper (atout ' + SUIT_NAME[t] + ').';
}

/* Estimation de la force d'une main avec `s` pour atout (utilisée par les bots et la passe automatique) */
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

/* Décompte des points d'une donne.
   state : { tricksWon:[cartes équipe 0, cartes équipe 1], taker, trump, lastWinner, beloteScored:[bool,bool] }
   cfg   : { pointsBelote, dixDeDer, pointsCapot, beloteToujoursAcquise }
   Renvoie { status:'reussi'|'chute', capot:-1|0|1, add:[pts équipe 0, pts équipe 1], rows } */
function scoreHand(state, cfg){
  const c = Object.assign({ pointsBelote:20, dixDeDer:10, pointsCapot:252, beloteToujoursAcquise:true }, cfg);
  const t = state.trump, tk = teamOf(state.taker), df = 1 - tk, lastT = teamOf(state.lastWinner);
  const totalDonne = CARD_POINTS + c.dixDeDer;
  const base = [0,1].map(i=>state.tricksWon[i].reduce((a,x)=>a+ptsOf(x,t),0));
  const der  = [0,1].map(i=>i===lastT ? c.dixDeDer : 0);
  const capot = !state.tricksWon[0].length ? 1 : !state.tricksWon[1].length ? 0 : -1;
  const plis = [0,1].map(i=>i===capot ? c.pointsCapot : base[i]+der[i]);
  const bel  = [0,1].map(i=>state.beloteScored[i] ? c.pointsBelote : 0);

  // Le preneur doit marquer strictement plus que la défense, belote comprise.
  const reussi = plis[tk]+bel[tk] > plis[df]+bel[df];
  const add = [0,0];
  if(reussi){
    add[tk] = plis[tk]+bel[tk];
    add[df] = plis[df]+bel[df];
  }else{
    add[df] = (capot===df ? c.pointsCapot : totalDonne) + bel[df];
    if(c.beloteToujoursAcquise) add[tk] = bel[tk];
    else add[df] += bel[tk];
  }

  const rows = [0,1].map(i=>{
    const r = [['Points des plis', base[i]]];
    if(der[i]) r.push(['Dix de der', der[i]]);
    if(i===capot) r.push(['Prime de capot', c.pointsCapot - base[i] - der[i]]);
    if(bel[i]){
      const perdue = !reussi && i===tk && !c.beloteToujoursAcquise;
      r.push(['Belote et rebelote', bel[i], perdue]);
    }
    if(!reussi){
      if(i===tk) r.push(['Contrat chuté', 'points des plis perdus']);
      else{
        r.push(['La défense empoche la donne', capot===df ? c.pointsCapot : totalDonne]);
        if(!c.beloteToujoursAcquise && bel[tk]) r.push(['Belote reprise au preneur', bel[tk]]);
      }
    }
    r.push(['Total marqué', add[i], false, true]);
    return r;
  });
  return { status: reussi ? 'reussi' : 'chute', capot, add, rows };
}

const api = { SUITS, RANKS, SUIT_NAME, CARD_POINTS, orderOf, ptsOf, teamOf, partnerOf,
  trickWinner, bestTrumpIn, legalMoves, whyIllegal, evalHand, scoreHand };
if(typeof module!=='undefined' && module.exports) module.exports = api;
else root.Regles = api;
})(typeof globalThis!=='undefined' ? globalThis : this);
