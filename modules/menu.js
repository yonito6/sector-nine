/* Sector Nine main menu (redesign). One clear home screen with two big choices:
     PLAY VS BOTS  -> pick a map (big previews) -> Play
     MULTIPLAYER   -> browse rooms (mode + map thumbnail + players + Join) / create a room (mode cards, map picker,
                      players, kills, visibility) -> room lobby (map + mode banner, team columns, host controls, invite)
   plus a top bar: brand, nav (Arsenal, Customize, Profile, Friends, ...), utilities (What's new, Settings, Report a bug,
   Controls), currency (Shop) and the account chip.
   It does NOT duplicate any game logic: the original elements of index.html (#btnPlay, #mapSel, #btnOnline, #nick,
   #roomList, #rName/#rSize/#rMap/#rKills/#rMode, #btnCreate, #oRoom, #btnStart, #btnCopy, #btnLeave, ...) are MOVED into
   the new layout, so every handler the game (and other modules) attached keeps working. Hidden <select>s stay the
   source of truth; the cards/chips just set their value and fire 'change'/'input'.
   Public API: window.S9Menu = { addNavButton({id,label,icon,onClick,badge,slot}), setBadge(id,n), addPanel(id,el,opts),
   show(screen), back(), screen(), vis() }. Room visibility (meta.vis = 'public'|'friends'|'private') is added to the
   create-room settings by wrapping serverTransport/roomTransport. Loaded after the main game script. */
(() => {
  'use strict';
  if (window.S9Menu && window.S9Menu.ready) return;
  const $ = id => document.getElementById(id);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const S9 = () => window.__s9;
  const MODES = {
    ffa: { name: 'Free for all', short: 'FFA', min: 2, line: 'Everyone for themselves.' },
    tdm: { name: 'Team deathmatch', short: 'TDM', min: 2, line: 'Two teams. Most team kills wins.' },
    demo: { name: 'Demolition', short: 'DEMO', min: 4, line: 'Plant or stop the charge. 4+ players.' }
  };
  const VIS = {
    public: { name: 'Public', line: 'Shown in the room list.' },
    friends: { name: 'Friends only', line: 'Only your friends see it.' },
    private: { name: 'Private', line: 'Link or code only.' }
  };
  const TEAMS = { atk: { name: 'Strike Force', css: '#ff8a3d' }, def: { name: 'Sentinels', css: '#3dc8ff' } };
  const IMG = id => `assets/ui/map_${id}.jpg`, THUMB = id => `assets/ui/menu/thumb_${id}.jpg`;

  /* ------------------------------------------------------------------ icons (24px, stroke = currentColor) */
  const P = {
    arsenal: '<circle cx="12" cy="12" r="7.5"/><path d="M12 1.5v5M12 17.5v5M1.5 12h5M17.5 12h5"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>',
    customize: '<path d="M12 2.5 4 5.5v6c0 5 3.4 8.6 8 10 4.6-1.4 8-5 8-10v-6z"/><path d="M8.5 11.5h7M12 8v7"/>',
    profile: '<circle cx="12" cy="8" r="4"/><path d="M4 21c.8-4.2 4-6.5 8-6.5s7.2 2.3 8 6.5"/>',
    friends: '<circle cx="9" cy="8.5" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.6 6.5-5.6s5.9 2 6.5 5.6"/><circle cx="17" cy="7.5" r="2.8"/><path d="M16.5 13.3c2.9.1 4.6 2 5 5"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M10.3 2.5h3.4l.5 2.6 1.9.8 2.2-1.5 2.4 2.4-1.5 2.2.8 1.9 2.6.5v3.4l-2.6.5-.8 1.9 1.5 2.2-2.4 2.4-2.2-1.5-1.9.8-.5 2.6h-3.4l-.5-2.6-1.9-.8-2.2 1.5-2.4-2.4 1.5-2.2-.8-1.9-2.6-.5v-3.4l2.6-.5.8-1.9-1.5-2.2 2.4-2.4 2.2 1.5 1.9-.8z"/>',
    news: '<path d="M3 10v4h3l7 5V5L6 10z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>',
    bug: '<rect x="7" y="7" width="10" height="13" rx="5"/><path d="M9 7.5 7.5 4M15 7.5 16.5 4M7 12H3M21 12h-4M7 17l-3 2M17 17l3 2M12 10v9"/>',
    controls: '<rect x="2" y="6" width="20" height="12" rx="1.5"/><path d="M6 10h1M10 10h1M14 10h1M18 10h0M6 14h12"/>',
    shop: '<path d="M12 2 20 8 12 22 4 8z"/><path d="M4 8h16M12 2 9 8l3 14 3-14z"/>',
    back: '<path d="M15 4 7 12l8 8"/>',
    play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor"/>',
    users: '<circle cx="12" cy="8" r="3.6"/><path d="M5 20c.7-3.7 3.4-5.8 7-5.8s6.3 2.1 7 5.8"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18"/>',
    lock: '<rect x="5" y="10.5" width="14" height="10" rx="1.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
    link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3.2-3.2a4.5 4.5 0 0 0-6.4-6.4l-1.3 1.3"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3.2 3.2a4.5 4.5 0 0 0 6.4 6.4l1.3-1.3"/>',
    plus: '<path d="M12 4v16M4 12h16"/>',
    shuffle: '<path d="M3 7h4l10 10h4M3 17h4l3-3M14 10l3-3h4M18 4l3 3-3 3M18 14l3 3-3 3"/>',
    door: '<path d="M14 3H5v18h9"/><path d="M10 12h11M17 8l4 4-4 4"/>',
    crown: '<path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/>',
    teams: '<circle cx="7" cy="9" r="3"/><circle cx="17" cy="9" r="3"/><path d="M2 19c.5-3 2.5-4.6 5-4.6s4.5 1.6 5 4.6M12 19c.5-3 2.5-4.6 5-4.6s4.5 1.6 5 4.6"/>',
    bomb: '<rect x="4" y="9" width="16" height="10" rx="1.5"/><path d="M8 9V6h8v3M8 14h3M14 13v3"/><circle cx="16.5" cy="14.5" r=".8" fill="currentColor"/>',
    check: '<path d="M4.5 12.5 10 18 20 6"/>'
  };
  const svg = (k, cls = '') => `<svg class="s9m-i ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[k] || k || ''}</svg>`;
  const iconUrl = k => 'url("data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${(P[k] || '').replace(/currentColor/g, '#000')}</svg>`) + '")';
  const MODE_ICON = { ffa: 'target', tdm: 'teams', demo: 'bomb' }, VIS_ICON = { public: 'globe', friends: 'friends', private: 'lock' };

  /* ------------------------------------------------------------------ nav: which injected button goes where */
  // id -> [slot, order, label, icon]   slot: nav (labelled), util (icon only), wallet (currency pill)
  const KNOWN = {
    btnArsenal: ['nav', 10, 'Arsenal', 'arsenal'], btnArsenalSkins: ['nav', 20, 'Customize', 'customize'],
    btnProfile: ['nav', 30, 'Profile', 'profile'], btnFriends: ['wallet', 0, 'Friends', 'friends'],
    btnNews: ['util', 10, "What's new", 'news'], s9mControls: ['util', 20, 'Controls', 'controls'],
    btnSettings: ['util', 30, 'Settings', 'settings'], btnBugMenu: ['util', 40, 'Report a bug', 'bug'],
    btnShop: ['wallet', 10, 'Shop', 'shop']
  };
  const CORE = new Set(['btnPlay', 'btnOnline', 'btnCreate', 'btnStart', 'btnCopy', 'btnLeave', 'btnSaveRoom', 'btnJoinInvite']);

  /* ------------------------------------------------------------------ styles */
  const CSS = `
#menu.s9m-on{display:block;padding:0;overflow:hidden;background:none}
#menu.s9m-on[hidden]{display:none!important}
#menu.s9m-on>.sheet{display:none!important}
#s9m{--o:#ff9a3c;--o2:#ffb066;--c:#7fe7ff;--ink:#ece6d8;--dim:#9aa0a8;--bg0:#0b0d10;--glass:rgba(12,14,18,.72);--glass2:rgba(18,21,27,.86);--ln:rgba(236,230,216,.16);--ln2:rgba(236,230,216,.3);
  --disp:"Big Shoulders Stencil Display",Impact,"Arial Narrow",sans-serif;--mo:"IBM Plex Mono",ui-monospace,Consolas,monospace;
  --gut:clamp(16px,3.2vw,56px);position:fixed;inset:0;display:grid;grid-template-rows:auto 1fr;color:var(--ink);font-family:var(--mo);overflow:hidden;z-index:1}
#s9m *{box-sizing:border-box}
:where(#s9m button){font-family:inherit}
#s9m [hidden]{display:none!important}
/* atmosphere: the menu's live 3D scene stays visible behind this */
#s9m .s9m-bg{position:absolute;inset:0;pointer-events:none;z-index:-1;overflow:hidden;
  background:radial-gradient(120% 90% at 78% 30%,rgba(11,13,16,0) 0,rgba(11,13,16,.35) 55%,rgba(8,9,12,.88) 100%),linear-gradient(90deg,rgba(8,9,12,.86) 0,rgba(8,9,12,.55) 46%,rgba(8,9,12,.25) 100%)}
#s9m .s9m-bg::before{content:"";position:absolute;inset:0;opacity:.35;background-image:linear-gradient(rgba(127,231,255,.06) 1px,transparent 1px),linear-gradient(90deg,rgba(127,231,255,.06) 1px,transparent 1px);background-size:48px 48px;
  -webkit-mask:linear-gradient(180deg,transparent,#000 30%,#000 70%,transparent);mask:linear-gradient(180deg,transparent,#000 30%,#000 70%,transparent)}
#s9m .s9m-bg::after{content:"";position:absolute;left:0;right:0;top:-30%;height:30%;background:linear-gradient(180deg,transparent,rgba(255,154,60,.07) 70%,rgba(255,154,60,.18) 99%,transparent);animation:s9mSweep 9s linear infinite}
@keyframes s9mSweep{to{transform:translateY(440%)}}
#s9m .s9m-bg i{position:absolute;inset:0;background:repeating-linear-gradient(0deg,rgba(0,0,0,.18) 0 1px,transparent 1px 3px);opacity:.35}
/* top bar */
.s9m-top{display:flex;align-items:center;gap:clamp(10px,1.6vw,26px);padding:12px var(--gut);background:linear-gradient(180deg,rgba(8,9,12,.92),rgba(8,9,12,.55));border-bottom:1px solid var(--ln);min-width:0;position:relative;z-index:3}
.s9m-brand{display:flex;align-items:center;gap:10px;background:none;border:0;color:var(--ink);cursor:pointer;padding:4px 2px;flex:none}
.s9m-brand b{font-family:var(--disp);font-weight:900;font-size:26px;letter-spacing:.05em;line-height:1;white-space:nowrap}
.s9m-brand b em{font-style:normal;color:var(--o)}
.s9m-mark{width:34px;height:34px;display:grid;place-items:center;background:var(--o);color:#14100b;font-family:var(--disp);font-weight:900;font-size:19px;clip-path:polygon(50% 0,100% 50%,50% 100%,0 50%)}
.s9m-nav{display:flex;align-items:center;gap:4px;min-width:0;flex:1}
.s9m-util,.s9m-right{display:flex;align-items:center;gap:6px;flex:none}
.s9m-nav>button,#s9m .s9m-nav>button.ghost{position:relative;display:inline-flex;align-items:center;gap:8px;height:42px;padding:0 14px;background:transparent;border:1px solid transparent;color:var(--ink);font-family:var(--mo);font-size:12px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;cursor:pointer;white-space:nowrap;transition:background .15s,border-color .15s,color .15s}
.s9m-nav>button::before{content:"";width:18px;height:18px;flex:none;background:currentColor;-webkit-mask:var(--ico) center/contain no-repeat;mask:var(--ico) center/contain no-repeat}
.s9m-nav>button:hover{background:rgba(236,230,216,.07);border-color:var(--ln)}
.s9m-nav>button::after{content:"";position:absolute;left:14px;right:14px;bottom:4px;height:2px;background:var(--o);transform:scaleX(0);transition:transform .2s}
.s9m-nav>button:hover::after{transform:scaleX(1)}
.s9m-nav>button b{font-size:10px;padding:2px 5px;background:rgba(255,154,60,.16);color:var(--o);letter-spacing:.06em}
.s9m-util>button,#s9m .s9m-util>button.ghost{position:relative;width:42px;height:42px;padding:0;display:grid;place-items:center;background:rgba(236,230,216,.04);border:1px solid var(--ln);color:var(--ink);font-size:0;cursor:pointer;transition:background .15s,border-color .15s}
.s9m-util>button::before{content:"";width:20px;height:20px;background:currentColor;-webkit-mask:var(--ico) center/contain no-repeat;mask:var(--ico) center/contain no-repeat}
.s9m-util>button:hover{border-color:var(--o);background:rgba(255,154,60,.1)}
.s9m-util>button>*{position:absolute;top:-6px;right:-6px;font-size:9px!important;line-height:1;padding:3px 4px;background:var(--o);color:#14100b;font-weight:700;letter-spacing:.04em;border-radius:2px}
.s9m-util>button:not(.s9n-has)>.s9n-dot{display:none}
.s9m-tip{position:absolute;z-index:9;pointer-events:none;padding:6px 9px;background:#000;border:1px solid var(--ln2);font-size:11px;letter-spacing:.08em;white-space:nowrap;color:var(--ink);opacity:0;transform:translateY(-4px);transition:opacity .12s,transform .12s}
.s9m-tip.on{opacity:1;transform:none}
.s9m-right>button.s9s-open,#s9m .s9m-right>button.ghost.s9s-open{display:inline-flex;align-items:center;gap:7px;height:42px;padding:0 14px;background:rgba(255,154,60,.08);border:1px solid rgba(255,154,60,.45);color:var(--ink);font-family:var(--mo);font-size:12px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;cursor:pointer}
#s9m .s9m-right>#btnFriends{display:inline-flex;align-items:center;gap:8px;height:42px;padding:0 14px;background:rgba(127,231,255,.07);border:1px solid rgba(127,231,255,.4);color:var(--ink);font-family:var(--mo);font-size:12px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;cursor:pointer;white-space:nowrap;position:relative}
#s9m .s9m-right>#btnFriends:hover{background:rgba(127,231,255,.16)}
#s9m .s9m-right>#btnFriends::before{content:"";width:18px;height:18px;flex:none;background:currentColor;-webkit-mask:var(--ico) center/contain no-repeat;mask:var(--ico) center/contain no-repeat}
#s9m #btnFriends .s9m-fc{color:var(--c);font-weight:700;letter-spacing:.06em}
#s9m #btnFriends .s9m-fc.none{color:var(--dim);font-weight:600}
#s9m #btnFriends .s9m-fc.in::before{content:"";display:inline-block;width:7px;height:7px;border-radius:50%;background:#5cff9d;box-shadow:0 0 8px #5cff9d;margin-right:6px;vertical-align:1px}
#s9m #btnFriends .s9f-on{display:none!important}
#s9m #btnFriends .s9f-badge{top:-8px;right:-8px}
@media (max-width:760px){#s9m .s9m-right>#btnFriends{height:38px;padding:0 9px;gap:5px;font-size:0}#s9m #btnFriends .s9m-fc{font-size:12px}#s9m #btnFriends .s9m-fc .w{display:none}}
.s9m-right>button.s9s-open:hover{background:rgba(255,154,60,.18)}
.s9m-right>button.s9s-open img{width:18px;height:18px}
.s9m-right>button.s9s-open b{font-family:var(--disp);font-size:20px;letter-spacing:.02em;color:var(--o2)}
.s9m-right>button.s9s-open:not(:has(b))::before{content:"";width:18px;height:18px;background:currentColor;-webkit-mask:var(--ico) center/contain no-repeat;mask:var(--ico) center/contain no-repeat}
#s9m #s9a-chip{position:static!important;margin:0!important;max-width:240px;height:42px;box-shadow:none}
#s9m #s9a-chip[hidden]{display:none!important}
#s9m button:focus-visible,#s9m [tabindex]:focus-visible,#s9m input:focus-visible,#s9m select:focus-visible{outline:2px solid var(--o);outline-offset:2px}
/* stage + screens */
.s9m-stage{position:relative;min-height:0}
.s9m-scr{position:absolute;inset:0;overflow-x:hidden;overflow-y:auto;padding:clamp(14px,2.4vh,30px) var(--gut) 28px;opacity:0;visibility:hidden;transform:translateX(26px);transition:opacity .28s ease,transform .32s cubic-bezier(.2,.8,.2,1),visibility 0s .32s;scrollbar-width:thin;scrollbar-color:rgba(236,230,216,.25) transparent}
.s9m-scr.on{opacity:1;visibility:visible;transform:none;transition:opacity .28s ease,transform .32s cubic-bezier(.2,.8,.2,1),visibility 0s}
.s9m-scr.out{transform:translateX(-26px)}
.s9m-head{display:flex;align-items:center;gap:16px;margin-bottom:clamp(12px,2.2vh,24px);min-width:0;flex-wrap:wrap}
.s9m-backb{display:inline-flex;align-items:center;gap:6px;height:40px;padding:0 14px 0 8px;background:rgba(236,230,216,.05);border:1px solid var(--ln);color:var(--ink);font-size:12px;letter-spacing:.14em;text-transform:uppercase;cursor:pointer;flex:none}
.s9m-backb:hover{border-color:var(--o)}
.s9m-backb kbd{font-family:var(--mo);font-size:10px;color:var(--dim);border:1px solid var(--ln);padding:1px 4px;margin-left:4px}
.s9m-h{font-family:var(--disp);font-weight:900;font-size:clamp(34px,4.4vw,60px);line-height:.9;margin:0;letter-spacing:.02em;text-transform:uppercase}
.s9m-sub{font-size:13px;color:var(--dim);letter-spacing:.04em;margin:4px 0 0}
.s9m-k{font-size:11px;letter-spacing:.28em;text-transform:uppercase;color:var(--o);font-weight:600}
.s9m-lab{display:block;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--dim);margin:0 0 8px;font-weight:600}
.s9m-panel{background:var(--glass);border:1px solid var(--ln);padding:clamp(14px,1.6vw,22px);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}
/* buttons */
.s9m-cta,#s9m button.go.s9m-cta,#s9m .s9m-cta{display:inline-flex;align-items:center;justify-content:center;gap:12px;min-height:58px;padding:12px 34px 10px;background:var(--o);color:#14100b;border:0;font-family:var(--disp);font-weight:900;font-size:28px;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;clip-path:polygon(0 0,100% 0,100% 68%,calc(100% - 16px) 100%,0 100%);transition:background .15s,transform .15s}
.s9m-cta:hover{background:var(--o2)}.s9m-cta:active{transform:translateY(1px)}
.s9m-cta:disabled,#s9m .s9m-cta:disabled{background:#4a4640;color:#a8a296;cursor:not-allowed}
.s9m-cta.cy{background:var(--c)}.s9m-cta.cy:hover{background:#b0f2ff}
.s9m-cta .s9m-i{width:22px;height:22px}
.s9m-btn,#s9m button.ghost.s9m-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;padding:0 16px;background:rgba(236,230,216,.05);border:1px solid var(--ln2);color:var(--ink);font-family:var(--mo);font-size:12px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;cursor:pointer;transition:background .15s,border-color .15s}
.s9m-btn:hover{border-color:var(--o);background:rgba(255,154,60,.08)}
.s9m-btn:disabled{opacity:.45;cursor:not-allowed}
.s9m-btn .s9m-i{width:18px;height:18px}
.s9m-i{width:20px;height:20px;flex:none}
/* home */
.s9m-home{display:grid;grid-template-rows:auto 1fr auto;gap:clamp(14px,2.6vh,30px);min-height:100%}
.s9m-hero h1{font-family:var(--disp);font-weight:900;font-size:clamp(52px,7.4vw,138px);line-height:.82;margin:8px 0 0;letter-spacing:.01em;text-transform:none;text-shadow:0 4px 30px rgba(0,0,0,.5)}
.s9m-hero h1 em{font-style:normal;color:var(--o)}
.s9m-hero p{margin:10px 0 0;font-size:14px;color:#c9c3b6;max-width:56ch;line-height:1.55}
.s9m-choices{display:grid;grid-template-columns:1fr 1fr;gap:clamp(12px,1.6vw,24px);min-height:0}
.s9m-choice{position:relative;display:flex;flex-direction:column;justify-content:flex-end;gap:10px;min-height:clamp(250px,44vh,520px);padding:clamp(18px,2.2vw,34px);text-align:left;color:var(--ink);background:#111;border:1px solid var(--ln2);cursor:pointer;overflow:hidden;isolation:isolate;
  clip-path:polygon(0 0,calc(100% - 28px) 0,100% 28px,100% 100%,28px 100%,0 calc(100% - 28px));transition:border-color .2s,transform .25s cubic-bezier(.2,.8,.2,1)}
.s9m-choice .s9m-ph{position:absolute;inset:0;z-index:-2;transition:transform .6s cubic-bezier(.2,.8,.2,1)}
.s9m-choice .s9m-ph img{width:100%;height:100%;object-fit:cover;display:block}
.s9m-choice::before{content:"";position:absolute;inset:0;z-index:-1;background:linear-gradient(180deg,rgba(8,9,12,.05) 0,rgba(8,9,12,.35) 40%,rgba(8,9,12,.94) 100%)}
.s9m-choice::after{content:"";position:absolute;left:0;top:0;bottom:0;width:5px;background:var(--acc)}
.s9m-choice:hover,.s9m-choice:focus-visible{border-color:var(--acc);transform:translateY(-3px)}
.s9m-choice:hover .s9m-ph,.s9m-choice:focus-visible .s9m-ph{transform:scale(1.045)}
.s9m-choice .s9m-k{color:var(--acc)}
.s9m-choice h2{font-family:var(--disp);font-weight:900;font-size:clamp(44px,5.4vw,92px);line-height:.84;margin:0;letter-spacing:.02em;text-transform:uppercase}
.s9m-choice p{margin:0;font-size:14px;line-height:1.5;color:#ddd6c8;max-width:44ch}
.s9m-choice .s9m-go{display:inline-flex;align-items:center;gap:10px;align-self:flex-start;margin-top:6px;padding:10px 18px 9px;background:var(--acc);color:#0d0f12;font-family:var(--disp);font-weight:900;font-size:22px;letter-spacing:.08em;text-transform:uppercase;clip-path:polygon(0 0,100% 0,100% 64%,calc(100% - 10px) 100%,0 100%)}
.s9m-choice .s9m-go .s9m-i{width:18px;height:18px}
.s9m-tags{display:flex;flex-wrap:wrap;gap:6px}
.s9m-tag{display:inline-flex;align-items:center;gap:6px;padding:4px 9px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;background:rgba(8,9,12,.6);border:1px solid var(--ln2);color:var(--ink);white-space:nowrap}
.s9m-tag .s9m-i{width:14px;height:14px}
.s9m-slices{position:absolute;inset:0;display:grid;grid-template-columns:repeat(3,1fr);overflow:hidden}
.s9m-slices img{width:100%;height:100%;object-fit:cover;display:block}
.s9m-slices span{overflow:hidden;clip-path:polygon(18% 0,100% 0,82% 100%,0 100%);margin:0 -9%}
.s9m-slices span:first-child{clip-path:polygon(0 0,100% 0,82% 100%,0 100%);margin-left:0}
.s9m-slices span:last-child{clip-path:polygon(18% 0,100% 0,100% 100%,0 100%);margin-right:0}
.s9m-foot{display:flex;flex-wrap:wrap;align-items:center;gap:10px 18px;font-size:12px;color:var(--dim)}
.s9m-foot #bestLine{font-size:12px;color:var(--ink);letter-spacing:.06em}
.s9m-foot .touchnote{margin:0}
/* map preview + grid */
.s9m-two{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:clamp(14px,2vw,30px);align-items:start}
.s9m-prev{position:relative;aspect-ratio:16/9;overflow:hidden;border:1px solid var(--ln2);background:#111;clip-path:polygon(0 0,calc(100% - 22px) 0,100% 22px,100% 100%,0 100%)}
.s9m-prev img{width:100%;height:100%;object-fit:cover;display:block;animation:s9mFade .35s ease}
@keyframes s9mFade{from{opacity:.25;transform:scale(1.02)}}
.s9m-prev .s9m-cap{position:absolute;left:0;right:0;bottom:0;padding:clamp(14px,2vw,26px);background:linear-gradient(180deg,transparent,rgba(8,9,12,.92))}
.s9m-prev .s9m-cap b{display:block;font-family:var(--disp);font-weight:900;font-size:clamp(32px,3.6vw,58px);line-height:.9;text-transform:uppercase;letter-spacing:.02em}
.s9m-prev .s9m-cap span{display:block;margin-top:6px;font-size:13px;color:#d8d2c4;letter-spacing:.04em}
.s9m-prev .s9m-slices span{margin:0 -9%}
.s9m-playrow{display:flex;flex-wrap:wrap;gap:12px 18px;align-items:center;margin-top:16px}
.s9m-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.s9m-map{position:relative;display:block;padding:0;text-align:left;background:#101216;border:1px solid var(--ln);color:var(--ink);cursor:pointer;overflow:hidden;transition:border-color .15s,transform .15s}
.s9m-th{position:relative}
.s9m-map .s9m-th{display:block;aspect-ratio:16/9;overflow:hidden;background:#15181d}
.s9m-map .s9m-th img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .35s}
.s9m-map .s9m-th .s9m-slices span{margin:0 -9%}
.s9m-map>b{display:block;padding:7px 9px 8px;font-size:12px;font-weight:600;letter-spacing:.06em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.s9m-map:hover{border-color:var(--ln2)}.s9m-map:hover img{transform:scale(1.06)}
.s9m-map[aria-pressed=true],.s9m-map[aria-checked=true]{border-color:var(--o);box-shadow:inset 0 0 0 1px var(--o)}
.s9m-map[aria-pressed=true]>b,.s9m-map[aria-checked=true]>b{background:var(--o);color:#14100b}
.s9m-map .s9m-ok{position:absolute;top:6px;right:6px;width:24px;height:24px;display:none;place-items:center;background:var(--o);color:#14100b}
.s9m-map[aria-pressed=true] .s9m-ok,.s9m-map[aria-checked=true] .s9m-ok{display:grid}
.s9m-map .s9m-ok .s9m-i{width:15px;height:15px}
/* option cards (mode / visibility) + chips */
.s9m-cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.s9m-card{display:grid;grid-template-columns:auto 1fr;gap:4px 10px;align-content:start;padding:12px;background:rgba(236,230,216,.04);border:1px solid var(--ln);color:var(--ink);text-align:left;cursor:pointer;transition:border-color .15s,background .15s;min-width:0}
.s9m-card .s9m-i{grid-row:1/3;width:26px;height:26px;color:var(--dim);margin-top:2px}
.s9m-card b{font-size:13px;letter-spacing:.06em;text-transform:uppercase;font-weight:600}
.s9m-card span{font-size:11.5px;line-height:1.4;color:var(--dim)}
.s9m-card:hover{border-color:var(--ln2);background:rgba(236,230,216,.07)}
.s9m-card[aria-checked=true]{border-color:var(--c);background:rgba(127,231,255,.09)}
.s9m-card[aria-checked=true] .s9m-i{color:var(--c)}
.s9m-card:disabled{opacity:.4;cursor:not-allowed}
.s9m-chips{display:flex;flex-wrap:wrap;gap:6px}
.s9m-chip{min-width:46px;height:40px;padding:0 12px;background:rgba(236,230,216,.04);border:1px solid var(--ln);color:var(--ink);font-family:var(--disp)!important;font-weight:900;font-size:20px;letter-spacing:.04em;cursor:pointer}
.s9m-chip:hover{border-color:var(--ln2)}
.s9m-chip[aria-checked=true]{background:var(--c);border-color:var(--c);color:#0b0d10}
.s9m-chip:disabled{opacity:.3;cursor:not-allowed}
.s9m-field{display:grid;gap:0;margin-bottom:16px;min-width:0}
.s9m-field:last-child{margin-bottom:0}
#s9m input[type=text],#s9m input:not([type]),#s9m .s9m-field input{width:100%;height:44px;padding:0 12px;background:rgba(8,9,12,.75);border:1px solid var(--ln2);color:var(--ink);font-family:var(--mo);font-size:15px;min-width:0}
#s9m input::placeholder{color:#767b83}
#s9m select{height:40px;background:rgba(8,9,12,.85);color:var(--ink);border:1px solid var(--ln2);font-family:var(--mo);font-size:13px;padding:0 8px;min-width:0;max-width:100%}
.s9m-hide{display:none!important}
.s9m-msg{min-height:20px;font-size:13px;color:var(--c);letter-spacing:.02em}
.s9m-msg .err,.s9m-msg #onlineMsg.err{color:#ff7a6e}
.s9m-msgrow{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:12px}
.s9m-msgrow .note{font-size:13px;color:var(--c)}
.s9m-msgrow .note.err{color:#ff7a6e}
/* browse */
.s9m-browse{display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,340px);gap:clamp(14px,2vw,28px);align-items:start}
.s9m-filters{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px}
.s9m-seg{display:inline-flex;border:1px solid var(--ln2);flex-wrap:wrap}
.s9m-seg button{height:38px;padding:0 14px;background:transparent;border:0;border-right:1px solid var(--ln);color:var(--dim);font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;cursor:pointer}
.s9m-seg button:last-child{border-right:0}
.s9m-seg button[aria-checked=true]{background:rgba(127,231,255,.14);color:var(--ink);box-shadow:inset 0 -2px 0 var(--c)}
#s9m #oCount{font-size:12px;color:var(--dim);letter-spacing:.06em}
#s9m #roomList{display:grid;gap:8px;max-height:none;overflow:visible}
.s9m-room{display:grid;grid-template-columns:132px minmax(0,1fr) auto auto;gap:14px;align-items:center;padding:8px 12px 8px 8px;background:var(--glass);border:1px solid var(--ln);transition:border-color .15s,background .15s}
.s9m-room:hover{border-color:var(--ln2);background:var(--glass2)}
.s9m-room .s9m-th{display:block;aspect-ratio:16/9;overflow:hidden;background:#15181d}
.s9m-room .s9m-th img{width:100%;height:100%;object-fit:cover;display:block}
.s9m-room .s9m-rn{min-width:0}
.s9m-room .s9m-rn b{display:block;font-size:16px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.s9m-room .s9m-rn>span:not(.s9m-tags){display:block;margin-top:3px;font-size:12px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.s9m-room .s9m-rn .s9m-tags{margin-top:7px}
.s9m-room .s9m-tag{font-size:10px;padding:3px 7px}
.s9m-mode-ffa{color:#ffd9a8!important;border-color:rgba(255,154,60,.5)!important}
.s9m-mode-tdm{color:#bdf4ff!important;border-color:rgba(127,231,255,.5)!important}
.s9m-mode-demo{color:#ffb4ab!important;border-color:rgba(255,90,70,.55)!important}
.s9m-cnt{display:grid;justify-items:end;gap:5px;min-width:74px}
.s9m-cnt b{font-family:var(--disp);font-weight:900;font-size:26px;line-height:1}
.s9m-cnt b small{font-size:16px;color:var(--dim)}
.s9m-cnt em{font-style:normal;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--c)}
.s9m-cnt em.live{color:var(--o)}
.s9m-bar{width:74px;height:4px;background:rgba(236,230,216,.12)}.s9m-bar i{display:block;height:100%;background:var(--c)}
.s9m-room button.go{min-width:96px;min-height:46px;font-size:22px;padding:8px 18px 6px}
.s9m-room button.go:disabled{background:#3a3833;color:#a39d91;cursor:not-allowed}
.s9m-empty{display:grid;justify-items:start;gap:12px;padding:clamp(18px,3vw,36px);border:1px dashed var(--ln2);background:rgba(8,9,12,.5)}
.s9m-empty b{font-family:var(--disp);font-size:30px;font-weight:900;text-transform:uppercase;letter-spacing:.02em}
.s9m-empty>span:not(.s9m-ph){font-size:13px;color:var(--dim);max-width:46ch;line-height:1.5}
.s9m-side{display:grid;gap:14px}
.s9m-codein{display:flex;gap:8px}.s9m-codein input{text-transform:uppercase;letter-spacing:.2em}
/* create */
.s9m-create{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:clamp(14px,2vw,30px);align-items:start}
.s9m-create .s9m-grid{grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:10px}
.s9m-create .s9m-map>b{font-size:11px;padding:5px 7px}
.s9m-bottom{position:sticky;bottom:-28px;margin:18px 0 -28px;padding:14px 0 18px;display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:12px 18px;background:linear-gradient(180deg,rgba(8,9,12,0),rgba(8,9,12,.92) 30%);z-index:2}
.s9m-bottom .s9m-sum{margin-right:auto;font-size:12px;color:var(--dim);letter-spacing:.06em;min-width:0}
.s9m-bottom .s9m-sum b{color:var(--ink)}
.s9m-dock{position:fixed!important;left:0;bottom:0;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;opacity:.01;z-index:0}
.s9m-dock *{max-width:none}
#s9m .mxPrev{display:none}
/* lobby: #oRoom itself */
#s9m #oRoom{display:grid;gap:clamp(14px,2vh,22px);grid-template-columns:minmax(0,1.45fr) minmax(280px,1fr);align-items:start}
#s9m #oRoom[hidden]{display:none}
#s9m #oRoom>.ohead{display:none}
.s9m-banner{grid-column:1/-1;position:relative;min-height:clamp(150px,24vh,250px);display:flex;flex-direction:column;justify-content:flex-end;gap:8px;padding:clamp(16px,2vw,28px);border:1px solid var(--ln2);overflow:hidden;isolation:isolate;clip-path:polygon(0 0,calc(100% - 26px) 0,100% 26px,100% 100%,0 100%)}
.s9m-banner .s9m-ph{position:absolute;inset:0;z-index:-2}.s9m-banner .s9m-ph img{width:100%;height:100%;object-fit:cover;display:block}
.s9m-banner::before{content:"";position:absolute;inset:0;z-index:-1;background:linear-gradient(90deg,rgba(8,9,12,.92) 0,rgba(8,9,12,.55) 55%,rgba(8,9,12,.15) 100%)}
.s9m-banner h2{font-family:var(--disp);font-weight:900;font-size:clamp(40px,5vw,78px);line-height:.88;margin:0;text-transform:uppercase;letter-spacing:.02em;overflow-wrap:anywhere}
.s9m-banner .s9m-code{position:absolute;top:clamp(14px,2vw,24px);right:clamp(28px,3vw,44px);text-align:right}
.s9m-banner .s9m-code span{display:block;font-size:10px;letter-spacing:.24em;color:var(--dim);text-transform:uppercase}
.s9m-banner .s9m-code b{font-family:var(--disp);font-size:clamp(28px,3vw,44px);font-weight:900;letter-spacing:.14em;color:var(--c)}
/* roomflow.js (older team UI) hides #oPlayers and shows #rfTeams in team modes: the menu has its own team columns, so keep ours and hide roomflow's */
#s9m #rfTeams{display:none!important}
#s9m #oPlayers[hidden]{display:grid!important}
#s9m #oPlayers{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px}
#s9m #oPlayers:not(.s9m-teams){grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}
#s9m .oplayer{display:flex;align-items:center;gap:10px;min-height:48px;padding:8px 12px;background:var(--glass);border:1px solid var(--ln);font-size:14px;min-width:0}
#s9m .oplayer b{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600;min-width:0}
#s9m .oplayer i{width:12px;height:12px;border-radius:50%;flex:none}
#s9m .oplayer em{font-style:normal;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#14100b;background:var(--o);padding:2px 6px;font-weight:700}
#s9m .oplayer span{font-size:11px;color:var(--c);letter-spacing:.1em;text-transform:uppercase;margin-left:auto}
#s9m .oplayer.empty{opacity:.55;border-style:dashed;background:rgba(8,9,12,.35)}
#s9m .oplayer.empty b{font-weight:400;color:var(--dim)}
#s9m #oPlayers.s9m-teams{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.s9m-team{display:grid;gap:8px;align-content:start;padding:12px;border:1px solid var(--ln);border-top:3px solid var(--tc);background:rgba(8,9,12,.55)}
.s9m-team>header{display:flex;align-items:center;justify-content:space-between;gap:8px}
.s9m-team>header b{font-family:var(--disp);font-size:24px;font-weight:900;text-transform:uppercase;letter-spacing:.03em;color:var(--tc)}
.s9m-team>header button{height:34px;padding:0 10px;background:transparent;border:1px solid var(--tc);color:var(--ink);font-size:11px;letter-spacing:.12em;text-transform:uppercase;cursor:pointer}
.s9m-team>header button:hover{background:rgba(255,255,255,.08)}
.s9m-team.auto{grid-column:1/-1;--tc:var(--dim)}
.s9m-team.auto>header b{font-size:18px}
.s9m-pl{grid-column:1}
.s9m-pl>.s9m-lab{display:flex;justify-content:space-between}
.s9m-lside{display:grid;gap:12px;grid-column:2;grid-row:2/span 3}
.s9m-lside .s9m-cta{width:100%}
.s9m-lside .s9m-btn{width:100%}
.s9m-lside .row{display:grid!important;gap:10px}
#s9m #oWait{font-size:14px;color:var(--c);letter-spacing:.04em;padding:12px 14px;border:1px solid rgba(127,231,255,.35);background:rgba(127,231,255,.07)}
#s9m #oWait[hidden]{display:none}
#s9m #oEdit{grid-column:1}
#s9m #oEdit[hidden]{display:none}
#s9m #oEdit .ohead{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:baseline;justify-content:space-between;border-bottom:1px solid var(--ln);padding-bottom:8px;margin-bottom:10px}
#s9m #oEdit .ohead b{font-family:var(--disp);font-size:22px;letter-spacing:.04em;text-transform:uppercase}
#s9m #oEdit .ocreate{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;align-items:end}
#s9m #oEdit label{display:grid;gap:5px;font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--dim)}
#s9m #oEdit input{height:40px;font-size:13px}
#s9m #oEdit .ocreate>button{grid-column:1/-1;justify-self:start}
#s9m #oEdit label.mxModeLab{display:grid;margin:0}
.s9m-lside .s9m-cta{font-size:24px}
#s9m #oEditMsg{font-size:12px;color:var(--dim)}
.s9m-vis-edit{grid-column:1/-1}
/* controls */
#s9m .keys{display:grid;grid-template-columns:repeat(2,auto minmax(0,1fr));gap:10px 16px;font-size:13px;align-items:center;max-width:820px}
#s9m .keys kbd{font-family:var(--mo);font-size:11.5px;border:1px solid var(--ln2);border-bottom-width:3px;padding:4px 9px;background:rgba(236,230,216,.06);white-space:nowrap;justify-self:start;color:var(--ink)}
#s9m .keys span{color:#c9c3b6}
#s9m .s9m-tips{max-width:820px;margin-top:18px;font-size:13px;line-height:1.6;color:#c9c3b6}
/* keyboard grid focus */
.s9m-grid .s9m-map:focus-visible{outline:2px solid var(--c);outline-offset:2px}
/* responsive */
@media (max-width:1500px){.s9m-nav>button{padding:0 11px;letter-spacing:.1em}}
@media (max-width:1240px){.s9m-brand b{display:none}.s9m-two{grid-template-columns:minmax(0,1.2fr) minmax(0,1fr)}.s9m-create{grid-template-columns:1fr}.s9m-cards{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (max-width:1040px){.s9m-nav>button{font-size:0;gap:0;padding:0 12px}.s9m-nav>button b{font-size:10px;margin-left:6px}.s9m-browse{grid-template-columns:1fr}.s9m-side{grid-template-columns:1fr 1fr}}
@media (max-width:760px){
  .s9m-top{flex-wrap:wrap;padding:10px 16px;gap:8px}
  .s9m-brand{order:0}.s9m-right{order:1;margin-left:auto}.s9m-util{order:2}
  .s9m-nav{order:3;flex-basis:100%;display:grid;grid-template-columns:repeat(auto-fit,minmax(64px,1fr));gap:4px}
  .s9m-nav>button,#s9m .s9m-nav>button.ghost{height:52px;flex-direction:column;justify-content:center;gap:4px;padding:4px 2px;font-size:9.5px;letter-spacing:.08em;border:1px solid var(--ln);background:rgba(236,230,216,.03)}
  .s9m-nav>button b{display:none}
  .s9m-nav>button::after{display:none}
  .s9m-util{gap:4px}.s9m-util>button,#s9m .s9m-util>button.ghost{width:38px;height:38px}
  .s9m-right{gap:4px}.s9m-right>button.s9s-open,#s9m .s9m-right>button.ghost.s9s-open{height:38px;padding:0 9px;font-size:0;gap:5px}
  .s9m-right>button.s9s-open b{font-size:17px}
  #s9m #s9a-chip{height:38px;max-width:150px;padding:4px 8px 4px 4px}
  #s9m #s9a-chip .lv{display:none}
  .s9m-brand .s9m-mark{width:30px;height:30px;font-size:17px}
  .s9m-scr{padding:14px 16px 24px}
  .s9m-choices{grid-template-columns:1fr}
  .s9m-choice{min-height:230px;clip-path:polygon(0 0,calc(100% - 20px) 0,100% 20px,100% 100%,20px 100%,0 calc(100% - 20px))}
  .s9m-two,.s9m-browse{grid-template-columns:1fr}
  .s9m-side{grid-template-columns:1fr}
  .s9m-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  .s9m-create .s9m-grid{grid-template-columns:repeat(3,minmax(0,1fr))}
  .s9m-cards{grid-template-columns:1fr}
  .s9m-card{grid-template-columns:auto 1fr}
  .s9m-room{grid-template-columns:96px minmax(0,1fr) auto;gap:10px}
  .s9m-room .s9m-cnt{grid-column:2;grid-row:2;justify-items:start;grid-auto-flow:column;align-items:center;gap:10px}
  .s9m-room button.go{grid-column:3;grid-row:1/3;min-width:76px;font-size:19px;padding:8px 12px 6px}
  .s9m-room .s9m-th{grid-row:1/3}
  .s9m-room .s9m-rn .s9m-tags{display:none}
  #s9m #oRoom{grid-template-columns:1fr}
  .s9m-lside,.s9m-pl,#s9m #oEdit{grid-column:1;grid-row:auto}
  #s9m #oPlayers.s9m-teams{grid-template-columns:1fr}
  .s9m-banner .s9m-code{position:static;text-align:left}
  #s9m .keys{grid-template-columns:auto minmax(0,1fr)}
  .s9m-cta,#s9m button.go.s9m-cta,#s9m .s9m-cta{font-size:24px;min-height:54px;padding:10px 24px 8px}
  .s9m-bottom .s9m-cta{flex:1}
  .s9m-head .s9m-h{font-size:34px}
}
.s9m-pair{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:0 16px}
.s9m-pair .s9m-field:last-child{margin-bottom:16px}
.s9m-create .s9m-prev{aspect-ratio:21/9}
#s9mSize{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:5px}#s9mSize .s9m-chip{min-width:0;padding:0}
.s9m-chip{min-width:40px;padding:0 10px}
@media (max-width:760px){.s9m-pair{grid-template-columns:1fr}.s9m-pair .s9m-field{margin-bottom:16px}.s9m-bottom .s9m-sum{display:none}
  .s9m-seg{display:grid;grid-template-columns:auto 1fr 1fr 1fr;width:100%}.s9m-seg button{padding:0 6px;font-size:10px;letter-spacing:.06em;border-right:1px solid var(--ln)}}
@media (max-height:820px) and (min-width:761px){.s9m-choice{min-height:clamp(220px,40vh,420px)}.s9m-hero h1{font-size:clamp(52px,6.2vw,110px)}}
/* ---- review round 2 ---- */
#s9m .s9m-bg::after{background:linear-gradient(180deg,transparent 0,rgba(255,154,60,.04) 55%,rgba(255,154,60,.09) 85%,transparent 100%)}
.s9m-head .s9m-h,.s9m-head .s9m-sub{text-shadow:0 2px 14px rgba(0,0,0,.95),0 0 2px rgba(0,0,0,.85)}
.s9m-sub{color:#d2ccbf}
#s9m #oCount{color:#cfc9bc}
.s9m-hero h1{font-size:clamp(46px,5.6vw,108px)}
.s9m-choices{align-items:stretch}
.s9m-choice{clip-path:none;height:100%;min-height:clamp(250px,40vh,440px)}
.s9m-choice .s9m-cn{position:absolute;top:0;right:0;width:40px;height:40px;background:linear-gradient(225deg,var(--acc) 0 50%,transparent 50%);opacity:.9}
.s9m-choice h2{font-size:clamp(44px,5vw,104px)}
.s9m-best[hidden]{display:none!important}
.s9m-botl{grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);grid-template-areas:"pv grid" "play grid";grid-template-rows:auto 1fr}
.s9m-botl .s9m-pvcol{grid-area:pv}.s9m-botl .s9m-grid{grid-area:grid}.s9m-botl .s9m-playrow{grid-area:play;align-self:start;margin-top:0}
.s9m-rules{margin-top:12px}
.s9m-empty{position:relative;overflow:hidden;isolation:isolate;min-height:clamp(280px,54vh,620px);align-content:end;border-style:solid}
.s9m-empty>.s9m-ph{position:absolute;inset:0;z-index:-2;opacity:.75;justify-self:stretch;align-self:stretch}
.s9m-empty::before{content:"";position:absolute;inset:0;z-index:-1;background:linear-gradient(180deg,rgba(8,9,12,.25),rgba(8,9,12,.92) 75%)}
.s9m-empty b{font-size:clamp(30px,3vw,46px)}
#s9m[data-empty] .s9m-side [data-go=create]{display:none}
.s9m-cnt em.full{color:#ff9d92}
.s9m-create .s9m-prev{aspect-ratio:16/5}
.s9m-create .s9m-prev .s9m-cap b{font-size:clamp(26px,2.6vw,42px)}
.s9m-create .s9m-prev .s9m-cap{padding:12px 16px}
.s9m-create .s9m-map>b{position:absolute;left:0;right:0;bottom:0;padding:16px 7px 5px;background:linear-gradient(180deg,transparent,rgba(8,9,12,.94) 55%)}
.s9m-create .s9m-map[aria-checked=true]{border-color:var(--c);box-shadow:inset 0 0 0 1px var(--c)}
.s9m-create .s9m-map[aria-checked=true]>b{background:linear-gradient(180deg,transparent,rgba(8,9,12,.94) 55%);color:var(--c)}
.s9m-create .s9m-map .s9m-ok{background:var(--c)}
.s9m-chip{height:44px}
.s9m-team>header button{height:40px;padding:0 12px}
#s9m .s9m-lside .s9m-cta:disabled,#s9m .s9m-lside .s9m-cta:disabled:hover{background:rgba(8,9,12,.6);color:#c9c3b6;clip-path:none;outline:1px dashed var(--ln2);outline-offset:-1px;font-size:22px}
.s9m-ctl{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(0,1fr);gap:clamp(14px,2vw,28px);align-items:start}
#s9m .s9m-ctl .keys{max-width:none}
#s9m .s9m-ctl .s9m-tips{margin:0;max-width:none}
#s9m #oEdit .ocreate{grid-template-columns:repeat(auto-fit,minmax(170px,1fr))}
@media (max-width:1040px){.s9m-ctl{grid-template-columns:1fr}}
@media (max-width:760px){
  .s9m-botl{grid-template-columns:1fr;grid-template-areas:"pv" "grid" "play";grid-template-rows:auto}
  .s9m-botl .s9m-playrow{position:sticky;bottom:-24px;margin:6px -16px -24px;padding:14px 16px 18px;background:linear-gradient(180deg,rgba(8,9,12,0),rgba(8,9,12,.96) 32%);z-index:2}
  .s9m-botl .s9m-playrow .s9m-cta{flex:1}
  .s9m-backb kbd{display:none}
  .s9m-seg{grid-template-columns:1fr 1fr}
  .s9m-seg button{border-bottom:1px solid var(--ln)}
  .s9m-bottom{flex-direction:column;align-items:stretch}
  .s9m-bottom .s9m-msgrow:empty{display:none}
  #s9m #oRoom>.s9m-banner{order:0}#s9m #oRoom>.s9m-lside{order:1}#s9m #oRoom>.s9m-pl{order:2}#s9m #oRoom>#oEdit{order:3}
  .s9m-empty{min-height:300px}
  .s9m-room .s9m-bar{display:none}
  .s9m-room .s9m-cnt em{white-space:nowrap}
  .s9m-room .s9m-cnt{gap:8px}
  .s9m-create .s9m-prev{aspect-ratio:16/7}
}
@media (pointer:coarse){.s9m-backb kbd{display:none}}
/* ---- team balance ---- */
.s9m-cards2{grid-template-columns:repeat(2,minmax(0,1fr))}
#s9m #oPlayers.s9m-teams{grid-template-columns:1fr 1fr;align-items:start}
.s9m-teamtools{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.s9m-teamtools .s9m-seg button{height:40px}
.s9m-lock[aria-pressed=true]{border-color:var(--o);background:rgba(255,154,60,.14)}
.s9m-tnote{grid-column:1/-1;margin:0;font-size:12.5px;color:#cfc9bc;letter-spacing:.02em}
.s9m-team>header small{font-family:var(--disp);font-size:20px;font-weight:900;color:var(--ink);margin-right:auto;margin-left:8px;opacity:.8}
.s9m-team.none{grid-column:1/-1;--tc:var(--dim)}
.s9m-team.none>header b{font-size:18px}
.s9m-nonegrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px}
.s9m-team.over{background:rgba(255,255,255,.07);outline:2px dashed var(--tc);outline-offset:-2px}
#s9m .oplayer.drag{cursor:grab}
#s9m .oplayer.dragging{opacity:.4}
#s9m .oplayer .s9m-mv{flex:none;min-width:34px;height:34px;padding:0 6px;margin-left:6px;background:transparent;border:1px solid var(--tc,var(--ln2));color:var(--ink);font-size:13px;font-weight:700;cursor:pointer}
#s9m .oplayer .s9m-mv:hover{background:rgba(255,255,255,.1)}
#s9m .oplayer span+.s9m-mv,#s9m .oplayer em+.s9m-mv{margin-left:6px}
#s9m .oplayer b+.s9m-mv{margin-left:auto}
.s9m-team .oplayer{--tc:inherit}
.s9m-team>header{min-height:40px}
.s9m-create .s9m-card{padding:8px 12px}.s9m-create .s9m-card .s9m-i{width:22px;height:22px}
.s9m-create .s9m-field{margin-bottom:12px}.s9m-create .s9m-pair .s9m-field:last-child{margin-bottom:12px}
@media (max-width:760px){#s9m #oPlayers.s9m-teams{grid-template-columns:1fr}.s9m-team>header button{padding:0 10px}}
/* quick play (the original #btnPlay) */
.s9m-qp{display:flex;align-items:center;gap:14px;flex-wrap:wrap;min-width:0}
#s9m #btnPlay.s9m-quick{display:inline-flex;align-items:center;gap:10px;height:48px;padding:0 22px 0 16px;background:rgba(255,154,60,.12);border:1px solid var(--o);color:var(--ink);font-family:var(--disp);font-weight:900;font-size:22px;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;clip-path:none;transition:background .15s}
#s9m #btnPlay.s9m-quick:hover{background:rgba(255,154,60,.26)}
#s9m #btnPlay.s9m-quick .s9m-i{width:18px;height:18px;color:var(--o)}
.s9m-qpt{font-size:12.5px;color:#cfc9bc;letter-spacing:.04em}
@media (prefers-reduced-motion:reduce){#s9m .s9m-bg::after{animation:none;display:none}.s9m-scr,.s9m-scr.on{transition:opacity .15s,visibility 0s}.s9m-scr{transform:none!important}.s9m-choice,.s9m-choice .s9m-ph{transition:none}}
`;

  /* ------------------------------------------------------------------ state */
  const ST = { screen: 'home', stack: [], vis: 'public', filter: 'all', rooms: [], panels: {}, built: false, escArm: 0, lastMeta: null };
  ST.balance = 'auto';
  try { const v = localStorage.getItem('sector9-roomvis'); if (VIS[v]) ST.vis = v; const b = localStorage.getItem('sector9-balance'); if (b === 'auto' || b === 'manual') ST.balance = b; } catch (e) {}
  const BAL = { auto: { name: 'Auto', line: 'The game keeps the teams even.' }, manual: { name: 'Manual', line: 'Players pick a team. Any split is allowed.' } };
  let root, stage, scr = {}, navEl, utilEl, rightEl, dock, tip;

  const mapsList = () => { const s = S9(); return (s && s.MAPS) || window.MAPS || []; };
  const mapById = id => mapsList().find(m => m.id === id);
  const mapNm = id => (mapById(id) || { name: id || 'Random rotation' }).name;
  const shortTag = m => (m && m.tag ? m.tag.split('·')[0].trim() : '');
  const game = () => S9() ? S9().state : '';
  const mapPrefNow = () => { const s = $('mapSel'); return s ? s.value : 'random'; };
  const slicesHTML = ids => `<span class="s9m-slices">${ids.map(id => `<span><img src="${THUMB(id)}" alt="" loading="lazy" decoding="async"></span>`).join('')}</span>`;

  function el(tag, attrs, html) { const e = document.createElement(tag); if (attrs) for (const k in attrs) { if (k === 'class') e.className = attrs[k]; else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]); else if (attrs[k] != null) e.setAttribute(k, attrs[k]); } if (html != null) e.innerHTML = html; return e; }
  const sfxClick = () => { try { const s = S9(); if (s && s.sfx && s.sfx.click) s.sfx.click(); } catch (e) {} };

  /* ------------------------------------------------------------------ build */
  function headHTML(title, sub, back = true) {
    return `<div class="s9m-head">${back ? `<button type="button" class="s9m-backb" data-back>${svg('back')}Back<kbd>Esc</kbd></button>` : ''}<div style="min-width:0"><h2 class="s9m-h">${title}</h2>${sub ? `<p class="s9m-sub">${sub}</p>` : ''}</div></div>`;
  }
  function build() {
    const menu = $('menu'); const sheet = menu.querySelector('.sheet');
    const st = el('style', { id: 's9m-css' }); st.textContent = CSS; document.head.appendChild(st);
    root = el('div', { id: 's9m' });
    root.innerHTML = `<div class="s9m-bg"><i></i></div>
<header class="s9m-top">
  <button type="button" class="s9m-brand" data-go="home" aria-label="Sector Nine home"><span class="s9m-mark"><span>9</span></span><b>SECTOR <em>NINE</em></b></button>
  <nav class="s9m-nav" aria-label="Main"></nav>
  <div class="s9m-util" role="toolbar" aria-label="Tools"></div>
  <div class="s9m-right"></div>
</header>
<main class="s9m-stage"></main><div class="s9m-tip" role="tooltip"></div>`;
    menu.insertBefore(root, menu.firstChild); menu.classList.add('s9m-on');
    stage = root.querySelector('.s9m-stage'); navEl = root.querySelector('.s9m-nav'); utilEl = root.querySelector('.s9m-util'); rightEl = root.querySelector('.s9m-right'); tip = root.querySelector('.s9m-tip');
    dock = el('div', { class: 's9m-dock', 'aria-hidden': 'true' }); root.appendChild(dock);
    const add = s => { stage.appendChild(s); return s; };

    /* HOME */
    const best = $('bestLine');
    scr.home = add(el('section', { class: 's9m-scr', 'data-scr': 'home', 'aria-label': 'Home' }, `<div class="s9m-home">
  <div class="s9m-hero"><div class="s9m-k">Arena shooter · 11 maps · 3 modes</div><h1>Sector <em>Nine</em></h1></div>
  <div class="s9m-choices">
    <button type="button" class="s9m-choice" id="s9mBots" style="--acc:var(--o)" data-go="bots">
      <span class="s9m-ph" id="s9mBotsPh"></span><span class="s9m-cn"></span>
      <span class="s9m-k">Solo</span><h2>Play vs bots</h2>
      <p>You against 7 bots. Everyone respawns. First to 30 kills wins.</p>
      <span class="s9m-tags" id="s9mBotsTags"><span class="s9m-tag">${svg('target')}Free for all</span><span class="s9m-tag" id="s9mBotsMap"></span></span>
      <span class="s9m-go">Choose map${svg('play')}</span>
    </button>
    <button type="button" class="s9m-choice" id="s9mMulti" style="--acc:var(--c)" data-go="browse">
      <span class="s9m-ph">${slicesHTML(['neon', 'docks', 'shrine'])}</span><span class="s9m-cn"></span>
      <span class="s9m-k">Online</span><h2>Multiplayer</h2>
      <p>Play with friends. Join an open room, or make your own and send the link.</p>
      <span class="s9m-tags"><span class="s9m-tag">${svg('target')}Free for all</span><span class="s9m-tag">${svg('teams')}Team deathmatch</span><span class="s9m-tag">${svg('bomb')}Demolition</span></span>
      <span class="s9m-go">Find a room${svg('play')}</span>
    </button>
  </div>
  <div class="s9m-foot" id="s9mFoot"></div>
</div>`));
    const foot = scr.home.querySelector('#s9mFoot');
    if (best) { best.classList.add('s9m-tag', 's9m-best'); scr.home.querySelector('#s9mBotsTags').appendChild(best); }
    const tn = sheet && sheet.querySelector('.touchnote'); if (tn) foot.appendChild(tn);

    /* BOTS */
    scr.bots = add(el('section', { class: 's9m-scr', 'data-scr': 'bots', 'aria-label': 'Play vs bots' }, headHTML('Play vs bots', 'Pick a map, then press Play.') +
`<div class="s9m-two s9m-botl">
  <div class="s9m-pvcol"><div class="s9m-prev" id="s9mBotPrev"></div>
    <div class="s9m-tags s9m-rules"><span class="s9m-tag">${svg('target')}Free for all</span><span class="s9m-tag">${svg('users')}You + 7 bots</span><span class="s9m-tag">First to 30 kills</span></div></div>
  <div class="s9m-grid" role="radiogroup" aria-label="Map" id="s9mBotGrid"></div>
  <div class="s9m-playrow" id="s9mPlayRow"></div>
</div>`));
    const play = $('btnPlay'); play.classList.add('s9m-quick'); play.classList.remove('go'); play.innerHTML = svg('play') + 'Quick play';
    play.setAttribute('aria-label', 'Quick play: a bot match on your chosen map');
    const qp = el('div', { class: 's9m-qp' }); qp.appendChild(play); qp.appendChild(el('span', { class: 's9m-qpt', id: 's9mQpT' }));
    scr.home.querySelector('#s9mFoot').prepend(qp);
    const play2 = el('button', { type: 'button', class: 's9m-cta', id: 's9mPlay' }, svg('play') + 'Play');
    play2.addEventListener('click', () => $('btnPlay').click());
    scr.bots.querySelector('#s9mPlayRow').prepend(play2);

    /* BROWSE */
    scr.browse = add(el('section', { class: 's9m-scr', 'data-scr': 'browse', 'aria-label': 'Multiplayer' }, headHTML('Multiplayer', 'Join an open room, or create your own.') +
`<div class="s9m-browse">
  <div>
    <div class="s9m-filters"><div class="s9m-seg" role="radiogroup" aria-label="Filter by mode" id="s9mFilter">
      <button type="button" role="radio" data-f="all">All</button><button type="button" role="radio" data-f="ffa">Free for all</button><button type="button" role="radio" data-f="tdm">Team deathmatch</button><button type="button" role="radio" data-f="demo">Demolition</button>
    </div><span id="s9mCountSlot"></span></div>
    <div id="s9mListSlot"></div>
    <div id="s9mEmpty" class="s9m-empty" hidden><span class="s9m-ph">${slicesHTML(['grid', 'caverns', 'foundry'])}</span><b>No open rooms yet</b><span>Create one and send your friends the link. New rooms show up here right away.</span><button type="button" class="s9m-cta cy" data-go="create">${svg('plus')}Create room</button></div>
  </div>
  <aside class="s9m-side">
    <div class="s9m-panel"><div class="s9m-field" id="s9mNickSlotB"></div>
      <button type="button" class="s9m-cta cy" data-go="create" style="width:100%">${svg('plus')}Create room</button></div>
    <div class="s9m-panel"><label class="s9m-lab" for="s9mCode">Have a room code?</label>
      <div class="s9m-codein"><input id="s9mCode" maxlength="8" autocomplete="off" spellcheck="false" placeholder="e.g. EZ8LQ"><button type="button" class="s9m-btn" id="s9mCodeGo">Join</button></div></div>
    <div class="s9m-msgrow" id="s9mMsgSlotB"></div>
  </aside>
</div>`));

    /* CREATE */
    scr.create = add(el('section', { class: 's9m-scr', 'data-scr': 'create', 'aria-label': 'Create a room' }, headHTML('Create a room', 'Pick the mode and map. You can change them later in the lobby.') +
`<div class="s9m-create">
  <div class="s9m-panel">
    <div class="s9m-pair"><div class="s9m-field" id="s9mNickSlotC"></div><div class="s9m-field" id="s9mNameSlot"></div></div>
    <div class="s9m-field"><span class="s9m-lab">Mode</span><div class="s9m-cards" role="radiogroup" aria-label="Mode" id="s9mModes"></div></div>
    <div class="s9m-field" id="s9mBalF" hidden><span class="s9m-lab">Team balance</span><div class="s9m-cards s9m-cards2" role="radiogroup" aria-label="Team balance" id="s9mBal"></div></div>
    <div class="s9m-field"><span class="s9m-lab">Who can join</span><div class="s9m-cards" role="radiogroup" aria-label="Who can join" id="s9mVis"></div></div>
    <div class="s9m-pair"><div class="s9m-field"><span class="s9m-lab">Players</span><div class="s9m-chips" role="radiogroup" aria-label="Players" id="s9mSize"></div></div>
    <div class="s9m-field" id="s9mKillsF"><span class="s9m-lab">Kills to win</span><div class="s9m-chips" role="radiogroup" aria-label="Kills to win" id="s9mKills"></div><span class="s9m-sub" id="s9mRounds" hidden>Demolition: first team to 7 rounds.</span></div></div>
  </div>
  <div>
    <div class="s9m-prev" id="s9mCrPrev"></div>
    <div class="s9m-grid" role="radiogroup" aria-label="Map" id="s9mCrGrid"></div>
  </div>
</div>
<div class="s9m-bottom"><span class="s9m-sum" id="s9mSum"></span><span class="s9m-msgrow" id="s9mMsgSlotC" style="margin:0"></span></div>`));
    const bc = $('btnCreate'); bc.classList.add('s9m-cta'); bc.innerHTML = svg('plus') + 'Create room'; scr.create.querySelector('.s9m-bottom').appendChild(bc);

    /* LOBBY: #oRoom becomes the screen body */
    scr.lobby = add(el('section', { class: 's9m-scr', 'data-scr': 'lobby', 'aria-label': 'Room lobby' }));
    buildLobby();

    /* CONTROLS (how to play) */
    scr.controls = add(el('section', { class: 's9m-scr', 'data-scr': 'controls', 'aria-label': 'Controls' }, headHTML('Controls', 'Keyboard and mouse. You can change any key in Settings.') + '<div class="s9m-ctl"><div class="s9m-panel" id="s9mKeys"></div><div class="s9m-panel" id="s9mTips"><span class="s9m-lab">Good to know</span></div></div>'));
    const keys = sheet && sheet.querySelector('.keys'); if (keys) scr.controls.querySelector('#s9mKeys').appendChild(keys);
    const tips = sheet && [...sheet.querySelectorAll(':scope>.note')].find(n => /Head shots/.test(n.textContent)); if (tips) { tips.classList.add('s9m-tips'); scr.controls.querySelector('#s9mTips').appendChild(tips); }
    if (keys) for (const k of keys.querySelectorAll('kbd')) if (/maps/i.test(k.textContent)) { k.classList.add('s9m-hide'); if (k.nextElementSibling) k.nextElementSibling.classList.add('s9m-hide'); }


    // core elements that must keep existing but are now driven by the new UI
    const mapLab = $('mapSel') && $('mapSel').closest('label'); if (mapLab) dock.appendChild(mapLab);
    dock.appendChild($('btnOnline'));

    // controls button (mine) in the tools
    addNavButton({ id: 's9mControls', label: 'Controls', icon: 'controls', slot: 'util', onClick: () => show('controls') });

    buildBotGrid(); buildCreate(); wireBrowse();
    root.addEventListener('click', onClick);
    root.addEventListener('keydown', gridKeys);
    root.addEventListener('dragstart', e => { const c = e.target.closest && e.target.closest('.oplayer.drag'); if (!c) return; e.dataTransfer.setData('text/s9pid', c.dataset.pid); e.dataTransfer.effectAllowed = 'move'; c.classList.add('dragging'); });
    root.addEventListener('dragend', e => { const c = e.target.closest && e.target.closest('.oplayer'); if (c) c.classList.remove('dragging'); for (const x of root.querySelectorAll('.s9m-team.over')) x.classList.remove('over'); });
    root.addEventListener('dragover', e => { const col = e.target.closest && e.target.closest('#oPlayers.manual [data-col=atk], #oPlayers.manual [data-col=def]'); if (!col || ![...e.dataTransfer.types].includes('text/s9pid')) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; col.classList.add('over'); });
    root.addEventListener('dragleave', e => { const col = e.target.closest && e.target.closest('.s9m-team'); if (col && !col.contains(e.relatedTarget)) col.classList.remove('over'); });
    root.addEventListener('drop', e => { const col = e.target.closest && e.target.closest('#oPlayers.manual [data-col=atk], #oPlayers.manual [data-col=def]'); if (!col) return; e.preventDefault(); col.classList.remove('over');
      const id = e.dataTransfer.getData('text/s9pid'), r = netRoom(); if (id && r && r.isHost && r.send) { const p = r.meta && r.meta.players && r.meta.players.find(q => q.id === id); if (!p || p.team !== col.dataset.col) r.send({ k: 'setTeam', id, team: col.dataset.col }); } });
    root.addEventListener('pointerover', tipShow); root.addEventListener('pointerout', tipHide); root.addEventListener('focusin', tipShow); root.addEventListener('focusout', tipHide);
    ST.built = true;
  }

  function buildLobby() {
    const oRoom = $('oRoom'); scr.lobby.appendChild(oRoom); oRoom.classList.remove('opane'); oRoom.classList.add('s9m-room-l');
    const banner = el('div', { class: 's9m-banner', id: 's9mBanner' }, `<span class="s9m-ph"><img id="s9mBanImg" alt=""></span>
<span class="s9m-code"><span>Room code</span><b id="s9mBanCode"></b></span>
<div class="s9m-k" id="s9mBanK">Room lobby</div><h2 id="s9mBanName"></h2><div class="s9m-tags" id="s9mBanTags"></div>`);
    oRoom.insertBefore(banner, oRoom.firstChild);
    const pl = el('div', { class: 's9m-pl' }, `<span class="s9m-lab"><span>Players</span><span id="s9mPlCount"></span></span>`);
    pl.appendChild($('oPlayers')); oRoom.insertBefore(pl, banner.nextSibling);
    const side = el('div', { class: 's9m-lside' }); oRoom.insertBefore(side, pl.nextSibling);
    const btnStart = $('btnStart'), btnCopy = $('btnCopy'), btnLeave = $('btnLeave'), row = btnStart.closest('.row');
    side.appendChild($('oWait')); side.appendChild(row);
    btnStart.classList.add('s9m-cta'); btnStart.classList.remove('go');
    const inv = el('div', { class: 's9m-panel', id: 's9mInvite' }, `<span class="s9m-lab">Invite</span><div style="display:grid;gap:8px" id="s9mInvBtns"></div><p class="s9m-sub" id="s9mVisLine" style="margin-top:10px"></p>`);
    side.appendChild(inv);
    const fr = el('button', { type: 'button', class: 's9m-btn', id: 's9mInviteFriends' }, svg('friends') + 'Invite friends');
    inv.querySelector('#s9mInvBtns').append(fr, btnCopy);
    btnCopy.classList.add('s9m-btn'); btnCopy.innerHTML = svg('link') + 'Copy invite link';
    btnLeave.classList.add('s9m-btn'); btnLeave.innerHTML = svg('door') + 'Leave room';
    side.appendChild(btnLeave);
    side.appendChild(el('div', { class: 's9m-msgrow', id: 's9mMsgSlotL' }));
    const edit = $('oEdit'); oRoom.appendChild(edit); edit.classList.add('s9m-panel');
    // visibility for the host (sent as meta.vis; the server decides what to do with it)
    const ve = el('div', { class: 's9m-vis-edit' }, `<span class="s9m-lab" style="margin-top:12px">Who can join</span><div class="s9m-cards" role="radiogroup" aria-label="Who can join" id="s9mVisEdit"></div>`);
    edit.appendChild(ve);
    $('btnSaveRoom').classList.add('s9m-btn');
  }

  /* ------------------------------------------------------------------ bots: map grid + preview */
  function mapCardHTML(id, name, sel, attr) {
    const thumb = id === 'random' ? slicesHTML(['yard', 'glacier', 'neon']) : `<img src="${THUMB(id)}" alt="" loading="lazy" decoding="async">`;
    return `<button type="button" class="s9m-map" role="radio" ${attr}="${esc(id)}" aria-checked="${sel ? 'true' : 'false'}" title="${esc(name)}"><span class="s9m-th">${thumb}</span><b>${esc(name)}</b><span class="s9m-ok">${svg('check')}</span></button>`;
  }
  function buildBotGrid() {
    const cur = mapPrefNow();
    $('s9mBotGrid').innerHTML = mapCardHTML('random', 'Random rotation', cur === 'random', 'data-bmap') + mapsList().map(m => mapCardHTML(m.id, m.name, cur === m.id, 'data-bmap')).join('');
    renderBotPrev();
  }
  function prevHTML(id, sub) {
    if (id === 'random') return `${slicesHTML(['yard', 'foundry', 'orbital'])}<div class="s9m-cap"><b>Random rotation</b><span>A different map every match.</span></div>`;
    const m = mapById(id) || {}; return `<img src="${IMG(id)}" alt="${esc(m.name || id)}" decoding="async"><div class="s9m-cap"><b>${esc(m.name || id)}</b><span>${esc(sub != null ? sub : m.tag || '')}</span></div>`;
  }
  function renderBotPrev() {
    const cur = mapPrefNow();
    const pv = $('s9mBotPrev'); if (pv && pv.dataset.id !== cur) { pv.dataset.id = cur; pv.innerHTML = prevHTML(cur); }
    for (const b of document.querySelectorAll('#s9mBotGrid [data-bmap]')) b.setAttribute('aria-checked', b.dataset.bmap === cur ? 'true' : 'false');
    const home = $('s9mBotsPh'), id = cur === 'random' ? 'yard' : cur;
    if (home && home.dataset.id !== id) { home.dataset.id = id; home.innerHTML = `<img src="${IMG(id)}" alt="" decoding="async">`; }
    const t = $('s9mBotsMap'); if (t) t.textContent = 'Map: ' + (cur === 'random' ? 'Random' : mapNm(cur));
    const q = $('s9mQpT'); if (q) q.textContent = 'Straight into a bot match · ' + (cur === 'random' ? 'random map' : mapNm(cur));
  }
  function pickBotMap(id) {
    const sel = $('mapSel'); if (!sel) return;
    sel.value = id;
    // same as the old <select>, minus the full-screen map load on every click: the map loads when Play is pressed
    try { mapPref = id; } catch (e) { sel.dispatchEvent(new Event('change')); }
    try { localStorage.setItem('sector9-map', id); } catch (e) {}
    renderBotPrev();
  }

  /* ------------------------------------------------------------------ create: mode / size / kills / visibility / map */
  function radioSet(box, attr, val) { for (const b of box.querySelectorAll(`[${attr}]`)) b.setAttribute('aria-checked', b.getAttribute(attr) === String(val) ? 'true' : 'false'); }
  function setSelect(id, v, ev = 'change') { const s = $(id); if (!s) return; s.value = String(v); s.dispatchEvent(new Event(ev, { bubbles: true })); if (ev !== 'change') s.dispatchEvent(new Event('change', { bubbles: true })); }
  function buildCreate() {
    const nameLab = $('rName').closest('label'); const slot = $('s9mNameSlot');
    slot.innerHTML = '<label class="s9m-lab" for="rName">Room name</label>'; slot.appendChild($('rName'));
    $('rName').placeholder = 'e.g. Friday night';
    if (nameLab) dock.appendChild(nameLab);   // the old label (now empty) stays out of sight
    for (const id of ['rSize', 'rMap', 'rKills']) { const l = $(id).closest('label'); if (l) dock.appendChild(l); }
    $('s9mModes').innerHTML = Object.entries(MODES).map(([k, m]) => `<button type="button" class="s9m-card" role="radio" data-s9mode="${k}" aria-checked="false">${svg(MODE_ICON[k])}<b>${m.name}</b><span>${m.line}</span></button>`).join('');
    $('s9mSize').innerHTML = [2, 3, 4, 5, 6, 7, 8].map(n => `<button type="button" class="s9m-chip" role="radio" data-size="${n}" aria-checked="false" aria-label="${n} players">${n}</button>`).join('');
    $('s9mKills').innerHTML = [10, 15, 20, 30].map(n => `<button type="button" class="s9m-chip" role="radio" data-kills="${n}" aria-checked="false" aria-label="${n} kills">${n}</button>`).join('');
    const vis = (box, attr) => { box.innerHTML = Object.entries(VIS).map(([k, v]) => `<button type="button" class="s9m-card" role="radio" ${attr}="${k}" aria-checked="false">${svg(VIS_ICON[k])}<b>${v.name}</b><span>${v.line}</span></button>`).join(''); };
    vis($('s9mVis'), 'data-vis'); vis($('s9mVisEdit'), 'data-evis');
    $('s9mBal').innerHTML = Object.entries(BAL).map(([k, v]) => `<button type="button" class="s9m-card" role="radio" data-bal="${k}" aria-checked="false">${svg(k === 'auto' ? 'shuffle' : 'teams')}<b>${v.name}</b><span>${v.line}</span></button>`).join('');
    $('s9mCrGrid').innerHTML = mapsList().map(m => mapCardHTML(m.id, m.name, false, 'data-cmap')).join('');
    $('rMap').addEventListener('change', syncCreate);
    syncCreate();
  }
  function curMode() { const s = $('rMode'); return s ? s.value : 'ffa'; }
  function syncCreate() {
    if (!ST.built) return;
    const mode = curMode(), size = +$('rSize').value || 4, kills = +$('rKills').value || 15, map = $('rMap').value;
    const hasModes = !!$('rMode');
    for (const b of $('s9mModes').querySelectorAll('[data-s9mode]')) { b.disabled = !hasModes && b.dataset.s9mode !== 'ffa'; b.setAttribute('aria-checked', b.dataset.s9mode === mode ? 'true' : 'false'); }
    const min = (MODES[mode] || MODES.ffa).min;
    for (const b of $('s9mSize').querySelectorAll('[data-size]')) { b.disabled = +b.dataset.size < min; }
    radioSet($('s9mSize'), 'data-size', size); radioSet($('s9mKills'), 'data-kills', kills); radioSet($('s9mVis'), 'data-vis', ST.vis);
    $('s9mBalF').hidden = mode === 'ffa'; radioSet($('s9mBal'), 'data-bal', ST.balance);
    $('s9mKills').hidden = mode === 'demo'; $('s9mRounds').hidden = mode !== 'demo'; $('s9mKillsF').querySelector('.s9m-lab').textContent = mode === 'demo' ? 'Rounds' : 'Kills to win';
    for (const b of $('s9mCrGrid').querySelectorAll('[data-cmap]')) b.setAttribute('aria-checked', b.dataset.cmap === map ? 'true' : 'false');
    const pv = $('s9mCrPrev'); if (pv.dataset.id !== map) { pv.dataset.id = map; pv.innerHTML = prevHTML(map); }
    $('s9mSum').innerHTML = `<b>${esc((MODES[mode] || MODES.ffa).name)}</b> · ${esc(mapNm(map))} · ${size} players · ${mode === 'demo' ? 'first to 7 rounds' : `first to ${kills} kills`} · <b>${esc(VIS[ST.vis].name)}</b>${mode !== 'ffa' ? ' · teams: ' + esc(BAL[ST.balance].name.toLowerCase()) : ''}`;
  }
  function setMode(k) {
    if (!$('rMode') && k !== 'ffa') return;
    if ($('rMode')) setSelect('rMode', k);
    if ((MODES[k] || MODES.ffa).min > (+$('rSize').value || 4)) setSelect('rSize', MODES[k].min);
    syncCreate();
  }
  function setVis(v, fromEdit) {
    if (!VIS[v]) return; ST.vis = v; try { localStorage.setItem('sector9-roomvis', v); } catch (e) {}
    if (fromEdit) { const r = netRoom(); if (r && r.isHost) { r.vis = v; try { r.setMeta({ vis: v }); } catch (e) {} renderLobby(r.meta); } }
    syncCreate();
  }

  /* ------------------------------------------------------------------ browse: room list with thumbnails */
  function wireBrowse() {
    $('s9mCountSlot').appendChild($('oCount'));
    $('s9mListSlot').appendChild($('roomList'));
    radioSet($('s9mFilter'), 'data-f', ST.filter);
    $('s9mCode').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); joinCode(); } });
    $('s9mCodeGo').addEventListener('click', joinCode);
  }
  function joinCode() {
    const c = String($('s9mCode').value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (c.length < 4) { msg('Type the room code (4 to 8 letters or numbers).', true); $('s9mCode').focus(); return; }
    if (typeof openRoom === 'function') openRoom(false, c);
  }
  function msg(t, err) { if (typeof onlineMsg === 'function') onlineMsg(t, err); }
  function renderRooms(rooms) {
    const list = $('roomList'); if (!list || $('oBrowse').hidden) return;
    const NET = S9() && S9().NET;
    let rs = (rooms || []).filter(r => r && (!NET || !NET.room || r.code !== NET.room.code)).sort((a, b) => (a.started - b.started) || (b.count - a.count));
    const total = rs.length;
    if (ST.filter !== 'all') rs = rs.filter(r => (r.mode || 'ffa') === ST.filter);
    $('oCount').textContent = total ? `${total} open room${total > 1 ? 's' : ''}` + (ST.filter !== 'all' ? ` · ${rs.length} shown` : '') : '';
    list.innerHTML = rs.map(r => {
      const full = (r.count | 0) >= (r.size | 0), mode = MODES[r.mode] ? r.mode : 'ffa', m = mapById(r.map);
      const pct = Math.min(100, Math.round((r.count | 0) / Math.max(1, r.size | 0) * 100));
      return `<div class="s9m-room"><span class="s9m-th">${m ? `<img src="${THUMB(m.id)}" alt="" loading="lazy" decoding="async">` : ''}</span>
<div class="s9m-rn"><b>${esc(r.name)}</b><span>${esc(m ? m.name : r.map || '')}${r.host ? ' · host ' + esc(r.host) : ''}</span>
<span class="s9m-tags"><span class="s9m-tag s9m-mode-${mode}">${svg(MODE_ICON[mode])}${esc(MODES[mode].name)}</span><span class="s9m-tag">${mode === 'demo' ? 'First to 7 rounds' : `First to ${r.kills | 0}`}</span></span></div>
<div class="s9m-cnt"><b>${r.count | 0}<small>/${r.size | 0}</small></b><span class="s9m-bar"><i style="width:${pct}%"></i></span><em class="${r.started ? 'live' : full ? 'full' : ''}">${r.started ? 'In match' : full ? 'Full' : 'Waiting'}</em></div>
<button type="button" class="go" data-room="${esc(r.code)}"${full ? ' disabled' : ''} aria-label="${full ? 'Room full' : 'Join ' + esc(r.name)}">${full ? 'Full' : 'Join'}</button></div>`;
    }).join('');
    if (window.S9Session && S9Session.markRejoin) S9Session.markRejoin(rs);
    $('s9mEmpty').hidden = rs.length > 0; root.toggleAttribute('data-empty', !rs.length);
    const e = $('s9mEmpty'); if (!rs.length) e.querySelector('b').textContent = total ? 'No rooms in this mode' : 'No open rooms yet';
  }

  /* ------------------------------------------------------------------ lobby */
  const netRoom = () => { const N = S9() && S9().NET; return N && N.room; };
  function renderLobby(m) {
    if (!m || !ST.built) return; ST.lastMeta = m;
    const r = netRoom(), host = !!r && (m.hostId != null && r.myId != null ? m.hostId === r.myId : !!r.isHost), mode = MODES[m.mode] ? m.mode : 'ffa';
    const vis = m.vis || (r && r.vis) || null;
    const img = $('s9mBanImg'); if (img.dataset.id !== m.map) { img.dataset.id = m.map; img.src = IMG(m.map); }
    $('s9mBanName').textContent = m.name || 'Room';
    $('s9mBanCode').textContent = r ? r.code : '';
    $('s9mBanK').textContent = m.started ? 'Match running' : host ? 'Your room · you are the host' : 'Room lobby';
    $('s9mBanTags').innerHTML = `<span class="s9m-tag s9m-mode-${mode}">${svg(MODE_ICON[mode])}${esc(MODES[mode].name)}</span><span class="s9m-tag">${esc(mapNm(m.map))}</span><span class="s9m-tag">${mode === 'demo' ? 'First to 7 rounds' : 'First to ' + (m.kills | 0) + ' kills'}</span>${vis && VIS[vis] ? `<span class="s9m-tag">${svg(VIS_ICON[vis])}${esc(VIS[vis].name)}</span>` : ''}`;
    $('s9mPlCount').textContent = `${m.count | 0} / ${m.size | 0}`;
    // team columns for team modes. Auto: read-only, the server balances. Manual: players join a team (any split), the
    // host moves anyone (drag a card or the swap button) and can lock the teams.
    const box = $('oPlayers');
    if (mode !== 'ffa' && Array.isArray(m.players)) {
      const bal = m.balance === 'manual' ? 'manual' : 'auto', lock = !!m.teamLock, manual = bal === 'manual', open = !m.started;
      const cols = { atk: [], def: [], none: [] };
      for (const p of m.players) (cols[p.team] || cols.none).push(p);
      const me = r && r.myId, mine = (m.players.find(p => p.id === me) || {}).team;
      const canMove = host && manual && open, canJoin = manual && open && (!lock || host);
      const other = t => t === 'atk' ? 'def' : 'atk';
      const card = p => { const c = (window.NET_COLORS || (typeof NET_COLORS !== 'undefined' ? NET_COLORS : null) || [[.6, .6, .6]]); const rgb = c[(p.c | 0) % c.length].map(x => Math.round(Math.min(1, x) * 255));
        const mv = !canMove ? '' : p.team ? `<button type="button" class="s9m-mv" data-move="${esc(p.id)}" data-to="${other(p.team)}" title="Move to ${TEAMS[other(p.team)].name}" aria-label="Move ${esc(p.n)} to ${TEAMS[other(p.team)].name}">⇄</button>`
          : `<button type="button" class="s9m-mv" data-move="${esc(p.id)}" data-to="atk" style="--tc:${TEAMS.atk.css}" title="Move to Strike Force" aria-label="Move ${esc(p.n)} to Strike Force">SF</button><button type="button" class="s9m-mv" data-move="${esc(p.id)}" data-to="def" style="--tc:${TEAMS.def.css}" title="Move to Sentinels" aria-label="Move ${esc(p.n)} to Sentinels">SE</button>`;
        return `<div class="oplayer${canMove ? ' drag' : ''}" data-pid="${esc(p.id)}"${canMove ? ' draggable="true"' : ''}><i style="background:rgb(${rgb})"></i><b>${esc(p.n)}</b>${p.host ? '<em>Host</em>' : ''}${p.id === me ? '<span>you</span>' : ''}${mv}</div>`; };
      const col = t => `<div class="s9m-team" data-col="${t}" style="--tc:${TEAMS[t].css}"><header><b>${TEAMS[t].name}</b><small>${cols[t].length}</small>${canJoin && mine !== t ? `<button type="button" data-team="${t}">Join this team</button>` : ''}</header>${cols[t].map(card).join('') || `<div class="oplayer empty"><b>${canMove ? 'Drop a player here' : 'No one yet'}</b></div>`}</div>`;
      const note = !open ? 'Match running. Teams can change between matches.' : !manual ? 'Teams are balanced automatically when the match starts.' : lock ? (host ? 'Teams are locked: only you can move players.' : 'The host locked the teams.') : host ? 'Players pick their team. Drag a player or use ⇄ to move them. Any split is allowed.' : 'Pick your team. Any split is allowed.';
      const tools = host && open ? `<div class="s9m-teamtools"><div class="s9m-seg" role="radiogroup" aria-label="Team balance"><button type="button" role="radio" data-lbal="auto" aria-checked="${!manual}">Auto teams</button><button type="button" role="radio" data-lbal="manual" aria-checked="${manual}">Manual teams</button></div>${manual ? `<button type="button" class="s9m-btn s9m-lock" data-lock="${lock ? 0 : 1}" aria-pressed="${lock}">${svg('lock')}${lock ? 'Teams locked' : 'Lock teams'}</button>` : ''}</div>` : '';
      box.className = 's9m-teams' + (manual ? ' manual' : ' auto') + (lock ? ' locked' : '');
      box.innerHTML = tools + `<p class="s9m-tnote">${esc(note)}</p>` + col('atk') + col('def') + (cols.none.length ? `<div class="s9m-team none" data-col="none"><header><b>Not on a team yet</b></header><div class="s9m-nonegrid">${cols.none.map(card).join('')}</div></div>` : '');
    } else box.className = '';
    const bs = $('btnStart');
    if (host && !m.started && bs.disabled) { const left = Math.max(1, (MODES[mode] || MODES.ffa).min - (m.count | 0)); bs.textContent = `Need ${left} more player${left > 1 ? 's' : ''} to start`; }
    // invite
    const fr = $('s9mInviteFriends'); const F = window.S9Friends; fr.hidden = !(F && typeof F.inviteToRoom === 'function');
    $('s9mVisLine').textContent = vis === 'private' ? 'Private room: only people with the link or code can join.' : vis === 'friends' ? 'Friends only: your friends can see it. Anyone else needs the link.' : 'Send the link, or tell friends the room code.';
    radioSet($('s9mVisEdit'), 'data-evis', vis || 'public');
  }

  /* ------------------------------------------------------------------ nav buttons */
  function setIcon(b, icon) {
    if (!icon) return;
    if (/^<svg/i.test(icon)) b.style.setProperty('--ico', 'url("data:image/svg+xml,' + encodeURIComponent(icon.replace(/currentColor/g, '#000')) + '")');
    else if (/^(https?:|data:|assets\/|\.\/|\/)/.test(icon)) b.style.setProperty('--ico', `url("${icon}")`);
    else b.style.setProperty('--ico', iconUrl(icon));
  }
  function placeButton(b) {
    if (!b || !b.id || CORE.has(b.id) || b.closest('#onlinePanel')) return;
    const k = KNOWN[b.id] || (b.dataset.s9slot ? [b.dataset.s9slot, +b.dataset.s9order || 50, b.dataset.s9label || b.textContent.trim(), b.dataset.s9icon] : ['nav', 60, b.textContent.trim(), b.dataset.s9icon || 'plus']);
    const [slot, order, label, icon] = k; const host = slot === 'util' ? utilEl : slot === 'wallet' ? rightEl : navEl;
    b.dataset.s9order = order; b.dataset.s9slot = slot;
    if (!b.style.getPropertyValue('--ico')) setIcon(b, icon);
    if (slot === 'util' && !b.getAttribute('aria-label')) b.setAttribute('aria-label', label);
    b.dataset.tip = label;
    // keep the order stable without moving buttons that are already in place (moving a focused button would blur it)
    const sibs = [...host.children].filter(x => x !== b && x.id !== 's9a-chip');
    const after = sibs.filter(x => (+x.dataset.s9order || 0) <= order).pop();
    const want = after ? after.nextSibling : host.firstChild;
    if (b.parentNode !== host || (b.previousElementSibling !== (after || null) && !(slot === 'wallet'))) host.insertBefore(b, want === b ? b.nextSibling : want);
  }
  let adopting = false;
  function adopt() {
    if (!ST.built || adopting) return; adopting = true;
    try {
      const menu = $('menu'), sheet = menu.querySelector('.sheet');
      for (const id of Object.keys(KNOWN)) { const b = $(id); if (b && b.parentNode && (!root.contains(b) || b.parentNode === dock || b.closest('.s9m-dock'))) placeButton(b); else if (b && root.contains(b) && !b.dataset.s9slot) placeButton(b); }
      // anything else another module put into the old menu row (or next to our buttons)
      const stray = [...(sheet ? sheet.querySelectorAll('button') : []), ...dock.querySelectorAll('button')].filter(b => b.id && !CORE.has(b.id) && !b.closest('#onlinePanel') && !b.closest('.settings'));
      for (const b of stray) placeButton(b);
      for (const b of navEl.querySelectorAll('button:not([data-s9slot])')) placeButton(b);
      const chip = $('s9a-chip'); if (chip && chip.parentNode !== rightEl) rightEl.appendChild(chip);
      const shop = $('btnShop'); if (shop && shop.parentNode === rightEl && chip && shop.nextSibling !== chip) rightEl.insertBefore(shop, chip);
    } finally { adopting = false; }
  }

  function addNavButton(o) {
    o = o || {}; if (!o.id) o.id = 's9mNav' + Math.random().toString(36).slice(2, 7);
    let b = $(o.id);
    if (!b) { b = el('button', { type: 'button', class: 'ghost', id: o.id }); b.textContent = o.label || o.id; if (typeof o.onClick === 'function') b.addEventListener('click', e => o.onClick(e)); }
    b.dataset.s9slot = o.slot || (KNOWN[o.id] ? KNOWN[o.id][0] : 'nav'); b.dataset.s9order = o.order != null ? o.order : KNOWN[o.id] ? KNOWN[o.id][1] : 60;
    b.dataset.s9label = o.label || ''; if (o.icon) { b.dataset.s9icon = typeof o.icon === 'string' && o.icon.length < 40 ? o.icon : ''; setIcon(b, o.icon); }
    if (!navEl) { (pending || (pending = [])).push([b, o]); return b; }
    if (!KNOWN[o.id]) KNOWN[o.id] = [b.dataset.s9slot, +b.dataset.s9order, o.label || o.id, o.icon];
    placeButton(b); if (o.badge != null) setBadge(o.id, o.badge); return b;
  }
  let pending = null;
  function setBadge(id, n) {
    const b = $(id); if (!b) return; let s = b.querySelector('.s9m-badge');
    if (!n) { if (s) s.remove(); return; }
    if (!s) { s = el('b', { class: 's9m-badge' }); b.appendChild(s); } s.textContent = typeof n === 'number' && n > 99 ? '99+' : String(n);
  }
  function addPanel(id, node, opts) {
    opts = opts || {}; if (!id || scr[id]) return scr[id] || null;
    const s = el('section', { class: 's9m-scr', 'data-scr': id, 'aria-label': opts.title || id }, opts.noHead ? '' : headHTML(esc(opts.title || ''), esc(opts.sub || '')));
    if (node) s.appendChild(node); scr[id] = s; ST.panels[id] = opts; (stage || document.createElement('div')).appendChild(s); return s;
  }

  /* ------------------------------------------------------------------ tooltips for icon-only buttons */
  function tipShow(e) {
    const b = e.target.closest && e.target.closest('[data-tip]'); if (!b || !root.contains(b)) return;
    if (b.dataset.s9slot === 'nav' && parseFloat(getComputedStyle(b).fontSize) > 1) return;   // labelled: no tooltip needed
    tip.textContent = b.dataset.tip; const r = b.getBoundingClientRect(), w = tip.offsetWidth;
    tip.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + 'px'; tip.style.top = (r.bottom + 8) + 'px'; tip.classList.add('on');
  }
  function tipHide() { tip.classList.remove('on'); }

  /* ------------------------------------------------------------------ navigation between screens */
  const PARENT = { home: null, bots: 'home', browse: 'home', create: 'browse', lobby: 'browse', controls: 'home' };
  function show(name, opt) {
    if (!ST.built) return; if (!scr[name]) name = 'home';
    opt = opt || {};
    // entering the multiplayer area opens the game's online panel the same way the old Online button did
    if ((name === 'browse' || name === 'create') && $('onlinePanel').hidden) { const b = $('btnOnline'); if (b) b.click(); }
    if (name === 'lobby' && $('oRoom').hidden && !netRoom()) name = 'browse';
    if (name === 'home' && !netRoom()) $('onlinePanel').hidden = true;
    if (name === 'browse' || name === 'create') {   // the name field and the status line travel with you
      const nickSlot = $(name === 'browse' ? 's9mNickSlotB' : 's9mNickSlotC'); const nick = $('nick');
      if (nick && nick.parentNode !== nickSlot) { nickSlot.innerHTML = '<label class="s9m-lab" for="nick">Your name</label>'; nickSlot.appendChild(nick); }
    }
    const msgSlot = { browse: 's9mMsgSlotB', create: 's9mMsgSlotC', lobby: 's9mMsgSlotL' }[name];
    if (msgSlot) { const row = $('onlineMsg') && $('onlineMsg').parentNode; const slot = $(msgSlot); if (row && slot && $('onlineMsg').parentNode !== slot) { slot.appendChild($('btnJoinInvite')); slot.appendChild($('onlineMsg')); } }
    if (name === 'create') { syncCreate(); }
    if (name === 'bots') renderBotPrev();
    if (name === 'browse' && ST.rooms) renderRooms(ST.rooms);
    if (name === 'lobby') { const r = netRoom(); if (r && r.meta) renderLobby(r.meta); }
    const prev = ST.screen; ST.screen = name; ST.escArm = 0; if (game() === 'menu') ST.lastGame = 'menu';   // an explicit choice wins over the late 'back from a match' re-home
    for (const k in scr) { const s = scr[k]; const on = k === name; s.classList.toggle('on', on); s.classList.toggle('out', !on && k === prev); s.setAttribute('aria-hidden', on ? 'false' : 'true'); if ('inert' in s) s.inert = !on; }
    root.dataset.screen = name;
    if (prev !== name && !opt.noFocus) {
      const s = scr[name]; s.scrollTop = 0;
      if (opt.kbd) { const f = s.querySelector('[data-back]') || s.querySelector('button'); if (f) try { f.focus({ preventScroll: true }); } catch (e) {} }
      else if (document.activeElement && root.contains(document.activeElement) && !s.contains(document.activeElement)) try { document.activeElement.blur(); } catch (e) {}
    }
    window.dispatchEvent(new CustomEvent('s9menu:screen', { detail: { screen: name, from: prev } }));
  }
  function back(kbd) {
    const cur = ST.screen;
    if (cur === 'lobby') {   // leaving a room needs a second press (or the Leave button)
      if (Date.now() - ST.escArm < 2500) { ST.escArm = 0; $('btnLeave').click(); return; }
      ST.escArm = Date.now(); msg('Press Esc again to leave the room.'); return;
    }
    const p = (ST.panels[cur] && ST.panels[cur].parent) || PARENT[cur] || (cur === 'home' ? null : 'home');
    if (p) show(p, { kbd });
  }

  function onClick(e) {
    const t = e.target.closest('button,[data-go]'); if (!t || !root.contains(t)) return;
    if (t.hasAttribute('data-back')) { sfxClick(); back(); return; }
    if (t.dataset.go) { sfxClick(); show(t.dataset.go, { kbd: e.detail === 0 }); return; }
    if (t.dataset.bmap) { sfxClick(); pickBotMap(t.dataset.bmap); return; }
    if (t.dataset.cmap) { sfxClick(); setSelect('rMap', t.dataset.cmap); syncCreate(); return; }
    if (t.dataset.s9mode) { sfxClick(); setMode(t.dataset.s9mode); return; }
    if (t.dataset.size) { sfxClick(); setSelect('rSize', t.dataset.size); syncCreate(); return; }
    if (t.dataset.kills) { sfxClick(); setSelect('rKills', t.dataset.kills); syncCreate(); return; }
    if (t.dataset.vis) { sfxClick(); setVis(t.dataset.vis); return; }
    if (t.dataset.evis) { sfxClick(); setVis(t.dataset.evis, true); return; }
    if (t.dataset.f) { sfxClick(); ST.filter = t.dataset.f; radioSet($('s9mFilter'), 'data-f', ST.filter); renderRooms(ST.rooms); return; }
    if (t.dataset.team) { const r = netRoom(); if (r && r.send) { sfxClick(); r.send({ k: 'team', team: t.dataset.team }); } return; }
    if (t.dataset.move) { const r = netRoom(); if (r && r.send && r.isHost) { sfxClick(); r.send({ k: 'setTeam', id: t.dataset.move, team: t.dataset.to }); } return; }
    if (t.dataset.lbal) { const r = netRoom(); if (r && r.isHost) { sfxClick(); ST.balance = t.dataset.lbal; try { localStorage.setItem('sector9-balance', ST.balance); } catch (e2) {} r.setMeta({ balance: t.dataset.lbal }); renderLobby(r.meta); } return; }
    if (t.dataset.lock) { const r = netRoom(); if (r && r.isHost) { sfxClick(); r.setMeta({ teamLock: t.dataset.lock === '1' }); renderLobby(r.meta); } return; }
    if (t.dataset.bal) { sfxClick(); ST.balance = t.dataset.bal; try { localStorage.setItem('sector9-balance', ST.balance); } catch (e2) {} syncCreate(); return; }
    if (t.id === 's9mInviteFriends') { const r = netRoom(), F = window.S9Friends; if (r && F && F.inviteToRoom) { try { F.inviteToRoom(r.code, Object.assign({ url: location.origin + location.pathname + '#room=' + r.code, vis: (r.meta && r.meta.vis) || r.vis || 'public' }, r.meta || {})); } catch (err) { msg('Could not open the friends list.', true); } } return; }
  }
  // arrow keys move between cards in a grid / radio group
  function gridKeys(e) {
    if (!/^Arrow/.test(e.key)) return; const g = e.target.closest('.s9m-grid,.s9m-cards,.s9m-chips,.s9m-seg'); if (!g) return;
    const items = [...g.querySelectorAll('button:not([disabled])')]; const i = items.indexOf(e.target); if (i < 0) return;
    const r0 = e.target.getBoundingClientRect(); let best = null, bd = 1e9;
    for (const it of items) { if (it === e.target) continue; const r = it.getBoundingClientRect(); const dx = (r.left + r.width / 2) - (r0.left + r0.width / 2), dy = (r.top + r.height / 2) - (r0.top + r0.height / 2);
      const ok = e.key === 'ArrowRight' ? dx > 4 && Math.abs(dy) < r0.height / 2 : e.key === 'ArrowLeft' ? dx < -4 && Math.abs(dy) < r0.height / 2 : e.key === 'ArrowDown' ? dy > 4 : dy < -4;
      if (!ok) continue; const d = Math.abs(dx) + Math.abs(dy) * 2; if (d < bd) { bd = d; best = it; } }
    if (best) { e.preventDefault(); best.focus(); }
  }

  /* ------------------------------------------------------------------ keyboard: Esc = back, Enter never starts a bot match by accident */
  function modalOpen() {
    for (const n of document.querySelectorAll('[role=dialog],[aria-modal=true],.overlay')) {
      if (n.id === 'menu' || n.id === 'pause' || n.id === 'mend' || root.contains(n) || $('menu').contains(n)) continue;
      if (n.hidden || n.closest('[hidden]') || n.closest('[aria-hidden="true"]')) continue;
      const r = n.getBoundingClientRect(); if (r.width < 2 || r.height < 2 || r.right <= 0 || r.left >= innerWidth || r.bottom <= 0 || r.top >= innerHeight) continue;
      const v = n.checkVisibility ? n.checkVisibility({ visibilityProperty: true, opacityProperty: true }) : n.offsetParent !== null || getComputedStyle(n).position === 'fixed';
      if (v) return n;
    }
    return null;
  }
  const menuUp = () => ST.built && game() === 'menu' && !$('menu').hidden;
  addEventListener('keydown', e => {
    if (e.code !== 'Enter' && e.key !== 'Enter') return;
    if (!menuUp() || modalOpen()) return;
    const a = document.activeElement, onCtl = a && a !== document.body && root.contains(a);
    // the game plays a bot match on Enter in the menu; only allow that from the home / bots screen with nothing focused
    if (onCtl || (ST.screen !== 'home' && ST.screen !== 'bots')) e.stopPropagation();
  }, true);
  addEventListener('keydown', e => {
    if (e.key !== 'Escape' && e.code !== 'Escape') return;
    if (e.defaultPrevented || !menuUp()) return;
    const m = modalOpen();
    if (m) { if (m.id === 'arsenal') { const c = $('btnArsClose'); if (c) { e.preventDefault(); c.click(); } } return; }
    if (ST.screen === 'home') return;
    e.preventDefault(); back(true);
  });

  /* ------------------------------------------------------------------ hooks into the game (wrapping globals, no index.html edits) */
  function hookGame() {
    // 1) room visibility rides along with the create-room settings (meta.vis)
    for (const n of ['serverTransport', 'roomTransport']) {
      const f = window[n]; if (typeof f !== 'function' || f.__s9m) continue;
      const w = function (code, create) { if (create && typeof create === 'object') { if (!create.vis) create.vis = ST.vis; if (!create.balance) create.balance = ST.balance; if (create.teamLock == null) create.teamLock = false; } return f.apply(this, arguments); };
      w.__s9m = true; window[n] = w;
    }
    // 2) room list: our cards with map thumbnails (same data-room Join buttons the game listens for)
    if (typeof renderRoomList === 'function' && !renderRoomList.__s9m) {
      const _rl = renderRoomList;
      const w = function (rooms) { const r = _rl.apply(this, arguments); ST.rooms = rooms || []; try { renderRooms(ST.rooms); } catch (e) {} return r; };
      w.__s9m = true; window.renderRoomList = w;
      try { if (LOBBY && LOBBY.onList === _rl) LOBBY.onList = w; } catch (e) {}
    }
    // 3) lobby banner / teams after the game (and modes.js) rendered the room
    if (typeof renderRoom === 'function' && !renderRoom.__s9m) {
      const _rr = renderRoom;
      const w = function (m) { const r = _rr.apply(this, arguments); try { renderLobby(m); } catch (e) {} return r; };
      w.__s9m = true; window.renderRoom = w;
    }
    // 4) remember which visibility I created the room with (for the lobby tag, until the server echoes meta.vis)
    if (typeof openRoom === 'function' && !openRoom.__s9m) {
      const _or = openRoom;
      const w = async function (create) { const vis = ST.vis; const bs = [...root.querySelectorAll('#btnCreate,#s9mCodeGo,#roomList [data-room]')].filter(b => !b.disabled); bs.forEach(b => { b.disabled = true; }); let ok; try { ok = await _or.apply(this, arguments); } finally { bs.forEach(b => { b.disabled = false; }); } const r = netRoom(); if (ok && r && create && !r.vis) r.vis = vis; route(); return ok; };
      w.__s9m = true; window.openRoom = w;
    }
  }

  /* ------------------------------------------------------------------ follow what the game does (room joined/left, back to menu) */
  function route() {
    if (!ST.built) return;
    const inRoom = !$('oRoom').hidden && !!netRoom();
    if (inRoom && ST.screen !== 'lobby') show('lobby', { noFocus: true });
    else if (!inRoom && ST.screen === 'lobby') show($('onlinePanel').hidden ? 'home' : 'browse', { noFocus: true });
    else if (!$('onlinePanel').hidden && !inRoom && (ST.screen === 'home' || ST.screen === 'bots') && ST.wantOnline) show('browse', { noFocus: true });
  }
  function watch() {
    const mo = new MutationObserver(muts => {
      let lay = false, rt = false;
      for (const m of muts) {
        if (m.type === 'attributes') { if (m.target.id === 'oRoom' || m.target.id === 'onlinePanel') rt = true; if (m.target.id === 'menu') rt = lay = true; if (m.target.id === 'onlinePanel' && !m.target.hidden) ST.wantOnline = true; }
        else for (const n of m.addedNodes) if (n.nodeType === 1 && (n.tagName === 'BUTTON' || n.id === 's9a-chip')) lay = true;
      }
      if (lay) queueMicrotask(adopt);
      if (rt) queueMicrotask(() => { route(); ST.wantOnline = false; });
    });
    mo.observe($('menu'), { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'] });
    mo.observe(document.body, { childList: true });   // the account chip lives on <body> until we pick it up
    // the account module moves its chip when the window crosses 600px: take it back
    try { matchMedia('(max-width: 600px)').addEventListener('change', () => setTimeout(adopt, 0)); } catch (e) {}
    // invite links (#room=CODE) open the lobby straight away; a page that opens straight into a room goes there too
    setTimeout(route, 0);
    // returning to the menu after a bot match lands on home
    $('menu').addEventListener('transitionend', () => {}, { passive: true });
    ST.lastGame = game();
    setInterval(() => { const s = game(); if (s !== ST.lastGame) { if (s === 'menu' && !netRoom() && ST.screen !== 'browse') show('home', { noFocus: true }); ST.lastGame = s; } if (s === 'menu' && ST.screen === 'bots') renderBotPrev(); const bl = $('bestLine'); if (bl) bl.hidden = /^No /.test(bl.textContent); }, 400);
    $('mapSel').addEventListener('change', renderBotPrev);
  }


  /* ------------------------------------------------------------------ Friends (top-right) + live online count */
  function syncFriends() {
    const b = $('btnFriends'); if (!b || !ST.built) return;
    const F = window.S9Friends, A = window.S9Account; let c = b.querySelector('.s9m-fc');
    if (!c) { c = el('span', { class: 's9m-fc' }); const bd = b.querySelector('.s9f-badge'); bd ? b.insertBefore(c, bd) : b.appendChild(c); }
    let signed = false; try { signed = !!(A && A.token && A.token()); } catch (e) {}
    let on = 0, total = 0;
    if (signed && F && F.list) { try { const l = F.list(); total = l.length; on = l.filter(f => f.status && f.status !== 'offline').length; } catch (e) {} }
    const txt = !signed ? '<span class="w">Sign in</span>' : on ? on + '<span class="w"> online</span>' : '<span class="w">0 online</span>';
    const cls = 's9m-fc ' + (!signed ? 'none' : on ? 'in' : 'none');
    if (c.dataset.k !== cls + txt) { c.dataset.k = cls + txt; c.className = cls; c.innerHTML = txt; }
    b.dataset.online = signed ? on : -1;
    b.title = !signed ? 'Sign in to see your friends' : on + ' of ' + total + ' friends online';
  }
  let frHooked = false;
  function hookFriends() {
    syncFriends();
    const F = window.S9Friends, A = window.S9Account;
    if (!frHooked && F && F.onChange) { frHooked = true; F.onChange(syncFriends); if (A && A.onChange) A.onChange(syncFriends); }
  }
  setInterval(hookFriends, 1500);

  function init() {
    const s = S9();
    if (!s || !document.body || !$('menu') || !$('btnPlay') || !$('oRoom') || !$('roomList')) { setTimeout(init, 100); return; }
    if (ST.built) return;
    build(); hookGame(); adopt(); watch(); hookFriends();
    if (pending) { for (const [b, o] of pending) { dock.appendChild(b); addNavButton(o); } pending = null; }
    // late modules (modes.js adds #rMode after us): keep the create form in sync
    const modeWait = setInterval(() => { if ($('rMode')) { clearInterval(modeWait); $('rMode').addEventListener('change', syncCreate); syncCreate(); } }, 300);
    setTimeout(() => clearInterval(modeWait), 60000);
    // a room join that started before this module moved the buttons (invite link at boot): the game re-enables only
    // the buttons still inside #onlinePanel, so give ours back once it is done connecting
    const stuck = [...root.querySelectorAll('button:disabled')].filter(x => x.id === 'btnLeave' || x.id === 'btnCreate' || x.id === 'btnCopy' || x.id === 'btnStart' || x.id === 'btnSaveRoom' || x.id === 'btnJoinInvite');
    if (stuck.length) { const t = setInterval(() => { if (!/Connecting/i.test(($('onlineMsg') || {}).textContent || '')) { clearInterval(t); for (const x of stuck) if (x.id !== 'btnStart') x.disabled = false; if (netRoom() && netRoom().meta) try { window.renderRoom(netRoom().meta); } catch (e) {} } }, 300); setTimeout(() => clearInterval(t), 60000); }
    show(!$('oRoom').hidden && netRoom() ? 'lobby' : !$('onlinePanel').hidden ? 'browse' : 'home', { noFocus: true });
    api.ready = true; window.dispatchEvent(new Event('s9menu'));
  }

  const api = window.S9Menu = {
    ready: false, addNavButton, setBadge, addPanel, show: n => show(n), back: () => back(), screen: () => ST.screen, vis: () => ST.vis,
    setVis: v => setVis(v), syncFriends, _st: ST
  };
  init();
})();
