// ============================================================
// EconoSchool Pro — app.js
// Logique principale de l'application
// ============================================================

// ==================== SUPABASE ====================
// Connexion automatique depuis config.js — l'utilisateur ne touche jamais aux clés
const SB = {
  url: CONFIG.supabase_url,
  key: CONFIG.supabase_key,
  headers() {
    return {
      'apikey': this.key,
      'Authorization': 'Bearer ' + this.key,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    };
  },
  endpoint(table) {
    return this.url.replace(/\/$/, '') + '/rest/v1/' + table;
  },
  storageUrl() {
    return this.url.replace(/\/$/, '') + '/storage/v1';
  },
  async fetch(url, opts = {}) {
    const res = await fetch(url, {
      ...opts,
      headers: { ...this.headers(), ...(opts.headers || {}) }
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error('HTTP ' + res.status + ': ' + err.substring(0, 200));
    }
    if (res.status === 204) return null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('json')) return res.json();
    return null;
  },
  async select(table, query = '') {
    return this.fetch(this.endpoint(table) + query);
  },
  async upsert(table, data, onConflict = '') {
    const url = this.endpoint(table) + (onConflict ? '?on_conflict=' + onConflict : '');
    return this.fetch(url, {
      method: 'POST',
      headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(data)
    });
  },
  async update(table, query, data) {
    return this.fetch(this.endpoint(table) + query, {
      method: 'PATCH',
      headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify(data)
    });
  },
  async delete(table, query) {
    return this.fetch(this.endpoint(table) + query, { method: 'DELETE' });
  }
};

// ==================== STATE (données locales) ====================
const STATE = {
  user: null,         // 'fondateur' | 'econome'
  caisse_ouverte: true,
  eleves: [],
  paiements: [],
  caisse: [],
  depenses: [],
  reductions: [],     // réductions avec workflow approbation
  tarifs: {},
  banque: { compte: null, mouvements: [] },
  types_frais: {
    inscription_echeances: [],
    scolarite_echeances: [],
  },
  _editId: null,
  _photoData: null,
  _paiement: { eleve: null, data: null }
};

function save() {
  try {
    // Séparer les photos (trop lourdes) du reste des données
    // pour éviter la limite localStorage (~5MB)
    const photosMap = {};
    const eleveSansPhotos = STATE.eleves.map(e => {
      if (e.photo && e.photo.startsWith('data:')) {
        photosMap[e.id] = e.photo; // stocker séparément
        return { ...e, photo: '__local__' }; // marqueur
      }
      return e;
    });

    // Sauvegarder les données principales (sans photos base64)
    const stateMin = { ...STATE, eleves: eleveSansPhotos };
    localStorage.setItem('econoschool_' + CONFIG.code_ecole, JSON.stringify(stateMin));

    // Sauvegarder les photos par chunks (par groupes de 100)
    const ids = Object.keys(photosMap);
    const CHUNK = 100;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = {};
      ids.slice(i, i + CHUNK).forEach(id => { chunk[id] = photosMap[id]; });
      try {
        localStorage.setItem('photos_' + CONFIG.code_ecole + '_' + Math.floor(i/CHUNK), JSON.stringify(chunk));
      } catch(e) {
        // Chunk trop grand → ignorer (photos récupérées depuis Supabase)
      }
    }
  } catch(e) {
    console.warn('Save error:', e.message);
  }
}

function load() {
  try {
    const d = localStorage.getItem('econoschool_' + CONFIG.code_ecole);
    if (d) {
      const s = JSON.parse(d);
      Object.assign(STATE, s);
      // Toujours vider la caisse au chargement : elle sera reconstruite depuis Supabase
      // Cela évite les doublons/fantômes qui persistent dans le localStorage
      STATE.caisse = [];
      if (!STATE.banque) STATE.banque = { compte: null, mouvements: [] };
      if (!STATE.reductions) STATE.reductions = [];
      if (!STATE.types_frais) STATE.types_frais = { inscription_echeances: [], scolarite_echeances: [] };

      // Recharger les photos depuis les chunks
      const photosMap = {};
      let chunk = 0;
      while (true) {
        const key = 'photos_' + CONFIG.code_ecole + '_' + chunk;
        const data = localStorage.getItem(key);
        if (!data) break;
        try { Object.assign(photosMap, JSON.parse(data)); } catch(e) {}
        chunk++;
      }
      // Réinjecter les photos dans les élèves
      STATE.eleves = STATE.eleves.map(e => {
        if (e.photo === '__local__' && photosMap[e.id]) {
          return { ...e, photo: photosMap[e.id] };
        }
        return e;
      });
    }
  } catch(e) { console.warn('Load error:', e.message); }
}


// ==================== UTILS ====================
function genId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}
function genMatricule() {
  const y = new Date().getFullYear().toString().substr(2);
  const n = (STATE.eleves.length + 1).toString().padStart(4, '0');
  return 'EL' + y + n;
}
function fmt(n) {
  if (!n && n !== 0) return '0';
  return Number(n).toLocaleString('fr-FR') + ' F';
}
function fmtDate(d) {
  if (!d) return '-';
  const s = String(d).trim();
  // Déjà DD/MM/YYYY
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) return s;
  // Format YYYY-MM-DD → DD/MM/YYYY
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[3] + '/' + iso[2] + '/' + iso[1];
  try { return new Date(s).toLocaleDateString('fr-FR'); } catch(e) { return s; }
}
function today() { return new Date().toISOString().split('T')[0]; }

// Convertir n'importe quel format de date → YYYY-MM-DD pour input[type=date]
function toDateInput(val) {
  if (!val && val !== 0) return '';
  const s = String(val).trim();
  if (!s) return '';
  // Numéro série Excel (ex: 40179)
  if (/^\d{4,5}(\.\d+)?$/.test(s)) {
    const excelEpoch = new Date(1899, 11, 30);
    const d = new Date(excelEpoch.getTime() + Math.floor(Number(s)) * 86400000);
    if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
  }
  // Format DD/MM/YYYY
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmy) return dmy[3] + '-' + dmy[2].padStart(2,'0') + '-' + dmy[1].padStart(2,'0');
  // Format DD-MM-YYYY
  const dmy2 = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (dmy2) return dmy2[3] + '-' + dmy2[2].padStart(2,'0') + '-' + dmy2[1].padStart(2,'0');
  // Déjà YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0, 10);
  return '';
}
function toISO(d) {
  if (!d) return new Date().toISOString();
  try {
    const dt = new Date(d);
    return isNaN(dt.getTime()) ? new Date().toISOString() : dt.toISOString();
  } catch(e) { return new Date().toISOString(); }
}
function isUUID(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}

// ==================== DROITS ====================
const DROITS = {
  fondateur: {
    config: true, tarifs: true, types_frais: true,
    eleves_supprimer: true, eleves_modifier: true,
    paiements_modifier: true, paiements_supprimer: true,
    reductions_approuver: true, reductions_demander: true,
    banque: true, depenses: true,
    caisse_toggle: true, rapports: true
  },
  econome: {
    config: false, tarifs: false, types_frais: false,
    eleves_supprimer: false, eleves_modifier: true,
    paiements_modifier: false, paiements_supprimer: false,
    reductions_approuver: false, reductions_demander: true,
    banque: false, depenses: true,
    caisse_toggle: false, rapports: true
  }
};
function peutFaire(action) {
  const role = STATE.user || 'econome';
  return !!(DROITS[role] && DROITS[role][action]);
}
function exigeRole(action, msg) {
  if (!peutFaire(action)) {
    showToast(msg || 'Accès réservé au Fondateur', 'error');
    return false;
  }
  return true;
}

// ==================== TOAST / LOADING ====================
function showToast(msg, type = 'success') {
  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.innerHTML = '<span>' + (icons[type] || 'ℹ️') + '</span><span>' + msg + '</span>';
  document.getElementById('toast-container').appendChild(t);
  setTimeout(() => t.remove(), 4000);
}
function showLoading(txt = 'Chargement...') {
  document.getElementById('loading-overlay').classList.add('show');
  document.getElementById('loading-text').textContent = txt;
}
function hideLoading() {
  document.getElementById('loading-overlay').classList.remove('show');
}
function setSyncStatus(s, txt) {
  const b = document.getElementById('sync-bar');
  const x = document.getElementById('sync-text');
  if (b) b.className = 'sync-bar ' + s;
  if (x) x.textContent = txt;
}

// ==================== CALCULS FINANCIERS ====================
// Normaliser niveau pour la recherche des tarifs (ignore accents et casse)
function normNiveau(n) {
  return String(n || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}
// Trouver le tarif même si les accents diffèrent
function getTarif(niveau) {
  if (!niveau) return {};
  // Cherche d'abord exactement
  if (STATE.tarifs[niveau]) return STATE.tarifs[niveau];
  // Cherche sans accent
  const normN = normNiveau(niveau);
  const key = Object.keys(STATE.tarifs).find(k => normNiveau(k) === normN);
  return key ? STATE.tarifs[key] : {};
}

function calcAttenduEleve(eleve) {
  const t = getTarif(eleve.niveau);
  const estAffecte = (eleve.statut_sco === 'Affecté');
  // Classes examen : comparer sans accent
  const normElNiveau = normNiveau(eleve.niveau);
  const estClasseExamen = CONFIG.classes_examen.some(c => normNiveau(c) === normElNiveau);
  let montant = 0;
  if (!estAffecte) montant += Number(t.scolarite || 0);
  montant += Number(t.inscription || 0);
  montant += Number(t.annexes || t.frais_annexes || 0);
  if (estClasseExamen) montant += Number(t.examen || t.droit_examen || 0);
  // Appliquer réduction approuvée si elle existe
  const red = getReductionActive(eleve.id);
  if (red && red.statut === 'approuvee') {
    const montantScol = Number(t.scolarite || 0);
    const remise = montantScol * (Number(red.pourcentage) / 100);
    montant = Math.max(0, montant - remise);
  }
  return Math.max(0, montant);
}
function calcTotalAttendu() {
  return STATE.eleves.reduce((s, e) => s + calcAttenduEleve(e), 0);
}
function calcTotalPercu() {
  return STATE.paiements.reduce((s, p) => s + Number(p.montant), 0);
}
function calcPercuEleve(eleveId) {
  return STATE.paiements
    .filter(p => p.eleve_id === eleveId)
    .reduce((s, p) => s + Number(p.montant), 0);
}
function calcSoldeCaisse() {
  return STATE.caisse.reduce((s, m) =>
    m.type === 'entree' ? s + Number(m.montant) : s - Number(m.montant), 0);
}
function calcSoldeBanque() {
  const init = Number(STATE.banque.compte?.solde_init || 0);
  return (STATE.banque.mouvements || []).reduce((s, m) =>
    m.type === 'versement' ? s + Number(m.montant) : s - Number(m.montant), init);
}
// Calcule le montant dû à ce jour selon les échéances dont la date est dépassée
function calcAttenduAujourdhui(eleve) {
  const today = new Date(); today.setHours(0,0,0,0);

  // Toutes les échéances disponibles (inscription + scolarité)
  const echInscription = STATE.types_frais.inscription_echeances || [];
  const echScolarite   = STATE.types_frais.scolarite_echeances   || [];
  const toutesEcheances = [...echInscription, ...echScolarite];

  // Cas 1 : aucune échéance configurée → rien n'est "en retard" formellement
  // L'économe/fondateur doit d'abord configurer des dates butoir dans "Types de frais"
  if (toutesEcheances.length === 0) return 0;

  // Cas 2 : toutes les échéances sont sans date → on considère tout dû (ancien comportement)
  const echAvecDate = toutesEcheances.filter(e => e.date);
  if (echAvecDate.length === 0) return calcAttenduEleve(eleve);

  // Cas 3 : comparer les dates en string YYYY-MM-DD (évite le bug timezone)
  // On utilise l'heure locale (pas toISOString qui est UTC)
  const now = new Date();
  const todayStr = now.getFullYear() + '-' +
    String(now.getMonth() + 1).padStart(2, '0') + '-' +
    String(now.getDate()).padStart(2, '0'); // "2026-06-25" heure locale
  const echDepassees = echAvecDate.filter(e => {
    // e.date peut être "2026-06-24" ou "2026-06-24T00:00:00"
    const dateStr = (e.date || '').substring(0, 10);
    return dateStr <= todayStr;
  });

  // Aucune échéance dépassée → pas encore en retard
  if (echDepassees.length === 0) return 0;

  // Proportion des échéances dépassées sur total des échéances avec date
  const ratio = echDepassees.length / echAvecDate.length;
  const montantTotal = calcAttenduEleve(eleve);
  return Math.round(montantTotal * ratio);
}

function getElevesEnRetard() {
  // Log diagnostic niveaux sans tarif (une seule fois au démarrage)
  if (!window._niveauxLogFait) {
    window._niveauxLogFait = true;
    const niveauxEleves = {};
    STATE.eleves.forEach(e => { niveauxEleves[e.niveau || 'VIDE'] = (niveauxEleves[e.niveau || 'VIDE'] || 0) + 1; });
    const tarifsDispos = Object.keys(STATE.tarifs);
    console.log('NIVEAUX dans élèves:', JSON.stringify(niveauxEleves));
    console.log('TARIFS configurés:', JSON.stringify(tarifsDispos));
    // Niveaux sans tarif
    Object.keys(niveauxEleves).forEach(n => {
      const t = getTarif(n);
      if (!t || (!t.scolarite && !t.inscription)) console.warn('SANS TARIF → niveau:', n, '| nb élèves:', niveauxEleves[n]);
    });
  }
  return STATE.eleves.filter(e => {
    const du = calcAttenduAujourdhui(e);
    if (!du) return false;
    return calcPercuEleve(e.id) < du;
  });
}
function getReductionActive(eleveId) {
  return STATE.reductions.find(r => r.eleve_id === eleveId) || null;
}

// ==================== LOGIN ====================
let _loginRole = 'fondateur';

function switchLoginTab(evt, role) {
  _loginRole = role;
  document.querySelectorAll('.login-tab').forEach(t => t.classList.remove('active'));
  evt.target.classList.add('active');
}

async function doLogin() {
  const pass = document.getElementById('login-pass').value;
  if (!pass) { showToast('Entrez le mot de passe', 'error'); return; }

  const expected = _loginRole === 'fondateur'
    ? CONFIG.fondateur.password
    : CONFIG.econome.password;

  if (pass !== expected) {
    showToast('Mot de passe incorrect', 'error');
    return;
  }

  STATE.user = _loginRole;
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  setupUI();
  showLoading('Chargement des données...');
  load(); // charger localStorage (élèves, tarifs, config)
  // Badge à 0 en attendant le pull Supabase
  const badgeEl = document.getElementById('badge-retards');
  if (badgeEl) { badgeEl.textContent = '…'; badgeEl.style.display = 'inline'; }
  refreshDashboard();
  const hasRemote = await pullAll(); // sync Supabase complète (inclut échéances)
  if (!hasRemote) {
    showToast('⚠️ Données locales (pas de connexion)', 'warning');
  }
  hideLoading();
  SYNC.startHeartbeat();
  // Recalculer APRES pull complet (échéances chargées depuis Supabase)
  refreshDashboard();
  updateRetardsBadge();
  showToast('Bienvenue ' + (_loginRole === 'fondateur' ? CONFIG.fondateur.nom : CONFIG.econome.nom) + ' !');
}

function doLogout() {
  STATE.user = null;
  document.getElementById('app').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('login-pass').value = '';
}

function setupUI() {
  // Infos sidebar
  document.getElementById('school-name-display').textContent = CONFIG.nom_ecole;
  document.getElementById('user-avatar-sidebar').textContent = STATE.user === 'fondateur' ? '👑' : '💼';
  document.getElementById('user-name-sidebar').textContent =
    STATE.user === 'fondateur' ? CONFIG.fondateur.nom : CONFIG.econome.nom;
  document.getElementById('user-role-sidebar').textContent =
    STATE.user === 'fondateur' ? 'Fondateur' : 'Économe';

  // Masquer/afficher menus selon rôle
  const fondateurOnly = ['nav-config', 'nav-tarifs', 'nav-types-frais', 'nav-banque'];
  fondateurOnly.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      if (peutFaire('config')) {
        el.classList.remove('locked');
      } else {
        el.classList.add('locked');
      }
    }
  });

  // Section administration visible seulement pour fondateur
  const adminSection = document.getElementById('nav-section-fondateur');
  if (adminSection) adminSection.style.display = peutFaire('config') ? 'block' : 'none';

  updateCaisseBadge();
  updateRetardsBadge();
  populateNiveauxSelects();
}

// ==================== NAVIGATION ====================
function showPage(page) {
  // Vérifier droits
  if ((page === 'config' || page === 'parametres') && !peutFaire('config')) {
    showToast('Accès réservé au Fondateur', 'error'); return;
  }
  if (page === 'banque' && !peutFaire('banque')) {
    showToast('Accès réservé au Fondateur', 'error'); return;
  }
  if (page === 'tarifs' && !peutFaire('tarifs')) {
    showToast('Accès réservé au Fondateur', 'error'); return;
  }

  // Activer page et nav
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const pg = document.getElementById('page-' + page);
  if (pg) pg.classList.add('active');
  const nav = document.getElementById('nav-' + page);
  if (nav) nav.classList.add('active');

  // Initialiser selon la page
  if (page === 'eleves') { renderEleves(); return; }
  if (page === 'paiements') {
    renderPaiements(); updateCaisseBadge();
    const dp = document.getElementById('paiement-date'); if (dp) dp.value = today();
    return;
  }
  if (page === 'caisse') { renderCaisse(); updateCaisseBadge(); return; }
  if (page === 'rapports') { renderRapports(); return; }
  if (page === 'banque') { renderBanque(); return; }
  if (page === 'reductions') { renderReductions(); return; }
  if (page === 'tarifs') { renderTarifs(); return; }
  if (page === 'types-frais') { renderTypesFrais(); return; }
  if (page === 'depenses') { renderDepenses(); return; }
  if (page === 'retards') { renderRetards(); updateRetardsBadge(); return; }
  if (page === 'dashboard') { refreshDashboard(); return; }

  if (page === 'parametres') {
    renderParametres(); return;
  }

  if (page === 'bilan') {
    const t = today();
    const dd = document.getElementById('bilan-date-debut');
    const df = document.getElementById('bilan-date-fin');
    if (dd && !dd.value) dd.value = t;
    if (df && !df.value) df.value = t;
    renderBilan(); return;
  }

  if (page === 'butoir') {
    // Populer select niveaux
    const sel = document.getElementById('filter-retard-niveau2');
    if (sel) sel.innerHTML = '<option value="">Tous les niveaux</option>' +
      CONFIG.niveaux.map(n => '<option value="' + n + '">' + n + '</option>').join('');
    const db = document.getElementById('date-butoir');
    if (db && !db.value) db.value = today();
    renderRetardsButoir();
    const zone = document.getElementById('butoir-stats-zone');
    if (zone) zone.style.display = (db && db.value) ? 'block' : 'none';
    return;
  }
}

// ==================== CAISSE ====================
function updateCaisseBadge() {
  const badge = document.getElementById('caisse-badge');
  const txt = document.getElementById('caisse-status-text');
  if (!badge) return;
  if (STATE.caisse_ouverte) {
    badge.className = 'caisse-badge ouverte';
    txt.textContent = 'Caisse Ouverte';
  } else {
    badge.className = 'caisse-badge fermee';
    txt.textContent = 'Caisse Fermée';
  }
  const alertP = document.getElementById('caisse-fermee-alert');
  const formP = document.getElementById('paiement-form-zone');
  const alertC = document.getElementById('caisse-fermee-alert2');
  if (alertP) alertP.style.display = STATE.caisse_ouverte ? 'none' : 'flex';
  if (formP) formP.style.display = STATE.caisse_ouverte ? 'block' : 'none';
  if (alertC) alertC.style.display = STATE.caisse_ouverte ? 'none' : 'flex';
  const bE = document.getElementById('btn-caisse-entree');
  const bS = document.getElementById('btn-caisse-sortie');
  if (bE) bE.disabled = !STATE.caisse_ouverte;
  if (bS) bS.disabled = !STATE.caisse_ouverte;
}

function toggleCaisse() {
  if (!peutFaire('caisse_toggle') && !STATE.caisse_ouverte) {
    showToast('Seul le Fondateur peut ouvrir la caisse', 'error'); return;
  }
  const action = STATE.caisse_ouverte ? 'fermer' : 'ouvrir';
  if (!confirm('Voulez-vous ' + action + ' la caisse ?')) return;
  STATE.caisse_ouverte = !STATE.caisse_ouverte;
  updateCaisseBadge();
  showToast('Caisse ' + (STATE.caisse_ouverte ? 'ouverte' : 'fermée'),
    STATE.caisse_ouverte ? 'success' : 'warning');
  save();
}

// ==================== RETARDS BADGE ====================
function updateRetardsBadge() {
  const echInscr = STATE.types_frais.inscription_echeances || [];
  const echScol  = STATE.types_frais.scolarite_echeances   || [];
  const now = new Date();
  const todayStr = now.getFullYear() + '-' +
    String(now.getMonth() + 1).padStart(2, '0') + '-' +
    String(now.getDate()).padStart(2, '0');
  console.log('BADGE — date locale:', todayStr,
    '| echInscr:', echInscr.length, echInscr[0] ? echInscr[0].date : 'N/A',
    '| echScol:', echScol.length, echScol[0] ? echScol[0].date : 'N/A');
  const nb = getElevesEnRetard().length;
  console.log('BADGE — retards:', nb, '/ total eleves:', STATE.eleves.length);
  const badge = document.getElementById('badge-retards');
  if (badge) { badge.textContent = nb; badge.style.display = nb > 0 ? 'inline' : 'none'; }
}

// ==================== POPULATE SELECTS ====================
function populateNiveauxSelects() {
  ['eleve-niveau', 'filter-niveau', 'filter-retard-niveau'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const prefix = id === 'eleve-niveau'
      ? '<option value="">-- Sélectionner --</option>'
      : '<option value="">Tous les niveaux</option>';
    sel.innerHTML = prefix + CONFIG.niveaux.map(n =>
      '<option value="' + n + '">' + n + '</option>'
    ).join('');
  });
  // Select examen niveaux
  const selEx = document.getElementById('examen-niveau-select');
  if (selEx) selEx.innerHTML = '<option value="">-- Sélectionner --</option>' +
    CONFIG.niveaux.map(n => '<option value="' + n + '">' + n + '</option>').join('');
}


// ==================== DASHBOARD ====================
function refreshDashboard() {
  const totalPercu = calcTotalPercu();
  const totalAttenduAnnuel = calcTotalAttendu(); // total annuel (toutes échéances)
  const totalAttenduAujourd = STATE.eleves.reduce((s, e) => s + calcAttenduAujourdhui(e), 0);
  const totalAttendu = totalAttenduAnnuel; // on garde le total annuel pour "Reste à percevoir"
  const taux = totalAttenduAnnuel > 0 ? Math.round((totalPercu / totalAttenduAnnuel) * 100) : 0;
  const retards = getElevesEnRetard(); // basé sur échéances dépassées
  const totalDep = STATE.depenses.reduce((s, d) => s + Number(d.montant), 0);

  document.getElementById('stat-eleves').textContent = STATE.eleves.length;
  document.getElementById('stat-paiements').textContent = fmt(totalPercu);
  document.getElementById('stat-reste').textContent = fmt(Math.max(0, totalAttendu - totalPercu));
  document.getElementById('stat-retard').textContent = retards.length;
  const elRetardSubEl = document.getElementById('stat-retard-sub');
  if (elRetardSubEl) elRetardSubEl.textContent = 'Échéances dépassées';
  document.getElementById('stat-caisse').textContent = fmt(calcSoldeCaisse());
  document.getElementById('stat-banque').textContent = fmt(calcSoldeBanque());
  document.getElementById('stat-depenses').textContent = fmt(totalDep);
  document.getElementById('stat-taux').textContent = taux + '%';
  document.getElementById('stat-taux-sub').textContent =
    fmt(totalPercu) + ' / ' + fmt(totalAttendu);
  document.getElementById('dashboard-subtitle').textContent =
    CONFIG.nom_ecole + ' — Année ' + CONFIG.annee;

  const pr = document.getElementById('dash-progress');
  const tt = document.getElementById('dash-taux-txt');
  if (pr) {
    pr.style.width = Math.min(100, taux) + '%';
    pr.style.background = taux >= 80
      ? 'linear-gradient(90deg,var(--vert),var(--vert-c))'
      : taux >= 50
        ? 'linear-gradient(90deg,var(--orange),#fbbf24)'
        : 'linear-gradient(90deg,var(--rouge),#f87171)';
  }
  if (tt) tt.textContent = taux + '%';

  // Derniers paiements
  const derniersP = [...STATE.paiements].reverse().slice(0, 5);
  document.getElementById('dashboard-paiements').innerHTML = derniersP.length > 0
    ? derniersP.map(p => {
        const el = STATE.eleves.find(e => e.id === p.eleve_id);
        return '<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--gbg);">' +
          '<div><div style="font-weight:600;font-size:13px;">' + (el ? el.nomPrenoms || el.nom : '?') + '</div>' +
          '<div style="font-size:11px;color:var(--gc);">' + (p.type_frais || '') + ' • ' + fmtDate(p.date) + '</div></div>' +
          '<div style="font-weight:700;color:var(--vert);">' + fmt(p.montant) + '</div></div>';
      }).join('')
    : '<div class="empty-state"><div class="empty-icon">💳</div><p>Aucun paiement</p></div>';

  // Chart niveaux
  const chartData = CONFIG.niveaux.map(n => {
    const percu = STATE.paiements
      .filter(p => { const el = STATE.eleves.find(e => e.id === p.eleve_id); return el && el.niveau === n; })
      .reduce((s, p) => s + Number(p.montant), 0);
    return { n, percu };
  }).filter(x => x.percu > 0);
  const maxPercu = Math.max(...chartData.map(x => x.percu), 1);
  document.getElementById('dashboard-chart').innerHTML = chartData.length > 0
    ? '<div class="chart-bar-wrap">' + chartData.map(x =>
        '<div class="chart-bar-item">' +
        '<div class="chart-bar-label">' + x.n + '</div>' +
        '<div class="chart-bar-bg"><div class="chart-bar-fill" style="width:' +
        Math.round((x.percu / maxPercu) * 100) + '%;background:linear-gradient(90deg,var(--vert),var(--vert-c));"></div></div>' +
        '<div class="chart-bar-value">' + fmt(x.percu) + '</div></div>'
      ).join('') + '</div>'
    : '<div class="empty-state"><div class="empty-icon">📊</div><p>Aucune donnée</p></div>';

  // Alertes retards
  document.getElementById('dashboard-alertes').innerHTML = retards.length > 0
    ? retards.slice(0, 5).map(e => {
        const att = calcAttenduAujourdhui(e); // retard basé sur échéances dépassées
        const percu = calcPercuEleve(e.id);
        return '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--gbg);">' +
          '<div><div style="font-weight:600;font-size:13px;">' + (e.nomPrenoms || e.nom) + '</div>' +
          '<div style="font-size:11px;color:var(--gc);">' + e.niveau +
          ' • <span class="badge ' + (e.statut_sco === 'Affecté' ? 'badge-bleu' : 'badge-vert') + '">' +
          (e.statut_sco || 'Non Affecté') + '</span></div></div>' +
          '<span class="badge badge-rouge">' + fmt(att - percu) + '</span></div>';
      }).join('') +
      '<div style="margin-top:8px;"><button class="btn btn-danger btn-xs" onclick="showPage(\'retards\')">Voir tous →</button></div>'
    : '<div class="empty-state"><div class="empty-icon">✅</div><p>Aucune alerte</p></div>';

  // Dernières dépenses
  const derDep = [...STATE.depenses].reverse().slice(0, 4);
  document.getElementById('dashboard-depenses').innerHTML = derDep.length > 0
    ? derDep.map(d =>
        '<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--gbg);">' +
        '<div><div style="font-weight:600;font-size:13px;">' + d.libelle + '</div>' +
        '<div style="font-size:11px;color:var(--gc);">' + (d.categorie || '') + ' • ' + fmtDate(d.date) + '</div></div>' +
        '<div style="font-weight:700;color:var(--rouge);">' + fmt(d.montant) + '</div></div>'
      ).join('')
    : '<div class="empty-state"><div class="empty-icon">📤</div><p>Aucune dépense</p></div>';

  updateRetardsBadge();
}

// ==================== ÉLÈVES ====================
function openModalEleve(id = null) {
  // D'abord populer les selects (niveaux doivent exister avant d'y assigner une valeur)
  populateNiveauxSelects();

  ['eleve-nom','eleve-matricule','eleve-tel','eleve-parent','eleve-tel-parent','eleve-adresse','eleve-lieu-naissance'].forEach(f => {
    const el = document.getElementById(f); if (el) el.value = '';
  });
  document.getElementById('eleve-statut').value = 'Actif';
  document.getElementById('eleve-statut-sco').value = 'Non Affecté';
  document.getElementById('eleve-qualite').value = 'Non Redoublant';
  document.getElementById('eleve-regime').value = 'Non Boursier';
  document.getElementById('eleve-sexe').value = 'M';
  document.getElementById('eleve-naissance').value = '';
  document.getElementById('eleve-ancienne-dette').value = '0';
  document.getElementById('eleve-annee').value = CONFIG.annee;
  document.getElementById('photo-preview').src = '';
  document.getElementById('photo-preview').style.display = 'none';
  document.getElementById('photo-placeholder').style.display = 'flex';
  document.getElementById('photo-zone').classList.remove('has-photo');
  STATE._editId = null;
  STATE._photoData = null;
  document.getElementById('modal-eleve-title').textContent = '➕ Nouvel élève';

  if (id) {
    const el = STATE.eleves.find(e => e.id === id);
    if (el) {
      STATE._editId = id;
      document.getElementById('modal-eleve-title').textContent = '✏️ Modifier l\'élève';
      document.getElementById('eleve-nom').value = el.nomPrenoms || el.nom || '';
      document.getElementById('eleve-matricule').value = el.matricule || '';

      // Niveau (6eme) pour le select — classe détaillée (6eme6) pour le champ texte
      const niveauPourSelect = el.niveau || '';
      document.getElementById('eleve-niveau').value = niveauPourSelect;
      // Classe détaillée : si différente du niveau, l'afficher
      const cdEl = document.getElementById('eleve-classe-detail');
      if (cdEl) cdEl.value = (el.classe && el.classe !== el.niveau) ? el.classe : '';

      // Sexe : normaliser "Feminin"→"F", "Masculin"→"M", "F"/"M" direct
      const sexeRaw = (el.sexe || 'M').toLowerCase();
      document.getElementById('eleve-sexe').value = (sexeRaw === 'f' || sexeRaw.startsWith('fem')) ? 'F' : 'M';

      document.getElementById('eleve-naissance').value = toDateInput(el.naissance) || '';
      document.getElementById('eleve-lieu-naissance').value = el.lieu_naissance || '';
      document.getElementById('eleve-statut').value = el.statut || 'Actif';
      document.getElementById('eleve-statut-sco').value = el.statut_sco || 'Non Affecté';
      document.getElementById('eleve-qualite').value = el.qualite || 'Non Redoublant';
      document.getElementById('eleve-regime').value = el.regime || 'Non Boursier';
      document.getElementById('eleve-tel').value = el.telephone || el.tel || '';
      document.getElementById('eleve-parent').value = el.parent || '';
      document.getElementById('eleve-tel-parent').value = el.tel_parent || '';
      document.getElementById('eleve-adresse').value = el.adresse || '';
      document.getElementById('eleve-ancienne-dette').value = el.ancienne_dette || 0;
      document.getElementById('eleve-annee').value = el.annee_scolaire || CONFIG.annee;
      if (el.photo) {
        document.getElementById('photo-preview').src = el.photo;
        document.getElementById('photo-preview').style.display = 'block';
        document.getElementById('photo-placeholder').style.display = 'none';
        document.getElementById('photo-zone').classList.add('has-photo');
        STATE._photoData = el.photo;
      }
    }
  }
  openModal('modal-eleve');
}

function previewPhoto(event) {
  const file = event.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = async e => {
    const compressed = await compressPhoto(e.target.result, 400);
    document.getElementById('photo-preview').src = compressed;
    document.getElementById('photo-preview').style.display = 'block';
    document.getElementById('photo-placeholder').style.display = 'none';
    document.getElementById('photo-zone').classList.add('has-photo');
    STATE._photoData = compressed;
  };
  reader.readAsDataURL(file);
}

async function compressPhoto(base64, maxSize = 300) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      let w = img.width, h = img.height;
      if (w > h) { if (w > maxSize) { h = Math.round(h * maxSize / w); w = maxSize; } }
      else { if (h > maxSize) { w = Math.round(w * maxSize / h); h = maxSize; } }
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.75));
    };
    img.onerror = () => resolve(base64);
    img.src = base64;
  });
}

async function sauvegarderEleve() {
  const nom = document.getElementById('eleve-nom').value.trim();
  const niveau = document.getElementById('eleve-niveau').value;
  if (!nom) { showToast('Le nom est obligatoire', 'error'); return; }
  if (!niveau) { showToast('Sélectionnez le niveau', 'error'); return; }
  if (!STATE._photoData && !STATE._editId) { showToast('La photo est obligatoire', 'error'); return; }

  const matricule = document.getElementById('eleve-matricule').value.trim() || genMatricule();
  // classe détaillée : si renseignée utiliser, sinon = niveau
  const classeDetail = (document.getElementById('eleve-classe-detail')?.value.trim()) || niveau;

  const data = {
    matricule, nomPrenoms: nom, nom,
    niveau,                   // 6eme — pour les tarifs et filtres
    classe: classeDetail,     // 6eme6 — pour l'affichage
    sexe: document.getElementById('eleve-sexe').value,
    naissance: document.getElementById('eleve-naissance').value,
    lieu_naissance: document.getElementById('eleve-lieu-naissance').value,
    statut: document.getElementById('eleve-statut').value || 'Actif',
    statut_sco: document.getElementById('eleve-statut-sco').value || 'Non Affecté',
    qualite: document.getElementById('eleve-qualite').value || 'Non Redoublant',
    regime: document.getElementById('eleve-regime').value || 'Non Boursier',
    telephone: document.getElementById('eleve-tel').value,
    tel: document.getElementById('eleve-tel').value,
    parent: document.getElementById('eleve-parent').value,
    tel_parent: document.getElementById('eleve-tel-parent').value,
    adresse: document.getElementById('eleve-adresse').value,
    ancienne_dette: Number(document.getElementById('eleve-ancienne-dette').value) || 0,
    annee_scolaire: document.getElementById('eleve-annee').value || CONFIG.annee,
    etablissement: CONFIG.nom_ecole,
    photo: STATE._photoData || ''
  };

  if (STATE._editId) {
    const idx = STATE.eleves.findIndex(e => e.id === STATE._editId);
    if (idx >= 0) STATE.eleves[idx] = {
      ...STATE.eleves[idx], ...data,
      photo: STATE._photoData || STATE.eleves[idx].photo
    };
  } else {
    STATE.eleves.push({ id: genId(), ...data, date_inscription: today() });
  }

  closeModal('modal-eleve');
  renderEleves();
  save();
  showToast('Élève sauvegardé ✅');
  updateRetardsBadge();
  // Sync silencieuse
  setTimeout(() => autoSync(), 800);
}

function renderEleves() {
  const q = (document.getElementById('search-eleves')?.value || '').toLowerCase();
  const nf = document.getElementById('filter-niveau')?.value || '';
  const sf = document.getElementById('filter-statut-eleve')?.value || '';

  let eleves = STATE.eleves.filter(e => {
    const matchQ = !q || ((e.nomPrenoms || e.nom || '') + ' ' + (e.classe || '') + ' ' + (e.niveau || '') + ' ' + (e.matricule || '')).toLowerCase().includes(q);
    const matchN = !nf || e.niveau === nf;
    if (sf) {
      const att = calcAttenduAujourdhui(e); // retard basé sur échéances dépassées
      const percu = calcPercuEleve(e.id);
      if (sf === 'a_jour' && percu < att) return false;
      if (sf === 'en_retard' && percu >= att) return false;
    }
    return matchQ && matchN;
  });

  document.getElementById('eleves-count').textContent = eleves.length + ' élève(s)';
  const tbody = document.getElementById('tbody-eleves');
  if (!eleves.length) {
    tbody.innerHTML = '<tr><td colspan="9"><div class="empty-state"><div class="empty-icon">👨‍🎓</div><p>Aucun élève</p></div></td></tr>';
    return;
  }

  tbody.innerHTML = eleves.map(e => {
    const att = calcAttenduAujourdhui(e); // retard basé sur échéances dépassées
    const percu = calcPercuEleve(e.id);
    const pct = att > 0 ? Math.round((percu / att) * 100) : 0;
    const statBadge = percu >= att && att > 0 ? 'badge-vert' : (percu > 0 ? 'badge-orange' : 'badge-rouge');
    const statTxt = percu >= att && att > 0 ? 'À jour' : (percu > 0 ? 'Partiel' : 'En attente');
    const canEdit = peutFaire('eleves_modifier');
    const canDel = peutFaire('eleves_supprimer');
    return '<tr>' +
      '<td>' + (e.photo
        ? '<img src="' + e.photo + '" style="width:48px;height:48px;border-radius:6px;object-fit:cover;border:2px solid var(--gb);">'
        : '<div style="width:48px;height:48px;border-radius:6px;background:var(--vert-p);display:flex;align-items:center;justify-content:center;font-size:20px;">👤</div>') + '</td>' +
      '<td><code style="font-size:12px;background:var(--gbg);padding:2px 6px;border-radius:4px;">' + (e.matricule || '-') + '</code></td>' +
      '<td><strong>' + (e.nomPrenoms || e.nom || '—') + '</strong></td>' +
      '<td><span class="badge badge-bleu">' + e.niveau + '</span>' +
      (e.classe && e.classe !== e.niveau ? '<br><span style="font-size:10px;color:var(--gc);">' + e.classe + '</span>' : '') + '</td>' +
      '<td><span class="badge ' + (e.statut_sco === 'Affecté' ? 'badge-bleu' : 'badge-vert') + '">' + (e.statut_sco || 'Non Aff.') + '</span></td>' +
      '<td>' + (e.telephone || e.tel || '-') + '</td>' +
      '<td><span class="badge ' + statBadge + '">' + statTxt + '</span></td>' +
      '<td><div style="font-size:12px;font-weight:600;color:var(--vert);">' + fmt(percu) + '</div>' +
      '<div style="font-size:10px;color:var(--gc);">' + pct + '% payé</div></td>' +
      '<td style="white-space:nowrap;">' +
      (canEdit ? '<button class="btn btn-secondary btn-xs" onclick="openModalEleve(\'' + e.id + '\')">✏️</button> ' : '') +
      '<button class="btn btn-bleu btn-xs" onclick="voirFicheEleve(\'' + e.id + '\')">👁️</button> ' +
      (canDel ? '<button class="btn btn-danger btn-xs" onclick="supprimerEleve(\'' + e.id + '\')">🗑️</button>' : '') +
      '</td></tr>';
  }).join('');
}

function filterEleves() { renderEleves(); }

function supprimerEleve(id) {
  if (!exigeRole('eleves_supprimer')) return;
  if (!confirm('Supprimer cet élève ? (irréversible)')) return;
  STATE.eleves = STATE.eleves.filter(e => e.id !== id);
  STATE.paiements = STATE.paiements.filter(p => p.eleve_id !== id);
  STATE.reductions = STATE.reductions.filter(r => r.eleve_id !== id);
  renderEleves(); save();
  showToast('Élève supprimé', 'warning');
  updateRetardsBadge();
}


// ==================== RÉDUCTIONS (avec workflow approbation) ====================
function openModalReduction(eleveId = null) {
  document.getElementById('red-search-eleve').value = '';
  document.getElementById('red-eleve-selected').style.display = 'none';
  document.getElementById('red-eleve-results').style.display = 'none';
  document.getElementById('red-pourcentage').value = '';
  document.getElementById('red-motif').value = '';
  document.getElementById('red-organisme').value = '';
  STATE._redEleveId = eleveId;
  if (eleveId) {
    const el = STATE.eleves.find(e => e.id === eleveId);
    if (el) {
      document.getElementById('red-eleve-selected').style.display = 'block';
      document.getElementById('red-eleve-selected').innerHTML =
        '✅ <strong>' + (el.nomPrenoms || el.nom) + '</strong> — ' + el.niveau + ' — ' + el.matricule;
    }
  }
  openModal('modal-reduction');
}

function searchEleveReduction() {
  const q = document.getElementById('red-search-eleve').value.toLowerCase();
  const results = STATE.eleves.filter(e =>
    ((e.nomPrenoms || e.nom || '').toLowerCase().includes(q) || (e.matricule || '').toLowerCase().includes(q))
  ).slice(0, 5);
  const div = document.getElementById('red-eleve-results');
  if (!q || !results.length) { div.style.display = 'none'; return; }
  div.style.display = 'block';
  div.innerHTML = results.map(e =>
    '<div onclick="selectEleveReduction(\'' + e.id + '\')" style="padding:10px 14px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--gb);" onmouseover="this.style.background=\'var(--gbg)\'" onmouseout="this.style.background=\'\'">' +
    '<strong>' + (e.nomPrenoms || e.nom) + '</strong> <span style="color:var(--gc);">— ' + (e.classe || e.niveau || '') + ' — ' + e.matricule + '</span></div>'
  ).join('');
}

function selectEleveReduction(id) {
  STATE._redEleveId = id;
  const el = STATE.eleves.find(e => e.id === id);
  document.getElementById('red-search-eleve').value = '';
  document.getElementById('red-eleve-results').style.display = 'none';
  const sel = document.getElementById('red-eleve-selected');
  sel.style.display = 'block';
  sel.innerHTML = '✅ <strong>' + (el.nomPrenoms || el.nom) + '</strong> — ' + el.niveau + ' — ' + el.matricule;
}

function demanderReduction() {
  if (!STATE._redEleveId) { showToast('Sélectionnez un élève', 'error'); return; }
  const pct = Number(document.getElementById('red-pourcentage').value);
  if (!pct || pct <= 0 || pct > 100) { showToast('Pourcentage invalide (1-100)', 'error'); return; }
  const motif = document.getElementById('red-motif').value.trim();
  if (!motif) { showToast('Le motif est obligatoire', 'error'); return; }

  // Vérifier si réduction existante
  const existing = STATE.reductions.findIndex(r => r.eleve_id === STATE._redEleveId);
  const red = {
    id: existing >= 0 ? STATE.reductions[existing].id : genId(),
    eleve_id: STATE._redEleveId,
    pourcentage: pct,
    motif,
    organisme: document.getElementById('red-organisme').value.trim(),
    date_demande: today(),
    annee_scolaire: CONFIG.annee,
    // Fondateur approuve directement, économe attend
    statut: peutFaire('reductions_approuver') ? 'approuvee' : 'en_attente',
    date_approbation: peutFaire('reductions_approuver') ? today() : null,
    approuve_par: peutFaire('reductions_approuver') ? CONFIG.fondateur.nom : null
  };

  if (existing >= 0) STATE.reductions[existing] = red;
  else STATE.reductions.push(red);

  closeModal('modal-reduction');
  renderReductions();
  save();
  updateRetardsBadge();

  if (peutFaire('reductions_approuver')) {
    showToast('Réduction de ' + pct + '% accordée et approuvée ✅');
  } else {
    showToast('Demande envoyée — En attente d\'approbation du Fondateur', 'info');
  }
  setTimeout(() => autoSync(), 500);
}

function approuverReduction(id) {
  if (!exigeRole('reductions_approuver')) return;
  const red = STATE.reductions.find(r => r.id === id);
  if (!red) return;
  red.statut = 'approuvee';
  red.date_approbation = today();
  red.approuve_par = CONFIG.fondateur.nom;
  renderReductions();
  save();
  updateRetardsBadge();
  showToast('Réduction approuvée ✅');
  setTimeout(() => autoSync(), 500);
}

function refuserReduction(id) {
  if (!exigeRole('reductions_approuver')) return;
  if (!confirm('Refuser cette demande de réduction ?')) return;
  STATE.reductions = STATE.reductions.filter(r => r.id !== id);
  renderReductions();
  save();
  showToast('Demande refusée', 'warning');
}

function supprimerReduction(id) {
  if (!exigeRole('reductions_approuver')) return;
  if (!confirm('Supprimer cette réduction ?')) return;
  STATE.reductions = STATE.reductions.filter(r => r.id !== id);
  renderReductions();
  save();
  updateRetardsBadge();
  showToast('Réduction supprimée', 'warning');
}

function renderReductions() {
  const tbody = document.getElementById('tbody-reductions');
  if (!STATE.reductions.length) {
    tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state"><p>Aucune réduction</p></div></td></tr>';
    return;
  }
  const canApprove = peutFaire('reductions_approuver');
  tbody.innerHTML = STATE.reductions.map(r => {
    const el = STATE.eleves.find(e => e.id === r.eleve_id);
    const t = STATE.tarifs[el?.niveau] || {};
    const scol = Number(t.scolarite || 0);
    const remise = Math.round(scol * r.pourcentage / 100);
    const nouvelleScol = scol - remise;
    const statusBadge = r.statut === 'approuvee'
      ? '<span class="badge badge-vert">✅ Approuvée</span>'
      : '<span class="badge badge-orange">⏳ En attente</span>';
    const actions = r.statut === 'en_attente' && canApprove
      ? '<button class="btn btn-vert btn-xs" onclick="approuverReduction(\'' + r.id + '\')">✅ Approuver</button> ' +
        '<button class="btn btn-danger btn-xs" onclick="refuserReduction(\'' + r.id + '\')">❌ Refuser</button>'
      : canApprove
        ? '<button class="btn btn-danger btn-xs" onclick="supprimerReduction(\'' + r.id + '\')">🗑️</button>'
        : '—';
    return '<tr>' +
      '<td><strong>' + (el ? el.nomPrenoms || el.nom : '?') + '</strong></td>' +
      '<td><span class="badge badge-bleu">' + (el ? el.niveau : '-') + '</span></td>' +
      '<td><span class="badge ' + (el?.statut_sco === 'Affecté' ? 'badge-bleu' : 'badge-vert') + '">' + (el?.statut_sco || '-') + '</span></td>' +
      '<td><strong>' + r.pourcentage + '%</strong></td>' +
      '<td><span style="color:var(--rouge);font-weight:700;">−' + fmt(remise) + '</span></td>' +
      '<td>' + fmt(nouvelleScol) + ' <small style="color:var(--gc);">(au lieu de ' + fmt(scol) + ')</small></td>' +
      '<td>' + r.motif + (r.organisme ? ' <span class="badge badge-gris">' + r.organisme + '</span>' : '') + '</td>' +
      '<td>' + statusBadge + '</td>' +
      '<td>' + actions + '</td></tr>';
  }).join('');
}

// ==================== PAIEMENTS ====================
function searchElevePaiement() {
  const q = document.getElementById('paiement-search-eleve').value.toLowerCase();
  if (!q) { document.getElementById('paiement-eleve-results').style.display = 'none'; return; }
  const results = STATE.eleves.filter(e =>
    ((e.nomPrenoms || e.nom || '').toLowerCase().includes(q) || (e.matricule || '').toLowerCase().includes(q))
  ).slice(0, 6);
  const div = document.getElementById('paiement-eleve-results');
  if (!results.length) { div.style.display = 'none'; return; }
  div.style.display = 'block';
  div.innerHTML = results.map(e =>
    '<div onclick="selectElevePaiement(\'' + e.id + '\')" style="display:flex;align-items:center;gap:10px;padding:10px 14px;cursor:pointer;border-bottom:1px solid var(--gb);" onmouseover="this.style.background=\'var(--gbg)\'" onmouseout="this.style.background=\'\'">' +
    (e.photo ? '<img src="' + e.photo + '" style="width:32px;height:32px;border-radius:50%;object-fit:cover;">'
      : '<div style="width:32px;height:32px;border-radius:50%;background:var(--vert-p);display:flex;align-items:center;justify-content:center;">👤</div>') +
    '<div><div style="font-weight:600;font-size:13px;">' + (e.nomPrenoms || e.nom) + '</div>' +
    '<div style="font-size:11px;color:var(--gc);">' + (e.classe || e.niveau || '') + ' — ' + e.matricule + '</div></div></div>'
  ).join('');
}

async function selectElevePaiement(id) {
  const el = STATE.eleves.find(e => e.id === id); if (!el) return;
  STATE._paiement.eleve = el;
  document.getElementById('paiement-search-eleve').value = '';
  document.getElementById('paiement-eleve-results').style.display = 'none';
  document.getElementById('paiement-eleve-selected').style.display = 'block';
  document.getElementById('paiement-eleve-photo').src = el.photo || '';
  document.getElementById('paiement-eleve-nom').textContent = el.nomPrenoms || el.nom;
  document.getElementById('paiement-eleve-info').textContent = (el.classe || el.niveau || '') + ' — ' + el.matricule +
    ' — ' + (el.statut_sco || 'Non Affecté');
  const att = calcAttenduEleve(el);
  const percu = calcPercuEleve(el.id);
  const reste = Math.max(0, att - percu);
  document.getElementById('paiement-eleve-solde').textContent =
    reste > 0 ? '⚠️ Reste à payer: ' + fmt(reste) : '✅ À jour';
  updateEcheancePaiementSelect(document.getElementById('paiement-type-frais').value);

  // Vérifier si l'élève a un crédit ou une dette reportée de l'année précédente
  const report = await verifierReportEleve(el.matricule);
  if (report && report.solde_reporte !== 0 && STATE.user === 'fondateur') {
    const typeReport = report.solde_reporte > 0 ? 'CRÉDIT' : 'DETTE';
    const montantAbs = Math.abs(report.solde_reporte);
    const msg = '📋 Report année ' + report.annee + ' détecté pour ' + el.nomPrenoms + '\n\n' +
      typeReport + ' reporté : ' + fmt(montantAbs) + '\n\n' +
      (report.solde_reporte > 0
        ? 'Voulez-vous appliquer ce crédit sur la scolarité de cette année ?\n(Le montant sera déduit du reste à payer)'
        : 'Cet élève avait une dette de ' + fmt(montantAbs) + '.\nVoulez-vous l\'ajouter au montant dû cette année ?');
    const ok = confirm(msg);
    if (ok) {
      // Appliquer le report comme paiement (crédit) ou ajustement (dette)
      STATE._paiement.report = { montant: report.solde_reporte, annee: report.annee };
      const soldeEl = document.getElementById('paiement-eleve-solde');
      if (soldeEl) {
        const nouveauReste = reste - report.solde_reporte;
        soldeEl.textContent = report.solde_reporte > 0
          ? '🎁 Crédit ' + report.annee + ': -' + fmt(montantAbs) + ' → Nouveau reste: ' + fmt(Math.max(0, nouveauReste))
          : '⚠️ Dette ' + report.annee + ': +' + fmt(montantAbs) + ' → Reste: ' + fmt(Math.max(0, nouveauReste));
      }
      showToast((report.solde_reporte > 0 ? '✅ Crédit' : '⚠️ Dette') + ' de ' + fmt(montantAbs) + ' pris en compte', 'success');
    }
  }
}

function clearElevePaiement() {
  STATE._paiement.eleve = null;
  document.getElementById('paiement-eleve-selected').style.display = 'none';
  document.getElementById('paiement-search-eleve').value = '';
}

function onTypeFraisChange() {
  updateEcheancePaiementSelect(document.getElementById('paiement-type-frais').value);
}

function updateEcheancePaiementSelect(type) {
  const sel = document.getElementById('paiement-echeance');
  const field = document.getElementById('echeance-field');
  if (!sel) return;
  if (!type || type === 'examen' || type === 'annexe') {
    sel.innerHTML = '<option value="">— Sans échéance —</option>';
    if (field) field.style.display = (type === 'examen' || type === 'annexe') ? 'none' : '';
    return;
  }
  if (field) field.style.display = '';
  const echeances = type === 'inscription'
    ? STATE.types_frais.inscription_echeances
    : STATE.types_frais.scolarite_echeances;
  sel.innerHTML = '<option value="">-- Sélectionner --</option>' +
    (echeances.length
      ? echeances.map(e => '<option value="' + e.id + '">' + e.nom + (e.date ? ' (' + fmtDate(e.date) + ')' : '') + '</option>').join('')
      : '<option value="">Aucune échéance configurée</option>');
}

function enregistrerPaiement() {
  if (!STATE.caisse_ouverte) { showToast('Caisse fermée', 'error'); return; }
  const el = STATE._paiement.eleve;
  if (!el) { showToast('Sélectionnez un élève', 'error'); return; }
  const montant = Number(document.getElementById('paiement-montant').value);
  if (!montant || montant <= 0) { showToast('Montant invalide', 'error'); return; }
  const typeFrais = document.getElementById('paiement-type-frais').value;
  if (!typeFrais) { showToast('Sélectionnez le type de frais', 'error'); return; }

  const paiement = {
    id: genId(),
    eleve_id: el.id,
    type_frais: typeFrais,
    echeance_id: document.getElementById('paiement-echeance').value,
    montant,
    mode: document.getElementById('paiement-mode').value,
    obs: document.getElementById('paiement-obs').value,
    date: document.getElementById('paiement-date').value || new Date().toISOString(),
    numero_recu: 'REC-' + Date.now().toString(36).toUpperCase(),
    agent: STATE.user
  };

  STATE.paiements.push(paiement);
  // Mouvement caisse automatique
  const solde = calcSoldeCaisse();
  STATE.caisse.push({
    id: genId(), type: 'entree',
    libelle: 'Paiement ' + (el.nomPrenoms || el.nom) + ' — ' + typeFrais,
    montant, categorie: 'paiement_eleve',
    date: paiement.date, solde_apres: solde + montant
  });

  save(); renderPaiements(); refreshDashboard(); clearElevePaiement();
  document.getElementById('paiement-montant').value = '';
  document.getElementById('paiement-obs').value = '';
  document.getElementById('paiement-date').value = today();
  showToast('Paiement enregistré ✅');
  STATE._paiement.data = paiement; STATE._paiement.eleve_data = el;
  // Afficher zone succès avec boutons Reçu + SMS
  const zone = document.getElementById('paiement-success-zone');
  const msg = document.getElementById('success-msg');
  const detail = document.getElementById('success-detail');
  if (zone) zone.style.display = 'block';
  if (msg) msg.textContent = 'Paiement de ' + fmt(paiement.montant) + ' enregistré';
  if (detail) detail.textContent = (el.nomPrenoms || el.nom) + ' — ' + (paiement.type_frais || '') + ' — Reçu: ' + (paiement.numero_recu || '');
  setTimeout(() => autoSync(), 500);
}

function renderPaiements() {
  const typef = document.getElementById('filter-paiement-type')?.value || '';
  const modef = document.getElementById('filter-paiement-mode')?.value || '';
  const paiements = [...STATE.paiements].reverse().filter(p => {
    if (typef && p.type_frais !== typef) return false;
    if (modef && p.mode !== modef) return false;
    return true;
  });
  const tbody = document.getElementById('tbody-paiements');
  if (!paiements.length) {
    tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state"><p>Aucun paiement</p></div></td></tr>';
    return;
  }
  const canDel = peutFaire('paiements_supprimer');
  tbody.innerHTML = paiements.map(p => {
    const el = STATE.eleves.find(e => e.id === p.eleve_id);
    let echNom = '-';
    if (p.echeance_id) {
      const ech = [...(STATE.types_frais.inscription_echeances || []), ...(STATE.types_frais.scolarite_echeances || [])].find(x => x.id === p.echeance_id);
      if (ech) echNom = ech.nom;
    } else if (p.type_frais === 'examen' || p.type_frais === 'annexe') echNom = 'Unique';
    return '<tr>' +
      '<td>' + fmtDate(p.date) + '</td>' +
      '<td><strong>' + (el ? el.nomPrenoms || el.nom : '?') + '</strong></td>' +
      '<td><span class="badge badge-bleu">' + (el ? el.niveau : '-') + '</span></td>' +
      '<td><span class="badge badge-gris">' + (p.type_frais || '-') + '</span></td>' +
      '<td>' + echNom + '</td>' +
      '<td><strong style="color:var(--vert);">' + fmt(p.montant) + '</strong></td>' +
      '<td><span class="badge badge-violet">' + (p.mode || '-') + '</span></td>' +
      '<td>' +
      '<button class="btn btn-secondary btn-xs" onclick="afficherRecuId(\'' + p.id + '\')">🧾</button> ' +
      (canDel ? '<button class="btn btn-danger btn-xs" onclick="supprimerPaiement(\'' + p.id + '\')">🗑️</button>' : '') +
      '</td></tr>';
  }).join('');
}

async function supprimerPaiement(id) {
  if (!exigeRole('paiements_supprimer')) return;
  if (!confirm('Supprimer ce paiement ?')) return;
  // 1. Retirer de la caisse locale
  const p = STATE.paiements.find(x => x.id === id);
  if (p) STATE.caisse = STATE.caisse.filter(c =>
    !(c.type === 'entree' && c.montant === p.montant && c.categorie === 'paiement_eleve'));
  // 2. Retirer localement
  STATE.paiements = STATE.paiements.filter(x => x.id !== id);
  renderPaiements(); refreshDashboard(); updateRetardsBadge(); save();
  showToast('Paiement supprimé', 'warning');
  // 3. Supprimer dans Supabase (permanent)
  try {
    await SB.delete('paiements', '?id=eq.' + id);
    // journal_caisse : supprimer la ligne dont le libelle contient le numéro de reçu
    if (p && p.numero_recu) {
      await SB.delete('journal_caisse', '?libelle=like.*' + encodeURIComponent(p.numero_recu) + '*&etablissement=eq.' + encodeURIComponent(CONFIG.nom_ecole));
    }
  } catch(e) {
    console.warn('Erreur suppression Supabase:', e.message);
    // Suppression locale déjà faite — l'erreur journal_caisse est non bloquante
  }
}

function afficherRecuId(id) {
  const p = STATE.paiements.find(x => x.id === id); if (!p) return;
  const el = STATE.eleves.find(e => e.id === p.eleve_id);
  afficherRecu(p, el);
}

function afficherRecu(paiement, eleve) {
  STATE._paiement.data = paiement; STATE._paiement.eleve_data = eleve;
  let echNom = '-';
  if (paiement.echeance_id) {
    const ech = [...(STATE.types_frais.inscription_echeances || []), ...(STATE.types_frais.scolarite_echeances || [])].find(x => x.id === paiement.echeance_id);
    if (ech) echNom = ech.nom + (ech.date ? ' (' + fmtDate(ech.date) + ')' : '');
  } else if (paiement.type_frais === 'examen' || paiement.type_frais === 'annexe') echNom = 'Paiement unique';

  const labels = { inscription: "Droit d'inscription", scolarite: 'Scolarité', examen: 'Frais Examen', annexe: 'Frais Annexe' };
  const modeLabel = { especes: '💵 Espèces', mobile_money: '📱 Mobile Money', cheque: '🏦 Chèque', virement: '🔁 Virement' };

  // Logo établissement depuis localStorage
  const logoData = localStorage.getItem('logo_' + CONFIG.code_ecole);
  const logoHtml = logoData
    ? '<img src="' + logoData + '" style="width:70px;height:70px;object-fit:contain;margin:0 auto 8px;display:block;">'
    : '<div style="font-size:40px;margin-bottom:8px;">🏫</div>';

  // Photo élève — affichée en haut à droite du reçu
  const photoHtml = (eleve && eleve.photo)
    ? '<img src="' + eleve.photo + '" style="position:absolute;top:0;right:0;width:64px;height:64px;object-fit:cover;border-radius:8px;border:2px solid var(--gb, #e2e8f0);">'
    : '<div style="position:absolute;top:0;right:0;width:64px;height:64px;border-radius:8px;background:var(--vert-p, #f1f5f9);display:flex;align-items:center;justify-content:center;font-size:26px;border:2px solid var(--gb, #e2e8f0);">👤</div>';

  document.getElementById('recu-content').innerHTML =
    '<div class="recu-header" style="position:relative;">' +
    photoHtml +
    logoHtml +
    '<div style="font-size:20px;font-weight:800;color:var(--gf);margin-bottom:4px;">' + CONFIG.nom_ecole + '</div>' +
    '<div style="font-size:12px;color:var(--gc);">' + (CONFIG.adresse || '') + (CONFIG.ville ? ' — ' + CONFIG.ville : '') + '</div>' +
    '<div style="font-size:12px;color:var(--gc);">Tél: ' + (CONFIG.tel || '-') + ' | Année: ' + CONFIG.annee + '</div>' +
    '<div style="margin-top:16px;display:inline-block;background:var(--gf);color:white;padding:6px 20px;border-radius:6px;font-size:14px;font-weight:700;">REÇU DE PAIEMENT</div>' +
    '<div style="font-size:12px;color:var(--gc);margin-top:6px;">N° ' + paiement.numero_recu + '</div></div>' +
    '<div class="recu-row"><span style="color:var(--gc);font-weight:600;">Date :</span><span style="font-weight:700;">' + fmtDate(paiement.date) + '</span></div>' +
    '<div class="recu-row"><span style="color:var(--gc);font-weight:600;">Élève :</span><span style="font-weight:700;">' + (eleve ? eleve.nomPrenoms || eleve.nom : '?') + '</span></div>' +
    '<div class="recu-row"><span style="color:var(--gc);font-weight:600;">Matricule :</span><span>' + (eleve?.matricule || '-') + '</span></div>' +
    '<div class="recu-row"><span style="color:var(--gc);font-weight:600;">Classe :</span><span><strong>' + (eleve ? eleve.classe || eleve.niveau : '-') + '</strong></span></div>' +
    '<div class="recu-row"><span style="color:var(--gc);font-weight:600;">Statut :</span><span>' + (eleve?.statut_sco || '-') + '</span></div>' +
    '<div class="recu-row"><span style="color:var(--gc);font-weight:600;">Type de frais :</span><span>' + (labels[paiement.type_frais] || paiement.type_frais || '-') + '</span></div>' +
    '<div class="recu-row"><span style="color:var(--gc);font-weight:600;">Échéance :</span><span>' + echNom + '</span></div>' +
    '<div class="recu-row"><span style="color:var(--gc);font-weight:600;">Mode :</span><span>' + (modeLabel[paiement.mode] || paiement.mode || '-') + '</span></div>' +
    (paiement.obs ? '<div class="recu-row"><span style="color:var(--gc);font-weight:600;">Observation :</span><span>' + paiement.obs + '</span></div>' : '') +
    '<div class="recu-total"><div style="display:flex;justify-content:space-between;align-items:center;"><span>MONTANT PAYÉ</span><span style="font-size:20px;">' + fmt(paiement.montant) + '</span></div></div>' +
    '<div class="recu-signatures">' +
    '<div class="recu-sig-box"><div style="font-weight:600;color:var(--gm);margin-bottom:30px;">L\'Économe</div><div>Signature & Cachet</div></div>' +
    '<div class="recu-sig-box"><div style="font-weight:600;color:var(--gm);margin-bottom:30px;">Le Fondateur</div><div>Signature & Cachet</div></div></div>' +
    '<div class="recu-watermark">' + CONFIG.nom_ecole + ' — EconoSchool Pro — Ce reçu tient lieu de preuve de paiement</div>';
  openModal('modal-recu');
}

function imprimerRecu() {
  const content = document.getElementById('recu-content').innerHTML;
  const logoData = localStorage.getItem('logo_' + CONFIG.code_ecole) || '';
  const win = window.open('', '_blank', 'width=600,height=800');
  win.document.write(`<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <title>Reçu — ${CONFIG.nom_ecole}</title>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'DM Sans',sans-serif;background:white;color:#0f172a;padding:24px}
    .recu-header{text-align:center;padding-bottom:20px;margin-bottom:20px;border-bottom:2px dashed #e2e8f0}
    .recu-row{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #f8fafc;font-size:13px}
    .recu-row:last-of-type{border-bottom:none}
    .recu-total{background:#dcfce7;border-radius:8px;padding:14px 16px;margin-top:16px;font-weight:800;font-size:16px;color:#16a34a;border:1px solid rgba(22,163,74,.2);display:flex;justify-content:space-between;align-items:center}
    .recu-watermark{text-align:center;margin-top:24px;padding-top:16px;border-top:1px dashed #e2e8f0;color:#64748b;font-size:11px}
    .recu-signatures{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:20px}
    .recu-sig-box{text-align:center;padding:20px;border:1px dashed #e2e8f0;border-radius:8px;font-size:11px;color:#64748b}
    @media print{
      body{padding:8px}
      @page{margin:10mm}
    }
  </style>
</head>
<body>
  <div style="max-width:500px;margin:0 auto;">
    ${content}
  </div>
  <script>
    window.onload = function() {
      setTimeout(function() { window.print(); window.close(); }, 400);
    };
  <\/script>
</body>
</html>`);
  win.document.close();
}

function exportPaiementsExcel() {
  if (!STATE.paiements.length) { showToast('Aucun paiement', 'warning'); return; }
  const data = STATE.paiements.map(p => {
    const el = STATE.eleves.find(e => e.id === p.eleve_id);
    return { Date: fmtDate(p.date), Nom: el ? el.nomPrenoms || el.nom : '', Matricule: el?.matricule || '', Classe: el ? el.classe || el.niveau : '', Statut_sco: el?.statut_sco || '', Type_Frais: p.type_frais, Montant: p.montant, Mode: p.mode, Recu: p.numero_recu };
  });
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Paiements');
  XLSX.writeFile(wb, 'paiements_' + CONFIG.code_ecole + '.xlsx');
  showToast('Export Excel ✅');
}


// ==================== CAISSE ====================
let _mouvType = 'entree';
function openModalMouvement(type) {
  if (!STATE.caisse_ouverte) { showToast('Caisse fermée', 'error'); return; }
  _mouvType = type;
  document.getElementById('modal-mouvement-title').textContent =
    type === 'entree' ? '➕ Entrée de caisse' : '➖ Sortie de caisse';
  ['mouvement-libelle','mouvement-obs'].forEach(f => { const el = document.getElementById(f); if (el) el.value = ''; });
  document.getElementById('mouvement-montant').value = '';
  document.getElementById('mouvement-date').value = today();
  openModal('modal-mouvement');
}
function sauvegarderMouvement() {
  if (!STATE.caisse_ouverte) { showToast('Caisse fermée', 'error'); return; }
  const libelle = document.getElementById('mouvement-libelle').value.trim();
  const montant = Number(document.getElementById('mouvement-montant').value);
  if (!libelle) { showToast('Entrez un libellé', 'error'); return; }
  if (!montant || montant <= 0) { showToast('Montant invalide', 'error'); return; }
  const solde = calcSoldeCaisse();
  if (_mouvType === 'sortie' && montant > solde) { showToast('Montant supérieur au solde', 'error'); return; }
  STATE.caisse.push({
    id: genId(), type: _mouvType, libelle, montant,
    categorie: document.getElementById('mouvement-categorie').value,
    obs: document.getElementById('mouvement-obs').value,
    date: document.getElementById('mouvement-date').value || new Date().toISOString(),
    solde_apres: _mouvType === 'entree' ? solde + montant : solde - montant
  });
  closeModal('modal-mouvement'); renderCaisse(); refreshDashboard(); save();
  showToast((_mouvType === 'entree' ? 'Entrée' : 'Sortie') + ' enregistrée ✅');
}
function renderCaisse() {
  const filtre = document.getElementById('filter-caisse')?.value || '';
  const mouvements = [...STATE.caisse].reverse().filter(m => !filtre || m.type === filtre);
  const entrees = STATE.caisse.filter(m => m.type === 'entree').reduce((s, m) => s + Number(m.montant), 0);
  const sorties = STATE.caisse.filter(m => m.type === 'sortie').reduce((s, m) => s + Number(m.montant), 0);
  const solde = entrees - sorties;
  document.getElementById('caisse-solde').textContent = fmt(solde);
  document.getElementById('caisse-entrees').textContent = fmt(entrees);
  document.getElementById('caisse-sorties').textContent = fmt(sorties);
  document.getElementById('stat-caisse').textContent = fmt(solde);
  const catLabels = { paiement_eleve: 'Paiement élève', depense_fonctionnement: 'Fonctionnement', salaire: 'Salaire', fournitures: 'Fournitures', entretien: 'Entretien', energie: 'Énergie', autre: 'Autre' };
  const tbody = document.getElementById('tbody-caisse');
  if (!mouvements.length) { tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state"><p>Aucun mouvement</p></div></td></tr>'; return; }
  tbody.innerHTML = mouvements.map(m =>
    '<tr><td>' + fmtDate(m.date) + '</td>' +
    '<td><span class="badge ' + (m.type === 'entree' ? 'badge-vert' : 'badge-rouge') + '">' +
    (m.type === 'entree' ? '➕ Entrée' : '➖ Sortie') + '</span></td>' +
    '<td>' + m.libelle + '</td>' +
    '<td><span class="badge badge-gris">' + (catLabels[m.categorie] || m.categorie || '-') + '</span></td>' +
    '<td><strong style="color:' + (m.type === 'entree' ? 'var(--vert)' : 'var(--rouge)') + ';">' +
    (m.type === 'entree' ? '+' : '−') + fmt(m.montant) + '</strong></td>' +
    '<td style="font-family:\'JetBrains Mono\',monospace;font-size:12px;">' + fmt(m.solde_apres) + '</td></tr>'
  ).join('');
}
function exportCaisseExcel() {
  if (!STATE.caisse.length) { showToast('Aucun mouvement', 'warning'); return; }
  const data = STATE.caisse.map(m => ({ Date: fmtDate(m.date), Type: m.type, Libelle: m.libelle, Categorie: m.categorie, Montant: m.montant, Solde_apres: m.solde_apres }));
  const ws = XLSX.utils.json_to_sheet(data); const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Caisse'); XLSX.writeFile(wb, 'caisse_' + CONFIG.code_ecole + '.xlsx');
  showToast('Export ✅');
}

// ==================== DÉPENSES ====================
function openModalDepense() {
  ['dep-libelle','dep-beneficiaire','dep-reference','dep-obs'].forEach(f => { const el = document.getElementById(f); if (el) el.value = ''; });
  document.getElementById('dep-montant').value = '';
  document.getElementById('dep-date').value = today();
  openModal('modal-depense');
}
function sauvegarderDepense() {
  const libelle = document.getElementById('dep-libelle').value.trim();
  const montant = Number(document.getElementById('dep-montant').value);
  if (!libelle) { showToast('Entrez un libellé', 'error'); return; }
  if (!montant || montant <= 0) { showToast('Montant invalide', 'error'); return; }
  const mode = document.getElementById('dep-mode').value;
  const dep = {
    id: genId(), libelle, montant,
    categorie: document.getElementById('dep-categorie').value,
    mode, date: document.getElementById('dep-date').value || today(),
    beneficiaire: document.getElementById('dep-beneficiaire').value,
    reference: document.getElementById('dep-reference').value,
    obs: document.getElementById('dep-obs').value
  };
  STATE.depenses.push(dep);
  if (mode === 'especes') {
    const solde = calcSoldeCaisse();
    STATE.caisse.push({ id: genId(), type: 'sortie', libelle: 'Dépense: ' + libelle, montant, categorie: dep.categorie, date: dep.date, solde_apres: Math.max(0, solde - montant) });
  }
  closeModal('modal-depense'); renderDepenses(); refreshDashboard(); save();
  showToast('Dépense enregistrée ✅');
  setTimeout(() => autoSync(), 500);
}
function renderDepenses() {
  const catf = document.getElementById('filter-depense-cat')?.value || '';
  const deps = [...STATE.depenses].reverse().filter(d => !catf || d.categorie === catf);
  const total = STATE.depenses.reduce((s, d) => s + Number(d.montant), 0);
  const moisActuel = new Date().toISOString().substr(0, 7);
  const mois = STATE.depenses.filter(d => d.date && d.date.startsWith(moisActuel)).reduce((s, d) => s + Number(d.montant), 0);
  const salaires = STATE.depenses.filter(d => d.categorie === 'salaire').reduce((s, d) => s + Number(d.montant), 0);
  const fonctionnement = STATE.depenses.filter(d => d.categorie !== 'salaire').reduce((s, d) => s + Number(d.montant), 0);
  document.getElementById('dep-total').textContent = fmt(total);
  document.getElementById('dep-mois').textContent = fmt(mois);
  document.getElementById('dep-salaires').textContent = fmt(salaires);
  document.getElementById('dep-fonctionnement').textContent = fmt(fonctionnement);
  document.getElementById('stat-depenses').textContent = fmt(total);
  const catLabels = { salaire:'👥 Salaires', fournitures:'📦 Fournitures', entretien:'🔧 Entretien', energie:'⚡ Énergie', communication:'📡 Communication', transport:'🚌 Transport', alimentation:'🍽️ Alimentation', investissement:'🏗️ Investissement', autre:'📌 Autre' };
  const tbody = document.getElementById('tbody-depenses');
  if (!deps.length) { tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state"><div class="empty-icon">📤</div><p>Aucune dépense</p></div></td></tr>'; return; }
  tbody.innerHTML = deps.map(d =>
    '<tr><td>' + fmtDate(d.date) + '</td><td><strong>' + d.libelle + '</strong></td>' +
    '<td><span class="badge badge-violet">' + (catLabels[d.categorie] || d.categorie) + '</span></td>' +
    '<td>' + (d.beneficiaire || '-') + '</td>' +
    '<td><strong style="color:var(--rouge);">' + fmt(d.montant) + '</strong></td>' +
    '<td><span class="badge badge-gris">' + (d.mode || '-') + '</span></td>' +
    '<td><button class="btn btn-danger btn-xs" onclick="supprimerDepense(\'' + d.id + '\')">🗑️</button></td></tr>'
  ).join('');
}
function supprimerDepense(id) {
  if (!confirm('Supprimer cette dépense ?')) return;
  STATE.depenses = STATE.depenses.filter(d => d.id !== id);
  renderDepenses(); refreshDashboard(); save(); showToast('Dépense supprimée', 'warning');
}
function exportDepensesExcel() {
  if (!STATE.depenses.length) { showToast('Aucune dépense', 'warning'); return; }
  const data = STATE.depenses.map(d => ({ Date: fmtDate(d.date), Libelle: d.libelle, Categorie: d.categorie, Beneficiaire: d.beneficiaire || '', Montant: d.montant, Mode: d.mode, Reference: d.reference || '' }));
  const ws = XLSX.utils.json_to_sheet(data); const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Dépenses'); XLSX.writeFile(wb, 'depenses_' + CONFIG.code_ecole + '.xlsx');
  showToast('Export ✅');
}

// ==================== RAPPORTS ====================
function renderRapports() {
  const totalPercu = calcTotalPercu(), totalAttendu = calcTotalAttendu();
  const taux = totalAttendu > 0 ? Math.round((totalPercu / totalAttendu) * 100) : 0;
  document.getElementById('rapport-taux').textContent = taux + '%';
  document.getElementById('rapport-percu').textContent = fmt(totalPercu);
  document.getElementById('rapport-attendu').textContent = fmt(totalAttendu);
  document.getElementById('rapport-reste2').textContent = fmt(Math.max(0, totalAttendu - totalPercu));
  const tbody = document.getElementById('tbody-rapports');
  if (!CONFIG.niveaux.length) { tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state"><p>Aucun niveau</p></div></td></tr>'; return; }
  tbody.innerHTML = CONFIG.niveaux.map(n => {
    const elNiveau = STATE.eleves.filter(e => e.niveau === n);
    const attendu = elNiveau.reduce((s, e) => s + calcAttenduEleve(e), 0);
    const percu = STATE.paiements.filter(p => { const el = STATE.eleves.find(e => e.id === p.eleve_id); return el && el.niveau === n; }).reduce((s, p) => s + Number(p.montant), 0);
    const reste = Math.max(0, attendu - percu);
    const tx = attendu > 0 ? Math.round((percu / attendu) * 100) : 0;
    return '<tr><td><span class="badge badge-bleu">' + n + '</span></td>' +
      '<td><strong>' + elNiveau.length + '</strong></td>' +
      '<td style="color:var(--vert);font-weight:700;">' + fmt(percu) + '</td>' +
      '<td>' + fmt(attendu) + '</td>' +
      '<td style="color:' + (reste > 0 ? 'var(--rouge)' : 'var(--vert)') + ';font-weight:700;">' + fmt(reste) + '</td>' +
      '<td><span class="badge ' + (tx >= 80 ? 'badge-vert' : tx >= 50 ? 'badge-orange' : 'badge-rouge') + '">' + tx + '%</span></td>' +
      '<td style="width:120px;"><div class="progress-bar-wrap"><div class="progress-bar" style="width:' + Math.min(100, tx) + '%;background:' + (tx >= 80 ? 'var(--vert)' : tx >= 50 ? 'var(--orange)' : 'var(--rouge)') + ';"></div></div></td></tr>';
  }).join('');
}
function switchRapportTab(tab, btn) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active')); btn.classList.add('active');
  ['rapport-tab-niveau','rapport-tab-type','rapport-tab-mois'].forEach(id => document.getElementById(id).style.display = 'none');
  document.getElementById('rapport-tab-' + tab).style.display = 'block';
  if (tab === 'mois') renderRapportMois();
}
function renderRapportMois() {
  const data = {};
  STATE.paiements.forEach(p => { if (!p.date) return; const m = p.date.substr(0, 7); if (!data[m]) data[m] = 0; data[m] += Number(p.montant); });
  const mois = Object.entries(data).sort(([a], [b]) => a.localeCompare(b));
  const maxVal = Math.max(...mois.map(([, v]) => v), 1);
  const months = {1:'Jan',2:'Fév',3:'Mar',4:'Avr',5:'Mai',6:'Jun',7:'Jul',8:'Aoû',9:'Sep',10:'Oct',11:'Nov',12:'Déc'};
  document.getElementById('rapport-chart-mois').innerHTML = mois.length
    ? '<div class="chart-bar-wrap">' + mois.map(([m, v]) => {
        const [y, mo] = m.split('-');
        return '<div class="chart-bar-item"><div class="chart-bar-label">' + months[parseInt(mo)] + ' ' + y + '</div>' +
          '<div class="chart-bar-bg"><div class="chart-bar-fill" style="width:' + Math.round((v / maxVal) * 100) + '%;background:linear-gradient(90deg,var(--bleu),var(--vert-c));"></div></div>' +
          '<div class="chart-bar-value">' + fmt(v) + '</div></div>';
      }).join('') + '</div>'
    : '<div class="empty-state"><p>Aucune donnée</p></div>';
}
function exportRapportExcel() {
  const data = CONFIG.niveaux.map(n => {
    const elNiveau = STATE.eleves.filter(e => e.niveau === n);
    const attendu = elNiveau.reduce((s, e) => s + calcAttenduEleve(e), 0);
    const percu = STATE.paiements.filter(p => { const el = STATE.eleves.find(e => e.id === p.eleve_id); return el && el.niveau === n; }).reduce((s, p) => s + Number(p.montant), 0);
    return { Niveau: n, Eleves: elNiveau.length, Percu: percu, Attendu: attendu, Reste: Math.max(0, attendu - percu), Taux: (attendu > 0 ? Math.round((percu / attendu) * 100) : 0) + '%' };
  });
  const ws = XLSX.utils.json_to_sheet(data); const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Rapport'); XLSX.writeFile(wb, 'rapport_' + CONFIG.code_ecole + '.xlsx');
  showToast('Export ✅');
}

// ==================== RETARDS ====================
function renderRetards() {
  const q = (document.getElementById('search-retards')?.value || '').toLowerCase();
  const nf = document.getElementById('filter-retard-niveau')?.value || '';
  const elevesRetard = STATE.eleves.filter(e => {
    const att = calcAttenduAujourdhui(e); if (!att) return false;
    if (calcPercuEleve(e.id) >= att) return false;
    if (q && !((e.nomPrenoms || e.nom || '').toLowerCase().includes(q) || (e.matricule || '').toLowerCase().includes(q))) return false;
    if (nf && (e.classe || e.niveau) !== nf) return false;
    return true;
  });
  const elevesOk = STATE.eleves.filter(e => { const att = calcAttenduAujourdhui(e); return att > 0 && calcPercuEleve(e.id) >= att; });
  const totalDu = elevesRetard.reduce((s, e) => s + Math.max(0, calcAttenduAujourdhui(e) - calcPercuEleve(e.id)), 0);
  document.getElementById('retard-count').textContent = elevesRetard.length;
  document.getElementById('retard-montant').textContent = fmt(totalDu);
  document.getElementById('retard-ok').textContent = elevesOk.length;
  const tbody = document.getElementById('tbody-retards');
  if (!elevesRetard.length) { tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state"><div class="empty-icon">✅</div><p>Aucun retard</p></div></td></tr>'; return; }
  tbody.innerHTML = elevesRetard.map(e => {
    const att = calcAttenduAujourdhui(e), percu = calcPercuEleve(e.id), reste = att - percu, pct = Math.round((percu / att) * 100);
    return '<tr><td><div style="display:flex;align-items:center;gap:8px;">' +
      (e.photo ? '<img src="' + e.photo + '" style="width:32px;height:32px;border-radius:50%;object-fit:cover;">' : '<div style="width:32px;height:32px;border-radius:50%;background:var(--rouge-p);display:flex;align-items:center;justify-content:center;">👤</div>') +
      '<div><strong>' + (e.nomPrenoms || e.nom) + '</strong><br><span class="badge ' + (e.statut_sco === 'Affecté' ? 'badge-bleu' : 'badge-vert') + '" style="font-size:10px;">' + (e.statut_sco || 'Non Affecté') + '</span></div></div></td>' +
      '<td><span class="badge badge-bleu">' + e.niveau + '</span></td>' +
      '<td>' + (e.telephone || e.tel || '-') + '</td>' +
      '<td style="color:var(--vert);font-weight:700;">' + fmt(percu) + '</td>' +
      '<td>' + fmt(att) + '</td>' +
      '<td><strong style="color:var(--rouge);">' + fmt(reste) + '</strong></td>' +
      '<td><div>' + pct + '%<div class="progress-bar-wrap" style="margin-top:4px;"><div class="progress-bar" style="width:' + pct + '%;background:' + (pct >= 50 ? 'var(--orange)' : 'var(--rouge)') + ';"></div></div></div></td>' +
      '<td><button class="btn btn-bleu btn-xs" onclick="voirFicheEleve(\'' + e.id + '\')">👁️</button>' +
      ' <button class="btn btn-vert btn-xs" onclick="openModalReduction(\'' + e.id + '\')">🎁</button></td></tr>';
  }).join('');
}
function filterRetards() { renderRetards(); }
function exportRetardsExcel() {
  const data = STATE.eleves.filter(e => { const att = calcAttenduAujourdhui(e); return att > 0 && calcPercuEleve(e.id) < att; })
    .map(e => ({ Nom: e.nomPrenoms||e.nom, Matricule: e.matricule, Niveau: e.niveau, Statut_sco: e.statut_sco||'Non Affecté', Telephone: e.telephone||e.tel||'', Paye: calcPercuEleve(e.id), Attendu: calcAttenduAujourdhui(e), Reste: calcAttenduAujourdhui(e)-calcPercuEleve(e.id) }));
  if (!data.length) { showToast('Aucun retard', 'warning'); return; }
  const ws = XLSX.utils.json_to_sheet(data); const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Retards'); XLSX.writeFile(wb, 'retards_' + CONFIG.code_ecole + '.xlsx');
  showToast('Export ✅');
}

// ==================== FICHE ÉLÈVE ====================
function voirFicheEleve(id) {
  const el = STATE.eleves.find(e => e.id === id); if (!el) return;
  const paiementsEl = STATE.paiements.filter(p => p.eleve_id === id);
  const totalPercu = paiementsEl.reduce((s, p) => s + Number(p.montant), 0);
  const attendu = calcAttenduEleve(el);
  const reste = Math.max(0, attendu - totalPercu);
  const pct = attendu > 0 ? Math.round((totalPercu / attendu) * 100) : 0;
  const red = getReductionActive(id);

  document.getElementById('fiche-eleve-content').innerHTML =
    '<div class="fiche-header">' +
    '<div class="fiche-photo">' + (el.photo ? '<img src="' + el.photo + '" alt="Photo">' : '👤') + '</div>' +
    '<div class="fiche-info" style="flex:1;">' +
    '<h3>' + (el.nomPrenoms || el.nom) + '</h3>' +
    '<p>📚 ' + el.niveau + ' &nbsp;|&nbsp; 🪪 ' + el.matricule + '</p>' +
    '<p style="margin-top:4px;">' +
    '<span class="badge ' + (el.statut_sco === 'Affecté' ? 'badge-bleu' : 'badge-vert') + '">' + (el.statut_sco || 'Non Affecté') + '</span> ' +
    '<span class="badge badge-gris">' + (el.qualite || 'Non Redoublant') + '</span> ' +
    '<span class="badge badge-gris">' + (el.regime || 'Non Boursier') + '</span></p>' +
    '<div style="margin-top:12px;background:rgba(255,255,255,.15);border-radius:8px;padding:8px 12px;">' +
    '<div style="display:flex;justify-content:space-between;margin-bottom:4px;font-size:12px;opacity:.8;"><span>Taux de paiement</span><span>' + pct + '%</span></div>' +
    '<div style="background:rgba(255,255,255,.2);border-radius:99px;height:6px;overflow:hidden;">' +
    '<div style="width:' + Math.min(100, pct) + '%;height:100%;background:' + (pct >= 100 ? '#4ade80' : pct >= 50 ? '#fbbf24' : '#f87171') + ';border-radius:99px;"></div></div></div></div></div>' +

    '<div class="fiche-stats-grid">' +
    '<div class="fiche-stat"><div class="fiche-stat-val" style="color:var(--vert);">' + fmt(totalPercu) + '</div><div class="fiche-stat-lbl">Total Payé</div></div>' +
    '<div class="fiche-stat"><div class="fiche-stat-val" style="color:var(--bleu);">' + fmt(attendu) + '</div><div class="fiche-stat-lbl">Attendu</div></div>' +
    '<div class="fiche-stat"><div class="fiche-stat-val" style="color:' + (reste > 0 ? 'var(--rouge)' : 'var(--vert)') + ';">' + fmt(reste) + '</div><div class="fiche-stat-lbl">Reste à payer</div></div></div>' +

    (red ? '<div class="' + (red.statut === 'approuvee' ? 'reduction-approved' : 'reduction-pending') + '">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;">' +
      '<span>🎁 Réduction scolarité : <strong>' + red.pourcentage + '%</strong> — ' + red.motif + '</span>' +
      '<span class="' + (red.statut === 'approuvee' ? 'reduction-badge-approved' : 'reduction-badge-pending') + '">' +
      (red.statut === 'approuvee' ? '✅ Approuvée' : '⏳ En attente') + '</span></div></div>' : '') +

    '<div class="fiche-grid">' +
    '<div class="fiche-item"><div class="fiche-item-label">Téléphone</div><div class="fiche-item-value">' + (el.telephone || el.tel || '-') + '</div></div>' +
    '<div class="fiche-item"><div class="fiche-item-label">Parent / Tuteur</div><div class="fiche-item-value">' + (el.parent || '-') + '</div></div>' +
    '<div class="fiche-item"><div class="fiche-item-label">Tél. Parent</div><div class="fiche-item-value">' + (el.tel_parent || '-') + '</div></div>' +
    '<div class="fiche-item"><div class="fiche-item-label">Date de naissance</div><div class="fiche-item-value">' + (el.naissance ? fmtDate(el.naissance) : '-') + '</div></div>' +
    '<div class="fiche-item"><div class="fiche-item-label">Lieu de naissance</div><div class="fiche-item-value">' + (el.lieu_naissance || '-') + '</div></div>' +
    '<div class="fiche-item"><div class="fiche-item-label">Sexe</div><div class="fiche-item-value">' + (el.sexe === 'F' ? 'Féminin' : 'Masculin') + '</div></div>' +
    '<div class="fiche-item"><div class="fiche-item-label">Ancienne dette</div><div class="fiche-item-value" style="color:' + (el.ancienne_dette > 0 ? 'var(--rouge)' : 'var(--vert)') + ';">' + fmt(el.ancienne_dette || 0) + '</div></div>' +
    '<div class="fiche-item"><div class="fiche-item-label">Inscription</div><div class="fiche-item-value">' + fmtDate(el.date_inscription) + '</div></div></div>' +

    (paiementsEl.length > 0 ?
      '<div style="margin-top:20px;"><div style="font-size:13.5px;font-weight:700;color:var(--gf);margin-bottom:10px;">📜 Historique paiements (' + paiementsEl.length + ')</div>' +
      '<div class="table-wrap"><table><thead><tr><th>Date</th><th>Type</th><th>Montant</th><th>Mode</th><th>N° Reçu</th></tr></thead><tbody>' +
      [...paiementsEl].reverse().map(p =>
        '<tr><td>' + fmtDate(p.date) + '</td><td>' + (p.type_frais || '-') + '</td>' +
        '<td style="color:var(--vert);font-weight:700;">' + fmt(p.montant) + '</td>' +
        '<td>' + (p.mode || '-') + '</td>' +
        '<td><code style="font-size:11px;">' + (p.numero_recu || '-') + '</code></td></tr>'
      ).join('') + '</tbody></table></div></div>' : '');

  window._ficheEleveId = id;
  openModal('modal-fiche-eleve');
}
function imprimerFiche() {
  const content = document.getElementById('fiche-eleve-content').innerHTML;
  const win = window.open('', '_blank', 'width=700,height=900');
  win.document.write(`<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <title>Fiche élève — ${CONFIG.nom_ecole}</title>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&family=Syne:wght@700;800&display=swap" rel="stylesheet">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'DM Sans',sans-serif;background:white;color:#0f172a;padding:20px}
    .fiche-header{background:linear-gradient(135deg,#14532d,#16a34a);border-radius:12px;padding:24px;margin-bottom:20px;color:white;display:flex;align-items:center;gap:20px}
    .fiche-photo{width:80px;height:80px;border-radius:50%;border:3px solid rgba(255,255,255,.4);object-fit:cover;flex-shrink:0;background:rgba(255,255,255,.2);display:flex;align-items:center;justify-content:center;font-size:32px}
    .fiche-photo img{width:100%;height:100%;border-radius:50%;object-fit:cover}
    .fiche-info h3{font-size:20px;font-weight:800;margin-bottom:4px;font-family:'Syne',sans-serif}
    .fiche-info p{font-size:12px;opacity:.85}
    .fiche-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px}
    .fiche-item{background:#f8fafc;border-radius:8px;padding:10px 12px;border:1px solid #e2e8f0}
    .fiche-item-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#64748b;margin-bottom:3px}
    .fiche-item-value{font-size:13px;font-weight:600;color:#0f172a}
    .fiche-stats-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px}
    .fiche-stat{background:white;border-radius:8px;padding:12px;text-align:center;border:1px solid #e2e8f0}
    .fiche-stat-val{font-size:18px;font-weight:800;font-family:monospace}
    .fiche-stat-lbl{font-size:10px;color:#64748b;font-weight:600;text-transform:uppercase}
    .badge{display:inline-flex;align-items:center;padding:3px 9px;border-radius:20px;font-size:11px;font-weight:600}
    .badge-vert{background:#dcfce7;color:#16a34a}
    .badge-bleu{background:#eff6ff;color:#2563eb}
    .badge-gris{background:#f8fafc;color:#64748b;border:1px solid #e2e8f0}
    .badge-rouge{background:#fee2e2;color:#dc2626}
    .badge-orange{background:#fef3c7;color:#92400e}
    table{width:100%;border-collapse:collapse;margin-top:8px}
    th{background:#f8fafc;padding:8px 10px;text-align:left;font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;border-bottom:1px solid #e2e8f0}
    td{padding:8px 10px;border-bottom:1px solid #f8fafc;font-size:12px}
    @media print{body{padding:4px}@page{margin:8mm}}
  </style>
</head>
<body>
  ${content}
  <script>
    window.onload = function() {
      setTimeout(function() { window.print(); window.close(); }, 400);
    };
  <\/script>
</body>
</html>`);
  win.document.close();
}


// ==================== TARIFS ====================
function renderTarifs() {
  const container = document.getElementById('tarifs-container');
  if (!CONFIG.niveaux.length) {
    container.innerHTML = '<div class="card" style="padding:40px;text-align:center;"><div class="empty-state"><div class="empty-icon">⚙️</div><h3>Aucun niveau configuré</h3><p>Modifiez le fichier config.js</p></div></div>';
    return;
  }
  container.innerHTML = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;">' +
    CONFIG.niveaux.map(n => {
      const t = STATE.tarifs[n] || { scolarite: 0, inscription: 0, annexes: 0, examen: 0 };
      const k = n.replace(/[^a-z0-9]/gi, '_');
      const estExamen = CONFIG.classes_examen.includes(n);
      return '<div class="tarif-niveau"><h4>📚 ' + n + (estExamen ? ' <span class="badge badge-orange" style="font-size:10px;">Examen</span>' : '') + '</h4>' +
        '<div class="config-grid">' +
        '<div class="form-group"><label>Scolarité annuelle (FCFA)</label><input type="number" id="tarif-scol-' + k + '" value="' + (t.scolarite || 0) + '" min="0"></div>' +
        '<div class="form-group"><label>Frais d\'inscription (FCFA)</label><input type="number" id="tarif-inscr-' + k + '" value="' + (t.inscription || 0) + '" min="0"></div>' +
        '<div class="form-group"><label>Frais annexes (FCFA)</label><input type="number" id="tarif-annex-' + k + '" value="' + (t.annexes || 0) + '" min="0"></div>' +
        (estExamen ? '<div class="form-group"><label>Frais examen (FCFA)</label><input type="number" id="tarif-exam-' + k + '" value="' + (t.examen || 0) + '" min="0"></div>' : '') +
        '</div></div>';
    }).join('') + '</div>';
}

async function sauvegarderTarifs() {
  if (!exigeRole('tarifs')) return;
  CONFIG.niveaux.forEach(n => {
    const k = n.replace(/[^a-z0-9]/gi, '_');
    const estExamen = CONFIG.classes_examen.includes(n);
    STATE.tarifs[n] = {
      scolarite: Number(document.getElementById('tarif-scol-' + k)?.value || 0),
      inscription: Number(document.getElementById('tarif-inscr-' + k)?.value || 0),
      annexes: Number(document.getElementById('tarif-annex-' + k)?.value || 0),
      examen: estExamen ? Number(document.getElementById('tarif-exam-' + k)?.value || 0) : 0
    };
  });
  save();
  showToast('Tarifs sauvegardés ✅');
  // Sync Supabase
  await pushTarifs();
}

// ==================== TYPES FRAIS ====================
function renderTypesFrais() {
  renderEcheancesTypeList('inscription', 'echeances-inscription-list', 2);
  renderEcheancesTypeList('scolarite', 'echeances-scolarite-list', 7);
}
function renderEcheancesTypeList(type, containerId, maxCount) {
  const container = document.getElementById(containerId); if (!container) return;
  const list = type === 'inscription' ? STATE.types_frais.inscription_echeances : STATE.types_frais.scolarite_echeances;
  if (!list.length) { container.innerHTML = '<p style="color:var(--gc);font-size:13px;">Aucune échéance</p>'; return; }
  container.innerHTML = list.map(e =>
    '<div style="display:grid;grid-template-columns:2fr 1fr 40px;gap:10px;align-items:center;margin-bottom:8px;">' +
    '<input type="text" value="' + e.nom + '" placeholder="Ex: 1ère tranche" oninput="updateEcheance(\'' + type + '\',\'' + e.id + '\',\'nom\',this.value)" style="border:1.5px solid var(--gb);border-radius:7px;padding:8px 10px;font-family:\'DM Sans\',sans-serif;font-size:13px;width:100%;">' +
    '<input type="date" value="' + (e.date || '') + '" oninput="updateEcheance(\'' + type + '\',\'' + e.id + '\',\'date\',this.value)" style="border:1.5px solid var(--gb);border-radius:7px;padding:8px 10px;font-family:\'DM Sans\',sans-serif;font-size:13px;width:100%;">' +
    '<button onclick="supprimerEcheance(\'' + type + '\',\'' + e.id + '\')" style="background:var(--rouge-p);color:var(--rouge);border:none;border-radius:7px;width:36px;height:36px;cursor:pointer;font-size:15px;">✕</button></div>'
  ).join('');
}
function ajouterEcheanceType(type) {
  if (!exigeRole('types_frais')) return;
  const list = type === 'inscription' ? STATE.types_frais.inscription_echeances : STATE.types_frais.scolarite_echeances;
  const max = type === 'inscription' ? 2 : 7;
  if (list.length >= max) { showToast('Maximum ' + max + ' échéances', 'error'); return; }
  list.push({ id: genId(), nom: (list.length + 1) + 'ème tranche', date: '' });
  renderEcheancesTypeList(type, type === 'inscription' ? 'echeances-inscription-list' : 'echeances-scolarite-list', max);
}
function updateEcheance(type, id, field, value) {
  const list = type === 'inscription' ? STATE.types_frais.inscription_echeances : STATE.types_frais.scolarite_echeances;
  const e = list.find(x => x.id === id); if (e) e[field] = value;
}
function supprimerEcheance(type, id) {
  if (!exigeRole('types_frais')) return;
  if (!confirm('Supprimer ?')) return;
  if (type === 'inscription') STATE.types_frais.inscription_echeances = STATE.types_frais.inscription_echeances.filter(e => e.id !== id);
  else STATE.types_frais.scolarite_echeances = STATE.types_frais.scolarite_echeances.filter(e => e.id !== id);
  renderEcheancesTypeList(type, type === 'inscription' ? 'echeances-inscription-list' : 'echeances-scolarite-list', type === 'inscription' ? 2 : 7);
}
function sauvegarderTypesFrais() {
  if (!exigeRole('types_frais')) return;
  // 1. D'abord lire toutes les valeurs des inputs
  const listsConfig = [
    { type: 'inscription', listKey: 'inscription_echeances', containerId: 'echeances-inscription-list' },
    { type: 'scolarite',   listKey: 'scolarite_echeances',   containerId: 'echeances-scolarite-list' }
  ];
  listsConfig.forEach(({ listKey, containerId }) => {
    const container = document.getElementById(containerId);
    if (!container) return;
    STATE.types_frais[listKey].forEach(e => {
      const nomInput = container.querySelector('input[type="text"][oninput*="' + e.id + '"]');
      const dateInput = container.querySelector('input[type="date"][oninput*="' + e.id + '"]');
      if (nomInput) e.nom = nomInput.value;
      if (dateInput) e.date = dateInput.value;
    });
  });
  // 2. Sauvegarder localement
  save();
  showToast('Types de frais sauvegardés ✅');
  // 3. Puis envoyer vers Supabase (après que STATE est à jour)
  setTimeout(() => pushTypesFrais(), 500);
  // 4. Recalculer les retards avec les nouvelles dates
  updateRetardsBadge();
  refreshDashboard();
}

// ==================== BANQUE ====================
function renderBanqueCompteInfo() {
  const div = document.getElementById('banque-compte-display'); if (!div) return;
  const c = STATE.banque?.compte;
  if (!c) {
    div.innerHTML = '<div class="empty-state" style="padding:24px;"><div class="empty-icon">🏦</div><h3>Aucun compte configuré</h3><button class="btn btn-primary" style="width:auto;margin-top:12px;" onclick="openModalCompte()">⚙️ Configurer</button></div>';
    return;
  }
  div.innerHTML = '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:16px;padding:16px;">' +
    '<div style="display:flex;align-items:center;gap:16px;">' +
    '<div style="width:52px;height:52px;background:linear-gradient(135deg,var(--bleu),#1557B0);border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:24px;">🏦</div>' +
    '<div><div style="font-size:16px;font-weight:800;color:var(--gf);">' + c.nom + '</div><div style="font-size:12px;color:var(--gc);">' + (c.intitule || '') + (c.agence ? ' — ' + c.agence : '') + '</div></div></div>' +
    '<button class="btn btn-secondary btn-sm" onclick="openModalCompte()">✏️ Modifier</button></div>';
}
function renderBanque() {
  if (!peutFaire('banque')) { showToast('Accès réservé au Fondateur', 'error'); showPage('dashboard'); return; }
  renderBanqueCompteInfo();
  if (!STATE.banque) STATE.banque = { compte: null, mouvements: [] };
  const mvts = STATE.banque.mouvements || [];
  const filtre = document.getElementById('banque-filtre')?.value || '';
  const init = Number(STATE.banque.compte?.solde_init || 0);
  const versements = mvts.filter(m => m.type === 'versement').reduce((s, m) => s + Number(m.montant), 0);
  const retraits = mvts.filter(m => m.type === 'retrait').reduce((s, m) => s + Number(m.montant), 0);
  const solde = init + versements - retraits;
  document.getElementById('banque-solde-actuel').textContent = fmt(solde);
  document.getElementById('banque-total-versements').textContent = fmt(versements);
  document.getElementById('banque-total-retraits').textContent = fmt(retraits);
  document.getElementById('stat-banque').textContent = fmt(solde);
  const tbody = document.getElementById('tbody-banque');
  const liste = [...mvts].reverse().filter(m => !filtre || m.type === filtre);
  if (!liste.length) { tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state"><p>Aucun mouvement</p></div></td></tr>'; return; }
  tbody.innerHTML = liste.map(m =>
    '<tr><td>' + fmtDate(m.date) + '</td>' +
    '<td><span class="badge ' + (m.type === 'versement' ? 'badge-bleu' : 'badge-rouge') + '">' + (m.type === 'versement' ? '⬆️ Versement' : '⬇️ Retrait') + '</span></td>' +
    '<td><strong>' + m.libelle + '</strong></td>' +
    '<td><code style="font-size:12px;">' + (m.reference || '—') + '</code></td>' +
    '<td><strong style="color:' + (m.type === 'versement' ? 'var(--bleu)' : 'var(--rouge)') + ';">' + (m.type === 'versement' ? '+' : '−') + fmt(m.montant) + '</strong></td>' +
    '<td style="font-family:\'JetBrains Mono\',monospace;font-size:12px;">' + fmt(m.solde_apres) + '</td>' +
    '<td><span class="badge badge-vert">' + (m.auteur || CONFIG.fondateur.nom) + '</span></td></tr>'
  ).join('');
}
let _banqueOpType = 'versement';
function openModalBanque(type) {
  if (!exigeRole('banque')) return;
  if (!STATE.banque?.compte) { showToast('Configurez d\'abord le compte', 'warning'); openModalCompte(); return; }
  _banqueOpType = type;
  document.getElementById('modal-banque-title').textContent = type === 'versement' ? '⬆️ Versement bancaire' : '⬇️ Retrait bancaire';
  ['banque-libelle','banque-reference','banque-obs'].forEach(f => { const el = document.getElementById(f); if (el) el.value = ''; });
  document.getElementById('banque-montant').value = '';
  document.getElementById('banque-date-op').value = today();
  document.getElementById('banque-solde-modal').textContent = fmt(calcSoldeBanque());
  openModal('modal-mouvement-banque');
}
function sauvegarderMouvementBanque() {
  if (!exigeRole('banque')) return;
  const libelle = document.getElementById('banque-libelle').value.trim();
  const montant = Number(document.getElementById('banque-montant').value);
  if (!libelle) { showToast('Entrez un libellé', 'error'); return; }
  if (!montant || montant <= 0) { showToast('Montant invalide', 'error'); return; }
  const solde = calcSoldeBanque();
  if (_banqueOpType === 'retrait' && montant > solde) { showToast('Montant supérieur au solde (' + fmt(solde) + ')', 'error'); return; }
  const soldeApres = _banqueOpType === 'versement' ? solde + montant : solde - montant;
  if (!STATE.banque.mouvements) STATE.banque.mouvements = [];
  STATE.banque.mouvements.push({
    id: genId(), type: _banqueOpType, libelle, montant,
    reference: document.getElementById('banque-reference').value.trim(),
    date: document.getElementById('banque-date-op').value || today(),
    obs: document.getElementById('banque-obs').value,
    solde_apres: soldeApres, auteur: CONFIG.fondateur.nom
  });
  closeModal('modal-mouvement-banque'); renderBanque(); refreshDashboard(); save();
  showToast((_banqueOpType === 'versement' ? 'Versement' : 'Retrait') + ' enregistré ✅');
}
function openModalCompte() {
  if (!exigeRole('banque')) return;
  const c = STATE.banque?.compte;
  document.getElementById('banque-nom').value = c?.nom || '';
  document.getElementById('banque-num-compte').value = c?.num_compte || '';
  document.getElementById('banque-intitule').value = c?.intitule || '';
  document.getElementById('banque-agence').value = c?.agence || '';
  document.getElementById('banque-iban').value = c?.iban || '';
  document.getElementById('banque-solde-init').value = c?.solde_init || 0;
  openModal('modal-compte-bancaire');
}
function sauvegarderCompte() {
  const nom = document.getElementById('banque-nom').value.trim();
  const num = document.getElementById('banque-num-compte').value.trim();
  if (!nom) { showToast('Entrez le nom de la banque', 'error'); return; }
  if (!num) { showToast('Entrez le N° compte', 'error'); return; }
  if (!STATE.banque) STATE.banque = { compte: null, mouvements: [] };
  STATE.banque.compte = { nom, num_compte: num, intitule: document.getElementById('banque-intitule').value.trim(), agence: document.getElementById('banque-agence').value.trim(), iban: document.getElementById('banque-iban').value.trim(), solde_init: Number(document.getElementById('banque-solde-init').value || 0) };
  closeModal('modal-compte-bancaire'); renderBanque(); refreshDashboard(); save();
  showToast('Compte enregistré ✅');
}
function exportBanqueExcel() {
  const mvts = STATE.banque?.mouvements || [];
  if (!mvts.length) { showToast('Aucun mouvement', 'warning'); return; }
  const data = mvts.map(m => ({ Date: fmtDate(m.date), Type: m.type, Libelle: m.libelle, Reference: m.reference || '', Montant: m.montant, Solde_apres: m.solde_apres, Auteur: m.auteur || '' }));
  const ws = XLSX.utils.json_to_sheet(data); const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Banque'); XLSX.writeFile(wb, 'banque_' + CONFIG.code_ecole + '.xlsx');
  showToast('Export ✅');
}

// ==================== IMPORT EXCEL ====================
let _excelData = [];
function openImportExcel() {
  document.getElementById('excel-preview').style.display = 'none';
  document.getElementById('btn-importer').style.display = 'none';
  document.getElementById('excel-input').value = '';
  _excelData = [];
  openModal('modal-import-excel');
}
function previewExcel(event) {
  const file = event.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      let data = [];
      if (file.name.endsWith('.csv')) {
        const text = new TextDecoder().decode(e.target.result);
        const lines = text.split('\n').filter(l => l.trim());
        const headers = lines[0].split(/[;,\t]/);
        data = lines.slice(1).map(line => { const vals = line.split(/[;,\t]/); const obj = {}; headers.forEach((h, i) => obj[h.trim()] = (vals[i] || '').trim()); return obj; });
      } else {
        const wb = XLSX.read(e.target.result, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        data = XLSX.utils.sheet_to_json(ws);
      }
      _excelData = data;
      const headers = data.length ? Object.keys(data[0]) : [];
      document.getElementById('excel-preview-thead').innerHTML = '<tr>' + headers.map(h => '<th>' + h + '</th>').join('') + '</tr>';
      document.getElementById('excel-preview-tbody').innerHTML = data.slice(0, 5).map(row => '<tr>' + headers.map(h => '<td>' + (row[h] || '') + '</td>').join('') + '</tr>').join('');
      document.getElementById('excel-preview-info').innerHTML = '✅ <strong>' + data.length + '</strong> lignes · Colonnes: <code>' + headers.join(' | ') + '</code>';
      document.getElementById('excel-preview').style.display = 'block';
      document.getElementById('btn-importer').style.display = 'inline-flex';
    } catch(err) { showToast('Erreur: ' + err.message, 'error'); }
  };
  reader.readAsArrayBuffer(file);
}
function importerDepuisExcel() {
  if (!_excelData.length) { showToast('Aucune donnée', 'error'); return; }
  let imported = 0, updated = 0, skipped = 0;

  // Normalisation des clés (insensible aux accents/casse/espaces)
  function norm(s) {
    return String(s).toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, '');
  }
  const rowKeys = Object.keys(_excelData[0] || {});
  const normIndex = {};
  rowKeys.forEach(k => { normIndex[norm(k)] = k; });

  function getVal(row, aliases) {
    for (const a of aliases) {
      const rk = normIndex[norm(a)];
      if (rk !== undefined) {
        const v = row[rk];
        if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
      }
    }
    return '';
  }

  // Normaliser statut_sco : "Affecte" → "Affecté", "Non Affecte" → "Non Affecté"
  function normaliserStatutSco(raw) {
    const s = norm(raw);
    if (s === 'affecte' || s === 'affecté' || s === 'affecte') return 'Affecté';
    return 'Non Affecté';
  }

  // Normaliser sexe : "Feminin" → "F", "Masculin" → "M"
  function normaliserSexe(raw) {
    const s = norm(raw);
    if (s.startsWith('f')) return 'F';
    return 'M';
  }

  // Normaliser qualité
  function normaliserQualite(raw) {
    const s = norm(raw);
    if (s.includes('redoublant') && !s.includes('non')) return 'Redoublant';
    return 'Non Redoublant';
  }

  // Normaliser régime
  function normaliserRegime(raw) {
    const s = norm(raw);
    if (s.includes('boursier') && !s.includes('non')) return 'Boursier';
    return 'Non Boursier';
  }

  _excelData.forEach(row => {
    // Nom + Prénoms séparés dans ce fichier : colonnes "Nom" et "Prénoms"
    const nom = getVal(row, ['Nom', 'nom']);
    const prenoms = getVal(row, ['Prénoms', 'Prenoms', 'prénoms', 'prenoms', 'Prénom', 'prenom']);
    const nomPrenoms = prenoms ? (nom + ' ' + prenoms).trim() : nom;

    if (!nomPrenoms) { skipped++; return; }

    const mat = getVal(row, ['Matricule', 'matricule', 'mat']) || genMatricule();

    // Le fichier a "Niveau" (6eme) ET "Classe" (6eme6) — on utilise Niveau pour les tarifs, Classe pour l'affichage
    const niveau = getVal(row, ['Niveau', 'niveau']) || getVal(row, ['Classe', 'classe']) || '';
    const classeDetail = getVal(row, ['Classe', 'classe']) || niveau;

    // Statut admin = Actif par défaut (pas dans ce fichier)
    const statutSco = normaliserStatutSco(getVal(row, ['statut', 'Statut', 'statut_sco', 'Statut_sco']));

    const d = {
      matricule: mat,
      nomPrenoms,
      nom: nomPrenoms,
      nomFamille: nom,
      prenoms,
      niveau,                  // pour les tarifs : 6eme, 5eme, etc.
      classe: classeDetail,    // pour l'affichage : 6eme6, 5eme3, etc.
      sexe: normaliserSexe(getVal(row, ['Sexe', 'sexe'])),
      naissance: toDateInput(getVal(row, ['Date de naissance', 'date de naissance', 'naissance', 'datenaissance'])),
      lieu_naissance: getVal(row, ['Lieu de Naissance', 'lieu de naissance', 'lieunaissance', 'lieu_naissance']),
      statut: 'Actif',
      statut_sco: statutSco,
      qualite: normaliserQualite(getVal(row, ['Qualite', 'qualité', 'Qualité', 'qualite'])),
      regime: normaliserRegime(getVal(row, ['Régime', 'regime', 'Regime'])),
      parent: getVal(row, ['Nom du Parent', 'nom du parent', 'nomparent', 'parent']),
      telephone: getVal(row, ['Contact', 'contact', 'telephone', 'Telephone', 'tel']),
      tel: getVal(row, ['Contact', 'contact', 'telephone', 'Telephone', 'tel']),
      tel_parent: getVal(row, ['Contact', 'contact', 'telephone', 'Telephone', 'tel']),
      ancienne_dette: Number(getVal(row, ['ancienne_dette', 'dette', 'dette_anterieure'])) || 0,
      annee_scolaire: CONFIG.annee,
      etablissement: CONFIG.nom_ecole,
      photo: ''
    };

    const existingIdx = STATE.eleves.findIndex(e => e.matricule === mat && mat !== '');
    if (existingIdx >= 0) {
      // Conserver la photo existante
      STATE.eleves[existingIdx] = { ...STATE.eleves[existingIdx], ...d, photo: STATE.eleves[existingIdx].photo || '' };
      updated++;
    } else {
      STATE.eleves.push({ id: genId(), ...d, date_inscription: today() });
      imported++;
    }
  });

  renderEleves();
  closeModal('modal-import-excel');
  save();
  showToast('✅ ' + imported + ' importé(s), ' + updated + ' mis à jour' + (skipped ? ', ' + skipped + ' ignoré(s)' : ''));
  updateRetardsBadge();
  setTimeout(() => autoSync(), 1500);
}


// ==================== SUPABASE SYNC ====================
function normalizeStoragePath(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').toLowerCase();
}
function sbPhotoUrl(matricule) {
  const folder = normalizeStoragePath(CONFIG.nom_ecole);
  return SB.url.replace(/\/$/, '') + '/storage/v1/object/public/photos-eleves/' + folder + '/' + encodeURIComponent(matricule) + '.jpg';
}
function base64ToBlob(base64) {
  const parts = base64.split(';base64,');
  const type = parts[0].split(':')[1] || 'image/jpeg';
  const binary = atob(parts[1]);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
  return new Blob([arr], { type });
}
async function uploadPhotoToStorage(matricule, base64) {
  if (!base64 || !base64.startsWith('data:')) return null;
  try {
    const compressed = await compressPhoto(base64, 400);
    const blob = base64ToBlob(compressed);
    const folder = normalizeStoragePath(CONFIG.nom_ecole);
    const path = folder + '/' + encodeURIComponent(matricule) + '.jpg';
    const url = SB.storageUrl() + '/object/photos-eleves/' + path;
    const res = await fetch(url, {
      method: 'POST',
      headers: { apikey: SB.key, Authorization: 'Bearer ' + SB.key, 'Content-Type': 'image/jpeg', 'x-upsert': 'true' },
      body: blob
    });
    return res.ok ? sbPhotoUrl(matricule) : null;
  } catch(e) { return null; }
}

// Mapper élève → Supabase
function eleveToSB(e) {
  const photoUrl = (e.photo && !e.photo.startsWith('data:')) ? e.photo : '';
  const obj = {
    etablissement: CONFIG.nom_ecole,
    matricule: e.matricule || '',
    nom: e.nomPrenoms || e.nom || '',
    classe: e.classe || e.niveau || '',   // classe détaillée : 6eme6
    niveau: e.niveau || '',               // niveau : 6eme
    statut: e.statut || 'Actif',
    statut_sco: e.statut_sco || 'Non Affecté',
    qualite: e.qualite || 'Non Redoublant',
    regime: e.regime || 'Non Boursier',
    sexe: e.sexe || 'M',
    naissance: e.naissance || '',
    lieu_naissance: e.lieu_naissance || '',
    parent: e.parent || '',
    tel_parent: e.tel_parent || '',
    telephone: e.telephone || e.tel || '',
    adresse: e.adresse || '',
    photo: photoUrl,
    ancienne_dette: Number(e.ancienne_dette || 0),
    annee_scolaire: e.annee_scolaire || CONFIG.annee
  };
  if (e.id && isUUID(e.id)) obj.id = e.id;
  return obj;
}
function sbToEleve(r) {
  return {
    id: r.id || genId(),
    matricule: r.matricule || '',
    nom: r.nom || '', nomPrenoms: r.nom || '',
    classe: r.classe || '',               // 6eme6
    niveau: r.niveau || r.classe || '',   // 6eme
    statut: r.statut || 'Actif',
    statut_sco: r.statut_sco || 'Non Affecté',
    qualite: r.qualite || 'Non Redoublant',
    regime: r.regime || 'Non Boursier',
    sexe: r.sexe || 'M',
    naissance: r.naissance || '',
    lieu_naissance: r.lieu_naissance || '',
    parent: r.parent || '',
    tel_parent: r.tel_parent || '',
    telephone: r.telephone || '', tel: r.telephone || '',
    adresse: r.adresse || '',
    photo: r.photo || '',
    ancienne_dette: Number(r.ancienne_dette || 0),
    annee_scolaire: r.annee_scolaire || '',
    etablissement: r.etablissement || ''
  };
}

// Mapper paiement → Supabase
function paiementToSB(p) {
  const eleveLocal = STATE.eleves.find(e => e.id === p.eleve_id);
  const eleveIdFinal = (eleveLocal && isUUID(eleveLocal.id)) ? eleveLocal.id : (isUUID(p.eleve_id) ? p.eleve_id : '');
  const obj = {
    etablissement: CONFIG.nom_ecole,
    eleve_id: eleveIdFinal,
    type: p.type_frais || p.type || '',
    montant: Number(p.montant || 0),
    mode: p.mode || 'especes',
    caisse: 'principale',
    echeance: p.echeance_id || '',
    observation: p.obs || '',
    date: toISO(p.date),
    agent: p.agent || STATE.user || 'econome',
    numero_recu: p.numero_recu || ('REC-' + Date.now().toString(36).toUpperCase()),
    annee_scolaire: CONFIG.annee
  };
  if (p.id && isUUID(p.id)) obj.id = p.id;
  return obj;
}
function sbToPaiement(r) {
  return {
    id: r.id, eleve_id: r.eleve_id || '', type_frais: r.type || '',
    montant: Number(r.montant || 0), mode: r.mode || '',
    echeance_id: r.echeance || '', obs: r.observation || '',
    date: r.date || r.created_at || new Date().toISOString(),
    numero_recu: r.numero_recu || ('REC-' + (r.id || '').substring(0, 8).toUpperCase()),
    agent: r.agent || '', etablissement: r.etablissement || ''
  };
}

// PUSH (envoyer vers Supabase)
async function pushEleves() {
  if (!STATE.eleves.length) return { ok: 0, err: 0 };
  let ok = 0, err = 0;
  // Upload photos d'abord
  for (const eleve of STATE.eleves.filter(e => e.photo && e.photo.startsWith('data:'))) {
    const url = await uploadPhotoToStorage(eleve.matricule, eleve.photo);
    if (url) eleve.photo = url;
  }
  const rows = STATE.eleves.map(eleveToSB);
  for (let i = 0; i < rows.length; i += 15) {
    const batch = rows.slice(i, i + 15);
    try {
      await SB.upsert('eleves', batch, 'matricule,etablissement');
      ok += batch.length;
    } catch(e) {
      for (const r of batch) {
        try { await SB.upsert('eleves', r, 'matricule,etablissement'); ok++; }
        catch(e2) { err++; }
      }
    }
  }
  return { ok, err };
}

async function pushPaiements() {
  if (!STATE.paiements.length) return { ok: 0, err: 0 };
  let ok = 0, err = 0;
  const rows = STATE.paiements.map(paiementToSB).filter(r => r.eleve_id && r.montant > 0);
  for (let i = 0; i < rows.length; i += 25) {
    const batch = rows.slice(i, i + 25);
    try {
      await SB.upsert('paiements', batch, 'numero_recu');
      ok += batch.length;
    } catch(e) {
      for (const r of batch) {
        try { await SB.upsert('paiements', r, 'numero_recu'); ok++; }
        catch(e2) { err++; }
      }
    }
  }
  return { ok, err };
}

async function pushCaisse() {
  if (!STATE.caisse.length) return;
  // Construire les UUIDs valides pour les mouvements paiement (id = paiementId + '_c')
  const idsPaiementsValides = new Set(STATE.paiements.map(p => p.id + '_c'));
  const rows = STATE.caisse.filter(m => {
    if (!m.id) return false;
    // Mouvements paiement : doit correspondre à un vrai paiement
    if (m.categorie === 'paiement_eleve') return idsPaiementsValides.has(m.id);
    // Mouvements manuels : doit être un UUID valide
    return isUUID(m.id);
  }).map(m => {
    // Pour les paiements, l'id stocké est paiementId+'_c' (pas un UUID valide)
    // On utilise l'UUID du paiement correspondant
    const realId = m.categorie === 'paiement_eleve' ? m.id.replace(/_c$/, '') : m.id;
    return {
      id: realId, etablissement: CONFIG.nom_ecole, caisse: 'principale',
      type_operation: m.type === 'entree' ? 'Encaissement' : 'Sortie',
      montant: Number(m.montant || 0), libelle: m.libelle || '',
      date: toISO(m.date), annee_scolaire: CONFIG.annee
    };
  });
  if (!rows.length) return;
  try { await SB.upsert('journal_caisse', rows); } catch(e) { console.warn('pushCaisse:', e.message); }
}

async function pushTarifs() {
  const rows = CONFIG.niveaux.map(n => {
    const t = STATE.tarifs[n] || {};
    return {
      etablissement: CONFIG.nom_ecole, classe: n,
      scolarite: Number(t.scolarite || 0), inscription: Number(t.inscription || 0),
      frais_annexes: Number(t.annexes || 0), droit_examen: Number(t.examen || 0),
      est_classe_examen: CONFIG.classes_examen.includes(n), annee_scolaire: CONFIG.annee
    };
  });
  try { await SB.upsert('tarifs', rows, 'etablissement,classe'); } catch(e) {}
}

// PULL (récupérer depuis Supabase)
async function pullEleves() {
  try {
    const etab = encodeURIComponent(CONFIG.nom_ecole);
    const localPhotos = {};
    STATE.eleves.forEach(e => { if (e.photo && e.photo.startsWith('data:')) localPhotos[e.matricule] = e.photo; });

    // Charger par pages de 1000 pour dépasser la limite Supabase
    let allData = [];
    let offset = 0;
    const pageSize = 1000;
    while (true) {
      const page = await SB.select('eleves',
        '?etablissement=eq.' + etab +
        '&order=nom' +
        '&limit=' + pageSize +
        '&offset=' + offset
      );
      if (!Array.isArray(page) || page.length === 0) break;
      allData = allData.concat(page);
      if (page.length < pageSize) break; // dernière page
      offset += pageSize;
    }

    if (!allData.length) return false;

    STATE.eleves = allData.map(r => {
      const el = sbToEleve(r);
      if (r.photo && r.photo.startsWith('http')) el.photo = r.photo;
      else if (localPhotos[r.matricule]) el.photo = localPhotos[r.matricule];
      else el.photo = '';
      return el;
    });
    return true;
  } catch(e) { console.warn('pullEleves:', e.message); return false; }
}

async function pullPaiements() {
  try {
    const etab = encodeURIComponent(CONFIG.nom_ecole);
    const data = await SB.select('paiements', '?etablissement=eq.' + etab + '&order=date.desc&limit=5000');
    if (!Array.isArray(data) || !data.length) { STATE.paiements = []; return true; }
    STATE.paiements = data.map(sbToPaiement);
    return true;
  } catch(e) { console.warn('pullPaiements:', e.message); return false; }
}

async function pullCaisse() {
  try {
    const etab = encodeURIComponent(CONFIG.nom_ecole);
    const data = await SB.select('journal_caisse', '?etablissement=eq.' + etab + '&order=date.asc&limit=5000');
    // Toujours vider STATE.caisse — reconstruire depuis paiements dans pullAll
    STATE.caisse = [];
    if (!Array.isArray(data) || !data.length) return true;
    // Reconstruire avec les IDs corrects (id Supabase = UUID du paiement)
    const idsPaiements = new Set(STATE.paiements.map(p => p.id));
    let solde = 0;
    STATE.caisse = data.map(r => {
      const typeLocal = r.type_operation === 'Encaissement' ? 'entree' : 'sortie';
      // Si l'id correspond à un paiement → categorie paiement_eleve, id = paiementId+'_c'
      const estPaiement = idsPaiements.has(r.id);
      const idLocal = estPaiement ? r.id + '_c' : r.id;
      const m = { id: idLocal, type: typeLocal, libelle: r.libelle || '',
        montant: Number(r.montant || 0),
        categorie: estPaiement ? 'paiement_eleve' : (r.categorie || 'autre'),
        date: r.date || new Date().toISOString() };
      solde = m.type === 'entree' ? solde + m.montant : solde - m.montant;
      m.solde_apres = solde; return m;
    });
    return true;
  } catch(e) { console.warn('pullCaisse:', e.message); return false; }
}

async function pullTarifs() {
  try {
    const etab = encodeURIComponent(CONFIG.nom_ecole);
    const data = await SB.select('tarifs', '?etablissement=eq.' + etab + '&limit=50');
    if (!Array.isArray(data) || !data.length) return false;
    data.forEach(r => {
      STATE.tarifs[r.classe] = {
        scolarite: Number(r.scolarite || 0), inscription: Number(r.inscription || 0),
        annexes: Number(r.frais_annexes || 0), examen: Number(r.droit_examen || 0)
      };
    });
    return true;
  } catch(e) { console.warn('pullTarifs:', e.message); return false; }
}

async function pullTypesFrais() {
  try {
    const etab = encodeURIComponent(CONFIG.nom_ecole);
    const annee = encodeURIComponent(CONFIG.annee);
    const data = await SB.select('echeancier', '?etablissement=eq.' + etab + '&annee_scolaire=eq.' + annee + '&limit=50');
    if (!Array.isArray(data) || !data.length) return false;
    const inscr = [], scol = [];
    data.forEach(r => {
      // Distinguer par le préfixe dans le champ mois
      const nom = r.mois || '';
      const estInscr = nom.startsWith('INSC-');
      const nomPropre = nom.replace(/^(INSC-|SCOL-)/, '');
      const ech = { id: r.id, nom: nomPropre, date: r.date_limite, montant: Number(r.montant || 0) };
      if (estInscr) inscr.push(ech);
      else scol.push(ech);
    });
    if (inscr.length) STATE.types_frais.inscription_echeances = inscr;
    if (scol.length) STATE.types_frais.scolarite_echeances = scol;
    return true;
  } catch(e) { console.warn('pullTypesFrais:', e.message); return false; }
}

async function pushTypesFrais() {
  try {
    const etab = CONFIG.nom_ecole;
    const annee = CONFIG.annee;
    const rows = [];
    // num_echeance est integer dans Supabase → utiliser 1,2,3... (pas "I1","S1")
    // On distingue inscription vs scolarité par le champ mois (préfixe)
    (STATE.types_frais.inscription_echeances || []).forEach((e, i) => {
      if (!e.id || !isUUID(e.id)) return;
      rows.push({ 
        id: e.id, 
        etablissement: etab, 
        annee_scolaire: annee, 
        num_echeance: i + 1,                           // integer
        mois: 'INSC-' + (e.nom || ('Tranche ' + (i+1))),  // préfixe pour distinguer inscription
        date_limite: e.date || null, 
        montant: Number(e.montant || 0) 
      });
    });
    (STATE.types_frais.scolarite_echeances || []).forEach((e, i) => {
      if (!e.id || !isUUID(e.id)) return;
      rows.push({ 
        id: e.id, 
        etablissement: etab, 
        annee_scolaire: annee, 
        num_echeance: i + 1,                           // integer
        mois: 'SCOL-' + (e.nom || ('Tranche ' + (i+1))),  // préfixe pour distinguer scolarité
        date_limite: e.date || null, 
        montant: Number(e.montant || 0) 
      });
    });
    if (!rows.length) { console.warn('pushTypesFrais: aucune échéance valide'); return false; }
    console.log('pushTypesFrais: envoi', rows.length, 'lignes');
    await SB.upsert('echeancier', rows);
    console.log('pushTypesFrais: OK');
    return true;
  } catch(e) { 
    console.warn('pushTypesFrais erreur:', e.message);
    return false; 
  }
}


// SYNC GLOBALE (automatique au démarrage)
// ==================== SYNC INTELLIGENTE ====================
// Principe : écriture locale immédiate + envoi Supabase silencieux automatique
// Si internet absent → file d'attente → retry automatique toutes les 30s
// L'utilisateur ne voit jamais de bouton "Synchroniser"

const SYNC = {
  _pending: false,    // une sync est en cours
  _dirty: false,      // des données ont changé depuis la dernière sync
  _online: true,      // état connexion
  _retryTimer: null,  // timer de retry
  _retryCount: 0,     // nombre de tentatives

  // Marquer que des données ont changé → déclencher sync différée
  touch() {
    this._dirty = true;
    save(); // sauvegarder localement immédiatement
    this._scheduleSync(1500); // sync dans 1.5s (debounce)
  },

  // Planifier une sync (annule et replanifie si appelé plusieurs fois)
  _scheduleSync(delay = 1500) {
    if (this._retryTimer) clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => this._doSync(), delay);
  },

  // Exécuter la sync réelle
  async _doSync() {
    if (this._pending || !this._dirty) return;
    this._pending = true;
    setSyncStatus('syncing', '⏳ Sauvegarde...');
    try {
      await pushEleves();
      await pushPaiements();
      await pushCaisse();
      this._dirty = false;
      this._online = true;
      this._retryCount = 0;
      setSyncStatus('synced', '☁️ Synchronisé • ' + new Date().toLocaleTimeString('fr-FR'));
    } catch(e) {
      this._online = false;
      this._retryCount++;
      const delay = Math.min(30000, 5000 * this._retryCount); // max 30s
      setSyncStatus('offline', '📵 Hors ligne — retry dans ' + Math.round(delay/1000) + 's');
      this._scheduleSync(delay); // réessayer automatiquement
      console.warn('Sync failed (retry ' + this._retryCount + '):', e.message);
    } finally {
      this._pending = false;
    }
  },

  // Vérifier la connexion périodiquement (toutes les 60s)
  startHeartbeat() {
    setInterval(() => {
      if (this._dirty && !this._pending) this._doSync();
    }, 60000);
  }
};

async function pullAll() {
  setSyncStatus('syncing', '⏳ Chargement...');
  try {
    const results = await Promise.allSettled([pullEleves(), pullPaiements(), pullCaisse(), pullTarifs(), pullTypesFrais()]);
    const hasData = results.some(r => r.status === 'fulfilled' && r.value === true);
    if (hasData) {
      // Reconstruire la caisse : paiements réels depuis Supabase + mouvements manuels depuis journal_caisse
      // STATE.caisse a été vidé par pullCaisse() si journal_caisse est vide
      // On recalcule depuis STATE.paiements (source de vérité)
      {
        const idsPaiements = new Set(STATE.paiements.map(p => p.id + '_c'));
        // Garder uniquement les mouvements manuels (ceux qui NE sont PAS liés à un paiement)
        const mouvementsManuels = STATE.caisse.filter(m =>
          m.categorie !== 'paiement_eleve' && !idsPaiements.has(m.id)
        );
        let solde = 0;
        const caissePaiements = [...STATE.paiements]
          .sort((a, b) => new Date(a.date) - new Date(b.date))
          .map(p => {
            solde += Number(p.montant || 0);
            const elv = STATE.eleves.find(e => e.id === p.eleve_id);
            const nomElv = elv ? (elv.nomPrenoms || elv.nom || '') : '';
            return { id: p.id + '_c', type: 'entree',
              libelle: 'Paiement ' + nomElv + ' — ' + (p.type_frais || ''),
              montant: Number(p.montant || 0), categorie: 'paiement_eleve',
              date: p.date, solde_apres: solde };
          });
        mouvementsManuels.forEach(m => {
          solde = m.type === 'entree' ? solde + Number(m.montant) : solde - Number(m.montant);
          m.solde_apres = solde;
        });
        STATE.caisse = [...caissePaiements, ...mouvementsManuels];
        await pushCaisse();
      }
      save();
      setSyncStatus('synced', '☁️ Synchronisé • ' + new Date().toLocaleTimeString('fr-FR'));
      // Recalculer retards avec les nouvelles échéances
      updateRetardsBadge();
    } else {
      setSyncStatus('synced', '☁️ Connecté (données locales)');
    }
    return hasData;
  } catch(e) {
    setSyncStatus('offline', '📵 Hors ligne — données locales');
    console.warn('pullAll:', e.message);
    return false;
  }
}

// autoSync = maintenant déclenche SYNC.touch() — invisible pour l'utilisateur
async function autoSync() {
  SYNC.touch();
}

// syncAll = sync complète forcée (bouton dashboard — pour le fondateur)
async function syncAll() {
  setSyncStatus('syncing', '⏳ Synchronisation...');
  showLoading('Synchronisation complète...');
  try {
    showLoading('📤 Envoi des élèves...');
    const resEl = await pushEleves();
    showLoading('💳 Envoi des paiements...');
    const resPai = await pushPaiements();
    showLoading('🗃️ Envoi de la caisse...');
    await pushCaisse();
    showLoading('💰 Envoi des tarifs...');
    await pushTarifs();
    showLoading('📅 Envoi des échéances...');
    await pushTypesFrais();
    showLoading('☁️ Récupération des données...');
    await Promise.allSettled([pullEleves(), pullPaiements(), pullCaisse(), pullTarifs(), pullTypesFrais()]);
    SYNC._dirty = false;
    save(); hideLoading();
    setSyncStatus('synced', '☁️ Synchronisé • ' + new Date().toLocaleTimeString('fr-FR'));
    renderEleves(); renderPaiements(); renderCaisse(); renderTarifs(); refreshDashboard(); updateRetardsBadge();
    showToast('✅ Sync complète — ' + (resEl?.ok || 0) + ' élève(s), ' + (resPai?.ok || 0) + ' paiement(s)');
  } catch(e) {
    hideLoading(); setSyncStatus('error', '❌ Erreur sync');
    showToast('❌ Erreur: ' + e.message, 'error');
    console.error('syncAll:', e);
  }
}

// ==================== MODALS ====================
function openModal(id) { document.getElementById(id)?.classList.add('show'); }
function closeModal(id) { document.getElementById(id)?.classList.remove('show'); }

// ==================== INIT ====================
document.addEventListener('DOMContentLoaded', () => {
  load();
  // Pré-remplir le nom de l'établissement dans le login
  const loginEcole = document.getElementById('login-ecole-display');
  if (loginEcole) loginEcole.textContent = CONFIG.nom_ecole;
  // Fermer modals au clic extérieur
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.remove('show'); });
  });
  // Date paiement par défaut
  const datePai = document.getElementById('paiement-date');
  if (datePai) datePai.value = today();
});


// filterPaiements — appelée depuis les selects de la page paiements
function filterPaiements() { renderPaiements(); }

// ==================== IMPORT PHOTOS PAR MATRICULE ====================
function openImportPhotos() {
  document.getElementById('import-photos-stats').innerHTML = '';
  document.getElementById('import-photos-input').value = '';
  openModal('modal-import-photos');
}

async function importerPhotosParMatricule(event) {
  const files = Array.from(event.target.files);
  if (!files.length) return;

  const stats = document.getElementById('import-photos-stats');
  stats.innerHTML = '<div class="alert alert-bleu"><span>⏳</span> Traitement de ' + files.length + ' photo(s) — upload vers le cloud...</div>';

  let ok = 0, notFound = 0, uploadOk = 0, uploadErr = 0, erreurs = [];
  const total = files.length;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    // Progression
    if (i % 10 === 0) {
      stats.innerHTML = '<div class="alert alert-bleu"><span>⏳</span> ' + i + '/' + total + ' photos traitées...</div>';
    }

    // Extraire le matricule depuis le nom du fichier (sans extension)
    const matricule = file.name.replace(/\.[^/.]+$/, '').toUpperCase().trim();
    const eleve = STATE.eleves.find(e =>
      (e.matricule || '').toUpperCase().trim() === matricule
    );

    if (!eleve) { notFound++; erreurs.push(matricule); continue; }

    try {
      const base64 = await fileToBase64(file);
      const compressed = await compressPhoto(base64, 400);

      // Uploader vers Supabase Storage
      const urlCloud = await uploadPhotoToStorage(eleve.matricule, compressed);
      if (urlCloud) {
        eleve.photo = urlCloud; // URL Supabase Storage
        uploadOk++;
      } else {
        eleve.photo = compressed; // Fallback base64 local
        uploadErr++;
      }
      ok++;
    } catch(e) {
      erreurs.push(matricule + ' (erreur)');
    }
  }

  save();
  renderEleves();

  // Mettre à jour les URLs dans Supabase
  if (uploadOk > 0) {
    setTimeout(() => autoSync(), 500);
  }

  stats.innerHTML =
    '<div class="alert ' + (ok > 0 ? 'alert-vert' : 'alert-orange') + '">' +
    '<div><strong>✅ ' + ok + ' photo(s) importée(s)</strong>' +
    (uploadOk > 0 ? '<br>☁️ ' + uploadOk + ' uploadée(s) vers Supabase Storage' : '') +
    (uploadErr > 0 ? '<br>💾 ' + uploadErr + ' sauvegardée(s) en local (cloud indisponible)' : '') +
    (notFound > 0 ? '<br>⚠️ ' + notFound + ' matricule(s) non trouvé(s) : <code style="font-size:11px;">' + erreurs.slice(0, 10).join(', ') + (erreurs.length > 10 ? '...' : '') + '</code>' : '') +
    '</div></div>' +
    '<div style="margin-top:12px;text-align:center;">' +
    '<button class="btn btn-primary" onclick="closeModal(\'modal-import-photos\');">✅ Terminer</button>' +
    '</div>';

  showToast('✅ ' + ok + ' photo(s) — ☁️ ' + uploadOk + ' cloud' + (notFound ? ' — ⚠️ ' + notFound + ' non trouvée(s)' : ''));
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ==================== SMS ====================
// ==================== SMS ORANGE CI v2.0 ====================
// Cache du token OAuth2 (valide 90 jours selon Orange CI)
const _smsCache = { token: null, expiry: 0 };

// Détection : on est sur localhost (serveur local) ou fichier direct ?
function isLocalServer() {
  return window.location.protocol === 'http:' && 
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
}

// Requête via proxy (résout le problème CORS)
// En local : passe par server.js (route /api/sms-proxy)
// En production (Vercel) : passe par la Serverless Function /api/sms-proxy
// Dans les deux cas, on utilise le MÊME endpoint pour éviter les appels directs
// au navigateur vers api.orange.com, qui sont bloqués par CORS.
async function proxyFetch(targetUrl, method, headers, body) {
  const res = await fetch('/api/sms-proxy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: targetUrl, method, headers, body })
  });
  return res;
}

async function getOrangeToken() {
  if (_smsCache.token && Date.now() < _smsCache.expiry) return _smsCache.token;

  const res = await proxyFetch(
    'https://api.orange.com/oauth/v3/token',
    'POST',
    {
      'Authorization': CONFIG.orange_basic,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json'
    },
    'grant_type=client_credentials'
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error('Orange token error ' + res.status + ': ' + err.substring(0, 100));
  }

  const data = await res.json();
  _smsCache.token = data.access_token;
  _smsCache.expiry = Date.now() + ((data.expires_in || 7776000) - 60) * 1000;
  return _smsCache.token;
}

async function envoyerSMSPaiement(paiement, eleve) {
  if (!CONFIG.orange_basic) {
    showToast('API SMS non configurée', 'warning'); return;
  }
  if (!CONFIG.orange_from) {
    showToast('Numéro expéditeur Orange non configuré (orange_from dans config.js)', 'warning'); return;
  }

  // Numéro destinataire : prendre tel parent en priorité, sinon tel élève
  const telRaw = eleve?.tel_parent || eleve?.telephone || eleve?.tel || '';
  if (!telRaw) { showToast('Aucun numéro de téléphone disponible', 'error'); return; }

  // Nettoyer le numéro : garder seulement les chiffres, ajouter 225 si pas déjà
  let telNum = telRaw.replace(/[^0-9]/g, '');
  if (telNum.startsWith('225')) telNum = telNum; // déjà avec indicatif
  else if (telNum.length === 10) telNum = '225' + telNum; // numéro local CI
  else if (telNum.startsWith('0')) telNum = '225' + telNum.substring(1);

  const typeLabel = { inscription: "Droit d'inscription", scolarite: 'Scolarité', examen: 'Frais Examen', annexe: 'Frais Annexe' };
  const msg =
    CONFIG.nom_ecole + '\n' +
    'Recu N° ' + (paiement.numero_recu || '') + '\n' +
    'Eleve: ' + (eleve?.nomPrenoms || eleve?.nom || '') + '\n' +
    'Classe: ' + (eleve?.classe || eleve?.niveau || '') + '\n' +
    'Type: ' + (typeLabel[paiement.type_frais] || paiement.type_frais || '') + '\n' +
    'Montant: ' + fmt(paiement.montant) + '\n' +
    'Date: ' + fmtDate(paiement.date) + '\n' +
    'Merci pour votre confiance.';

  try {
    showToast('📱 Envoi SMS en cours...', 'info');

    // 1. Obtenir le token OAuth2
    const token = await getOrangeToken();

    // 2. Envoyer le SMS via proxy
    const fromEncoded = encodeURIComponent('tel:+' + CONFIG.orange_from);
    const smsBody = JSON.stringify({
      outboundSMSMessageRequest: {
        address: ['tel:+' + telNum],
        senderAddress: 'tel:+' + CONFIG.orange_from,
        outboundSMSTextMessage: { message: msg },
        senderName: CONFIG.orange_sender || 'EconoSchool'
      }
    });

    const res = await proxyFetch(
      'https://api.orange.com/smsmessaging/v1/outbound/' + fromEncoded + '/requests',
      'POST',
      {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      smsBody
    );

    if (res.ok || res.status === 201) {
      showToast('📱 SMS envoyé à +' + telNum + ' ✅');
      // Logger le SMS
      STATE._lastSMS = { tel: telNum, msg, date: new Date().toISOString(), status: 'ok' };
    } else {
      const err = await res.text();
      console.error('SMS error:', res.status, err);
      showToast('SMS erreur ' + res.status + ' — vérifiez votre crédit Orange', 'error');
    }
  } catch(e) {
    console.error('SMS exception:', e);
    showToast('SMS: ' + e.message.substring(0, 60), 'error');
  }
}

// ==================== BILAN JOURNALIER / PÉRIODIQUE ====================
function renderBilan() {
  const dateDebut = document.getElementById('bilan-date-debut')?.value || '';
  const dateFin = document.getElementById('bilan-date-fin')?.value || '';

  // Filtrer paiements sur la période
  const paiementsPeriode = STATE.paiements.filter(p => {
    const d = (p.date || '').substring(0, 10);
    if (dateDebut && d < dateDebut) return false;
    if (dateFin && d > dateFin) return false;
    return true;
  });

  // Filtrer mouvements caisse sur la période
  const caissePeriode = STATE.caisse.filter(m => {
    const d = (m.date || '').substring(0, 10);
    if (dateDebut && d < dateDebut) return false;
    if (dateFin && d > dateFin) return false;
    return true;
  });

  // Filtrer mouvements banque sur la période
  const banquePeriode = (STATE.banque?.mouvements || []).filter(m => {
    const d = (m.date || '').substring(0, 10);
    if (dateDebut && d < dateDebut) return false;
    if (dateFin && d > dateFin) return false;
    return true;
  });

  // Filtrer dépenses sur la période
  const depensesPeriode = STATE.depenses.filter(d => {
    const dt = (d.date || '').substring(0, 10);
    if (dateDebut && dt < dateDebut) return false;
    if (dateFin && dt > dateFin) return false;
    return true;
  });

  // Calculs
  const totalPaiements = paiementsPeriode.reduce((s, p) => s + Number(p.montant), 0);
  const caisseEntrees = caissePeriode.filter(m => m.type === 'entree').reduce((s, m) => s + Number(m.montant), 0);
  const caisseSorties = caissePeriode.filter(m => m.type === 'sortie').reduce((s, m) => s + Number(m.montant), 0);
  const soldeCaissePeriode = caisseEntrees - caisseSorties;
  const banqueVersements = banquePeriode.filter(m => m.type === 'versement').reduce((s, m) => s + Number(m.montant), 0);
  const banqueRetraits = banquePeriode.filter(m => m.type === 'retrait').reduce((s, m) => s + Number(m.montant), 0);
  const totalDepenses = depensesPeriode.reduce((s, d) => s + Number(d.montant), 0);

  // Paiements par type
  const parType = {};
  paiementsPeriode.forEach(p => {
    const t = p.type_frais || 'autre';
    parType[t] = (parType[t] || 0) + Number(p.montant);
  });

  // Paiements par mode
  const parMode = {};
  paiementsPeriode.forEach(p => {
    const m = p.mode || 'especes';
    parMode[m] = (parMode[m] || 0) + Number(p.montant);
  });

  // Affichage stats bilan
  document.getElementById('bilan-total-paiements').textContent = fmt(totalPaiements);
  document.getElementById('bilan-nb-paiements').textContent = paiementsPeriode.length;
  document.getElementById('bilan-caisse-entrees').textContent = fmt(caisseEntrees);
  document.getElementById('bilan-caisse-sorties').textContent = fmt(caisseSorties);
  document.getElementById('bilan-caisse-net').textContent = fmt(soldeCaissePeriode);
  document.getElementById('bilan-banque-versements').textContent = fmt(banqueVersements);
  document.getElementById('bilan-banque-retraits').textContent = fmt(banqueRetraits);
  document.getElementById('bilan-depenses').textContent = fmt(totalDepenses);

  // Tableau par type
  const typeLabels = { inscription: "Inscription", scolarite: "Scolarité", examen: "Examen", annexe: "Annexe", autre: "Autre" };
  document.getElementById('bilan-par-type').innerHTML = Object.entries(parType).length > 0
    ? Object.entries(parType).map(([t, v]) =>
      '<div class="recu-row"><span>' + (typeLabels[t] || t) + '</span><strong style="color:var(--vert);">' + fmt(v) + '</strong></div>'
    ).join('')
    : '<p style="color:var(--gc);font-size:13px;">Aucun paiement sur cette période</p>';

  // Tableau par mode
  const modeLabels = { especes: '💵 Espèces', mobile_money: '📱 Mobile Money', cheque: '🏦 Chèque', virement: '🔁 Virement' };
  document.getElementById('bilan-par-mode').innerHTML = Object.entries(parMode).length > 0
    ? Object.entries(parMode).map(([m, v]) =>
      '<div class="recu-row"><span>' + (modeLabels[m] || m) + '</span><strong style="color:var(--bleu);">' + fmt(v) + '</strong></div>'
    ).join('')
    : '<p style="color:var(--gc);font-size:13px;">Aucun mode</p>';

  // Liste détaillée paiements
  const tbody = document.getElementById('tbody-bilan-paiements');
  if (!paiementsPeriode.length) {
    tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state"><p>Aucun paiement sur cette période</p></div></td></tr>';
  } else {
    tbody.innerHTML = [...paiementsPeriode].reverse().map(p => {
      const el = STATE.eleves.find(e => e.id === p.eleve_id);
      return '<tr>' +
        '<td>' + fmtDate(p.date) + '</td>' +
        '<td><strong>' + (el ? el.nomPrenoms || el.nom : '?') + '</strong></td>' +
        '<td><span class="badge badge-bleu">' + (el ? el.niveau : '-') + '</span></td>' +
        '<td><span class="badge badge-gris">' + (p.type_frais || '-') + '</span></td>' +
        '<td><strong style="color:var(--vert);">' + fmt(p.montant) + '</strong></td>' +
        '<td><span class="badge badge-violet">' + (p.mode || '-') + '</span></td></tr>';
    }).join('');
  }
}

function setBilanAujourdhui() {
  const t = today();
  document.getElementById('bilan-date-debut').value = t;
  document.getElementById('bilan-date-fin').value = t;
  renderBilan();
}
function setBilanCetteSemaine() {
  const now = new Date();
  const day = now.getDay() || 7;
  const lundi = new Date(now); lundi.setDate(now.getDate() - day + 1);
  const dim = new Date(lundi); dim.setDate(lundi.getDate() + 6);
  document.getElementById('bilan-date-debut').value = lundi.toISOString().split('T')[0];
  document.getElementById('bilan-date-fin').value = dim.toISOString().split('T')[0];
  renderBilan();
}
function setBilanCeMois() {
  const now = new Date();
  const debut = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
  const fin = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];
  document.getElementById('bilan-date-debut').value = debut;
  document.getElementById('bilan-date-fin').value = fin;
  renderBilan();
}

function exportBilanExcel() {
  const dateDebut = document.getElementById('bilan-date-debut')?.value || '';
  const dateFin = document.getElementById('bilan-date-fin')?.value || '';
  const paiementsPeriode = STATE.paiements.filter(p => {
    const d = (p.date || '').substring(0, 10);
    if (dateDebut && d < dateDebut) return false;
    if (dateFin && d > dateFin) return false;
    return true;
  });
  if (!paiementsPeriode.length) { showToast('Aucun paiement sur cette période', 'warning'); return; }
  const data = paiementsPeriode.map(p => {
    const el = STATE.eleves.find(e => e.id === p.eleve_id);
    return { Date: fmtDate(p.date), Eleve: el ? el.nomPrenoms || el.nom : '?', Niveau: el ? el.niveau : '-', Type: p.type_frais, Montant: p.montant, Mode: p.mode, Recu: p.numero_recu };
  });
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Bilan');
  XLSX.writeFile(wb, 'bilan_' + (dateDebut || 'periode') + '_' + CONFIG.code_ecole + '.xlsx');
  showToast('Export Excel ✅');
}

// ==================== DATE BUTOIR SCOLARITÉ ====================
function renderRetardsButoir() {
  const dateButoir = document.getElementById('date-butoir')?.value || '';
  const nf = document.getElementById('filter-retard-niveau2')?.value || '';

  if (!dateButoir) {
    document.getElementById('butoir-resultat').innerHTML =
      '<div class="alert alert-bleu"><span>📅</span> Sélectionnez une date butoir pour voir les résultats</div>';
    return;
  }

  // Un élève est "à jour" si : total payé >= total attendu OU si dernier paiement avant/à la date butoir couvre l'attendu
  // Simplification : on compare total payé vs attendu à la date butoir
  const paiementsAvantButoir = STATE.paiements.filter(p => (p.date || '').substring(0, 10) <= dateButoir);

  function percuAvantButoir(eleveId) {
    return paiementsAvantButoir.filter(p => p.eleve_id === eleveId).reduce((s, p) => s + Number(p.montant), 0);
  }

  const elevesActifs = STATE.eleves.filter(e => e.statut === 'Actif' || !e.statut);
  const filtres = nf ? elevesActifs.filter(e => e.niveau === nf) : elevesActifs;

  const resultats = filtres.map(e => {
    const attendu = calcAttenduEleve(e);
    const percu = percuAvantButoir(e.id);
    const reste = Math.max(0, attendu - percu);
    let statut;
    if (attendu === 0) statut = 'exempt';
    else if (percu >= attendu) statut = 'solde';
    else if (percu > 0) statut = 'partiel';
    else statut = 'retard';
    return { e, attendu, percu, reste, statut };
  });

  const soldes = resultats.filter(r => r.statut === 'solde');
  const partiels = resultats.filter(r => r.statut === 'partiel');
  const retards = resultats.filter(r => r.statut === 'retard');
  const totalDu = resultats.reduce((s, r) => s + r.reste, 0);

  document.getElementById('butoir-stat-solde').textContent = soldes.length;
  document.getElementById('butoir-stat-partiel').textContent = partiels.length;
  document.getElementById('butoir-stat-retard').textContent = retards.length;
  document.getElementById('butoir-stat-montant').textContent = fmt(totalDu);

  const badgeStatut = {
    solde: '<span class="badge badge-vert">✅ Soldé</span>',
    partiel: '<span class="badge badge-orange">⚡ Partiel</span>',
    retard: '<span class="badge badge-rouge">❌ En retard</span>',
    exempt: '<span class="badge badge-gris">— Exempté</span>'
  };

  const tbody = document.getElementById('tbody-butoir');
  if (!resultats.length) {
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state"><p>Aucun élève</p></div></td></tr>';
    return;
  }

  // Trier : retards en premier, puis partiels, puis soldés
  const ordre = { retard: 0, partiel: 1, solde: 2, exempt: 3 };
  resultats.sort((a, b) => ordre[a.statut] - ordre[b.statut]);

  tbody.innerHTML = resultats.map(({ e, attendu, percu, reste, statut }) => {
    const pct = attendu > 0 ? Math.round((percu / attendu) * 100) : 100;
    return '<tr>' +
      '<td>' +
      (e.photo ? '<img src="' + e.photo + '" style="width:30px;height:30px;border-radius:50%;object-fit:cover;margin-right:6px;vertical-align:middle;">' : '') +
      '<strong>' + (e.nomPrenoms || e.nom) + '</strong></td>' +
      '<td><span class="badge badge-bleu">' + e.niveau + '</span></td>' +
      '<td><span class="badge ' + (e.statut_sco === 'Affecté' ? 'badge-bleu' : 'badge-vert') + '">' + (e.statut_sco || 'Non Aff.') + '</span></td>' +
      '<td style="color:var(--vert);font-weight:700;">' + fmt(percu) + '</td>' +
      '<td>' + fmt(attendu) + '</td>' +
      '<td style="color:' + (reste > 0 ? 'var(--rouge)' : 'var(--vert)') + ';font-weight:700;">' + fmt(reste) + '</td>' +
      '<td>' + badgeStatut[statut] + '</td></tr>';
  }).join('');

  document.getElementById('butoir-resultat').style.display = 'block';
}

function exportButoir() {
  const dateButoir = document.getElementById('date-butoir')?.value || '';
  if (!dateButoir) { showToast('Sélectionnez d\'abord une date butoir', 'warning'); return; }
  const paiementsAvantButoir = STATE.paiements.filter(p => (p.date || '').substring(0, 10) <= dateButoir);
  function percuAvantButoir(eleveId) {
    return paiementsAvantButoir.filter(p => p.eleve_id === eleveId).reduce((s, p) => s + Number(p.montant), 0);
  }
  const data = STATE.eleves.map(e => {
    const attendu = calcAttenduEleve(e);
    const percu = percuAvantButoir(e.id);
    const reste = Math.max(0, attendu - percu);
    const statut = attendu === 0 ? 'Exempté' : percu >= attendu ? 'Soldé' : percu > 0 ? 'Partiel' : 'En retard';
    return { Nom: e.nomPrenoms || e.nom, Matricule: e.matricule, Niveau: e.niveau, Statut_sco: e.statut_sco || '', Paye: percu, Attendu: attendu, Reste: reste, Statut: statut };
  });
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Butoir_' + dateButoir);
  XLSX.writeFile(wb, 'butoir_' + dateButoir + '_' + CONFIG.code_ecole + '.xlsx');
  showToast('Export ✅');
}


// ==================== FONCTIONS NOUVELLES PAGES ====================

// Afficher reçu du dernier paiement enregistré
function afficherRecuDernier() {
  const p = STATE._paiement?.data;
  const el = STATE._paiement?.eleve_data;
  if (!p) { showToast('Aucun paiement récent', 'warning'); return; }
  afficherRecu(p, el);
}

// Envoyer SMS du dernier paiement
function envoyerSMSDernier() {
  const p = STATE._paiement?.data;
  const el = STATE._paiement?.eleve_data;
  if (!p || !el) { showToast('Aucun paiement récent', 'warning'); return; }
  envoyerSMSPaiement(p, el);
}

// showPage est défini de manière complète au début du fichier — pas de patch nécessaire

// La zone succès paiement est gérée directement dans enregistrerPaiement

// renderRetardsButoir gère déjà l'affichage de butoir-stats-zone


// ==================== PARAMÈTRES ====================
function renderParametres() {
  // Remplir les champs depuis CONFIG
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
  set('param-code', CONFIG.code_ecole);
  set('param-nom', CONFIG.nom_ecole);
  set('param-annee', CONFIG.annee);
  set('param-adresse', CONFIG.adresse);
  set('param-ville', CONFIG.ville);
  set('param-tel', CONFIG.tel);
  set('param-email', CONFIG.email);
  set('param-fondateur-nom', CONFIG.fondateur.nom);
  set('param-fondateur-login', CONFIG.fondateur.login);
  set('param-econome-nom', CONFIG.econome.nom);
  set('param-econome-login', CONFIG.econome.login);

  // Type et statut
  const selType = document.getElementById('param-type');
  if (selType) selType.value = CONFIG.type_ecole || 'Lycée';
  const selStatut = document.getElementById('param-statut');
  if (selStatut) selStatut.value = CONFIG.statut_ecole || 'Privé';

  // Logo
  const logoData = localStorage.getItem('logo_' + CONFIG.code_ecole);
  if (logoData) {
    const img = document.getElementById('logo-preview');
    const ph = document.getElementById('logo-placeholder');
    if (img) { img.src = logoData; img.style.display = 'block'; }
    if (ph) ph.style.display = 'none';
  }

  // Niveaux
  const niveauxDiv = document.getElementById('param-niveaux-display');
  if (niveauxDiv) niveauxDiv.innerHTML = CONFIG.niveaux.map(n =>
    '<span class="badge badge-bleu" style="font-size:13px;padding:6px 12px;">' + n + '</span>'
  ).join(' ');
  const examDiv = document.getElementById('param-examen-display');
  if (examDiv) examDiv.textContent = CONFIG.classes_examen.join(', ');

  // Stats
  const nbEl = document.getElementById('param-nb-eleves');
  const nbPai = document.getElementById('param-nb-paiements');
  if (nbEl) nbEl.textContent = STATE.eleves.length + ' élève(s)';
  if (nbPai) nbPai.textContent = STATE.paiements.length + ' paiement(s)';

  // Zone danger — Fondateur uniquement (injection HTML si pas encore présent)
  let zoneDanger = document.getElementById('zone-danger-fondateur');
  if (!zoneDanger) {
    // Créer la section et l'injecter dans la page paramètres
    const pageParam = document.getElementById('page-parametres') || document.querySelector('.page-content');
    if (pageParam) {
      const div = document.createElement('div');
      div.id = 'zone-danger-fondateur';
      div.innerHTML = `
        <div style="margin-top:32px;border:2px solid #e74c3c;border-radius:12px;padding:24px;background:#fff5f5;">
          <h3 style="color:#e74c3c;margin:0 0 8px;font-size:16px;">⚠️ Zone Fondateur — Actions sensibles</h3>
          <p style="color:#888;font-size:13px;margin:0 0 20px;">Ces actions sont irréversibles. Réservées exclusivement au Fondateur.</p>
          <div style="display:flex;gap:12px;flex-wrap:wrap;">
            <button onclick="cloturerAnnee()" style="background:#e67e22;color:#fff;border:none;border-radius:8px;padding:12px 20px;font-size:14px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:8px;">
              📦 Clôturer l'année ${CONFIG.annee}
            </button>
            <button onclick="confirmerResetTotal()" style="background:#e74c3c;color:#fff;border:none;border-radius:8px;padding:12px 20px;font-size:14px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:8px;">
              🗑️ Réinitialisation totale
            </button>
          </div>
          <p style="color:#e74c3c;font-size:12px;margin:12px 0 0;">🔴 Réinitialisation totale = suppression DÉFINITIVE de toutes les données (élèves, paiements, caisse...)</p>
        </div>`;
      pageParam.appendChild(div);
      zoneDanger = div;
    }
  }
  if (zoneDanger) zoneDanger.style.display = STATE.user === 'fondateur' ? 'block' : 'none';
}

// ==================== RESET TOTAL ====================
async function confirmerResetTotal() {
  if (STATE.user !== 'fondateur') { showToast('Accès réservé au Fondateur', 'error'); return; }
  const ok1 = confirm('⚠️ ATTENTION — Cette action va supprimer TOUTES les données :\n\n• Tous les élèves\n• Tous les paiements\n• Toute la caisse\n• Tous les échéanciers\n• Tous les tarifs\n\nCette action est IRRÉVERSIBLE.\n\nConfirmez-vous ?');
  if (!ok1) return;
  const saisie = prompt('Pour confirmer, tapez exactement : RESET');
  if (saisie !== 'RESET') { showToast('Reset annulé — mot de confirmation incorrect', 'warning'); return; }
  showToast('⏳ Réinitialisation en cours...', 'info');
  try {
    const etab = encodeURIComponent(CONFIG.nom_ecole);
    const annee = encodeURIComponent(CONFIG.annee);
    // Supprimer dans Supabase
    await Promise.allSettled([
      SB.delete('paiements', '?etablissement=eq.' + etab),
      SB.delete('journal_caisse', '?etablissement=eq.' + etab),
      SB.delete('echeancier', '?etablissement=eq.' + etab + '&annee_scolaire=eq.' + annee),
      SB.delete('tarifs', '?etablissement=eq.' + etab),
    ]);
    // Réinitialiser STATE
    STATE.paiements = [];
    STATE.caisse = [];
    STATE.types_frais = { inscription_echeances: [], scolarite_echeances: [] };
    STATE.tarifs = {};
    STATE.reductions = [];
    save();
    refreshDashboard(); updateRetardsBadge();
    showToast('✅ Réinitialisation terminée — Base de données vidée', 'success');
  } catch(e) {
    showToast('Erreur lors du reset: ' + e.message, 'error');
  }
}

// ==================== ARCHIVE FIN D'ANNEE ====================
async function cloturerAnnee() {
  if (STATE.user !== 'fondateur') { showToast('Accès réservé au Fondateur', 'error'); return; }
  const ok1 = confirm('📦 CLÔTURE ANNÉE ' + CONFIG.annee + '\n\nCette opération va :\n• Archiver tous les élèves et paiements\n• Calculer les crédits et dettes de chaque élève\n• Préparer la nouvelle année\n\nContinuer ?');
  if (!ok1) return;

  showToast('⏳ Calcul des crédits/dettes en cours...', 'info');

  // Calculer crédit/dette pour chaque élève
  const reports = STATE.eleves.map(e => {
    const attendu = calcAttenduEleve(e);
    const percu = calcPercuEleve(e.id);
    const solde = percu - attendu; // positif = crédit, négatif = dette
    return { matricule: e.matricule, nom: e.nomPrenoms || e.nom, niveau: e.niveau,
      annee: CONFIG.annee, solde_reporte: solde, etablissement: CONFIG.nom_ecole };
  }).filter(r => r.solde_reporte !== 0); // ne garder que ceux avec écart

  // Résumé avant confirmation
  const credits = reports.filter(r => r.solde_reporte > 0);
  const dettes = reports.filter(r => r.solde_reporte < 0);
  const ok2 = confirm(
    '📊 Résumé de clôture ' + CONFIG.annee + ':\n\n' +
    '• ' + STATE.eleves.length + ' élèves archivés\n' +
    '• ' + STATE.paiements.length + ' paiements archivés\n' +
    '• ' + credits.length + ' élèves avec crédit à reporter\n' +
    '• ' + dettes.length + ' élèves avec dette à reporter\n\n' +
    'Valider la clôture définitive ?'
  );
  if (!ok2) return;

  try {
    // Sauvegarder les reports dans Supabase
    if (reports.length > 0) {
      await SB.upsert('credits_reports', reports, 'matricule,annee,etablissement');
    }
    showToast('✅ Année ' + CONFIG.annee + ' clôturée — ' + reports.length + ' reports enregistrés', 'success');
  } catch(e) {
    // La table credits_reports n'existe peut-être pas encore
    console.warn('cloturerAnnee:', e.message);
    showToast('⚠️ Reports sauvegardés localement (créez la table credits_reports dans Supabase)', 'warning');
  }
  // Sauvegarder les reports en localStorage en attendant
  try { localStorage.setItem('reports_' + CONFIG.annee + '_' + CONFIG.code_ecole, JSON.stringify(reports)); } catch(e) {}
}

// Vérifier au login si l'élève a un report (crédit ou dette) de l'année précédente
async function verifierReportEleve(matricule) {
  try {
    const etab = encodeURIComponent(CONFIG.nom_ecole);
    const mat = encodeURIComponent(matricule);
    const data = await SB.select('credits_reports', '?matricule=eq.' + mat + '&etablissement=eq.' + etab + '&order=annee.desc&limit=1');
    if (!Array.isArray(data) || !data.length) return null;
    const r = data[0];
    if (r.annee === CONFIG.annee) return null; // même année, pas un report
    return r; // { matricule, nom, annee, solde_reporte, etablissement }
  } catch(e) { 
    // Fallback localStorage
    const key = 'reports_' + CONFIG.annee_precedente + '_' + CONFIG.code_ecole;
    try {
      const local = JSON.parse(localStorage.getItem(key) || '[]');
      return local.find(r => r.matricule === matricule) || null;
    } catch(e2) { return null; }
  }
}

function sauvegarderParametres() {
  if (!exigeRole('config')) return;
  const get = id => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  const nom = get('param-nom');
  if (!nom) { showToast('Le nom de l\'établissement est obligatoire', 'error'); return; }

  // Mettre à jour CONFIG en mémoire
  CONFIG.code_ecole = get('param-code') || CONFIG.code_ecole;
  CONFIG.nom_ecole = nom;
  CONFIG.type_ecole = get('param-type') || CONFIG.type_ecole;
  CONFIG.statut_ecole = get('param-statut') || CONFIG.statut_ecole;
  CONFIG.annee = get('param-annee') || CONFIG.annee;
  CONFIG.adresse = get('param-adresse');
  CONFIG.ville = get('param-ville');
  CONFIG.tel = get('param-tel');
  CONFIG.email = get('param-email');
  CONFIG.fondateur.nom = get('param-fondateur-nom') || CONFIG.fondateur.nom;
  CONFIG.fondateur.login = get('param-fondateur-login') || CONFIG.fondateur.login;
  const fondPass = get('param-fondateur-pass');
  if (fondPass) CONFIG.fondateur.password = fondPass;
  CONFIG.econome.nom = get('param-econome-nom') || CONFIG.econome.nom;
  CONFIG.econome.login = get('param-econome-login') || CONFIG.econome.login;
  const ecoPass = get('param-econome-pass');
  if (ecoPass) CONFIG.econome.password = ecoPass;

  // Sauvegarder la config dans localStorage pour persistance
  try {
    localStorage.setItem('config_override_' + CONFIG.code_ecole, JSON.stringify({
      code_ecole: CONFIG.code_ecole, nom_ecole: CONFIG.nom_ecole,
      type_ecole: CONFIG.type_ecole, statut_ecole: CONFIG.statut_ecole,
      annee: CONFIG.annee, adresse: CONFIG.adresse, ville: CONFIG.ville,
      tel: CONFIG.tel, email: CONFIG.email,
      fondateur: { nom: CONFIG.fondateur.nom, login: CONFIG.fondateur.login, password: CONFIG.fondateur.password },
      econome: { nom: CONFIG.econome.nom, login: CONFIG.econome.login, password: CONFIG.econome.password }
    }));
  } catch(e) {}

  // Mettre à jour l'interface
  const sn = document.getElementById('school-name-display');
  if (sn) sn.textContent = CONFIG.nom_ecole;
  const ds = document.getElementById('dashboard-subtitle');
  if (ds) ds.textContent = CONFIG.nom_ecole + ' — Année ' + CONFIG.annee;
  const le = document.getElementById('login-ecole-display');
  if (le) le.textContent = CONFIG.nom_ecole;

  save();
  showToast('✅ Paramètres sauvegardés — Rechargez pour appliquer les mots de passe');
}

function previewLogo(event) {
  const file = event.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const data = e.target.result;
    const img = document.getElementById('logo-preview');
    const ph = document.getElementById('logo-placeholder');
    if (img) { img.src = data; img.style.display = 'block'; }
    if (ph) ph.style.display = 'none';
    try { localStorage.setItem('logo_' + CONFIG.code_ecole, data); } catch(e) {}
    showToast('Logo enregistré ✅');
  };
  reader.readAsDataURL(file);
}

function viderDonneesLocales() {
  if (!exigeRole('config')) return;
  if (!confirm('⚠️ Vider TOUTES les données locales (élèves, paiements, caisse) ?\nLes données Supabase ne seront PAS supprimées.')) return;
  STATE.eleves = []; STATE.paiements = []; STATE.caisse = [];
  STATE.depenses = []; STATE.reductions = []; STATE.tarifs = {};
  STATE.banque = { compte: null, mouvements: [] };
  save();
  renderEleves(); refreshDashboard();
  showToast('Données locales vidées — Synchronisez pour recharger depuis Supabase', 'warning');
}

// Charger config overrides au démarrage
function loadConfigOverride() {
  try {
    const key = 'config_override_' + CONFIG.code_ecole;
    const saved = localStorage.getItem(key);
    if (saved) {
      const c = JSON.parse(saved);
      Object.assign(CONFIG, c);
      if (c.fondateur) Object.assign(CONFIG.fondateur, c.fondateur);
      if (c.econome) Object.assign(CONFIG.econome, c.econome);
    }
  } catch(e) {}
}

// showPage gère déjà les paramètres — pas de patch supplémentaire

// Appeler au chargement
document.addEventListener('DOMContentLoaded', () => {
  loadConfigOverride();
});

