'use strict';
/* =========================================================
   場面データ（台本 第5稿 = 21_台本_第5稿.md をそのまま表にしたもの）
   - 文言は台本から一字も変えない。台本にない画面の部品の文字（ボタンの「OK」など）は UI に分けて置く。
   - wait は「（間：秒）」＝その行が届くまでの秒数。
   - 秒数はすべて TIMING に集めた。台本に数字がないものは「仮」と書いた。
   ========================================================= */

const TIMING = {
  s1CallAfter: 4,        /* S1「少しして」着信（台本に秒なし・仮） */
  s1RingMax: 25,         /* 出ないまま鳴りやむまで（仮） */
  s1ExploreMax: 25,     /* 11/17 本人「ミサキから連絡が来るまでがちょい遅い」60→25秒（電話を切ってから数える） */
  s1AfterMail: 8,        /* 流出メールの選択がすんでから S2 まで（仮） */
  nudge: 30,             /* 付録：返事を待つ場面で放っておくと（30秒） */
  s2Gap: 2,              /* ソウタが送ってから相手が返すまで（仮） */
  s4: { interval: 6, friends: 8, lockout: 60, grace: 6 },   /* 11/17 本人「何が起きているか確認できる猶予を」で 4→6秒・40→60秒 */   /* S4 40秒・4秒に1人・友だち8人 */
  s4safeAgain: 10,       /* S4safe 10秒後、もう一度 */
  s6Gap: 4,              /* S6 ミサキの3通の間（仮） */
  s6UnsendAfter: 8,      /* S6 5秒で「送信を取り消しました」 */
  lines: { mom: 150, friends: 150 },   /* 11/17 90→150秒 */               /* S7 2本の線 */
  s8: {
    ring: 10,            /* 母に電話する（呼び出し10秒） */
    callback: 20,        /* 20秒後に母から折り返し */
    orePenalty: 30,      /* 「俺だよ」→（30秒すすむ） */
    notifyEach: 8,       /* 友だちに知らせる 1人8秒 */
    speedUpAfter: 2,     /* 2人目に知らせたところで、送る間隔が短くなる */
    speedUpRate: 2,      /* 短くなったあとの減り方（2倍・仮） */
    mailPw: 10,          /* メールのパスワードを変える（10秒） */
    apply: 15,           /* インスタグラフのアプリから申し込む（15秒） */
    strangerAt: 12,      /* S8の途中で知らない人から（S8に入ってからの秒・仮） */
    strangerWait: 3,     /* （3） */
    sayHold: 3           /* 通話の字幕1行を読む時間（仮） */
  },
  endingWait: 4,         /* 結末の（4） */
  endingHold: 9,         /* 結末を見せておく時間（仮） */
  laterHold: 10,         /* 「4日後」を見せておく時間（仮） */
  s9Dark: 1.5,           /* 一拍、真っ暗（仮） */
  s9AutoOpen: 12,        /* ソウタの行を開かないとき、自動で開くまで（仮） */
  s9LastLine: 4          /* 行を開いてから最後の1行が足されるまで（仮） */
};

/* 人の名前（ほか友だち5人の名前は台本にないので仮） */
const FRIENDS = ['ユウト', 'リコ', 'カイ', 'ハルカ', 'レン', 'ミオ', 'ダイチ', 'アオイ'];

/* ---------- 台本の文言 ---------- */
const T = {
  s0: {
    normal: { label: '体験版', desc: '位置情報やカメラは使いません。許可の画面は絵で出ます。' },
    real: { label: '本番', desc: 'あなたのスマホの、本物の位置情報・カメラ・通知を使います。' },
    realNotes: [
      '音が出ます。8分ほどかかります。途中でやめずに遊んでください。',
      '途中で、偽の投票ページが出てきます。そこで出る許可の画面（位置情報・カメラ・通知）は本物です。押すと、このゲームが本当にあなたの位置とカメラを使います。どれも断れます。',
      'あなたの情報は外に送りません。',
      'ここで見る手口（「番号を教えて」など）を、本物の友だちに試すのはやめてください。いたずらでも、本当に乗っ取りになります。'
    ],
    normalNote: '許可の画面は、本物の代わりに絵で見せます。',
    start: '始める'
  },

  /* S1 */
  picoPosts: [
    { img: 'desk', text: '課題おわらん' },
    { img: 'shop', text: '実家帰ってた' },
    { img: 'nabe', text: 'サークルの鍋', tag: 'ユウト・リコ' }
  ],
  leakMail: {
    from: 'ゲームサイト',
    subject: '【お詫び】会員情報流出のお知らせ',
    body: '2023年にお預かりしていたメールアドレスとパスワードが流出しました。同じパスワードをほかのサービスでお使いの場合は、変更してください',
    change: 'インスタグラフのパスワードも変える',
    close: '閉じる'
  },
  sms1: '【インスタグラフ】パスワード再設定の確認番号 482913　他の人に教えないでください',
  sms2: '【インスタグラフ】パスワード再設定の確認番号 739104　他の人に教えないでください',
  code1: '482913',
  code2: '739104',

  vote: {
    loc: '近くの会場を表示します',
    cam: '顔で本人確認します',
    notif: '結果をお知らせします',
    verify: '投票には本人確認が必要です'
  },

  /* S4 */
  s4notify: '新しい端末からログインがありました（{遠い都道府県}）',
  s4button: '心当たりがない',
  s4toMom: 'お母さん、ちょっとお願い。RINEの調子悪くて、こっちから送ってる。電話も今出られない',
  s4toFriend: 'ごめん急ぎで、コンビニでギフトカード買って番号送ってくれない？明日返す',
  s4confirm: 'パスワードを変更しますか',
  s4confirmBtn: '変更する',
  s4saved: 'パスワードを変更しました。ほかの端末はログアウトされました',
  s4white: 'パスワードが変更されました。ログインし直してください',

  /* S5 */
  s5locked: 'ログインできません。',
  s5mail: {
    from: 'インスタグラフ',
    subject: '登録メールアドレスが変更されました',
    body: '登録メールアドレスが変更されました。心当たりがない場合は…',
    note: '（このゲームでは）メールのリンクではなく、インスタグラフのアプリから手続きします'
  },

  /* S6 */
  s6opened: [
    { text: '{駅名}駅の近くなんだ', needStation: true },
    { text: '{スマホの種類}から見てるんだね' },
    { text: 'もう{時刻}だよ、{時刻の一言}' }
  ],
  /* 乗っ取った人が、アカウントの中の写真を見たことを見せる（11/17 本人「乗っ取りのあとでクリーニングの話になるのが分からない」） */
  s6photo: [
    { img: 'shop', text: '' },
    { text: '「実家帰ってた」の写真、見たよ' },
    { text: 'お母さん、フジミヤクリーニングなんだね' }
  ],
  unsent: '送信を取り消しました',

  /* S7・S8 */
  lineMom: '母がコンビニに着くまで',
  lineFriends: 'まだ返事をしていない友だちが送ってしまうまで',
  act: {
    mom: '母に電話する',
    friend: '友だちに知らせる',
    mail: 'メールのパスワードを変える',
    apply: 'インスタグラフのアプリから申し込む'
  },
  noAnswer: 'ただいま電話に出ることができません',
  again: 'もう一度かける',
  writeKotori: 'RINEで書く',
  kotoriToMom: 'インスタグラフ乗っ取られた、買わないで',
  /* 11/17 本人「乗っ取られたと言う／おばあちゃんの手紙、が意味わからん」→ 母が本人しか知らないことを聞く形に */
  momCall: [
    '{名前}？　インスタグラフの{名前}が、「俺のふりして電話してくる人がいるから出ないで」って言ってたよ',
    '声も今は真似できるってテレビで言ってたし…',
    '本当に{名前}なら、きのう送った箱に何が入ってたか言って'
  ],
  momQuiz: ['「みかん」', '「お米」', '「わからない」'],
  momRight: ['……{名前}だ。', 'じゃあ、インスタグラフのほうが偽物なんだね。今レジの前。やめとく'],
  momWrong: '……やっぱりおかしい。切るね',
  /* RINEで知らせたとき：少しして既読がつき、母がRINEで確かめてくる（11/17 本人「何言ってもコンビニ行っちゃうの？」） */
  momRineAsk: ['え、ほんと？', 'さっきインスタグラフのほうから、電話出られないって来たけど', '本当に{名前}なら、きのう送った箱に何が入ってた？'],
  momRineRight: ['……わかった。買わないでおく', '怖いね。気をつけてね'],
  momRineWrong: 'どっちが本物なの……とりあえず、行ってくる',
  support: [
    'お問い合わせを受け付けました',
    '本人確認のため、身分証の画像をこの画面から提出してください',
    '確認には3〜5日かかります'
  ],
  submit: '提出する',
  kotoriLogin: '新しい端末からログインがありました',
  stranger1: 'インスタグラフのアカウント、今日中に取り戻します。復旧代行です',
  stranger2: '先払い5,000円と、身分証の写真をお願いします',
  ignore: '無視',
  listen: '話を聞く',
  quit: 'やめる',

  /* 結末 */
  endA: 'コンビニの人にも、詐欺かもって言われた',
  endB: '番号送ったよ。あとで電話してね',
  edge: '{名前}だと思って、カードの番号を送った友だち {n}人',
  later: '4日後',
  restored: 'アカウントを元に戻しました。',

  /* S9 */
  s9cols: ['アカウント', '入った道', '状態'],
  path1: '流出したパスワードの使い回し',
  path2: '確認番号を本人から入手',
  path3: '投票ページで確認番号を入力',
  twoStep: '2段階認証：なし',
  failed3: 'ログイン失敗 3回',
  friends54: '友だち 54人',
  lastIn: '{名前} → 知らない人：久しぶり〜元気？　ごめん番号ミスってそっちにコード行っちゃった',
  lastSafe: 'ミサキ → リコ：久しぶり〜元気？　ごめん番号ミスってそっちにコード行っちゃった',

  /* S10 */
  s10title: 'このゲームが読み取ったもの',
  s10opened: '開いただけで分かったもの：',
  s10allowed: '許可したもの：',
  s10face: '顔の写真',
  s10sent: 'どれも、このスマホの外に送っていません。',
  s10deleted: '写真は、今消しました。',
  s10howto: '許可を外すには：',
  s10iphone: 'iPhone（Safari）：設定 → アプリ → Safari → 位置情報・カメラ',
  s10android: 'Android（Chrome）：URL欄の左のマーク → 権限 → オフ',
  s10pc: 'パソコン：URL欄の左のマーク → このサイトの設定 → オフ',
  next: '次へ',

  /* S11 */
  s11title: '本当に起きたら',
  s11main: [
    '友だちに頼まれても、確認番号は渡さない。',
    'パスワードを使い回さない。',
    '乗っ取られたら、まず電話で家族と友だちに知らせる。'
  ],
  s11more: [
    '手続きはアプリの中の窓口から。「復旧代行」には頼まない。',
    '顔や指紋でログインする設定（パスキー）にしておくと、番号をだまし取られても入られにくい。',
    '家族とは、本人しか知らないことで確かめ合う。',
    '困ったら 警察相談専用電話 #9110'
  ],
  credit: '駅の位置：国土数値情報（鉄道データ）国土交通省 を加工して作成',
  erase: 'このスマホの記録を消す',
  again2: 'もう一度',

  /* 付録：追いかけてくる仕掛け */
  nudge: '見てる？',
  tabPico: '(1) インスタグラフ：新しいメッセージ',
  tabKotori: '(1) RINE：母',
  bgNotif1: '（ゲーム内）投票結果のお知らせ',
  bgNotif2: '（ゲーム内）{駅名}周辺の会場が決まりました',
  welcomeApp: '投票サイト',
  welcome: 'おかえりなさい。続きはこちら',
  timeWord: { morning: '学校は？', day: '', night: '寝なくていいの？' }
};

/* ---------- 台本にない、画面の部品の文字（作業記録に一覧） ---------- */
const UI = {
  title: '乗っ取り',
  inGame: 'ゲーム内',
  pcLead: 'スマホで遊ぶと本物になります',
  nameLabel: 'あなたの呼ばれ方（あだ名でも）',
  namePh: 'ソウタ',
  nameNote: '入れた名前は、このスマホの外に出ません。',
  iosFull: 'iPhoneは、共有ボタン →「ホーム画面に追加」から開くと、画面いっぱいで遊べます。',
  back: '戻る',
  ok: 'OK',
  allow: '許可する',
  deny: '許可しない',
  answer: '出る',
  decline: '出ない',
  typing: '入力中…',
  calling: '呼び出し中…',
  incoming: '着信',
  missed: '不在着信 母',
  unlock: 'タップして開く',
  pwRow: 'パスワードを変更',
  pwDone: 'パスワードを変更しました',
  resume: '前回の続きがあります',
  goOn: '続きから',
  fromStart: '最初から',
  erased: '消しました',
  more: 'くわしく',
  voteHost: 'audition-vote.example',
  voteTitle: 'WEB投票',
  permAsk: 'が次の許可を求めています',
  permKind: { loc: '位置情報の使用', cam: 'カメラの使用', notif: '通知の表示' },
  phoneLabel: '電話番号',
  codeLabel: '確認番号',
  picoTabs: ['ホーム', 'DM', '設定'],
  stranger: '知らない人',
  apps: { pico: 'インスタグラフ', kotori: 'RINE', sms: 'SMS', mail: 'メール', phone: '電話' }
};

/* ---------- 場面の進み方（進行役 game.js がこの表を上から順に動かす） ---------- */
const anyOpen = st => !st.leakFixed || st.path2 || st.path3;

const SCENES = {
  S1: [
    { do: 'lock' },
    { do: 'msg', app: 'kotori', th: 'mom', who: '母', text: 'みかん送ったよ', wait: 0 },
    { do: 'msg', app: 'kotori', th: 'mom', who: '母', text: 'ちゃんと食べてる？', wait: 0 },
    { do: 'pause', s: TIMING.s1CallAfter },
    { do: 'incoming', id: 's1call', who: '母', max: TIMING.s1RingMax, options: [
      { label: UI.answer, set: { answeredS1: true }, steps: [
        { do: 'say', who: '母', text: 'みかん、もう届いた？　ちゃんと食べてね。', wait: 1 },
        { do: 'say', who: '母', text: 'それだけ。じゃあね。', wait: 4 },
        { do: 'hangup', wait: 3 }
      ] },
      { label: UI.decline, steps: [{ do: 'missed', who: '母' }] }
    ] },
    { do: 'explore' },
    { do: 'goto', to: 'S2' }
  ],

  S2: [
    { do: 'notify', app: 'pico', text: 'ミサキさんからメッセージ', th: 'misaki' },
    { do: 'msg', app: 'pico', th: 'misaki', who: 'ミサキ', text: '{名前}久しぶり〜元気？', wait: 2, quiet: true },
    { do: 'msg', app: 'pico', th: 'misaki', who: 'ミサキ', text: 'ごめん番号ミスってそっちにコード行っちゃった', wait: 3 },
    { do: 'msg', app: 'pico', th: 'misaki', who: 'ミサキ', text: '届いてたら教えてくれない？🙏', wait: 2 },
    { do: 'msg', app: 'sms', th: 'picosms', who: 'インスタグラフ', text: T.sms1, wait: 1 },
    { do: 'choice', id: 's2', app: 'pico', th: 'misaki', nudge: true, options: [
      { label: '番号を送る', me: T.code1, set: { path2: true }, steps: [
        { do: 'msg', app: 'pico', th: 'misaki', who: 'ミサキ', text: 'ありがと！助かった', wait: TIMING.s2Gap }
      ], next: 'S4' },
      { label: '「なんのコード？」', me: 'なんのコード？', steps: [
        { do: 'msg', app: 'pico', th: 'misaki', who: 'ミサキ', text: 'あ、大丈夫！ごめんね', wait: TIMING.s2Gap }
      ], next: 'S3' }
    ] }
  ],

  S3: [
    { do: 'msg', app: 'pico', th: 'misaki', who: 'ミサキ', text: 'いとこがオーディション出てて、投票してくれたらうれしい！1分で終わる', wait: 4 },
    { do: 'msg', app: 'pico', th: 'misaki', who: 'ミサキ', link: true, text: '（リンク）', wait: 1 },
    { do: 'choice', id: 's3', app: 'pico', th: 'misaki', nudge: true, options: [
      { label: '開く', steps: [{ do: 'vote' }] },
      { label: '開かない', steps: [
        { do: 'msg', app: 'pico', th: 'misaki', who: 'ミサキ', text: 'そっか、ありがと！', wait: TIMING.s2Gap }
      ] }
    ] },
    { do: 'msg', app: 'kotori', th: 'yuto', who: 'ユウト', text: '明日の1限出る？', wait: 4 },
    { do: 'choice', id: 'yuto', app: 'kotori', th: 'yuto', options: [
      { label: '出る', me: '出る' },
      { label: 'むり', me: 'むり' }
    ] },
    { do: 'branch', next: st => anyOpen(st) ? 'S4' : 'S4safe' }
  ],

  S4safe: [
    { do: 'set', v: { route: 'safe' } },
    { do: 'notify', app: 'pico', text: 'ログインに失敗しました（{遠い都道府県}）' },
    { do: 'pause', s: TIMING.s4safeAgain },
    { do: 'notify', app: 'pico', text: 'ログインに失敗しました（{遠い都道府県}）' },
    { do: 'msg', app: 'kotori', th: 'riko', who: 'リコ', text: 'ミサキのインスタグラフから変な投票のやつ来たんだけど', wait: 5 },
    { do: 'msg', app: 'kotori', th: 'riko', who: 'リコ', text: '{名前}にも来た？', wait: 3 },
    { do: 'choice', id: 'riko', app: 'kotori', th: 'riko', options: [
      { label: '「来た。ミサキ乗っ取られてると思う。開かないで」', me: '来た。ミサキ乗っ取られてると思う。開かないで' },
      { label: '「来た」', me: '来た' }
    ] },
    { do: 'goto', to: 'S6' }
  ],

  S4: [
    { do: 'race' },
    { do: 'branch', next: st => st.route === 'out' ? 'S5' : 'S6' }
  ],

  S5: [
    { do: 'set', v: { picoLocked: true } },
    { do: 'open', view: { name: 'pico', tab: 'feed' } },
    { do: 'mail', wait: 2, mail: T.s5mail },
    { do: 'msg', app: 'kotori', th: 'yuto', who: 'ユウト', text: 'インスタグラフでお前から「ギフトカード買って」って来たけど本人？', wait: 6 },
    { do: 'msg', app: 'kotori', th: 'yuto', who: 'ユウト', img: 'yutoShot', text: '', wait: 2 },
    { do: 'msg', when: st => st.faceTaken, app: 'kotori', th: 'riko', who: 'リコ', text: '{名前}の顔写真つきで「本人です」って来たんだけど', wait: 5 },
    { do: 'goto', to: 'S6' }
  ],

  S6: [
    { do: 'misaki3' },
    { do: 'branch', next: st => st.route === 'safe' ? 'S9' : 'S7' }
  ],

  S7: [
    { do: 'msg', app: 'kotori', th: 'mom', who: '母', text: 'インスタグラフで頼まれたカード、今からコンビニ行くね', wait: 4 },
    { do: 'msg', app: 'kotori', th: 'mom', who: '母', text: '電話も出られないって言うから', wait: 3 },
    { do: 'goto', to: 'S8' }
  ],

  S8: [
    { do: 'recover' },
    { do: 'goto', to: 'END' }
  ],

  END: [
    { do: 'ending' },
    { do: 'goto', to: 'S9' }
  ],

  S9: [
    { do: 'attacker' },
    { do: 'goto', to: 'S10' }
  ],

  S10: [
    { do: 'readout' },
    { do: 'goto', to: 'S11' }
  ],

  S11: [
    { do: 'advice' }
  ]
};
