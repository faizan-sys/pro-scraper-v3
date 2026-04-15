// ================================================================
//  Pro Scraper v3.0 — Popup Script
//  Unified HDD-Scraper + ProScraper, with deduplication
// ================================================================
'use strict';

// ── State ─────────────────────────────────────────────────────────
let tabId      = null;
let collected  = [];
let columns    = [];
let colEnabled = {};
let running    = false;
let t0         = 0;
let candIdx    = 0;
let totalCands = 0;
let pdSkuSet   = new Set();   // ProDisk existing SKUs (loaded from API or CSV)
let pdLoaded   = false;

// ── DOM shortcuts ─────────────────────────────────────────────────
const $  = id => document.getElementById(id);
const el = {
  detect:   $('btnDetect'),
  cycle:    $('btnCycle'),
  start:    $('btnStart'),
  stop:     $('btnStop'),
  csv:      $('btnCSV'),
  xlsx:     $('btnXLSX'),
  gear:     $('btnGear'),
  info:     $('detectInfo'),
  preview:  $('previewWrap'),
  colsWrap: $('colsWrap'),
  chips:    $('chips'),
  nxtInp:   $('nxtInp'),
  nxtDot:   $('nxtDot'),
  svPage:   $('svPage'),
  svTotal:  $('svTotal'),
  svRows:   $('svRows'),
  svETA:    $('svETA'),
  progBar:  $('progBar'),
  dot:      $('dot'),
  msg:      $('msgTxt'),
  siteUrl:  $('siteUrl'),
  mode:     $('modeBadge'),
  settings: $('settingsPane'),
  chkUniq:  $('chkUniq'),
  keyRow:   $('keyRow'),
  selKey:   $('selKey'),
  dStats:   $('dedupStats'),
  dKept:    $('dKept'),
  dDrop:    $('dDrop'),
  // ProDisk filter
  btnLoadApi: $('btnLoadApi'),
  fileCSV:    $('fileCSV'),
  btnClearPD: $('btnClearPD'),
  chkNewOnly: $('chkNewOnly'),
  selPdKey:   $('selPdKey'),
  pdStatus:   $('pdStatus'),
  pdLoadBar:  $('pdLoadBar'),
  pdProg:     $('pdProg'),
  pdLoadMsg:  $('pdLoadMsg'),
  pdResult:   $('pdResult'),
  pdNew:      $('pdNew'),
  pdHave:     $('pdHave')
};

// ── Init ──────────────────────────────────────────────────────────
chrome.tabs.query({ active:true, currentWindow:true }, ([tab]) => {
  if (!tab) return;
  tabId = tab.id;
  try { el.siteUrl.textContent = new URL(tab.url).hostname; } catch(e) {}

  send({ action:'ping' }, r => {
    if (!r?.ok) { setMsg('Refresh the page, then reopen', 'err'); el.detect.disabled = true; return; }

    // Show site mode badge
    if (r.mode === 'hdd') {
      el.mode.textContent = 'HDD DIRECT';
      el.mode.style.background = '#064e3b';
      el.mode.style.color = '#6ee7b7';
    } else {
      el.mode.textContent = 'GENERIC';
    }
    setMsg('Ready — click Detect', '');

    // Resume if scraping was running
    send({ action:'status' }, st => {
      if (st?.scraping) { running = true; setRunState(true); updateStats(st.page, st.totalPages, st.collected, st.totalPages); }
    });
  });
});

// ── Detect ────────────────────────────────────────────────────────
el.detect.addEventListener('click', () => {
  setMsg('Scanning…', '');
  el.detect.disabled = true;
  send({ action:'detect' }, r => {
    el.detect.disabled = false;
    if (!r?.count) { setMsg('Nothing found — try a listing/category page', 'err'); el.info.textContent = 'No repeating data detected'; return; }
    totalCands = r.count;
    candIdx    = 0;
    applyCandidate(r.candidates[0]);
    el.cycle.disabled = r.count < 2;
    checkNextBtn();
    setMsg(`Found ${r.candidates[0].rows} rows — review columns, then Start`, '');
  });
});

function applyCandidate(c) {
  if (!c) return;
  el.info.innerHTML = `<b>${c.rows}</b> rows × <b>${c.columns}</b> cols &nbsp;·&nbsp; <b>${c.type}</b>`;
  columns    = c.sampleHeaders || [];
  colEnabled = {};
  columns.forEach(col => colEnabled[col] = true);
  buildChips();
  buildPreview(c.sampleRows || []);
  populateKeyDropdown(columns);
}

// ── Cycle candidates ──────────────────────────────────────────────
el.cycle.addEventListener('click', () => {
  if (totalCands < 2) return;
  candIdx = (candIdx + 1) % totalCands;
  send({ action:'detect' }, r => {
    if (!r?.candidates?.[candIdx]) return;
    send({ action:'setActive', index: candIdx }, () => {});
    applyCandidate(r.candidates[candIdx]);
    checkNextBtn();
  });
});

// ── Column chips ──────────────────────────────────────────────────
function buildChips() {
  el.chips.innerHTML = '';
  el.colsWrap.style.display = columns.length ? 'block' : 'none';
  columns.forEach(col => {
    const chip = document.createElement('div');
    chip.className = 'chip' + (colEnabled[col] ? '' : ' off');
    chip.innerHTML = `<input type="checkbox" ${colEnabled[col]?'checked':''}/> ${esc(col)}`;
    chip.querySelector('input').addEventListener('change', e => {
      colEnabled[col] = e.target.checked;
      chip.className = 'chip' + (e.target.checked ? '' : ' off');
    });
    el.chips.appendChild(chip);
  });
}

$('colAll').addEventListener('click',  e => { e.preventDefault(); columns.forEach(c=>colEnabled[c]=true);  buildChips(); });
$('colNone').addEventListener('click', e => { e.preventDefault(); columns.forEach(c=>colEnabled[c]=false); buildChips(); });

// ── Preview table ─────────────────────────────────────────────────
function buildPreview(rows) {
  if (!rows?.length) { el.preview.innerHTML = '<div class="p-empty">No preview</div>'; return; }
  const cols = columns.length ? columns : Object.keys(rows[0] || {});
  let h = '<table class="ptbl"><thead><tr>';
  cols.forEach(c => h += `<th>${esc(c)}</th>`);
  h += '</tr></thead><tbody>';
  rows.slice(0,8).forEach(row => {
    h += '<tr>';
    cols.forEach(c => {
      const v = String(row[c]||'');
      if ((c.toLowerCase().includes('image')||c==='img') && v.startsWith('http'))
        h += `<td><img src="${esc(v)}" style="height:24px;width:auto;border-radius:2px" onerror="this.style.display='none'"/></td>`;
      else
        h += `<td title="${esc(v)}">${esc(v.slice(0,55))}</td>`;
    });
    h += '</tr>';
  });
  h += '</tbody></table>';
  el.preview.innerHTML = h;
}

// ── Check next button ─────────────────────────────────────────────
function checkNextBtn() {
  send({ action:'findNext' }, r => {
    el.nxtDot.className = 'nxt-dot' + (r?.found ? ' ok' : '');
    el.nxtInp.value = r?.found ? (r.selector||'Auto-detected') : '';
  });
}

// ── Start / Stop ──────────────────────────────────────────────────
el.start.addEventListener('click', () => {
  if (running) return;
  collected = [];
  t0 = Date.now();
  running = true;
  setRunState(true);
  setMsg('Starting…', 'run');

  send({
    action:   'start',
    settings: readSettings(),
    reDetect: false
  }, r => {
    if (!r?.ok) { setMsg('Failed — refresh & retry', 'err'); setRunState(false); running = false; }
  });
});

el.stop.addEventListener('click', () => {
  send({ action:'stop' }, () => setMsg('Stopping after this page…','') );
});

// ── Messages from content ─────────────────────────────────────────
chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'started') {
    updateStats(1, msg.totalPages, 0, msg.totalPages);
    setMsg('Scraping page 1…', 'run');
  }

  if (msg.type === 'progress') {
    const elapsed = (Date.now()-t0)/1000;
    const pps = msg.page / elapsed;
    const rem = msg.totalPages > 0 ? (msg.totalPages - msg.page) / pps : 0;
    updateStats(msg.page, msg.totalPages, msg.collected, msg.totalPages);
    el.svETA.textContent = rem > 0 ? fmtTime(rem) : '—';
    setMsg(`Page ${msg.page}/${msg.totalPages||'?'} — ${msg.pageRows} rows`, 'run');
    if (msg.sampleRows?.length) buildPreview(msg.sampleRows);
  }

  if (msg.type === 'done') {
    running = false;
    collected = msg.data || [];
    setRunState(false);
    el.progBar.style.width = '100%';
    el.csv.disabled  = false;
    el.xlsx.disabled = false;
    setMsg(`Done — ${msg.total} rows. ${({no_next:'No more pages',identical_page:'Last page reached',stopped:'Stopped',complete:'Complete!'})[msg.reason]||''}`, 'done');
    updateStats(msg.total, msg.total, msg.total, msg.total);
    // Fetch final data, then show dedup + ProDisk badges
    send({ action:'getData' }, r => {
      if (r?.data?.length) {
        collected = r.data;
        showDedupBadge(collected);
        updatePdResult(collected);   // auto-show new SKU count if filter is loaded
      }
    });
  }

  if (msg.type === 'error') {
    running = false;
    setRunState(false);
    setMsg('Error: ' + msg.message, 'err');
    send({ action:'getData' }, r => {
      if (r?.data?.length) {
        collected = r.data;
        el.csv.disabled  = false;
        el.xlsx.disabled = false;
        setMsg(msg.message + ` (${collected.length} rows saved)`, 'err');
      }
    });
  }
});

// ── Downloads ─────────────────────────────────────────────────────
el.csv.addEventListener('click', () => {
  if (!collected.length) { send({action:'getData'}, r => r?.data?.length && downloadCSV(r.data)); return; }
  downloadCSV(collected);
});
el.xlsx.addEventListener('click', () => {
  if (!collected.length) { send({action:'getData'}, r => r?.data?.length && downloadXLSX(r.data)); return; }
  downloadXLSX(collected);
});

function applyDedup(data) {
  if (!el.chkUniq.checked || !data.length) return data;
  const keyCol = el.selKey.value;
  const seen   = new Set();
  const out    = [];
  let   drops  = 0;
  data.forEach(row => {
    let k;
    if (keyCol === '_auto') {
      const fc = Object.keys(row).find(c => c !== '_page' && row[c]);
      k = fc ? String(row[fc]).trim().toLowerCase() : JSON.stringify(row);
    } else {
      k = String(row[keyCol]??'').trim().toLowerCase();
    }
    if (!k || seen.has(k)) { drops++; } else { seen.add(k); out.push(row); }
  });
  el.dKept.textContent  = out.length;
  el.dDrop.textContent  = drops;
  el.dStats.style.display = 'block';
  return out;
}

function getEnabledCols(data) {
  if (!data.length) return [];
  const all = Object.keys(data[0]).filter(k => k !== '_page');
  const en  = all.filter(c => colEnabled[c] !== false);
  return en.length ? en : all;
}

function prepareExportData(raw) {
  // Step 1: Dedup
  let data = applyDedup(raw);
  // Step 2: ProDisk new-only filter
  if (el.chkNewOnly.checked && pdLoaded && pdSkuSet.size) {
    const r = applyPdFilter(data);
    if (r.newRows !== undefined) {
      data = r.newRows;
      el.pdNew.textContent  = r.newRows.length.toLocaleString();
      el.pdHave.textContent = r.haveRows.length.toLocaleString();
      el.pdResult.style.display = 'block';
    }
  }
  return data;
}

function downloadCSV(raw) {
  const data  = prepareExportData(raw);
  const cols  = getEnabledCols(data);
  const rows  = data.map(r => cols.map(c => csvEsc(r[c]??'')));
  const csv   = [cols, ...rows].map(r=>r.join(',')).join('\r\n');
  const tag   = [el.chkUniq.checked?'_unique':'', el.chkNewOnly.checked?'_new':''].join('');
  trigger('\uFEFF'+csv, 'scrape'+tag+'_'+today()+'.csv', 'text/csv');
}

function downloadXLSX(raw) {
  const data  = prepareExportData(raw);
  const cols  = getEnabledCols(data);
  const rows  = data.map(r => cols.map(c => String(r[c]??'')));
  const tsv   = [cols, ...rows].map(r=>r.join('\t')).join('\r\n');
  const tag   = [el.chkUniq.checked?'_unique':'', el.chkNewOnly.checked?'_new':''].join('');
  trigger('\uFEFF'+tsv, 'scrape'+tag+'_'+today()+'.xlsx','application/vnd.ms-excel');
}

function trigger(content, name, mime) {
  const a   = document.createElement('a');
  a.href    = URL.createObjectURL(new Blob([content], {type:mime+';charset=utf-8;'}));
  a.download = name;
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href), 2000);
}

// ── Dedup UI ──────────────────────────────────────────────────────
el.chkUniq.addEventListener('change', function() {
  el.keyRow.style.display   = this.checked ? 'flex' : 'none';
  if (this.checked && collected.length) showDedupBadge(collected);
  else el.dStats.style.display = 'none';
});

function showDedupBadge(data) {
  if (!el.chkUniq.checked || !data.length) { el.dStats.style.display='none'; return; }
  applyDedup(data); // updates badge as side effect
}

function populateKeyDropdown(cols) {
  // Dedup key dropdown
  const s = el.selKey;
  while (s.options.length > 1) s.remove(1);
  cols.forEach(col => {
    const o = document.createElement('option');
    o.value = col; o.textContent = col;
    if (/part|sku|id|number|code|model/i.test(col) && s.value==='_auto') o.selected = true;
    s.appendChild(o);
  });

  // ProDisk compare column dropdown
  const ps = el.selPdKey;
  while (ps.options.length > 1) ps.remove(1);
  cols.forEach(col => {
    const o = document.createElement('option');
    o.value = col; o.textContent = col;
    // Auto-select the most likely part/SKU column
    if (/part|sku|number|code|model/i.test(col) && ps.value === '_auto') o.selected = true;
    ps.appendChild(o);
  });
}

// ── Settings ──────────────────────────────────────────────────────
el.gear.addEventListener('click', () => {
  el.settings.classList.toggle('open');
  el.gear.style.color = el.settings.classList.contains('open') ? '#3b82f6' : '';
});

function readSettings() {
  return {
    minDelay:      parseInt($('sMin').value)||1200,
    maxDelay:      parseInt($('sMax').value)||2800,
    maxPages:      parseInt($('sPages').value)||500,
    waitStrategy:  $('sWait').value,
    includeImages: $('sImgs').checked,
    includeLinks:  $('sLinks').checked,
    uniqueOnly:    el.chkUniq.checked,
    uniqueKey:     el.selKey.value
  };
}

// ── Helpers ───────────────────────────────────────────────────────
function send(msg, cb) {
  if (!tabId) { cb?.(null); return; }
  chrome.tabs.sendMessage(tabId, msg, r => {
    if (chrome.runtime.lastError) { cb?.(null); return; }
    cb?.(r);
  });
}

function setRunState(on) {
  el.start.disabled  = on;
  el.stop.disabled   = !on;
  el.csv.disabled    = on;
  el.xlsx.disabled   = on;
  el.detect.disabled = on;
}

function updateStats(page, total, rows, tp) {
  el.svPage.textContent  = page||'—';
  el.svTotal.textContent = total||'—';
  el.svRows.textContent  = rows||0;
  if (tp>0&&page>0) el.progBar.style.width = Math.min(100,Math.round(page/tp*100))+'%';
}

function setMsg(txt, type) {
  el.msg.textContent = txt;
  el.dot.className = 'dot'+(type?' '+type:'');
}

function fmtTime(s) { return s<60 ? Math.round(s)+'s' : Math.floor(s/60)+'m '+Math.round(s%60)+'s'; }
function today()    { return new Date().toISOString().slice(0,10); }
function csvEsc(v)  { const s=String(v).replace(/"/g,'""'); return /[,"\n\r]/.test(s)?'"'+s+'"':s; }
function esc(s)     { return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ================================================================
//  PRODISK NEW SKU FILTER
// ================================================================

const PD_API = 'https://api.prodisknetwork.com/api/price-list.php';
const PD_STORE_KEY = 'pdSkuSet';

// ── Restore cached SKUs on popup open ────────────────────────────
chrome.storage.local.get([PD_STORE_KEY, 'pdSkuCount', 'pdLoadedAt'], res => {
  if (res[PD_STORE_KEY] && res.pdSkuCount > 0) {
    pdSkuSet  = new Set(res[PD_STORE_KEY]);
    pdLoaded  = true;
    const age = res.pdLoadedAt ? Math.round((Date.now()-res.pdLoadedAt)/3600000) : '?';
    setPdStatus(`${res.pdSkuCount.toLocaleString()} SKUs · ${age}h ago`, 'loaded');
    el.chkNewOnly.disabled = false;
  }
});

// ── Load from ProDisk API ─────────────────────────────────────────
el.btnLoadApi.addEventListener('click', () => loadFromApi());

async function loadFromApi() {
  setPdStatus('Loading…', 'loading');
  setPdProgress(0, 'Connecting to api.prodisknetwork.com…');
  el.pdLoadBar.style.display = 'block';
  el.btnLoadApi.disabled     = true;

  try {
    const resp = await fetch(PD_API, { cache: 'no-cache' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    // Stream the CSV with progress
    const reader  = resp.body.getReader();
    const decoder = new TextDecoder();
    let   buffer  = '';
    let   loaded  = 0;
    const total   = parseInt(resp.headers.get('content-length') || '0');

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      loaded += value.length;
      const pct = total > 0 ? Math.round(loaded/total*100) : 0;
      setPdProgress(pct, `Downloading… ${(loaded/1024/1024).toFixed(1)} MB`);
    }

    setPdProgress(80, 'Parsing SKUs…');
    const skus = parseSkuCsv(buffer);
    if (!skus.size) throw new Error('No SKUs parsed from response');

    await storeSkus(skus);
    setPdProgress(100, '');
    el.pdLoadBar.style.display = 'none';
    setPdStatus(`${skus.size.toLocaleString()} SKUs loaded`, 'loaded');
    el.chkNewOnly.disabled = false;
    if (collected.length) updatePdResult(collected);

  } catch (e) {
    el.pdLoadBar.style.display = 'none';
    setPdStatus('Error: ' + e.message, 'error');
    el.btnLoadApi.disabled = false;
  }
  el.btnLoadApi.disabled = false;
}

// ── Upload CSV ────────────────────────────────────────────────────
el.fileCSV.addEventListener('change', function() {
  const file = this.files[0];
  if (!file) return;
  setPdStatus('Reading…', 'loading');
  const reader = new FileReader();
  reader.onload = async e => {
    try {
      const skus = parseSkuCsv(e.target.result);
      if (!skus.size) throw new Error('No SKUs found in file');
      await storeSkus(skus);
      setPdStatus(`${skus.size.toLocaleString()} SKUs from file`, 'loaded');
      el.chkNewOnly.disabled = false;
      if (collected.length) updatePdResult(collected);
    } catch(err) {
      setPdStatus('Parse error: ' + err.message, 'error');
    }
  };
  reader.readAsText(file);
  this.value = ''; // reset so same file can be reloaded
});

// ── Clear ─────────────────────────────────────────────────────────
el.btnClearPD.addEventListener('click', () => {
  pdSkuSet = new Set();
  pdLoaded = false;
  chrome.storage.local.remove([PD_STORE_KEY, 'pdSkuCount', 'pdLoadedAt']);
  setPdStatus('Not loaded', '');
  el.chkNewOnly.checked  = false;
  el.chkNewOnly.disabled = true;
  el.pdResult.style.display = 'none';
});

// ── New-only toggle ───────────────────────────────────────────────
el.chkNewOnly.addEventListener('change', () => {
  if (el.chkNewOnly.checked && collected.length) updatePdResult(collected);
  else el.pdResult.style.display = 'none';
});

// ── Parse CSV — extract first column as SKU set ──────────────────
function parseSkuCsv(text) {
  const skus = new Set();
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    // First field (before first comma or tab) is the SKU
    const sku = line.split(/,|\t/)[0].replace(/^["']|["']$/g,'').trim();
    if (sku && sku.toLowerCase() !== 'sku' && sku.toLowerCase() !== 'part') {
      skus.add(sku.toLowerCase());
    }
  }
  return skus;
}

// ── Store SKUs in chrome.storage (chunked for 5MB limit) ─────────
async function storeSkus(skuSet) {
  pdSkuSet  = skuSet;
  pdLoaded  = true;
  const arr = [...skuSet];
  // chrome.storage.local has a 10MB limit — store as array
  await new Promise(res => chrome.storage.local.set({
    [PD_STORE_KEY]: arr,
    pdSkuCount:    arr.length,
    pdLoadedAt:    Date.now()
  }, res));
}

// ── Apply filter to data ──────────────────────────────────────────
function applyPdFilter(data) {
  if (!el.chkNewOnly.checked || !pdLoaded || !pdSkuSet.size) return data;

  const keyCol = el.selPdKey.value;
  const result = { newRows: [], haveRows: [] };

  data.forEach(row => {
    let val;
    if (keyCol === '_auto') {
      // Try common SKU/part field names
      const skuField = Object.keys(row).find(k =>
        /part|sku|number|code|model|item/i.test(k) && row[k]
      ) || Object.keys(row).find(k => k !== '_page' && row[k]);
      val = skuField ? String(row[skuField]) : '';
    } else {
      val = String(row[keyCol] ?? '');
    }

    // Normalise: lowercase, strip spaces, strip leading zeros for numeric parts
    const norm = val.trim().toLowerCase().replace(/\s+/g,'');
    const inPD = pdSkuSet.has(norm) || pdSkuSet.has(norm.replace(/^0+/,''));

    if (inPD) result.haveRows.push(row);
    else       result.newRows.push(row);
  });

  return result;
}

// ── Update badge showing new vs existing count ───────────────────
function updatePdResult(data) {
  if (!el.chkNewOnly.checked || !pdLoaded) { el.pdResult.style.display='none'; return; }
  const r = applyPdFilter(data);
  if (r.newRows === undefined) { el.pdResult.style.display='none'; return; } // filter off
  el.pdNew.textContent  = r.newRows.length.toLocaleString();
  el.pdHave.textContent = r.haveRows.length.toLocaleString();
  el.pdResult.style.display = 'block';
}

// ── Status helpers ────────────────────────────────────────────────
function setPdStatus(text, type) {
  el.pdStatus.textContent = text;
  el.pdStatus.className   = 'pd-status' + (type ? ' ' + type : '');
}

function setPdProgress(pct, msg) {
  el.pdProg.style.width   = pct + '%';
  el.pdLoadMsg.textContent = msg;
}
