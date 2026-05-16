// Cmd-K command palette
const { useState: cS, useEffect: cE, useMemo: cM, useRef: cR } = React;
const { Favicon: Fc } = window.ZPASS_UI;
const Ic = window.ZPASS_ICONS;
const { useI18n: cUseI18n } = window.ZPASS_I18N;

function CmdK({ open, onClose, items, onJump, onItem }) {
  const [q, setQ] = cS('');
  const [sel, setSel] = cS(0);
  const inputRef = cR();
  const { t } = cUseI18n();

  cE(() => {
    if (open) { setQ(''); setSel(0); setTimeout(() => inputRef.current?.focus(), 30); }
  }, [open]);

  const results = cM(() => {
    const nav = [
      { kind: 'nav', id: 'vault',  title: t('cmdk_nav_vault'),  hint: 'G V', run: () => onJump('vault') },
      { kind: 'nav', id: 'gen',    title: t('cmdk_nav_gen'),    hint: 'G G', run: () => onJump('generator') },
      { kind: 'nav', id: 'health', title: t('cmdk_nav_health'), hint: 'G H', run: () => onJump('health') },
      { kind: 'nav', id: 'new',    title: t('cmdk_nav_new'),    hint: 'N',   run: () => onJump('vault') },
      { kind: 'nav', id: 'lock',   title: t('cmdk_nav_lock'),   hint: 'L',   run: () => onJump('lock') },
      { kind: 'nav', id: 'theme',  title: t('cmdk_nav_theme'),  hint: 'T',   run: () => document.documentElement.setAttribute('data-theme', document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light') },
    ];
    const ql = q.toLowerCase();
    const navF = ql ? nav.filter(n => n.title.toLowerCase().includes(ql)) : nav;
    const itemF = ql
      ? items.filter(i => (i.name + ' ' + (i.username||'') + ' ' + (i.url||'')).toLowerCase().includes(ql)).slice(0, 8)
      : items.slice(0, 5);
    return { navF, itemF };
  }, [q, items]);

  const flat = [...results.navF.map((x,i) => ({ kind: 'nav', i, data: x })), ...results.itemF.map((x,i) => ({ kind: 'item', i, data: x }))];

  cE(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(s+1, flat.length-1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(0, s-1)); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        const r = flat[sel];
        if (!r) return;
        if (r.kind === 'nav') r.data.run();
        else onItem(r.data.id);
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, flat, sel, onClose, onItem]);

  if (!open) return null;
  return (
    <div className="cmdk-backdrop" onClick={onClose}>
      <div className="cmdk" onClick={e => e.stopPropagation()}>
        <div className="cmdk-input">
          <Ic.Search size={16} />
          <input ref={inputRef} value={q} onChange={e => { setQ(e.target.value); setSel(0); }} placeholder={t('cmdk_placeholder')} />
          <span className="kbd">ESC</span>
        </div>
        <div className="cmdk-list">
          {results.navF.length > 0 && <div className="cmdk-section">{t('cmdk_commands')}</div>}
          {results.navF.map((c, i) => {
            const idx = i;
            return (
              <button key={c.id} className={"cmdk-item " + (sel === idx ? 'sel' : '')} onMouseEnter={() => setSel(idx)} onClick={() => { c.run(); onClose(); }}>
                <Ic.Command size={14} />
                <span>{c.title}</span>
                <span className="cmeta"><span className="kbd">{c.hint}</span></span>
              </button>
            );
          })}
          {results.itemF.length > 0 && <div className="cmdk-section">{t('cmdk_items')}</div>}
          {results.itemF.map((it, i) => {
            const idx = results.navF.length + i;
            return (
              <button key={it.id} className={"cmdk-item " + (sel === idx ? 'sel' : '')} onMouseEnter={() => setSel(idx)} onClick={() => { onItem(it.id); onClose(); }}>
                <div style={{ width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Fc item={it} size={20} /></div>
                <span>{it.name} <span style={{ color: 'var(--text-3)', fontFamily: 'var(--font-mono)', fontSize: 11, marginLeft: 6 }}>{it.username || it.url}</span></span>
                <span className="cmeta">{it.type}</span>
              </button>
            );
          })}
          {!flat.length && <div className="empty" style={{ padding: 28 }}>{t('cmdk_empty')}</div>}
        </div>
        <div style={{ padding: '8px 14px', borderTop: '1px solid var(--line-soft)', display: 'flex', gap: 14, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)' }}>
          <span><span className="kbd">↑↓</span> {t('cmdk_navigate')}</span>
          <span><span className="kbd">↵</span> {t('cmdk_select')}</span>
          <span><span className="kbd">⌘K</span> {t('cmdk_toggle')}</span>
          <div style={{ marginLeft: 'auto' }}>zpass://palette</div>
        </div>
      </div>
    </div>
  );
}

window.ZPASS_CmdK = CmdK;
