// Friends in Dupny: Telegram invitation only, no account registration screen.
import { h, copyText } from '../util.js';
import { icon } from '../icons.js';
import { get } from '../api.js';
import { toast, avatar } from '../ui.js';

function shareInvite() {
  const own = window.__dupnyMiniApp?.inviteUrl || 'https://t.me/DupnyApp';
  const url = 'https://t.me/share/url?url=' + encodeURIComponent(own) +
    '&text=' + encodeURIComponent('Присоединяйся к Dupny! 🎬');
  const tg = window.Telegram?.WebApp;
  if (typeof tg?.openTelegramLink === 'function') tg.openTelegramLink(url);
  else copyText(own).then(ok => toast(ok ? 'Ссылка скопирована' : 'Пригласи друга через @DupnyApp'));
}
export function friendsPage(root) {
  root.classList.add('narrow');
  const list = h('div.list', h('p', 'Загрузка друзей…'));
  const share = h('button.btn.btn-primary', { type: 'button', onclick: shareInvite },
    icon('mail', 'ic-s'), h('span', 'Пригласить в Telegram'));
  root.append(
    h('header.page-head',
      h('div', h('div.eyebrow', 'Dupny'), h('h1.h1', 'Друзья')),
      h('div.page-tools', share)),
    h('div.group', h('div.eyebrow', 'Участники'), list)
  );
  get('/api/friends').then(({ friends }) => {
    if (!friends.length) { list.replaceChildren(h('p', 'Пригласи первого друга через Telegram.')); return; }
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
  }).catch(err => list.replaceChildren(h('p', err.message || 'Не удалось загрузить друзей')));
}
