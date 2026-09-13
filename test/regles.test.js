/* Tests des règles — lancer avec :  npm test */
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../regles');

const card  = id => ({ suit:id[0], rank:id.slice(1), id });
const cards = s => s.split(' ').map(card);
const trick = (...plays) => plays.map(([p,id]) => ({ p, card:card(id) }));
const ids   = list => list.map(c=>c.id).sort();
const DECK  = R.SUITS.flatMap(s => R.RANKS.map(r => s + r));
const rest  = taken => cards(DECK.filter(id => !taken.split(' ').includes(id)).join(' '));

test('il faut fournir à la couleur demandée', () => {
  const legal = R.legalMoves(cards('h7 hA sV'), 's', trick([0,'hR']), 1);
  assert.deepEqual(ids(legal), ['h7','hA']);
});

test('sans la couleur, il faut couper', () => {
  const legal = R.legalMoves(cards('s7 d8'), 's', trick([0,'hR']), 1);
  assert.deepEqual(ids(legal), ['s7']);
});

test('partenaire maître du pli : on est libre', () => {
  const legal = R.legalMoves(cards('s7 d8'), 's', trick([1,'hA'],[2,'h7']), 3);
  assert.deepEqual(ids(legal), ['d8','s7']);
});

test('adversaire qui coupe : il faut surcouper si possible', () => {
  const legal = R.legalMoves(cards('s7 sV d8'), 's', trick([0,'h7'],[1,'s9']), 2);
  assert.deepEqual(ids(legal), ['sV']);
});

test('sous-couper selon le réglage', () => {
  const t = trick([0,'h7'],[1,'sV']);
  assert.deepEqual(ids(R.legalMoves(cards('s7 d8'), 's', t, 2, { sousCouper:true })), ['s7']);
  assert.deepEqual(ids(R.legalMoves(cards('s7 d8'), 's', t, 2, { sousCouper:false })), ['d8','s7']);
});

test("à l'atout, il faut monter si possible", () => {
  assert.deepEqual(ids(R.legalMoves(cards('sV s7'), 's', trick([0,'s9']), 1)), ['sV']);
  assert.deepEqual(ids(R.legalMoves(cards('s7 s8'), 's', trick([0,'s9']), 1)), ['s7','s8']);
});

test('explications des coups refusés', () => {
  assert.match(R.whyIllegal(cards('h7 sV'), 's', trick([0,'hR']), 1, card('sV')), /fournir du cœur/);
  assert.match(R.whyIllegal(cards('s7 d8'), 's', trick([0,'hR']), 1, card('d8')), /couper/);
  assert.match(R.whyIllegal(cards('s7 sV d8'), 's', trick([0,'h7'],[1,'s9']), 2, card('s7')), /surcouper/);
});

test('ordre et valeur des cartes', () => {
  assert.equal(R.trickWinner(trick([0,'sA'],[1,'s9'],[2,'sV'],[3,'s10']), 's'), 2);
  assert.equal(R.trickWinner(trick([0,'hA'],[1,'s7'],[2,'h10'],[3,'d9']), 's'), 1);
  const total = DECK.map(card).reduce((a,c)=>a+R.ptsOf(c,'c'),0);
  assert.equal(total, 152);
});

/* ---- Comptage ---- */
const clubs = 'c7 c8 c9 c10 cV cD cR cA';       // 62 points à l'atout trèfle
const state = (team0, extra={}) => Object.assign({
  tricksWon:[cards(team0), rest(team0)], taker:0, trump:'c', lastWinner:0, beloteScored:[false,false],
}, extra);

test('contrat réussi : chacun marque ses points', () => {
  const res = R.scoreHand(state(clubs + ' sA s10'), {});    // 83 + 10 de der
  assert.equal(res.status, 'reussi');
  assert.deepEqual(res.add, [93, 69]);
});

test('contrat chuté : la défense marque 162', () => {
  const res = R.scoreHand(state('sA s10 cV', { lastWinner:1 }), {});
  assert.equal(res.status, 'chute');
  assert.deepEqual(res.add, [0, 162]);
});

test('égalité : le preneur est dedans', () => {
  const res = R.scoreHand(state(clubs + ' sR sD sV'), {});    // 71 + 10 = 81 contre 81
  assert.equal(res.status, 'chute');
  assert.deepEqual(res.add, [0, 162]);
});

test('belote du preneur qui chute : acquise ou donnée selon le réglage', () => {
  const s = state('sA s10 cV', { lastWinner:1, beloteScored:[true,false] });
  assert.deepEqual(R.scoreHand(s, { beloteToujoursAcquise:true  }).add, [20, 162]);
  assert.deepEqual(R.scoreHand(s, { beloteToujoursAcquise:false }).add, [0, 182]);
});

test('la belote peut faire passer le contrat', () => {
  const s = state(clubs + ' sR sD sV', { beloteScored:[true,false] });   // 81 + 20 contre 81
  const res = R.scoreHand(s, {});
  assert.equal(res.status, 'reussi');
  assert.deepEqual(res.add, [101, 81]);
});

test('capot du preneur : 252', () => {
  const s = { tricksWon:[cards(DECK.join(' ')), []], taker:0, trump:'c', lastWinner:0, beloteScored:[false,false] };
  const res = R.scoreHand(s, {});
  assert.equal(res.status, 'reussi');
  assert.equal(res.capot, 0);
  assert.deepEqual(res.add, [252, 0]);
});

test('capot contre le preneur : 252 pour la défense', () => {
  const s = { tricksWon:[[], cards(DECK.join(' '))], taker:0, trump:'c', lastWinner:1, beloteScored:[false,false] };
  const res = R.scoreHand(s, {});
  assert.equal(res.status, 'chute');
  assert.deepEqual(res.add, [0, 252]);
});

test('preneur dans l’équipe 1', () => {
  const res = R.scoreHand(state('sA s10 cV', { taker:1, lastWinner:1 }), {});
  assert.equal(res.status, 'reussi');
  assert.deepEqual(res.add, [41, 121]);
});
