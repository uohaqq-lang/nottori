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
  locAllowed: false, lat: null, lon: null, station: null, faceTaken: false, notifAllowed: false, permAsked: [], permAllowed: [], permPre: [],
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
    .replace(/\{名前\}/g, () => myName())
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
const PEOPLE = { group: 'サークル', f0: 'ゆうと', official: 'RINE', mom: '母', misaki: 'みさき', yuto: 'ゆうと', riko: 'Riko', kai: 'kai', stranger: UI.stranger, picosms: 'インスタグラフ' };
FRIENDS.forEach((n, i) => { const k = 'f' + i; PEOPLE[k] = n; if (!COLORS[k]) COLORS[k] = ['#5b84b5', '#c26b7e', '#5f9a7a', '#a08251', '#6b74b5', '#b56b9c', '#6f8f4f', '#a3655b'][i]; });
/* アイコンの写真（生成AIで作った。人の顔は写さない）。知らない人は初期アイコンのまま */
const AVATAR = { me: 'me', mom: 'mom', misaki: 'misaki', yuto: 'yuto', riko: 'riko', kai: 'kai', f0: 'yuto', f1: 'riko', f2: 'kai', f3: 'haruka', f4: 'ren', f5: 'mio', f6: 'daichi', f7: 'aoi' };
const DEFAULT_AV = '<svg viewBox="0 0 40 40"><rect width="40" height="40" fill="#dbdbdb"/><circle cx="20" cy="16" r="7" fill="#fff"/><path d="M6 38c1.5-8 7-12 14-12s12.5 4 14 12z" fill="#fff"/></svg>';
function avHTML(th, cls, size) {
  const st = size ? `width:${size}px;height:${size}px;` : '';
  if (AVATAR[th]) return `<img class="${cls} pic" src="img/av_${AVATAR[th]}.jpg" alt="" draggable="false" style="${st}">`;
  if (th === 'group') return `<img class="${cls} pic" src="img/nabe.jpg" alt="" draggable="false" style="${st}">`;
  if (th === 'picosms') return `<span class="${cls} pic" style="${st}">${ICON.pico}</span>`;
  return `<span class="${cls} pic" style="${st}">${DEFAULT_AV}</span>`;
}
const threads = { pico: {}, kotori: {}, sms: {} };
setTimeout(() => { const gt = thread('kotori', 'group'); gt.name = T.groupName + '（9）'; gt.t = Date.now() - 86400000; T.groupOld.forEach(([who, from, text]) => gt.msgs.push({ who, from, text, tm: '昨日' })); }, 0);
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
let support = null;       /* S8 アプリからの申し込みの進み具合（画面を移っても残す） */

/* ---------- 小さな絵（写真の代わり） ---------- */
const SVG = {
  desk: `<img class="ph" src="img/desk.jpg" alt="" draggable="false">`,  /* 写真は生成AIで作った（実在の店・人ではない） */
  shop: `<img class="ph" src="img/shop.jpg" alt="" draggable="false">`,  /* 写真は生成AIで作った（実在の店・人ではない） */
  nabe: `<img class="ph" src="img/nabe.jpg" alt="" draggable="false">`,  /* 写真は生成AIで作った（実在の店・人ではない） */
  yutoShot: `<svg viewBox="0 0 220 120" width="200"><rect width="220" height="120" rx="10" fill="#f7f6f3" stroke="#ddd"/><clipPath id="ysc"><circle cx="22" cy="28" r="12"/></clipPath><image href="img/av_me.jpg" x="10" y="16" width="24" height="24" clip-path="url(#ysc)" preserveAspectRatio="xMidYMid slice"/><text x="40" y="32" font-size="11" fill="#333">ソウタ</text><rect x="14" y="48" width="192" height="52" rx="12" fill="#fff" stroke="#e5e2dc"/><text x="24" y="70" font-size="10" fill="#333">コンビニで電子マネーのカード買ってきて</text><text x="24" y="86" font-size="10" fill="#333">くれない？裏の番号を写真で送ってほしい</text></svg>`,
  storyShot: `<svg viewBox="0 0 180 300" width="170"><defs><linearGradient id="sg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b1b2e"/><stop offset="1" stop-color="#3a2a12"/></linearGradient></defs><rect width="180" height="300" rx="12" fill="url(#sg)"/><rect x="10" y="10" width="160" height="2.5" rx="1" fill="#fff" opacity=".8"/><circle cx="22" cy="28" r="9" fill="#9a9a9a"/><text x="36" y="32" font-size="9" fill="#fff">fukugyo.life_</text><text x="90" y="96" font-size="20" fill="#ffd34d" text-anchor="middle" font-weight="700">副業で</text><text x="90" y="124" font-size="24" fill="#ffd34d" text-anchor="middle" font-weight="700">月50万💰</text><text x="90" y="160" font-size="10" fill="#fff" text-anchor="middle">スマホ1台、1日10分</text><text x="90" y="176" font-size="10" fill="#fff" text-anchor="middle">気になる人はDMください</text><rect x="44" y="210" width="92" height="26" rx="13" fill="#fff"/><text x="90" y="227" font-size="10" fill="#111" text-anchor="middle">DMで詳しく</text><text x="90" y="285" font-size="8" fill="#bbb" text-anchor="middle">（ゲーム内の絵）</text></svg>`,
  selfie: `<svg viewBox="0 0 180 150" class="idcard"><rect width="180" height="150" rx="10" fill="#1d2230"/><ellipse cx="90" cy="72" rx="40" ry="52" fill="none" stroke="#fff" stroke-width="3" stroke-dasharray="6 5"/><path d="M30 72 l-12 0 m6 -6 l-6 6 l6 6 M150 72 l12 0 m-6 -6 l6 6 l-6 6" stroke="#fff" stroke-width="3" fill="none"/><text x="90" y="142" font-size="10" fill="#cfd6e4" text-anchor="middle">顔を左右に動かす（ゲーム内の絵）</text></svg>`,
  idcard: `<svg viewBox="0 0 180 112" class="idcard"><rect width="180" height="112" rx="8" fill="#eef2f6" stroke="#b9c3cf"/><rect x="12" y="22" width="52" height="66" fill="#c9a38f"/><rect x="76" y="26" width="86" height="8" fill="#9aa8bb"/><rect x="76" y="44" width="70" height="8" fill="#9aa8bb"/><rect x="76" y="62" width="80" height="8" fill="#9aa8bb"/><text x="12" y="15" font-size="9" fill="#6b7682">学生証（ゲームの中の絵）</text></svg>`,
  cand: c => `<svg viewBox="0 0 160 160"><rect width="160" height="160" fill="#efe9df"/><rect x="18" y="18" width="124" height="124" fill="#8a6a45"/><rect x="26" y="26" width="108" height="108" fill="${c}"/><circle cx="104" cy="54" r="14" fill="#fff" opacity=".8"/><path d="M26 120 L62 72 L86 100 L104 84 L134 120 Z" fill="#fff" opacity=".55"/></svg>`,
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
  const dark = ['lock', 'home', 'call', 's0', 's9'].includes(view.name);
  const sb = $('#statusbar');
  sb.className = dark ? 'light' : '';
  /* 11/24 S9は犯人のスマホ：時刻は深夜、電池は残りわずか（赤） */
  const s9 = view.name === 's9';
  sb.innerHTML = `<span>${s9 ? esc(view.clock || '3:12') : hm(new Date())}</span><span class="icons"><svg width="18" height="12"><rect x="0" y="8" width="3" height="4" fill="currentColor"/><rect x="5" y="5" width="3" height="7" fill="currentColor"/><rect x="10" y="2" width="3" height="10" fill="currentColor"/><rect x="15" y="0" width="3" height="12" fill="currentColor"/></svg><svg width="26" height="12"><rect x="0.5" y="0.5" width="22" height="11" rx="3" fill="none" stroke="currentColor"/><rect x="2" y="2" width="${s9 ? 3 : 15}" height="8" rx="1.5" fill="${s9 ? '#ff453a' : 'currentColor'}"/></svg></span>`;
}
function head(title, back, cls = '') { return `<div class="pad44"></div><div class="appHead ${cls}">${back ? `<button class="back" data-act="back">‹</button>` : ''}<span class="ttl">${esc(title)}</span></div>`; }
const homebar = (light) => `<div class="homebar${light ? ' light' : ''}" data-act="home"><i></i></div>`;
function badge(app) {
  if ((app === 'kotori' && st.rineLost) || (app === 'mail' && st.mailLost)) return 0;
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
  const av = me ? '' : avHTML(t.th, 'av');
  let bb;
  if (m.typing) bb = `<div class="bb typing" aria-label="${esc(UI.typing)}"><i></i><i></i><i></i></div>`;
  else if (m.link) bb = `<div class="bb link" data-act="openVote"><div class="lkimg"></div><div class="lk"><b>${esc(UI.voteTitle)}</b><span>${esc(UI.voteHost)}</span></div></div>`;
  else if (m.img) bb = `<div class="bb img">${(SVG[m.img] || '').replace('>ソウタ<', '>' + esc(myName()) + '<')}</div>`;
  else if (m.face) bb = `<div class="bb img"><div class="camslot" style="width:120px;height:120px;margin:0;border-width:2px" data-face="1"></div></div>`;
  else bb = `<div class="bb">${esc(fill(m.text))}</div>`;
  if (app === 'kotori') {
    const idx = t.msgs.indexOf(m);
    const read = me && t.msgs.slice(idx + 1).some(x => !x.me && !x.typing && !x.sys);
    const rd = m.readN != null ? (m.readN ? `既読 ${m.readN}<br>` : '') : read ? '既読<br>' : '';
    const side = `<span class="tm">${rd}${esc(m.tm || '')}</span>`;
    /* 本物と同じく、同じ人が続くときは顔としっぽを最初の1つにだけ */
    const pv = t.msgs[idx - 1];
    const cont = pv && !pv.sys && !pv.unsent && !pv.typing && !!pv.me === !!me && (me || pv.from === m.from) ? ' cont' : '';
    if (t.th === 'group' && m.typing) return `<div class="msg"><span class="av" style="visibility:hidden"></span>${bb}</div>`;
    if (t.th === 'group' && !me) return `<div class="msg${cont}">${m.from ? avHTML(m.from, 'av') : av}<div class="gcol">${cont ? '' : `<span class="gname">${esc(m.who || '')}</span>`}<div class="grow">${bb}${side}</div></div></div>`;
    return me ? `<div class="msg me${cont}">${side}${bb}</div>` : `<div class="msg${cont}">${av}${bb}${side}</div>`;
  }
  if (app === 'pico') {
    /* 本物と同じく、同じ人が続くときは顔を最後の1つにだけ出す */
    const nx = t.msgs[t.msgs.indexOf(m) + 1];
    const tail = !nx || !!nx.me !== !!me || nx.sys || nx.unsent;
    return `<div class="msg${me ? ' me' : ''}${tail ? '' : ' cont'}">${av}${bb}</div>`;
  }
  return `<div class="msg${me ? ' me' : ''}">${av}${bb}<span class="tm">${esc(m.tm || '')}</span></div>`;
}
function canReply(app, th) {
  const t = threads[app] && threads[app][th];
  return !!(t && t.inline && t.inline.length) || !!(choice && choice.app === app && choice.th === th);
}
/* 11/24 自分で打って返す場面（choice.input）か。打ちかけの文は、画面を移って戻っても残す */
let dmDraft = '', codeDraft = '', typedReply = null;
function composeHere(app, th) { return !!(choice && choice.input && choice.app === app && choice.th === th); }
function inlineHTML(app, th) {
  const t = threads[app] && threads[app][th];
  if (!t || !t.inline) return '';
  return `<div class="inline">${t.inline.map((o, i) => `<button data-act="inline" data-arg="${i}">${esc(o.label)}</button>`).join('')}</div>`;
}
let lastKey = '', lastSnap = null;
const APPS = ['pico', 'kotori', 'mail', 'sms', 'phone'];
function navKind(o, n) {
  if (!o || AUTO && !QS.has('anim')) return '';
  const isApp = x => APPS.includes(x);
  const depth = v => (v.th || v.id || v.lc || v.where || v.sett) ? (v.lc || v.where || v.sett === 'sec' || v.sett === 'mails' ? 2 : 1) : 0;
  if (n.name === 'home' && (isApp(o.name) || ['vote', 'protect'].includes(o.name))) return 'close';
  if ((isApp(n.name) || ['vote', 'protect'].includes(n.name)) && n.name !== o.name) return 'open';
  if (isApp(n.name) && n.name === o.name) { const a = depth(o), b = depth(n); if (b > a) return 'push'; if (b < a) return 'pop'; }
  return '';
}
function render() {
  statusbar();
  const v = view, s = $('#screen');
  let html = '';
  if (v.th && threads[v.name] && threads[v.name][v.th]) threads[v.name][v.th].unread = 0;
  const key = [v.name, v.th, v.tab, v.id, v.sett, v.lc, v.where].join('|');
  const oldSc = s.querySelector('.scroll'), oldCh = s.querySelector('.chat');
  const keep = key === lastKey ? { sc: oldSc ? oldSc.scrollTop : 0, chBottom: !oldCh || oldCh.scrollHeight - oldCh.scrollTop - oldCh.clientHeight < 40, ch: oldCh ? oldCh.scrollTop : 0 } : null;
  const nav = key === lastKey ? '' : navKind(lastSnap, v);
  const oldEl = nav ? s.firstElementChild : null;
  if (key !== lastKey) trayFolded = null;
  lastKey = key; lastSnap = { name: v.name, th: v.th, tab: v.tab, id: v.id, sett: v.sett, lc: v.lc, where: v.where };
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
  else if (v.name === 'phone') html = `<div class="view">${head(UI.apps.phone, true)}<div class="scroll">${calls.slice().reverse().map(c => `<div class="row">${avHTML('mom', 'av')}<div class="mid"><div class="nm"${c.missed ? ' style="color:var(--danger)"' : ''}>${esc(c.who)}</div><div class="pv">${c.missed ? '不在着信' : '通話'}</div></div><span class="tm">${esc(c.tm)}</span></div>`).join('')}</div>${homebar()}</div>`;
  else if (v.name === 'call') html = renderCall();
  else if (v.name === 'vote') html = renderVote();
  else if (v.name === 'protect') {
    const M = T.s5mail;
    const rm = mails.find(m => m.revert); const expired = !st.reverted && rm && (Date.now() - rm.at) * SPEED / 1000 > 120;
    const inner = expired ? `<p class="lcnote">${esc(M.pExpired)}</p>` : st.reverted ? `<p class="lcnote">${esc(M.pDone)}</p><button class="btn igBlue" data-act="open" data-arg="pico">${esc(M.pOpen)}</button>` : `<p class="lcnote">${esc(M.pBody)}</p><label class="lclab">${esc(T.lc.pwLabel)}</label><div class="lcfld">••••••••••••</div><button class="btn igBlue" data-act="revertDo">${esc(M.pBtn)}</button>`;
    html = `<div class="view vote" style="position:absolute;inset:0;background:#fff"><div class="vbar"><span class="url">${esc(M.url)}</span><button class="x" data-act="voteX">✕</button></div><div class="scroll"><div class="lcbox"><div class="igLogo" style="text-align:center;margin:8px 0 14px">Instagraph</div><b class="lcttl">${esc(M.pTitle)}</b>${inner}</div></div>${homebar()}</div>`;
  }
  else if (v.name === 's9') html = renderS9();
  else if (v.name === 'doc') html = v.html;
  /* 11/24 打っている途中に画面を作り直すと、入力欄が消えてキーボードが閉じる。
     同じ画面のままなら、DMは会話の部分だけ、投票ページは何も作り直さない */
  if (!nav && keep && patchKeepInput(s, v, html)) { renderTray(); return; }
  s.innerHTML = html;
  { const sb = s.querySelector('[data-act="submitId"]'); if (sb) setTimeout(() => sb.scrollIntoView({ block: 'center' }), 0); }
  if (nav) {
    const nw = s.firstElementChild;
    if (nw) nw.classList.add('nav-' + nav + '-in');
    if (oldEl) {
      oldEl.classList.add('navghost', 'nav-' + nav + '-out');
      if (nav === 'close' || nav === 'pop') s.appendChild(oldEl); else s.insertBefore(oldEl, nw);
      setTimeout(() => oldEl.remove(), 340);
    }
    if (nw) setTimeout(() => nw.classList.remove('nav-' + nav + '-in'), 360);
  }
  if (v.name === 'vote' && v.cam && v.stream) { const vid = s.querySelector('video'); if (vid) { vid.srcObject = v.stream; vid.play().catch(() => {}); } }
  s.querySelectorAll('[data-face]').forEach(el => { if (faceCanvas) { const c = document.createElement('canvas'); c.width = faceCanvas.width; c.height = faceCanvas.height; c.getContext('2d').drawImage(faceCanvas, 0, 0); el.appendChild(c); } else el.innerHTML = SVG.faceDummy; });
  const chat = s.querySelector('.chat'); if (chat) chat.scrollTop = keep && !keep.chBottom ? keep.ch : chat.scrollHeight;
  const sc2 = s.querySelector('.scroll'); if (sc2 && keep) sc2.scrollTop = keep.sc;
  if ($('#bars').classList.contains('on')) s.querySelectorAll('.view').forEach(x => x.classList.add('withBars'));
  renderTray();
}
function patchKeepInput(s, v, html) {
  if (v.name === 'pico' && v.th) {
    const oc = s.querySelector('.chat');
    if (!s.querySelector('#dmIn') || !oc || html.indexOf('id="dmIn"') < 0) return false;
    const tmp = document.createElement('div'); tmp.innerHTML = html;
    const nc = tmp.querySelector('.chat'); if (!nc) return false;
    const atBottom = oc.scrollHeight - oc.scrollTop - oc.clientHeight < 40;
    oc.innerHTML = nc.innerHTML;
    oc.querySelectorAll('[data-face]').forEach(el => { if (faceCanvas) { const c = document.createElement('canvas'); c.width = faceCanvas.width; c.height = faceCanvas.height; c.getContext('2d').drawImage(faceCanvas, 0, 0); el.appendChild(c); } else el.innerHTML = SVG.faceDummy; });
    if (atBottom) oc.scrollTop = oc.scrollHeight;
    return true;
  }
  if (v.name === 'vote') {
    const vf = s.querySelector('.vverify[data-sig]');
    return !!(vf && s.querySelector('#codeIn') && vf.dataset.sig === voteSig(v));
  }
  return false;
}
/* 投票ページの見た目が変わる要素。これが同じ間は作り直さない */
function voteSig(v) { return [v.card, v.perm, v.verify, v.code, !!v.stream, !!(choice && choice.app === 'vote')].join('|'); }
function nameField() { return `<label class="nameLab">${esc(UI.nameLabel)}<input id="nameIn" maxlength="8" autocomplete="off" placeholder="${esc(UI.namePh)}" value="${esc(st.name)}"></label><p class="nameNote">${esc(UI.nameNote)}</p>`; }
function renderS0() {
  const saved = loadProgress();
  if (view.step === 'real') return `<div class="view s0"><div class="inner"><div class="notes">${T.s0.realNotes.map(p => `<p>${esc(p)}</p>`).join('')}</div>${nameField()}<button class="btn go" data-act="start" data-arg="real">${esc(T.s0.start)}</button><button class="backs" data-act="s0back">${esc(UI.back)}</button></div></div>`;
  if (view.step === 'normal') return `<div class="view s0"><div class="inner"><div class="notes"><p>${esc(T.s0.normalNote)}</p></div>${nameField()}<button class="btn go" data-act="start" data-arg="normal">${esc(T.s0.start)}</button><button class="backs" data-act="s0back">${esc(UI.back)}</button></div></div>`;
  const ios = deviceKind() === 'iPhone' && !navigator.standalone;
  /* SafariのほかにChrome・LINE・Instagramなどのアプリ内ブラウザでも開かれる。Safari以外は「ホーム画面に追加」ができないので、まずSafariで開いてもらう */
  const notSafari = ios && /CriOS|FxiOS|EdgiOS|OPiOS|GSA\/|Line\/|Instagram|FBAN|FBAV|YJApp|Twitter/i.test(navigator.userAgent);
  const tipCss = 'font-size:13px;line-height:1.7;color:#9aa0ab;margin-top:6px';
  const tip = !ios ? '' : notSafari
    ? `<p style="${tipCss}">${esc(UI.iosOther)}</p><button data-act="copyUrl" style="margin-top:8px;padding:8px 16px;font-size:14px;color:#e6e8ec;background:transparent;border:1px solid #5a6170;border-radius:18px">${esc(UI.copyUrl)}</button>`
    : `<p style="${tipCss}">${esc(UI.iosFull)}</p>`;
  return `<div class="view s0"><div class="inner">${saved ? `<div class="resume"><span>${esc(UI.resume)}</span><button data-act="resume">${esc(UI.goOn)}</button></div>` : ''}<button class="mode" data-act="mode" data-arg="normal"><b>${esc(T.s0.normal.label)}</b><span>${esc(T.s0.normal.desc)}</span></button><button class="mode real" data-act="mode" data-arg="real"><b>${esc(T.s0.real.label)}</b><span>${esc(T.s0.real.desc)}</span></button>${tip}</div></div>`;
}
/* ---------- インスタグラフとRINEは、本物のアプリの画面の作りに寄せる（11/17 本人「めっちゃ似せて」）。ロゴは写さない ---------- */
const IC = {
  heart: '<svg viewBox="0 0 24 24"><path d="M12 20s-7.5-4.6-7.5-10.2A4.2 4.2 0 0 1 12 7.3a4.2 4.2 0 0 1 7.5 2.5C19.5 15.4 12 20 12 20z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/></svg>',
  plane: '<svg viewBox="0 0 24 24"><path d="M21.5 3 2.8 9.6l7.4 3 3 7.4z M10.2 12.6 21.5 3" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/></svg>',
  home: '<svg viewBox="0 0 24 24"><path d="M3.5 10.5 12 3.5l8.5 7V20.5h-5.5v-6h-6v6H3.5z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/></svg>',
  homeOn: '<svg viewBox="0 0 24 24"><path d="M3.5 10.5 12 3.5l8.5 7V20.5h-5.5v-6h-6v6H3.5z" fill="currentColor" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.8" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M15.6 15.6 21 21" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="17" height="17" rx="5" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M12 8v8M8 12h8" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
  reel: '<svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="17" height="17" rx="5" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M3.5 8.5h17M8.5 3.5l3 5M14 3.5l3 5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10.5 12v5l4.2-2.5z" fill="currentColor"/></svg>',
  bubble: '<svg viewBox="0 0 24 24"><path d="M20.3 16.4A8.5 8.5 0 1 0 17 19.6l4 1.2z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/></svg>',
  save: '<svg viewBox="0 0 24 24"><path d="M6 3.5h12v17l-6-5-6 5z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/></svg>',
  phone: '<svg viewBox="0 0 24 24"><path d="M6.6 3.6 9 3.2l2 4.8-2.2 1.5a11 11 0 0 0 5.7 5.7L16 13l4.8 2-.4 2.4c-.3 1.5-1.6 2.5-3.1 2.4C10.4 19.4 4.6 13.6 4.2 6.7 4.1 5.2 5.1 3.9 6.6 3.6z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  video: '<svg viewBox="0 0 24 24"><rect x="2.5" y="6" width="13" height="12" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m15.5 10.5 6-3.5v10l-6-3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  camera: '<svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="12" cy="13" r="3.5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
  image: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="9" cy="10" r="1.8" fill="currentColor"/><path d="m4 18 5-5 4 4 3-3 4 4" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
  mic: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="12" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  menu: '<svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
  plus2: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M15 4 7 12l8 8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.7" fill="currentColor"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/><circle cx="19" cy="12" r="1.7" fill="currentColor"/></svg>'
};
function igAv(th, size) { return avHTML(th, 'igav', size); }
/* ログインの確認（本物の通知を押したときの画面）と、ログインしている場所の一覧 */
function renderLoginCheck(v) {
  const lc = T.lc;
  const map = '<svg viewBox="0 0 300 120" class="lcmap"><rect width="300" height="120" fill="#e8eef2"/><path d="M0 80 C60 60 90 95 150 70 S250 40 300 55" stroke="#fff" stroke-width="10" fill="none"/><path d="M40 0 L70 120 M200 0 L180 120" stroke="#fff" stroke-width="6"/><circle cx="160" cy="62" r="22" fill="#0095f6" opacity=".18"/><circle cx="160" cy="62" r="7" fill="#0095f6"/></svg>';
  const head = `<div class="pad44"></div><div class="igChatHead"><button class="igIcon" data-act="back">${IC.back}</button><div class="igChatName"><b>${esc(v.lc === 'pw' ? lc.pwTitle : lc.title)}</b></div></div>`;
  let body;
  if (v.lc === 'pw') body = `<div class="lcbox"><p class="lcnote">${esc(lc.pwNote)}</p><label class="lclab">${esc(lc.pwLabel)}</label><div class="lcfld">••••••••••••</div><button class="btn igBlue" data-act="lcPw">${esc(lc.pwBtn)}</button></div>`;
  else body = `<div class="lcbox">${map}<div class="lcrow"><b>${esc(fill(lc.where))}</b><span>${esc(lc.device)}</span><span>${esc(lc.when)}</span></div><p class="lcq">${esc(lc.q)}</p><button class="btn igBlue" data-act="lcNo">${esc(lc.no)}</button><button class="btn sub" data-act="lcYes">${esc(lc.yes)}</button></div>`;
  return `<div class="view pico ig">${head}<div class="scroll">${body}</div>${homebar()}</div>`;
}
function renderSettings(v) {
  const row = (label, act, arg, right) => `<div class="setrow${act ? '' : ' dim'}"${act ? ` data-act="${act}"${arg ? ` data-arg="${arg}"` : ''}` : ''}><span>${esc(label)}</span><span>${esc(right || (act ? '›' : ''))}</span></div>`;
  let title, body;
  if (v.sett === 'top') { title = '設定とアクティビティ'; body = `<div class="igSearch">${IC.search}<span>検索</span></div><div class="igSetHead">あなたのアカウント</div>` + row('アカウントセンター', 'sett', 'ac', '') + `<div class="igSetNote">パスワード、セキュリティ、個人の情報</div><div class="igSetHead">Instagraphの使い方</div>` + row('保存済み') + row('アーカイブ') + row('通知') + row('プライバシー設定'); }
  else if (v.sett === 'ac') { title = 'アカウントセンター'; body = `<div class="igSetHead">アカウント設定</div>` + row('個人の情報') + row('パスワードとセキュリティ', 'sett', 'sec') + row('広告の設定'); }
  else if (v.sett === 'mails') {
    title = '最近のメール';
    const ms = mails.filter(m => m.revert || m.id === 'mr');
    body = `<div class="igSetNote" style="padding-top:14px">Instagraphから過去14日間に送ったメールです。届いたメールが本物か、ここで確かめられます。</div>` + (ms.length ? ms.map(m => `<div class="setrow dim"><span>${esc(m.subject)}</span><span>${esc(m.t)}</span></div>`).join('') : `<div class="igSetNote">メールはありません</div>`);
  } else {
    title = 'パスワードとセキュリティ';
    if (v.confirm) body = `<div class="confirm"><p>${esc(T.s4confirm)}</p><button class="btn igBlue" data-act="pwDo">${esc(T.s4confirmBtn)}</button><button class="btn sub" data-act="pwCancel">${esc(UI.back)}</button></div>`;
    else body = `<div class="igSetHead">ログインとリカバリー</div>` + row(UI.pwRow, 'pwRow') + row('2段階認証', null, null, 'オフ') + `<div class="igSetHead">セキュリティチェック</div>` + row(T.lc.whereTitle, 'loginWhere') + row('最近のメール', 'sett', 'mails') + (v.pwDone ? `<div class="sysline">${esc(UI.pwDone)}</div>` : '');
  }
  return `<div class="view pico ig"><div class="pad44"></div><div class="igChatHead"><button class="igIcon" data-act="back">${IC.back}</button><div class="igChatName"><b>${esc(title)}</b></div></div><div class="scroll">${body}</div>${homebar()}</div>`;
}
function renderLoginWhere() {
  const lc = T.lc;
  const mine = `<div class="lwrow"><span class="lwic">${IC.phone}</span><div class="mid"><b>${esc(fill('{スマホの種類}'))}</b><span class="on">${esc(lc.thisDevice)}・${esc(lc.active)}</span></div></div>`;
  const theirs = raceAction ? `<div class="lwrow" data-act="loginAlert"><span class="lwic"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 20h8M12 16v4" stroke="currentColor" stroke-width="1.8"/></svg></span><div class="mid"><b>${esc(lc.device)}</b><span>${esc(fill(lc.where))}・${esc(lc.when)}</span></div><span class="igIcon sm">${IC.more}</span></div>` : '';
  return `<div class="view pico ig"><div class="pad44"></div><div class="igChatHead"><button class="igIcon" data-act="back">${IC.back}</button><div class="igChatName"><b>${esc(lc.whereTitle)}</b></div></div><div class="scroll">${mine}${theirs}</div>${homebar()}</div>`;
}
/* 一覧の表示は「入力中…」ではなく、最後に届いた本物のメッセージで */
const lastReal = t => t.msgs.slice().reverse().find(x => !x.typing) || t.msgs[t.msgs.length - 1];
/* インスタの一覧は「今」「3分」のように、経った時間で出す */
function ago(m) {
  if (!m || !m.tm) return '';
  const [h, mi] = m.tm.split(':').map(Number); const now = new Date();
  let d = now.getHours() * 60 + now.getMinutes() - (h * 60 + mi); if (d < 0) d += 1440;
  return d < 1 ? '今' : d < 60 ? d + '分' : Math.floor(d / 60) + '時間';
}
function renderPico() {
  const v = view;
  if (st.picoLocked) {
    const sup = (support || []).map(x => x === 'id' ? `<div class="bb">${SVG.selfie}</div>` : x === 'submit' ? `<button class="btn pico" data-act="submitId">${esc(T.submit)}</button>` : `<div class="bb">${esc(x)}</div>`).join('');
    return `<div class="view pico ig"><div class="pad44"></div><div class="igTop"><span class="igLogo">Instagraph</span></div><div class="locked"><div class="big">${esc(T.s5locked)}</div><div class="fake"></div><div class="fake"></div><div class="support">${sup}</div></div>${homebar()}</div>`;
  }
  if (v.lc) return renderLoginCheck(v);
  if (v.where) return renderLoginWhere();
  if (v.sett) return renderSettings(v);
  if (v.th) {
    const t = thread('pico', v.th);
    /* 11/24 自分で打って送る場面では、見た目だけの欄の代わりに本物の入力欄を出す（本物のDMと同じく、打つと「送信」が出る） */
    const bar = composeHere('pico', v.th)
      ? `<div class="igInput igCompose${dmDraft ? ' has' : ''}"><span class="igCam">${IC.camera}</span><input id="dmIn" type="text" enterkeyhint="send" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" maxlength="200" placeholder="${esc(UI.dmPh)}" value="${esc(dmDraft)}"><span class="igIcon sm igIdle">${IC.mic}</span><span class="igIcon sm igIdle">${IC.image}</span><button class="igSend" data-act="dmSend" data-keepfocus="1">${esc(UI.send)}</button></div>`
      : `<div class="igInput${canReply('pico', v.th) ? ' can' : ' off'}" data-act="typeHint"><span class="igCam">${IC.camera}</span><span class="igPh">${esc(canReply('pico', v.th) ? T.canReply : T.cannotReply)}</span><span class="igIcon sm">${IC.mic}</span><span class="igIcon sm">${IC.image}</span></div>`;
    return `<div class="view pico ig"><div class="pad44"></div><div class="igChatHead"><button class="igIcon" data-act="back">${IC.back}</button>${igAv(v.th, 32)}<div class="igChatName"><b>${esc(t.name)}</b><span>Instagraph</span></div><span class="igIcon">${IC.phone}</span><span class="igIcon">${IC.video}</span></div><div class="chat">${t.msgs.map(m => msgHTML('pico', t, m)).join('')}${inlineHTML('pico', v.th)}</div>${bar}${homebar()}</div>`;
  }
  const tab = v.tab || 'feed';
  if (tab === 'dm') {
    const list = Object.values(threads.pico).filter(t => t.msgs.some(x => !x.typing)).sort((a, b) => b.t - a.t);
    const rows = list.map(t => {
      const last = lastReal(t); const ghost = last && last.ghost;
      const pv = last ? (last.unsent ? T.unsent : last.link ? 'リンクを送信しました' : last.img ? '写真を送信しました' : (last.me ? 'あなた: ' : '') + fill(last.text || '')) : '';
      return `<div class="igRow${t.unread ? ' unread' : ''}${ghost ? ' ghost' : ''}" data-act="th" data-arg="${t.th}">${igAv(t.th, 54)}<div class="mid"><div class="nm">${esc(t.name)}</div><div class="pv"><span class="txt">${esc(pv)}</span><span class="ago"> · ${esc(ago(last))}</span></div></div>${t.unread ? '<span class="igDot"></span>' : `<span class="igIcon sm dim">${IC.camera}</span>`}</div>`;
    }).join('');
    return `<div class="view pico ig"><div class="pad44"></div><div class="igChatHead"><button class="igIcon" data-act="ptab" data-arg="feed">${IC.back}</button><div class="igChatName"><b>${esc(myName())}</b></div><span class="igIcon">${IC.edit}</span></div><div class="scroll"><div class="igSearch">${IC.search}<span>検索</span></div><div class="igSub"><b>メッセージ</b><span>リクエスト</span></div>${rows}</div>${homebar()}</div>`;
  }
  let body = '';
  if (tab === 'set') {
    const prof = `<div class="igProf">${igAv('me', 80)}<div class="igNums"><div><b>${T.picoPosts.length}</b><span>投稿</span></div><div><b>54</b><span>フォロワー</span></div><div><b>61</b><span>フォロー中</span></div></div></div><div class="igBio"><b>${esc(myName())}</b></div>`;
    body = prof + `<div class="igGrid">${T.picoPosts.slice().reverse().map(p => SVG[p.img].replace('<svg ', '<svg preserveAspectRatio="xMidYMid slice" ')).join('')}</div>`;
  } else {
    const ppl = ['me', 'yuto', 'riko', 'kai', 'f3', 'f4', 'f5'];
    const stories = ppl.map((k, n) => `<div class="igStory${n === 0 ? ' mine' : ''}"><span class="ring">${igAv(k, 60)}</span><span class="nm">${esc(n === 0 ? 'ストーリーズ' : (PEOPLE[k] || ''))}</span></div>`).join('');
    const likes = [12, 31, 8, 17];
    const posts = T.picoPosts.slice().reverse().map((p, n) => `<div class="igPost"><div class="igPostHead">${igAv('me', 32)}<b>${esc(myName())}</b><span class="igIcon sm right">${IC.more}</span></div>${SVG[p.img].replace('<svg ', '<svg preserveAspectRatio="xMidYMid slice" ')}<div class="igActs"><span class="igIcon">${IC.heart}</span><span class="igIcon">${IC.bubble}</span><span class="igIcon">${IC.plane}</span><span class="igIcon right">${IC.save}</span></div><div class="igLikes">「いいね！」${likes[n % likes.length]}件</div><div class="igCap"><b>${esc(myName())}</b> ${esc(p.text)}${p.tag ? `<span class="igTag">${esc(p.tag)}</span>` : ''}</div>${p.comment ? `<div class="igCmtAll">コメント1件を見る</div><div class="igCap"><b>${esc(p.comment[0])}</b> ${esc(p.comment[1])}</div>` : ''}</div>`).join('');
    body = `<div class="igStories">${stories}</div>${posts}`;
  }
  const n = badge('pico');
  const nav = `<div class="igNav"><button class="igIcon" data-act="ptab" data-arg="feed">${tab === 'feed' ? IC.homeOn : IC.home}</button><span class="igIcon">${IC.search}</span><span class="igIcon">${IC.plus}</span><span class="igIcon">${IC.reel}</span><button class="igIcon me${tab === 'set' ? ' on' : ''}" data-act="ptab" data-arg="set">${igAv('me', 26)}</button></div>`;
  const top = tab === 'set'
    ? `<div class="igTop"><span class="igUser">${esc(myName())}</span><span class="igIcon right">${IC.plus}</span><button class="igIcon" data-act="sett" data-arg="top">${IC.menu}</button></div>`
    : `<div class="igTop"><span class="igLogo">Instagraph</span><span class="igIcon right">${IC.heart}</span><button class="igIcon dm" data-act="ptab" data-arg="dm">${IC.plane}${n ? `<span class="igBadge">${n}</span>` : ''}</button></div>`;
  return `<div class="view pico ig"><div class="pad44"></div>${top}<div class="scroll">${body}</div>${nav}${homebar()}</div>`;
}
function renderChatApp(app) {
  const v = view;
  if (app === 'kotori' && st.rineLost) return `<div class="view kotori rine"><div class="pad44"></div><div class="rineListHead"><b>トーク</b></div><div class="locked"><div class="big">${esc(T.rineLocked)}</div><div class="fake"></div><div class="fake"></div></div>${homebar()}</div>`;
  if (app === 'kotori') {
    if (v.th) {
      const t = thread(app, v.th);
      return `<div class="view kotori rine"><div class="pad44"></div><div class="rineHead"><button class="igIcon" data-act="back">${IC.back}</button><b>${esc(t.name)}</b><span class="igIcon">${IC.search}</span><span class="igIcon">${IC.phone}</span><span class="igIcon">${IC.menu}</span></div><div class="chat">${t.msgs.map(m => msgHTML(app, t, m)).join('')}${inlineHTML(app, v.th)}</div><div class="rineInput${canReply(app, v.th) ? ' can' : ' off'}" data-act="typeHint"><span class="igIcon sm">${IC.plus2}</span><span class="igIcon sm">${IC.camera}</span><span class="igIcon sm">${IC.image}</span><span class="rinePh">${esc(canReply(app, v.th) ? T.canReply : T.cannotReply)}</span><span class="igIcon sm">${IC.mic}</span></div>${homebar()}</div>`;
    }
    const list = Object.values(threads[app]).filter(t => t.msgs.length).sort((a, b) => b.t - a.t);
    const rows = list.map(t => { const last = lastReal(t); return `<div class="rineRow" data-act="th" data-arg="${t.th}">${igAv(t.th, 50)}<div class="mid"><div class="nm">${esc(t.name)}</div><div class="pv">${esc(last.img ? '写真を送信しました' : fill(last.text || ''))}</div></div><div class="rineSide"><span>${esc(last.tm || '')}</span>${t.unread ? `<span class="rineCount">${t.unread}</span>` : ''}</div></div>`; }).join('');
    return `<div class="view kotori rine"><div class="pad44"></div><div class="rineListHead"><b>トーク</b><span class="igIcon right">${IC.search}</span><span class="igIcon">${IC.edit}</span></div><div class="scroll">${rows}</div><div class="rineNav"><span>ホーム</span><span class="on">トーク</span><span>VOOM</span><span>ニュース</span><span>ウォレット</span></div>${homebar()}</div>`;
  }
  if (v.th) {
    const t = thread(app, v.th);
    return `<div class="view ${app}">${head(t.name, true)}<div class="chat">${t.msgs.map(m => msgHTML(app, t, m)).join('')}${inlineHTML(app, v.th)}</div>${homebar()}</div>`;
  }
  const list = Object.values(threads[app]).filter(t => t.msgs.length).sort((a, b) => b.t - a.t);
  return `<div class="view ${app}">${head(UI.apps[app], false)}<div class="scroll">${list.map(t => { const last = t.msgs[t.msgs.length - 1]; return `<div class="row${t.unread ? ' unread' : ''}" data-act="th" data-arg="${t.th}">${avHTML(t.th, 'av')}<div class="mid"><div class="nm">${esc(t.name)}</div><div class="pv">${esc(last.img ? '画像' : (last.me ? 'あなた：' : '') + fill(last.text || ''))}</div></div><span class="tm">${esc(last.tm || '')}</span></div>`; }).join('')}</div>${homebar()}</div>`;
}
function renderMail() {
  const v = view;
  if (st.mailLost) return `<div class="view">${head(UI.apps.mail, false)}<div class="locked"><div class="big">${esc(T.mailLocked)}</div><div class="fake"></div><div class="fake"></div></div>${homebar()}</div>`;
  if (v.id) {
    const m = mails.find(x => x.id === v.id);
    let acts = '';
    if (m.leak && !st.leakFixed && !leakAnswered) acts = `<div class="acts"><button class="btn pico" data-act="leakFix">${esc(T.leakMail.change)}</button><button class="btn sub" data-act="leakClose">${esc(T.leakMail.close)}</button></div>`;
    const extra = m.revert ? `<div class="acts"><button class="btn igBlue" data-act="revertOpen"${st.reverted ? ' disabled' : ''}>${esc(T.s5mail.btn)}</button></div>` : '';
    return `<div class="view">${head(UI.apps.mail, true)}<div class="mailbody"><div class="s">${esc(m.subject)}</div><div class="f">${esc(m.from)}${m.addr ? ` &lt;${esc(m.addr)}&gt;` : ''}</div><div class="b">${esc(m.body)}</div>${extra}${acts}</div>${homebar()}</div>`;
  }
  return `<div class="view">${head(UI.apps.mail, false)}<div class="scroll">${mails.slice().reverse().map(m => `<div class="mailrow${m.unread ? ' unread' : ''}" data-act="mailOpen" data-arg="${m.id}"><div class="f">${esc(m.from)}<span>${esc(m.t)}</span></div><div class="s">${esc(m.subject)}</div></div>`).join('')}</div>${homebar()}</div>`;
}
function renderCall() {
  const v = view;
  const subs = (v.subs || []).map(x => `<div class="sub${x.me ? ' me' : x.sys ? ' sys' : ''}">${x.who ? `<b>${esc(x.who)}</b>` : ''}${esc(fill(x.text))}</div>`).join('');
  let btns = '';
  if (v.ringing) btns = `<button class="rb ng" data-act="callNo"><i>✕</i>${esc(UI.decline)}</button><button class="rb ok" data-act="callYes"><i>✆</i>${esc(UI.answer)}</button>`;
  return `<div class="view call${pendingTrayOptions ? ' asking' : ''}"><div class="${v.ringing ? 'ringing' : ''}"><div class="who" style="margin-top:96px">${avHTML('mom', 'avatar')}${esc(v.who || '母')}</div><div class="st">${esc(v.status || '')}</div></div><div class="subs">${subs}</div><div class="btns">${btns}</div></div>`;
}
function renderVote() {
  const v = view;
  const cands = ['#ff8fb3', '#ffc06b', '#9fc3ff', '#b6e3a8'].map((c, i) => `<div class="vcand">${SVG.cand(c)}<div>エントリーNo.${i + 1}</div></div>`).join('');
  let modal = '';
  if (v.card) modal = `<div class="vmodal"><div class="vcard">${v.card === 'cam' ? `<div class="camslot">${v.stream ? '<video playsinline muted></video>' : (v.shot ? '' : SVG.faceDummy)}</div>` : ''}<p>${esc(T.vote[v.card])}</p>${v.stream ? '' : `<button class="btn" data-act="voteCard">${esc(UI.ok)}</button>`}</div></div>`;
  let perm = '';
  if (v.perm) perm = `<div class="vmodal" style="background:rgba(0,0,0,.2)"><div class="perm"><div class="ph">${esc(UI.voteHost)} ${esc(UI.permAsk)}</div><div class="pk">${esc(UI.permKind[v.perm])}</div><div class="pb"><button data-act="fakePerm" data-arg="0">${esc(UI.deny)}</button><button class="y" data-act="fakePerm" data-arg="1">${esc(UI.allow)}</button></div></div></div>`;
  /* 11/24 確認番号は自分で打つ（数字のキーボード）。SMSが届くまでは打てない */
  const can = !!(choice && choice.app === 'vote');
  const codeBox = v.code ? `<div class="fld">${esc(T.code2)}</div>`
    : `<div class="vcode"><input id="codeIn" class="fld${v.codeErr ? ' ng' : ''}" type="text" inputmode="numeric" pattern="[0-9]*" enterkeyhint="done" autocomplete="off" maxlength="10" value="${esc(codeDraft)}"${can ? '' : ' disabled'}><button class="vok" data-act="codeOk" data-keepfocus="1"${can ? '' : ' disabled'}>${esc(UI.codeOk)}</button></div><div class="verr">${v.codeErr ? esc(UI.codeWrong) : ''}</div>`;
  const verify = v.verify ? `<div class="vverify" data-sig="${esc(voteSig(v))}"><div class="h">${esc(T.vote.verify)}</div><label>${esc(UI.phoneLabel)}</label><div class="fld">●●●-●●●●-●●●●</div><label for="codeIn">${esc(UI.codeLabel)}</label>${codeBox}</div>` : '';
  return `<div class="view vote" style="position:absolute;inset:0"><div class="vbar"><span class="url">${esc(UI.voteHost)}</span><button class="x" data-act="voteX">✕</button></div><div class="scroll"><div class="vhead"><b>${esc(UI.voteTitle)}</b></div><div class="vgrid">${cands}</div>${verify}</div>${modal}${perm}${homebar()}</div>`;
}
const lockCards = [];

/* ---------- 下の板（選択・S8の行動） ---------- */
function trayPad() {
  const el = $('#tray'), scr = $('#screen');
  const on = el.classList.contains('on');
  document.documentElement.style.setProperty('--trayh', '0px');
  const sr = scr.getBoundingClientRect(), k = sr.height / (scr.offsetHeight || 1) || 1;
  const trayTop = on ? scr.offsetHeight - el.offsetHeight : scr.offsetHeight;
  ['.chat', '.scroll', '.locked'].forEach(sel => {
    const n = scr.querySelector(sel); if (!n) return;
    const b = (n.getBoundingClientRect().bottom - sr.top) / k;
    n.style.paddingBottom = (Math.max(0, b - trayTop) + 12) + 'px';
  });
  const ch = scr.querySelector('.chat'); if (ch && on) ch.scrollTop = ch.scrollHeight;
  if (voteView && view === voteView && voteView.verify && on) centerCodeField();
}
let trayFolded = null;   /* null＝その場に合わせる（返事できる会話ではたたむ） */
function renderTray() {
  setTimeout(trayPad, 0);
  const el = $('#tray');
  el.className = '';
  el.innerHTML = '';
  if (['s9', 'doc', 's0'].includes(view.name)) return;
  if (pendingTrayOptions) {
    el.className = 'on dark';
    const isActs = tray && view.name !== 'call' && !!pendingTrayOptions.isActs;
    if (isActs) {
      const folded = trayFolded != null ? trayFolded : canReply(view.name, view.th);
      if (folded) { el.innerHTML = `<button class="trayHandle" data-act="trayToggle">${esc(T.trayMore)}（${pendingTrayOptions.filter(o => !o.off).length}） ▲</button>`; return; }
      el.innerHTML = `<div class="goal">${esc(st.route === 'out' ? T.goal : T.goalMom)}</div><div class="grid2">${pendingTrayOptions.map((o, i) => `<button class="opt sm" data-act="trayPick" data-arg="${i}"${o.off ? ' disabled' : ''}>${esc(o.label)}</button>`).join('')}</div>${canReply(view.name, view.th) ? `<button class="trayHandle sub" data-act="trayToggle">${esc(T.trayFold)} ▼</button>` : ''}`;
      return;
    }
    const goal = '';
    /* 電話の途中で選ぶときは、相手が最後に言ったことを板の上にも出す（11/17 本人「選択肢でお母さんの言っていることが見えない」） */
    const said = view.name === 'call' ? (view.subs || []).filter(x => !x.me && !x.sys).slice(-1)[0] : null;
    const cv = document.querySelector('#screen .view.call'); if (cv) { cv.classList.add('asking'); const sb = cv.querySelector('.subs'); if (sb) sb.scrollTop = sb.scrollHeight; }
    el.innerHTML = goal + (said ? `<div class="q"><b>${esc(said.who || '')}</b>${esc(fill(said.text))}</div>` : '') + pendingTrayOptions.map((o, i) => `<button class="opt" data-act="trayPick" data-arg="${i}"${o.off ? ' disabled' : ''}>${esc(o.label)}</button>`).join('');
    return;
  }
  if (busy && view.name !== 'call') {
    el.className = 'on dark';
    el.innerHTML = `<div class="busy">${esc(busy.label)}…<div class="track"><div class="fill" style="width:${Math.min(100, (Date.now() - busy.start) / (busy.dur * 1000 / SPEED) * 100)}%"></div></div></div>`;
    return;
  }
  /* 自分で打つ場面（DMの入力欄・投票ページの番号の欄）は、下の板にボタンを出さない */
  if (choice && !choice.input && choice.app !== 'vote' && view.name === choice.app && view.th === choice.th) {
    el.className = 'on';
    el.innerHTML = choice.options.map((o, i) => `<button class="opt" data-act="choose" data-arg="${i}">${esc(o.label)}</button>`).join('');
  }
}

/* ---------- お知らせ ---------- */
/* 11/19 通知が次の通知に押し出されて0.5秒ほどで消えていた → 出てから最低3秒は残す。
   2枚出ていて、古いほうがまだ3秒たっていないときは、新しい通知を少し待たせる */
const banQueue = [];
let banQueueTm = null;
function banMinMs() { return TIMING.banMin * 1000 / SPEED; }
function flushBanQueue() {
  banQueueTm = null;
  while (banQueue.length) {
    const shown = [...document.querySelectorAll('#banners .ban:not(.out):not(.sticky)')];
    if (shown.length >= 2) {
      const oldest = shown[shown.length - 1];
      const age = Date.now() - (oldest._at || 0);
      if (age < banMinMs()) { banQueueTm = setTimeout(flushBanQueue, banMinMs() - age + 20); return; }
      dismiss(oldest);
    }
    const q = banQueue.shift();
    /* 犯人側の画面（S9）からあとは、待たせていた通知は出さない */
    if (['S9', 'S10', 'S11'].includes(st.scene)) continue;
    /* 待っているあいだに、その会話を開いていたら出さない */
    if (q.opts.open && view.name === q.opts.open.name && view.th && view.th === q.opts.open.th) continue;
    showBanner(q.app, q.title, q.text, q.opts);
  }
}
function banner(app, title, text, opts = {}) {
  /* ロック画面と、消えない通知（ログインの通知）は、待たせずにすぐ出す */
  if (opts.sticky || view.name === 'lock') return showBanner(app, title, text, opts);
  banQueue.push({ app, title, text, opts });
  if (!banQueueTm) flushBanQueue();
  return null;
}
function showBanner(app, title, text, opts = {}) {
  const tm = hm(new Date());
  lockCards.push({ app, text: title ? `${title}${text ? '　' + text : ''}` : text, tm, fresh: true });
  sound.notify(app);
  bgNotify(text);
  /* ロック画面のときは、上から降ろさず、暗い画面が光ってロック画面に積む */
  if (view.name === 'lock' && !opts.sticky) { wake(); render(); return null; }
  const box = document.createElement('div');
  box._at = Date.now();
  box.className = 'ban' + (opts.sticky ? ' sticky' : '');
  box.innerHTML = `<span class="ico">${ICON[app] || ''}</span><div class="mid"><div class="t"><span>${esc(UI.apps[app] || app)}</span><span>今</span></div>${title ? `<div class="h">${esc(title)}</div>` : ''}<div class="b">${esc(text)}</div>${opts.button ? `<button class="bt">${esc(opts.button)}</button>` : ''}</div>${opts.img && SVG[opts.img] ? `<span class="bimg">${SVG[opts.img]}</span>` : ''}`;
  /* 上にはらうと消える（11/17 本人「通知をどかせない・消せないのが嫌」） */
  let y0 = null, moved = false;
  const sStart = y => { y0 = y; moved = false; };
  const sMove = (y, e) => { if (y0 == null) return; const dy = y - y0; if (dy < -6) { moved = true; if (e && e.cancelable) e.preventDefault(); box.style.transition = 'none'; box.style.transform = `translateY(${dy}px)`; box.style.opacity = String(Math.max(0, 1 + dy / 120)); } };
  const sEnd = y => { if (y0 == null) return; const dy = y - y0; y0 = null; box.style.transition = ''; if (dy < -35) { dismiss(box); if (opts.onSwipe) opts.onSwipe(); } else { box.style.transform = ''; box.style.opacity = ''; } };
  box.addEventListener('touchstart', e => sStart(e.touches[0].clientY), { passive: true });
  box.addEventListener('touchmove', e => sMove(e.touches[0].clientY, e), { passive: false });
  box.addEventListener('touchend', e => sEnd(e.changedTouches[0].clientY));
  box.addEventListener('mousedown', e => { sStart(e.clientY); swipeNow = { move: sMove, end: sEnd }; });

  box.addEventListener('click', e => {
    if (moved) { moved = false; return; }
    if (opts.button && e.target.classList.contains('bt')) { opts.onButton && opts.onButton(); return; }
    if (view.name === 'call') { dismiss(box); return; }   /* 電話中は通知を押しても切り替えない */
    if (opts.onTap) { opts.onTap(); return; }
    if (opts.open) { gotoView(opts.open); }
    if (!opts.sticky) dismiss(box);
  });
  $('#banners').prepend(box);
  if (!opts.sticky) setTimeout(() => dismiss(box), (opts.hold || 7) * 1000);
  return box;
}
let swipeNow = null;
window.addEventListener('mousemove', e => { if (swipeNow) swipeNow.move(e.clientY); });
window.addEventListener('mouseup', e => { if (swipeNow) { swipeNow.end(e.clientY); swipeNow = null; } });
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
function hint(t, sec) { const el = $('#toast'); el.textContent = t; el.className = 'on hint'; clearTimeout(hint.tm); hint.tm = setTimeout(() => { el.className = ''; }, (sec || 6) * 1000); }
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
   みさき（乗っ取り犯が用意した文）・復旧代行は速い。母はゆっくり。友だちはふつう。同じ人が続けて送るときは短い。 */
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
  const th = step.th, app = st.rineLost && step.app === 'kotori' ? 'sms' : step.app;   /* RINEを取られたら、RINEの連絡はSMSで届く */
  if (step.when && !step.when(st)) return;
  const t = thread(app, th);
  /* 読ませる速さ：台本の間を1.6倍にし、字数に応じた最低の間をとる（11/17 本人「すごい速さで出てきて怖さがない」） */
  const len = String(step.text || '').length;
  const wait = step.noPace ? (step.wait || 0) : humanWait(th, step, len);
  /* 11/24 本人「入力中ってLINEもインスタも出ないよね」→ LINEとSMSには相手が打っている印は出ない。
     インスタのDMは、本物も相手が打っている間に3つの点が出るので、インスタだけ点で出す */
  if (wait > 0 && app !== 'pico') { await sleep(wait); if (step.when && !step.when(st)) return; }
  else if (wait > 0) {
    const ty = { typing: true };
    t.msgs.push(ty); if (view.name === app && view.th === th) render();
    await sleep(wait);
    t.msgs.splice(t.msgs.indexOf(ty), 1);
    /* 11/24 打っているあいだに条件が変わったら（例：その間にグループに書いた）、送らない */
    if (step.when && !step.when(st)) { if (view.name === app && view.th === th) render(); return; }
  }
  const m = { who: step.who, text: step.text, img: step.img, link: step.link, from: step.from };
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
  if (v.name === 'pico' && v.lc) { view = { name: 'pico', tab: 'dm' }; render(); return; }
  if (v.name === 'pico' && v.where) { view = { name: 'pico', sett: 'sec' }; render(); return; }
  if (v.name === 'pico' && v.sett) { view = v.sett === 'top' ? { name: 'pico', tab: 'set' } : { name: 'pico', sett: { ac: 'top', sec: 'ac', mails: 'sec' }[v.sett] }; render(); return; }
  if (v.th) { view = Object.assign({}, v, { th: null }); if (v.name === 'pico') view.tab = 'dm'; }
  else if (v.id) view = { name: 'mail' };
  else view = { name: 'home' };
  render();
}

/* ---------- 選択を待つ ---------- */
function ask(app, th, options, opts = {}) {
  return new Promise(resolve => {
    choice = { app, th, options, resolve, at: Date.now(), input: opts.input || null };
    render();
    let nudged = false, nudgedMore = 0;
    /* 11/24 自分で打って送ったら、催促は最初から数え直す（送った直後に「見てる？」が来ていた） */
    { const me = choice; me.nudgeReset = () => { me.at = Date.now(); nudged = false; nudgedMore = 0; }; }
    const tick = setInterval(() => {
      if (!choice || choice.options !== options) { clearInterval(tick); return; }
      const idle = (Date.now() - choice.at) / 1000 * SPEED;
      if (opts.nudge && !nudged && idle > TIMING.nudge) { nudged = true; deliver({ app, th, who: PEOPLE[th], text: T.nudge, wait: 0, noPace: true }); }
      /* 11/19 「見てる？」のあとも放っておくと、さらに催促が来る */
      if (opts.nudge && nudged && nudgedMore < TIMING.nudgeMore.length && idle > TIMING.nudgeMore[nudgedMore]) { const tx = T.nudgeMore[nudgedMore]; nudgedMore++; deliver({ app, th, who: PEOPLE[th], text: tx, wait: 0, noPace: true }); }
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
/* 11/24 打った文の数字を読み取れる形に（全角数字を半角に、空白とハイフンを取る） */
function normDigits(s) { return String(s || '').replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/[\s　\-‐‑–—−ー－]/g, ''); }
/* 11/24 質問や断りの文（これは「なんのコード？」と同じ流れにする） */
const ASK_OR_NO = /[?？]|なに|なんの|なんで|何|どういう|どゆこと|誰|だれ|コードって|いや|イヤ|嫌|無理|むり|ムリ|教えない|おしえない|やだ|やめ|怪し|あやし|届いてない|とどいてない|来てない|きてない|わから|分から|知らない|しらない|詐欺|さぎ|乗っ取/;
/* DMで打った文を送る。
   確認番号が入っていれば「番号を送る」、番号らしいが違えば聞き返されて待ち直し、
   質問や断りなら「なんのコード？」と同じ流れ、それ以外（「ちょっと待って」など）はみさきが短く返して待ち直す */
function sendDm() {
  const inp = document.getElementById('dmIn');
  const c = choice;
  if (!inp || !c || !c.input) return;
  const text = inp.value.replace(/[\u0000-\u001f]/g, '').trim();
  if (!text) return;
  inp.value = ''; dmDraft = '';
  const box = inp.closest('.igCompose'); if (box) box.classList.remove('has');
  const n = normDigits(text);
  if (n.indexOf(c.input.code) >= 0) { typedReply = text; choose(0); return; }
  const wrong = (n.match(/\d+/g) || []).some(r => r.length >= 4 && r.length <= 7);
  if (!wrong && ASK_OR_NO.test(text)) { typedReply = text; choose(1); return; }
  /* ここからは待ち直し：自分の吹き出しを出し、催促を数え直す */
  pushMsg(c.app, c.th, { me: true, text }); render();
  if (c.nudgeReset) c.nudgeReset();
  c.holds = (c.holds || 0) + (wrong ? 0 : 1);
  const reply = wrong ? c.input.retry : (T.s2wait[c.holds - 1] || null);
  /* 届ける直前に、まだこの入力を待っているか、そのあと自分がもう送っていないかを確かめる
     （すぐ後に正しい番号を送ったら聞き返しは出さない。続けて送ったら、最後の文への返しだけ出す） */
  const seq = c.sendSeq = (c.sendSeq || 0) + 1;
  if (reply) deliver({ app: c.app, th: c.th, who: PEOPLE[c.th], text: reply, wait: TIMING.s2Gap, when: () => choice === c && c.sendSeq === seq });
}
/* 投票ページの確認番号を決める。違えば欄の下に出して打ち直し */
function submitCode() {
  const inp = document.getElementById('codeIn');
  if (!inp || !(choice && choice.app === 'vote') || !voteView || view !== voteView) return;
  const d = normDigits(inp.value).replace(/\D/g, '');
  if (!d) return;
  if (d === T.code2) { codeDraft = ''; choose(0); return; }
  voteView.codeErr = true; inp.classList.add('ng');
  const er = document.querySelector('#screen .verr'); if (er) er.textContent = UI.codeWrong;
}

/* ---------- 進み具合（端末の中だけ） ---------- */
const KEY = 'nottori.progress';
function saveProgress() {
  try {
    const keepSt = {}; ['name', 'answeredS1', 'leakFixed', 'path2', 'path3', 'opened', 'route', 'sentCount', 'picoLocked', 'momSaved', 'momPaid', 'mailPw', 'applied', 'reverted', 'asked', 'mailLost', 'rineLost', 'groupUsed', 'strangerListened', 'strangerPaid', 'momRineSent', 'momRineRead', 'momRineAnswered', 'permAsked', 'permAllowed', 'permPre'].forEach(k => { keepSt[k] = st[k]; });
    keepSt.notified = [...st.notified]; keepSt.paid = [...st.paid];
    const th = {}; for (const app in threads) { th[app] = {}; for (const k in threads[app]) { const t = threads[app][k]; th[app][k] = { th: t.th, name: t.name, unread: t.unread, t: t.t, msgs: t.msgs.filter(m => !m.typing && !m.priv && !m.face) }; } }
    localStorage.setItem(KEY, JSON.stringify({ scene: st.scene, mode: st.mode, st: keepSt, threads: th, mails: mails.map(m => Object.assign({}, m)) }));
  } catch (e) {}
}
function restoreProgress(sv) {
  if (!sv || !sv.st) return;
  Object.assign(st, sv.st); st.notified = new Set(sv.st.notified || []); st.paid = new Set(sv.st.paid || []);
  for (const app in (sv.threads || {})) for (const k in sv.threads[app]) threads[app][k] = sv.threads[app][k];
  if (sv.mails) { mails.length = 0; sv.mails.forEach(m => mails.push(m)); }
}
function loadProgress() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
function eraseProgress() { try { localStorage.removeItem(KEY); } catch (e) {} }

/* ---------- 場面の進行 ---------- */
let leakAnswered = false;
let exploreDone = null;
async function runScene(name) {
  st.scene = name; if (['S9', 'S10', 'S11'].includes(name)) eraseProgress(); else saveProgress(); tlog('scene', name);
  /* 出来事と出来事のあいだに間をあける（何が起きたか確かめられるように） */
  if (['S3', 'S4', 'S4safe', 'S5', 'S6', 'S7', 'S8', 'END'].includes(name)) await sleep(3.5);
  if (QS.get('hold') === name) setTimeout(() => {
    FROZEN = true;
    /* 確かめ用：&peek=アプリ:タブ または アプリ:th:相手 で、止めた時点の画面を開く */
    const pk = (QS.get('peek') || '').split(':');
    if (pk[0]) { const b = $('#banners'); if (b) b.innerHTML = ''; view = pk[1] === 'th' ? { name: pk[0], th: pk[2] } : pk[1] === 'lc' ? { name: pk[0], lc: pk[2] } : pk[1] === 'where' ? { name: pk[0], where: true } : pk[1] === 'sett' ? { name: pk[0], sett: pk[2] } : pk[0] === 'mail' ? { name: 'mail', id: pk[1] } : pk[0] === 'protect' ? { name: 'protect' } : { name: pk[0], tab: pk[1] }; render(); }
  }, (Number(QS.get('holdAfter')) || 1) * 1000 / SPEED);
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
    case 'notify': banner(step.app, '', fill(step.text), { open: step.view || (step.th ? { name: step.app, th: step.th } : { name: step.app, tab: 'dm' }) }); return;
    case 'mail': await sleep(step.wait || 0); if (!st.leakFixed) { st.mailLost = true; banner('mail', '', T.mailLostBanner, {}); return; } mails.push({ id: 'm' + mails.length, from: step.mail.from, addr: step.mail.addr, subject: step.mail.subject, body: fill(step.mail.body), unread: true, t: hm(new Date()), revert: true, at: Date.now() }); banner('mail', step.mail.from, step.mail.subject, { open: { name: 'mail', id: 'm' + (mails.length - 1) } }); return;
    case 'set': Object.assign(st, step.v); return;
    case 'qr': {
      if (st.route !== 'out' || (step.when && !step.when(st))) return;
      const app = st.rineLost ? 'sms' : 'kotori', t = thread(app, step.th);
      if (step.th === 'group') { if (!st.groupUsed && !st.rineLost) t.inline = [{ label: T.qrGroup, f: () => groupPost() }]; }
      else if (!st.notified.has(step.k)) t.inline = [{ label: T.qrHijacked, f: () => replyHijacked(step.th, step.k, app) }];
      render(); return;
    }
    case 'open': view = Object.assign({}, step.view); render(); return;
    case 'goto': return { goto: step.to };
    case 'branch': return { goto: step.next(st) };
    case 'incoming': return incoming(step);
    case 'explore': return explore();
    case 'choice': {
      typedReply = null;
      const i = await ask(step.app, step.th, step.options, { nudge: step.nudge, input: step.input });
      const o = step.options[i];
      /* 自分で打った場面は、打った文をそのまま自分の吹き出しに（自動テストは o.me） */
      const meText = step.input && typedReply != null ? typedReply : o.me;
      typedReply = null;
      if (meText) { pushMsg(step.app, step.th, { me: true, text: meText }); render(); }
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
    if (!AUTO) setTimeout(() => { if (exploreDone) hint(T.hintS1, 6); }, 4000);
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
  view = { name: 'pico', sett: 'sec', confirm: false, fromLeak: true }; render();
}

/* S3：投票ページ */
let voteView = null;   /* 投票ページを離れても、戻れるように持っておく */
async function voteFlow() {
  st.opened = true;
  const vv = { name: 'vote', verify: false }; voteView = vv; view = vv;
  render();
  let away = null;
  const watch = setInterval(() => {
    if (view === vv) { away = null; return; }
    away = away || Date.now();
    if ((Date.now() - away) * SPEED / 1000 > 20 && !vv.closed) {
      vv.closed = true; clearInterval(watch);
      ['voteCard', 'fakePerm'].forEach(n => { if (actWaiters[n]) { const r = actWaiters[n]; delete actWaiters[n]; r(n === 'fakePerm' ? false : true); } });
      if (choice && choice.app === 'vote') { const c = choice; choice = null; c.resolve(1); }
    }
  }, 500);
  await sleep(1.2);
  for (const kind of ['loc', 'cam', 'notif']) {
    if (vv.closed) break;
    vv.card = kind; render();
    await waitAct('voteCard');
    if (vv.closed) break;
    vv.card = null; render();
    /* 11/24 振り返り（S11）で「許可を押したか」を出すため、出た許可と押した許可を数えておく */
    /* 11/24 確認の画面が出なかった許可（前から許可済み・前に拒否・対応していない）は、押したかどうかに数えない */
    let res;
    if (st.mode === 'real') res = await realPerm(kind);
    else { vv.perm = kind; render(); const ok = await waitAct('fakePerm'); vv.perm = null; if (kind === 'loc') st.locAllowed = false; render(); if (kind === 'cam' && ok) st.faceTaken = false; res = ok ? 'granted' : 'denied'; }
    if (res === 'granted' || res === 'denied') st.permAsked.push(kind);
    if (res === 'granted') st.permAllowed.push(kind);
    if (res === 'pre') st.permPre.push(kind);
  }
  if (!vv.closed) { vv.verify = true; render(); }
  let i = 1;
  if (!vv.closed) {
  await sleep(1.0);
  centerCodeField();
  pushMsg('sms', 'picosms', { who: 'インスタグラフ', text: T.sms2 });
  banner('sms', 'インスタグラフ', T.sms2, {});
  await sleep(0.6);
  tray = null;
  i = await new Promise(resolve => {
    /* 11/24 番号は欄に自分で打って「確認」（submitCode が choose(0)）。✕で閉じたまま20秒たつと「入れない」（choose(1) と同じ） */
    choice = { app: 'vote', th: undefined, options: [{ label: '「SMSの番号を入れる」' }, { label: '閉じる' }], resolve, at: Date.now() };
    codeDraft = ''; vv.codeErr = false;
    render();
    setTimeout(centerCodeField, 0);
    if (AUTO) { const p = PICKS.length ? PICKS.shift() : 0; setTimeout(() => choose(p), 300); }
  });
  }
  clearInterval(watch);
  if (i === 0 && !vv.closed) {
    st.path3 = true; vv.code = true; render();
    await sleep(1.2);
    vv.verify = false; vv.card = null; render();
    if (view === vv) { const sc = $('#screen .scroll'); sc.insertAdjacentHTML('afterbegin', `<div class="vverify" style="margin-top:14px"><div class="h">投票ありがとうございました</div></div>`); sc.scrollTop = 0; }
    await sleep(2);
  }
  voteView = null;
  if (view === vv) { view = { name: 'pico', th: 'misaki' }; render(); }
}
/* 11/19 確認番号の欄が下の板に隠れていた → 欄を、板より上の見えている所の真ん中に。
   11/24 キーボードが出ているときは、欄の説明（「投票には本人確認が必要です」）から見えるように、枠の上端を上に寄せる */
function centerCodeField() {
  if (!voteView || view !== voteView) return;
  const sc = document.querySelector('#screen .scroll'), flds = document.querySelectorAll('#screen .vverify .fld');
  let fld = flds[flds.length - 1]; if (!sc || !fld) return;
  if (document.body.classList.contains('kb')) fld = fld.closest('.vverify') || fld;
  const tr = $('#tray'), bar = document.querySelector('#screen .vbar');
  const sr = sc.getBoundingClientRect(), fr = fld.getBoundingClientRect();
  const top = bar ? Math.max(sr.top, bar.getBoundingClientRect().bottom) : sr.top;
  const bottom = tr.classList.contains('on') ? Math.min(sr.bottom, tr.getBoundingClientRect().top) : sr.bottom;
  const k = sr.height / (sc.offsetHeight || 1) || 1;   /* PCでは画面ごと縮めているので、その分を戻す */
  const want = sc.scrollTop + ((fr.top + fr.height / 2) - (top + bottom) / 2) / k;
  const max = sc.scrollHeight - sc.clientHeight;
  if (want > max) sc.style.paddingBottom = ((parseFloat(sc.style.paddingBottom) || 0) + want - max + 2) + 'px';   /* 真ん中まで動かせるだけの余白 */
  sc.scrollTop = want;
}
const actWaiters = {};
function waitAct(name) {
  return new Promise(resolve => {
    actWaiters[name] = resolve;
    if (AUTO) setTimeout(() => { if (actWaiters[name]) { const r = actWaiters[name]; delete actWaiters[name]; r(name === 'fakePerm' ? 1 : true); } }, 250);
  });
}
/* 11/24 求める前に、ブラウザが覚えている許可の状態を見る（2回目に遊ぶと画面が出ないのに「押した」になっていた）。
   返す値：'granted' 画面が出て許可した／'denied' 画面が出て断った／'pre' 前から許可済みで画面は出なかった／'none' 画面が出なかった（前に拒否・対応していない） */
async function permState(kind) {
  try {
    if (kind === 'notif' && 'Notification' in window && Notification.permission !== 'default') return Notification.permission;
    if (!navigator.permissions || !navigator.permissions.query) return 'unknown';
    const r = await navigator.permissions.query({ name: { loc: 'geolocation', cam: 'camera', notif: 'notifications' }[kind] });
    return r.state;
  } catch (e) { return 'unknown'; }
}
async function realPerm(kind) {
  const supported = kind === 'loc' ? !!navigator.geolocation : kind === 'cam' ? !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) : 'Notification' in window;
  if (!supported) return 'none';   /* iPhoneのSafariは、ホーム画面に追加しないと通知の許可の画面が出ない */
  const before = await permState(kind);
  if (before === 'denied') return 'none';
  const ok = await realPermAsk(kind);
  if (before === 'granted') return ok ? 'pre' : 'none';
  return ok ? 'granted' : 'denied';
}
async function realPermAsk(kind) {
  try {
    if (kind === 'loc' && navigator.geolocation) {
      const pos = await new Promise(res => {
        let done = false;
        navigator.geolocation.getCurrentPosition(p => { if (done) { st.locAllowed = true; st.lat = p.coords.latitude; st.lon = p.coords.longitude; st.station = nearestStation(st.lat, st.lon); return; } done = true; res(p); }, () => { if (!done) { done = true; res(null); } }, { enableHighAccuracy: false, timeout: 60000, maximumAge: 60000 });
        setTimeout(() => { if (!done) { done = true; res(null); } }, 60000);
      });
      if (pos) { st.locAllowed = true; st.lat = pos.coords.latitude; st.lon = pos.coords.longitude; st.station = nearestStation(st.lat, st.lon); }
      return !!pos;
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
      return !!stream;
    } else if (kind === 'notif' && 'Notification' in window) {
      const p = await Notification.requestPermission().catch(() => 'denied');
      st.notifAllowed = p === 'granted';
      return st.notifAllowed;
    }
  } catch (e) { tlog('perm', kind, e && e.message); }
  /* 11/24 許可したかを返す（振り返りの行に使う） */
  return false;
}

/* S4：40秒 */
async function race() {
  st.route = null;
  const far = fill('{遠い都道府県}');
  const momT = thread('pico', 'mom'); momT.name = '母';
  pushMsg('pico', 'mom', { me: true, ghost: true, text: T.s4toMom });
  setTimeout(() => { pushMsg('pico', 'mom', { me: true, ghost: true, text: T.s4toMom2 }); render(); }, 2500 / SPEED);
  let saved = false, sent = 0, done = false;
  const onPress = () => {
    if (done || st.route) return;
    dismiss(raceBanner);
    gotoView({ name: 'pico', lc: 'ask' });
  };
  raceAction = { press: onPress, text: T.s4notify.replace('{遠い都道府県}', far), save: () => { if (!done) { saved = true; done = true; } } };
  raceBanner = banner('pico', '新しいログイン', raceAction.text, { sticky: true, onTap: onPress });
  render();
  if (AUTO) { const p = PICKS.length ? PICKS.shift() : 0; if (p === 0) setTimeout(() => { onPress(); setTimeout(() => { view.lc = 'pw'; render(); setTimeout(() => raceAction && raceAction.save(), 200); }, 200); }, 3500 / SPEED * 4); }
  const t0 = Date.now(); let hinted = false;
  while (!done) {
    await sleep(0.25);
    if (!hinted && !AUTO && (Date.now() - t0) * SPEED / 1000 > 15 && !(view.name === 'pico' && view.lc)) { hinted = true; hint(T.hintS4, 7); }
    const el = (Date.now() - t0) * SPEED / 1000;
    const want = Math.min(TIMING.s4.friends, Math.max(0, Math.floor((el - TIMING.s4.grace) / TIMING.s4.interval) + 1));
    while (sent < want && !done) {
      const k = 'f' + sent; thread('pico', k).name = FRIENDS[sent];
      /* 本物と同じく、別の端末から送られたメッセージが、そのまま自分の送信として一覧に増えていく（自分の側に「入力中」は出ない） */
      pushMsg('pico', k, { me: true, ghost: true, text: T.s4toFriend });
      sent++; render();
      /* 少し間をあけて本題。止められたら届かない */
      setTimeout(() => { if (!saved) { pushMsg('pico', k, { me: true, ghost: true, text: T.s4toFriend2 }); st.asked = (st.asked || 0) + 1; render(); } }, (2 + Math.random() * 2) * 1000 / SPEED);
    }
    if (el >= TIMING.s4.lockout) done = true;
  }
  dismiss(raceBanner); raceBanner = null; raceAction = null;
  if (view.name === 'pico' && (view.lc || view.where)) view = { name: 'pico', tab: 'dm' };
  st.sentCount = sent;
  if (saved) {
    st.route = 'in';
    banner('pico', '', T.s4saved, {});
  } else {
    st.route = 'out'; st.sentCount = TIMING.s4.friends; st.picoLocked = true;
    if (st.path3 && !st.rineLost) { st.rineLost = true; setTimeout(() => banner('kotori', '', T.rineLostBanner, {}), 2500 / SPEED); }
    /* インスタグラフを見ているときだけ、その場で締め出される。ほかのアプリにいるときは通知で知る（11/17 本人「RINEを開いてるのにインスタのログアウトが出る」） */
    if (view.name === 'pico') { st.picoLocked = true; $('#overlay').className = 'on white'; $('#overlay').textContent = T.s4white; await sleep(3); $('#overlay').className = ''; $('#overlay').textContent = ''; }
    else banner('pico', '', T.s4white, { open: { name: 'pico' } });
    if (!AUTO) setTimeout(() => hint(st.rineLost ? T.hintOutRine : T.hintOut, 8), 1500);
  }
  render();
}

/* S6：みさきの3通（5秒で取り消し） */
async function misaki3() {
  const lines = st.opened ? T.s6opened.filter(l => !l.needStation || st.station) : [];   /* 店の写真を送り返すのはやめた（11/17） */
  if (!lines.length) return;
  const shown = [];
  for (const l of lines) {
    await sleep(TIMING.s6Gap * (0.25 + Math.random() * 0.45));
    const text = l.img ? '写真' : fill(l.text);
    if (st.picoLocked) banner('pico', 'みさき', text, { hold: TIMING.s6UnsendAfter, img: l.img });
    else { const m = { who: 'みさき', text: l.img ? '' : text, img: l.img, priv: !l.img && !T.s6photo.includes(l) }; pushMsg('pico', 'misaki', m); shown.push(m); if (!(view.name === 'pico' && view.th === 'misaki')) banner('pico', 'みさき', text, { open: { name: 'pico', th: 'misaki' }, hold: TIMING.s6UnsendAfter, img: l.img }); render(); }
  }
  await sleep(TIMING.s6UnsendAfter);
  shown.forEach(m => { m.unsent = true; });
  render();
  await sleep(1);
}

const doubt = new Set();   /* 犯人に先回りされて迷っている友だち */
let drawBarsNow = null;    /* S8の上の表示を描き直す */
function told() { if (drawBarsNow) drawBarsNow(); }
/* グループに書く（締め出された直後から、S8の板からも） */
function groupPost() {
  if (st.groupUsed || st.rineLost) return;
  st.groupUsed = true;
  const gt = thread('kotori', 'group'); gt.inline = null;
  const post = { me: true, text: T.groupPost, readN: 0 }; pushMsg('kotori', 'group', post); render();
  (async () => {
    /* 読むのは通知を切っていない人だけ（Ren と 葵 は切っている）。kai は犯人に先回りされている */
    const readers = [0, 1, 3, 5, 6, 2].filter(k => k < st.sentCount);
    for (const k of readers) {
      await sleep(1.2 + Math.random() * 2.2);
      if (['S9', 'S10', 'S11', 'END'].includes(st.scene)) return;
      post.readN++;
      const who = FRIENDS[k], from = 'f' + k;
      if (st.paid.has(k)) await deliver({ app: 'kotori', th: 'group', who, from, text: T.groupLate, wait: 1.2 });
      else if (k === 2 && !st.notified.has(k)) { doubt.add(k); await deliver({ app: 'kotori', th: 'group', who, from, text: T.groupDoubt, wait: 1.5 }); }
      else if (st.paid.has(k)) await deliver({ app: 'kotori', th: 'group', who, from, text: T.groupLate, wait: 1.2 });
      else if (going.has(k)) {
        /* コンビニへ向かっていた人は、ここで止まる */
        st.notified.add(k); { const ft = thread('kotori', friendTh(k)); if (ft.inline && ft.inline[0] && ft.inline[0].label === T.qrHijacked) ft.inline = null; }
        await deliver({ app: 'kotori', th: 'group', who, from, text: T.friendStopped[k % T.friendStopped.length], wait: 1.2 });
      }
      else { st.notified.add(k); if (T.groupOk[k] && Math.random() < 0.8) await deliver({ app: 'kotori', th: 'group', who, from, text: T.groupOk[k], wait: 1.2 }); }
      told(); render();
    }
  })();
}
/* 届いた連絡に返す：その友だちは、その場で守られる */
function replyHijacked(th, k, app = 'kotori') {
  const t = thread(app, th); t.inline = null;
  pushMsg(app, th, { me: true, text: T.qrHijacked.replace(/[「」]/g, '') }); render();
  const late = st.paid.has(k); if (!late) { st.notified.add(k); doubt.delete(k); told(); }
  deliver({ app, th, who: FRIENDS[k], text: late ? T.friendLate : going.has(k) ? T.friendStopped[k % T.friendStopped.length] : T.friendOk[k % T.friendOk.length], wait: 1.5 });
}
/* 11/19 コンビニへ向かっている友だちからの連絡（まだ買っていないので、返事をすれば止まる） */
const going = new Set();
function goingNotice(k) {
  if (st.notified.has(k) || st.paid.has(k)) return;
  const app = st.rineLost ? 'sms' : 'kotori';
  /* 11/24 SMSでも、S5の問い合わせと同じ会話に続ける（RINEを取られると会話が2つに分かれていた） */
  const th = friendTh(k); thread(app, th).name = FRIENDS[k];
  const text = k === 1 && rikoWary() ? T.rikoGoingWary : T.goingMsgs[k % T.goingMsgs.length];
  deliver({ app, th, who: FRIENDS[k], text: fill(text), wait: 0, noPace: true }).then(() => {
    if (['END', 'S9', 'S10', 'S11'].includes(st.scene) || st.paid.has(k) || st.notified.has(k)) return;
    const t = thread(app, th);
    t.inline = [{ label: T.qrHijacked, f: () => replyHijacked(th, k, app) }];
    render();
  });
}
/* 送ってしまった友だちからの連絡（相手はインスタグラフの頼みを本物だと思っている） */
const friendTh = k => ['yuto', 'riko', 'kai'][k] || 'f' + k;   /* RINEでもSMSでも、ゆうと・Riko・kai は前からの会話に続ける */
/* 11/24 その友だちから、S5で個人の問い合わせが届いていたか（RINEでもSMSでも） */
function askedInS5(th, text) { return ['kotori', 'sms'].some(a => threads[a][th] && threads[a][th].msgs.some(m => !m.me && m.text === text)); }
const rikoWary = () => askedInS5('riko', T.storyAsk2);
function paidNotice(k) {
  const app = st.rineLost ? 'sms' : 'kotori';
  const th = friendTh(k); thread(app, th).name = FRIENDS[k];
  const text = k === 1 && rikoWary() ? T.rikoPaidWary : T.paidMsgs[k % T.paidMsgs.length];
  deliver({ app, th, who: FRIENDS[k], text: fill(text), wait: 0, noPace: true }).then(() => {
    if (['END', 'S9', 'S10', 'S11'].includes(st.scene)) return;
    const t = thread(app, th);
    t.inline = [{ label: T.qrFake, f: () => { t.inline = null; pushMsg(app, th, { me: true, text: T.qrFake.replace(/[「」]/g, '') }); render(); deliver({ app, th, who: FRIENDS[k], text: T.fakeReply, wait: 1.5 }); } }];
    render();
  });
}
/* S8：取り戻す */
async function recover() {
  const out = st.route === 'out';
  const momLeft = { v: TIMING.lines.mom };
  const frLeft = { v: out ? TIMING.lines.friends : 0 };
  const receivers = []; for (let i = 0; i < st.sentCount; i++) receivers.push(i);
  let momDone = false;
  let s8clock = 0;   /* S8に入ってからの秒（タブが裏にいるあいだは進めない） */
  const goingAt = new Map();   /* 「向かってる」が届いたときの s8clock */
  let plan = null;   /* 買う間隔：{ r: 割り直したときの残り秒, n: そのときの残り人数 } */
  /* 11/24 本人「ゆうとの時系列がわけわからなくならない？」→ S5で「本人？」と疑って聞いてきたゆうとは、返事がなくても買いに行かない。
     「知らせた」には数えない（自分で気づいた人）。少したってから、買わないでおく、と個人のトークに来る */
  const selfSafe = new Set();
  /* 11/24 グループに先に書いて「本人？」が届かなかった流れでは、ゆうとは自分で疑ったわけではないので入れない */
  if (out && st.sentCount > 0 && !st.notified.has(0) && !st.paid.has(0) && askedInS5('yuto', T.yutoAsk)) {
    selfSafe.add(0);
    setTimeout(() => {
      if (['END', 'S9', 'S10', 'S11'].includes(st.scene) || st.notified.has(0)) return;
      /* S5の「本人？」と同じ会話に続ける（RINEを取られていればSMSの同じ会話） */
      const app = st.rineLost ? 'sms' : 'kotori', th = friendTh(0);
      thread(app, th).name = FRIENDS[0];
      deliver({ app, th, who: FRIENDS[0], text: T.yutoWary, wait: 0, noPace: true });
    }, TIMING.s8.yutoWaryAt * 1000 / SPEED);
  }
  const leftNow = () => receivers.filter(i => !st.notified.has(i) && !st.paid.has(i) && !selfSafe.has(i));
  /* 11/24 1人ずつ知らせるとき、自分で気づいて買わないゆうと（selfSafe）は最後に回す（先に選ぶと、その間にRikoが出かけてしまう） */
  const nextToTell = () => receivers.find(k => !st.notified.has(k) && !st.paid.has(k) && !selfSafe.has(k)) ?? receivers.find(k => !st.notified.has(k) && !st.paid.has(k));
  /* 11/24 本人のスクショ：母も友だちも片づいて、ボタンが全部押せない灰色のまま残り時間（最大150秒）を待たされていた。
     知らせる人が残っていなければ、時間を待たずに次へ進む */
  const friendsOver = () => !out || st.reverted || !leftNow().length;
  /* 11/19 本人「上にゲージが出るじゃん、あれいらないかも」→ 残り時間のバー・友だちの顔の列・凡例は画面に出さない。
     時間の数え方と、誰が買うかの決まりは今までどおり裏で動かす（drawBars は中身を作るだけで、#bars は表示しない） */
  $('#bars').className = '';
  const drawBars = () => {
    const bar = (lab, left, total, cls) => `<div class="bar ${cls}"><div class="lab"><span>${esc(lab)}</span><b>${Math.max(0, Math.ceil(left))}秒</b></div><div class="track"><div class="fill" style="width:${Math.max(0, left / total * 100)}%"></div></div></div>`;
    const frs = out ? `<div class="frs">${receivers.map(k => `<span class="fr ${st.paid.has(k) ? 'paid' : st.notified.has(k) ? 'ok' : doubt.has(k) ? 'doubt' : ''}">${avHTML('f' + k, 'frav')}<i>${esc(FRIENDS[k])}</i></span>`).join('')}</div>` : '';
    const legend = out ? `<div class="frleg"><span class="ok">知らせた</span><span class="doubt">迷っている</span><span class="paid">買ってしまった</span></div>` : '';
    $('#bars').innerHTML = bar(T.lineMom, momLeft.v, TIMING.lines.mom, st.momSaved ? 'saved' : '') + (out && !st.reverted ? bar(T.lineFriends, frLeft.v, TIMING.lines.friends, '') : '') + frs + legend;
  };
  drawBarsNow = drawBars;
  if (st.path3 && !st.rineLost) { st.rineLost = true; banner('kotori', '', T.rineLostBanner, {}); if (view.name === 'kotori') { view = { name: 'home' }; render(); } }
  const chat = st.rineLost ? 'sms' : 'kotori';   /* RINEを取られていたら、連絡はSMSと電話だけ */
  if (AUTO && QS.has('revert')) setTimeout(() => { st.reverted = true; st.picoLocked = false; tlog('reverted'); }, 4000 / SPEED);
  const acts = [{ id: 'mom', label: T.act.mom }];
  if (out && !st.rineLost) acts.push({ id: 'group', label: T.act.group, off: !!st.groupUsed }, { id: 'friend', label: T.act.friend });
  if (out && st.rineLost) acts.push({ id: 'fcall', label: T.fcall });
  if (!st.mailLost) acts.push({ id: 'mail', label: T.act.mail });
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
    if (view.name !== 'call' || momDone) return;
    if (momCalls === 1 && momStage === 0) {
      view.subs.push({ sys: true, text: T.noAnswer }); render();
      await sleep(TIMING.s8.sayHold);
      view = prev; render();
      momStage = 1;
      const i = st.rineLost ? 0 : await askTray([{ label: T.again }, { label: T.writeKotori }]);
      if (i === 1) { view = { name: 'kotori', th: 'mom' }; pushMsg('kotori', 'mom', { me: true, text: T.kotoriToMom }); st.momRineSent = true; render(); rineQuiz(); return; }
      return momConversation();
    }
    return momConversation(true);
  };
  let rineAsked = false, momTalked = false;
  /* RINEで母に知らせる：既読がついて、母が確かめてくる。そのあいだ、ほかの手も打てる */
  const rineQuiz = async () => {
    if (rineAsked) return; rineAsked = true;
    await sleep(10 + Math.random() * 8);
    /* 電話がつながったら、母はRINEで確かめるのをやめる。呼び出し中は待つ（11/17 本人「電話してるのに母からめっちゃラインきてんの変」） */
    const hold = async () => { while (view.name === 'call' && !momTalked && !momDone) await sleep(0.5); return st.momSaved || momDone || momTalked; };
    if (await hold()) return;
    for (const l of T.momRineAsk) { if (await hold()) return; await deliver({ app: 'kotori', th: 'mom', who: '母', text: l, wait: 1.5 }); st.momRineRead = true; }
    if (await hold()) return;
    const t = thread('kotori', 'mom');
    const answer = async k => {
      if (momDone) { t.inline = null; render(); return; }
      t.inline = null; st.momRineAnswered = true; pushMsg('kotori', 'mom', { me: true, text: T.momQuiz[k].replace(/[「」]/g, '') }); render();
      if (k === 0) {
        for (const l of T.momRineRight) await deliver({ app: 'kotori', th: 'mom', who: '母', text: l, wait: 2 });
        st.momSaved = true; momDone = true; drawBars();
      } else {
        await deliver({ app: 'kotori', th: 'mom', who: '母', text: T.momRineWrong, wait: 2 });
        momLeft.v -= TIMING.s8.orePenalty; drawBars();
      }
    };
    t.inline = T.momQuiz.map((label, k) => ({ label, f: () => answer(k) }));
    render();
    if (AUTO) setTimeout(() => { if (t.inline) answer(0); }, 400);
  };
  const momConversation = async (already) => {
    if (st.momSaved || momLeft.v <= 0) return;
    if (!already) { view = { name: 'call', who: '母', status: UI.calling, subs: [] }; render(); sound.dialOnce(); await sleep(TIMING.s8.ring * 0.5); if (momDone) return; }
    view = { name: 'call', who: '母', status: '通話中', subs: [] }; momTalked = true;
    { const mt = threads.kotori.mom; if (mt) mt.inline = null; }   /* 電話がつながったら、RINEの質問は電話で聞く */
    render();
    for (const line of T.momCall) { await sleep(TIMING.s8.sayHold); if (view.name !== 'call' || momDone) return; view.subs.push({ who: '母', text: line }); render(); }
    const opts = T.momQuiz.map(label => ({ label }));
    const i = await askTray(opts, true);
    if (i < 0 || view.name !== 'call') return;   /* 答える前に時間切れになったとき */
    view.subs.push({ me: true, text: T.momQuiz[i].replace(/[「」]/g, '') }); render();
    if (i === 0) {
      for (const l of T.momRight) { await sleep(TIMING.s8.sayHold); if (view.name !== 'call') break; view.subs.push({ who: '母', text: l }); render(); }
      st.momSaved = true; momDone = true; drawBars();
    } else {
      await sleep(TIMING.s8.sayHold); if (view.name === 'call') { view.subs.push({ who: '母', text: T.momWrong }); render(); }
      momLeft.v -= TIMING.s8.orePenalty; drawBars();
    }
    await sleep(TIMING.s8.sayHold);
    if (view.name === 'call') { view = st.rineLost ? { name: 'home' } : { name: 'kotori', th: 'mom' }; render(); }
  };
  let last = Date.now();
  /* 11/19 タブを裏にして戻ると、裏にいたあいだの分の通知と文が一度に届いていた → 裏にいるあいだはS8の時計を止める */
  const onVis = () => { last = Date.now(); };
  document.addEventListener('visibilitychange', onVis);
  const timer = setInterval(() => {
    const now = Date.now();
    /* 1回に進めるのは最大0.6秒ぶん（裏で止められていたページが戻ったときに、まとめて進めない） */
    const dt = FROZEN || document.hidden ? 0 : Math.min(now - last, 600) * SPEED / 1000; last = now;
    s8clock += dt;
    if (!st.momSaved && !momDone) { momLeft.v -= dt; if (momLeft.v <= 0) { st.momPaid = true; momDone = true; } }
    if (st.reverted && frLeft.v > 0) { receivers.forEach(k => { if (!st.paid.has(k)) st.notified.add(k); }); frLeft.v = 0; const ap = tray && tray.find(a => a.id === 'apply'); if (ap) ap.off = true; }
    if (st.momSaved && tray) { const mo = tray.find(a => a.id === 'mom'); if (mo && !mo.off) { mo.off = true; if (pendingTrayOptions && !busy) { const r = trayResolve; trayResolve = null; pendingTrayOptions = null; r && r(-2); } } }
    if (out && !st.reverted && (frLeft.v > 0 || leftNow().length)) {
      frLeft.v = Math.max(0, frLeft.v - dt);
      const left = leftNow();
      /* 11/19 知らせた人を数え直す：残り時間を、まだ知らせていない人数で割り直す（知らせるほど、残りの人が買うのは遅くなる） */
      if (!plan || plan.n !== left.length) plan = { r: frLeft.v, n: left.length };
      /* 残りの j 番目の人が買う予定（残り秒がこの値になったとき） */
      const at = j => plan.r * (plan.n - 1 - j) / plan.n;
      /* 買う予定の少し前に、コンビニへ向かう様子が届く（このあいだに知らせれば止まる） */
      left.forEach((k, j) => { if (!going.has(k) && frLeft.v <= at(j) + TIMING.s8.goLead) { going.add(k); goingAt.set(k, s8clock); goingNotice(k); } });
      /* 予定の時刻が来ても、「向かってる」から最低 goMin 秒たつまでは買わない */
      if (left.length && frLeft.v <= at(0)) {
        const k = left[0];
        if (!going.has(k)) { going.add(k); goingAt.set(k, s8clock); goingNotice(k); }
        else if (s8clock - goingAt.get(k) >= TIMING.s8.goMin) { st.paid.add(k); paidNotice(k); }
      }
    }
    refreshActs();
    if (!strangerShown && s8clock > TIMING.s8.strangerAt) { strangerShown = true; stranger(); }
    drawBars();
  }, 200);
  /* 11/19 知らせる人がいないのに「1人ずつ知らせる」が押せた → いないときは押せなくする */
  const refreshActs = () => {
    if (!tray) return;
    const any = out && !st.reverted && leftNow().length > 0;
    let changed = false;
    tray.forEach((a, i) => {
      if (a.id !== 'friend' && a.id !== 'fcall') return;
      if (!!a.off !== !any) { a.off = !any; changed = true; }
      if (pendingTrayOptions && pendingTrayOptions.isActs && pendingTrayOptions[i] && !!pendingTrayOptions[i].off !== !!a.off) { pendingTrayOptions[i].off = a.off; changed = true; }
    });
    if (changed) renderTray();
  };
  drawBars();
  const actLoop = (async () => {
    while (!(momDone && friendsOver())) {
      refreshActs();
      const actOpts = tray.map(a => ({ label: a.label, off: a.off })); actOpts.isActs = true;
      const i = await askTray(actOpts);
      if (i === -2) continue;
      if (i < 0) break;
      const a = tray[i]; tlog('act', a.id);
      if (a.id === 'mom') { if (!st.momSaved && momLeft.v > 0) await momCall(); }
      else if (a.id === 'fcall') {
        /* RINEを取られたので、電話で1人ずつ。1人15秒 */
        const next = receivers.find(k => going.has(k) && !st.notified.has(k) && !st.paid.has(k)) ?? nextToTell();
        if (next == null) { toast('もう知らせる人がいない'); continue; }
        st.notified.add(next); drawBars();
        await doBusy(FRIENDS[next] + 'に電話中', 15);   /* 「…」は板の側で足す */
        toast(FRIENDS[next] + T.fcallDone);
        told();
      }
      else if (a.id === 'group') {
        a.off = true;
        gotoView({ name: 'kotori', th: 'group' }); groupPost();
      }
      else if (a.id === 'friend') {
        const next = receivers.find(k => doubt.has(k) && !st.paid.has(k)) ?? receivers.find(k => going.has(k) && !st.notified.has(k) && !st.paid.has(k)) ?? nextToTell();
        if (next == null) { toast('もう知らせる人がいない'); continue; }
        st.notified.add(next);   /* 知らせ始めた時点で、この人は買わない */
        thread('kotori', friendTh(next)).name = FRIENDS[next]; gotoView({ name: 'kotori', th: friendTh(next) });
        pushMsg('kotori', friendTh(next), { me: true, text: T.friendMsg }); render();
        await doBusy(T.act.friend, TIMING.s8.notifyEach);
        const wasDoubt = doubt.has(next); doubt.delete(next);
        { const ft = thread('kotori', friendTh(next)); if (ft.inline && ft.inline[0] && ft.inline[0].label === T.qrHijacked) ft.inline = null; }
        deliver({ app: 'kotori', th: friendTh(next), who: FRIENDS[next], text: st.paid.has(next) ? T.friendLate : wasDoubt ? T.friendDoubtOk : going.has(next) ? T.friendStopped[next % T.friendStopped.length] : T.friendOk[next % T.friendOk.length], wait: 1.5 });
        drawBars();
        told();
      } else if (a.id === 'mail') { await doBusy(T.act.mail, TIMING.s8.mailPw); st.mailPw = true; a.off = true; }
      else if (a.id === 'apply') {
        a.off = true; support = []; gotoView({ name: 'pico' });
        await doBusy(T.act.apply, TIMING.s8.apply);
        support = [T.support[0], T.support[1], 'id', 'submit'];
        if (view.name !== 'pico') banner('pico', '', T.support[1], { open: { name: 'pico' } });
        if (AUTO) setTimeout(() => { support = [T.support[0], T.support[1], 'id', T.support[2]]; st.applied = true; }, 300);
        render();
      }
    }
  })();
  await new Promise(resolve => { const iv = setInterval(() => { if (momDone && friendsOver()) { clearInterval(iv); resolve(); } }, 300); });
  clearInterval(timer); drawBarsNow = null; document.removeEventListener('visibilitychange', onVis);
  if (trayResolve) pickTray(-1);   /* 出したままの選択肢も片づける */
  tray = null; busy = null;
  for (const app of ['kotori', 'sms']) for (const k in threads[app]) threads[app][k].inline = null;   /* 時間切れのあとは答えられない */

  $('#bars').className = ''; $('#bars').innerHTML = '';
  if (view.name === 'call') { view = st.rineLost ? { name: 'home' } : { name: 'kotori', th: 'mom' }; }
  render();
  await sleep(2);
}
let trayResolve = null;
function askTray(options, inCall) {
  return new Promise(resolve => {
    trayResolve = resolve;
    pendingTrayOptions = options;
    renderTray();
    if (AUTO && !(inCall && QS.has('callHold'))) { const p = PICKS.length ? PICKS.shift() : 0; setTimeout(() => pickTray(Math.min(p, options.length - 1)), 300); }  /* callHold は確かめ用：電話の選択肢で止める */
  });
}
let pendingTrayOptions = null;
function pickTray(i) { if (!trayResolve) return; const r = trayResolve; trayResolve = null; pendingTrayOptions = null; $('#tray').className = ''; $('#tray').innerHTML = ''; trayPad(); r(i); }
/* 払ってしまったとき：追加を求められ、払っても相手は消える */
async function strangerPay(app, t) {
  t.inline = null; st.strangerPaid = true;
  pushMsg(app, 'stranger', { me: true, text: T.strangerPayMe }); pushMsg(app, 'stranger', { me: true, img: 'idcard' }); render();
  await deliver({ app, th: 'stranger', who: UI.stranger, text: T.stranger3, wait: 2 });
  await deliver({ app, th: 'stranger', who: UI.stranger, text: T.stranger4, wait: 6 });
  if (['END', 'S9', 'S10', 'S11'].includes(st.scene)) return;
  t.inline = [{ label: T.strangerPay2, f: async () => { t.inline = null; pushMsg(app, 'stranger', { me: true, text: T.strangerPay2Me }); render(); await deliver({ app, th: 'stranger', who: UI.stranger, text: T.stranger5, wait: 2 }); await sleep(6); pushMsg(app, 'stranger', { sys: true, text: T.strangerGone }); render(); } }, { label: T.quit, f: () => { t.inline = null; pushMsg(app, 'stranger', { me: true, text: T.quit }); render(); } }];
  render();
}
async function stranger() {
  const app = st.rineLost ? 'sms' : 'kotori';
  if (app === 'kotori') pushMsg(app, 'stranger', { sys: true, text: 'このアカウントは友だちに追加されていません' });
  await deliver({ app, th: 'stranger', who: UI.stranger, text: T.stranger1, wait: TIMING.s8.strangerWait });
  const t = thread(app, 'stranger');
  t.inline = [{ label: T.ignore, f: () => { t.inline = null; render(); } }, { label: T.listen, f: async () => { st.strangerListened = true; t.inline = null; pushMsg(app, 'stranger', { me: true, text: T.listen }); render(); await deliver({ app, th: 'stranger', who: UI.stranger, text: T.stranger2, wait: 2 }); t.inline = [{ label: T.strangerPay, f: () => strangerPay(app, t) }, { label: T.quit, f: () => { t.inline = null; pushMsg(app, 'stranger', { me: true, text: T.quit }); render(); } }]; render(); } }];
  render();
}

/* 結末 */
async function ending() {
  const n = st.route === 'out' ? st.paid.size : Math.ceil((st.asked || 0) / 2);
  st.friendsPaid = n;
  if (st.route !== 'out') for (let k = 0; k < n; k++) { paidNotice(k); await sleep(1.2); }
  const capp = st.rineLost ? 'sms' : 'kotori';
  thread(capp, 'mom').name = '母';
  view = { name: capp, th: 'mom' };
  /* 11/24 RINEで「買わないで」と送ったのに母がまだ読んでいなかったときは、読んだと分かる文で（送った連絡を無視したように見えないように） */
  /* 母がRINEで確かめてきて、こちらが答えないうちに買ったときは、返事がなかったことに触れる */
  const endMom = st.momSaved ? T.endA : st.momRineSent && !st.momRineRead ? T.endBRine : st.momRineSent && !st.momRineAnswered ? T.endBRineNoReply : T.endB;
  await deliver({ app: capp, th: 'mom', who: '母', text: endMom, wait: TIMING.endingWait });
  const edge = $('#edge');
  edge.className = 'on';
  edge.innerHTML = `<span>${esc(fill(T.edge).replace('{n}', n))}</span><button id="edgeNext">›</button>`;
  await new Promise(r => { $('#edgeNext').onclick = r; setTimeout(r, TIMING.endingHold * 1000 / SPEED); });
  edge.className = ''; edge.innerHTML = '';
  if (st.applied && !st.reverted) {
    $('#overlay').className = 'on black'; $('#overlay').textContent = T.later; await sleep(2);
    $('#overlay').className = ''; $('#overlay').textContent = '';
    st.picoLocked = false;
    mails.push({ id: 'mr', from: 'インスタグラフ', subject: T.restored, body: T.restored, unread: true, t: '4日後' });
    view = { name: 'pico', tab: 'dm' }; render();
    await sleep(TIMING.laterHold);
  }
}

/* S9：向こうの画面 */
async function attacker() {
  /* 11/24 本人「よく意味が分からない情報だな。本当にこういう画面なの？」→ 作り物の表をやめ、犯人のスマホでインスタグラフの「アカウント切り替え」を開いた形にした。
     深夜の時刻・電池の残りわずか・知らない壁紙・大量の未読で「他人のスマホ」と分かるようにし、場面ごとに短い字幕を1つずつ出す（本人「文で書かないとわからない」） */
  tray = null; choice = null; renderTray();
  $('#overlay').className = 'on black'; $('#overlay').textContent = '';
  await sleep(TIMING.s9Dark);
  $('#overlay').className = '';
  const safe = st.route === 'safe', stopped = st.route === 'in' || !!st.reverted;
  const C = T.s9cap;
  /* 並ぶアカウント（知らない人。顔の写真は使わず、色の丸で写真の代わりにする） */
  const names = ['kenta.s', 'たくみ_07', 'yuu.k', 'さき', 'みさき', 'まなみ', 'hiro_t', 'りん', 'kazuya', 'あや', 'sora.m', 'しおり', 'tatsu', 'なな', 'ryota_22', 'ゆい', 'mei_k', 'daiki', 'はるか', 'shun', 'あおい', 'こうた', 'rina', 'つばさ', 'yuto.h', 'かな', 'sho', 'えみ', 'takeru', 'のぞみ'];
  const accounts = names.map((n, i) => ({ name: n, av: n === 'みさき' ? 'misaki' : null, hue: (i * 47) % 360, badge: i % 3 === 1 ? 0 : (i * 7) % 38 + 2, cur: i === 0 }));
  if (!safe) accounts.splice(13, 0, { name: myName(), av: 'me', badge: stopped ? 0 : 12, mine: true, out: stopped });
  const pickIdx = () => accounts.findIndex(a => safe ? a.av === 'misaki' : a.mine);
  view = { name: 's9', phase: 'home', clock: '3:12', accounts, openDet: true, next: false };
  render();
  const cap = async (text, last) => {
    view.cap = text; view.next = true; render();
    await new Promise(r => { actWaiters.s9next = r; if (!last) setTimeout(r, TIMING.s9CapAuto * 1000 / SPEED); if (AUTO) setTimeout(r, 400); });
    delete actWaiters.s9next; view.cap = null; view.next = false; render();
  };
  await sleep(1.2);
  await cap(C.phone);
  /* インスタグラフを開くと、アカウント切り替えの一覧が下から出る */
  view.tapApp = true; render(); await sleep(0.5);
  view.phase = 'list'; view.tapApp = false; render();
  await sleep(1.0);
  /* 一覧をゆっくり下へ。自分のアカウント（防げたときは、みさき）で止める */
  const sc = document.querySelector('#screen .s9sheet .scroll'), row = document.querySelectorAll('#screen .s9row')[pickIdx()];
  if (sc && row) {
    const want = Math.max(0, row.offsetTop - sc.clientHeight / 2 + row.offsetHeight / 2), from = sc.scrollTop, n = 30;
    for (let k = 1; k <= n; k++) { const t = k / n; const s2 = document.querySelector('#screen .s9sheet .scroll'); if (s2) s2.scrollTop = from + (want - from) * (1 - Math.pow(1 - t, 3)); await sleep(2.2 / n); }
  }
  view.pick = pickIdx(); render();
  await sleep(1.4);
  await cap(safe ? C.safe : stopped ? C.mineStop : C.mine);
  /* 取り戻せたときは、自分の行は入れないので、みさきに移る */
  if (stopped) { view.pick = accounts.findIndex(a => a.av === 'misaki'); render(); await sleep(1.2); }
  const acct = accounts[view.pick];
  view.tapRow = true; render(); await sleep(0.4);
  view.phase = 'switch'; view.as = acct; render(); await sleep(2.2);
  /* 切り替えたアカウントのDM一覧（見出しがそのアカウントの名前）に、知らない人あての送信が1人ずつ増える。
     11/24 初見役が個別の会話では「誰が送っているか分からない」と言ったので、一覧だけで見せる。各行は「久しぶり〜元気？」のあと「ごめん番号ミスって…」に変わる */
  const peers = (safe ? [{ name: 'Riko', av: 'riko' }] : []).concat(['haruto_k', 'mika.0815', 'りょう', 'yuna_s', 'こうへい', 'aki_n'].map((n, i) => ({ name: n, hue: (i * 83 + 20) % 360 })));
  view.phase = 'inbox'; view.inbox = []; render();
  for (let k = 0; k < 5; k++) {
    await sleep(0.9);
    const r = { p: peers[k], text: T.s9msgs[0] }; view.inbox.unshift(r); sound.tap(); render();
    await sleep(0.9); r.text = T.s9msgs[1]; render();
  }
  await sleep(0.8);
  await cap(safe ? C.usedSafe : stopped ? C.usedStop : C.used, true);
}
const S9CHEV = '<svg class="s9chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
/* S9 の画面（犯人のスマホ。インスタグラフは暗い表示にして、自分のスマホと見た目を変える） */
function s9Av(a, size) {
  if (a && a.av) return avHTML(a.av, 'igav', size);
  const h = a ? a.hue : 0;
  return `<span class="igav pic" style="width:${size}px;height:${size}px"><svg viewBox="0 0 40 40"><defs><linearGradient id="g${h}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h},55%,62%)"/><stop offset="1" stop-color="hsl(${(h + 50) % 360},50%,38%)"/></linearGradient></defs><rect width="40" height="40" fill="url(#g${h})"/><circle cx="${12 + h % 17}" cy="${14 + h % 11}" r="7" fill="rgba(255,255,255,.35)"/></svg></span>`;
}
function renderS9() {
  const v = view;
  const capBox = v.cap ? `<div class="s9cap"><span>${esc(v.cap)}</span><button class="nx on" data-act="s9next">›</button></div>` : '';
  let body = '';
  if (v.phase === 'home') {
    const ic = (k, label, n) => `<button class="app${k === 'pico' && v.tapApp ? ' s9tap' : ''}"><span class="ic">${ICON[k]}</span><span class="nm">${esc(label)}</span>${n ? `<span class="badge">${esc(n)}</span>` : ''}</button>`;
    body = `<div class="view home s9home"><div class="grid">${ic('pico', UI.apps.pico, '99+')}${ic('kotori', UI.apps.kotori, '99+')}${ic('mail', UI.apps.mail, '999+')}${ic('sms', UI.apps.sms, '214')}${ic('cam', 'カメラ')}${ic('photo', '写真')}${ic('clock', '時計')}${ic('set', '設定', '3')}</div><div class="dock">${ic('phone', UI.apps.phone, '27')}<span></span><span></span><span></span></div>${homebar(true)}</div>`;
  } else if (v.phase === 'list') {
    const cur = v.accounts.find(a => a.cur);
    const rows = v.accounts.map((a, i) => `<div class="s9row${a.out ? ' out' : ''}${v.pick === i ? ' pick' : ''}${v.pick === i && v.tapRow ? ' s9tap' : ''}">${s9Av(a, 44)}<div class="mid"><b>${esc(a.name)}${a.mine && v.pick === i ? `<span class="s9you">${esc(T.s9you)}</span>` : ''}</b>${a.out ? `<span>${esc(T.s9cannot)}</span>` : ''}</div>${a.badge ? `<span class="s9badge">${a.badge}</span>` : ''}${a.cur ? '<span class="s9check"></span>' : '<span class="s9radio"></span>'}</div>`).join('');
    body = `<div class="view s9ig"><div class="pad44"></div><div class="s9top"><b>${esc(cur.name)}${S9CHEV}</b><span class="igIcon">${IC.plus}</span><span class="igIcon s9dm">${IC.plane}<i>99+</i></span></div><div class="s9prof">${s9Av(cur, 76)}<div class="igNums"><div><b>0</b><span>投稿</span></div><div><b>3</b><span>フォロワー</span></div><div><b>1,204</b><span>フォロー中</span></div></div></div><div class="s9dim"></div><div class="s9sheet"><i class="grab"></i><div class="scroll">${rows}<div class="s9row add"><span class="plus">＋</span><div class="mid"><b>${esc(T.s9add)}</b></div></div></div></div></div>`;
  } else if (v.phase === 'switch') {
    body = `<div class="view s9ig s9switch"><div class="pad44"></div><div class="s9sw">${s9Av(v.as, 84)}<b>${esc(v.as.name)}</b><i class="spin"></i></div></div>`;
  } else {
    const rows = v.inbox.map((r, i) => `<div class="igRow${i === 0 ? ' s9new' : ''}">${s9Av(r.p, 54)}<div class="mid"><div class="nm">${esc(r.p.name)}</div><div class="pv"><span class="txt">${esc(r.text)}</span><span class="ago"> · 今</span></div></div></div>`).join('');
    body = `<div class="view s9ig"><div class="pad44"></div><div class="igChatHead"><span class="igIcon">${IC.back}</span><div class="igChatName"><b>${esc(v.as.name)}${S9CHEV}</b></div><span class="igIcon">${IC.edit}</span></div><div class="scroll"><div class="igSearch">${IC.search}<span>検索</span></div><div class="igSub"><b>メッセージ</b><span>リクエスト</span></div>${rows}</div>${homebar(true)}</div>`;
  }
  return body.replace(/<\/div>$/, capBox + '</div>');
}

/* S10：このゲームが読み取ったもの */
async function readout() {
  const od = st.openedAt ? new Date(st.openedAt) : new Date();
  const opened = [deviceKind(), od.getHours() + '時' + od.getMinutes() + '分'];
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
  const C = T.myCase, rows = [];
  rows.push(st.leakFixed ? C.leakYes : (st.route === 'out' && st.mailLost) ? C.leakNo : C.leakNoIn);
  rows.push(st.path2 ? C.codeYes : C.codeNo);
  if (!st.path2) rows.push(st.path3 ? C.voteYes : st.opened ? C.voteOpen : C.voteNo);   /* 番号を送った人には投票の誘いは来ていない */
  /* 11/24 審査で「本物の許可を押させる作りが心配」と言われた → 投票ページを開いた人には、許可を押したかの行を足す。
     押さなかった（拒否・閉じた）なら○、押したら✕。本番であとから位置が取れた・写真が撮れた分も、押したに数える */
  if (!st.path2 && st.opened) {
    const W = C.permWord, order = ['loc', 'cam', 'notif'];
    const names = ks => ks.map(k => W[k]).join('・');
    const pre = order.filter(k => (st.permPre || []).includes(k));
    const askedSet = new Set(st.permAsked || []);
    const allowed = new Set(st.permAllowed || []);
    /* 本番で、画面が出たあと遅れて位置が取れた・写真が撮れた分も押したに数える（前から許可済みのものは除く） */
    if (st.mode === 'real') { if (st.locAllowed && askedSet.has('loc')) allowed.add('loc'); if (st.faceTaken && askedSet.has('cam')) allowed.add('cam'); if (st.notifAllowed && askedSet.has('notif')) allowed.add('notif'); }
    const asked = order.filter(k => askedSet.has(k));
    const preNote = pre.length ? C.permPreNote.replace('{pre}', names(pre)) : '';
    if (allowed.size) {
      const al = order.filter(k => allowed.has(k));
      const what = al.filter(k => C.permWhat[k]).map(k => C.permWhat[k]);
      const gave = what.length ? C.permGave.replace('{what}', what.join('や')) : C.permGaveNotif;
      rows.push(C.permYes.map(x => x.replace('{allowed}', names(al)).replace('{note}', st.mode === 'real' ? C.permNoteReal : C.permNoteNormal).replace('{gave}', gave).replace('{preNote}', preNote)));
    } else if (pre.length) {
      const denied = asked.length ? C.permPreDenied.replace('{asked}', names(asked)) : '';
      rows.push(C.permPre.map(x => x.replace('{pre}', names(pre)).replace('{denied}', denied)));
    } else {
      /* 許可の画面が出る前に閉じた・画面が出なかったときは、位置情報とカメラで書く（通知は出ない端末があるので入れない） */
      const ak = asked.length ? asked : ['loc', 'cam'];
      rows.push(C.permNo.map(x => x.replace('{asked}', names(ak)).replace('{face}', ak.includes('cam') ? C.permNoFace : '')));
    }
  }
  if (st.route === 'in') rows.push(C.raceIn); else if (st.route === 'out') rows.push(C.raceOut);
  if (st.route === 'out' && st.reverted) rows.push(C.revert);
  if (st.route === 'out' && st.mailLost) rows.push(C.mailLost);
  if (st.route !== 'safe') rows.push(st.momSaved ? C.momYes : C.momNo);
  if (st.mailPw) rows.push(C.mailPw);
  if (st.route === 'in' && st.asked) { const p = st.friendsPaid || 0; rows.push(C.friendsIn.map(x => x.replace('{mark}', p ? '△' : '○').replace('{asked}', st.asked).replace('{paid}', p))); }
  if (st.route === 'out' && st.reverted) { const p = st.paid.size; rows.push(C.friendsRevert.map(x => x.replace('{mark}', p ? '△' : '○').replace('{paid}', p))); }
  else if (st.route === 'out') {
    const all = st.sentCount, paid = st.paid.size, ok = [...st.notified].filter(k => !st.paid.has(k)).length;
    const tip = st.rineLost ? C.tipNoRine : st.groupUsed ? C.tipGroup : C.tipNoGroup;
    rows.push(C.friends.map(x => x.replace('{mark}', paid === 0 ? '○' : paid <= 2 ? '△' : '✕').replace('{all}', all).replace('{ok}', ok).replace('{paid}', paid).replace('{tip}', tip)));
  }
  if (st.strangerPaid) rows.push(C.strangerPaid); else if (st.strangerListened) rows.push(C.stranger);
  const mine = `<h2 class="mycase">${esc(T.myCaseTitle)}</h2><div class="cases">${rows.map(r => `<div class="case m${r[0] === '○' ? 'o' : r[0] === '△' ? 't' : 'x'}"><b>${esc(r[0])}</b><div><p>${esc(r[1])}</p><span>${esc(r[2])}</span></div></div>`).join('')}</div>`;
  const html = `<div class="view doc" style="position:absolute;inset:0"><div class="scroll">${mine}<h1>${esc(T.s11title)}</h1>
    <ul>${T.s11main.map(x => `<li class="cur">${esc(x)}</li>`).join('')}</ul>
    <details><summary>${esc(UI.more)}</summary><ul>${T.s11more.map(x => `<li>${esc(x)}</li>`).join('')}</ul></details>
    <p style="font-size:11px;color:var(--sub);margin-top:18px">${esc(T.credit)}</p><button class="btn sub" data-act="erase">${esc(T.erase)}</button><button class="btn" data-act="again">${esc(T.again2)}</button></div></div>`;
  view = { name: 'doc', html }; render();
  tlog('END', JSON.stringify({ route: st.route, sent: st.sentCount, paid: st.friendsPaid, momSaved: st.momSaved, applied: st.applied, mailPw: st.mailPw, reverted: !!st.reverted, rineLost: !!st.rineLost, mailLost: !!st.mailLost, path2: st.path2, path3: st.path3, leakFixed: st.leakFixed }));
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
    case 'copyUrl': {
      const url = location.origin + location.pathname;
      const done = () => toast(UI.copied);
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, () => toast(url));
      else toast(url);
      break;
    }
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
    case 'pwRow': if (raceAction) { gotoView({ name: 'pico', lc: 'pw' }); break; } view.confirm = true; render(); break;
    case 'pwDo': view.confirm = false; view.pwDone = true; if (raceAction) raceAction.save(); if (!st.leakFixed && ['S1', 'S2', 'S3'].includes(st.scene)) { st.leakFixed = true; if (view.fromLeak) leakAnsweredThen(); } render(); break;
    case 'pwCancel': view.confirm = false; render(); break;
    case 'loginWhere': gotoView({ name: 'pico', where: true }); break;
    case 'sett': gotoView({ name: 'pico', sett: arg }); break;
    case 'submitId': if (support && support.includes('submit')) { support = [T.support[0], T.support[1], 'id', T.support[2]]; st.applied = true; render(); } break;
    case 'lcNo': view.lc = 'pw'; render(); break;
    case 'lcYes': view = { name: 'pico', tab: 'dm' }; render(); break;
    case 'lcPw': if (raceAction) raceAction.save(); view = { name: 'pico', tab: 'dm' }; render(); break;
    case 'revertOpen': if (!st.reverted) gotoView({ name: 'protect' }); break;
    case 'revertDo': { const rm = mails.find(m => m.revert); if (rm && (Date.now() - rm.at) * SPEED / 1000 > 120) { render(); break; } } st.reverted = true; st.picoLocked = false; tlog('reverted'); render(); break;
    case 'choose': choose(Number(arg)); break;
    case 'trayPick': pickTray(Number(arg)); break;
    case 'inline': { const t = threads[view.name] && threads[view.name][view.th]; if (t && t.inline && t.inline[arg]) t.inline[arg].f(); break; }
    case 'callYes': if (view.onPick) view.onPick(0); break;
    case 'callNo': if (view.onPick) view.onPick(1); break;
    case 'loginAlert': if (raceAction) raceAction.press(); break;
    case 'voteX': view = { name: 'home' }; render(); break;
    case 'openVote': if (voteView && !voteView.closed) { view = voteView; render(); } else if (choice && choice.app === 'pico' && choice.th === 'misaki' && choice.options[0] && choice.options[0].label === '開く') choose(0); else toast('このページは表示できません'); break;
    case 'typeHint': {
      /* 入力欄は見た目だけ。返事は選択肢のボタンから（11/17 本人の質問から） */
      const bt = document.querySelectorAll('#screen .inline button, #tray .opt');
      const mine = choice && choice.app === view.name && choice.th === view.th;
      if (bt.length || mine) { toast('返事は上のボタンから選べます'); bt.forEach(b => { b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash'); }); }
      else toast('今は返事を送れる場面ではありません');
      break;
    }
    case 'dmSend': sendDm(); break;
    case 'codeOk': submitCode(); break;
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
  if (el.dataset.act === 'trayToggle') { const cur = trayFolded != null ? trayFolded : canReply(view.name, view.th); trayFolded = !cur; renderTray(); }
}, true);

/* ---------- 自分で打つ欄（11/24） ---------- */
document.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'dmIn') { dmDraft = t.value; const box = t.closest('.igCompose'); if (box) box.classList.toggle('has', t.value.trim() !== ''); }
  else if (t.id === 'codeIn') codeDraft = t.value;
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;   /* 日本語の変換を決めるEnterでは送らない */
  if (e.target.id === 'dmIn') { e.preventDefault(); sendDm(); }
  else if (e.target.id === 'codeIn') { e.preventDefault(); submitCode(); }
});
/* 「送信」「確認」を押してもキーボードを閉じない（本物のチャットと同じ。閉じると画面が動いて押し損じる） */
document.addEventListener('mousedown', e => { if (e.target.closest && e.target.closest('[data-keepfocus]')) e.preventDefault(); });
/* キーボードが出たら、見えている高さ（visualViewport）に画面を合わせる。
   こうすると会話の下端がキーボードの上に来て、直前のみさきのメッセージや番号の欄の説明が隠れない */
let kbRaf = 0;
function kbFit() {
  kbRaf = 0;
  const vv = window.visualViewport, stg = $('#stage');
  const ae = document.activeElement;
  const typing = !!(ae && ae.tagName === 'INPUT' && ae.type !== 'checkbox');
  const kb = vv ? window.innerHeight - vv.height : 0;
  const on = !!vv && window.innerWidth <= 600 && typing && kb > 80;
  const was = document.body.classList.contains('kb');
  if (on) { stg.style.top = vv.offsetTop + 'px'; stg.style.height = vv.height + 'px'; stg.style.bottom = 'auto'; document.body.classList.add('kb'); }
  else if (was) { stg.style.top = ''; stg.style.height = ''; stg.style.bottom = ''; document.body.classList.remove('kb'); try { window.scrollTo(0, 0); } catch (e) {} }
  if (on || was) {
    trayPad();
    const ch = document.querySelector('#screen .chat'); if (ch) ch.scrollTop = ch.scrollHeight;
    centerCodeField();
  }
}
function kbLater() { if (!kbRaf) kbRaf = requestAnimationFrame(kbFit); }
if (window.visualViewport) { visualViewport.addEventListener('resize', kbLater); visualViewport.addEventListener('scroll', kbLater); }
document.addEventListener('focusin', kbLater);
document.addEventListener('focusout', () => setTimeout(kbLater, 60));

/* ---------- 始める ---------- */
let wantResume = false;
async function begin(mode) {
  st.mode = mode; audioInit(); if (!st.openedAt) st.openedAt = Date.now();
  /* Android・PCは「始める」を押したときに画面いっぱいにする（iPhoneのSafariはできないので、ホーム画面に追加してもらう） */
  try { const el = document.documentElement; if (!AUTO && el.requestFullscreen && window.innerWidth <= 600) el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {}); } catch (e) {}
  const saved = loadProgress();
  /* 続きからは「続きから」を押したときだけ。ふつうに選んだら最初から（11/17 最初の母の電話が飛ばされたため） */
  const startScene = wantResume && saved && saved.scene && SCENES[saved.scene] && !['S0', 'S1'].includes(saved.scene) ? saved.scene : 'S1';
  if (startScene === 'S1') eraseProgress();
  if (startScene !== 'S1') {
    restoreProgress(saved);
    view = { name: 'home' }; render();
    /* 11/19 投票ページを見ていないルートでは「投票サイト」の名前を出さない */
    banner('pico', st.opened ? T.welcomeApp : '', T.welcome, {});
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
try { history.pushState({ g: 1 }, ''); } catch (e) {}
window.addEventListener('popstate', () => { if (view.name === 's0') return; try { history.pushState({ g: 1 }, ''); } catch (e) {} if (!['s0', 'doc', 's9', 'call', 'lock', 'home'].includes(view.name)) goBack(); });
if (navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches)) document.body.classList.add('standalone');
if (QS.get('s0') === 'real') view = { name: 's0', step: 'real' };
render();
if (AUTO) eraseProgress();
if (AUTO && QS.get('name')) st.name = QS.get('name').slice(0, 8);
if (AUTO) setTimeout(() => begin(QS.get('mode') === 'real' ? 'real' : 'normal'), 300);
