// zp-vault.jsx — Vault list variations: dense, card, swipe-to-copy

function ZPVaultHeader({ theme = 'dark', t, title, count, large = true }) {
  const c = ZP_TOKENS[theme];
  return (
    <div style={{ padding: '8px 20px 10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h1 style={{
          margin: 0, fontSize: large ? 28 : 20, fontWeight: 600,
          letterSpacing: -0.025, flex: 1,
        }}>{title}</h1>
        <span style={{
          fontFamily: ZP_FONTS.mono, fontSize: 11, color: c.text3,
          padding: '2px 7px', border: `1px solid ${c.line}`, borderRadius: 4,
        }}>{count}</span>
        <button style={{
          width: 34, height: 34, borderRadius: 8, border: `1px solid ${c.line}`,
          background: c.bgElev, color: c.text2, display: 'inline-flex',
          alignItems: 'center', justifyContent: 'center',
        }}><IconDots size={18}/></button>
      </div>
      {/* search */}
      <div style={{
        marginTop: 10, display: 'flex', alignItems: 'center', gap: 10,
        height: 40, padding: '0 12px', background: c.bgElev,
        border: `1px solid ${c.line}`, borderRadius: 8, color: c.text3, fontSize: 14,
      }}>
        <IconSearch size={16}/>
        <span style={{ flex: 1 }}>{t('topbar_search')}</span>
        <span style={{ fontFamily: ZP_FONTS.mono, fontSize: 11 }}>⌘K</span>
      </div>
    </div>
  );
}

function ZPFilterChips({ theme = 'dark', t, active = 'all' }) {
  const c = ZP_TOKENS[theme];
  const chips = [
    { id: 'all', label: t('filter_all'), n: 28 },
    { id: 'login', label: t('filter_login'), n: 16 },
    { id: 'card', label: t('filter_card'), n: 3 },
    { id: 'note', label: t('filter_note'), n: 3 },
    { id: 'identity', label: t('filter_identity'), n: 1 },
    { id: 'ssh', label: t('filter_ssh'), n: 3 },
  ];
  return (
    <div style={{
      display: 'flex', gap: 6, padding: '6px 20px 10px',
      overflowX: 'auto', WebkitOverflowScrolling: 'touch',
    }}>
      {chips.map(ch => (
        <ZPChip key={ch.id} active={ch.id === active} theme={theme} count={ch.n}>
          {ch.label}
        </ZPChip>
      ))}
    </div>
  );
}

// Variation A — Dense list (default, matches desktop vibe)
function ZPVaultDense({ theme = 'dark', t, items, activeId, onSelect }) {
  const c = ZP_TOKENS[theme];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <ZPVaultHeader theme={theme} t={t} title={t('vault_title')} count={items.length}/>
      <ZPFilterChips theme={theme} t={t}/>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {items.map((it, idx) => {
          const isActive = it.id === activeId;
          return (
            <button key={it.id} onClick={() => onSelect && onSelect(it.id)}
              style={{
                display: 'grid', gridTemplateColumns: '36px 1fr auto', gap: 12,
                alignItems: 'center', width: '100%', textAlign: 'left',
                padding: '12px 20px', background: isActive ? c.bgActive : 'transparent',
                borderBottom: `1px solid ${c.lineSoft}`, border: 0, position: 'relative',
                color: c.text, cursor: 'pointer',
              }}>
              {isActive && <div style={{
                position: 'absolute', left: 0, top: 10, bottom: 10, width: 2, background: c.text,
              }}/>}
              <ZPFav t={it.favT} theme={theme} size={36}/>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 14, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.name}</span>
                  {it.totp && <ZPTypeBadge theme={theme}>totp</ZPTypeBadge>}
                  {it.breached && <span style={{
                    fontFamily: ZP_FONTS.mono, fontSize: 9, padding: '1px 5px',
                    background: `color-mix(in oklab, ${c.danger} 18%, transparent)`,
                    color: c.danger, borderRadius: 3,
                    border: `1px solid color-mix(in oklab, ${c.danger} 30%, ${c.line})`,
                    textTransform: 'uppercase', letterSpacing: 0.05,
                  }}>{t('breach_detected').includes('泄露') ? '已泄露' : 'breach'}</span>}
                </div>
                <div style={{
                  marginTop: 2, fontFamily: ZP_FONTS.mono, fontSize: 11, color: c.text3,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>{it.username || it.url}</div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
                <span style={{ fontFamily: ZP_FONTS.mono, fontSize: 10, color: c.text3 }}>{it.modifiedLbl}</span>
                {it.strength != null && (
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    fontFamily: ZP_FONTS.mono, fontSize: 10,
                    color: it.strength > 70 ? c.text2 : c.danger,
                  }}>
                    <span style={{ width: 26, height: 3, borderRadius: 2, background: c.lineSoft, position: 'relative', overflow: 'hidden', display: 'inline-block' }}>
                      <span style={{ position: 'absolute', inset: 0, right: 'auto', width: `${it.strength}%`, background: it.strength > 70 ? c.text : c.danger }}/>
                    </span>
                    {it.strength}
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Variation B — Card, with swipe-to-copy affordance peeking
function ZPVaultCards({ theme = 'dark', t, items }) {
  const c = ZP_TOKENS[theme];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <ZPVaultHeader theme={theme} t={t} title={t('vault_title')} count={items.length}/>
      <ZPFilterChips theme={theme} t={t}/>
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 16px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {items.map((it, idx) => {
          // every 3rd card — show swipe-to-copy peeking
          const peeking = idx === 1;
          return (
            <div key={it.id} style={{ position: 'relative', overflow: 'hidden', borderRadius: 10 }}>
              {/* peek actions under */}
              {peeking && (
                <div style={{
                  position: 'absolute', inset: 0,
                  display: 'flex', justifyContent: 'flex-end', alignItems: 'stretch',
                  background: c.bg,
                }}>
                  <div style={{ width: 64, background: c.bgElev2, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, color: c.text2, borderLeft: `1px solid ${c.line}` }}>
                    <IconCopy size={18}/>
                    <span style={{ fontFamily: ZP_FONTS.mono, fontSize: 9, textTransform: 'uppercase' }}>{t('mob_copy_user').split(' ')[1] || 'user'}</span>
                  </div>
                  <div style={{ width: 64, background: c.text, color: c.bg, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                    <IconKey size={18}/>
                    <span style={{ fontFamily: ZP_FONTS.mono, fontSize: 9, textTransform: 'uppercase' }}>{t('lbl_password').slice(0,4)}</span>
                  </div>
                </div>
              )}
              <div style={{
                transform: peeking ? 'translateX(-128px)' : 'translateX(0)',
                transition: 'transform .2s',
                background: c.bgElev, border: `1px solid ${c.line}`, borderRadius: 10,
                padding: '14px 14px', display: 'grid', gridTemplateColumns: '40px 1fr auto', gap: 12, alignItems: 'center',
                position: 'relative',
              }}>
                <ZPFav t={it.favT} theme={theme} size={40}/>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 15, fontWeight: 500 }}>{it.name}</span>
                    {it.totp && <ZPTypeBadge theme={theme}>totp</ZPTypeBadge>}
                  </div>
                  <div style={{
                    marginTop: 2, fontFamily: ZP_FONTS.mono, fontSize: 11, color: c.text3,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>{it.username}</div>
                  <div style={{ marginTop: 6, display: 'flex', gap: 4 }}>
                    {(it.tags||[]).slice(0,3).map(tg => <ZPTag key={tg} theme={theme}>{tg}</ZPTag>)}
                  </div>
                </div>
                <div style={{ color: c.text3 }}><IconBack size={18} style={{ transform: 'scaleX(-1)' }}/></div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Variation C — Dashboard-ish (recent, breaches strip, pinned)
function ZPVaultDashboard({ theme = 'dark', t, items, breachCount = 3 }) {
  const c = ZP_TOKENS[theme];
  const pinned = items.slice(0, 4);
  const recent = items.slice(0, 6);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <ZPVaultHeader theme={theme} t={t} title={t('vault_title')} count={items.length}/>
      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 20 }}>
        {/* Breach strip */}
        <div style={{
          margin: '6px 20px 12px', padding: '12px 14px',
          border: `1px solid color-mix(in oklab, ${c.danger} 35%, ${c.line})`,
          background: `color-mix(in oklab, ${c.danger} 6%, ${c.bgElev})`,
          borderRadius: 10, display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <div style={{
            width: 32, height: 32, borderRadius: 8,
            background: `color-mix(in oklab, ${c.danger} 20%, transparent)`,
            color: c.danger, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          }}><IconAlert size={18}/></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 500 }}>{t('mob_breach_strip', breachCount)}</div>
            <div style={{ fontFamily: ZP_FONTS.mono, fontSize: 10, color: c.text3, marginTop: 2 }}>HIBP · linear.app, twitter.com, notion.so</div>
          </div>
          <button style={{
            padding: '6px 10px', borderRadius: 6, background: c.text, color: c.bg,
            fontSize: 12, fontWeight: 500, border: 0,
          }}>{t('mob_view')}</button>
        </div>

        {/* Pinned */}
        <ZPSectionHeader theme={theme}>{t('mob_pinned')}</ZPSectionHeader>
        <div style={{ padding: '0 20px', display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
          {pinned.map(it => (
            <div key={it.id} style={{
              padding: 12, border: `1px solid ${c.line}`, borderRadius: 10,
              background: c.bgElev, display: 'flex', flexDirection: 'column', gap: 8,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <ZPFav t={it.favT} theme={theme} size={28}/>
                <span style={{ fontSize: 13, fontWeight: 500, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.name}</span>
              </div>
              <div style={{ fontFamily: ZP_FONTS.mono, fontSize: 10, color: c.text3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.username}</div>
              <div style={{ display: 'flex', gap: 4 }}>
                <button style={{ flex: 1, fontFamily: ZP_FONTS.mono, fontSize: 10, padding: '5px 0', border: `1px solid ${c.line}`, borderRadius: 5, background: c.bg, color: c.text2, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                  <IconCopy size={12}/> user
                </button>
                <button style={{ flex: 1, fontFamily: ZP_FONTS.mono, fontSize: 10, padding: '5px 0', border: 0, borderRadius: 5, background: c.text, color: c.bg, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                  <IconKey size={12}/> pw
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Recent */}
        <ZPSectionHeader theme={theme}>{t('mob_recent')}</ZPSectionHeader>
        <div>
          {recent.map(it => (
            <div key={it.id} style={{
              display: 'grid', gridTemplateColumns: '32px 1fr auto', gap: 12,
              alignItems: 'center', padding: '10px 20px',
              borderBottom: `1px solid ${c.lineSoft}`,
            }}>
              <ZPFav t={it.favT} theme={theme} size={32}/>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14 }}>{it.name}</div>
                <div style={{ fontFamily: ZP_FONTS.mono, fontSize: 10, color: c.text3 }}>{it.username}</div>
              </div>
              <div style={{ fontFamily: ZP_FONTS.mono, fontSize: 10, color: c.text3 }}>{it.modifiedLbl}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { ZPVaultDense, ZPVaultCards, ZPVaultDashboard, ZPVaultHeader, ZPFilterChips });
