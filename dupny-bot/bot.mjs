// Dupny Telegram Bot • Bot API 9.4+ custom emoji with safe fallback.
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SITE = process.env.DUPNY_SITE_URL || 'https://dupny-production.up.railway.app';
if (!TOKEN) { console.error('TELEGRAM_BOT_TOKEN is missing'); process.exit(1); }

const ICONS = Object.freeze({
  hello: ['6041921818896372382', '👋'],
  film: ['5937999673510858217', '🎞'],
  music: ['5938473438468378529', '🎶'],
  home: ['6042137469204303531', '🏠'],
  share: ['6039391666547201160', '⬆️'],
  help: ['6030848053177486888', '❓'],
  settings: ['6032742198179532882', '⚙'],
  profile: ['6035084557378654059', '👤']
});
const ico = key => {
  const [id, fallback] = ICONS[key];
  return '<tg-emoji emoji-id="' + id + '">' + fallback + '</tg-emoji>';
};
let stopping = false;
let offset = 0;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function api(method, payload = {}, timeoutMs = 45000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetch('https://api.telegram.org/bot' + TOKEN + '/' + method, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload), signal: ctrl.signal
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      const error = new Error(method + ': ' + (data.description || response.status));
      error.status = data.error_code || response.status;
      error.retryAfter = data.parameters?.retry_after;
      throw error;
    }
    return data.result;
  } finally {
    clearTimeout(timer);
  }
}

function button(text, key, action, premium) {
  if (!premium) return { text: ICONS[key][1] + ' ' + text, ...action };
  return { text, icon_custom_emoji_id: ICONS[key][0], ...action };
}
function keyboard(premium, referral = '') {
  const url = SITE + (referral ? '?ref=' + encodeURIComponent(referral) : '');
  return { inline_keyboard: [
    [button('Открыть Mini App', 'film', { web_app: { url } }, premium)],
    [button('Пригласить друзей', 'share', { callback_data: 'invite' }, premium)],
    [button('Помощь', 'help', { callback_data: 'help' }, premium)]
  ] };
}
function inviteLink(telegramId) {
  return 'https://t.me/DupnyApp?start=ref_' + telegramId;
}
function inviteKeyboard(premium, link) {
  const share = 'https://t.me/share/url?url=' + encodeURIComponent(link)
    + '&text=' + encodeURIComponent('Присоединяйся к Dupny! Будем смотреть фильмы и слушать музыку вместе.');
  return { inline_keyboard: [
    [button('Поделиться ссылкой', 'share', { url: share }, premium)],
    [button('Открыть Mini App', 'film', { web_app: { url: SITE } }, premium)]
  ] };
}
async function send(chatId, html, plain, makeKeyboard = keyboard, referral = '') {
  // Some bots cannot use premium emoji unless their owner has Telegram Premium.
  try {
    return await api('sendMessage', {
      chat_id: chatId, text: html, parse_mode: 'HTML',
      reply_markup: makeKeyboard(true, referral), disable_web_page_preview: true
    });
  } catch (error) {
    if (error.status !== 400) throw error;
    console.warn('Custom emoji rejected; falling back to ordinary emoji.');
    return api('sendMessage', {
      chat_id: chatId, text: plain,
      reply_markup: makeKeyboard(false, referral), disable_web_page_preview: true
    });
  }
}
const HOME_HTML = ico('hello') + ' <b>Добро пожаловать в Dupny!</b>\n\n'
  + ico('film') + ' Смотри фильмы вместе с друзьями.\n'
  + ico('music') + ' Слушай музыку и заходи в общие комнаты.\n\n'
  + ico('home') + ' Нажми «Открыть Mini App».\n'
  + ico('share') + ' /invite — пригласить друзей.';
const HOME_PLAIN = '👋 Добро пожаловать в Dupny!\n\n🎞 Фильмы и 🎶 музыка с друзьями.\n'
  + '🏠 Нажми «Открыть Mini App».\n⬆️ /invite — пригласить друзей.';
const HELP_HTML = ico('help') + ' <b>Команды Dupny</b>\n\n'
  + ico('home') + ' /start — главная\n'
  + ico('share') + ' /invite — приглашение\n'
  + ico('help') + ' /help — помощь\n'
  + ico('settings') + ' /settings — настройки\n'
  + ico('profile') + ' /about — о проекте.';
const HELP_PLAIN = '❓ Команды Dupny\n\n/start — главная\n/invite — приглашение\n'
  + '/help — помощь\n/settings — настройки\n/about — о проекте.';

async function sendInvite(chatId, tgId) {
  const link = inviteLink(tgId);
  const html = ico('share') + ' <b>Пригласи друзей в Dupny</b>\n\n'
    + ico('film') + ' Отправь ссылку другу. Друг нажимает «Запустить» у бота, '
    + 'затем «Открыть Mini App». Вход через Telegram, без пароля.\n\n' + link;
  const plain = '⬆️ Пригласи друзей в Dupny\n\n'
    + 'Друг откроет Mini App со своим Telegram-профилем.\n\n' + link;
  return send(chatId, html, plain, premium => inviteKeyboard(premium, link));
}
async function handleMessage(msg) {
  if (!msg.text || msg.chat?.type !== 'private') return;
  const words = msg.text.trim().split(/\s+/);
  const command = words[0].toLowerCase().split('@')[0];
  const referral = /^ref_\d{4,18}$/.test(words[1] || '') ? words[1] : '';
  if (command === '/start' && referral) {
    // Telegram users may open the Mini App from the persistent chat menu
    // instead of the referral-specific inline button. Preserve it in both.
    try {
      await api('setChatMenuButton', {
        chat_id: msg.chat.id,
        menu_button: {
          type: 'web_app',
          text: 'Открыть Dupny',
          web_app: { url: SITE + '?ref=' + encodeURIComponent(referral) }
        }
      });
    } catch (error) {
      console.warn('Cannot set referral menu button:', error.message);
    }
  }
  if (command === '/invite') return sendInvite(msg.chat.id, msg.from.id);
  if (command === '/help') return send(msg.chat.id, HELP_HTML, HELP_PLAIN);
  if (command === '/settings') return send(msg.chat.id,
    ico('settings') + ' <b>Настройки Dupny</b>\n\n'
      + ico('profile') + ' Твой профиль Telegram используется автоматически. '
      + 'Открой Mini App, чтобы посмотреть комнаты и параметры.',
    '⚙ Настройки Dupny\n\n👤 Telegram-профиль используется автоматически. '
      + 'Открой Mini App для просмотра комнат и параметров.');
  if (command === '/about') return send(msg.chat.id,
    ico('film') + ' <b>Dupny | Дупни</b>\n\n'
      + ico('music') + ' Фильмы, музыка и совместный просмотр прямо в Telegram.',
    '🎞 Dupny | Дупни\n\n🎶 Фильмы, музыка и совместный просмотр прямо в Telegram.');
  return send(msg.chat.id, HOME_HTML, HOME_PLAIN, keyboard, command === '/start' ? referral : '');
}
async function handleCallback(query) {
  await api('answerCallbackQuery', { callback_query_id: query.id }).catch(() => {});
  if (query.message?.chat?.type !== 'private') return;
  if (query.data === 'invite') return sendInvite(query.message.chat.id, query.from.id);
  if (query.data === 'help') return send(query.message.chat.id, HELP_HTML, HELP_PLAIN);
}

// Profile setup without repeating edits that cause Telegram flood limits.
async function syncProfile() {
  const changes = [
    ['getChatMenuButton', 'setChatMenuButton', null, {
      type: 'web_app', text: 'Открыть Dupny', web_app: { url: SITE }
    }],
    ['getMyName', 'setMyName', 'name', 'Dupny | Дупни'],
    ['getMyDescription', 'setMyDescription', 'description',
      'Dupny — фильмы, музыка и совместный просмотр с друзьями в Telegram Mini App.'],
    ['getMyShortDescription', 'setMyShortDescription', 'short_description',
      'Фильмы, музыка и комнаты с друзьями 🎬'],
    ['getMyCommands', 'setMyCommands', null, [
      { command: 'start', description: 'Главная' },
      { command: 'invite', description: 'Пригласить друзей' },
      { command: 'help', description: 'Помощь' },
      { command: 'settings', description: 'Настройки' },
      { command: 'about', description: 'О проекте' }
    ]]
  ];
  for (const [getter, setter, key, value] of changes) {
    try {
      const current = await api(getter);
      // getChatMenuButton returns a full button object.
      const actual = key ? current?.[key] : current;
      if (JSON.stringify(actual) === JSON.stringify(value)) continue;
      const payload = setter === 'setChatMenuButton' ? { menu_button: value }
        : setter === 'setMyCommands' ? { commands: value }
        : { [key]: value };
      await api(setter, payload);
    } catch (error) {
      console.warn('Profile sync skipped (' + setter + '): ' + error.message);
      if (error.status === 429) break;
    }
  }
}
try {
  const me = await api('getMe');
  console.log('Dupny connected to Telegram as @' + me.username);
  await api('deleteWebhook', { drop_pending_updates: false });
  await syncProfile();
  console.log('Dupny ready; long polling active.');
} catch (error) {
  console.error('Dupny startup failed: ' + error.message);
  process.exit(1);
}
while (!stopping) {
  try {
    const updates = await api('getUpdates', {
      offset, limit: 50, timeout: 25, allowed_updates: ['message', 'callback_query']
    }, 40000);
    for (const update of updates) {
      offset = update.update_id + 1;
      try {
        if (update.message) await handleMessage(update.message);
        if (update.callback_query) await handleCallback(update.callback_query);
      } catch (error) { console.error('Update failed: ' + error.message); }
    }
  } catch (error) {
    if (stopping) break;
    console.error('Telegram polling: ' + error.message);
    await sleep(error.status === 429
      ? Math.min(120000, (error.retryAfter || 10) * 1000)
      : error.status === 409 ? 6000 : 3000);
  }
}
console.log('Dupny stopped.');
