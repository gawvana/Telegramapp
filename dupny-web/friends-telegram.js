// Telegram friends. Reliable referral links, visible address and manual copy fallback.
import { h, copyText } from '../util.js';
import { icon } from '../icons.js';
import { get } from '../api.js';
import { toast, avatar } from '../ui.js';

const validReferral = url => /^https:\/\/t\.me\/DupnyApp\?start=ref_\d{4,18}$/.test(url);
const referralLink = () => {
  const saved = window.__dupnyMiniApp?.inviteUrl || '';
  if (validReferral(saved)) return saved;
  const id = String(window.__dupnyMiniApp?.telegram?.id || '');
  return /^\d{4,18}$/.test(id) ? 'https://t.me/DupnyApp?start=ref_' + id : '';
};

async function copyInvite() {
  const url = referralLink();
  if (!validReferral(url)) return toast('Нет ссылки приглашения. Переоткрой Mini App через Telegram.');
  const ok = await copyText(url);
  toast(ok ? 'Ссылка приглашения скопирована' : 'Скопируй ссылку из поля ниже вручную');
}

async function shareInvite() {
  const url = referralLink();
  if (!validReferral(url)) return toast('Не удалось получить ссылку. Переоткрой Mini App.');
  const message = 'Заходи в Dupny! Будем смотреть фильмы и слушать музыку вместе 🎬';
  const share = 'https://t.me/share/url?url=' + encodeURIComponent(url) +
    '&text=' + encodeURIComponent(message);
  const tg = window.Telegram?.WebApp;
  if (typeof tg?.openTelegramLink === 'function') {
    try {
      tg.openTelegramLink(share);
      return;
    } catch (error) {
      console.warn('Telegram sharing is not available:', error);
    }
  }
  if (typeof navigator.share === 'function') {
    try { await navigator.share({ title: 'Dupny', text: message, url }); return; }
    catch (error) { if (error?.name === 'AbortError') return; }
  }
  await copyInvite();
}

export function friendsPage(root) {
  root.classList.add('narrow');
  const list = h('div.list', h('p', 'Загрузка друзей…'));
  const ownUrl = referralLink();
  const canShare = validReferral(ownUrl);
  const share = h('button.btn.btn-primary', { type: 'button', onclick: shareInvite, disabled: !canShare },
    icon('mail', 'ic-s'), h('span', 'Отправить другу'));
  const copy = h('button.btn', { type: 'button', onclick: copyInvite, disabled: !canShare },
    icon('link', 'ic-s'), h('span', 'Копировать ссылку'));
  const address = h('input', {
    type: 'text', readOnly: true, value: ownUrl || 'Нет ссылки приглашения',
    'aria-label': 'Личная ссылка приглашения',
    onclick: e => e.currentTarget.select(),
    style: { width: '100%', minWidth: 0 }
  });
  root.append(
    h('header.page-head',
      h('div', h('div.eyebrow', 'Dupny'), h('h1.h1', 'Друзья'))),
    h('div.group',
      h('div.eyebrow', 'Приглашение в Telegram'),
      h('p', 'Отправь другу личную ссылку. После открытия бота нажми «Открыть Mini App».'),
      h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', margin: '12px 0' } }, share, copy),
      address
    ),
    h('div.group',
      h('div.eyebrow', 'Мои друзья'),
      h('button.btn.btn-s', { type: 'button', onclick: refreshFriends }, 'Обновить список'),
      list)
  );
  async function refreshFriends() {
    list.replaceChildren(h('p', 'Обновляем список друзей…'));
    try {
      const { friends = [] } = await get('/api/friends');
      if (!friends.length) {
        list.replaceChildren(h('p', 'Пока никого нет. Отправь приглашение и попроси друга открыть Mini App.'));
        return;
      }
      list.replaceChildren(...friends.map((f, i) =>
        h('div.item', { style: { '--i': i } },
          avatar(f),
          h('div.grow',
            h('b.clip', f.name),
            h('span', (f.login?.startsWith('@') ? f.login + ' · ' : '') +
              (f.role === 'owner' ? 'владелец' : 'участник') +
              (f.online ? ' · в сети' : ''))
          ),
          f.role === 'owner' ? h('span.chip', icon('crown', 'ic-s'), 'владелец') : null
        )));
    } catch (error) {
      list.replaceChildren(h('p', error.message || 'Не удалось загрузить друзей'));
    }
  }
  refreshFriends();
}
