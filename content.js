// ================================================================
//  Pro Scraper v3.0 — Unified Content Script
//  Merges HDD-Scraper site-specific logic + ProScraper universal
//  engine into one optimised script.
//
//  Site modes (auto-detected):
//    "hdd"     — harddiskdirect.com  (.product-single-card)
//    "generic" — any other site      (universal candidate scanner)
// ================================================================
'use strict';

// ── Global state ─────────────────────────────────────────────────
const S = {
  scraping:    false,
  stop:        false,
  data:        [],
  page:        1,
  totalPages:  0,
  candidates:  [],
  activeIdx:   0,
  hlEl:        null,
  settings: {
    minDelay:      1200,
    maxDelay:      2800,
    maxPages:      500,
    waitStrategy:  'dom',
    includeImages: true,
    includeLinks:  true,
    uniqueOnly:    false,
    uniqueKey:     '_auto'
  }
};

function siteMode() {
  if (location.hostname.includes('harddiskdirect.com')) return 'hdd';
  return 'generic';
}

// ================================================================
//  MESSAGE ROUTER
// ================================================================
chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  switch (msg.action) {
    case 'ping':
      reply({ ok: true, url: location.href, mode: siteMode() });
      break;
    case 'detect':
      reply(doDetect());
      break;
    case 'setActive':
      setActive(msg.index);
      reply({ ok: true });
      break;
    case 'findNext': {
      const btn = findNextBtn();
      reply({ found: !!btn, selector: btn ? cssPath(btn) : '' });
      break;
    }
    case 'start':
      if (msg.settings) Object.assign(S.settings, msg.settings);
      if (!S.scraping) runScraper(msg);
      reply({ ok: true });
      break;
    case 'stop':
      S.stop = true;
      reply({ ok: true });
      break;
    case 'status':
      reply({ scraping: S.scraping, page: S.page, totalPages: S.totalPages, collected: S.data.length, candidates: S.candidates.length, activeIdx: S.activeIdx });
      break;
    case 'getData':
      reply({ data: S.data });
      break;
    case 'clear':
      S.data = [];
      reply({ ok: true });
      break;
    default:
      reply({ ok: false });
  }
  return true;
});

// ================================================================
//  SECTION 1 — DETECTION
// ================================================================

function doDetect() {
  S.candidates = [];

  if (siteMode() === 'hdd') {
    const cards = [...document.querySelectorAll('.product-single-card')];
    if (cards.length) {
      const cols = ['Part Number','Brand','Full Name','Condition','Price','Stock','Image URL','Product URL'];
      S.candidates = [{
        el: cards[0].parentElement,
        type: 'hdd-card',
        rows: cards,
        selector: '.product-single-card',
        score: 999,
        columns: cols,
        sampleRows: cards.slice(0,3).map(c => extractHddCard(c))
      }];
      setActive(0);
      return buildDetectResult();
    }
  }

  document.querySelectorAll('table').forEach(tbl => {
    const rows = [...tbl.querySelectorAll('tr')];
    if (rows.length >= 2) pushCandidate(scoreEl(tbl, 'table', rows));
  });

  const repeatMap = {};
  const cardSelectors = 'li,article,[class*="card"],[class*="item"],[class*="product"],[class*="result"],[class*="tile"],[class*="listing"],[class*="entry"],[class*="row"]';
  document.querySelectorAll(cardSelectors).forEach(el => {
    const p = el.parentElement;
    if (!p) return;
    const k = p.tagName + '|' + el.tagName + '|' + (el.className||'').split(' ')[0];
    if (!repeatMap[k]) repeatMap[k] = { p, els: [] };
    repeatMap[k].els.push(el);
  });
  Object.values(repeatMap).forEach(({ p, els }) => {
    if (els.length >= 3 && els.length <= 3000) pushCandidate(scoreEl(p, 'grid', els));
  });

  document.querySelectorAll('ul,ol,[role="list"],[role="grid"]').forEach(el => {
    const kids = [...el.children].filter(c => !/^(SCRIPT|STYLE|NAV)$/.test(c.tagName));
    if (kids.length < 3 || kids.length > 3000) return;
    const fc = (kids[0].className||'').split(' ')[0];
    if (fc && kids.filter(c=>(c.className||'').split(' ')[0]===fc).length / kids.length > 0.7) {
      pushCandidate(scoreEl(el, 'list', kids));
    }
  });

  const seen = new Set();
  S.candidates = S.candidates
    .filter(c => { if (seen.has(c.selector)) return false; seen.add(c.selector); return c.score > 0 && c.rows.length >= 2; })
    .sort((a,b) => b.score - a.score)
    .slice(0, 8);

  if (S.candidates.length) setActive(0);
  return buildDetectResult();
}

function buildDetectResult() {
  return {
    count: S.candidates.length,
    candidates: S.candidates.map((c,i) => ({
      index:        i,
      type:         c.type,
      rows:         c.rows.length,
      columns:      c.columns.length,
      selector:     c.selector,
      score:        c.score,
      sampleHeaders: c.columns.slice(0,8),
      sampleRows:   c.sampleRows
    }))
  };
}

function pushCandidate(c) {
  if (c && c.score > 0) S.candidates.push(c);
}

function scoreEl(el, type, rows) {
  let score = 0;
  if (el.closest('nav,header,footer,[role="navigation"]')) return null;
  const tag = el.tagName.toLowerCase();
  if (['nav','header','footer'].includes(tag)) return null;

  score += Math.min(rows.length, 60) * 3;
  const txt = el.innerText || '';
  score += Math.min(txt.length / 100, 20);
  if (/\$[\d,]+|\d+\.\d{2}/.test(txt))   score += 15;
  if (type === 'table')                   score += 20;
  score += Math.min(el.querySelectorAll('a[href]').length * 2, 20);
  score += Math.min(el.querySelectorAll('img').length * 3, 15);

  const { columns, sampleRows } = buildSchema(rows, type);
  const selector = type === 'table'
    ? cssPath(el)
    : cssPath(el) + ' > ' + (rows[0]?.tagName||'div').toLowerCase();

  return { el, type, rows, selector, score: Math.max(0,score), columns, sampleRows };
}

// ================================================================
//  SECTION 2 — SCHEMA + EXTRACTION
// ================================================================

function buildSchema(rows, type) {
  const columns = [];
  const sampleRows = [];

  if (type === 'table') {
    const hCells = rows[0].querySelectorAll('th,td');
    hCells.forEach((c,i) => columns.push(c.innerText.trim() || 'Col '+(i+1)));
    if (rows.some(r => r.querySelector('img'))) columns.push('Image URL');
    rows.slice(1,4).forEach(r => sampleRows.push(extractRow(r, type, columns)));
  } else {
    discoverFields(rows[0]).forEach(f => columns.push(f));
    rows.slice(0,3).forEach(r => sampleRows.push(extractRow(r, type, columns)));
  }
  return { columns, sampleRows };
}

function discoverFields(el) {
  const fields = [];
  const seen   = new Set();
  el.querySelectorAll('[class]').forEach(child => {
    const cls = (child.className||'').split(' ').find(c => c.length > 2 && !/^ng-|^_|^bi/.test(c));
    if (!cls || seen.has(cls)) return;
    const txt = child.innerText?.trim();
    if (!txt || txt.length > 300) return;
    seen.add(cls);
    fields.push(cls.replace(/[-_]/g,' ').replace(/([a-z])([A-Z])/g,'$1 $2').replace(/\b\w/g,c=>c.toUpperCase()).trim());
  });
  if (el.querySelector('img'))     fields.push('Image URL');
  if (el.querySelector('a[href]')) fields.push('Link URL');
  if (!fields.length) fields.push('Text');
  return fields.slice(0,20);
}

function extractRow(row, type, columns) {
  const data = {};
  if (type === 'table') {
    const cells = row.querySelectorAll('td,th');
    columns.forEach((col,i) => {
      if (col === 'Image URL') {
        data[col] = [...row.querySelectorAll('img')].map(getImgUrl).filter(Boolean).join(' | ');
      } else {
        data[col] = cells[i] ? cells[i].innerText.trim() : '';
      }
    });
  } else {
    const card = extractCardData(row);
    columns.forEach(col => {
      if (col === 'Image URL') { data[col] = card.images; return; }
      if (col === 'Link URL')  { data[col] = card.link;   return; }
      const k = Object.keys(card.fields).find(k =>
        k.toLowerCase().replace(/[^a-z]/g,'') === col.toLowerCase().replace(/[^a-z]/g,'')
      );
      data[col] = k ? card.fields[k] : '';
    });
    if (Object.values(data).every(v => !v)) {
      const lines = row.innerText.split('\n').map(l=>l.trim()).filter(l=>l&&l.length<500);
      lines.forEach((l,i) => { data[columns[i]||'Col '+(i+1)] = l; });
      data['Image URL'] = card.images;
      data['Link URL']  = card.link;
    }
  }
  return data;
}

function extractHddCard(card) {
  const lines = card.innerText.split('\n').map(l=>l.trim()).filter(Boolean);
  const cond  = (card.innerText.match(/\b(New|Refurbished|Used|OEM)\b/i)||[])[1] || '';
  const stock = (card.innerText.match(/\b(In Stock|Out of Stock|Limited Stock|Available)\b/i)||[])[1] || '';
  const price = card.querySelector('.p-price,[class*="price"]')?.textContent.trim() || '';
  const link  = card.querySelector('a[href$=".html"]')?.href || '';
  const part  = lines[0] || '';
  const brand = part.split(' ')[0] || '';
  const imgUrl = getImgUrl(card.querySelector('img'));
  return {
    'Part Number': part,
    'Brand':       brand,
    'Full Name':   lines[1] || '',
    'Condition':   cond,
    'Price':       price,
    'Stock':       stock,
    'Image URL':   imgUrl,
    'Product URL': link
  };
}

function extractCardData(el) {
  const result = { fields: {}, images: '', link: '' };
  el.querySelectorAll('[class]').forEach(child => {
    if (child.querySelectorAll('[class]').length > 3) return;
    const txt = child.innerText?.trim();
    if (!txt || txt.length > 400) return;
    const cls = (child.className||'').split(' ').find(c=>c.length>2&&!/^ng-|^_|^bi/.test(c));
    if (cls) result.fields[cls] = txt;
  });
  result.images = [...el.querySelectorAll('img')].map(getImgUrl).filter(Boolean).join(' | ');
  const link = el.querySelector('a[href]:not([href="#"]):not([href^="javascript"])');
  if (link) result.link = link.href;
  return result;
}

function getImgUrl(img) {
  if (!img) return '';
  const attrs = ['src','data-src','data-lazy','data-lazy-src','data-original',
                 'data-srcset','srcset','data-image','data-full','data-zoom-image',
                 'data-hi-res-src','data-large-image'];
  for (const attr of attrs) {
    let v = img.getAttribute(attr) || '';
    if (!v) continue;
    if (attr.includes('srcset')) v = v.split(',')[0].trim().split(' ')[0];
    if (!v) continue;
    const skip = ['img-loader','placeholder','blank.gif','data:image/gif','data:image/png;base64,R0l'];
    if (skip.some(s => v.includes(s))) continue;
    if (v.startsWith('//'))   return 'https:' + v;
    if (v.startsWith('/'))    return location.origin + v;
    if (v.startsWith('http')) return v;
  }
  return '';
}

function scrapeCurrentPage() {
  if (siteMode() === 'hdd') {
    return [...document.querySelectorAll('.product-single-card')]
      .map(c => ({ ...extractHddCard(c), _page: S.page }))
      .filter(r => r['Part Number']);
  }
  const c = S.candidates[S.activeIdx];
  if (!c) return [];
  let rows;
  if (c.type === 'table') {
    rows = [...c.el.querySelectorAll('tr')].slice(1);
  } else {
    const childTag = c.selector.split('>').pop().trim().replace(/\[.*\]/,'').trim();
    rows = [...c.el.querySelectorAll(childTag)];
  }
  return rows.map(r => ({ ...extractRow(r, c.type, c.columns), _page: S.page }));
}

// ================================================================
//  SECTION 3 — PAGINATION ENGINE
// ================================================================

function findNextBtn() {
  const strategies = [
    () => document.querySelector('a[rel="next"]'),
    () => document.querySelector('[aria-label="Next page"],[aria-label="next page"],[aria-label="Next"],[aria-label="Go to next page"]'),
    () => document.querySelector('.next>a,.next-page>a,li.next>a,.pagination-next a,.pager-next a,a.next,button.next'),
    () => {
      const pag = document.querySelector('ul.pagination,.pagination,ol.pagination');
      if (!pag) return null;
      const items = pag.querySelectorAll('li');
      if (!items.length) return null;
      const last = items[items.length-1];
      if (last.classList.contains('disabled')) return null;
      return last.querySelector('a,button');
    },
    () => {
      for (const t of ['Next','Next Page','NEXT','>','»','›','next']) {
        const el = [...document.querySelectorAll('a,button')].find(e =>
          e.innerText?.trim() === t && !e.disabled && !e.classList.contains('disabled') && !e.closest('.disabled')
        );
        if (el) return el;
      }
      return null;
    },
    () => {
      const pag = document.querySelector('.pagination,[class*="pagination"],[class*="pager"]');
      if (!pag) return null;
      const btns = [...pag.querySelectorAll('a,button')];
      for (let i = btns.length-1; i >= 0; i--) {
        const b = btns[i];
        if (b.classList.contains('disabled') || b.closest('.disabled')) continue;
        const img = b.querySelector('img');
        const svg = b.querySelector('svg');
        if (img && /(right|next|arrow|forward)/i.test(img.src+img.alt)) return b;
        if (svg) return b;
      }
      return null;
    },
    () => {
      const cur = document.querySelector('[data-page].active,[aria-current="page"]');
      if (!cur) return null;
      const n = parseInt(cur.dataset.page || cur.textContent);
      return isNaN(n) ? null : document.querySelector(`[data-page="${n+1}"]`);
    },
    () => {
      const el = document.querySelector('[class*="next-btn"],[class*="nextBtn"],[class*="NextBtn"]');
      return el && !el.classList.contains('disabled') ? el : null;
    }
  ];
  for (const fn of strategies) {
    try { const el = fn(); if (el) return el; } catch (e) {}
  }
  return null;
}

function isDisabled(btn) {
  if (!btn) return true;
  return [btn, btn.parentElement, btn.closest('li')].filter(Boolean)
    .some(el => el.classList.contains('disabled') || el.hasAttribute('disabled') || el.disabled);
}

function getTotalPages() {
  const pag = document.querySelector('.pagination,[class*="pagination"],[class*="pager"]');
  if (!pag) return 0;
  let max = 0;
  pag.querySelectorAll('a,button,li,span').forEach(el => {
    const n = parseInt(el.innerText?.trim());
    if (!isNaN(n) && n > max && n < 100000) max = n;
  });
  return max;
}

function hddCurrentPage() {
  const active = document.querySelector('ul.pagination li.active button');
  return active ? parseInt(active.textContent.trim()) || 1 : 1;
}

function fingerprint() {
  if (siteMode() === 'hdd') {
    return document.querySelector('.product-single-card')?.innerText?.trim().slice(0,80) || '';
  }
  const c = S.candidates[S.activeIdx];
  if (!c) return '';
  const childTag = c.type === 'table' ? 'tr' : c.selector.split('>').pop().trim();
  return c.el.querySelector(childTag)?.innerText?.trim().slice(0,80) || '';
}

function waitForChange(oldFp, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    let obs;
    const settle = () => { if (obs) obs.disconnect(); setTimeout(resolve, 450); };
    const check  = () => {
      if (Date.now()-t0 > timeout) { if (obs) obs.disconnect(); reject(new Error('timeout')); return; }
      const fp = fingerprint();
      if (fp && fp !== oldFp) { settle(); return; }
      setTimeout(check, 250);
    };
    const target = siteMode()==='hdd'
      ? document.querySelector('.product-list,[class*="product-list"]') || document.body
      : (S.candidates[S.activeIdx]?.el || document.body);
    obs = new MutationObserver(() => {
      const fp = fingerprint();
      if (fp && fp !== oldFp) settle();
    });
    obs.observe(target, { childList:true, subtree:true, characterData:true });
    setTimeout(check, 600);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randDelay() { return sleep(S.settings.minDelay + Math.random()*(S.settings.maxDelay - S.settings.minDelay)); }

// ================================================================
//  SECTION 4 — MAIN SCRAPING LOOP
// ================================================================

async function runScraper(opts) {
  S.scraping = true;
  S.stop     = false;
  S.data     = [];
  S.page     = 1;

  if (!S.candidates.length) doDetect();
  if (siteMode() !== 'hdd' && !S.candidates[S.activeIdx]) {
    emit({ type:'error', message:'No data detected. Click Detect first.' });
    S.scraping = false;
    return;
  }

  if (siteMode() === 'hdd') {
    S.page = hddCurrentPage();
    S.totalPages = Math.min(getTotalPages() || 999, S.settings.maxPages);
  } else {
    S.totalPages = Math.min(getTotalPages() || 999, S.settings.maxPages);
  }

  emit({ type:'started', totalPages: S.totalPages, page: S.page });
  window.scrollTo(0,0);
  await sleep(500);

  while (!S.stop) {
    const rows = scrapeCurrentPage();
    S.data.push(...rows);

    emit({
      type:       'progress',
      page:       S.page,
      totalPages: S.totalPages,
      collected:  S.data.length,
      pageRows:   rows.length,
      sampleRows: S.data.slice(-5)
    });

    if (S.page >= S.settings.maxPages) break;

    const nxt = findNextBtn();
    if (!nxt || isDisabled(nxt)) break;

    const oldFp  = fingerprint();
    const oldUrl = location.href;

    nxt.scrollIntoView({ behavior:'smooth', block:'center' });
    await sleep(300);
    nxt.click();

    try {
      if (S.settings.waitStrategy === 'fixed') {
        await sleep(S.settings.maxDelay);
      } else if (location.href !== oldUrl) {
        await new Promise((res,rej) => {
          const t = Date.now();
          const poll = () => {
            if (location.href !== oldUrl) { setTimeout(res,800); return; }
            if (Date.now()-t > 8000) { rej(new Error('url timeout')); return; }
            setTimeout(poll,200);
          };
          setTimeout(poll,300);
        });
      } else {
        await waitForChange(oldFp);
      }
    } catch (e) {
      emit({ type:'error', message:'Page load timeout on page '+S.page+'. Partial data available.' });
      break;
    }

    if (fingerprint() === oldFp && S.page > 1) break;

    S.page++;
    const tp = getTotalPages();
    if (tp > 0) S.totalPages = Math.min(tp, S.settings.maxPages);

    window.scrollTo(0,0);
    await sleep(150);
    await randDelay();
  }

  S.scraping = false;
  emit({ type:'done', total: S.data.length, data: S.data, reason: S.stop ? 'stopped' : 'complete' });
}

// ================================================================
//  SECTION 5 — UTILITIES
// ================================================================

function setActive(idx) {
  S.activeIdx = idx;
  if (S.hlEl) { S.hlEl.style.outline = ''; S.hlEl.style.outlineOffset = ''; S.hlEl = null; }
  if (S.candidates[idx]) {
    S.hlEl = S.candidates[idx].el;
    S.hlEl.style.outline       = '3px solid #3b82f6';
    S.hlEl.style.outlineOffset = '2px';
  }
}

function emit(data) {
  data._from = 'content';
  try { chrome.runtime.sendMessage(data); } catch (e) {}
}

function cssPath(el) {
  if (!el || el === document.body) return 'body';
  const parts = [];
  let cur = el;
  for (let i=0; i<5 && cur && cur!==document.body; i++) {
    let s = cur.tagName.toLowerCase();
    if (cur.id) { parts.unshift('#'+CSS.escape(cur.id)); break; }
    const cls = [...cur.classList].filter(c=>c.length>1&&!/^ng-|^is-|^has-/.test(c)).slice(0,2).map(c=>'.'+CSS.escape(c)).join('');
    if (cls) s += cls;
    parts.unshift(s);
    cur = cur.parentElement;
  }
  return parts.join(' > ');
}
