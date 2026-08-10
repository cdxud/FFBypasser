// ==UserScript==
// @name         FFBypasser - FuckingFast Link Extractor
// @namespace    ffbypasser
// @version      1.0.0
// @description  Collect fuckingfast.co links from any page (FitGirl etc.) and resolve them to direct download URLs. Redirects this tab through the file pages, then brings you back. Modern dark-blue popup UI, copy/export.
// @author       FFBypasser
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_setClipboard
// @grant        GM_openInTab
// @grant        GM_registerMenuCommand
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @connect      fuckingfast.co
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
'use strict';

const HOST_RE = /(?:^|\.)fuckingfast\.co$/i;
const SKIP_SEG = /^(f|faq|tos|terms|privacy|contact|login|register|signup|api|assets|static|dl|download)$/i;
const ID_RE = /^[A-Za-z0-9_-]{6,}$/;
const BAD_HOST_RE = /(?:^|\.)(?:challenges\.cloudflare\.com|cloudflare\.com|google\.com|google-analytics\.com|googletagmanager\.com|gstatic\.com|googleapis\.com|recaptcha\.net|hcaptcha\.com|jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|jquery\.com|w3\.org|schema\.org|fitgirl-repacks\.site)$/i;

const onHost = HOST_RE.test(location.hostname);

const DEFAULTS = {
    concurrency: 4,
    delayMs: 600,
    timeoutMs: 30000,
    hopMode: true,
    hopWaitMs: 90000,
    relayTabs: 2,
    relayWaitMs: 90000,
    autoRelay: true,
    showFrames: false,
};

const KEY_CFG = 'ffb_cfg';
const KEY_QUEUE = 'ffb_queue';
const KEY_JOBS = 'ffb_jobs';
const KEY_HOP = 'ffb_hop';
const KEY_POS = 'ffb_pos';
const KEY_SIZE = 'ffb_size';

const HOP_TOTAL_MS = 25 * 60 * 1000;
const HOP_STEP_MS = 4 * 60 * 1000;
const HISTORY_CAP = 600;

function gmGet(key, fallback) {
    try {
        const raw = GM_getValue(key, null);
        if (raw == null) return fallback;
        const val = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return val == null ? fallback : val;
    } catch { return fallback; }
}

function gmSet(key, val) {
    try { GM_setValue(key, JSON.stringify(val)); } catch {}
}

function gmDel(key) {
    try { GM_deleteValue(key); } catch { gmSet(key, null); }
}

const CFG = Object.assign({}, DEFAULTS, gmGet(KEY_CFG, {}));
const saveCfg = () => gmSet(KEY_CFG, CFG);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const now = () => Date.now();
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function hostOf(link) {
    try { return new URL(link).hostname; } catch { return ''; }
}

function absolutize(u, origin) {
    try { return new URL(u, origin).href; } catch { return u; }
}

function fileIdOf(link) {
    try { return new URL(link).pathname.split('/').filter(Boolean).pop() || null; }
    catch { return null; }
}

function sameUrl(a, b) {
    try {
        const x = new URL(a), y = new URL(b);
        return x.origin === y.origin && x.pathname === y.pathname && x.search === y.search;
    } catch { return a === b; }
}

function isFilePage(link) {
    if (typeof link !== 'string' || !/^https?:\/\//i.test(link)) return false;
    if (!HOST_RE.test(hostOf(link))) return false;
    const id = fileIdOf(link);
    return !!id && ID_RE.test(id) && !SKIP_SEG.test(id);
}

function prettyName(link) {
    try {
        const u = new URL(link);
        const hash = decodeURIComponent(u.hash.replace(/^#/, '')).trim();
        if (hash && /\.[a-z0-9]{2,5}$/i.test(hash)) return hash;
        const n = u.searchParams.get('n');
        if (n) return decodeURIComponent(n);
        if (hash) return hash;
        return u.pathname.split('/').filter(Boolean).pop() || link;
    } catch { return link; }
}

function trimUrl(raw) {
    return String(raw).trim().replace(/^[<("']+/, '').replace(/[>)\]",;.'`]+$/, '');
}

function looksLikeDirect(url) {
    let u;
    try { u = new URL(url); } catch { return false; }
    if (!/^https?:$/.test(u.protocol)) return false;
    if (!u.hostname || BAD_HOST_RE.test(u.hostname)) return false;
    if (/\.(?:js|mjs|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf)$/i.test(u.pathname)) return false;
    if (/\/(?:turnstile|cdn-cgi|recaptcha|hcaptcha)\//i.test(u.pathname)) return false;
    if (HOST_RE.test(u.hostname)) return /\/(?:dl|download|get|file)\//i.test(u.pathname);
    return true;
}

function pickDirect(text, origin) {
    const re = /https?:\/\/[^\s"'<>\\)]+/g;
    let m;
    while ((m = re.exec(String(text || '')))) {
        const cand = absolutize(trimUrl(m[0]), origin);
        if (looksLikeDirect(cand)) return cand;
    }
    return null;
}

function headerMap(raw) {
    const map = new Map();
    String(raw || '').trim().split(/\r?\n/).forEach(line => {
        const i = line.indexOf(':');
        if (i > 0) map.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
    });
    return map;
}

function readRedirect(map) {
    return map.get('hx-redirect') || map.get('hx-location') || map.get('location') || null;
}

function parseLinks(text) {
    const re = /https?:\/\/(?:[a-z0-9-]+\.)*fuckingfast\.co\/[^\s"'<>\\)\]]+/gi;
    return String(text || '').match(re) || [];
}

function normalize(rawList) {
    const seen = new Set();
    const list = [];
    let dupes = 0;
    for (const raw of rawList) {
        const url = trimUrl(raw);
        if (!isFilePage(url)) continue;
        const id = fileIdOf(url);
        if (seen.has(id)) { dupes++; continue; }
        seen.add(id);
        list.push(url);
    }
    return { list, dupes };
}

const state = { items: [], running: false, stop: false, bail: false, query: '' };

function stats() {
    let ok = 0, fail = 0, working = 0;
    for (const i of state.items) {
        if (i.status === 'ok') ok++;
        else if (i.status === 'fail') fail++;
        else if (i.status === 'working') working++;
    }
    return {
        total: state.items.length,
        ok, fail, working,
        done: ok + fail,
        pending: state.items.length - ok,
    };
}

function makeItem(url, rec) {
    return {
        url,
        id: fileIdOf(url),
        name: prettyName(url),
        status: rec && rec.status === 'ok' ? 'ok' : rec && rec.status === 'fail' ? 'fail' : 'pending',
        out: (rec && rec.out) || null,
        err: (rec && rec.err) || null,
        via: (rec && rec.via) || null,
        note: null,
    };
}

function addLinks(rawList) {
    const { list, dupes } = normalize(rawList);
    const known = new Set(state.items.map(i => i.id));
    let added = 0, dup = dupes;
    for (const url of list) {
        const id = fileIdOf(url);
        if (known.has(id)) { dup++; continue; }
        known.add(id);
        state.items.push(makeItem(url, null));
        added++;
    }
    return { added, dup, matched: list.length + dupes };
}

const resultLines = () => state.items.filter(i => i.status === 'ok' && i.out).map(i => i.out);

function toRecord(i) {
    return {
        url: i.url,
        status: i.status === 'working' ? 'pending' : i.status,
        out: i.out, err: i.err, via: i.via,
    };
}

let history = [];

function readStored() {
    return gmGet(KEY_QUEUE, []).filter(rec => rec && isFilePage(rec.url));
}

function refreshHistory() {
    history = readStored();
    return history;
}

function persist() {
    const mine = state.items.map(toRecord);
    const ids = new Set(state.items.map(i => i.id));
    const kept = history.filter(rec => !ids.has(fileIdOf(rec.url)));
    history = kept.concat(mine).slice(-HISTORY_CAP);
    gmSet(KEY_QUEUE, history);
}

function wipeHistory() {
    history = [];
    gmDel(KEY_QUEUE);
}

function restorableCount() {
    const known = new Set(state.items.map(i => i.id));
    return history.reduce((n, rec) => n + (known.has(fileIdOf(rec.url)) ? 0 : 1), 0);
}

function loadHistory() {
    const known = new Set(state.items.map(i => i.id));
    let added = 0;
    for (const rec of history) {
        const id = fileIdOf(rec.url);
        if (known.has(id)) continue;
        known.add(id);
        state.items.push(makeItem(rec.url, rec));
        added++;
    }
    return added;
}

function patchRecord(id, patch) {
    const list = gmGet(KEY_QUEUE, []);
    let hit = false;
    for (const rec of list) {
        if (!rec || fileIdOf(rec.url) !== id) continue;
        Object.assign(rec, patch);
        hit = true;
    }
    if (hit) gmSet(KEY_QUEUE, list);
    return hit;
}

function recordOf(id) {
    return gmGet(KEY_QUEUE, []).find(rec => rec && fileIdOf(rec.url) === id) || null;
}

function collectAnchors() {
    const out = [];
    document.querySelectorAll('a[href*="fuckingfast"]').forEach(a => out.push(a.href));
    return out;
}

function collectDeep() {
    const out = collectAnchors();
    const html = document.documentElement ? document.documentElement.innerHTML : '';
    if (html.indexOf('fuckingfast') !== -1) out.push(...parseLinks(html));
    return out;
}

const inflight = new Set();

function abortAll() {
    for (const handle of inflight) {
        try { if (handle && typeof handle.abort === 'function') handle.abort(); } catch {}
    }
    inflight.clear();
}

function napt(ms) {
    return new Promise(resolve => {
        if (state.stop || !(ms > 0)) return resolve();
        const step = Math.min(ms, 120);
        let left = ms;
        const timer = setInterval(() => {
            left -= step;
            if (left <= 0 || state.stop) { clearInterval(timer); resolve(); }
        }, step);
    });
}

function gmRequest(opts) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let handle = null;
        const once = fn => (...a) => {
            if (settled) return;
            settled = true;
            if (handle) inflight.delete(handle);
            fn(...a);
        };
        try {
            handle = GM_xmlhttpRequest(Object.assign({
                timeout: CFG.timeoutMs,
                onload: once(resolve),
                onerror: once(() => reject(new Error('network error'))),
                ontimeout: once(() => reject(new Error('timeout'))),
                onabort: once(() => reject(new Error('stopped'))),
            }, opts));
            if (handle && typeof handle.abort === 'function') inflight.add(handle);
        } catch (e) { reject(e); }
    });
}

async function resolveDirect(item) {
    const origin = `https://${hostOf(item.url) || 'fuckingfast.co'}`;
    const res = await gmRequest({
        method: 'POST',
        url: `${origin}/f/${item.id}/go`,
        headers: {
            'HX-Request': 'true',
            'HX-Current-URL': item.url,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Referer': item.url,
            'Origin': origin,
        },
        data: '',
    });

    const hit = readRedirect(headerMap(res.responseHeaders));
    if (hit) {
        const url = absolutize(trimUrl(hit), origin);
        if (looksLikeDirect(url)) return url;
    }

    if (res.finalUrl && looksLikeDirect(res.finalUrl)) return res.finalUrl;

    const body = String(res.responseText || '');
    if (/challenges\.cloudflare\.com|cf-turnstile|__cf_chl/i.test(body)) {
        throw new Error('cloudflare challenge');
    }

    const found = pickDirect(body, origin);
    if (found) return found;

    throw new Error(res.status >= 400 ? `HTTP ${res.status}` : 'no direct link returned');
}

const readJobs = () => gmGet(KEY_JOBS, {});

function writeJob(id, patch) {
    const jobs = readJobs();
    jobs[id] = Object.assign({ id, ts: now() }, jobs[id], patch);
    gmSet(KEY_JOBS, jobs);
}

function dropJob(id) {
    const jobs = readJobs();
    delete jobs[id];
    gmSet(KEY_JOBS, jobs);
}

function pruneJobs() {
    const jobs = readJobs();
    let changed = false;
    for (const [id, job] of Object.entries(jobs)) {
        if (!job || now() - (job.ts || 0) > 10 * 60 * 1000) { delete jobs[id]; changed = true; }
    }
    if (changed) gmSet(KEY_JOBS, jobs);
}

function waitForJob(id, timeoutMs) {
    return new Promise(resolve => {
        let listener = null;
        let timer = null;
        let poll = null;
        let done = false;

        const finish = result => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            clearInterval(poll);
            if (listener != null) {
                try { GM_removeValueChangeListener(listener); } catch {}
            }
            resolve(result);
        };

        const check = () => {
            if (state.stop) return finish({ state: 'error', err: 'stopped' });
            const job = readJobs()[id];
            if (!job) return;
            if (job.state === 'done' || job.state === 'error') finish(job);
        };

        try { listener = GM_addValueChangeListener(KEY_JOBS, () => check()); } catch {}
        poll = setInterval(check, 700);
        timer = setTimeout(() => finish({ state: 'error', err: 'relay timeout' }), timeoutMs);
        check();
    });
}

let relayLanes = 0;

async function relaySlot() {
    const cap = clamp(CFG.relayTabs, 1, 4);
    while (relayLanes >= cap && !state.stop) await sleep(250);
    relayLanes++;
}

async function resolveRelay(item, onNote) {
    if (!CFG.autoRelay) throw new Error('relay disabled in settings');
    if (typeof GM_openInTab !== 'function') throw new Error('GM_openInTab unavailable');

    await relaySlot();
    let tab = null;
    try {
        if (state.stop) throw new Error('stopped');
        writeJob(item.id, { url: item.url, state: 'pending', ts: now(), out: null, err: null });
        if (onNote) onNote('opening tab…');

        tab = GM_openInTab(item.url, { active: false, insert: true, setParent: true });

        const job = await waitForJob(item.id, clamp(CFG.relayWaitMs, 10000, 600000));
        if (job.state === 'done' && looksLikeDirect(job.out)) return job.out;
        throw new Error(job.err || 'relay produced no link');
    } finally {
        dropJob(item.id);
        try { if (tab && typeof tab.close === 'function') tab.close(); } catch {}
        relayLanes--;
    }
}

let framePanel = null;

function ensureFramePanel() {
    if (framePanel && framePanel.isConnected) return framePanel;
    framePanel = document.createElement('div');
    framePanel.style.cssText = [
        'position:fixed', 'left:8px', 'bottom:8px', 'z-index:2147483646',
        'display:flex', 'gap:6px', 'flex-wrap:wrap', 'max-width:60vw',
        CFG.showFrames ? 'opacity:1' : 'opacity:0;pointer-events:none',
    ].join(';');
    (document.body || document.documentElement).appendChild(framePanel);
    return framePanel;
}

function loadFrame(src) {
    return new Promise((resolve, reject) => {
        const frame = document.createElement('iframe');
        frame.style.cssText = 'width:280px;height:180px;border:0;background:#070a12';
        let settled = false;
        const finish = (fn, arg) => { if (!settled) { settled = true; clearTimeout(timer); fn(arg); } };
        const timer = setTimeout(() => { frame.remove(); finish(reject, new Error('page load timeout')); }, CFG.timeoutMs);
        frame.onload = () => finish(resolve, frame);
        frame.onerror = () => { frame.remove(); finish(reject, new Error('frame load error')); };
        frame.src = src;
        ensureFramePanel().appendChild(frame);
    });
}

function frameWindow(frame) {
    try {
        const win = frame.contentWindow;
        if (!win || !win.document || !win.document.body) return null;
        void win.location.href;
        return win;
    } catch { return null; }
}

function neuterAds(win) {
    try { win.open = () => null; } catch {}
    try { win.addEventListener('beforeunload', e => e.stopImmediatePropagation(), true); } catch {}
}

function grabToken(win) {
    const input = win.document.querySelector(
        'input[name="cf-turnstile-response"], input[name="g-recaptcha-response"], input[name="h-captcha-response"]'
    );
    if (input && input.value) return { name: input.name, value: input.value };
    try {
        if (win.turnstile && typeof win.turnstile.getResponse === 'function') {
            const v = win.turnstile.getResponse();
            if (v) return { name: 'cf-turnstile-response', value: v };
        }
    } catch {}
    return null;
}

function tokenWidgetPresent(win) {
    return !!win.document.querySelector(
        '.cf-turnstile, [data-sitekey], iframe[src*="challenges.cloudflare.com"], input[name="cf-turnstile-response"]'
    );
}

async function waitForToken(win, waitMs, onTick) {
    if (!tokenWidgetPresent(win)) return null;
    const deadline = now() + (waitMs || 15000);
    while (now() < deadline) {
        const tok = grabToken(win);
        if (tok) return tok;
        if (onTick) onTick(Math.max(0, Math.round((deadline - now()) / 1000)));
        await sleep(250);
    }
    return grabToken(win);
}

function findTrigger(win, id) {
    const doc = win.document;
    const hx = doc.querySelector(`[hx-post*="/${id}/"], [hx-post], [data-hx-post]`);
    if (hx) return hx;
    return Array.from(doc.querySelectorAll('a,button'))
        .find(el => /download/i.test(el.textContent || '')) || null;
}

function describeRequest(win, id) {
    const trigger = findTrigger(win, id);
    const path = (trigger && (trigger.getAttribute('hx-post') || trigger.getAttribute('data-hx-post')))
        || `/f/${id}/go`;
    const params = new URLSearchParams();

    const valsAttr = trigger && (trigger.getAttribute('hx-vals') || trigger.getAttribute('data-hx-vals'));
    if (valsAttr) {
        try {
            for (const [k, v] of Object.entries(JSON.parse(valsAttr))) params.set(k, String(v));
        } catch {}
    }

    const form = (trigger && trigger.closest('form')) || win.document.querySelector('form');
    if (form) {
        for (const [k, v] of new FormData(form).entries()) {
            if (typeof v === 'string') params.set(k, v);
        }
    }

    const headers = {
        'HX-Request': 'true',
        'HX-Current-URL': win.location.href,
        'Content-Type': 'application/x-www-form-urlencoded',
    };
    if (trigger) {
        const target = trigger.getAttribute('hx-target') || trigger.getAttribute('data-hx-target');
        if (target) headers['HX-Target'] = target.replace(/^#/, '');
        if (trigger.id) headers['HX-Trigger'] = trigger.id;
        const nameAttr = trigger.getAttribute('name');
        if (nameAttr) headers['HX-Trigger-Name'] = nameAttr;
    }
    return { path, params, headers };
}

async function strategyFetch(win, id, tokenWaitMs, onTick) {
    const req = describeRequest(win, id);
    const token = await waitForToken(win, tokenWaitMs, onTick);
    if (token) req.params.set(token.name, token.value);

    const res = await win.fetch(req.path, {
        method: 'POST',
        credentials: 'include',
        headers: req.headers,
        body: req.params.toString(),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const hit = res.headers.get('hx-redirect') || res.headers.get('hx-location') || res.headers.get('location');
    if (hit) {
        const url = absolutize(trimUrl(hit), win.location.origin);
        if (looksLikeDirect(url)) return url;
    }

    const found = pickDirect(await res.text(), win.location.origin);
    if (found) return found;
    throw new Error(token ? 'no direct link in response' : 'captcha token missing');
}

function armCapture(win) {
    let resolveFn;
    const captured = new Promise(res => { resolveFn = res; });
    try {
        const proto = win.XMLHttpRequest.prototype;
        const origOpen = proto.open;
        proto.open = function (...args) {
            this.addEventListener('readystatechange', () => {
                if (this.readyState !== 4) return;
                try {
                    const url = this.getResponseHeader('hx-redirect') || this.getResponseHeader('hx-location');
                    if (url) resolveFn(url);
                } catch {}
            });
            return origOpen.apply(this, args);
        };
    } catch {}
    try {
        const origFetch = win.fetch;
        win.fetch = function (...args) {
            return origFetch.apply(this, args).then(res => {
                try {
                    const url = res.headers.get('hx-redirect') || res.headers.get('hx-location');
                    if (url) resolveFn(url);
                } catch {}
                return res;
            });
        };
    } catch {}
    return captured;
}

async function strategyClick(win, id, tokenWaitMs) {
    neuterAds(win);
    const captured = armCapture(win);
    await waitForToken(win, tokenWaitMs || 15000);

    const trigger = findTrigger(win, id);
    if (!trigger) throw new Error('download trigger not found');

    trigger.click();
    await sleep(700);
    trigger.click();

    const hit = await Promise.race([captured, sleep(20000).then(() => null)]);
    if (!hit) throw new Error('no request captured after click');
    const url = absolutize(trimUrl(hit), win.location.origin);
    if (!looksLikeDirect(url)) throw new Error('captured link was not a download');
    return url;
}

let useFrames = true;

async function resolveInFrame(item) {
    if (!useFrames) throw new Error('framing unavailable');
    let host = null;
    try {
        host = await loadFrame(item.url);
        const win = frameWindow(host);
        if (!win) {
            useFrames = false;
            throw new Error('framing blocked (X-Frame-Options)');
        }
        neuterAds(win);
        try { return await strategyFetch(win, item.id, 15000); }
        catch (e) {
            try { return await strategyClick(win, item.id); }
            catch { throw e; }
        }
    } finally {
        if (host) host.remove();
    }
}

const readHop = () => gmGet(KEY_HOP, null);
const writeHop = s => gmSet(KEY_HOP, s);
const clearHop = () => gmDel(KEY_HOP);

function hopExpired(s) {
    return !s || !s.active || !s.deadline || now() > s.deadline;
}

function startHop(items, returnUrl) {
    const hops = items.map(i => ({ id: i.id, url: i.url, name: i.name }));
    const first = items.find(i => i.status !== 'ok');
    if (!first) return false;

    persist();
    writeHop({
        active: true,
        finished: false,
        cancelled: false,
        returnUrl: returnUrl || location.href,
        startedAt: now(),
        deadline: now() + clamp(hops.length * 20000, HOP_TOTAL_MS, 90 * 60 * 1000),
        stepId: null,
        stepStart: 0,
        hops,
    });
    location.replace(first.url);
    return true;
}

async function hostPost(id) {
    const res = await fetch(`/f/${id}/go`, {
        method: 'POST',
        credentials: 'include',
        headers: {
            'HX-Request': 'true',
            'HX-Current-URL': `${location.origin}/${id}`,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: '',
    });
    if (res.status === 403 || res.status === 429) throw new Error('cloudflare challenge');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const hit = res.headers.get('hx-redirect') || res.headers.get('hx-location') || res.headers.get('location');
    if (hit) {
        const url = absolutize(trimUrl(hit), location.origin);
        if (looksLikeDirect(url)) return url;
    }
    const text = await res.text();
    if (/challenges\.cloudflare\.com|cf-turnstile|__cf_chl/i.test(text)) throw new Error('cloudflare challenge');
    const found = pickDirect(text, location.origin);
    if (found) return found;
    throw new Error('no direct link returned');
}

async function batchFromHost(session, card, skipIndex) {
    const rest = [];
    session.hops.forEach((hop, i) => {
        if (i === skipIndex) return;
        const rec = recordOf(hop.id);
        if (!rec || rec.status !== 'ok') rest.push(hop);
    });
    if (!rest.length) return 0;

    const total = session.hops.length;
    const doneCount = () => session.hops.filter(x => {
        const r = recordOf(x.id);
        return r && r.status === 'ok';
    }).length;

    let cursor = 0, got = 0, blocked = false;

    const lane = async () => {
        while (!blocked) {
            const hop = rest[cursor++];
            if (!hop) break;
            try {
                const url = await hostPost(hop.id);
                patchRecord(hop.id, { status: 'ok', out: url, err: null, via: 'batch' });
                got++;
                const d = doneCount();
                card.setStep(d, total, hop.name, d);
                card.note(`resolved ${d} of ${total}`);
            } catch (e) {
                if (/cloudflare|challenge|captcha/i.test(e.message || '')) { blocked = true; break; }
                patchRecord(hop.id, { status: 'fail', err: e.message || 'failed', out: null });
            }
            await sleep(120);
        }
    };

    card.note(`resolved ${doneCount()} of ${total}`);
    await Promise.all([lane(), lane(), lane()]);

    if (got) card.ok(`${doneCount()} of ${total} resolved from this page`);
    return got;
}

function hopSummary(s) {
    let ok = 0, fail = 0;
    for (const hop of s.hops) {
        const rec = recordOf(hop.id);
        if (rec && rec.status === 'ok') ok++;
        else if (rec && rec.status === 'fail') fail++;
    }
    return { ok, fail, total: s.hops.length };
}

function nextHop(s, fromIndex) {
    for (let i = fromIndex + 1; i < s.hops.length; i++) {
        const rec = recordOf(s.hops[i].id);
        if (!rec || rec.status !== 'ok') return s.hops[i];
    }
    for (let i = 0; i <= fromIndex && i < s.hops.length; i++) {
        const rec = recordOf(s.hops[i].id);
        if (rec && rec.status !== 'ok' && rec.status !== 'fail') return s.hops[i];
    }
    return null;
}

function leaveHop(s, target) {
    s.active = false;
    s.finished = true;
    writeHop(s);
    location.replace(target || s.returnUrl);
}

async function runHop(session) {
    const id = fileIdOf(location.href);
    const index = session.hops.findIndex(hop => hop.id === id);
    if (index < 0) return;

    const card = buildHopCard();
    let finished = false;

    const advance = () => {
        if (finished) return;
        finished = true;
        const fresh = readHop() || session;
        if (fresh.cancelled) return leaveHop(fresh);
        const next = nextHop(fresh, index);
        if (!next) return leaveHop(fresh);
        fresh.stepId = null;
        writeHop(fresh);
        setTimeout(() => location.replace(next.url), 350);
    };

    const doneNow = session.hops.filter(hop => {
        const rec = recordOf(hop.id);
        return rec && rec.status === 'ok';
    }).length;

    card.setStep(Math.min(doneNow + 1, session.hops.length), session.hops.length,
        session.hops[index].name, doneNow);

    card.onCancel(() => {
        session.cancelled = true;
        card.note('going back…');
        leaveHop(session);
    });
    card.onSkip(() => {
        patchRecord(id, { status: 'fail', err: 'skipped', out: null });
        card.note('skipping…');
        advance();
    });

    if (session.stepId !== id) {
        session.stepId = id;
        session.stepStart = now();
        writeHop(session);
    } else if (now() - session.stepStart > HOP_STEP_MS) {
        patchRecord(id, { status: 'fail', err: 'page kept reloading', out: null });
        card.fail('page kept reloading');
        return advance();
    }

    card.note('reading the page…');
    const ready = await waitForFilePage(id, 25000);
    if (!ready) {
        patchRecord(id, { status: 'fail', err: 'file page never loaded', out: null });
        card.fail('file page never loaded');
        return advance();
    }

    const budget = clamp(CFG.hopWaitMs, 15000, 600000);
    if (tokenWidgetPresent(window)) card.note('waiting for the captcha…');
    else card.note('asking for the direct link…');

    let out = null, err = null;
    try {
        out = await strategyFetch(window, id, budget, secs => {
            card.note(`waiting for the captcha… ${secs}s`);
        });
    } catch (e1) {
        try {
            card.note('trying the download button…');
            out = await strategyClick(window, id, 8000);
        } catch (e2) {
            err = e2.message || e1.message || 'failed';
        }
    }

    if (out && looksLikeDirect(out)) {
        patchRecord(id, { status: 'ok', out, err: null, via: 'redirect' });
        card.ok(out);
        await batchFromHost(readHop() || session, card, index);
    } else {
        patchRecord(id, { status: 'fail', err: err || 'no direct link', out: null });
        card.fail(err || 'no direct link');
    }

    setTimeout(advance, 700);
}

async function waitForFilePage(id, waitMs) {
    const deadline = now() + waitMs;
    while (now() < deadline) {
        if (findTrigger(window, id)) return true;
        await sleep(300);
    }
    return false;
}

async function runWorker() {
    const id = fileIdOf(location.href);
    const card = buildHopCard(true);
    card.setStep(1, 1, prettyName(location.href), 0);
    card.note('resolving in the background…');

    try {
        if (tokenWidgetPresent(window)) card.note('waiting for the captcha…');
        const url = await strategyFetch(window, id, 60000, secs => {
            card.note(`waiting for the captcha… ${secs}s`);
        });
        writeJob(id, { state: 'done', out: url, ts: now() });
        card.ok(url);
    } catch (e) {
        try {
            const url = await strategyClick(window, id);
            writeJob(id, { state: 'done', out: url, ts: now() });
            card.ok(url);
        } catch (e2) {
            const msg = e2.message || e.message || 'failed';
            writeJob(id, { state: 'error', err: msg, ts: now() });
            card.fail(msg);
        }
    }
}

const TOKENS = `
    --bg:        #070a12;
    --bg-2:      #0a0e18;
    --raised:    #101725;
    --hover:     #162032;
    --line:      #1a2436;
    --line-2:    #25324b;
    --fg:        #e9eefb;
    --fg-2:      #93a1bd;
    --fg-3:      #5d6b86;
    --accent:    #3b82f6;
    --accent-2:  #7aa7ff;
    --accent-3:  #1d4ed8;
    --soft:      rgba(59,130,246,.12);
    --soft-2:    rgba(59,130,246,.24);
    --danger:    #ff6b6b;
    --danger-soft: rgba(255,107,107,.1);
    --radius:    16px;
    --font:      ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
    --mono:      ui-monospace, "Cascadia Code", Consolas, monospace;
`;

const BASE_CSS = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes rise { from { opacity: 0; transform: translateY(6px) scale(.985); } to { opacity: 1; transform: none; } }
@keyframes sheen { 0% { background-position: 0% 50%; } 100% { background-position: 200% 50%; } }
@media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { transition: none !important; animation: none !important; }
}
`;

const CSS = BASE_CSS + `
.wrap {
${TOKENS}
    position: fixed; z-index: 2147483647;
    font-family: var(--font); font-size: 13px; line-height: 1.5; color: var(--fg);
    -webkit-font-smoothing: antialiased;
}

.fabwrap { position: fixed; right: 22px; bottom: 22px; }
.fabwrap[hidden] { display: none; }
.fab {
    position: relative; width: 46px; height: 46px; border-radius: 15px;
    cursor: pointer; display: grid; place-items: center; color: #fff;
    background: linear-gradient(145deg, var(--accent), var(--accent-3));
    border: 1px solid rgba(122,167,255,.45);
    box-shadow: 0 10px 26px rgba(0,0,0,.55), 0 6px 20px rgba(59,130,246,.32);
    transition: transform .16s cubic-bezier(.2,.8,.3,1), box-shadow .16s;
}
.fab:hover { transform: translateY(-2px); box-shadow: 0 14px 32px rgba(0,0,0,.55), 0 8px 26px rgba(59,130,246,.5); }
.fab:active { transform: none; }
.badge {
    position: absolute; top: -6px; right: -6px; min-width: 19px; height: 19px;
    padding: 0 5px; border-radius: 999px; background: var(--bg); color: var(--accent-2);
    font-size: 10.5px; font-weight: 700; display: grid; place-items: center;
    border: 1px solid var(--line-2); font-variant-numeric: tabular-nums;
}
.badge[hidden] { display: none; }

.panel {
    width: 456px; max-width: calc(100vw - 20px);
    display: flex; flex-direction: column;
    max-height: min(78vh, 760px);
    background: var(--bg); border: 1px solid var(--line-2);
    border-radius: var(--radius); overflow: hidden;
    box-shadow: 0 28px 70px rgba(0,0,0,.66), 0 0 0 1px rgba(59,130,246,.07);
    animation: rise .18s cubic-bezier(.2,.8,.3,1);
}
.panel[hidden] { display: none; }

.head {
    display: flex; align-items: center; gap: 10px;
    padding: 12px 10px 12px 13px;
    background: linear-gradient(180deg, rgba(59,130,246,.09), transparent 90%);
    border-bottom: 1px solid var(--line);
    cursor: grab; user-select: none;
}
.head.drag { cursor: grabbing; }
.mark {
    width: 26px; height: 26px; border-radius: 9px; flex: none;
    display: grid; place-items: center; color: #fff;
    background: linear-gradient(145deg, var(--accent), var(--accent-3));
    box-shadow: 0 3px 10px rgba(59,130,246,.4);
}
.htxt { flex: 1; min-width: 0; }
.htxt h1 { font-size: 13px; font-weight: 620; letter-spacing: -.15px; }
.htxt .where {
    display: block; font-size: 10.5px; color: var(--fg-3);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ico {
    width: 28px; height: 28px; border-radius: 9px; cursor: pointer; flex: none;
    border: 1px solid transparent; background: transparent; color: var(--fg-2);
    display: grid; place-items: center; transition: background .14s, color .14s, border-color .14s;
}
.ico:hover { background: var(--hover); color: var(--fg); }
.ico.on { background: var(--soft); border-color: var(--soft-2); color: var(--accent-2); }

.actions { display: flex; gap: 6px; padding: 11px 12px; }
.btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 7px;
    cursor: pointer; padding: 9px 14px; border-radius: 11px;
    font-family: var(--font); font-size: 12.5px; font-weight: 550; white-space: nowrap;
    border: 1px solid var(--line-2); background: var(--raised); color: var(--fg);
    transition: background .14s, border-color .14s, opacity .14s, box-shadow .14s, transform .1s;
}
.btn:hover:not(:disabled) { background: var(--hover); border-color: var(--fg-3); }
.btn:active:not(:disabled) { transform: translateY(1px); }
.btn:disabled { opacity: .32; cursor: not-allowed; }
.btn svg { flex: none; }
.btn span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.btn.primary {
    flex: 1; min-width: 0; color: #fff; font-weight: 620;
    background: linear-gradient(145deg, var(--accent), var(--accent-3));
    border-color: rgba(122,167,255,.4);
    box-shadow: 0 5px 16px rgba(59,130,246,.3);
}
.btn.primary:hover:not(:disabled) {
    background: linear-gradient(145deg, #4f8ff8, #2456d6);
    border-color: rgba(122,167,255,.6);
    box-shadow: 0 7px 20px rgba(59,130,246,.42);
}
.btn.primary:disabled { box-shadow: none; }
.btn.primary.stop {
    background: var(--danger-soft); border-color: rgba(255,107,107,.4);
    color: var(--danger); box-shadow: none;
}
.btn.primary.stop:hover:not(:disabled) {
    background: rgba(255,107,107,.16); border-color: var(--danger); box-shadow: none;
}
.btn.sq { padding: 9px; width: 36px; flex: none; }
.btn.ghost { background: transparent; }

.stats { display: flex; gap: 7px; padding: 0 12px 11px; }
.stat {
    flex: 1; min-width: 0; cursor: pointer; text-align: left;
    padding: 8px 10px; border-radius: 11px;
    background: var(--raised); border: 1px solid var(--line);
    transition: background .14s, border-color .14s;
}
.stat:hover { background: var(--hover); }
.stat b {
    display: block; font-size: 17px; font-weight: 640; line-height: 1.15;
    color: var(--fg); font-variant-numeric: tabular-nums; letter-spacing: -.4px;
}
.stat span {
    display: block; font-size: 9.5px; font-weight: 600; letter-spacing: .55px;
    text-transform: uppercase; color: var(--fg-3); margin-top: 2px;
}
.stat.on { background: var(--soft); border-color: var(--soft-2); }
.stat.on b, .stat.on span { color: var(--accent-2); }
.stat.bad.on { background: var(--danger-soft); border-color: rgba(255,107,107,.35); }
.stat.bad.on b, .stat.bad.on span { color: var(--danger); }

.prog { display: flex; align-items: center; gap: 10px; padding: 0 13px 11px; }
.prog[hidden] { display: none; }
.track { flex: 1; height: 4px; border-radius: 99px; background: var(--line); overflow: hidden; }
.track i {
    display: block; height: 100%; width: 0; border-radius: 99px;
    background: linear-gradient(90deg, var(--accent-3), var(--accent), var(--accent-2), var(--accent));
    background-size: 200% 100%; animation: sheen 2.2s linear infinite;
    transition: width .3s cubic-bezier(.3,.9,.3,1);
}
.pct {
    font-size: 11px; color: var(--fg-2); font-variant-numeric: tabular-nums;
    white-space: nowrap; min-width: 68px; text-align: right;
}

.find { position: relative; padding: 0 12px 11px; }
.find[hidden] { display: none; }
.find svg { position: absolute; left: 22px; top: 8px; color: var(--fg-3); pointer-events: none; }
.find input {
    width: 100%; padding: 7px 10px 7px 32px; border-radius: 10px;
    background: var(--raised); border: 1px solid var(--line); color: var(--fg);
    font-family: var(--font); font-size: 12px;
    transition: border-color .14s, box-shadow .14s;
}
.find input::placeholder { color: var(--fg-3); }
.find input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--soft); }

.list {
    flex: 1; overflow-y: auto; overscroll-behavior: contain;
    min-height: 96px; border-top: 1px solid var(--line);
}
.list::-webkit-scrollbar { width: 10px; }
.list::-webkit-scrollbar-track { background: transparent; }
.list::-webkit-scrollbar-thumb { background: var(--line-2); border-radius: 99px; border: 3px solid var(--bg); }
.list::-webkit-scrollbar-thumb:hover { background: var(--fg-3); }

.row {
    display: flex; align-items: center; gap: 10px;
    padding: 9px 13px; transition: background .12s;
    border-left: 2px solid transparent;
}
.row + .row { box-shadow: inset 0 1px 0 var(--line); }
.row:hover { background: var(--raised); }
.row.ok { cursor: pointer; }
.row.ok:hover { border-left-color: var(--accent); }
.row.fail { border-left-color: rgba(255,107,107,.55); }
.row.work { background: var(--soft); border-left-color: var(--accent); }

.st { width: 16px; flex: none; display: grid; place-items: center; color: var(--fg-3); }
.row.ok .st { color: var(--accent-2); }
.row.fail .st { color: var(--danger); }
.row.work .st { color: var(--accent-2); }
.row.work .st svg { animation: spin 1s linear infinite; }

.info { flex: 1; min-width: 0; }
.fname {
    font-size: 12.5px; font-weight: 520; color: var(--fg);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.row.pending .fname { color: var(--fg-2); }
.sub { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--fg-3); margin-top: 1px; }
.sub span.txt {
    min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    font-family: var(--mono);
}
.row.ok .sub span.txt { color: var(--fg-2); }
.row.fail .sub span.txt { color: var(--danger); font-family: var(--font); }
.tag {
    flex: none; font-size: 9px; font-weight: 700; letter-spacing: .5px;
    text-transform: uppercase; padding: 1.5px 5px; border-radius: 5px;
    background: var(--soft); border: 1px solid var(--soft-2); color: var(--accent-2);
}

.acts { display: flex; gap: 2px; opacity: 0; transition: opacity .14s; }
.row:hover .acts, .row:focus-within .acts { opacity: 1; }
.act {
    width: 26px; height: 26px; border-radius: 8px; cursor: pointer;
    border: none; background: transparent; color: var(--fg-3);
    display: grid; place-items: center; transition: background .14s, color .14s;
}
.act:hover { background: var(--soft); color: var(--accent-2); }

.empty { padding: 38px 26px; text-align: center; }
.empty .eic { color: var(--accent); opacity: .5; margin-bottom: 12px; }
.empty h2 { font-size: 13px; font-weight: 560; color: var(--fg-2); margin-bottom: 3px; }
.empty p { font-size: 11.5px; color: var(--fg-3); line-height: 1.6; }
.empty .btn { margin-top: 14px; max-width: 100%; }

.drawer { padding: 12px 13px; border-top: 1px solid var(--line); background: var(--bg-2); }
.drawer[hidden] { display: none; }
.drawer textarea {
    width: 100%; height: 100px; resize: vertical; display: block;
    border-radius: 11px; padding: 10px;
    background: var(--raised); border: 1px solid var(--line); color: var(--fg);
    font-family: var(--mono); font-size: 11px; line-height: 1.6;
    transition: border-color .14s, box-shadow .14s;
}
.drawer textarea::placeholder { color: var(--fg-3); }
.drawer textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--soft); }
.hint { font-size: 11px; color: var(--fg-3); margin-top: 8px; line-height: 1.55; }
.drawrow { display: flex; gap: 7px; margin-top: 10px; }

.opt { display: flex; align-items: center; gap: 12px; padding: 9px 0; }
.opt + .opt { border-top: 1px solid var(--line); }
.opt .lab { flex: 1; min-width: 0; }
.opt .lab span { display: block; font-size: 12.5px; color: var(--fg); }
.opt .lab small { display: block; font-size: 10.5px; color: var(--fg-3); margin-top: 1px; line-height: 1.5; }
.opt input[type=number] {
    width: 78px; flex: none; padding: 6px 9px; border-radius: 9px; text-align: right;
    background: var(--raised); border: 1px solid var(--line); color: var(--fg);
    font-family: var(--font); font-size: 12px; font-variant-numeric: tabular-nums;
    transition: border-color .14s, box-shadow .14s;
}
.opt input[type=number]:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--soft); }
.sw {
    width: 38px; height: 22px; border-radius: 99px; flex: none; cursor: pointer;
    background: var(--line-2); border: none; position: relative;
    transition: background .18s, box-shadow .18s;
}
.sw::after {
    content: ''; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px;
    border-radius: 50%; background: var(--fg-2); transition: transform .18s, background .18s;
}
.sw.on { background: var(--accent); box-shadow: 0 0 0 3px var(--soft); }
.sw.on::after { transform: translateX(16px); background: #fff; }
.sub-opt { padding-left: 12px; border-left: 2px solid var(--line); }
.sub-opt[hidden] { display: none; }

.foot {
    display: flex; gap: 7px; padding: 11px 12px;
    border-top: 1px solid var(--line); background: var(--bg-2);
}
.foot[hidden] { display: none; }

.toast {
    position: absolute; left: 50%; bottom: 16px; transform: translate(-50%, 8px);
    padding: 9px 15px; border-radius: 11px; font-size: 12px;
    max-width: 88%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    background: #0e1626; color: var(--fg); font-weight: 500;
    border: 1px solid var(--line-2);
    box-shadow: 0 12px 30px rgba(0,0,0,.65), 0 0 0 4px var(--soft);
    opacity: 0; pointer-events: none; transition: opacity .18s, transform .18s;
}
.toast.show { opacity: 1; transform: translate(-50%, 0); }

.grip {
    position: absolute; right: 3px; bottom: 3px; width: 15px; height: 15px;
    cursor: nwse-resize; color: var(--fg-3); opacity: .55;
}
.grip:hover { opacity: 1; color: var(--accent-2); }
`;

const HOP_CSS = BASE_CSS + `
.wrap {
${TOKENS}
    position: fixed; right: 20px; bottom: 20px;
    z-index: 2147483647; width: 400px; max-width: calc(100vw - 28px);
    font-family: var(--font); font-size: 13px; line-height: 1.5; color: var(--fg);
    -webkit-font-smoothing: antialiased;
    animation: rise .2s cubic-bezier(.2,.8,.3,1);
}
.card {
    background: var(--bg); border: 1px solid var(--line-2); border-radius: var(--radius);
    box-shadow: 0 26px 64px rgba(0,0,0,.7), 0 0 0 1px rgba(59,130,246,.08);
    overflow: hidden;
}
.top {
    display: flex; align-items: center; gap: 9px; padding: 11px 12px;
    background: linear-gradient(180deg, rgba(59,130,246,.1), transparent 90%);
    border-bottom: 1px solid var(--line);
}
.mark {
    width: 24px; height: 24px; border-radius: 8px; flex: none;
    display: grid; place-items: center; color: #fff;
    background: linear-gradient(145deg, var(--accent), var(--accent-3));
}
.top h1 { flex: 1; font-size: 12.5px; font-weight: 620; letter-spacing: -.1px; }
.step {
    font-size: 10.5px; font-weight: 650; letter-spacing: .3px; padding: 2px 8px;
    border-radius: 999px; background: var(--soft); border: 1px solid var(--soft-2);
    color: var(--accent-2); font-variant-numeric: tabular-nums;
}
.body { padding: 12px; }
.fname {
    font-size: 12.5px; font-weight: 550; color: var(--fg);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.track { height: 4px; border-radius: 99px; background: var(--line); overflow: hidden; margin: 10px 0 8px; }
.track i {
    display: block; height: 100%; width: 0; border-radius: 99px;
    background: linear-gradient(90deg, var(--accent-3), var(--accent), var(--accent-2), var(--accent));
    background-size: 200% 100%; animation: sheen 2.2s linear infinite;
    transition: width .3s cubic-bezier(.3,.9,.3,1);
}
.note {
    display: flex; align-items: center; gap: 7px;
    font-size: 11.5px; color: var(--fg-2); min-height: 18px;
}
.note svg { flex: none; animation: spin 1s linear infinite; }
.note.ok { color: var(--accent-2); }
.note.ok svg, .note.bad svg { animation: none; }
.note.bad { color: var(--danger); }
.note span { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.acts { display: flex; gap: 7px; margin-top: 12px; }
.acts[hidden] { display: none; }
.btn {
    flex: 1; cursor: pointer; padding: 8px 12px; border-radius: 10px;
    font-family: var(--font); font-size: 12px; font-weight: 550;
    border: 1px solid var(--line-2); background: var(--raised); color: var(--fg-2);
    transition: background .14s, color .14s, border-color .14s;
}
.btn:hover { background: var(--hover); color: var(--fg); }
.btn.stop { color: var(--danger); border-color: rgba(255,107,107,.3); }
.btn.stop:hover { background: var(--danger-soft); border-color: var(--danger); }
`;

const ICON = {
    bolt: '<path d="M8.6 1.5 3.4 8.6a.4.4 0 0 0 .3.6h2.8l-.9 5.1a.3.3 0 0 0 .5.3l5.4-7.2a.4.4 0 0 0-.3-.6H8.4l.7-4.5a.3.3 0 0 0-.5-.3Z"/>',
    gear: '<circle cx="8" cy="8" r="2.1" stroke="currentColor" stroke-width="1.25" fill="none"/><path d="M12.9 8c0-.3 0-.6-.1-.9l1.2-.9-1.3-2.2-1.4.5c-.4-.4-.9-.6-1.4-.8L9.6 2.3H7l-.3 1.4c-.5.2-1 .4-1.4.8l-1.4-.5-1.3 2.2 1.2.9a5 5 0 0 0 0 1.8l-1.2.9 1.3 2.2 1.4-.5c.4.4.9.6 1.4.8l.3 1.4h2.6l.3-1.4c.5-.2 1-.4 1.4-.8l1.4.5 1.3-2.2-1.2-.9c.1-.3.1-.6.1-.9Z" stroke="currentColor" stroke-width="1.25" fill="none" stroke-linejoin="round"/>',
    minus: '<path d="M4 8h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
    search: '<circle cx="7.2" cy="7.2" r="4.2" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="m10.4 10.4 2.8 2.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
    paste: '<rect x="3.8" y="2.8" width="8.4" height="11.4" rx="1.8" stroke="currentColor" stroke-width="1.3" fill="none"/><rect x="6" y="1.6" width="4" height="2.6" rx=".9" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M6.3 8.2h3.4M6.3 10.9h2.2" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>',
    play: '<path d="M5.4 3.3a.4.4 0 0 1 .6-.3l6.4 4.6a.5.5 0 0 1 0 .8L6 13a.4.4 0 0 1-.6-.3V3.3Z"/>',
    stop: '<rect x="4.4" y="4.4" width="7.2" height="7.2" rx="1.6"/>',
    trash: '<path d="M3.6 4.6h8.8M6.6 4.6V3.3a.8.8 0 0 1 .8-.8h1.2a.8.8 0 0 1 .8.8v1.3M5.2 4.6l.5 8a1 1 0 0 0 1 .9h2.6a1 1 0 0 0 1-.9l.5-8" stroke="currentColor" stroke-width="1.25" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    copy: '<rect x="5.6" y="5.6" width="7.8" height="7.8" rx="1.8" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M10.4 5.6V4.4a1.8 1.8 0 0 0-1.8-1.8H4.4a1.8 1.8 0 0 0-1.8 1.8v4.2a1.8 1.8 0 0 0 1.8 1.8h1.2" stroke="currentColor" stroke-width="1.3" fill="none"/>',
    save: '<path d="M8 2.6v6.8m0 0L5.6 7M8 9.4 10.4 7M3 11.2v1.2a1.6 1.6 0 0 0 1.6 1.6h6.8a1.6 1.6 0 0 0 1.6-1.6v-1.2" stroke="currentColor" stroke-width="1.35" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    link: '<path d="M6.7 9.3a2.5 2.5 0 0 0 3.6 0l2-2a2.5 2.5 0 0 0-3.6-3.6l-.8.8M9.3 6.7a2.5 2.5 0 0 0-3.6 0l-2 2a2.5 2.5 0 0 0 3.6 3.6l.8-.8" stroke="currentColor" stroke-width="1.35" fill="none" stroke-linecap="round"/>',
    open: '<path d="M9.2 3h3.8v3.8M13 3 7.8 8.2M11.4 9.6v2.8a1.2 1.2 0 0 1-1.2 1.2H3.8a1.2 1.2 0 0 1-1.2-1.2V6a1.2 1.2 0 0 1 1.2-1.2h2.8" stroke="currentColor" stroke-width="1.35" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    retry: '<path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.8V6H9.8" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    history: '<path d="M3.1 8a4.9 4.9 0 1 0 1.5-3.5M3 2.9V6h3.1" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 5.4V8l1.9 1.4" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    check: '<path d="m3.6 8.4 3 3 5.8-6.4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    cross: '<path d="m4.6 4.6 6.8 6.8M11.4 4.6l-6.8 6.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
    dot: '<circle cx="8" cy="8" r="2.6" stroke="currentColor" stroke-width="1.3" fill="none"/>',
    spin: '<path d="M8 2.4a5.6 5.6 0 1 0 5.6 5.6" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>',
    grip: '<path d="M13 5 5 13M13 9.5 9.5 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
    empty: '<path d="M3 13h6l1 2h4l1-2h6M3 13l3-8h12l3 8v5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18v-5Z" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
};

const NS = 'http://www.w3.org/2000/svg';

function svg(name, size) {
    const el = document.createElementNS(NS, 'svg');
    const box = name === 'empty' ? 24 : 16;
    el.setAttribute('viewBox', `0 0 ${box} ${box}`);
    el.setAttribute('width', size || 15);
    el.setAttribute('height', size || 15);
    el.setAttribute('fill', 'currentColor');
    el.innerHTML = ICON[name] || '';
    return el;
}

function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
}

function iconBtn(cls, name, title, size) {
    const b = h('button', cls);
    b.appendChild(svg(name, size || 15));
    if (title) b.title = title;
    return b;
}

function shadowHost(id, css) {
    const host = document.createElement('div');
    host.id = id;
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = css;
    root.appendChild(style);
    (document.body || document.documentElement).appendChild(host);
    return { host, root };
}

function buildHopCard(soloMode) {
    const { root } = shadowHost('ffbypasser-hop', HOP_CSS);

    const wrap = h('div', 'wrap');
    const card = h('div', 'card');

    const top = h('div', 'top');
    const mark = h('div', 'mark');
    mark.appendChild(svg('bolt', 14));
    const step = h('span', 'step', '');
    top.append(mark, h('h1', null, 'FFBypasser'), step);

    const body = h('div', 'body');
    const fname = h('div', 'fname', '…');
    const track = h('div', 'track');
    const fill = h('i');
    track.appendChild(fill);

    const note = h('div', 'note');
    const noteTxt = h('span', null, 'starting…');
    note.append(svg('spin', 13), noteTxt);

    const acts = h('div', 'acts');
    const btnSkip = h('button', 'btn', 'Skip this file');
    const btnStop = h('button', 'btn stop', 'Stop and go back');
    acts.append(btnSkip, btnStop);
    acts.hidden = !!soloMode;

    body.append(fname, track, note, acts);
    card.append(top, body);
    wrap.appendChild(card);
    root.appendChild(wrap);

    const swapIcon = name => note.replaceChild(svg(name, 13), note.firstChild);

    return {
        setStep(index, total, name, doneCount) {
            step.textContent = `${index} / ${total}`;
            fname.textContent = name || '…';
            fname.title = name || '';
            fill.style.width = total ? Math.round(doneCount / total * 100) + '%' : '0%';
        },
        note(msg) {
            note.className = 'note';
            noteTxt.textContent = msg;
            noteTxt.title = msg;
        },
        ok(msg) {
            note.className = 'note ok';
            swapIcon('check');
            noteTxt.textContent = msg;
            noteTxt.title = msg;
        },
        fail(msg) {
            note.className = 'note bad';
            swapIcon('cross');
            noteTxt.textContent = msg;
            noteTxt.title = msg;
        },
        onSkip(fn) { btnSkip.addEventListener('click', fn); },
        onCancel(fn) { btnStop.addEventListener('click', fn); },
    };
}

const ui = {};
let filter = 'all';

function buildUI() {
    const { root } = shadowHost('ffbypasser-host', CSS);

    const fabWrap = h('div', 'wrap fabwrap');
    fabWrap.hidden = true;
    const fab = h('button', 'fab');
    fab.title = 'FFBypasser  ·  Alt+F';
    fab.appendChild(svg('bolt', 19));
    const badge = h('span', 'badge');
    badge.hidden = true;
    fab.appendChild(badge);
    fabWrap.appendChild(fab);

    const wrap = h('div', 'wrap');
    const panel = h('div', 'panel');
    panel.hidden = true;

    const head = h('div', 'head');
    const mark = h('div', 'mark');
    mark.appendChild(svg('bolt', 14));
    const htxt = h('div', 'htxt');
    htxt.append(
        h('h1', null, 'FFBypasser'),
        h('small', 'where', onHost ? 'fuckingfast.co · direct mode' : location.hostname),
    );
    const btnSet = iconBtn('ico', 'gear', 'Settings');
    const btnMin = iconBtn('ico', 'minus', 'Minimize  ·  Esc');
    head.append(mark, htxt, btnSet, btnMin);

    const actions = h('div', 'actions');
    const primary = h('button', 'btn primary');
    const btnScan = iconBtn('btn sq ghost', 'search', 'Scan this page');
    const btnPaste = iconBtn('btn sq ghost', 'paste', 'Paste links');
    const btnRestore = iconBtn('btn sq ghost', 'history', 'Restore the saved list');
    const btnClear = iconBtn('btn sq ghost', 'trash', 'Clear the list and the saved history');
    actions.append(primary, btnScan, btnPaste, btnRestore, btnClear);

    const statsRow = h('div', 'stats');
    const statAll = h('button', 'stat on');
    const statOk = h('button', 'stat');
    const statFail = h('button', 'stat bad');
    [[statAll, 'Links'], [statOk, 'Resolved'], [statFail, 'Failed']].forEach(pair => {
        pair[0].append(h('b', null, '0'), h('span', null, pair[1]));
        statsRow.appendChild(pair[0]);
    });

    const prog = h('div', 'prog');
    prog.hidden = true;
    const track = h('div', 'track');
    const trackFill = h('i');
    track.appendChild(trackFill);
    const pct = h('div', 'pct', '');
    prog.append(track, pct);

    const find = h('div', 'find');
    find.hidden = true;
    const findInput = document.createElement('input');
    findInput.type = 'text';
    findInput.placeholder = 'Filter by name or link…';
    findInput.spellcheck = false;
    find.append(svg('search', 13), findInput);

    const list = h('div', 'list');

    const pasteBox = h('div', 'drawer');
    pasteBox.hidden = true;
    const area = document.createElement('textarea');
    area.placeholder = 'https://fuckingfast.co/abc123#Game.part001.rar\nhttps://fuckingfast.co/def456#Game.part002.rar';
    area.spellcheck = false;
    const pasteRow = h('div', 'drawrow');
    const btnAdd = h('button', 'btn primary', 'Add links');
    const btnPasteClose = h('button', 'btn', 'Cancel');
    pasteRow.append(btnAdd, btnPasteClose);
    pasteBox.append(
        area,
        h('div', 'hint', 'One per line, or a JSON array. Anything that is not a fuckingfast.co file link is ignored.'),
        pasteRow,
    );

    const setBox = h('div', 'drawer');
    setBox.hidden = true;

    const optNum = (title, note, key, min, max, stepBy) => {
        const row = h('div', 'opt');
        const lab = h('div', 'lab');
        lab.append(h('span', null, title), h('small', null, note));
        const inp = document.createElement('input');
        inp.type = 'number';
        inp.min = String(min);
        inp.max = String(max);
        inp.step = String(stepBy || 1);
        inp.value = String(CFG[key]);
        inp.addEventListener('change', () => {
            CFG[key] = clamp(Number(inp.value) || DEFAULTS[key], min, max);
            inp.value = String(CFG[key]);
            saveCfg();
        });
        row.append(lab, inp);
        return row;
    };

    const optToggle = (title, note, key, onFlip) => {
        const row = h('div', 'opt');
        const lab = h('div', 'lab');
        lab.append(h('span', null, title), h('small', null, note));
        const sw = h('button', 'sw' + (CFG[key] ? ' on' : ''));
        sw.title = title;
        sw.addEventListener('click', () => {
            CFG[key] = !CFG[key];
            sw.classList.toggle('on', CFG[key]);
            saveCfg();
            if (onFlip) onFlip();
        });
        row.append(lab, sw);
        return row;
    };

    const hopOpts = h('div', 'sub-opt');
    hopOpts.append(optNum('Wait per file', 'Milliseconds to spend on one file page', 'hopWaitMs', 15000, 600000, 5000));
    hopOpts.hidden = !CFG.hopMode;

    const relayOpts = h('div', 'sub-opt');
    relayOpts.append(
        optToggle('Use background tabs', 'Turn off to only try the silent request', 'autoRelay'),
        optNum('Background tabs', 'How many open at once', 'relayTabs', 1, 4),
        optNum('Wait per tab', 'Milliseconds to wait for a background tab', 'relayWaitMs', 10000, 600000, 5000),
    );
    relayOpts.hidden = !!CFG.hopMode;

    setBox.append(
        optToggle('Redirect this tab', 'Walk the file pages in this tab, then come back here. Off = background tabs.', 'hopMode', () => {
            hopOpts.hidden = !CFG.hopMode;
            relayOpts.hidden = !!CFG.hopMode;
            render();
        }),
        hopOpts,
        relayOpts,
        optNum('Parallel jobs', 'Silent requests running at once', 'concurrency', 1, 12),
        optNum('Delay between jobs', 'Milliseconds. Raise if rate limited', 'delayMs', 0, 10000, 100),
        optNum('Request timeout', 'Milliseconds per HTTP request', 'timeoutMs', 5000, 120000, 1000),
        optToggle('Debug frames', 'Show the hidden worker iframes', 'showFrames', () => {
            if (framePanel) framePanel.style.opacity = CFG.showFrames ? '1' : '0';
        }),
    );

    const foot = h('div', 'foot');
    foot.hidden = true;
    const btnCopy = h('button', 'btn primary');
    btnCopy.append(svg('copy', 14), h('span', null, 'Copy links'));
    const btnSave = iconBtn('btn sq', 'save', 'Save as .txt');
    const btnCopySrc = iconBtn('btn sq', 'link', 'Copy source links as JSON');
    foot.append(btnCopy, btnSave, btnCopySrc);

    const toast = h('div', 'toast');
    const grip = h('div', 'grip');
    grip.appendChild(svg('grip', 15));
    grip.title = 'Drag to resize';

    panel.append(head, actions, statsRow, prog, find, list, pasteBox, setBox, foot, toast, grip);
    wrap.appendChild(panel);
    root.append(fabWrap, wrap);

    Object.assign(ui, {
        root, panel, wrap, fabWrap, fab, badge, head, list, toast, foot, grip,
        statAll, statOk, statFail, track, trackFill, prog, pct, primary,
        find, findInput, btnScan, btnPaste, btnRestore, btnClear,
        btnCopy, btnSave, btnCopySrc, btnSet, pasteBox, area, setBox, primaryFn: null,
    });

    const savedSize = gmGet(KEY_SIZE, null);
    if (savedSize && Number.isFinite(savedSize.w)) {
        panel.style.width = clamp(savedSize.w, 360, 720) + 'px';
        if (Number.isFinite(savedSize.h)) panel.style.maxHeight = clamp(savedSize.h, 260, 900) + 'px';
    }

    const savedPos = gmGet(KEY_POS, null);
    if (savedPos && Number.isFinite(savedPos.x) && Number.isFinite(savedPos.y)) {
        userPlaced = true;
        placePanel(savedPos.x, savedPos.y);
    } else {
        placePanel(window.innerWidth - 480, window.innerHeight - 560);
    }

    fab.addEventListener('click', () => togglePanel(true));
    btnMin.addEventListener('click', () => togglePanel(false));
    primary.addEventListener('click', () => { if (ui.primaryFn) ui.primaryFn(); });

    btnSet.addEventListener('click', () => toggleDrawer(setBox, btnSet));
    btnScan.addEventListener('click', () => doScan());
    btnRestore.addEventListener('click', () => doRestore());
    btnClear.addEventListener('click', () => doClear());

    btnPaste.addEventListener('click', () => {
        toggleDrawer(pasteBox, null);
        if (!pasteBox.hidden) area.focus();
    });
    btnPasteClose.addEventListener('click', () => { pasteBox.hidden = true; });
    btnAdd.addEventListener('click', () => {
        const res = addLinks(parseLinks(area.value));
        if (res.added) { area.value = ''; pasteBox.hidden = true; }
        persist();
        render();
        say(scanMessage(res));
    });

    btnCopy.addEventListener('click', () => copyResults());
    btnCopySrc.addEventListener('click', () => {
        if (!state.items.length) return say('List is empty');
        toClipboard(JSON.stringify(state.items.map(i => i.url), null, 4));
        say(`Copied ${plural(state.items.length, 'source link')}`);
    });
    btnSave.addEventListener('click', () => {
        const lines = resultLines();
        if (!lines.length) return say('Nothing resolved yet');
        download(lines.join('\n'), 'Out_Direct_Links.txt');
        say('Saved Out_Direct_Links.txt');
    });

    findInput.addEventListener('input', () => {
        state.query = findInput.value.trim().toLowerCase();
        renderList();
    });

    const bindStat = (name, el) => el.addEventListener('click', () => {
        filter = filter === name ? 'all' : name;
        const active = filter === 'all' ? statAll : el;
        [statAll, statOk, statFail].forEach(s => s.classList.toggle('on', s === active));
        renderList();
    });
    bindStat('all', statAll);
    bindStat('ok', statOk);
    bindStat('fail', statFail);

    makeDraggable();
    makeResizable();

    window.addEventListener('keydown', e => {
        if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'f' || e.key === 'F')) {
            e.preventDefault();
            ui.fabWrap.hidden = false;
            togglePanel(panel.hidden);
            return;
        }
        if (panel.hidden) return;
        if (e.key === 'Escape') {
            if (!pasteBox.hidden || !setBox.hidden) {
                pasteBox.hidden = true;
                setBox.hidden = true;
                btnSet.classList.remove('on');
            } else {
                togglePanel(false);
            }
            return;
        }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            if (!state.running) runAll();
        }
    }, true);

    window.addEventListener('resize', () => {
        if (ui.panel.hidden) return;
        if (userPlaced) placePanel(panelPos.x, panelPos.y);
        else anchorPanel();
    });
}

function toggleDrawer(box, toggleBtn) {
    const opening = box.hidden;
    ui.pasteBox.hidden = true;
    ui.setBox.hidden = true;
    ui.btnSet.classList.remove('on');
    box.hidden = !opening;
    if (toggleBtn) toggleBtn.classList.toggle('on', opening);
}

function doScan() {
    const res = addLinks(collectDeep());
    persist();
    render();
    say(scanMessage(res));
}

function doRestore() {
    if (state.running) return say('Stop the run first');
    const added = loadHistory();
    render();
    say(added ? `Restored ${plural(added, 'link')}` : 'Nothing saved to restore');
}

function doClear() {
    if (state.running) return say('Stop the run first');
    if (!state.items.length && !history.length) return say('Nothing to clear');
    state.items = [];
    state.query = '';
    if (ui.findInput) ui.findInput.value = '';
    wipeHistory();
    clearHop();
    render();
    say('List and saved history cleared');
}

function copyResults() {
    const lines = resultLines();
    if (!lines.length) return say('Nothing resolved yet');
    toClipboard(lines.join('\n'));
    say(`Copied ${plural(lines.length, 'direct link')}`);
}

function scanMessage(res) {
    if (res.added) return `Added ${plural(res.added, 'link')}`;
    if (res.dup) return `Already in the list (${plural(res.dup, 'duplicate')})`;
    return 'No fuckingfast.co file links found';
}

const panelPos = { x: 0, y: 0 };
let userPlaced = false;

function anchorPanel() {
    const w = ui.panel.offsetWidth || 456;
    const hh = ui.panel.offsetHeight || 520;
    placePanel(window.innerWidth - w - 20, window.innerHeight - hh - 20);
}

function placePanel(x, y) {
    const w = ui.panel.offsetWidth || 456;
    const hh = ui.panel.offsetHeight || 320;
    panelPos.x = clamp(x, 8, Math.max(8, window.innerWidth - w - 8));
    panelPos.y = clamp(y, 8, Math.max(8, window.innerHeight - Math.min(hh, 140) - 8));
    ui.wrap.style.left = panelPos.x + 'px';
    ui.wrap.style.top = panelPos.y + 'px';
}

function makeDraggable() {
    let start = null;
    ui.head.addEventListener('mousedown', e => {
        if (e.target.closest('.ico')) return;
        start = { mx: e.clientX, my: e.clientY, x: panelPos.x, y: panelPos.y };
        ui.head.classList.add('drag');
        e.preventDefault();
    });
    window.addEventListener('mousemove', e => {
        if (!start) return;
        placePanel(start.x + e.clientX - start.mx, start.y + e.clientY - start.my);
    });
    window.addEventListener('mouseup', () => {
        if (!start) return;
        start = null;
        userPlaced = true;
        ui.head.classList.remove('drag');
        gmSet(KEY_POS, panelPos);
    });
}

function makeResizable() {
    let start = null;
    ui.grip.addEventListener('mousedown', e => {
        start = { mx: e.clientX, my: e.clientY, w: ui.panel.offsetWidth, h: ui.panel.offsetHeight };
        e.preventDefault();
        e.stopPropagation();
    });
    window.addEventListener('mousemove', e => {
        if (!start) return;
        const w = clamp(start.w + e.clientX - start.mx, 360, Math.min(720, window.innerWidth - 24));
        const hh = clamp(start.h + e.clientY - start.my, 260, Math.min(900, window.innerHeight - 24));
        ui.panel.style.width = w + 'px';
        ui.panel.style.maxHeight = hh + 'px';
    });
    window.addEventListener('mouseup', () => {
        if (!start) return;
        start = null;
        gmSet(KEY_SIZE, { w: ui.panel.offsetWidth, h: ui.panel.offsetHeight });
        if (userPlaced) placePanel(panelPos.x, panelPos.y);
        else anchorPanel();
    });
}

function togglePanel(show) {
    ui.panel.hidden = !show;
    ui.fabWrap.hidden = show;
    if (show) {
        render();
        if (userPlaced) placePanel(panelPos.x, panelPos.y);
        else anchorPanel();
    }
}

let toastTimer = null;

function say(msg) {
    if (!ui.toast) return;
    ui.toast.textContent = msg;
    ui.toast.title = msg;
    ui.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 2600);
}

function toClipboard(text) {
    try {
        if (typeof GM_setClipboard === 'function') { GM_setClipboard(text, 'text'); return; }
    } catch {}
    try { navigator.clipboard.writeText(text); } catch {}
}

function download(text, name) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    (document.body || document.documentElement).appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const STATUS_ICON = { pending: 'dot', working: 'spin', ok: 'check', fail: 'cross' };

function setPrimary(iconName, label, variant, fn) {
    ui.primary.className = 'btn primary' + (variant ? ' ' + variant : '');
    ui.primary.innerHTML = '';
    ui.primary.append(svg(iconName, 14), h('span', null, label));
    ui.primary.disabled = !fn;
    ui.primaryFn = fn;
}

function updatePrimary(s, restorable) {
    if (state.running) {
        setPrimary('stop', `Stop  ·  ${s.done}/${s.total}`, 'stop', () => {
            state.stop = true;
            abortAll();
            for (const i of state.items) {
                if (i.status === 'working') { i.status = 'pending'; i.note = null; }
            }
            render();
            say('Stopped');
        });
        return;
    }
    if (!s.total) {
        if (restorable) {
            setPrimary('history', `Restore ${plural(restorable, 'link')}`, null, doRestore);
        } else {
            setPrimary('search', 'Scan this page', null, doScan);
        }
        return;
    }
    if (s.pending) {
        const label = CFG.hopMode && !onHost
            ? `Resolve ${plural(s.pending, 'link')} on the site`
            : `Resolve ${plural(s.pending, 'link')}`;
        setPrimary('play', label, null, () => runAll());
        return;
    }
    setPrimary('copy', `Copy ${plural(s.ok, 'link')}`, null, copyResults);
}

function setStat(el, value, label) {
    el.innerHTML = '';
    el.append(h('b', null, String(value)), h('span', null, label));
}

function render() {
    if (!ui.panel) return;
    const s = stats();
    const restorable = restorableCount();

    setStat(ui.statAll, s.total, 'Links');
    setStat(ui.statOk, s.ok, 'Resolved');
    setStat(ui.statFail, s.fail, 'Failed');

    ui.prog.hidden = !s.total;
    const pctVal = s.total ? Math.round(s.done / s.total * 100) : 0;
    ui.trackFill.style.width = pctVal + '%';
    ui.pct.textContent = `${s.done}/${s.total} · ${pctVal}%`;

    const count = s.pending || s.total;
    ui.badge.textContent = count > 99 ? '99+' : String(count);
    ui.badge.hidden = !count;

    updatePrimary(s, restorable);
    ui.btnScan.disabled = state.running;
    ui.btnPaste.disabled = state.running;
    ui.btnRestore.disabled = state.running || !restorable;
    ui.btnRestore.title = restorable
        ? `Restore ${plural(restorable, 'saved link')}`
        : 'Nothing saved to restore';
    ui.btnClear.disabled = state.running || !(s.total || history.length);
    ui.foot.hidden = !s.ok;
    ui.find.hidden = s.total < 7;
    if (ui.find.hidden && state.query) {
        state.query = '';
        ui.findInput.value = '';
    }

    renderList(restorable);
}

function visibleItems() {
    const q = state.query;
    return state.items.filter(i => {
        if (filter === 'ok' && i.status !== 'ok') return false;
        if (filter === 'fail' && i.status !== 'fail') return false;
        if (!q) return true;
        return i.name.toLowerCase().includes(q)
            || i.url.toLowerCase().includes(q)
            || (i.out || '').toLowerCase().includes(q);
    });
}

function renderList(restorable) {
    const list = visibleItems();
    ui.list.innerHTML = '';

    if (!list.length) {
        const saved = restorable == null ? restorableCount() : restorable;
        const hasItems = state.items.length > 0;
        const empty = h('div', 'empty');
        const eic = h('div', 'eic');
        eic.appendChild(svg('empty', 32));
        empty.append(
            eic,
            h('h2', null, hasItems ? 'Nothing matches' : 'No links yet'),
            h('p', null, hasItems
                ? 'Clear the filter to see the whole list.'
                : saved
                    ? `Scan this page, paste links in, or bring back the ${plural(saved, 'saved link')}.`
                    : 'Scan this page, or paste links in by hand.'),
        );
        if (!hasItems && saved && !state.running) {
            const b = h('button', 'btn');
            b.append(svg('history', 14), h('span', null, `Restore ${plural(saved, 'link')}`));
            b.addEventListener('click', () => doRestore());
            empty.appendChild(b);
        }
        ui.list.appendChild(empty);
        return;
    }

    const frag = document.createDocumentFragment();
    for (const item of list) {
        const row = h('div', 'row ' + (item.status === 'working' ? 'work' : item.status));

        const st = h('div', 'st');
        st.appendChild(svg(STATUS_ICON[item.status] || 'dot', 14));

        const info = h('div', 'info');
        const fname = h('div', 'fname', item.name);
        fname.title = item.url;

        const sub = h('div', 'sub');
        const subTxt = h('span', 'txt');
        if (item.status === 'ok') {
            subTxt.textContent = item.out;
            sub.appendChild(subTxt);
            if (item.via) sub.appendChild(h('span', 'tag', item.via));
            sub.title = item.out;
        } else if (item.status === 'fail') {
            subTxt.textContent = item.err || 'failed';
            sub.appendChild(subTxt);
            sub.title = item.err || '';
        } else {
            subTxt.textContent = item.note || (item.status === 'working' ? 'resolving…' : 'queued');
            sub.appendChild(subTxt);
        }
        info.append(fname, sub);

        const acts = h('div', 'acts');
        if (item.status === 'ok') {
            const o = iconBtn('act', 'open', 'Open direct link', 13);
            o.addEventListener('click', e => {
                e.stopPropagation();
                window.open(item.out, '_blank', 'noopener');
            });
            acts.appendChild(o);
            row.title = 'Click to copy';
            row.addEventListener('click', () => { toClipboard(item.out); say('Copied'); });
        } else if (!state.running) {
            const r = iconBtn('act', 'retry', 'Retry this link', 13);
            r.addEventListener('click', e => { e.stopPropagation(); runAll([item]); });
            acts.appendChild(r);
        }
        const src = iconBtn('act', 'link', item.url, 13);
        src.addEventListener('click', e => {
            e.stopPropagation();
            window.open(item.url, '_blank', 'noopener');
        });
        acts.appendChild(src);

        row.append(st, info, acts);
        frag.appendChild(row);
    }
    ui.list.appendChild(frag);
}

async function runPool(items, worker, size) {
    let cursor = 0;
    const lanes = Array.from({ length: clamp(size, 1, 12) }, async () => {
        while (!state.stop && !state.bail) {
            const i = cursor++;
            if (i >= items.length) break;
            await worker(items[i]);
            await napt(CFG.delayMs);
        }
    });
    await Promise.all(lanes);
}

async function phaseSilent(queue) {
    let challenges = 0, solved = 0;

    await runPool(queue, async item => {
        if (state.stop) return;
        item.status = 'working';
        item.note = null;
        renderList();
        try {
            item.out = await resolveDirect(item);
            item.via = 'direct';
            item.status = 'ok';
            item.err = null;
            solved++;
        } catch (e) {
            if (state.stop) { item.status = 'pending'; item.note = null; return; }
            let done = false;
            if (onHost) {
                try {
                    item.out = await resolveInFrame(item);
                    item.via = 'frame';
                    item.status = 'ok';
                    item.err = null;
                    solved++;
                    done = true;
                } catch {}
            }
            if (!done) {
                item.status = 'fail';
                item.err = e.message || String(e);
                item.out = null;
                if (/cloudflare|captcha|challenge/i.test(item.err)) challenges++;
            }
        }
        item.note = null;
        if (!solved && challenges >= 3 && CFG.hopMode && !onHost) {
            state.bail = true;
            abortAll();
        }
        render();
    }, CFG.concurrency);
}

async function phaseRelay(queue) {
    await runPool(queue, async item => {
        if (state.stop) return;
        item.status = 'working';
        renderList();
        try {
            item.out = await resolveRelay(item, note => { item.note = note; renderList(); });
            item.via = 'relay';
            item.status = 'ok';
            item.err = null;
        } catch (e) {
            if (state.stop) { item.status = 'pending'; item.note = null; return; }
            item.status = 'fail';
            item.err = e.message || String(e);
            item.out = null;
        }
        item.note = null;
        render();
    }, CFG.relayTabs);
}

async function runAll(subset) {
    if (state.running) return;
    const queue = (subset || state.items).filter(i => i.status !== 'ok');
    if (!queue.length) {
        return say(state.items.length ? 'Everything is resolved already' : 'Add some links first');
    }

    state.stop = false;
    state.bail = false;
    queue.forEach(i => { i.status = 'pending'; i.err = null; i.note = null; });
    render();

    if (CFG.hopMode && !onHost) {
        say(`Redirecting to the site · ${plural(queue.length, 'link')}`);
        await napt(700);
        if (startHop(subset || state.items, location.href)) return;
    }

    state.running = true;
    render();

    const started = performance.now();
    await phaseSilent(queue);

    if (state.bail) {
        for (const i of queue) {
            if (i.status !== 'ok') { i.status = 'pending'; i.err = null; i.note = null; }
        }
    }

    let left = queue.filter(i => i.status !== 'ok');
    if (!state.stop && !state.bail && left.length && !CFG.hopMode && CFG.autoRelay) {
        await phaseRelay(left);
        left = queue.filter(i => i.status !== 'ok');
    }

    if (framePanel) { framePanel.remove(); framePanel = null; }
    state.running = false;
    for (const i of state.items) if (i.status === 'working') i.status = 'pending';
    persist();
    render();

    const s = stats();
    const secs = ((performance.now() - started) / 1000).toFixed(1);

    if (state.stop) {
        say(`Stopped · ${s.ok}/${s.total} resolved`);
        if (s.ok) toClipboard(resultLines().join('\n'));
        return;
    }

    if (left.length && CFG.hopMode) {
        say(`${plural(left.length, 'link')} need the site · redirecting…`);
        await napt(1200);
        if (!state.stop && startHop(subset || state.items, location.href)) return;
    }

    say(`Done · ${s.ok}/${s.total} resolved in ${secs}s`);
    if (s.ok) toClipboard(resultLines().join('\n'));
}

function boot() {
    if (window.top !== window.self) return;
    if (document.getElementById('ffbypasser-host')) return;
    if (document.getElementById('ffbypasser-hop')) return;

    pruneJobs();
    const hop = readHop();

    if (onHost && hop && hop.active && !hop.cancelled) {
        if (hopExpired(hop)) clearHop();
        else if (hop.hops.some(x => x.id === fileIdOf(location.href))) { runHop(hop); return; }
    }

    if (onHost) {
        const job = readJobs()[fileIdOf(location.href)];
        if (job && job.state === 'pending') { runWorker(); return; }
    }

    refreshHistory();
    const home = !!(hop && hop.finished && (sameUrl(location.href, hop.returnUrl) || !onHost));

    buildUI();

    if (home) loadHistory();
    const res = addLinks(collectAnchors());
    let show = !!(res.matched || onHost || state.items.length);

    render();

    if (home) {
        const sum = hopSummary(hop);
        clearHop();
        togglePanel(true);
        say(hop.cancelled
            ? `Stopped · ${sum.ok}/${sum.total} resolved on the site`
            : `Back · ${sum.ok}/${sum.total} resolved on the site`);
        if (resultLines().length) toClipboard(resultLines().join('\n'));
    } else if (res.added) {
        say(`Found ${plural(res.added, 'link')} on this page`);
    }

    ui.fabWrap.hidden = !show || !ui.panel.hidden;

    try {
        GM_registerMenuCommand('Open FFBypasser', () => {
            ui.fabWrap.hidden = false;
            togglePanel(true);
        });
        GM_registerMenuCommand('Scan page for links', () => {
            ui.fabWrap.hidden = false;
            togglePanel(true);
            doScan();
        });
        GM_registerMenuCommand('Restore saved list', () => {
            ui.fabWrap.hidden = false;
            togglePanel(true);
            doRestore();
        });
        GM_registerMenuCommand('Clear list and saved history', () => {
            ui.fabWrap.hidden = false;
            togglePanel(true);
            doClear();
        });
        GM_registerMenuCommand('Cancel redirect run', () => {
            clearHop();
            say('Redirect run cleared');
        });
    } catch {}
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
    boot();
}

})();
