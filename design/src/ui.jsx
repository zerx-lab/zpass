// Shared UI helpers: Favicon, Tag, Toast

const { useState, useEffect, useRef, useCallback, useMemo } = React;
const I = window.ZPASS_ICONS;
const { FAVICONS } = window.ZPASS_DATA;

function Favicon({ item, size = 32 }) {
  const key = item.fav || (item.type === 'card' ? 'card' : item.type === 'note' ? 'note' : item.type === 'identity' ? 'id' : item.type === 'ssh' ? 'ssh' : item.type === 'wallet' ? 'wallet' : null);
  const preset = FAVICONS[key];
  if (preset) {
    return (
      <div className="fav" style={{ width: size, height: size }}>
        <span style={{ fontSize: size * 0.34, letterSpacing: '0.02em' }}>{preset.t}</span>
      </div>
    );
  }
  const glyphs = { card: '◧', note: '✎', identity: '◉', ssh: '›_', wallet: '◇' };
  const g = glyphs[item.type] || (item.name?.[0] || '?').toUpperCase();
  return (
    <div className="fav" style={{ width: size, height: size }}>
      <span style={{ fontSize: size * 0.4 }}>{g}</span>
    </div>
  );
}

function typeLabel(t, lang) {
  const zh = lang === 'zh';
  const en = { login: 'Login', card: 'Card', note: 'Note', identity: 'Identity', ssh: 'Key', wallet: 'Wallet' };
  const z  = { login: '登录', card: '银行卡', note: '笔记', identity: '身份', ssh: '密钥', wallet: '钱包' };
  return (zh ? z : en)[t] || t;
}

function fmtRel(ts, lang) {
  const zh = lang === 'zh';
  const d = Math.round((Date.now() - ts) / (24*3600*1000));
  if (d < 1) return zh ? '今天' : 'today';
  if (d < 30) return d + (zh ? '天前' : 'd');
  if (d < 365) return Math.round(d/30) + (zh ? '月前' : 'mo');
  return Math.round(d/365) + (zh ? '年前' : 'y');
}

// Toast context
const ToastCtx = React.createContext(null);
function ToastProvider({ children }) {
  const [t, setT] = useState(null);
  const show = useCallback((msg) => {
    setT({ msg, k: Date.now() });
    setTimeout(() => setT(x => x && x.msg === msg ? null : x), 2000);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {t && <div className="toast" key={t.k}><I.Check size={14} /> {t.msg}</div>}
    </ToastCtx.Provider>
  );
}
function useToast() { return React.useContext(ToastCtx); }

function copyText(txt, toast, label) {
  navigator.clipboard?.writeText(txt).catch(() => {});
  toast?.(label ? `${label} ✓` : 'Copied');
}

// Password colorizer for generator
function colorize(pw) {
  return [...pw].map((c, i) => {
    let cls = 'char-l';
    if (/[A-Z]/.test(c)) cls = 'char-u';
    else if (/[0-9]/.test(c)) cls = 'char-n';
    else if (!/[a-z]/i.test(c)) cls = 'char-s';
    return <span key={i} className={cls}>{c}</span>;
  });
}

function randomPw(opts) {
  const pools = [];
  if (opts.lower) pools.push('abcdefghijkmnopqrstuvwxyz');
  if (opts.upper) pools.push('ABCDEFGHJKLMNPQRSTUVWXYZ');
  if (opts.numbers) pools.push('23456789');
  if (opts.symbols) pools.push('!@#$%^&*-_=+?');
  if (!pools.length) return '';
  const all = pools.join('');
  let out = '';
  // Ensure at least one from each pool
  for (const p of pools) out += p[Math.floor(Math.random() * p.length)];
  while (out.length < opts.length) out += all[Math.floor(Math.random() * all.length)];
  // Shuffle
  return out.split('').sort(() => Math.random() - 0.5).join('').slice(0, opts.length);
}

function pwStrength(pw) {
  // Simple proxy: length + variety
  let s = Math.min(100, pw.length * 4);
  const pools = (/[a-z]/.test(pw)?1:0) + (/[A-Z]/.test(pw)?1:0) + (/[0-9]/.test(pw)?1:0) + (/[^a-z0-9]/i.test(pw)?1:0);
  s += pools * 6;
  if (pw.length < 8) s = Math.min(s, 30);
  if (/^(password|12345|qwerty|trustno1|summer)/i.test(pw)) s = Math.min(s, 20);
  return Math.max(0, Math.min(100, s));
}

function wordwords(n) {
  const W = ['brave','ocean','forest','magnet','ladder','silver','glove','token','crystal','wheel','echo','marble','ribbon','quiet','pyramid','orange','breeze','panel','harbor','vault','lumber','emerald','velvet','kindle','lunar','pepper','island','cedar','planet','quartz','mango','ember','twilight'];
  return Array.from({length: n}, () => W[Math.floor(Math.random()*W.length)]).join('-');
}

window.ZPASS_UI = { Favicon, typeLabel, fmtRel, ToastProvider, useToast, copyText, colorize, randomPw, pwStrength, wordwords };
