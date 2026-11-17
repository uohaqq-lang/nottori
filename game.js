'use strict';
/* 進行役：scenes.js の場面データを上から順に動かす。
   外へは何も送らない。位置・カメラ・端末の情報は、このページを開いている間だけメモリに置く。
   localStorage に入れるのは「どこまで進んだか」（場面の名前とモード）だけ。 */

/* ---------- 早送り（確かめ用）：?fast=20 で20倍、?pick=0,1,... で選択を自動 ---------- */
const QS = new URLSearchParams(location.search);
const SPEED = Math.max(1, Number(QS.get('fast')) || 1);
const PICKS = (QS.get('pick') || '').split(',').filter(s => s !== '').map(Number);
const AUTO = PICKS.length > 0 || QS.has('auto');
let FROZEN = false;   /* 確かめ用：?hold=場面名&holdAfter=秒 で、その時点で止める */
const PACE = 2.0;   /* 会話の間の倍率 */
const sleep = s => FROZEN ? new Promise(() => {}) : new Promise(r => setTimeout(() => { if (!FROZEN) r(); }, Math.max(0, s) * 1000 / SPEED));
function tlog(...a) { const el = document.getElementById('testlog'); if (el) el.textContent += a.join(' ') + '\n'; console.log('[game]', ...a); }
window.addEventListener('error', e => tlog('ERROR', e.message, e.lineno));
window.addEventListener('unhandledrejection', e => tlog('ERROR', String(e.reason)));

const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- 状態 ---------- */
const st = {
  mode: 'normal', name: '', answeredS1: false, leakFixed: false, path2: false, path3: false, opened: false,
  locAllowed: false, lat: null, lon: null, station: null, faceTaken: false, notifAllowed: false,
  route: null, sentCount: 0, picoLocked: false, momSaved: false, momPaid: false,
  notified: new Set(), paid: new Set(), mailPw: false, applied: false, scene: 'S0'
};
let faceCanvas = null;          /* 撮った写真（メモリだけ） */
let audio = null;

/* ---------- 端末・時刻 ---------- */
function deviceKind() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) return 'Android';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  return 'パソコン';
}
const isAndroid = /Android/.test(navigator.userAgent);
const pad = n => String(n).padStart(2, '0');
const hm = d => `${d.getHours()}:${pad(d.getMinutes())}`;
function timeWord() {
  const h = new Date().getHours();
  if (h >= 5 && h < 10) return T.timeWord.morning;
  if (h >= 10 && h < 17) return T.timeWord.day;
  return T.timeWord.night;
}
function myName() { return st.name || UI.namePh; }
function fill(s) {
  const d = new Date();
  let out = String(s);
  const w = timeWord();
  if (!w) out = out.replace('、{時刻の一言}', '').replace('{時刻の一言}', '');
  return out
    .replace(/\{名前\}/g, myName())
    .replace(/\{遠い都道府県\}/g, farPrefecture(st.lat, st.lon))
    .replace(/\{駅名\}/g, st.station || '')
    .replace(/\{スマホの種類\}/g, deviceKind())
    .replace(/\{時刻\}/g, `${d.getHours()}時${d.getMinutes()}分`)
    .replace(/\{時刻の一言\}/g, w);
}

/* ---------- 音（その場で作る。本物のアプリの音は使わない） ---------- */
function audioInit() {
  try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { audio = null; }
}
function tone(freq, t0, dur, vol = 0.12, type = 'sine') {
  if (!audio) return;
  const o = audio.createOscillator(), g = audio.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, audio.currentTime + t0);
  g.gain.exponentialRampToValueAtTime(vol, audio.currentTime + t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + t0 + dur);
  o.connect(g); g.connect(audio.destination); o.start(audio.currentTime + t0); o.stop(audio.currentTime + t0 + dur + 0.02);
}
function haptic() { try { const l = document.getElementById('hapt'); if (l) l.click(); } catch (e) {} }
const sound = {
  /* アプリごとに違う、短い通知音（本物のアプリの音は使わない） */
  notify(app) {
    if (app === 'kotori') { tone(880, 0, 0.07, 0.13); tone(1175, 0.08, 0.12, 0.13); }
    else if (app === 'pico') { tone(1568, 0, 0.25, 0.08); tone(2093, 0.06, 0.35, 0.05); }
    else if (app === 'sms') { tone(1319, 0, 0.09); tone(1568, 0.11, 0.09); tone(2093, 0.22, 0.14); }
    else if (app === 'mail') { tone(660, 0, 0.18, 0.07); tone(990, 0.12, 0.2, 0.06); }
    else { tone(988, 0, 0.12); tone(1319, 0.09, 0.18); }
    if (isAndroid && navigator.vibrate) navigator.vibrate(app === 'kotori' ? [40, 60, 40] : 70);
    else haptic();   /* iPhone（iOS 18以降のSafari）は、スイッチの小さな振動を借りる */
  },
  ringOnce() { for (let i = 0; i < 8; i++) { tone(1046, i * 0.1, 0.08, 0.1, 'triangle'); tone(1318, i * 0.1 + 0.05, 0.05, 0.08, 'triangle'); } if (isAndroid && navigator.vibrate) navigator.vibrate([400, 200, 400]); },
  dialOnce() { tone(400, 0, 1.0, 0.07); },
  tap() { tone(1500, 0, 0.03, 0.03); }
};

/* ---------- データ：会話・メール ---------- */
const COLORS = { mom: '#c08a5b', misaki: '#9b6fa6', yuto: '#5b84b5', riko: '#c26b7e', kai: '#5f9a7a', stranger: '#7c7c7c', pico: '#b5654f', picosms: '#678c6b' };
const PEOPLE = { mom: '母', misaki: 'ミサキ', yuto: 'ユウト', riko: 'リコ', kai: 'カイ', stranger: UI.stranger, picosms: 'インスタカム' };
FRIENDS.forEach((n, i) => { const k = 'f' + i; PEOPLE[k] = n; if (!COLORS[k]) COLORS[k] = ['#5b84b5', '#c26b7e', '#5f9a7a', '#a08251', '#6b74b5', '#b56b9c', '#6f8f4f', '#a3655b'][i]; });
const threads = { pico: {}, kotori: {}, sms: {} };
function thread(app, th) {
  if (!threads[app][th]) threads[app][th] = { th, name: PEOPLE[th] || th, msgs: [], unread: 0, t: Date.now() };
  return threads[app][th];
}
const mails = [
  { id: 'm1', from: '大学 学務', subject: '履修登録の確認期間について', body: '履修登録の確認期間は今週末までです。', unread: false, t: '昨日' },
  { id: 'm2', from: '通販', subject: 'ご注文の商品を発送しました', body: 'ご注文ありがとうございます。商品を発送しました。', unread: false, t: '月曜' },
  { id: 'leak', from: T.leakMail.from, subject: T.leakMail.subject, body: T.leakMail.body, unread: true, t: '10/28', leak: true }
];
const calls = [];

/* ---------- 画面の状態 ---------- */
let view = { name: 's0' };
let choice = null;            /* いまの選択 { app, th, options, resolve } */
let tray = null;              /* S8 の行動の板 */
let busy = null;              /* 行動中 { label, start, dur } */
let raceBanner = null;
let raceAction = null;   /* 通知を消しても、設定から押せるように */

/* ---------- 小さな絵（写真の代わり） ---------- */
const SVG = {
  desk: `<svg viewBox="0 0 400 300" class="ph"><rect width="400" height="300" fill="#e9e3d8"/><rect x="70" y="70" width="260" height="150" rx="8" fill="#3b4250"/><rect x="82" y="82" width="236" height="126" fill="#dfe6ef"/><rect x="95" y="100" width="150" height="8" fill="#9aa8bb"/><rect x="95" y="118" width="190" height="8" fill="#9aa8bb"/><rect x="95" y="136" width="120" height="8" fill="#9aa8bb"/><rect x="40" y="220" width="320" height="18" rx="4" fill="#59606d"/><circle cx="340" cy="95" r="20" fill="#c9a26b"/></svg>`,
  shop: `<svg viewBox="0 0 400 300" class="ph"><rect width="400" height="300" fill="#cfe0ee"/><rect x="0" y="230" width="400" height="70" fill="#b9b3a8"/><rect x="60" y="90" width="230" height="150" fill="#f3efe6"/><rect x="60" y="70" width="230" height="34" fill="#2f5f8f"/><text x="175" y="94" font-size="19" fill="#fff" text-anchor="middle" font-weight="700">フジミヤクリーニング</text><rect x="90" y="130" width="70" height="110" fill="#9bb7cf"/><rect x="190" y="130" width="70" height="60" fill="#9bb7cf"/><rect x="315" y="150" width="62" height="26" fill="#264c7a"/><text x="346" y="168" font-size="13" fill="#fff" text-anchor="middle">北原駅</text><rect x="343" y="176" width="5" height="60" fill="#666"/><circle cx="125" cy="200" r="14" fill="#7a5a48"/><rect x="113" y="212" width="24" height="30" fill="#7a5a48"/></svg>`,
  nabe: `<svg viewBox="0 0 400 300" class="ph"><rect width="400" height="300" fill="#efe2cf"/><ellipse cx="200" cy="190" rx="130" ry="60" fill="#444"/><ellipse cx="200" cy="175" rx="120" ry="48" fill="#d9a066"/><circle cx="160" cy="170" r="16" fill="#f2efe8"/><circle cx="220" cy="160" r="14" fill="#7aa35a"/><circle cx="245" cy="185" r="12" fill="#e7d27a"/><circle cx="70" cy="70" r="26" fill="#5b84b5"/><circle cx="330" cy="70" r="26" fill="#c26b7e"/><circle cx="200" cy="55" r="26" fill="#c9a38f"/></svg>`,
  yutoShot: `<svg viewBox="0 0 220 120" width="200"><rect width="220" height="120" rx="10" fill="#f7f6f3" stroke="#ddd"/><circle cx="22" cy="28" r="12" fill="#c9a38f"/><text x="40" y="32" font-size="11" fill="#333">ソウタ</text><rect x="14" y="48" width="192" height="52" rx="12" fill="#fff" stroke="#e5e2dc"/><text x="24" y="70" font-size="10" fill="#333">ごめん急ぎで、コンビニでギフト</text><text x="24" y="86" font-size="10" fill="#333">カード買って番号送ってくれない？</text></svg>`,
  idcard: `<svg viewBox="0 0 180 112" class="idcard"><rect width="180" height="112" rx="8" fill="#eef2f6" stroke="#b9c3cf"/><rect x="12" y="22" width="52" height="66" fill="#c9a38f"/><rect x="76" y="26" width="86" height="8" fill="#9aa8bb"/><rect x="76" y="44" width="70" height="8" fill="#9aa8bb"/><rect x="76" y="62" width="80" height="8" fill="#9aa8bb"/><text x="12" y="15" font-size="9" fill="#6b7682">学生証（ゲームの中の絵）</text></svg>`,
  cand: c => `<svg viewBox="0 0 160 160"><rect width="160" height="160" fill="${c}"/><circle cx="80" cy="64" r="30" fill="#fff" opacity=".85"/><rect x="38" y="104" width="84" height="56" rx="30" fill="#fff" opacity=".85"/></svg>`,
  faceDummy: `<svg viewBox="0 0 100 100"><rect width="100" height="100" fill="#f3e4ea"/><circle cx="50" cy="42" r="18" fill="#d9b8c4"/><rect x="24" y="64" width="52" height="36" rx="18" fill="#d9b8c4"/></svg>`
};
const appColor = { pico: 'var(--pico)', kotori: 'var(--kotori)', sms: 'var(--sms)', mail: 'var(--mail)', phone: 'var(--phone)' };

/* アプリのアイコン（実在のアプリのロゴは写さない。種類が分かる色と形だけ寄せる） */
const ICON = {
  pico: '<svg viewBox="0 0 60 60"><defs><linearGradient id="gp" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#f6b64f"/><stop offset=".5" stop-color="#e2546f"/><stop offset="1" stop-color="#7a4fc4"/></linearGradient></defs><rect width="60" height="60" rx="14" fill="url(#gp)"/><text x="30" y="41" text-anchor="middle" font-size="25" font-weight="700" font-style="italic" fill="#fff" font-family="Georgia,serif">Ic</text></svg>',
  kotori: '<svg viewBox="0 0 60 60"><rect width="60" height="60" rx="14" fill="#3fbf6a"/><path d="M30 15c-9.9 0-18 6.3-18 14.1 0 4.7 2.9 8.9 7.4 11.4-.3 2-1.2 4.2-2.6 5.6 3.6-.4 6.7-1.9 8.6-3.4 1.5.3 3 .5 4.6.5 9.9 0 18-6.3 18-14.1S39.9 15 30 15z" fill="#fff"/><circle cx="24" cy="28" r="2.2" fill="#3fbf6a"/><path d="M33 27l6-2-4 5z" fill="#3fbf6a"/></svg>',
  sms: '<svg viewBox="0 0 60 60"><rect width="60" height="60" rx="14" fill="#4fb45a"/><ellipse cx="30" cy="28" rx="17" ry="13" fill="#fff"/><path d="M18 36l-3 8 9-5z" fill="#fff"/></svg>',
  mail: '<svg viewBox="0 0 60 60"><rect width="60" height="60" rx="14" fill="#3b8be0"/><rect x="13" y="19" width="34" height="23" rx="3" fill="#fff"/><path d="M14 21l16 12 16-12" fill="none" stroke="#3b8be0" stroke-width="2.6"/></svg>',
  cam: '<svg viewBox="0 0 60 60"><rect width="60" height="60" rx="14" fill="#5b5f66"/><rect x="13" y="20" width="34" height="24" rx="5" fill="#e9e9ea"/><circle cx="30" cy="32" r="7" fill="#5b5f66"/></svg>',
  photo: '<svg viewBox="0 0 60 60"><rect width="60" height="60" rx="14" fill="#fff"/><circle cx="30" cy="21" r="8" fill="#f2b544"/><circle cx="39" cy="30" r="8" fill="#e65f5f"/><circle cx="30" cy="39" r="8" fill="#5a8ee6"/><circle cx="21" cy="30" r="8" fill="#5fc07a"/></svg>',
  clock: '<svg viewBox="0 0 60 60"><rect width="60" height="60" rx="14" fill="#1f1f22"/><circle cx="30" cy="30" r="17" fill="#fff"/><path d="M30 19v11l7 5" stroke="#1f1f22" stroke-width="3" fill="none"/></svg>',
  weather: '<svg viewBox="0 0 60 60"><rect width="60" height="60" rx="14" fill="#4a90d9"/><circle cx="24" cy="25" r="8" fill="#f7d34c"/><ellipse cx="34" cy="36" rx="13" ry="8" fill="#fff"/></svg>',
  map: '<svg viewBox="0 0 60 60"><rect width="60" height="60" rx="14" fill="#e8efe2"/><path d="M10 40L50 18" stroke="#f2c14e" stroke-width="6"/><path d="M30 14c-5 0-9 4-9 9 0 7 9 15 9 15s9-8 9-15c0-5-4-9-9-9z" fill="#e2544a"/><circle cx="30" cy="23" r="3.5" fill="#fff"/></svg>',
  set: '<svg viewBox="0 0 60 60"><rect width="60" height="60" rx="14" fill="#8e9198"/><circle cx="30" cy="30" r="12" fill="none" stroke="#fff" stroke-width="6" stroke-dasharray="5 3.4"/><circle cx="30" cy="30" r="5" fill="#fff"/></svg>',
  phone: '<svg viewBox="0 0 60 60"><rect width="60" height="60" rx="14" fill="#43c35e"/><path d="M22 15c1.5 0 4.5 6 4.5 7.5s-3 3-3 4.5 6 9.5 9 9.5 3-3 4.5-3 7.5 3 7.5 4.5-3 6-7.5 6C28 44 16 32 16 21c0-3 4.5-6 6-6z" fill="#fff"/></svg>'
};
/* ---------- 描画 ---------- */
function statusbar() {
  const dark = ['lock', 'home', 'call', 's0'].includes(view.name);
  const sb = $('#statusbar');
  sb.className = dark ? 'light' : '';
  sb.innerHTML = `<span>${hm(new Date())}</span><span class="icons"><svg width="18" height="12"><rect x="0" y="8" width="3" height="4" fill="currentColor"/><rect x="5" y="5" width="3" height="7" fill="currentColor"/><rect x="10" y="2" width="3" height="10" fill="currentColor"/><rect x="15" y="0" width="3" height="12" fill="currentColor"/></svg><svg width="26" height="12"><rect x="0.5" y="0.5" width="22" height="11" rx="3" fill="none" stroke="currentColor"/><rect x="2" y="2" width="15" height="8" rx="1.5" fill="currentColor"/></svg></span>`;
}
function head(title, back, cls = '') { return `<div class="pad44"></div><div class="appHead ${cls}">${back ? `<button class="back" data-act="back">‹</button>` : ''}<span class="ttl">${esc(title)}</span></div>`; }
const homebar = (light) => `<div class="homebar${light ? ' light' : ''}" data-act="home"><i></i></div>`;
function badge(app) {
  if (app === 'mail') return mails.filter(m => m.unread).length;
  if (app === 'phone') return calls.filter(c => c.missed && !c.seen).length;
  return Object.values(threads[app] || {}).reduce((a, t) => a + t.unread, 0);
}
function appIcon(app, label) {
  const n = badge(app);
  return `<button class="app" data-act="open" data-arg="${app}"><span class="ic">${ICON[app] || ''}</span><span class="nm">${esc(label)}</span>${n ? `<span class="badge">${n}</span>` : ''}</button>`;
}
function dummyIcon(k, label) { return `<button class="app"><span class="ic">${ICON[k]}</span><span class="nm">${esc(label)}</span></button>`; }
function msgHTML(app, t, m) {
  if (m.unsent) return `<div class="msg"><div class="bb">${esc(T.unsent)}</div></div>`.replace('class="msg"', 'class="msg unsent"');
  if (m.sys) return `<div class="sysline">${esc(m.text)}</div>`;
  const me = m.me;
  const av = me ? '' : `<span class="av" style="background:${COLORS[t.th] || '#888'}">${esc((m.who || t.name).slice(0, 1))}</span>`;
  let bb;
  if (m.typing) bb = `<div class="bb typing">${esc(UI.typing)}</div>`;
  else if (m.link) bb = `<div class="bb link" data-act="openVote"><div class="lkimg"></div><div class="lk"><b>${esc(UI.voteTitle)}</b><span>${esc(UI.voteHost)}</span></div></div>`;
  else if (m.img) bb = `<div class="bb img">${(SVG[m.img] || '').replace('>ソウタ<', '>' + esc(myName()) + '<')}</div>`;
  else if (m.face) bb = `<div class="bb img"><div class="camslot" style="width:120px;height:120px;margin:0;border-width:2px" data-face="1"></div></div>`;
  else bb = `<div class="bb">${esc(fill(m.text))}</div>`;
  return `<div class="msg${me ? ' me' : ''}">${av}${bb}<span class="tm">${esc(m.tm || '')}</span></div>`;
}
function inlineHTML(app, th) {
  const t = threads[app] && threads[app][th];
  if (!t || !t.inline) return '';
  return `<div class="inline">${t.inline.map((o, i) => `<button data-act="inline" data-arg="${i}">${esc(o.label)}</button>`).join('')}</div>`;
}
function render() {
  statusbar();
  const v = view, s = $('#screen');
  let html = '';
  if (v.name === 's0') html = renderS0();
  else if (v.name === 'lock') {
    const d = new Date();
    const cards = lockCards.slice(-6).reverse().map(c => `<div class="lcard"><span class="ico">${ICON[c.app] || ''}</span><div style="flex:1;min-width:0"><div class="t"><span>${esc(UI.apps[c.app] || c.app)}</span><span>${esc(c.tm)}</span></div><div class="b">${esc(c.text)}</div></div></div>`).join('');
    html = `<div class="view lock"><div class="clock">${hm(d)}</div><div class="date">${d.getMonth() + 1}月${d.getDate()}日（${'日月火水木金土'[d.getDay()]}）</div><div class="cards">${cards}</div><div class="unlock${v.locked ? ' off' : ''}" data-act="unlock">${esc(UI.unlock)}</div>${homebar(true)}</div>`;
  } else if (v.name === 'home') {
    html = `<div class="view home"><div class="grid">${appIcon('pico', UI.apps.pico)}${appIcon('kotori', UI.apps.kotori)}${appIcon('mail', UI.apps.mail)}${appIcon('sms', UI.apps.sms)}${dummyIcon('cam','カメラ')}${dummyIcon('photo','写真')}${dummyIcon('clock','時計')}${dummyIcon('weather','天気')}${dummyIcon('map','地図')}${dummyIcon('set','設定')}</div><div class="dock">${appIcon('phone', UI.apps.phone)}<span></span><span></span><span></span></div>${homebar(true)}</div>`;
  } else if (v.name === 'pico') html = renderPico();
  else if (v.name === 'kotori' || v.name === 'sms') html = renderChatApp(v.name);
  else if (v.name === 'mail') html = renderMail();
  else if (v.name === 'phone') html = `<div class="view">${head(UI.apps.phone, true)}<div class="scroll">${calls.slice().reverse().map(c => `<div class="row"><span class="av" style="background:${COLORS.mom}">母</span><div class="mid"><div class="nm"${c.missed ? ' style="color:var(--danger)"' : ''}>${esc(c.who)}</div><div class="pv">${c.missed ? '不在着信' : '通話'}</div></div><span class="tm">${esc(c.tm)}</span></div>`).join('')}</div>${homebar()}</div>`;
  else if (v.name === 'call') html = renderCall();
  else if (v.name === 'vote') html = renderVote();
  else if (v.name === 's9') html = renderS9();
  else if (v.name === 'doc') html = v.html;
  s.innerHTML = html;
  if (v.name === 'vote' && v.cam && v.stream) { const vid = s.querySelector('video'); if (vid) { vid.srcObject = v.stream; vid.play().catch(() => {}); } }
  s.querySelectorAll('[data-face]').forEach(el => { if (faceCanvas) { const c = document.createElement('canvas'); c.width = faceCanvas.width; c.height = faceCanvas.height; c.getContext('2d').drawImage(faceCanvas, 0, 0); el.appendChild(c); } else el.innerHTML = SVG.faceDummy; });
  const chat = s.querySelector('.chat'); if (chat) chat.scrollTop = chat.scrollHeight;
  if ($('#bars').classList.contains('on')) s.querySelectorAll('.view').forEach(x => x.classList.add('withBars'));
  renderTray();
}
function nameField() { return `<label class="nameLab">${esc(UI.nameLabel)}<input id="nameIn" maxlength="8" autocomplete="off" placeholder="${esc(UI.namePh)}" value="${esc(st.name)}"></label><p class="nameNote">${esc(UI.nameNote)}</p>`; }
function renderS0() {
  const saved = loadProgress();
  if (view.step === 'real') return `<div class="view s0"><div class="inner"><div class="notes">${T.s0.realNotes.map(p => `<p>${esc(p)}</p>`).join('')}</div>${nameField()}<button class="btn go" data-act="start" data-arg="real">${esc(T.s0.start)}</button><button class="backs" data-act="s0back">${esc(UI.back)}</button></div></div>`;
  if (view.step === 'normal') return `<div class="view s0"><div class="inner"><div class="notes"><p>${esc(T.s0.normalNote)}</p></div>${nameField()}<button class="btn go" data-act="start" data-arg="normal">${esc(T.s0.start)}</button><button class="backs" data-act="s0back">${esc(UI.back)}</button></div></div>`;
  const ios = deviceKind() === 'iPhone' && !navigator.standalone;
  return `<div class="view s0"><div class="inner">${saved ? `<div class="resume"><span>${esc(UI.resume)}</span><button data-act="resume">${esc(UI.goOn)}</button></div>` : ''}<button class="mode" data-act="mode" data-arg="normal"><b>${esc(T.s0.normal.label)}</b><span>${esc(T.s0.normal.desc)}</span></button><button class="mode real" data-act="mode" data-arg="real"><b>${esc(T.s0.real.label)}</b><span>${esc(T.s0.real.desc)}</span></button>${ios ? `<p style="font-size:13px;line-height:1.7;color:#9aa0ab;margin-top:6px">${esc(UI.iosFull)}</p>` : ''}</div></div>`;
}
function renderPico() {
  const v = view;
  if (st.picoLocked && !v.th) {
    const sup = (v.support || []).map(x => x === 'id' ? `<div class="bb">${SVG.idcard}</div>` : x === 'submit' ? `<button class="btn pico" data-act="submitId">${esc(T.submit)}</button>` : `<div class="bb">${esc(x)}</div>`).join('');
    return `<div class="view pico">${head(UI.apps.pico, true)}<div class="locked"><div class="big">${esc(T.s5locked)}</div><div class="fake"></div><div class="fake"></div><div class="support">${sup}</div></div>${homebar()}</div>`;
  }
  if (v.th) {
    const t = thread('pico', v.th);
    return `<div class="view pico">${head(t.name, true)}<div class="chat">${t.msgs.map(m => msgHTML('pico', t, m)).join('')}${inlineHTML('pico', v.th)}</div>${homebar()}</div>`;
  }
  const tab = v.tab || 'feed';
  let body = '';
  if (tab === 'feed') {
    body = `<div class="prof"><div class="av"></div><div><div class="nm">${esc(myName())}</div><div class="sb">投稿 ${T.picoPosts.length}　フォロワー 54</div></div></div>` +
      T.picoPosts.slice().reverse().map(p => `<div class="post">${SVG[p.img]}<div class="cap">${esc(p.text)}${p.tag ? `<small>${esc(p.tag)}</small>` : ''}</div></div>`).join('');
  } else if (tab === 'dm') {
    const list = Object.values(threads.pico).filter(t => t.msgs.length).sort((a, b) => b.t - a.t);
    body = list.map(t => { const last = t.msgs[t.msgs.length - 1]; const ghost = last && last.ghost; return `<div class="row${t.unread ? ' unread' : ''}${ghost ? ' ghost' : ''}" data-act="th" data-arg="${t.th}"><span class="av" style="background:${COLORS[t.th] || '#888'}">${esc(t.name.slice(0, 1))}</span><div class="mid"><div class="nm">${esc(t.name)}</div><div class="pv${ghost ? ' red' : ''}">${esc(last ? (last.unsent ? T.unsent : last.link ? UI.voteTitle : (last.me ? 'あなた：' : '') + fill(last.text || '')) : '')}</div></div><span class="tm">${esc(last ? last.tm : '')}</span></div>`; }).join('');
  } else {
    if (v.confirm) body = `<div class="confirm"><p>${esc(T.s4confirm)}</p><button class="btn pico" data-act="pwDo">${esc(T.s4confirmBtn)}</button><button class="btn sub" data-act="pwCancel">${esc(UI.back)}</button></div>`;
    else body = (raceAction ? `<div class="setrow" data-act="loginAlert" style="flex-direction:column;gap:8px"><span style="color:var(--danger)">${esc(raceAction.text)}</span><button class="btn" style="padding:10px">${esc(T.s4button)}</button></div>` : '') + `<div class="setrow" data-act="pwRow"><span>${esc(UI.pwRow)}</span><span>›</span></div><div class="setrow dim"><span>通知</span><span>オン</span></div><div class="setrow dim"><span>2段階認証</span><span>オフ</span></div>` + (v.pwDone ? `<div class="sysline">${esc(UI.pwDone)}</div>` : '');
  }
  return `<div class="view pico">${head('Instacam', false, 'logo')}<div class="scroll">${body}</div><div class="ptabs">${['feed', 'dm', 'set'].map((k, i) => `<button class="${tab === k ? 'on' : ''}" data-act="ptab" data-arg="${k}">${esc(UI.picoTabs[i])}${k === 'dm' && badge('pico') ? ` (${badge('pico')})` : ''}</button>`).join('')}</div>${homebar()}</div>`;
}
function renderChatApp(app) {
  const v = view;
  if (v.th) {
    const t = thread(app, v.th);
    return `<div class="view ${app}">${head(t.name, true)}<div class="chat">${t.msgs.map(m => msgHTML(app, t, m)).join('')}${inlineHTML(app, v.th)}</div>${homebar()}</div>`;
  }
  const list = Object.values(threads[app]).filter(t => t.msgs.length).sort((a, b) => b.t - a.t);
  return `<div class="view ${app}">${head(UI.apps[app], false)}<div class="scroll">${list.map(t => { const last = t.msgs[t.msgs.length - 1]; return `<div class="row${t.unread ? ' unread' : ''}" data-act="th" data-arg="${t.th}"><span class="av" style="background:${COLORS[t.th] || '#888'}">${esc(t.name.slice(0, 1))}</span><div class="mid"><div class="nm">${esc(t.name)}</div><div class="pv">${esc(last.img ? '画像' : (last.me ? 'あなた：' : '') + fill(last.text || ''))}</div></div><span class="tm">${esc(last.tm || '')}</span></div>`; }).join('')}</div>${homebar()}</div>`;
}
function renderMail() {
  const v = view;
  if (v.id) {
    const m = mails.find(x => x.id === v.id);
    let acts = '';
    if (m.leak && !st.leakFixed && !leakAnswered) acts = `<div class="acts"><button class="btn pico" data-act="leakFix">${esc(T.leakMail.change)}</button><button class="btn sub" data-act="leakClose">${esc(T.leakMail.close)}</button></div>`;
    const extra = m.dead ? `<div><span class="deadlink">https://pico.example/…</span></div><div class="note">${esc(T.s5mail.note)}</div>` : '';
    return `<div class="view">${head(UI.apps.mail, true)}<div class="mailbody"><div class="s">${esc(m.subject)}</div><div class="f">${esc(m.from)}</div><div class="b">${esc(m.body)}</div>${extra}${acts}</div>${homebar()}</div>`;
  }
  return `<div class="view">${head(UI.apps.mail, false)}<div class="scroll">${mails.slice().reverse().map(m => `<div class="mailrow${m.unread ? ' unread' : ''}" data-act="mailOpen" data-arg="${m.id}"><div class="f">${esc(m.from)}<span>${esc(m.t)}</span></div><div class="s">${esc(m.subject)}</div></div>`).join('')}</div>${homebar()}</div>`;
}
function renderCall() {
  const v = view;
  const subs = (v.subs || []).map(x => `<div class="sub${x.me ? ' me' : x.sys ? ' sys' : ''}">${x.who ? `<b>${esc(x.who)}</b>` : ''}${esc(fill(x.text))}</div>`).join('');
  let btns = '';
  if (v.ringing) btns = `<button class="rb ng" data-act="callNo"><i>✕</i>${esc(UI.decline)}</button><button class="rb ok" data-act="callYes"><i>✆</i>${esc(UI.answer)}</button>`;
  return `<div class="view call"><div class="${v.ringing ? 'ringing' : ''}"><div class="who" style="margin-top:96px"><div class="avatar">母</div>${esc(v.who || '母')}</div><div class="st">${esc(v.status || '')}</div></div><div class="subs">${subs}</div><div class="btns">${btns}</div></div>`;
}
function renderVote() {
  const v = view;
  const cands = ['#ff8fb3', '#ffc06b', '#9fc3ff', '#b6e3a8'].map((c, i) => `<div class="vcand">${SVG.cand(c)}<div>エントリーNo.${i + 1}</div></div>`).join('');
  let modal = '';
  if (v.card) modal = `<div class="vmodal"><div class="vcard">${v.card === 'cam' ? `<div class="camslot">${v.stream ? '<video playsinline muted></video>' : (v.shot ? '' : SVG.faceDummy)}</div>` : ''}<p>${esc(T.vote[v.card])}</p><button class="btn" data-act="voteCard">${esc(UI.ok)}</button></div></div>`;
  let perm = '';
  if (v.perm) perm = `<div class="vmodal" style="background:rgba(0,0,0,.2)"><div class="perm"><div class="ph">${esc(UI.voteHost)} ${esc(UI.permAsk)}</div><div class="pk">${esc(UI.permKind[v.perm])}</div><div class="pb"><button data-act="fakePerm" data-arg="0">${esc(UI.deny)}</button><button class="y" data-act="fakePerm" data-arg="1">${esc(UI.allow)}</button></div></div></div>`;
  const verify = v.verify ? `<div class="vverify"><div class="h">${esc(T.vote.verify)}</div><label>${esc(UI.phoneLabel)}</label><div class="fld">●●●-●●●●-●●●●</div><label>${esc(UI.codeLabel)}</label><div class="fld">${v.code ? esc(T.code2) : ''}</div></div>` : '';
  return `<div class="view vote" style="position:absolute;inset:0"><div class="vbar"><span class="url">${esc(UI.voteHost)}</span><button class="x" data-act="voteX">✕</button></div><div class="scroll"><div class="vhead"><b>${esc(UI.voteTitle)}</b></div><div class="vgrid">${cands}</div>${verify}</div>${modal}${perm}${homebar()}</div>`;
}
function renderS9() {
  const v = view;
  const rows = v.rows.map((r, i) => `<tr class="${r.me ? 'me' : ''}${r.last ? ' last' : ''}"${r.me ? ' data-act="s9open"' : ''}><td>${esc(r.a)}</td><td>${esc(r.p)}</td><td>${esc(r.s)}</td></tr>` + (r.me && v.openDet ? `<tr class="det"><td colspan="3"><div class="det-wrap">${SVG.shop.replace('class="ph"', 'class="shopm"').replace('</svg>', '<rect x="56" y="66" width="238" height="42" fill="none" stroke="#e33" stroke-width="3"/><rect x="311" y="146" width="70" height="34" fill="none" stroke="#e33" stroke-width="3"/></svg>')}${st.station ? `<span class="chip">${esc(st.station)}駅</span>` : ''}${st.faceTaken ? '<div class="face" data-face="1"></div>' : ''}<span class="chip">${esc(T.friends54)}</span></div></td></tr>` : '')).join('');
  return `<div class="view s9" style="position:absolute;inset:0"><div class="scroll"><table><colgroup><col class="c1"><col class="c2"><col class="c3"></colgroup><tr>${T.s9cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr>${rows}</table></div><button class="nx${v.next ? ' on' : ''}" data-act="s9next">›</button></div>`;
}
const lockCards = [];

/* ---------- 下の板（選択・S8の行動） ---------- */
function renderTray() {
  const el = $('#tray');
  el.className = '';
  el.innerHTML = '';
  if (['s9', 'doc', 's0'].includes(view.name)) return;
  if (pendingTrayOptions) {
    el.className = 'on dark';
    el.innerHTML = pendingTrayOptions.map((o, i) => `<button class="opt" data-act="trayPick" data-arg="${i}"${o.off ? ' disabled' : ''}>${esc(o.label)}</button>`).join('');
    return;
  }
  if (busy && view.name !== 'call') {
    el.className = 'on dark';
    el.innerHTML = `<div class="busy">${esc(busy.label)}…<div class="track"><div class="fill" style="width:${Math.min(100, (Date.now() - busy.start) / (busy.dur * 1000 / SPEED) * 100)}%"></div></div></div>`;
    return;
  }
  if (choice && view.name === choice.app && view.th === choice.th) {
    el.className = 'on';
    el.innerHTML = choice.options.map((o, i) => `<button class="opt" data-act="choose" data-arg="${i}">${esc(o.label)}</button>`).join('');
  }
}

/* ---------- お知らせ ---------- */
function banner(app, title, text, opts = {}) {
  const tm = hm(new Date());
  lockCards.push({ app, text: title ? `${title}${text ? '　' + text : ''}` : text, tm, fresh: true });
  sound.notify(app);
  bgNotify(text);
  /* ロック画面のときは、上から降ろさず、暗い画面が光ってロック画面に積む */
  if (view.name === 'lock' && !opts.sticky) { wake(); render(); return null; }
  /* 上に出しておくのは2枚まで（古いものから引っ込める） */
  const shown = [...document.querySelectorAll('#banners .ban:not(.out):not(.sticky)')];
  if (shown.length >= 2) dismiss(shown[0]);
  const box = document.createElement('div');
  box.className = 'ban' + (opts.sticky ? ' sticky' : '');
  box.innerHTML = `<span class="ico">${ICON[app] || ''}</span><div class="mid"><div class="t"><span>${esc(UI.apps[app] || app)}</span><span>今</span></div>${title ? `<div class="h">${esc(title)}</div>` : ''}<div class="b">${esc(text)}</div>${opts.button ? `<button class="bt">${esc(opts.button)}</button>` : ''}</div>`;
  /* 上にはらうと消える（11/17 本人「通知をどかせない・消せないのが嫌」） */
  let y0 = null, moved = false;
  const sStart = y => { y0 = y; moved = false; };
  const sMove = (y, e) => { if (y0 == null) return; const dy = y - y0; if (dy < -6) { moved = true; if (e && e.cancelable) e.preventDefault(); box.style.transition = 'none'; box.style.transform = `translateY(${dy}px)`; box.style.opacity = String(Math.max(0, 1 + dy / 120)); } };
  const sEnd = y => { if (y0 == null) return; const dy = y - y0; y0 = null; box.style.transition = ''; if (dy < -35) { dismiss(box); if (opts.onSwipe) opts.onSwipe(); } else { box.style.transform = ''; box.style.opacity = ''; } };
  box.addEventListener('touchstart', e => sStart(e.touches[0].clientY), { passive: true });
  box.addEventListener('touchmove', e => sMove(e.touches[0].clientY, e), { passive: false });
  box.addEventListener('touchend', e => sEnd(e.changedTouches[0].clientY));
  box.addEventListener('mousedown', e => sStart(e.clientY));
  window.addEventListener('mousemove', e => sMove(e.clientY));
  window.addEventListener('mouseup', e => sEnd(e.clientY));
  box.addEventListener('click', e => {
    if (moved) { moved = false; return; }
    if (opts.button && e.target.classList.contains('bt')) { opts.onButton && opts.onButton(); return; }
    if (opts.open) { gotoView(opts.open); }
    if (!opts.sticky) dismiss(box);
  });
  $('#banners').prepend(box);
  if (!opts.sticky) setTimeout(() => dismiss(box), (opts.hold || 7) * 1000);
  return box;
}
/* 画面が暗くなる → 通知で光る */
let asleep = false;
async function screenSleep() {
  view = { name: 'lock', locked: false }; backStack.length = 0; render();
  const o = $('#overlay'); o.className = 'on black'; o.textContent = ''; o.style.transition = 'opacity 1.6s'; o.style.opacity = '0';
  requestAnimationFrame(() => { o.style.opacity = '1'; });
  asleep = true;
  await sleep(2.2);
}
function wake() {
  if (!asleep) { const lc = document.querySelector('.lock .cards'); if (lc) lc.classList.add('pulse'); return; }
  asleep = false;
  const o = $('#overlay'); o.style.transition = 'opacity .25s'; o.style.opacity = '0';
  setTimeout(() => { o.className = ''; o.style.opacity = ''; o.style.transition = ''; }, 300);
}
function dismiss(box) { if (!box || !box.parentNode) return; box.classList.add('out'); setTimeout(() => box.remove(), 320); }
function toast(t) { const el = $('#toast'); el.textContent = t; el.className = 'on'; setTimeout(() => { el.className = ''; }, 2200); }

/* ---------- 会話 ---------- */
let lastTm = null;
function pushMsg(app, th, m) {
  const t = thread(app, th);
  m.tm = m.tm || hm(new Date());
  t.msgs.push(m); t.t = Date.now();
  const viewing = view.name === app && view.th === th;
  if (!m.me && !viewing) t.unread++;
  return viewing;
}
/* 人ごとの打つ速さと、ばらつき（11/17 本人「等間隔が嫌。ランダムに。構えている相手はポンポン来る」）
   ミサキ（乗っ取り犯が用意した文）・復旧代行は速い。母はゆっくり。友だちはふつう。同じ人が続けて送るときは短い。 */
const TYPING = { misaki: 0.35, stranger: 0.4, mom: 1.35, picosms: 0, yuto: 0.9, riko: 0.85, kai: 0.9 };
let lastFrom = { th: null, t: 0 };
function humanWait(th, step, len) {
  const base = Math.max((step.wait || 0) * PACE, 1.6 + len * 0.09);
  const f = TYPING[th] != null ? TYPING[th] : 0.9;
  let w = base * f * (0.55 + Math.random() * 0.9);
  if (lastFrom.th === th && Date.now() - lastFrom.t < 6000 / SPEED) w *= 0.45 + Math.random() * 0.3;   /* 続けて送るときはポンポン */
  if (Math.random() < 0.12 && f >= 0.8) w += 2 + Math.random() * 3;   /* たまに考え込む */
  lastFrom = { th, t: Date.now() };
  return Math.max(0.5, w);
}
async function deliver(step) {
  const { app, th } = step;
  if (step.when && !step.when(st)) return;
  const t = thread(app, th);
  /* 読ませる速さ：台本の間を1.6倍にし、字数に応じた最低の間をとる（11/17 本人「すごい速さで出てきて怖さがない」） */
  const len = String(step.text || '').length;
  const wait = step.noPace ? (step.wait || 0) : humanWait(th, step, len);
  if (wait > 0) {
    const ty = { typing: true };
    t.msgs.push(ty); if (view.name === app && view.th === th) render();
    await sleep(wait);
    t.msgs.splice(t.msgs.indexOf(ty), 1);
  }
  const m = { who: step.who, text: step.text, img: step.img, link: step.link };
  const viewing = pushMsg(app, th, m);
  if (!viewing && !step.quiet) banner(app, step.who, step.img ? '画像' : step.link ? UI.voteTitle : fill(step.text), { open: { name: app, th } });
  else if (viewing) sound.tap();
  render();
}

/* ---------- 画面の移動 ---------- */
const backStack = [];
function gotoView(v) {
  backStack.push(view);
  view = Object.assign({}, v);
  if (view.th && threads[view.name] && threads[view.name][view.th]) threads[view.name][view.th].unread = 0;
  if (view.name === 'pico' && !view.th && !view.tab) view.tab = 'feed';
  render();
}
function goBack() {
  const v = view;
  if (v.th) { view = Object.assign({}, v, { th: null }); if (v.name === 'pico') view.tab = 'dm'; }
  else if (v.id) view = { name: 'mail' };
  else view = { name: 'home' };
  render();
}

/* ---------- 選択を待つ ---------- */
function ask(app, th, options, opts = {}) {
  return new Promise(resolve => {
    choice = { app, th, options, resolve, at: Date.now() };
    render();
    let nudged = false;
    const tick = setInterval(() => {
      if (!choice || choice.options !== options) { clearInterval(tick); return; }
      const idle = (Date.now() - choice.at) / 1000 * SPEED;
      if (opts.nudge && !nudged && idle > TIMING.nudge) { nudged = true; deliver({ app, th, who: PEOPLE[th], text: T.nudge, wait: 0 }); }
      if (!(view.name === app && view.th === th) && idle > 20 && Math.floor(idle) % 20 === 0) banner(app, PEOPLE[th], '…', { open: { name: app, th } });
    }, 1000);
    if (AUTO) { const p = PICKS.length ? PICKS.shift() : 0; setTimeout(() => choose(Math.min(p, options.length - 1)), 300); }
  });
}
function choose(i) {
  if (!choice) return;
  const c = choice; choice = null;
  render();
  c.resolve(i);
}

/* ---------- 進み具合（端末の中だけ） ---------- */
const KEY = 'nottori.progress';
function saveProgress() { try { localStorage.setItem(KEY, JSON.stringify({ scene: st.scene, mode: st.mode })); } catch (e) {} }
function loadProgress() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
function eraseProgress() { try { localStorage.removeItem(KEY); } catch (e) {} }

/* ---------- 場面の進行 ---------- */
let leakAnswered = false;
let exploreDone = null;
async function runScene(name) {
  st.scene = name; saveProgress(); tlog('scene', name);
  /* 出来事と出来事のあいだに間をあける（何が起きたか確かめられるように） */
  if (['S3', 'S4', 'S4safe', 'S5', 'S6', 'S7', 'S8', 'END'].includes(name)) await sleep(3.5);
  if (QS.get('hold') === name) setTimeout(() => { FROZEN = true; }, (Number(QS.get('holdAfter')) || 1) * 1000 / SPEED);
  const steps = SCENES[name];
  for (const step of steps) {
    const r = await exec(step);
    if (r && r.goto) return runScene(r.goto);
  }
}
async function runSteps(steps) {
  for (const s of steps || []) { const r = await exec(s); if (r && r.goto) return r; }
  return null;
}
async function exec(step) {
  switch (step.do) {
    case 'lock': view = { name: 'lock', locked: false }; render(); return;
    case 'msg': await deliver(step); return;
    case 'pause': await sleep(step.s); return;
    case 'notify': banner(step.app, '', fill(step.text), { open: step.th ? { name: step.app, th: step.th } : { name: step.app, tab: 'dm' } }); return;
    case 'mail': await sleep(step.wait || 0); mails.push({ id: 'm' + mails.length, from: step.mail.from, subject: step.mail.subject, body: step.mail.body, unread: true, t: hm(new Date()), dead: true }); banner('mail', step.mail.from, step.mail.subject, { open: { name: 'mail', id: 'm' + (mails.length - 1) } }); return;
    case 'set': Object.assign(st, step.v); return;
    case 'open': view = Object.assign({}, step.view); render(); return;
    case 'goto': return { goto: step.to };
    case 'branch': return { goto: step.next(st) };
    case 'incoming': return incoming(step);
    case 'explore': return explore();
    case 'choice': {
      const i = await ask(step.app, step.th, step.options, { nudge: step.nudge });
      const o = step.options[i];
      if (o.me) { pushMsg(step.app, step.th, { me: true, text: o.me }); render(); }
      if (o.set) Object.assign(st, o.set);
      const r = await runSteps(o.steps);
      if (r && r.goto) return r;
      if (o.next) return { goto: o.next };
      return;
    }
    case 'vote': return voteFlow();
    case 'race': return race();
    case 'misaki3': return misaki3();
    case 'recover': return recover();
    case 'ending': return ending();
    case 'attacker': return attacker();
    case 'readout': return readout();
    case 'advice': return advice();
    default: tlog('unknown step', step.do);
  }
}

/* S1：着信 */
async function incoming(step) {
  const prev = view.name === 'lock' ? view : { name: 'home' };
  view = { name: 'call', ringing: true, who: step.who, status: UI.incoming, subs: [] };
  render();
  let answered = null;
  const ring = setInterval(() => sound.ringOnce(), 1600 / SPEED);
  sound.ringOnce();
  const pick = await new Promise(resolve => {
    view.onPick = resolve;
    setTimeout(() => resolve(1), step.max * 1000 / SPEED);
    if (AUTO) { const p = PICKS.length ? PICKS.shift() : 0; setTimeout(() => resolve(p), 300); }
  });
  clearInterval(ring);
  answered = pick === 0;
  const o = step.options[answered ? 0 : 1];
  if (o.set) Object.assign(st, o.set);
  if (answered) { view.ringing = false; view.status = '通話中'; render(); }
  for (const s of o.steps) {
    if (s.do === 'say') { await sleep(s.wait || 0); view.subs.push({ who: s.who, text: s.text }); render(); }
    else if (s.do === 'hangup') { await sleep(s.wait || 0); calls.push({ who: '母', tm: hm(new Date()), missed: false }); }
    else if (s.do === 'missed') { calls.push({ who: '母', tm: hm(new Date()), missed: true }); lockCards.push({ app: 'phone', text: UI.missed, tm: hm(new Date()) }); }
  }
  view = prev; if (view.name === 'lock') view.locked = false; render();
}
/* S1：自由に見て回る。ロックを開けてから60秒、または流出メールの返事から8秒で S2 */
function explore() {
  return new Promise(resolve => {
    exploreDone = resolve;
    let started = Date.now();   /* 電話が終わったときから数える（ロック画面のままでも進む） */
    const iv = setInterval(() => {
      if (view.name !== 'lock' && !started) started = Date.now();
      if (started && (Date.now() - started) * SPEED / 1000 > TIMING.s1ExploreMax) { clearInterval(iv); exploreDone = null; resolve(); }
    }, 500);
    if (AUTO) { setTimeout(() => { if (view.name === 'lock') { view = { name: 'home' }; render(); } }, 200); if (QS.get('leak') === '1') setTimeout(() => leakFix(true), 400); }
  });
}
function leakAnsweredThen() { leakAnswered = true; if (exploreDone) { const r = exploreDone; exploreDone = null; setTimeout(r, TIMING.s1AfterMail * 1000 / SPEED); } }
function leakFix(auto) {
  if (auto) { st.leakFixed = true; leakAnsweredThen(); return; }
  view = { name: 'pico', tab: 'set', confirm: false, fromLeak: true }; render();
}

/* S3：投票ページ */
let voteView = null;   /* 投票ページを離れても、戻れるように持っておく */
async function voteFlow() {
  st.opened = true;
  const vv = { name: 'vote', verify: false }; voteView = vv; view = vv;
  render();
  await sleep(1.2);
  for (const kind of ['loc', 'cam', 'notif']) {
    vv.card = kind; render();
    await waitAct('voteCard');
    vv.card = null; render();
    if (st.mode === 'real') await realPerm(kind);
    else { vv.perm = kind; render(); const ok = await waitAct('fakePerm'); vv.perm = null; if (kind === 'loc') st.locAllowed = false; render(); if (kind === 'cam' && ok) st.faceTaken = false; }
  }
  vv.verify = true; render();
  await sleep(1.0);
  pushMsg('sms', 'picosms', { who: 'インスタカム', text: T.sms2 });
  banner('sms', 'インスタカム', T.sms2, {});
  await sleep(0.6);
  tray = null;
  const i = await new Promise(resolve => {
    choice = { app: 'vote', th: undefined, options: [{ label: '「SMSの番号を入れる」' }, { label: '閉じる' }], resolve, at: Date.now() };
    renderVoteTray();
    if (AUTO) { const p = PICKS.length ? PICKS.shift() : 0; setTimeout(() => choose(p), 300); }
  });
  if (i === 0) {
    st.path3 = true; vv.code = true; render();
    await sleep(1.2);
    vv.verify = false; vv.card = null; render();
    if (view === vv) $('#screen .scroll').insertAdjacentHTML('afterbegin', `<div class="vverify" style="margin-top:14px"><div class="h">投票ありがとうございました</div></div>`);
    await sleep(2);
  }
  voteView = null;
  if (view === vv) { view = { name: 'pico', th: 'misaki' }; render(); }
}
function renderVoteTray() {
  if (view !== voteView) return;
  const el = $('#tray');
  el.className = 'on';
  el.innerHTML = choice.options.map((o, i) => `<button class="opt" data-act="choose" data-arg="${i}">${esc(o.label)}</button>`).join('');
}
const actWaiters = {};
function waitAct(name) {
  return new Promise(resolve => {
    actWaiters[name] = resolve;
    if (AUTO) setTimeout(() => { if (actWaiters[name]) { const r = actWaiters[name]; delete actWaiters[name]; r(name === 'fakePerm' ? 1 : true); } }, 250);
  });
}
async function realPerm(kind) {
  try {
    if (kind === 'loc' && navigator.geolocation) {
      const pos = await new Promise(res => {
        let done = false;
        navigator.geolocation.getCurrentPosition(p => { done = true; res(p); }, () => { done = true; res(null); }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
        setTimeout(() => { if (!done) res(null); }, 20000);
      });
      if (pos) { st.locAllowed = true; st.lat = pos.coords.latitude; st.lon = pos.coords.longitude; st.station = nearestStation(st.lat, st.lon); }
    } else if (kind === 'cam' && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false }).catch(() => null);
      if (stream) {
        const vv = voteView || view; vv.card = 'cam'; vv.stream = stream; render();
        await sleep(2.5);
        const vid = $('#screen video');
        if (vid && vid.videoWidth) {
          const c = document.createElement('canvas'); const s = Math.min(vid.videoWidth, vid.videoHeight);
          c.width = 240; c.height = 240;
          c.getContext('2d').drawImage(vid, (vid.videoWidth - s) / 2, (vid.videoHeight - s) / 2, s, s, 0, 0, 240, 240);
          faceCanvas = c; st.faceTaken = true;
        }
        stream.getTracks().forEach(t => t.stop());       /* 1枚撮ったらすぐ止める */
        vv.stream = null; vv.card = null; render();
      }
    } else if (kind === 'notif' && 'Notification' in window) {
      const p = await Notification.requestPermission().catch(() => 'denied');
      st.notifAllowed = p === 'granted';
    }
  } catch (e) { tlog('perm', kind, e && e.message); }
}

/* S4：40秒 */
async function race() {
  st.route = null;
  const far = fill('{遠い都道府県}');
  const momT = thread('pico', 'mom'); momT.name = '母';
  pushMsg('pico', 'mom', { me: true, ghost: true, text: T.s4toMom });
  let saved = false, sent = 0, done = false;
  const onPress = () => {
    if (done || st.route) return;
    $('#overlay').className = 'on modal';
    $('#overlay').innerHTML = `<div class="dlg"><p>${esc(T.s4confirm)}</p><button class="btn" id="pwgo">${esc(T.s4confirmBtn)}</button><button class="btn sub" id="pwno" style="margin-top:10px">キャンセル</button></div>`;
    const close = () => { $('#overlay').className = ''; $('#overlay').innerHTML = ''; $('#overlay').onclick = null; };
    $('#pwgo').onclick = e => { e.stopPropagation(); close(); if (!done) { saved = true; done = true; } };
    $('#pwno').onclick = e => { e.stopPropagation(); close(); };
    $('#overlay').onclick = e => { if (e.target.id === 'overlay') close(); };
  };
  raceAction = { press: onPress, text: T.s4notify.replace('{遠い都道府県}', far) };
  raceBanner = banner('pico', '', raceAction.text, { sticky: true, button: T.s4button, onButton: onPress });
  view = { name: 'pico', tab: 'dm' }; render();
  if (AUTO) { const p = PICKS.length ? PICKS.shift() : 0; if (p === 0) setTimeout(() => { onPress(); setTimeout(() => $('#pwgo') && $('#pwgo').click(), 200); }, 3500 / SPEED * 4); }
  const t0 = Date.now();
  while (!done) {
    await sleep(0.25);
    const el = (Date.now() - t0) * SPEED / 1000;
    const want = Math.min(TIMING.s4.friends, Math.max(0, Math.floor((el - TIMING.s4.grace) / TIMING.s4.interval) + 1));
    while (sent < want && !done) {
      const k = 'f' + sent; thread('pico', k).name = FRIENDS[sent];
      pushMsg('pico', k, { me: true, ghost: true, text: T.s4toFriend }); sent++; render();
    }
    if (el >= TIMING.s4.lockout) done = true;
  }
  dismiss(raceBanner); raceBanner = null; raceAction = null;
  st.sentCount = sent;
  if (saved && sent < TIMING.s4.friends) {
    st.route = 'in';
    banner('pico', '', T.s4saved, {});
  } else {
    st.route = 'out'; st.sentCount = TIMING.s4.friends;
    $('#overlay').className = 'on white'; $('#overlay').textContent = T.s4white;
    await sleep(3);
    $('#overlay').className = ''; $('#overlay').textContent = '';
  }
  render();
}

/* S6：ミサキの3通（5秒で取り消し） */
async function misaki3() {
  const lines = st.opened ? T.s6opened.filter(l => !l.needStation || st.station) : T.s6notOpened;
  const shown = [];
  for (const l of lines) {
    await sleep(TIMING.s6Gap * (0.25 + Math.random() * 0.45));
    const text = fill(l.text);
    if (st.picoLocked) banner('pico', 'ミサキ', text, { hold: TIMING.s6UnsendAfter });
    else { const m = { who: 'ミサキ', text }; pushMsg('pico', 'misaki', m); shown.push(m); if (!(view.name === 'pico' && view.th === 'misaki')) banner('pico', 'ミサキ', text, { open: { name: 'pico', th: 'misaki' }, hold: TIMING.s6UnsendAfter }); render(); }
  }
  await sleep(TIMING.s6UnsendAfter);
  shown.forEach(m => { m.unsent = true; });
  render();
  await sleep(1);
}

/* S8：取り戻す */
async function recover() {
  const out = st.route === 'out';
  const momLeft = { v: TIMING.lines.mom };
  const frLeft = { v: out ? TIMING.lines.friends : 0 };
  const receivers = []; for (let i = 0; i < st.sentCount; i++) receivers.push(i);
  let speed = 1, momDone = false;
  $('#bars').className = 'on';
  const drawBars = () => {
    const bar = (lab, left, total, cls) => `<div class="bar ${cls}"><div class="lab"><span>${esc(lab)}</span><b>${Math.max(0, Math.ceil(left))}秒</b></div><div class="track"><div class="fill" style="width:${Math.max(0, left / total * 100)}%"></div></div></div>`;
    $('#bars').innerHTML = bar(T.lineMom, momLeft.v, TIMING.lines.mom, st.momSaved ? 'saved' : '') + (out ? bar(T.lineFriends, frLeft.v, TIMING.lines.friends, '') : '');
  };
  document.querySelectorAll('.view').forEach(v => v.classList.add('withBars'));
  const acts = [{ id: 'mom', label: T.act.mom }];
  if (out) acts.push({ id: 'friend', label: T.act.friend });
  acts.push({ id: 'mail', label: T.act.mail });
  if (out) acts.push({ id: 'apply', label: T.act.apply });
  tray = acts;
  let momCalls = 0, momStage = 0, strangerShown = false;
  const doBusy = async (label, dur) => { busy = { label, start: Date.now(), dur }; render(); const iv = setInterval(renderTray, 200); await sleep(dur); clearInterval(iv); busy = null; render(); };
  const momCall = async () => {
    const prev = view;
    view = { name: 'call', who: '母', status: UI.calling, subs: [] }; render();
    sound.dialOnce();
    await sleep(TIMING.s8.ring);
    momCalls++;
    if (momCalls === 1 && momStage === 0) {
      view.subs.push({ sys: true, text: T.noAnswer }); render();
      await sleep(TIMING.s8.sayHold);
      view = prev; render();
      momStage = 1;
      const i = await askTray([{ label: T.again }, { label: T.writeKotori }]);
      if (i === 1) { pushMsg('kotori', 'mom', { me: true, text: T.kotoriToMom }); render(); await sleep(TIMING.s8.callback); }
      return momConversation();
    }
    return momConversation(true);
  };
  const momConversation = async (already) => {
    if (st.momSaved || momLeft.v <= 0) return;
    view = { name: 'call', who: '母', status: '通話中', subs: [] }; render();
    for (const line of T.momCall) { await sleep(TIMING.s8.sayHold); view.subs.push({ who: '母', text: line }); render(); }
    const opts = [{ label: T.replyOre }]; if (st.answeredS1) opts.push({ label: T.replyLetter });
    let saidOre = false;
    while (true) {
      const i = await askTray(opts, true);
      if (i === 0) {
        view.subs.push({ me: true, text: T.replyOre.replace(/[「」]/g, '') }); render();
        await sleep(TIMING.s8.sayHold); view.subs.push({ who: '母', text: T.momAfterOre }); render();
        momLeft.v -= TIMING.s8.orePenalty; drawBars();
        if (!st.answeredS1 || saidOre) { await sleep(TIMING.s8.sayHold); break; }
        saidOre = true;
      } else {
        view.subs.push({ me: true, text: T.replyLetter.replace(/[「」]/g, '') }); render();
        for (const l of T.momAfterLetter) { await sleep(TIMING.s8.sayHold); view.subs.push({ who: '母', text: l }); render(); }
        st.momSaved = true; momDone = true; drawBars();
        await sleep(TIMING.s8.sayHold); break;
      }
    }
    view = { name: 'kotori', th: 'mom' }; render();
  };
  const t0 = Date.now(); let last = t0;
  const timer = setInterval(() => {
    const now = Date.now(); const dt = FROZEN ? 0 : (now - last) * SPEED / 1000; last = now;
    if (!st.momSaved && !momDone) { momLeft.v -= dt; if (momLeft.v <= 0) { st.momPaid = true; momDone = true; } }
    if (out && frLeft.v > 0) {
      frLeft.v -= dt * speed;
      const left = receivers.filter(i => !st.notified.has(i) && !st.paid.has(i));
      const shouldPaid = Math.floor((1 - Math.max(0, frLeft.v) / TIMING.lines.friends) * receivers.length);
      while (st.paid.size < shouldPaid && left.length) { const k = left.shift(); st.paid.add(k); }
    }
    if (!strangerShown && (now - t0) * SPEED / 1000 > TIMING.s8.strangerAt) { strangerShown = true; stranger(); }
    drawBars();
  }, 200);
  drawBars();
  const actLoop = (async () => {
    while (!(momDone && (!out || frLeft.v <= 0))) {
      const i = await askTray(tray.map(a => ({ label: a.label, off: a.off })));
      if (i < 0) break;
      const a = tray[i]; tlog('act', a.id);
      if (a.id === 'mom') { if (!st.momSaved && momLeft.v > 0) await momCall(); }
      else if (a.id === 'friend') {
        const next = receivers.find(k => !st.notified.has(k) && !st.paid.has(k));
        if (next == null) { toast('もう知らせる人がいない'); continue; }
        view = { name: 'kotori', th: 'f' + next }; thread('kotori', 'f' + next).name = FRIENDS[next];
        pushMsg('kotori', 'f' + next, { me: true, text: 'インスタカム乗っ取られた。俺から来たのは無視して' }); render();
        await doBusy(T.act.friend, TIMING.s8.notifyEach);
        st.notified.add(next);
        if (st.notified.size >= TIMING.s8.speedUpAfter) speed = TIMING.s8.speedUpRate;
      } else if (a.id === 'mail') { await doBusy(T.act.mail, TIMING.s8.mailPw); st.mailPw = true; a.off = true; }
      else if (a.id === 'apply') {
        view = { name: 'pico', support: [] }; render();
        await doBusy(T.act.apply, TIMING.s8.apply);
        view.support = [T.support[0], T.support[1], 'id', 'submit']; render();
        await waitAct('submitId');
        view.support = [T.support[0], T.support[1], 'id', T.support[2]]; render();
        st.applied = true; a.off = true;
      }
    }
  })();
  await new Promise(resolve => { const iv = setInterval(() => { if (momDone && (!out || frLeft.v <= 0)) { clearInterval(iv); resolve(); } }, 300); });
  clearInterval(timer);
  if (trayResolve) { const r = trayResolve; trayResolve = null; r(-1); }
  tray = null; busy = null;
  if (!st.mailPw) banner('kotori', '', T.kotoriLogin, {});
  $('#bars').className = ''; $('#bars').innerHTML = '';
  if (view.name === 'call') { view = { name: 'kotori', th: 'mom' }; }
  render();
  await sleep(2);
}
let trayResolve = null;
function askTray(options, inCall) {
  return new Promise(resolve => {
    trayResolve = resolve;
    pendingTrayOptions = options;
    renderTray();
    if (AUTO) { const p = PICKS.length ? PICKS.shift() : 0; setTimeout(() => pickTray(Math.min(p, options.length - 1)), 300); }
  });
}
let pendingTrayOptions = null;
function pickTray(i) { if (!trayResolve) return; const r = trayResolve; trayResolve = null; pendingTrayOptions = null; $('#tray').className = ''; $('#tray').innerHTML = ''; r(i); }
async function stranger() {
  await deliver({ app: 'kotori', th: 'stranger', who: UI.stranger, text: T.stranger1, wait: TIMING.s8.strangerWait });
  const t = thread('kotori', 'stranger');
  t.inline = [{ label: T.ignore, f: () => { t.inline = null; render(); } }, { label: T.listen, f: async () => { t.inline = null; pushMsg('kotori', 'stranger', { me: true, text: T.listen }); render(); await deliver({ app: 'kotori', th: 'stranger', who: UI.stranger, text: T.stranger2, wait: 2 }); t.inline = [{ label: T.quit, f: () => { t.inline = null; pushMsg('kotori', 'stranger', { me: true, text: T.quit }); render(); } }]; render(); } }];
  render();
}

/* 結末 */
async function ending() {
  const n = st.route === 'out' ? st.paid.size : Math.ceil(st.sentCount / 2);
  st.friendsPaid = n;
  view = { name: 'kotori', th: 'mom' };
  await deliver({ app: 'kotori', th: 'mom', who: '母', text: st.momSaved ? T.endA : T.endB, wait: TIMING.endingWait });
  const edge = $('#edge');
  edge.className = 'on';
  edge.innerHTML = `<span>${esc(fill(T.edge).replace('{n}', n))}</span><button id="edgeNext">›</button>`;
  await new Promise(r => { $('#edgeNext').onclick = r; setTimeout(r, TIMING.endingHold * 1000 / SPEED); });
  edge.className = ''; edge.innerHTML = '';
  if (st.applied) {
    $('#overlay').className = 'on black'; $('#overlay').textContent = T.later; await sleep(2);
    $('#overlay').className = ''; $('#overlay').textContent = '';
    st.picoLocked = false;
    mails.push({ id: 'mr', from: 'インスタカム', subject: T.restored, body: T.restored, unread: true, t: '4日後' });
    view = { name: 'pico', tab: 'dm' }; render();
    await sleep(TIMING.laterHold);
  }
}

/* S9：向こうの画面 */
async function attacker() {
  tray = null; choice = null; renderTray();
  $('#overlay').className = 'on black'; $('#overlay').textContent = '';
  await sleep(TIMING.s9Dark);
  $('#overlay').className = '';
  const names = ['ミサキ', 'たくみ_07', 'yuu.k', 'さき', 'ren0412', 'まなみ', 'hiro_t', 'りん', 'kazuya', 'あや', 'sora.m', 'しおり', 'tatsu', 'なな', 'ryota_22', 'ゆい', 'kenta.s', 'みお', 'daiki', 'はるか', 'shun', 'あおい', 'mei_k', 'こうた', 'rina', 'つばさ', 'yuto.h', 'かな', 'sho', 'えみ', 'takeru', 'のぞみ'];
  const paths = [T.path2, T.path3, T.path1];
  const rows = names.map((a, i) => ({ a, p: paths[i % 3], s: i % 5 === 0 ? 'ログイン中' : '送信中' }));
  let me;
  if (st.route === 'safe') me = { a: myName(), p: '—', s: T.failed3, me: true };
  else {
    const p = []; if (!st.leakFixed) p.push(T.path1); if (st.path2) p.push(T.path2); if (st.path3) p.push(T.path3);
    me = { a: myName(), p: p.join(' / ') + '　' + T.twoStep, s: 'ログイン中', me: true };
  }
  rows.splice(1, 0, me);
  view = { name: 's9', rows, openDet: false, next: false }; render();
  await new Promise(r => { actWaiters.s9open = r; setTimeout(r, TIMING.s9AutoOpen * 1000 / SPEED); });
  view.openDet = true; render();
  await sleep(TIMING.s9LastLine);
  view.rows.push({ a: '', p: fill(st.route === 'safe' ? T.lastSafe : T.lastIn), s: '', last: true }); view.next = true; render();
  const sc = $('#screen .scroll'); if (sc) sc.scrollTop = sc.scrollHeight;
  await new Promise(r => { actWaiters.s9next = r; if (AUTO) setTimeout(r, 400); });
}

/* S10：このゲームが読み取ったもの */
async function readout() {
  const opened = [deviceKind(), new Date().getHours() + '時' + new Date().getMinutes() + '分'];
  const allowed = []; if (st.station) allowed.push(st.station + '駅'); if (st.faceTaken) allowed.push(T.s10face);
  const html = `<div class="view doc" style="position:absolute;inset:0"><div class="scroll"><h1>${esc(T.s10title)}</h1>
    <p><span class="k">${esc(T.s10opened)}</span>${esc(opened.join('、'))}</p>
    ${allowed.length ? `<p><span class="k">${esc(T.s10allowed)}</span>${esc(allowed.join('、'))}</p>` : ''}
    <p>${esc(T.s10sent)}</p>${st.faceTaken ? `<p>${esc(T.s10deleted)}</p>` : ''}
    <p class="k">${esc(T.s10howto)}</p><ul><li${deviceKind() === 'iPhone' ? ' class="cur"' : ''}>${esc(T.s10iphone)}</li><li${deviceKind() === 'Android' ? ' class="cur"' : ''}>${esc(T.s10android)}</li><li${deviceKind() === 'パソコン' ? ' class="cur"' : ''}>${esc(T.s10pc)}</li></ul>
    <button class="btn" data-act="docNext">${esc(T.next)}</button></div></div>`;
  /* 写真をここで消す（メモリからも） */
  if (faceCanvas) { const g = faceCanvas.getContext('2d'); g.clearRect(0, 0, faceCanvas.width, faceCanvas.height); faceCanvas.width = 0; faceCanvas = null; }
  st.lat = st.lon = null;
  view = { name: 'doc', html }; render();
  await new Promise(r => { actWaiters.docNext = r; if (AUTO) setTimeout(r, 400); });
}
/* S11 */
async function advice() {
  const html = `<div class="view doc" style="position:absolute;inset:0"><div class="scroll"><h1>${esc(T.s11title)}</h1>
    <ul>${T.s11main.map(x => `<li class="cur">${esc(x)}</li>`).join('')}</ul>
    <details><summary>${esc(UI.more)}</summary><ul>${T.s11more.map(x => `<li>${esc(x)}</li>`).join('')}</ul></details>
    <p style="font-size:11px;color:var(--sub);margin-top:18px">${esc(T.credit)}</p><button class="btn sub" data-act="erase">${esc(T.erase)}</button><button class="btn" data-act="again">${esc(T.again2)}</button></div></div>`;
  view = { name: 'doc', html }; render();
  tlog('END', JSON.stringify({ route: st.route, sent: st.sentCount, paid: st.friendsPaid, momSaved: st.momSaved, applied: st.applied, mailPw: st.mailPw }));
}

/* ---------- 裏にいるとき ---------- */
let titleBase = document.title;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (st.scene !== 'S0' && !['S9', 'S10', 'S11'].includes(st.scene)) document.title = ['S7', 'S8', 'END'].includes(st.scene) ? T.tabKotori : T.tabPico;
  } else document.title = titleBase;
});
function bgNotify(text) {
  if (!document.hidden || !st.notifAllowed || !('Notification' in window) || Notification.permission !== 'granted') return;
  try { new Notification(T.bgNotif1, { body: fill(st.station ? T.bgNotif2 : text), tag: 'game' }); } catch (e) {}
}

/* ---------- 押した所 ---------- */
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act, arg = el.dataset.arg;
  if (actWaiters[act]) { const r = actWaiters[act]; delete actWaiters[act]; r(act === 'fakePerm' ? arg === '1' : true); }
  switch (act) {
    case 'mode': view = { name: 's0', step: arg }; render(); break;
    case 's0back': view = { name: 's0' }; render(); break;
    case 'fresh': eraseProgress(); render(); break;
    case 'resume': wantResume = true; { const sv = loadProgress(); begin(sv && sv.mode === 'real' ? 'real' : 'normal'); } break;
    case 'start': { const el = document.getElementById('nameIn'); st.name = el ? el.value.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 8) : ''; begin(arg); break; }
    case 'unlock': if (!view.locked) { view = { name: 'home' }; render(); } break;
    case 'home': if (view.name !== 'call') { view = { name: 'home' }; render(); } break;
    case 'open': gotoView({ name: arg }); break;
    case 'back': goBack(); break;
    case 'th': gotoView({ name: view.name, th: arg }); break;
    case 'ptab': view = { name: 'pico', tab: arg }; render(); break;
    case 'mailOpen': { const m = mails.find(x => x.id === arg); if (m) m.unread = false; gotoView({ name: 'mail', id: arg }); break; }
    case 'leakFix': leakFix(false); break;
    case 'leakClose': leakAnsweredThen(); goBack(); break;
    case 'pwRow': if (view.fromLeak || st.leakFixed) { view.confirm = true; render(); } break;
    case 'pwDo': view.confirm = false; view.pwDone = true; if (view.fromLeak && !st.leakFixed) { st.leakFixed = true; leakAnsweredThen(); } render(); break;
    case 'pwCancel': view.confirm = false; render(); break;
    case 'choose': choose(Number(arg)); break;
    case 'trayPick': pickTray(Number(arg)); break;
    case 'inline': { const t = threads[view.name] && threads[view.name][view.th]; if (t && t.inline && t.inline[arg]) t.inline[arg].f(); break; }
    case 'callYes': if (view.onPick) view.onPick(0); break;
    case 'callNo': if (view.onPick) view.onPick(1); break;
    case 'loginAlert': if (raceAction) raceAction.press(); break;
    case 'voteX': view = { name: 'home' }; render(); break;
    case 'openVote': if (voteView) { view = voteView; render(); } break;
    case 'erase': eraseProgress(); toast(UI.erased); break;
    case 'again': eraseProgress(); location.href = location.pathname; break;
  }
});
/* 下の板は #tray の中なので別に受ける */
$('#tray').addEventListener('click', e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  e.stopPropagation();
  if (el.dataset.act === 'choose') choose(Number(el.dataset.arg));
  if (el.dataset.act === 'trayPick') pickTray(Number(el.dataset.arg));
}, true);

/* ---------- 始める ---------- */
let wantResume = false;
async function begin(mode) {
  st.mode = mode; audioInit();
  /* Android・PCは「始める」を押したときに画面いっぱいにする（iPhoneのSafariはできないので、ホーム画面に追加してもらう） */
  try { const el = document.documentElement; if (!AUTO && el.requestFullscreen && window.innerWidth <= 600) el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {}); } catch (e) {}
  const saved = loadProgress();
  /* 続きからは「続きから」を押したときだけ。ふつうに選んだら最初から（11/17 最初の母の電話が飛ばされたため） */
  const startScene = wantResume && saved && saved.scene && SCENES[saved.scene] && !['S0', 'S1'].includes(saved.scene) ? saved.scene : 'S1';
  if (startScene === 'S1') eraseProgress();
  if (startScene !== 'S1') {
    view = { name: 'home' }; render();
    banner('pico', T.welcomeApp, T.welcome, {});
    await sleep(2);
  }
  runScene(startScene).catch(err => tlog('ERROR', err && err.stack || err));
}

/* ---------- 画面の大きさ（PC） ---------- */
function fit() {
  const w = $('#phoneWrap');
  if (window.innerWidth <= 600) { w.style.transform = ''; return; }
  const s = Math.min(1, (window.innerHeight - 40) / 844);
  w.style.transform = `scale(${s})`;
}
document.body.classList.add(deviceKind() === 'Android' || QS.get('look') === 'android' ? 'android' : 'ios');
window.addEventListener('resize', fit);
fit();
tlog('size', window.innerWidth, window.innerHeight, document.documentElement.clientWidth, (document.getElementById('phone')||{}).offsetWidth);
setInterval(() => { if (view.name === 'lock') render(); else statusbar(); }, 10000);
if (QS.get('s0') === 'real') view = { name: 's0', step: 'real' };
render();
if (AUTO) eraseProgress();
if (AUTO && QS.get('name')) st.name = QS.get('name').slice(0, 8);
if (AUTO) setTimeout(() => begin(QS.get('mode') === 'real' ? 'real' : 'normal'), 300);
