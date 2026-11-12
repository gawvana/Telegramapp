// Dupny is a Telegram-only Mini App. Its backend authenticates signed initData.
let inviteUrl = '';
function showGate(text, showRetry = false) {
  let overlay = document.getElementById('dupny-welcome');
  if (!overlay) {
    overlay = document.createElement('main');
    overlay.id = 'dupny-welcome';
    Object.assign(overlay.style, {
      position: 'fixed', inset: '0', zIndex: '10000',
      background: '#111', color: '#fff', display: 'flex',
      flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: '15px', padding: '28px', textAlign: 'center',
      fontFamily: 'system-ui, sans-serif'
    });
    document.body.appendChild(overlay);
  }
  overlay.replaceChildren();
  const title = document.createElement('h1');
  title.textContent = '🎬 Dupny';
  title.style.fontSize = '34px';
  const message = document.createElement('p');
  message.textContent = text;
  message.style.lineHeight = '1.6';
  message.style.maxWidth = '380px';
  const open = document.createElement('a');
  open.href = 'https://t.me/DupnyApp';
  open.textContent = 'Открыть в Telegram';
  Object.assign(open.style, {
    padding: '12px 20px', background: '#fff',
    color: '#111', borderRadius: '12px', textDecoration: 'none',
    fontWeight: '700'
  });
  overlay.append(title, message, open);
  if (showRetry) {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = 'Повторить';
    Object.assign(retry.style, {
      padding: '10px 16px', background: 'transparent',
      color: '#fff', border: '1px solid #888', borderRadius: '12px'
    });
    retry.onclick = () => window.location.reload();
    overlay.append(retry);
  }
  return overlay;
}
function inviteButton(tg) {
  if (document.getElementById('dupny-invite')) return;
  const button = document.createElement('button');
  button.id = 'dupny-invite';
  button.type = 'button';
  button.textContent = '✉ Пригласить';
  Object.assign(button.style, {
    position: 'fixed', top: 'calc(env(safe-area-inset-top, 0px) + 14px)',
    right: '14px', zIndex: '9000', borderRadius: '18px',
    background: '#fff', color: '#111', border: '1px solid #bbb',
    padding: '8px 13px', fontWeight: '700', fontSize: '13px',
    boxShadow: '0 3px 15px #0005', cursor: 'pointer'
  });
  button.onclick = () => {
    if (!inviteUrl) return;
    const share = 'https://t.me/share/url?url=' + encodeURIComponent(inviteUrl)
      + '&text=' + encodeURIComponent('Заходи в Dupny! Будем смотреть вместе 🎬');
    if (typeof tg.openTelegramLink === 'function') tg.openTelegramLink(share);
    else window.open(share, '_blank', 'noopener,noreferrer');
  };
  document.body.appendChild(button);
}
export async function bootTelegram() {
  const tg = window.Telegram?.WebApp;
  if (!tg?.initData) {
    showGate('Dupny открывается через Telegram. Никаких логинов и регистраций.', false);
    return false;
  }
  try { tg.ready(); tg.expand(); } catch {}
  const overlay = showGate('Открываем твой Telegram-профиль…');
  try {
    const params = new URLSearchParams(location.search);
    const referral = tg.initDataUnsafe?.start_param || params.get('ref') || '';
    const response = await fetch('/api/telegram/auth', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initData: tg.initData, referral })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || 'Не удалось проверить Telegram');
    if (!data.user || !data.user.telegram) throw new Error('Сервер не распознал Telegram-профиль');
    inviteUrl = data.inviteUrl;
    window.__dupnyMiniApp = { connected: true, inviteUrl, telegram: data.user.telegram };
    inviteButton(tg);
    overlay.remove();
    return true;
  } catch (err) {
    showGate(err.message || 'Ошибка связи с Telegram', true);
    return false;
  }
}
