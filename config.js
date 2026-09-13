/* ============================================================
   config.js — Lecture du fichier de réglages config.jsonc
   Inutile de modifier ce fichier : c'est config.jsonc qu'il faut éditer.
   Toute valeur absente ou incorrecte est remplacée par la valeur
   par défaut, et un message explicite s'affiche dans la console.
   ============================================================ */
const fs = require('fs');
const path = require('path');

const FICHIER = process.env.BELOTE_CONFIG || path.join(__dirname, 'config.jsonc');

const REGLAGES = {
  'partie.pointsParDefaut':         { defaut:501,   type:'entier', min:0, max:100000 },
  'partie.choixPoints':             { defaut:[251,501,1001,0], type:'entiers', min:0, max:100000 },
  'regles.pointsBelote':            { defaut:20,    type:'entier', min:0, max:1000 },
  'regles.dixDeDer':                { defaut:10,    type:'entier', min:0, max:1000 },
  'regles.pointsCapot':             { defaut:252,   type:'entier', min:0, max:10000 },
  'regles.beloteToujoursAcquise':   { defaut:true,  type:'oui/non' },
  'regles.obligationDeSousCouper':  { defaut:true,  type:'oui/non' },
  'aides.jeuAutoCarteUnique':       { defaut:true,  type:'oui/non' },
  'aides.passeAutoMainFaible':      { defaut:false, type:'oui/non' },
  'temps.delaiTourSecondes':        { defaut:45,    type:'nombre', min:5, max:3600 },
  'temps.pauseEntreDonnesSecondes': { defaut:7,     type:'nombre', min:1, max:120 },
  'temps.reflexionBotsSecondes':    { defaut:0.7,   type:'nombre', min:0, max:30 },
  'bots.noms':                      { defaut:['Marcel','Gérard','Janine','Huguette','Firmin','Jeanine'], type:'textes' },
  'serveur.port':                   { defaut:3000,  type:'entier', min:1, max:65535 },
  'serveur.dureeVieSalleMinutes':   { defaut:10,    type:'nombre', min:1, max:10080 },
};
const ATTENDU = {
  'entier':  ['un nombre entier', ''],
  'nombre':  ['un nombre', ' (avec un point pour les décimales, par exemple 0.5)'],
  'oui/non': ['true (oui) ou false (non)', ''],
  'entiers': ['une liste de nombres entiers', ' (par exemple [251, 501])'],
  'textes':  ['une liste de noms entre guillemets', ' (par exemple ["Marcel", "Janine"])'],
};

const avertir = msg => console.warn('  [config] ' + msg);

/* Enlève un commentaire « // … » s'il n'est pas à l'intérieur de guillemets */
function sansCommentaire(ligne){
  const i = ligne.indexOf('//');
  if(i<0) return ligne;
  const avant = ligne.slice(0, i);
  return (avant.match(/"/g) || []).length % 2 === 0 ? avant : ligne;
}

function lireFichier(){
  const nom = path.basename(FICHIER);
  let texte;
  try{ texte = fs.readFileSync(FICHIER, 'utf8'); }
  catch(e){ avertir(`fichier ${nom} introuvable : les réglages par défaut s'appliquent.`); return {}; }
  const json = texte.replace(/^\uFEFF/, '').split(/\r?\n/).map(sansCommentaire).join('\n')
    .replace(/,(\s*[}\]])/g, '$1');                       // virgule en trop tolérée
  try{
    const brut = JSON.parse(json);
    if(brut && typeof brut==='object' && !Array.isArray(brut)) return brut;
    avertir(`le contenu de ${nom} doit être placé entre accolades { … } : les réglages par défaut s'appliquent.`);
  }catch(e){
    const m = /position (\d+)/.exec(e.message);
    const ligne = m ? json.slice(0, +m[1]).split('\n').length : null;
    avertir(`${nom} est mal rédigé${ligne ? `, vers la ligne ${ligne}` : ''} (détail technique : ${e.message}).`);
    avertir("Vérifiez les guillemets, les virgules et les accolades. En attendant, les réglages par défaut s'appliquent.");
  }
  return {};
}

function estValable(v, r){
  switch(r.type){
    case 'entier':  return Number.isInteger(v) && v>=r.min && v<=r.max;
    case 'nombre':  return typeof v==='number' && isFinite(v) && v>=r.min && v<=r.max;
    case 'oui/non': return typeof v==='boolean';
    case 'entiers': return Array.isArray(v) && v.length>0 && v.every(x=>Number.isInteger(x) && x>=r.min && x<=r.max);
    case 'textes':  return Array.isArray(v) && v.length>0 && v.every(x=>typeof x==='string' && x.trim());
  }
  return false;
}

function charger(){
  const brut = lireFichier();
  const cfg = {};
  for(const [cle, r] of Object.entries(REGLAGES)){
    const [groupe, nom] = cle.split('.');
    const section = brut[groupe];
    const val = section && typeof section==='object' ? section[nom] : undefined;
    cfg[groupe] = cfg[groupe] || {};
    if(val===undefined){ cfg[groupe][nom] = r.defaut; continue; }
    if(estValable(val, r)){ cfg[groupe][nom] = val; continue; }
    const bornes = r.min===undefined ? ''
      : r.type==='entiers' ? `, chacun compris entre ${r.min} et ${r.max}` : ` compris entre ${r.min} et ${r.max}`;
    const [attendu, exemple] = ATTENDU[r.type];
    avertir(`valeur incorrecte pour « ${cle} » : ${JSON.stringify(val)}. Il faut ${attendu}${bornes}${exemple}. ` +
            `La valeur par défaut (${JSON.stringify(r.defaut)}) est utilisée à la place.`);
    cfg[groupe][nom] = r.defaut;
  }
  for(const [groupe, section] of Object.entries(brut)){
    if(!section || typeof section!=='object' || Array.isArray(section)){
      avertir(`la section « ${groupe} » est inconnue ou mal écrite : elle est ignorée.`); continue;
    }
    for(const nom of Object.keys(section))
      if(!REGLAGES[groupe+'.'+nom]) avertir(`réglage « ${groupe}.${nom} » inconnu (faute de frappe ?) : il est ignoré.`);
  }

  cfg.partie.choixPoints = [...new Set(cfg.partie.choixPoints)];
  if(!cfg.partie.choixPoints.includes(cfg.partie.pointsParDefaut)){
    avertir(`le score par défaut (${cfg.partie.pointsParDefaut}) ne figure pas dans « partie.choixPoints » : il y a été ajouté.`);
    cfg.partie.choixPoints.push(cfg.partie.pointsParDefaut);
  }
  cfg.bots.noms = cfg.bots.noms.map(n=>n.trim().slice(0,12));
  return cfg;
}

module.exports = charger();
