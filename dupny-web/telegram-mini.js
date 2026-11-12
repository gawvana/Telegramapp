// Dupny Telegram Mini App bootstrap. The server validates Telegram.initData.
let inviteUrl = '';
function invitationButton(tg) {
  if (document.getElementById('dupny-invite')) return;
  const button = document.createElement('button');
  button.id = 'dupny-invite';
  button.type = 'button';
  button.textContent = '✉ Пригласить';
  button.setAttribute('aria-label', 'Пригласить друзей');
  Object.assign(button.style, {
    position: 'fixed', top: 'calc(env(safe-area-inset-top, 0px) + 14px)',
    right: '14px', zIndex: '9000', borderRadius: '18px',
    background: '#ffffff', color: '#111111', border: '1px solid #bbb',
    padding: '8px 13px', fontWeight: '700', fontSize: '13px',
    boxShadow: '0 3px 15px #0005', cursor: 'pointer'
  });
  button.addEventListener('click', () => {
    if (!inviteUrl) return;
    const share = 'https://t.me/share/url?url=' + encodeURIComponent(inviteUrl) +
      '&text=' + encodeURIComponent('Заходи в Dupny, будем смотреть фильмы вместе! 🎬');
    if (typeof tg.openTelegramLink === 'function') tg.openTelegramLink(share);
    else window.open(share, '_blank', 'noopener,noreferrer');
  });
  document.body.append(button);
}
function splash() {
  const overlay = document.createElement('div');
  overlay.id = 'dupny-welcome';
  Object.assign(overlay.style, {
    position: 'fixed', inset: '0', zIndex: '10000',
    background: '#111', color: '#f5f5f5',
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', padding: '28px', textAlign: 'center',
    fontFamily: 'system-ui, sans-serif'
  });
  const name = document.createElement('h1');
  name.textContent = '🎬 Dupny';
  name.style.fontSize = '34px';
  const msg = document.createElement('p');
  msg.textContent = 'Выполняем вход через Telegram…';
  msg.style.lineHeight = '1.6';
  overlay.append(name, msg);
  document.body.append(overlay);
  return { overlay, msg };
}
export async function bootTelegram() {
  const tg = window.Telegram?.WebApp;
  // Normal browsers keep the regular login/invite screen.
  if (!tg?.initData) return false;
  try { tg.ready(); tg.expand(); } catch {}
  const { overlay, msg } = splash();
  try {
    const params = new URLSearchParams(window.location.search);
    const referral = tg.initDataUnsafe?.start_param || params.get('ref') || '';
    const response = await fetch('/api/telegram/auth', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initData: tg.initData, referral })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || 'Ошибка входа через Telegram');
    inviteUrl = data.inviteUrl;
    window.__dupnyMiniApp = { connected: true, inviteUrl, created: data.created };
    if (data.created) {
      msg.textContent = 'Аккаунт зарегистрирован. Добро пожаловать, ' + data.user.name + '!';
      await new Promise(r => setTimeout(r, 850));
    }
    invitationButton(tg);
    return true;
  } catch (err) {
    msg.textContent = err.message || 'Не удалось авторизоваться в Telegram';
    const hint = document.createElement('p');
    hint.textContent = 'Закрой Mini App и открой его заново, либо используй обычный вход на сайте.';
    hint.style.fontSize = '13px';
    const button = document.createElement('button');
    button.textContent = 'Обычный вход';
    button.type = 'button';
    Object.assign(button.style, { padding: '10px 20px', borderRadius: '12px', border: '0', cursor: 'pointer' });
    button.onclick = () => overlay.remove();
    overlay.append(hint, button);
    return false;
  } finally {
    if (!overlay.querySelector('button')) overlay.remove();
  }
}
