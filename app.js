/* Meteo dashboard pre Slovenský Grob.
   Písané v starom JavaScripte (ES5, XMLHttpRequest), aby fungovalo aj
   v starých Android prehliadačoch na čítačke a slabšom tablete. */
(function () {
  'use strict';

  var LAT = 48.2603, LON = 17.2786;
  var TZ = 'Europe/Bratislava';

  var FORECAST_URL = 'https://api.open-meteo.com/v1/forecast' +
    '?latitude=' + LAT + '&longitude=' + LON +
    '&timezone=' + encodeURIComponent(TZ) +
    '&past_days=1&forecast_days=7' +
    '&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m' +
    '&hourly=temperature_2m,pressure_msl,dew_point_2m' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,sunrise,sunset,wind_speed_10m_max,wind_gusts_10m_max';
  var AIR_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality' +
    '?latitude=' + LAT + '&longitude=' + LON +
    '&timezone=' + encodeURIComponent(TZ) +
    '&current=european_aqi,pm2_5,pm10';

  var RETRY_MIN = 2;          // pri chybe skúsiť znova o 2 minúty
  var CACHE_KEY = 'meteo-cache-v1';
  var MODE_KEY = 'meteo-mode';
  var ROT_KEY = 'meteo-rotate';
  var rotation = 0;

  var DAYS_SHORT = ['Ne', 'Po', 'Ut', 'St', 'Št', 'Pi', 'So'];
  var DAYS_LONG = ['nedeľa', 'pondelok', 'utorok', 'streda', 'štvrtok', 'piatok', 'sobota'];
  var MONTHS = ['januára', 'februára', 'marca', 'apríla', 'mája', 'júna', 'júla',
    'augusta', 'septembra', 'októbra', 'novembra', 'decembra'];
  var DIRS = ['S', 'SV', 'V', 'JV', 'J', 'JZ', 'Z', 'SZ'];

  var state = { forecast: null, air: null, fetchedAt: null, nextAt: null, error: null };
  var refreshTimer = null;

  function $(id) { return document.getElementById(id); }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function hhmm(d) { return d.getHours() + ':' + pad(d.getMinutes()); }
  function fmt(n, dec) {
    if (n === null || n === undefined || isNaN(n)) return '--';
    return n.toFixed(dec || 0).replace('.', ',').replace(/^-(0(,0+)?)$/, '$1');
  }
  function setText(id, t) { var el = $(id); if (el) el.textContent = t; }

  // Open-Meteo vracia miestny čas "2026-11-20T19:00"
  function parseLocal(s) {
    var m = /^(\d+)-(\d+)-(\d+)(?:T(\d+):(\d+))?/.exec(s);
    return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
  }
  function dateKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

  /* ---------------- Režim tablet / čítačka ---------------- */

  function getMode() {
    var q = /[?&]rezim=(tablet|citacka|eink)/.exec(location.search);
    if (q) return q[1] === 'tablet' ? 'tablet' : 'eink';
    try { var m = localStorage.getItem(MODE_KEY); if (m === 'eink' || m === 'tablet') return m; } catch (e) {}
    return 'tablet';
  }
  function setMode(mode, save) {
    document.body.className = mode;
    $('mode-tablet').className = mode === 'tablet' ? 'on' : '';
    $('mode-eink').className = mode === 'eink' ? 'on' : '';
    var meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.setAttribute('content', mode === 'eink' ? '#ffffff' : '#11161c');
    if (save) { try { localStorage.setItem(MODE_KEY, mode); } catch (e) {} }
    render();
  }
  /* ---------------- Otočenie stránky ---------------- */

  function getRotation() {
    var q = /[?&]otocit=(0|90|270)/.exec(location.search);
    if (q) return +q[1];
    try { var r = +localStorage.getItem(ROT_KEY); if (r === 90 || r === 270) return r; } catch (e) {}
    return 0;
  }
  function applyLayout() {
    var cls = '';
    if (rotation) cls = 'rot' + rotation;
    else if (window.innerHeight > window.innerWidth) cls = 'port';
    document.documentElement.className = cls;
    $('rotate').title = 'Otočiť stránku (teraz ' + rotation + '°)';
  }
  function cycleRotation() {
    rotation = rotation === 0 ? 90 : (rotation === 90 ? 270 : 0);
    try { localStorage.setItem(ROT_KEY, '' + rotation); } catch (e) {}
    applyLayout();
    render();
  }

  function isEink() { return document.body.className === 'eink'; }

  /* ---------------- Celá obrazovka a zapnutá obrazovka ---------------- */

  function fsElement() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
  function toggleFullscreen() {
    var de = document.documentElement;
    if (fsElement()) {
      (document.exitFullscreen || document.webkitExitFullscreen || function () {}).call(document);
    } else {
      var req = de.requestFullscreen || de.webkitRequestFullscreen || de.webkitRequestFullScreen;
      if (req) req.call(de);
    }
    requestWakeLock();
  }
  var wakeLock = null;
  function requestWakeLock() {
    try {
      if (navigator.wakeLock && !wakeLock) {
        navigator.wakeLock.request('screen').then(function (l) {
          wakeLock = l;
          l.addEventListener('release', function () { wakeLock = null; });
        }, function () {});
      }
    } catch (e) {}
  }

  /* ---------------- Interval obnovy ---------------- */

  // 6:00–9:00 každých 5 min, 9:00–20:00 každých 10 min, 20:00–6:00 každých 30 min
  function intervalFor(d) {
    var h = d.getHours();
    if (h >= 6 && h < 9) return 5;
    if (h >= 9 && h < 20) return 10;
    return 30;
  }
  function nextRefresh(now) {
    var next = new Date(now.getTime() + intervalFor(now) * 60000);
    // nepreskočiť začiatok rýchlejšieho obdobia (napr. 5:50 → obnova o 6:00, nie 6:20)
    var bounds = [6, 9, 20];
    for (var i = 0; i < 2; i++) {
      for (var j = 0; j < bounds.length; j++) {
        var b = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, bounds[j], 0, 30);
        if (b > now && b < next) next = b;
      }
    }
    return next;
  }
  function schedule(at) {
    if (refreshTimer) clearTimeout(refreshTimer);
    state.nextAt = at;
    refreshTimer = setTimeout(load, Math.max(1000, at.getTime() - Date.now()));
    renderStatus();
  }

  /* ---------------- Načítanie dát ---------------- */

  function getJSON(url, cb) {
    var x = new XMLHttpRequest();
    var done = false;
    function finish(err, data) { if (!done) { done = true; cb(err, data); } }
    x.open('GET', url, true);
    x.timeout = 20000;
    x.onreadystatechange = function () {
      if (x.readyState !== 4) return;
      if (x.status >= 200 && x.status < 300) {
        try { finish(null, JSON.parse(x.responseText)); } catch (e) { finish(e); }
      } else finish(new Error('HTTP ' + x.status));
    };
    x.ontimeout = function () { finish(new Error('timeout')); };
    x.onerror = function () { finish(new Error('network')); };
    x.send();
  }

  function load() {
    var pending = 2, fErr = null;
    var f = null, a = null;
    setText('status', 'Načítavam údaje…');
    getJSON(FORECAST_URL, function (err, data) { fErr = err; f = data; if (--pending === 0) loaded(); });
    getJSON(AIR_URL, function (err, data) { a = err ? null : data; if (--pending === 0) loaded(); });

    function loaded() {
      var now = new Date();
      if (fErr || !f || !f.current) {
        state.error = 'Nepodarilo sa načítať údaje';
        schedule(new Date(now.getTime() + RETRY_MIN * 60000));
        render();
        return;
      }
      state.error = null;
      state.forecast = f;
      if (a && a.current) state.air = a;
      state.fetchedAt = now;
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ f: f, a: state.air, t: now.getTime() }));
      } catch (e) {}
      schedule(nextRefresh(now));
      render();
    }
  }

  function loadCache() {
    try {
      var c = JSON.parse(localStorage.getItem(CACHE_KEY));
      if (c && c.f) { state.forecast = c.f; state.air = c.a; state.fetchedAt = new Date(c.t); }
    } catch (e) {}
  }

  /* ---------------- Ikony (SVG, farba podľa textu) ---------------- */

  var SUN = '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/>';
  var MOON = '<path d="M19.5 14.6A7.8 7.8 0 1 1 9.4 4.5a6.2 6.2 0 0 0 10.1 10.1z"/>';
  var CLOUD = '<path d="M7 19h10.2a4.1 4.1 0 0 0 .6-8.15A6 6 0 0 0 6.4 11.2 3.9 3.9 0 0 0 7 19z"/>';
  var CLOUD_UP = '<path d="M7 15h10.2a4.1 4.1 0 0 0 .6-8.15A6 6 0 0 0 6.4 7.2 3.9 3.9 0 0 0 7 15z"/>';

  function iconKind(code) {
    if (code === 0) return 'clear';
    if (code === 1 || code === 2) return 'partly';
    if (code === 3) return 'cloud';
    if (code === 45 || code === 48) return 'fog';
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
    if (code >= 95) return 'storm';
    if (code >= 51) return 'rain';
    return 'cloud';
  }
  function iconSVG(code, isDay) {
    var k = iconKind(code), body;
    var small = isDay ? SUN : MOON;
    switch (k) {
      case 'clear': body = small; break;
      case 'partly':
        body = '<g transform="translate(-1.5 -1.5) scale(.72)">' + small + '</g>' +
          '<g transform="translate(3 3) scale(.85)">' + CLOUD + '</g>'; break;
      case 'fog': body = CLOUD_UP + '<path d="M4 18.5h16M6 21.5h12"/>'; break;
      case 'rain': body = CLOUD_UP + '<path d="M8 18l-1 3M12 18l-1 3M16 18l-1 3"/>'; break;
      case 'snow': body = CLOUD_UP + '<path d="M8 18.5v.1M12 20.5v.1M16 18.5v.1M10 22v.1M14 22v.1"/>'; break;
      case 'storm': body = CLOUD_UP + '<path d="M12.5 15.5l-2.5 4h3.5l-2 3.5"/>'; break;
      default: body = CLOUD;
    }
    return '<svg viewBox="-1 -1 26 26" overflow="visible" style="overflow:visible" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + body + '</svg>';
  }
  function weatherText(c) {
    var t = {
      0: 'Jasno', 1: 'Prevažne jasno', 2: 'Polooblačno', 3: 'Zamračené',
      45: 'Hmla', 48: 'Hmla s námrazou',
      51: 'Slabé mrholenie', 53: 'Mrholenie', 55: 'Silné mrholenie',
      56: 'Mrznúce mrholenie', 57: 'Mrznúce mrholenie',
      61: 'Slabý dážď', 63: 'Dážď', 65: 'Silný dážď', 66: 'Mrznúci dážď', 67: 'Mrznúci dážď',
      71: 'Slabé sneženie', 73: 'Sneženie', 75: 'Silné sneženie', 77: 'Snehové zrná',
      80: 'Slabé prehánky', 81: 'Prehánky', 82: 'Silné prehánky',
      85: 'Snehové prehánky', 86: 'Silné snehové prehánky',
      95: 'Búrka', 96: 'Búrka s krupobitím', 99: 'Silná búrka s krupobitím'
    };
    return t[c] || '—';
  }
  function aqiText(v) {
    if (v === null || v === undefined) return '';
    if (v <= 20) return 'Dobrá';
    if (v <= 40) return 'Prijateľná';
    if (v <= 60) return 'Stredná';
    if (v <= 80) return 'Zlá';
    if (v <= 100) return 'Veľmi zlá';
    return 'Extrémne zlá';
  }

  /* ---------------- Graf (vlastné SVG, bez knižníc) ---------------- */

  function niceStep(range, target) {
    var raw = range / target, steps = [0.5, 1, 2, 5, 10, 20];
    for (var i = 0; i < steps.length; i++) if (steps[i] >= raw) return steps[i];
    return 50;
  }

  function drawChart(el, times, values, opt) {
    var now = new Date();
    var t0 = now.getTime() - 24 * 3600000, t1 = now.getTime() + 24 * 3600000;
    var pts = [];
    for (var i = 0; i < times.length; i++) {
      var t = times[i].getTime();
      if (t >= t0 - 3600000 && t <= t1 + 3600000 && values[i] !== null) pts.push({ t: t, v: values[i] });
    }
    if (pts.length < 2) { el.innerHTML = ''; return; }

    var eink = isEink();
    var W = el.clientWidth || 600, H = el.clientHeight || 190;
    var fs = parseFloat(window.getComputedStyle ? getComputedStyle(document.body).fontSize : 16) || 16;
    fs = Math.max(11, Math.round(fs * 0.75));
    var L = Math.round(fs * 3.4), R = 12, T = Math.round(fs * 1.5), B = Math.round(fs * 2);
    var lo = Infinity, hi = -Infinity;
    for (i = 0; i < pts.length; i++) { if (pts[i].v < lo) lo = pts[i].v; if (pts[i].v > hi) hi = pts[i].v; }
    var step = niceStep(Math.max(hi - lo, opt.minRange), 3);
    var ylo = Math.floor(lo / step) * step, yhi = Math.ceil(hi / step) * step;
    if (yhi === ylo) yhi = ylo + step;

    function X(t) { return L + (t - t0) / (t1 - t0) * (W - L - R); }
    function Y(v) { return T + (yhi - v) / (yhi - ylo) * (H - T - B); }

    var ink = eink ? '#000' : '#e8edf2';
    var mute = eink ? '#000' : '#93a1b0';
    var grid = eink ? '#999' : 'rgba(147,161,176,0.22)';
    var line = eink ? '#000' : opt.color;
    var s = '<svg width="' + W + '" height="' + H + '" xmlns="http://www.w3.org/2000/svg" font-family="inherit">';
    s += '<defs><clipPath id="clip-' + el.id + '"><rect x="' + L + '" y="0" width="' + (W - L - R) + '" height="' + H + '"/></clipPath></defs>';

    // vodorovná mriežka a popisy osi Y
    for (var v = ylo; v <= yhi + 1e-9; v += step) {
      var y = Y(v).toFixed(1);
      s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y + '" y2="' + y + '" stroke="' + grid + '" stroke-width="1"' + (eink ? ' stroke-dasharray="2 4"' : '') + '/>';
      s += '<text x="' + (L - 6) + '" y="' + (+y + fs / 3) + '" text-anchor="end" font-size="' + fs + '" fill="' + mute + '">' + fmt(v, step < 1 ? 1 : 0) + '</text>';
    }
    // os X: každých 6 hodín
    var d = new Date(t0); d.setMinutes(0, 0, 0);
    while (d.getHours() % 6 !== 0) d.setHours(d.getHours() + 1);
    for (; d.getTime() <= t1; d.setHours(d.getHours() + 6)) {
      var x = X(d.getTime()).toFixed(1);
      var lbl = d.getHours() === 0 ? DAYS_SHORT[d.getDay()] : d.getHours() + ':00';
      s += '<line x1="' + x + '" x2="' + x + '" y1="' + T + '" y2="' + (H - B) + '" stroke="' + grid + '" stroke-width="1"/>';
      s += '<text x="' + x + '" y="' + (H - fs / 2) + '" text-anchor="middle" font-size="' + fs + '" fill="' + mute + '"' + (d.getHours() === 0 ? ' font-weight="bold"' : '') + '>' + lbl + '</text>';
    }

    // čiara: minulosť plná, predpoveď prerušovaná
    var nowT = now.getTime(), past = '', fut = '', curV = null;
    for (i = 0; i < pts.length; i++) {
      var p = pts[i], P = X(p.t).toFixed(1) + ',' + Y(p.v).toFixed(1);
      if (p.t <= nowT) past += (past ? 'L' : 'M') + P;
      if (p.t >= nowT || (i + 1 < pts.length && pts[i + 1].t > nowT)) fut += (fut ? 'L' : 'M') + P;
    }
    // hodnota v aktuálnom čase (lineárna interpolácia)
    for (i = 0; i + 1 < pts.length; i++) {
      if (pts[i].t <= nowT && pts[i + 1].t >= nowT) {
        var f = (nowT - pts[i].t) / (pts[i + 1].t - pts[i].t);
        curV = pts[i].v + f * (pts[i + 1].v - pts[i].v);
      }
    }
    if (opt.current !== null && opt.current !== undefined) curV = opt.current;

    s += '<g clip-path="url(#clip-' + el.id + ')">';
    if (opt.zero && ylo < 0 && yhi > 0) {
      s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(0).toFixed(1) + '" y2="' + Y(0).toFixed(1) + '" stroke="' + mute + '" stroke-width="1"/>';
    }
    s += '<path d="' + past + '" fill="none" stroke="' + line + '" stroke-width="' + (eink ? 3 : 2.5) + '" stroke-linejoin="round" stroke-linecap="round"/>';
    s += '<path d="' + fut + '" fill="none" stroke="' + line + '" stroke-width="' + (eink ? 2 : 2) + '" stroke-dasharray="5 5" stroke-linejoin="round" opacity="' + (eink ? 1 : 0.75) + '"/>';
    s += '</g>';

    // čiara "teraz"
    var nx = X(nowT).toFixed(1);
    s += '<line x1="' + nx + '" x2="' + nx + '" y1="' + (T - 4) + '" y2="' + (H - B) + '" stroke="' + ink + '" stroke-width="1" stroke-dasharray="2 3"/>';

    // min a max za zobrazené obdobie
    var minP = pts[0], maxP = pts[0];
    for (i = 1; i < pts.length; i++) {
      if (pts[i].t < t0 || pts[i].t > t1) continue;
      if (pts[i].v < minP.v || minP.t < t0) minP = pts[i];
      if (pts[i].v > maxP.v || maxP.t < t0) maxP = pts[i];
    }
    function mark(p, above) {
      var x = X(p.t), y = Y(p.v);
      var anchor = x < L + 30 ? 'start' : (x > W - R - 30 ? 'end' : 'middle');
      return '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="3" fill="' + line + '"/>' +
        '<text x="' + x.toFixed(1) + '" y="' + (above ? y - fs * 0.6 : y + fs * 1.35).toFixed(1) + '" text-anchor="' + anchor + '" font-size="' + fs + '" fill="' + ink + '">' + fmt(p.v, opt.dec) + '</text>';
    }
    if (Math.abs(X(maxP.t) - X(nowT)) > 34) s += mark(maxP, true);
    if (Math.abs(X(minP.t) - X(nowT)) > 34) s += mark(minP, false);
    if (curV !== null) {
      var cy = Y(curV);
      s += '<circle cx="' + nx + '" cy="' + cy.toFixed(1) + '" r="5" fill="' + (eink ? '#fff' : '#1b232c') + '" stroke="' + line + '" stroke-width="2.5"/>';
      s += '<text x="' + (+nx + 8) + '" y="' + (cy < T + fs ? cy + fs * 1.4 : cy - fs * 0.7).toFixed(1) + '" font-size="' + Math.round(fs * 1.15) + '" font-weight="bold" fill="' + ink + '">' + fmt(curV, opt.dec) + '</text>';
    }
    s += '<g id="hover-' + el.id + '"></g></svg>';
    el.innerHTML = s;

    // dotyk / myš: ukáž hodnotu v danom čase (len tablet)
    el.onmousemove = el.ontouchstart = el.ontouchmove = function (ev) {
      if (isEink()) return;
      var touch = ev.touches && ev.touches[0];
      var rect = el.getBoundingClientRect();
      var mx = (touch ? touch.clientX : ev.clientX) - rect.left;
      var tt = t0 + (mx - L) / (W - L - R) * (t1 - t0), best = null;
      for (var k = 0; k < pts.length; k++) if (!best || Math.abs(pts[k].t - tt) < Math.abs(best.t - tt)) best = pts[k];
      if (!best || best.t < t0 || best.t > t1) return;
      var bx = X(best.t), by = Y(best.v), bd = new Date(best.t);
      var label = DAYS_SHORT[bd.getDay()] + ' ' + bd.getHours() + ':00  ' + fmt(best.v, opt.dec) + ' ' + opt.unit;
      var tw = fs * 12, tx = Math.min(Math.max(bx, L + tw / 2), W - R - tw / 2);
      var g = document.getElementById('hover-' + el.id);
      if (g) g.innerHTML =
        '<line x1="' + bx + '" x2="' + bx + '" y1="' + T + '" y2="' + (H - B) + '" stroke="' + ink + '" stroke-width="1"/>' +
        '<circle cx="' + bx + '" cy="' + by + '" r="4.5" fill="' + line + '" stroke="#1b232c" stroke-width="2"/>' +
        '<rect x="' + (tx - tw / 2) + '" y="0" width="' + tw + '" height="' + (fs * 1.4) + '" rx="4" fill="#26313d"/>' +
        '<text x="' + tx + '" y="' + (fs * 1.05) + '" text-anchor="middle" font-size="' + fs + '" fill="#e8edf2">' + label + '</text>';
    };
    el.onmouseleave = el.ontouchend = function () {
      var g = document.getElementById('hover-' + el.id);
      if (g) setTimeout(function () { g.innerHTML = ''; }, el.ontouchend ? 1500 : 0);
    };
  }

  /* ---------------- Vykreslenie ---------------- */

  function renderClock() {
    var d = new Date();
    setText('clock', hhmm(d));
    setText('date', DAYS_LONG[d.getDay()] + ', ' + d.getDate() + '. ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear());
  }

  function renderStatus() {
    var el = $('status'); if (!el) return;
    var parts = [];
    if (state.error) parts.push(state.error);
    if (state.fetchedAt) parts.push('Aktualizované ' + hhmm(state.fetchedAt));
    if (state.nextAt) parts.push('ďalšia obnova ' + hhmm(state.nextAt));
    el.textContent = parts.join(' · ') || 'Načítavam údaje…';
    el.className = state.error ? 'err' : '';
  }

  function drawCharts() {
    var f = state.forecast; if (!f) return;
    var h = f.hourly, c = f.current, times = [];
    for (var i = 0; i < h.time.length; i++) times.push(parseLocal(h.time[i]));
    drawChart($('chart-temp'), times, h.temperature_2m,
      { color: '#f2994a', dec: 1, unit: '°C', minRange: 4, zero: true, current: c.temperature_2m });
    drawChart($('chart-pressure'), times, h.pressure_msl,
      { color: '#5aa9e6', dec: 0, unit: 'hPa', minRange: 6, current: c.pressure_msl });

  }

  function render() {
    renderClock();
    renderStatus();
    var f = state.forecast;
    if (!f) return;
    var c = f.current, h = f.hourly, dl = f.daily;
    var now = new Date();

    // aktuálne
    $('hero-icon').innerHTML = iconSVG(c.weather_code, c.is_day);
    setText('temp', fmt(c.temperature_2m, 1));
    setText('desc', weatherText(c.weather_code));

    var todayKey = dateKey(now), ti = 0;
    for (var i = 0; i < dl.time.length; i++) if (dl.time[i] === todayKey) ti = i;
    setText('feels', 'Pocitovo ' + fmt(c.apparent_temperature, 0) + ' °C · dnes ' +
      fmt(dl.temperature_2m_min[ti], 0) + ' až ' + fmt(dl.temperature_2m_max[ti], 0) + ' °C');

    // hodinové časy
    var times = [];
    for (i = 0; i < h.time.length; i++) times.push(parseLocal(h.time[i]));
    var hi = 0;
    for (i = 0; i < times.length; i++) if (times[i] <= now) hi = i;

    // tlak a trend za 3 h (meteorologická tendencia)
    setText('pressure', fmt(c.pressure_msl, 0));
    var p3 = hi >= 3 ? h.pressure_msl[hi - 3] : null;
    var p24 = hi >= 24 ? h.pressure_msl[hi - 24] : null;
    var d3 = p3 !== null ? c.pressure_msl - p3 : null;
    var arrow = '', word = '';
    if (d3 !== null) {
      if (d3 >= 1) { arrow = '▲'; word = 'stúpa'; }
      else if (d3 <= -1) { arrow = '▼'; word = 'klesá'; }
      else { arrow = '▶'; word = 'stály'; }
    }
    setText('p-arrow', arrow);
    setText('p-trend', d3 === null ? '' :
      word + ' · 3 h: ' + (d3 > 0 ? '+' : '') + fmt(d3, 1) +
      (p24 !== null ? ' · 24 h: ' + (c.pressure_msl - p24 > 0 ? '+' : '') + fmt(c.pressure_msl - p24, 1) : ''));

    setText('humidity', fmt(c.relative_humidity_2m, 0));
    setText('dew', h.dew_point_2m ? 'Rosný bod ' + fmt(h.dew_point_2m[hi], 0) + ' °C' : '');

    setText('wind', fmt(c.wind_speed_10m, 0));
    var dir = c.wind_direction_10m;
    var dirName = DIRS[Math.round(dir / 45) % 8];
    var wa = $('wind-arrow');
    wa.textContent = '↓';
    var rot = 'rotate(' + Math.round(dir) + 'deg)';
    wa.style.webkitTransform = rot; wa.style.transform = rot;
    wa.title = 'Vietor od ' + dirName;
    setText('wind-sub', 'od ' + dirName + ' · nárazy ' + fmt(c.wind_gusts_10m, 0) + ' km/h');

    setText('rain', fmt(dl.precipitation_sum[ti], 1));
    setText('rain-sub', (c.precipitation > 0 ? 'teraz ' + fmt(c.precipitation, 1) + ' mm · ' : '') +
      'pravdepodobnosť ' + fmt(dl.precipitation_probability_max[ti], 0) + ' %');

    var sr = parseLocal(dl.sunrise[ti]), ss = parseLocal(dl.sunset[ti]);
    setText('sunrise', hhmm(sr));
    setText('sunset', hhmm(ss));
    var len = Math.round((ss - sr) / 60000);
    setText('daylen', 'Deň ' + Math.floor(len / 60) + ' h ' + pad(len % 60) + ' min');

    var a = state.air && state.air.current;
    if (a) {
      setText('aqi', aqiText(a.european_aqi));
      setText('aqi-sub', 'Index ' + fmt(a.european_aqi, 0) + ' · PM2,5 ' + fmt(a.pm2_5, 0) + ' · PM10 ' + fmt(a.pm10, 0));
    } else { setText('aqi', '--'); setText('aqi-sub', 'nedostupné'); }

    // predpoveď na dni
    var html = '';
    for (i = ti; i < dl.time.length && i < ti + 7; i++) {
      var dd = parseLocal(dl.time[i]);
      var name = i === ti ? 'Dnes' : (i === ti + 1 ? 'Zajtra' : DAYS_SHORT[dd.getDay()] + ' ' + dd.getDate() + '.');
      var pr = dl.precipitation_sum[i];
      html += '<div class="day"><div class="day-name">' + name + '</div>' +
        '<div class="ic" title="' + weatherText(dl.weather_code[i]) + '">' + iconSVG(dl.weather_code[i], 1) + '</div>' +
        '<div><span class="day-max">' + fmt(dl.temperature_2m_max[i], 0) + '°</span> <span class="day-min">' + fmt(dl.temperature_2m_min[i], 0) + '°</span></div>' +
        '<div class="day-rain">' + (pr >= 0.1 ? fmt(pr, 1) + ' mm' : '') + '</div>' +
        windLine(dl.wind_speed_10m_max && dl.wind_speed_10m_max[i], dl.wind_gusts_10m_max && dl.wind_gusts_10m_max[i]) +
        '</div>';
    }
    $('days').innerHTML = html;
    // grafy až po vykreslení zvyšku stránky, aby mali správnu výšku
    drawCharts();
    setTimeout(drawCharts, 300);
  }

  // vietor v predpovedi: max. rýchlosť a nárazy; silné nárazy (od 50 km/h) zvýraznené
  function windLine(speed, gust) {
    if (speed === null || speed === undefined) return '';
    var strong = gust !== null && gust !== undefined && gust >= 50;
    return '<div class="day-wind' + (strong ? ' strong' : '') + '">vietor ' + fmt(speed, 0) +
      (gust !== null && gust !== undefined ? '<br>nárazy ' + fmt(gust, 0) : '') + ' <small>km/h</small></div>';
  }

  /* ---------------- Štart ---------------- */

  function init() {
    $('mode-tablet').onclick = function () { setMode('tablet', true); };
    $('mode-eink').onclick = function () { setMode('eink', true); };
    var de = document.documentElement;
    if (de.requestFullscreen || de.webkitRequestFullscreen || de.webkitRequestFullScreen) {
      $('fullscreen').onclick = toggleFullscreen;
    } else {
      $('fullscreen').style.display = 'none';
    }
    $('refresh').onclick = function () { load(); };
    $('rotate').onclick = cycleRotation;
    rotation = getRotation();
    applyLayout();

    loadCache();
    setMode(getMode(), false);
    load();
    requestWakeLock();

    // hodiny: prekresliť na začiatku každej minúty
    (function tick() {
      renderClock();
      setTimeout(tick, 60000 - (Date.now() % 60000) + 50);
    })();

    // po prebudení zariadenia: ak je čas na obnovu, obnov hneď
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      requestWakeLock();
      if (state.nextAt && Date.now() >= state.nextAt.getTime()) load();
    });

    var rt = null;
    window.addEventListener('resize', function () {
      clearTimeout(rt); rt = setTimeout(function () { applyLayout(); render(); }, 250);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
