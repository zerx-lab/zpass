// zp-detail.jsx — Item detail view

function ZPDetail({ theme = 'dark', t, item }) {
  const c = ZP_TOKENS[theme];
  const it = item;
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* header */}
      <div style={{
        padding: '6px 16px 10px',
        display: 'flex', alignItems: 'center', gap: 8,
        borderBottom: `1px solid ${c.lineSoft}`,
      }}>
        <button style={{
          width: 36, height: 36, borderRadius: 8, border: `1px solid ${c.line}`,
          background: c.bgElev, color: c.text2, display: 'inline-flex',
          alignItems: 'center', justifyContent: 'center',
        }}><IconBack size={18}/></button>
        <div style={{ flex: 1, fontFamily: ZP_FONTS.mono, fontSize: 11, color: c.text3, textAlign: 'center' }}>
          {t('topbar_vault')} <span style={{ opacity: .4, margin: '0 4px' }}>/</span> <span style={{ color: c.text2 }}>{it.name}</span>
        </div>
        <button style={{
          width: 36, height: 36, borderRadius: 8, border: `1px solid ${c.line}`,
          background: c.bgElev, color: c.text2, display: 'inline-flex',
          alignItems: 'center', justifyContent: 'center',
        }}><IconStar size={18}/></button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {/* hero */}
        <div style={{
          padding: '22px 20px 18px', display: 'flex', alignItems: 'flex-start', gap: 14,
        }}>
          <ZPFav t={it.favT} theme={theme} size={56}/>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: -0.02 }}>{it.name}</h1>
            <div style={{
              marginTop: 4, fontFamily: ZP_FONTS.mono, fontSize: 12, color: c.text3,
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}><IconGlobe size={13}/> {it.url}</div>
            <div style={{ marginTop: 8, display: 'flex', gap: 4 }}>
              {(it.tags||['Work','dev','2fa']).map(tg => <ZPTag key={tg} theme={theme}>{tg}</ZPTag>)}
            </div>
          </div>
        </div>

        {/* action row */}
        <div style={{ padding: '0 20px 16px', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
          {[
            { icon: <IconCopy/>, label: t('mob_copy_user').split(' ')[1] || 'user', primary: false },
            { icon: <IconKey/>, label: t('lbl_password').slice(0,2).toLowerCase() === 'pa' ? 'pass' : '密码', primary: true },
            { icon: <IconShare/>, label: t('act_share').slice(0,4) },
            { icon: <IconEdit/>, label: t('act_edit').slice(0,4) },
          ].map((a, i) => (
            <button key={i} style={{
              height: 60, borderRadius: 10,
              background: a.primary ? c.text : c.bgElev,
              color: a.primary ? c.bg : c.text,
              border: a.primary ? 0 : `1px solid ${c.line}`,
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4,
            }}>
              {a.icon}
              <span style={{ fontFamily: ZP_FONTS.mono, fontSize: 9, letterSpacing: 0.06, textTransform: 'uppercase' }}>{a.label}</span>
            </button>
          ))}
        </div>

        {/* credentials */}
        <ZPSectionHeader theme={theme}>{t('sec_credentials')}</ZPSectionHeader>
        <div style={{ margin: '0 20px', border: `1px solid ${c.line}`, borderRadius: 10, background: c.bgElev, overflow: 'hidden' }}>
          {[
            { label: t('lbl_username'), value: it.username, mask: false },
            { label: t('lbl_password'), value: '••••••••••••••••••••', mask: true },
            { label: t('lbl_website'), value: it.url, mask: false },
          ].map((f, i, a) => (
            <div key={i} style={{
              padding: '12px 14px',
              borderBottom: i < a.length-1 ? `1px solid ${c.lineSoft}` : 0,
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: ZP_FONTS.mono, fontSize: 9, color: c.text3, textTransform: 'uppercase', letterSpacing: 0.06 }}>{f.label}</div>
                <div style={{
                  marginTop: 3, fontFamily: ZP_FONTS.mono, fontSize: 13, color: c.text,
                  letterSpacing: f.mask ? 0.3 : 0,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>{f.value}</div>
              </div>
              {f.mask && <button style={{ width: 30, height: 30, borderRadius: 6, color: c.text3, border: `1px solid ${c.lineSoft}`, background: c.bg, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><IconEye size={16}/></button>}
              <button style={{ width: 30, height: 30, borderRadius: 6, color: c.text3, border: `1px solid ${c.lineSoft}`, background: c.bg, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><IconCopy size={16}/></button>
            </div>
          ))}
        </div>

        {/* strength */}
        <ZPSectionHeader theme={theme}>{t('sec_strength')}</ZPSectionHeader>
        <div style={{ margin: '0 20px', padding: 14, border: `1px solid ${c.line}`, borderRadius: 10, background: c.bgElev }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ fontFamily: ZP_FONTS.mono, fontSize: 28, fontWeight: 600, letterSpacing: -0.02 }}>
              {it.strength || 94}<span style={{ fontSize: 12, color: c.text3 }}>/100</span>
            </div>
            <div style={{ flex: 1, height: 5, background: c.lineSoft, borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ width: `${it.strength||94}%`, height: '100%', background: c.text }}/>
            </div>
            <div style={{ fontFamily: ZP_FONTS.mono, fontSize: 11, color: c.text2 }}>{t('strength_excellent')}</div>
          </div>
          <div style={{ marginTop: 10, fontFamily: ZP_FONTS.mono, fontSize: 10, color: c.text3, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <span>{t('meta_length')} <b style={{ color: c.text }}>20</b></span>
            <span>{t('meta_entropy')} <b style={{ color: c.text }}>124 bits</b></span>
            <span>{t('meta_crack')} <b style={{ color: c.text }}>{t('crack_centuries')}</b></span>
          </div>
        </div>

        {/* TOTP inline */}
        <ZPSectionHeader theme={theme}>{t('sec_totp')}</ZPSectionHeader>
        <div style={{ margin: '0 20px 20px', padding: 14, border: `1px solid ${c.line}`, borderRadius: 10, background: c.bgElev, display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{
            width: 32, height: 32, borderRadius: '50%',
            background: `conic-gradient(${c.text} 58%, ${c.line} 0)`,
            position: 'relative',
          }}>
            <div style={{ position: 'absolute', inset: 3, borderRadius: '50%', background: c.bgElev, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: ZP_FONTS.mono, fontSize: 11, color: c.text }}>17</div>
          </div>
          <div style={{ flex: 1, fontFamily: ZP_FONTS.mono, fontSize: 22, fontWeight: 600, letterSpacing: 0.15 }}>068 508</div>
          <button style={{ width: 36, height: 36, borderRadius: 8, border: `1px solid ${c.line}`, background: c.bg, color: c.text2, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><IconCopy size={16}/></button>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { ZPDetail });
