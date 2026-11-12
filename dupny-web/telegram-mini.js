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
// Used when an embedded browser blocks cookies or Telegram auth has expired.
window.__dupnyShowLoginProblem = () => {
  showGate('Не получилось восстановить Telegram-сеанс. Закрой Mini App и открой его снова из @DupnyApp.', true);
};
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
    const referral = tg.initDataUnsafe?.start_param || params.get('tgWebAppStartParam') || params.get('ref') || '';
    const response = await fetch('/api/telegram/auth', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initData: tg.initData, referral })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || 'Не удалось проверить Telegram');
    if (!data.user || !data.user.telegram) throw new Error('Сервер не распознал Telegram-профиль');
    // Telegram Web embeds Mini Apps as a cross-site iframe.
    // Verify the partitioned cookie actually survives the following request.
    const verify = await fetch('/api/me', { credentials: 'include', cache: 'no-store' });
    const session = await verify.json().catch(() => ({}));
    if (!verify.ok || !session.user ||
        String(session.user.telegram?.id) !== String(data.user.telegram.id)) {
      throw new Error('Telegram-сеанс не сохранился. Закрой Mini App и открой заново.');
    }
    inviteUrl = data.inviteUrl;
    window.__dupnyMiniApp = { connected: true, inviteUrl, telegram: data.user.telegram };
    overlay.remove();
    return true;
  } catch (err) {
    showGate(err.message || 'Ошибка связи с Telegram', true);
    return false;
  }
}
