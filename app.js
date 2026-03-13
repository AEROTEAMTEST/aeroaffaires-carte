
// ── CONFIG ───────────────────────────────────────────────────────────────────
const SHEET_ID  = '1mbG7kB7M2n1U1FY-FmCy1F-W4OxSvuUp7eoQsssm0E4';
const SHEET_GID = '1402952697'; // GID exact de l'onglet MyMaps
// CSV export — évite tous les problèmes de formatage de l'API gviz
const API_URL   = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET_GID}`;

// ── STATE ────────────────────────────────────────────────────────────────────
let operators = [];
let markers   = {};
let map;
let activeNom = null;
let currentFilter = 'all';

// ── MAP INIT ─────────────────────────────────────────────────────────────────
window.addEventListener('load', () => {
  map = L.map('map', { zoomControl: true, worldCopyJump: true }).setView([30, 10], 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap', maxZoom: 18
  }).addTo(map);

  const searchInput = document.getElementById('search');
  const suggBox     = document.getElementById('location-suggestions');

  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    const q = searchInput.value.trim();
    suggBox.style.display = 'none';
    renderSidebar();
    renderMarkers();
    if (q.length >= 2) {
      searchTimeout = setTimeout(() => searchLocation(q), 500);
    }
  });

  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      suggBox.style.display = 'none';
      searchInput.value = '';
      renderSidebar();
      renderMarkers();
      clearLocation();
    }
  });

  document.addEventListener('click', e => {
    if (!searchInput.contains(e.target) && !suggBox.contains(e.target)) {
      suggBox.style.display = 'none';
    }
  });

  loadData();
});

// ── LOAD DATA FROM GOOGLE SHEETS ─────────────────────────────────────────────
async function loadData() {
  const loadStart = Date.now();
  const btn = document.getElementById('btn-refresh');
  btn.classList.add('loading');
  btn.textContent = '↻ Chargement…';

  try {
    // CSV export : données brutes sans formatage Google Sheets
    const res  = await fetch(API_URL + '&t=' + Date.now());
    const text = await res.text();

    // Parser CSV proprement (gère les guillemets et virgules)
    const parseCSV = (str) => {
      const rows = [];
      // Gère les sauts de ligne dans les cellules entre guillemets
      let i = 0, cols = [], cur = '', inQ = false;
      while (i <= str.length) {
        const ch = str[i];
        if (ch === undefined) { // fin de fichier
          cols.push(cur.replace(/^"|"$/g, '').trim());
          if (cols.some(c => c)) rows.push(cols);
          break;
        }
        if (ch === '"') {
          if (inQ && str[i+1] === '"') { cur += '"'; i += 2; continue; } // guillemet échappé ""
          inQ = !inQ; i++; continue;
        }
        if (ch === ',' && !inQ) {
          cols.push(cur.replace(/^"|"$/g, '').trim()); cur = ''; i++; continue;
        }
        if ((ch === '\r' || ch === '\n') && !inQ) {
          if (ch === '\r' && str[i+1] === '\n') i++;
          cols.push(cur.replace(/^"|"$/g, '').trim());
          if (cols.some(c => c)) rows.push(cols);
          cols = []; cur = ''; i++; continue;
        }
        cur += ch; i++;
      }
      return rows;
    };

    const allRows = parseCSV(text);
    if (allRows.length < 2) throw new Error('CSV vide');

    const headers = allRows[0].map(h => h.toLowerCase().replace(/"/g, ''));
    const dataRows = allRows.slice(1);

    const idx = {
      nom:    headers.findIndex(c => c.includes('nom')),
      base:   headers.findIndex(c => c.includes('base')),
      natio:  headers.findIndex(c => c.includes('nation') || c.includes('pays')),
      tel:    headers.findIndex(c => c.includes('phone') || c.includes('tel')),
      email:  headers.findIndex(c => c.includes('email') || c.includes('mail')),
      lat:    headers.findIndex(c => c === 'lat'),
      lng:    headers.findIndex(c => c === 'lng'),
      flotte: headers.findIndex(c => c.includes('flotte') || c.includes('fleet')),
    };

    console.log('Headers CSV:', headers);
    console.log('Index colonnes:', idx);

    const getVal = (row, i) => i >= 0 && row[i] ? row[i].replace(/^"|"$/g, '').trim() : '';
    const getCoord = (row, i) => {
      const v = getVal(row, i);
      if (!v) return NaN;
      // Nettoyer : supprimer espaces, remplacer virgule par point
      const clean = v.replace(/\s/g, '').replace(',', '.');
      const n = parseFloat(clean);
      return (isNaN(n) || Math.abs(n) > 180) ? NaN : n;
    };

    operators = dataRows
      .filter(r => r[idx.nom] && r[idx.nom].trim())
      .map((r, i) => ({
        id:    'op_' + i,
        nom:   getVal(r, idx.nom),
        base:  getVal(r, idx.base),
        natio: getVal(r, idx.natio),
        tel:   getVal(r, idx.tel),
        email: getVal(r, idx.email),
        lat:    getCoord(r, idx.lat),
        lng:    getCoord(r, idx.lng),
        flotte: getVal(r, idx.flotte),
      }))
      .filter(o => o.nom);

    console.log('Total opérateurs:', operators.length, '— Avec coords:', operators.filter(o => !isNaN(o.lat)).length);

    buildFilters();
    renderSidebar();
    renderMarkers();
    updateCounters();

    const elapsed = Date.now() - loadStart;
    const delay = Math.max(0, 3000 - elapsed);
    setTimeout(() => document.getElementById('loader').classList.add('hidden'), delay);
    showToast(`✓ ${operators.length} bases chargées depuis Google Sheets`);

  } catch(e) {
    console.error(e);
    document.getElementById('loader-text').textContent = '⚠ Erreur de chargement — vérifiez que le sheet est public';
    showToast('⚠ Erreur de chargement');
  }

  btn.classList.remove('loading');
  btn.textContent = '↻ Actualiser';
}

// ── FILTERS ──────────────────────────────────────────────────────────────────
let currentModele = 'all';

function buildFilters() {
  const pays = [...new Set(operators.map(o => o.natio).filter(Boolean))].sort();
  const wrap = document.getElementById('filter-btns');
  wrap.innerHTML = `<button class="filt active" data-f="all" onclick="setFilter('all',this)">Tous</button>`;
  pays.slice(0, 8).forEach(p => {
    const b = document.createElement('button');
    b.className = 'filt';
    b.dataset.f = p;
    b.textContent = p;
    b.onclick = () => setFilter(p, b);
    wrap.appendChild(b);
  });

  // Construire la liste des modèles uniques depuis les flottes
  const modeles = [...new Set(
    operators
      .map(o => o.flotte).filter(Boolean)
      .flatMap(f => f.split('|').map(a => a.trim().split(/\s+/)[0]))
      .filter(Boolean)
  )].sort();

  const sel = document.getElementById('filter-modele');
  if (!sel) return;
  sel.innerHTML = `<option value="all">🚁 Tous les modèles</option>`;
  modeles.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    sel.appendChild(opt);
  });
  sel.onchange = () => { currentModele = sel.value; renderSidebar(); renderMarkers(); };
}

function setFilter(f, btn) {
  currentFilter = f;
  document.querySelectorAll('.filt').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderSidebar();
  renderMarkers();
}

function getFiltered() {
  const q = document.getElementById('search').value.toLowerCase();
  return operators.filter(o => {
    const matchF = currentFilter === 'all' || o.natio === currentFilter;
    const matchQ = !q || [o.nom, o.base, o.natio, o.email].some(v => v && v.toLowerCase().includes(q));
    const matchM = currentModele === 'all' || (
      o.flotte && o.flotte.split('|').some(a => a.trim().split(/\s+/)[0] === currentModele)
    );
    return matchF && matchQ && matchM;
  });
}

// ── SIDEBAR ──────────────────────────────────────────────────────────────────
function renderSidebar() {
  const filtered = getFiltered();
  document.getElementById('sidebar-count').textContent = `${filtered.length} résultat${filtered.length > 1 ? 's' : ''}`;

  const list = document.getElementById('op-list');
  if (!filtered.length) {
    list.innerHTML = '<div class="empty">Aucun résultat</div>';
    return;
  }

  // Grouper par nom d'opérateur
  const grouped = {};
  filtered.forEach(o => {
    if (!grouped[o.nom]) grouped[o.nom] = [];
    grouped[o.nom].push(o);
  });

  list.innerHTML = Object.entries(grouped).map(([nom, ops]) => {
    const first = ops[0];
    const isActive = activeNom && ops.some(o => o.nom === activeNom);
    const bases = ops.map(o => o.base).filter(Boolean);
    return `
      <div class="op-item ${isActive ? 'active' : ''}" onclick="selectGroup('${nom.replace(/'/g,'\\\'')}')" onmouseenter="highlightGroup('${nom.replace(/'/g,'\\\'')}')" onmouseleave="unhighlightGroup()">
        <div class="op-name">🚁 ${nom}</div>
        <div class="op-base">📍 ${first.natio || '—'} · ${ops.length} base${ops.length > 1 ? 's' : ''}</div>
        <div class="op-tags">
          ${bases.slice(0,3).map(b => `<span class="tag">${b.split(' - ')[0].trim()}</span>`).join('')}
          ${bases.length > 3 ? `<span class="tag">+${bases.length - 3}</span>` : ''}
        </div>
      </div>`;
  }).join('');
}

// ── MARKERS ──────────────────────────────────────────────────────────────────
let hoveredNom = null;

function makeIcon(ops) {
  const isActive = activeNom && ops.some(o => o.nom === activeNom);
  const isHL     = hoveredNom && ops.some(o => o.nom === hoveredNom);
  const on = isActive || isHL;
  return L.divIcon({
    className: '',
    html: `<div style="
      width:30px;height:30px;border-radius:50%;
      background:${on ? '#e8b84b' : '#0f1829'};
      border:2px solid ${on ? '#e8b84b' : 'rgba(232,184,75,0.6)'};
      display:flex;align-items:center;justify-content:center;font-size:13px;
      box-shadow:0 0 0 ${on ? '6px' : '3px'} rgba(232,184,75,${on ? '0.35' : '0.1'}),0 4px 12px rgba(0,0,0,0.5);
      cursor:pointer;transition:all 0.2s;
    ">🚁</div>`,
    iconSize:[30,30], iconAnchor:[15,15],
  });
}

function renderMarkers() {
  Object.values(markers).forEach(m => map.removeLayer(m));
  markers = {};

  // Regrouper par position identique
  const byPos = {};
  getFiltered().forEach(o => {
    if (isNaN(o.lat) || isNaN(o.lng)) return;
    const key = o.lat.toFixed(4) + ',' + o.lng.toFixed(4);
    if (!byPos[key]) byPos[key] = [];
    byPos[key].push(o);
  });

  Object.values(byPos).forEach(ops => addMarker(ops));
}

function addMarker(ops) {
  const first = ops[0];
  const noms = [...new Set(ops.map(o => o.nom))];

  const popupHTML = noms.map(nom => {
    const op = ops.find(o => o.nom === nom);
    const nomEsc = nom.replace(/'/g, "\'");
    return `<div style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
      <div class="popup-name">${nom}</div>
      <div class="popup-loc">📍 ${op.base||'—'} · ${op.natio||''}</div>
      ${op.tel   ? `<div class="popup-fleet">📞 ${op.tel}</div>`   : ''}
      ${op.email ? `<div class="popup-fleet">✉ ${op.email}</div>` : ''}
      <button class="popup-btn" style="margin-top:6px" onclick="selectGroup('${nomEsc}')">Voir la fiche →</button>
    </div>`;
  }).join('');

  const m = L.marker([first.lat, first.lng], { icon: makeIcon(ops) }).addTo(map);
  m.bindPopup(L.popup({ offset:[0,-8], closeButton:false, maxWidth:280 })
    .setContent(`<div class="popup-inner">${popupHTML}</div>`));
  m.on('click', () => { if (noms.length === 1) selectGroup(noms[0]); });
  m._ops = ops;
  ops.forEach(o => { markers[o.id] = m; });
}

function highlightGroup(nom) {
  hoveredNom = nom;
  Object.values(markers).forEach(m => { if (m._ops) m.setIcon(makeIcon(m._ops)); });
}

function unhighlightGroup() {
  hoveredNom = null;
  Object.values(markers).forEach(m => { if (m._ops) m.setIcon(makeIcon(m._ops)); });
}

// ── SELECT ────────────────────────────────────────────────────────────────────
function selectGroup(nom) {
  const ops = operators.filter(o => o.nom === nom);
  if (!ops.length) return;

  activeNom = nom;
  renderSidebar();
  renderMarkers();

  // Zoom sur le groupe
  const valid = ops.filter(o => !isNaN(o.lat) && !isNaN(o.lng));
  if (valid.length === 1) {
    map.flyTo([valid[0].lat, valid[0].lng], 8, { duration: 1 });
    if (markers[valid[0].id]) markers[valid[0].id].openPopup();
  } else if (valid.length > 1) {
    const bounds = L.latLngBounds(valid.map(o => [o.lat, o.lng]));
    map.flyToBounds(bounds, { padding: [60, 60], duration: 1 });
  }

  openDetail(nom, ops);
}

function openDetail(nom, ops) {
  document.getElementById('d-name').textContent = nom;
  document.getElementById('d-loc').textContent = `📍 ${ops[0].natio || '—'} · ${ops.length} base${ops.length > 1 ? 's' : ''}`;

  const basesHTML = ops.map(o => `
    <div class="d-fleet-item">
      <span>🏁</span>
      <span style="font-size:12px">${o.base || 'Base non renseignée'}</span>
    </div>`).join('');

  const contacts = [];
  if (ops[0].tel)   contacts.push(`<div class="d-contact"><span>📞</span><a href="tel:${ops[0].tel}">${ops[0].tel}</a></div>`);
  if (ops[0].email) contacts.push(`<div class="d-contact"><span>✉</span><a href="mailto:${ops[0].email}">${ops[0].email}</a></div>`);

  // Flotte — agrégée sur toutes les bases de l'opérateur
  const flotteStr = ops.map(o => o.flotte).filter(Boolean).join(' | ');
  const appareils = flotteStr
    ? [...new Set(flotteStr.split('|').map(a => a.trim()).filter(Boolean))]
    : [];
  const flotteHTML = appareils.length
    ? `<div class="d-section">
        <div class="d-title">🚁 Flotte (${appareils.length})</div>
        ${appareils.map(a => {
          const parts = a.trim().split(/\s+/);
          const modele = parts[0] || '';
          const immat  = parts.slice(1).join(' ');
          return `<div class="d-fleet-item">
            <span>🚁</span>
            <span style="font-size:12px;color:#e8b84b;font-weight:600">${modele}</span>
            ${immat ? `<span style="font-size:11px;color:#6b80a8;font-family:'DM Mono',monospace">${immat}</span>` : ''}
          </div>`;
        }).join('')}
      </div>`
    : '';

  document.getElementById('d-body').innerHTML = `
    <div class="d-section">
      <div class="d-title">🏁 Bases (${ops.length})</div>
      ${basesHTML}
    </div>
    ${flotteHTML}
    ${contacts.length ? `<div class="d-section"><div class="d-title">📞 Contact</div>${contacts.join('')}</div>` : ''}
  `;

  document.getElementById('detail').classList.add('open');
}

function closeDetail() {
  document.getElementById('detail').classList.remove('open');
  activeNom = null;
  renderSidebar();
}

// ── COUNTERS ─────────────────────────────────────────────────────────────────
function updateCounters() {
  const noms = [...new Set(operators.map(o => o.nom))];
  document.getElementById('counter').textContent = `${noms.length} opérateurs`;
  document.getElementById('base-counter').textContent = `${operators.filter(o => !isNaN(o.lat)).length} bases`;
}

// ── DEBUG ────────────────────────────────────────────────────────────────────
async function debugData() {
  let msg = '=== OPÉRATEURS CHARGÉS: ' + operators.length + ' ===\n';
  msg += 'Avec coords: ' + operators.filter(o => !isNaN(o.lat) && !isNaN(o.lng)).length + '\n\n';
  msg += '=== 3 PREMIERS ===\n';
  operators.slice(0, 3).forEach(o => {
    msg += `${o.nom} | ${o.base} | lat=${o.lat} lng=${o.lng}\n`;
  });
  msg += '\n=== SANS COORDS (5 premiers) ===\n';
  operators.filter(o => isNaN(o.lat)).slice(0,5).forEach(o => {
    msg += `${o.nom} | lat=${o.lat} lng=${o.lng}\n`;
  });
  alert(msg);
}

// ── LOCATION SEARCH ──────────────────────────────────────────────────────────
let locationMarker = null;
let locationCircle = null;
let searchTimeout = null;

// location search wired in main listener

async function searchLocation(q) {
  const sugg = document.getElementById('location-suggestions');
  sugg.style.display = 'block';
  sugg.innerHTML = '<div class="loc-item"><span>⏳</span><div><div class="loc-name">Recherche…</div></div></div>';

  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=5&addressdetails=1`;
    const res  = await fetch(url, { headers: { 'Accept-Language': 'fr', 'User-Agent': 'AEROAFFAIRES/1.0' } });
    const data = await res.json();

    if (!data.length) {
      sugg.innerHTML = '<div class="loc-item"><span>❌</span><div><div class="loc-name">Aucun résultat</div></div></div>';
      return;
    }

    sugg.innerHTML = data.map((r, i) => {
      const city    = r.address?.city || r.address?.town || r.address?.village || r.address?.county || '';
      const country = r.address?.country || '';
      const label   = r.display_name.split(',').slice(0,2).join(',');
      const sub     = [city, country].filter(Boolean).join(', ');
      return `<div class="loc-item" onclick="goToLocation(${r.lat}, ${r.lon}, '${label.replace(/'/g,"\'")}')">
        <span>📍</span>
        <div>
          <div class="loc-name">${label}</div>
          ${sub ? `<div class="loc-sub">${sub}</div>` : ''}
        </div>
      </div>`;
    }).join('');

  } catch(e) {
    sugg.innerHTML = '<div class="loc-item"><span>⚠️</span><div><div class="loc-name">Erreur de recherche</div></div></div>';
  }
}

function goToLocation(lat, lng, label) {
  const sugg  = document.getElementById('location-suggestions');
  const input = document.getElementById('search');
  sugg.style.display = 'none';
  input.value = '';
  renderSidebar();
  renderMarkers();

  // Supprimer ancien marker/cercle
  if (locationMarker) { map.removeLayer(locationMarker); locationMarker = null; }
  if (locationCircle) { map.removeLayer(locationCircle); locationCircle = null; }

  lat = parseFloat(lat); lng = parseFloat(lng);

  // Marqueur de position
  locationMarker = L.marker([lat, lng], {
    icon: L.divIcon({
      className: '',
      html: `<div style="
        width:16px;height:16px;border-radius:50%;
        background:#4ea3d4;border:3px solid white;
        box-shadow:0 0 0 4px rgba(78,163,212,0.3),0 4px 12px rgba(0,0,0,0.5);
      "></div>`,
      iconSize:[16,16], iconAnchor:[8,8],
    })
  }).addTo(map);

  // Cercle de 50km
  locationCircle = L.circle([lat, lng], {
    radius: 200000,
    color: '#4ea3d4',
    fillColor: '#4ea3d4',
    fillOpacity: 0.05,
    weight: 1.5,
    dashArray: '6,4',
  }).addTo(map);

  // Zoom
  map.flyTo([lat, lng], 9, { duration: 1.2 });

  // Badge radius
  const badge = document.getElementById('radius-badge');
  if (badge) {
    badge.querySelector('#radius-label').textContent = `📍 ${label} · rayon 200 km`;
    badge.classList.add('show');
  }
}

function clearLocation() {
  if (locationMarker) { map.removeLayer(locationMarker); locationMarker = null; }
  if (locationCircle) { map.removeLayer(locationCircle); locationCircle = null; }
  document.getElementById('search').value = ''; renderSidebar(); renderMarkers();
  const badge = document.getElementById('radius-badge');
  if (badge) badge.classList.remove('show');
}

// ── TOAST ─────────────────────────────────────────────────────────────────────
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

