// Dupny Telegram Bot. Token comes only from Railway environment variables.
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SITE = process.env.DUPNY_SITE_URL || "https://lozha-production.up.railway.app";
if (!TOKEN) { console.error("TELEGRAM_BOT_TOKEN is missing"); process.exit(1); }
const EMOJI = { bot: "6030400221232501136", home: "6042137469204303531", settings: "6032742198179532882" };
const emoji = (id, fallback) => '<tg-emoji emoji-id="' + id + '">' + fallback + '</tg-emoji>';
const startHtml = emoji(EMOJI.bot, "🤖") + " <b>Добро пожаловать в Dupny!</b>\n\n" +
  emoji(EMOJI.home, "🏠") + " Смотри фильмы и слушай музыку с друзьями.\n\n/start — главная\n/help — помощь\n/settings — настройки";
const startPlain = "🎬 Добро пожаловать в Dupny!\n\nСмотри фильмы и слушай музыку с друзьями.\n\n/start — главная\n/help — помощь\n/settings — настройки";
let stopping = false, offset = 0;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function api(method, payload = {}, timeoutMs = 45000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch("https://api.telegram.org/bot" + TOKEN + "/" + method, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      const error = new Error(method + ": " + (data.description || response.status));
      error.status = data.error_code || response.status;
      throw error;
    }
    return data.result;
  } finally { clearTimeout(timer); }
}
function keyboard(premium) {
  const open = { text: premium ? "Открыть Dupny" : "🏠 Открыть Dupny", url: SITE };
  const help = { text: premium ? "Помощь" : "❔ Помощь", callback_data: "help" };
  if (premium) {
    open.icon_custom_emoji_id = EMOJI.home;
    help.icon_custom_emoji_id = EMOJI.bot;
  }
  return { inline_keyboard: [[open], [help]] };
}
async function send(chatId, html, plain, premium = true) {
  try {
    return await api("sendMessage", {
      chat_id: chatId,
      text: premium ? html : plain,
      parse_mode: premium ? "HTML" : undefined,
      reply_markup: keyboard(premium),
      disable_web_page_preview: true
    });
  } catch (error) {
    if (premium && error.status === 400) {
      console.warn("Custom emoji not available; using ordinary emoji.");
      return send(chatId, html, plain, false);
    }
    throw error;
  }
}
async function handleMessage(message) {
  if (!message.text || !message.chat?.id) return;
  const cmd = message.text.trim().split(/\s+/)[0].toLowerCase().split("@")[0];
  const chatId = message.chat.id;
  if (cmd === "/start") return send(chatId, startHtml, startPlain);
  if (cmd === "/help") {
    const h = emoji(EMOJI.bot, "🤖") + " <b>Помощь Dupny</b>\n\n/start — главная\n/help — помощь\n/settings — настройки\n/about — о проекте";
    const p = "🤖 Помощь Dupny\n\n/start — главная\n/help — помощь\n/settings — настройки\n/about — о проекте";
    return send(chatId, h, p);
  }
  if (cmd === "/settings") {
    const h = emoji(EMOJI.settings, "⚙️") + " <b>Настройки Dupny</b>\n\nПрофиль, видео и комнаты на сайте. Открой его кнопкой ниже.";
    const p = "⚙️ Настройки Dupny\n\nПрофиль, видео и комнаты на сайте. Открой его кнопкой ниже.";
    return send(chatId, h, p);
  }
  if (cmd === "/about") {
    const h = emoji(EMOJI.bot, "🤖") + " <b>Dupny (Дупни)</b>\n\nБот для совместного просмотра фильмов и музыки.";
    const p = "🤖 Dupny (Дупни)\n\nБот для совместного просмотра фильмов и музыки.";
    return send(chatId, h, p);
  }
  if (message.chat.type === "private") return send(chatId, startHtml, startPlain);
}
async function handleCallback(query) {
  await api("answerCallbackQuery", { callback_query_id: query.id }).catch(() => {});
  if (query.data === "help" && query.message?.chat?.id) {
    return send(query.message.chat.id,
      emoji(EMOJI.bot, "🤖") + " <b>Команды Dupny</b>\n\n/start, /help, /settings, /about",
      "🤖 Команды Dupny\n\n/start, /help, /settings, /about");
  }
}
async function init() {
  const me = await api("getMe");
  console.log("Dupny bot connected: @" + me.username + " (ID " + me.id + ")");
  await api("deleteWebhook", { drop_pending_updates: false });
  const profile = [
    ["setMyName", { name: "Dupny | Дупни" }],
    ["setMyDescription", { description: "Dupny — фильмы, музыка и совместный просмотр с друзьями. Открывай сайт через бота." }],
    ["setMyShortDescription", { short_description: "Фильмы, музыка и комнаты с друзьями 🎬" }],
    ["setMyCommands", { commands: [
      { command: "start", description: "Главная" },
      { command: "help", description: "Помощь" },
      { command: "settings", description: "Настройки" },
      { command: "about", description: "О проекте" }
    ] }]
  ];
  for (const [name, payload] of profile) {
    try { await api(name, payload); }
    catch (error) { console.warn("Cannot update " + name + ": " + error.message); }
  }
  console.log("Dupny started; long polling active.");
}
try { await init(); }
catch (error) { console.error("Dupny startup failed: " + error.message); process.exit(1); }
while (!stopping) {
  try {
    const updates = await api("getUpdates", {
      offset, limit: 50, timeout: 25, allowed_updates: ["message", "callback_query"]
    }, 40000);
    for (const update of updates) {
      offset = update.update_id + 1;
      try {
        if (update.message) await handleMessage(update.message);
        if (update.callback_query) await handleCallback(update.callback_query);
      } catch (error) { console.error("Update failed: " + error.message); }
    }
  } catch (error) {
    if (stopping) break;
    console.error("Telegram polling: " + error.message);
    await sleep(error.status === 429 ? 7000 : 3000);
  }
}
console.log("Dupny stopped.");
