// zp-shared.jsx — shared ZPass mobile primitives, tokens, icons, helpers

// ─────────────────────────────────────────────────────────────
// Tokens — mirror the desktop design system
// ─────────────────────────────────────────────────────────────
const ZP_TOKENS = {
  dark: {
    bg: '#0c0c0d', bgElev: '#111113', bgElev2: '#16161a',
    bgHover: '#18181c', bgActive: '#1d1d22',
    line: '#232328', lineSoft: '#1a1a1e',
    text: '#ececec', text2: '#a8a8ac', text3: '#6e6e73', text4: '#45454a',
    accent: '#ececec', accentInk: '#0c0c0d',
    danger: '#e55a4a', warn: '#c8934a', ok: '#5ea47a', info: '#6b9cc4',
    grid: 'rgba(255,255,255,0.025)',
  },
  light: {
    bg: '#f5f5f3', bgElev: '#fbfbf9', bgElev2: '#ffffff',
    bgHover: '#ededea', bgActive: '#e4e4e0',
    line: '#e1e1dd', lineSoft: '#ececea',
    text: '#141416', text2: '#4a4a4e', text3: '#77777c', text4: '#a6a6aa',
    accent: '#141416', accentInk: '#f5f5f3',
    danger: '#b53d2b', warn: '#9a6a1a', ok: '#35734f', info: '#355a7a',
    grid: 'rgba(0,0,0,0.035)',
  },
};

const ZP_FONTS = {
  sans: '"Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  mono: '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
};

// ─────────────────────────────────────────────────────────────
// Icons — thin strokes, 20px, currentColor
// ─────────────────────────────────────────────────────────────
const IconLock = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
    <rect x="4" y="9" width="12" height="9" rx="1.5"/>
    <path d="M7 9V6a3 3 0 016 0v3"/>
  </svg>
);
const IconSearch = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
    <circle cx="9" cy="9" r="5.5"/><path d="M13 13l3.5 3.5"/>
  </svg>
);
const IconCopy = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M13 7V4.5A1.5 1.5 0 0011.5 3h-7A1.5 1.5 0 003 4.5v7A1.5 1.5 0 004.5 13H7"/>
  </svg>
);
const IconEye = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
    <path d="M1.5 10S4.5 4.5 10 4.5 18.5 10 18.5 10 15.5 15.5 10 15.5 1.5 10 1.5 10z"/><circle cx="10" cy="10" r="2.5"/>
  </svg>
);
const IconShield = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
    <path d="M10 2l6.5 2.5V10c0 4-3 7-6.5 8.5C6.5 17 3.5 14 3.5 10V4.5L10 2z"/>
  </svg>
);
const IconKey = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
    <circle cx="6.5" cy="10" r="3.5"/><path d="M9.5 9.5L17 9.5l-1.5 2m-2-2v2.5"/>
  </svg>
);
const IconGrid = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4">
    <rect x="3" y="3" width="6.5" height="6.5" rx="1"/><rect x="10.5" y="3" width="6.5" height="6.5" rx="1"/>
    <rect x="3" y="10.5" width="6.5" height="6.5" rx="1"/><rect x="10.5" y="10.5" width="6.5" height="6.5" rx="1"/>
  </svg>
);
const IconPlus = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <path d="M10 4v12M4 10h12"/>
  </svg>
);
const IconBack = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12.5 4.5L6 10l6.5 5.5"/>
  </svg>
);
const IconDots = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor">
    <circle cx="4.5" cy="10" r="1.4"/><circle cx="10" cy="10" r="1.4"/><circle cx="15.5" cy="10" r="1.4"/>
  </svg>
);
const IconFace = ({ size = 28 }) => (
  <svg width={size} height={size} viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
    <path d="M3 8V5.5A2.5 2.5 0 015.5 3H8M20 3h2.5A2.5 2.5 0 0125 5.5V8M25 20v2.5a2.5 2.5 0 01-2.5 2.5H20M8 25H5.5A2.5 2.5 0 013 22.5V20"/>
    <path d="M10 11v2M18 11v2M11 17c1 1 4.5 1 6 0"/>
    <path d="M14 10v5l-1 1.5"/>
  </svg>
);
const IconRefresh = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3.5 10a6.5 6.5 0 0111.3-4.4M16.5 3v3.5H13M16.5 10a6.5 6.5 0 01-11.3 4.4M3.5 17v-3.5H7"/>
  </svg>
);
const IconStar = ({ size = 18, fill = 'none' }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill={fill} stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
    <path d="M10 2.5l2.4 4.9 5.4.8-3.9 3.8.9 5.4L10 14.8l-4.8 2.6.9-5.4L2.2 8.2l5.4-.8L10 2.5z"/>
  </svg>
);
const IconShare = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="15" cy="4.5" r="2"/><circle cx="5" cy="10" r="2"/><circle cx="15" cy="15.5" r="2"/>
    <path d="M6.7 9l6.6-3.3M6.7 11l6.6 3.3"/>
  </svg>
);
const IconEdit = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 17l1-4 9-9 3 3-9 9-4 1z"/><path d="M12 5l3 3"/>
  </svg>
);
const IconAlert = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10 2l8 15H2L10 2z"/><path d="M10 8v4M10 14.5v.01"/>
  </svg>
);
const IconCheck = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 10.5L8 14.5l8-9"/>
  </svg>
);
const IconGlobe = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.3">
    <circle cx="10" cy="10" r="7"/><path d="M3 10h14M10 3c2.5 3 2.5 11 0 14M10 3c-2.5 3-2.5 11 0 14"/>
  </svg>
);

// ─────────────────────────────────────────────────────────────
// Tab bar — bottom nav, 5 tabs
// ─────────────────────────────────────────────────────────────
function ZPTabBar({ tab, setTab, t, theme = 'dark', platform = 'ios' }) {
  const c = ZP_TOKENS[theme];
  const tabs = [
    { id: 'vault', label: t('mob_tab_vault'), icon: IconGrid },
    { id: 'gen', label: t('mob_tab_gen'), icon: IconKey },
    { id: 'scan', label: '', icon: null, big: true },
    { id: 'security', label: t('mob_tab_security'), icon: IconShield },
    { id: 'settings', label: t('mob_tab_me'), icon: IconDots },
  ];
  return (
    <div style={{
      borderTop: `1px solid ${c.lineSoft}`,
      background: c.bg,
      padding: platform === 'ios' ? '6px 8px 0' : '6px 8px 6px',
      display: 'flex', alignItems: 'flex-start', justifyContent: 'space-around',
      flexShrink: 0,
    }}>
      {tabs.map(tb => {
        const active = tab === tb.id;
        if (tb.big) {
          return (
            <button key={tb.id} onClick={() => setTab && setTab(tb.id)} style={{
              width: 48, height: 48, borderRadius: 14,
              marginTop: 2,
              background: c.text, color: c.bg, border: 0,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: `0 1px 2px rgba(0,0,0,0.3)`,
              cursor: 'pointer',
            }}>
              <IconPlus size={22}/>
            </button>
          );
        }
        const Icon = tb.icon;
        return (
          <button key={tb.id} onClick={() => setTab && setTab(tb.id)} style={{
            flex: 1, background: 'none', border: 0, padding: '8px 0 4px',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
            color: active ? c.text : c.text3,
            cursor: 'pointer',
          }}>
            <Icon size={22}/>
            <span style={{
              fontFamily: ZP_FONTS.mono, fontSize: 9,
              letterSpacing: 0.04, textTransform: 'uppercase',
            }}>{tb.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Status bar — ZPass-styled, replaces platform default inside screens
// ─────────────────────────────────────────────────────────────
function ZPStatusBar({ theme = 'dark', time = '9:41', platform = 'ios' }) {
  const c = ZP_TOKENS[theme];
  return (
    <div style={{
      height: platform === 'ios' ? 54 : 40,
      display: 'flex', alignItems: platform === 'ios' ? 'center' : 'center',
      justifyContent: 'space-between',
      padding: platform === 'ios' ? '18px 28px 0 28px' : '0 16px',
      color: c.text, fontFamily: ZP_FONTS.mono,
      fontSize: platform === 'ios' ? 14 : 12,
      fontWeight: 500, fontVariantNumeric: 'tabular-nums',
      position: 'relative', flexShrink: 0,
    }}>
      <span>{time}</span>
      {platform === 'ios' && (
        <div style={{
          position: 'absolute', top: 8, left: '50%', transform: 'translateX(-50%)',
          width: 112, height: 32, borderRadius: 20, background: '#000',
        }}/>
      )}
      {platform === 'android' && (
        <div style={{
          position: 'absolute', top: 6, left: '50%', transform: 'translateX(-50%)',
          width: 20, height: 20, borderRadius: '50%', background: '#000',
        }}/>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, opacity: 0.75 }}>
        {/* signal bars */}
        <svg width="15" height="10" viewBox="0 0 15 10" fill="currentColor">
          <rect x="0" y="6" width="2.5" height="4" rx="0.4"/>
          <rect x="4" y="4" width="2.5" height="6" rx="0.4"/>
          <rect x="8" y="2" width="2.5" height="8" rx="0.4"/>
          <rect x="12" y="0" width="2.5" height="10" rx="0.4"/>
        </svg>
        {/* wifi */}
        <svg width="13" height="10" viewBox="0 0 14 10" fill="currentColor">
          <path d="M7 2c2 0 3.8.8 5.2 2.1l.9-1C11.4 1.5 9.3 0.7 7 0.7S2.6 1.5 0.9 3.1l.9 1C3.2 2.8 5 2 7 2z"/>
          <path d="M7 5c1.2 0 2.3.5 3.1 1.3l.9-1C9.9 4.2 8.5 3.7 7 3.7s-2.9.5-4 1.6l.9 1C4.7 5.5 5.8 5 7 5z"/>
          <circle cx="7" cy="8.5" r="1.2"/>
        </svg>
        {/* battery */}
        <svg width="22" height="10" viewBox="0 0 22 10">
          <rect x="0.5" y="0.5" width="18" height="9" rx="2" fill="none" stroke="currentColor" strokeOpacity="0.5"/>
          <rect x="2" y="2" width="15" height="6" rx="1" fill="currentColor"/>
          <rect x="19.5" y="3" width="1.5" height="4" rx="0.5" fill="currentColor" opacity="0.5"/>
        </svg>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Home indicator (iOS)
// ─────────────────────────────────────────────────────────────
function ZPHomeIndicator({ theme = 'dark' }) {
  const c = ZP_TOKENS[theme];
  return (
    <div style={{ height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      <div style={{
        width: 120, height: 4, borderRadius: 2,
        background: theme === 'dark' ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.5)',
      }}/>
    </div>
  );
}

// Gesture nav (Android)
function ZPGestureBar({ theme = 'dark' }) {
  const c = ZP_TOKENS[theme];
  return (
    <div style={{ height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      <div style={{
        width: 108, height: 3, borderRadius: 2,
        background: theme === 'dark' ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.45)',
      }}/>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Favicon — mono letter tile (matches desktop)
// ─────────────────────────────────────────────────────────────
function ZPFav({ t, size = 36, theme = 'dark' }) {
  const c = ZP_TOKENS[theme];
  return (
    <div style={{
      width: size, height: size, borderRadius: size * 0.22,
      background: c.bgElev2, border: `1px solid ${c.line}`,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: ZP_FONTS.mono, fontWeight: 600,
      fontSize: size * 0.36, color: c.text,
      flexShrink: 0,
    }}>{t}</div>
  );
}

// ─────────────────────────────────────────────────────────────
// Device shells — ZPass-branded iPhone / Android
//   platform-specific chrome (notch/island/punch, corners, home bar)
// ─────────────────────────────────────────────────────────────
function ZPPhone({ children, theme = 'dark', width = 390, height = 844, platform = 'ios', label, labelSub, showChrome = true }) {
  const c = ZP_TOKENS[theme];
  const r = platform === 'ios' ? 50 : 36;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 14, flexShrink: 0 }}>
      {label && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div style={{ fontFamily: ZP_FONTS.mono, fontSize: 11, color: 'rgba(40,30,20,0.85)', letterSpacing: 0.04, textTransform: 'uppercase' }}>{label}</div>
          {labelSub && <div style={{ fontFamily: ZP_FONTS.sans, fontSize: 13, color: 'rgba(60,50,40,0.6)' }}>{labelSub}</div>}
        </div>
      )}
      <div style={{
        width, height, borderRadius: r, overflow: 'hidden', position: 'relative',
        background: c.bg, color: c.text,
        fontFamily: ZP_FONTS.sans,
        WebkitFontSmoothing: 'antialiased',
        boxShadow: showChrome ? '0 30px 80px rgba(0,0,0,0.18), 0 0 0 9px #1a1a1c, 0 0 0 10px rgba(0,0,0,0.3)' : 'none',
      }}>
        {children}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Small screen-shell: gives a consistent status bar + content area + tab bar or home indicator
// ─────────────────────────────────────────────────────────────
function ZPScreen({ children, theme = 'dark', platform = 'ios', tab, setTab, t, showTabBar = true, statusBarTheme }) {
  const c = ZP_TOKENS[theme];
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%', background: c.bg, color: c.text,
    }}>
      <ZPStatusBar theme={statusBarTheme || theme} platform={platform}/>
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {children}
      </div>
      {showTabBar && <ZPTabBar tab={tab} setTab={setTab} t={t} theme={theme} platform={platform}/>}
      {platform === 'ios' ? <ZPHomeIndicator theme={theme}/> : <ZPGestureBar theme={theme}/>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Common UI pieces
// ─────────────────────────────────────────────────────────────
function ZPChip({ children, active, theme = 'dark', count }) {
  const c = ZP_TOKENS[theme];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '5px 11px', borderRadius: 999, flexShrink: 0,
      border: `1px solid ${active ? c.text : c.line}`,
      background: active ? c.text : c.bgElev,
      color: active ? c.bg : c.text2,
      fontSize: 12,
    }}>
      {children}
      {count != null && (
        <span style={{
          fontFamily: ZP_FONTS.mono, fontSize: 10, opacity: 0.7,
        }}>{count}</span>
      )}
    </span>
  );
}

function ZPTag({ children, theme = 'dark' }) {
  const c = ZP_TOKENS[theme];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 7px', borderRadius: 4,
      border: `1px solid ${c.line}`, background: c.bgElev2,
      color: c.text2, fontFamily: ZP_FONTS.mono, fontSize: 10,
    }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: c.text3 }}/>
      {children}
    </span>
  );
}

function ZPTypeBadge({ children, theme = 'dark' }) {
  const c = ZP_TOKENS[theme];
  return (
    <span style={{
      fontFamily: ZP_FONTS.mono, fontSize: 8, padding: '1px 5px',
      border: `1px solid ${c.line}`, borderRadius: 3,
      color: c.text3, textTransform: 'uppercase', letterSpacing: 0.05,
    }}>{children}</span>
  );
}

// Section header - mono, small, underlined
function ZPSectionHeader({ children, theme = 'dark', style = {} }) {
  const c = ZP_TOKENS[theme];
  return (
    <div style={{
      fontFamily: ZP_FONTS.mono, fontSize: 10, color: c.text3,
      textTransform: 'uppercase', letterSpacing: 0.08,
      padding: '14px 20px 10px',
      display: 'flex', alignItems: 'center', gap: 10,
      ...style,
    }}>
      <span>{children}</span>
      <span style={{ flex: 1, height: 1, background: c.lineSoft }}/>
    </div>
  );
}

// String labels for mobile (additive to i18n)
const MOBILE_STRINGS = {
  en: {
    mob_tab_vault: 'Vault',
    mob_tab_gen: 'Generate',
    mob_tab_security: 'Security',
    mob_tab_me: 'More',
    mob_unlock_hi: 'Welcome back',
    mob_unlock_sub: 'alex.rivera@zpass.dev',
    mob_unlock_faceid: 'Look at iPhone to unlock',
    mob_unlock_faceid_android: 'Scanning fingerprint…',
    mob_unlock_enter_pin: 'Enter master PIN',
    mob_unlock_usepw: 'Use master password',
    mob_unlock_switch: 'Switch account',
    mob_unlock_e2e: 'End-to-end encrypted · v2.4',
    mob_all: 'All',
    mob_recent: 'Recent',
    mob_pinned: 'Pinned',
    mob_breach_strip: (n) => `${n} items need attention`,
    mob_view: 'View',
    mob_rotate: 'Rotate',
    mob_swipe_hint: 'Swipe left for quick actions',
    mob_copy_user: 'Copy user',
    mob_copy_pw: 'Copy password',
    mob_copy_totp: 'Copy code',
    mob_strength: 'Strength',
    mob_reveal: 'Tap to reveal',
    mob_next_code: 'next in',
    mob_totp_hint: 'Hold to pin. Shake to switch account.',
    mob_gen_length: 'Length',
    mob_gen_mode: 'Mode',
    mob_security_score: 'Vault score',
    mob_issues: 'Issues',
    mob_widget: 'Lock screen widget',
    mob_watch: 'ZPass on Watch',
  },
  zh: {
    mob_tab_vault: '保险库',
    mob_tab_gen: '生成',
    mob_tab_security: '安全',
    mob_tab_me: '更多',
    mob_unlock_hi: '欢迎回来',
    mob_unlock_sub: 'alex.rivera@zpass.dev',
    mob_unlock_faceid: '请注视 iPhone 以解锁',
    mob_unlock_faceid_android: '正在扫描指纹…',
    mob_unlock_enter_pin: '输入主 PIN 码',
    mob_unlock_usepw: '使用主密码',
    mob_unlock_switch: '切换账户',
    mob_unlock_e2e: '端到端加密 · v2.4',
    mob_all: '全部',
    mob_recent: '最近',
    mob_pinned: '置顶',
    mob_breach_strip: (n) => `${n} 项需要处理`,
    mob_view: '查看',
    mob_rotate: '更换',
    mob_swipe_hint: '左滑显示快捷操作',
    mob_copy_user: '复制用户名',
    mob_copy_pw: '复制密码',
    mob_copy_totp: '复制验证码',
    mob_strength: '强度',
    mob_reveal: '点击显示',
    mob_next_code: '下一个',
    mob_totp_hint: '长按置顶 · 摇动切换账户',
    mob_gen_length: '长度',
    mob_gen_mode: '模式',
    mob_security_score: '保险库评分',
    mob_issues: '待处理',
    mob_widget: '锁屏小组件',
    mob_watch: '手表版 ZPass',
  },
};

Object.assign(window, {
  ZP_TOKENS, ZP_FONTS, MOBILE_STRINGS,
  IconLock, IconSearch, IconCopy, IconEye, IconShield, IconKey, IconGrid,
  IconPlus, IconBack, IconDots, IconFace, IconRefresh, IconStar, IconShare,
  IconEdit, IconAlert, IconCheck, IconGlobe,
  ZPTabBar, ZPStatusBar, ZPHomeIndicator, ZPGestureBar, ZPFav, ZPPhone, ZPScreen,
  ZPChip, ZPTag, ZPTypeBadge, ZPSectionHeader,
});
