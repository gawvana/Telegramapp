// Telegram-only entry screen: password and registration forms are intentionally absent.
import { h } from '../util.js';
import { logo } from '../icons.js';
export function loginPage(root) {
  root.replaceChildren(h('div.auth',
    h('div.auth-card',
      logo('auth-logo'),
      h('div.eyebrow', 'Telegram Mini App'),
      h('h1.h1', 'Dupny'),
      h('p', 'Вход выполняется автоматически через твой Telegram-аккаунт. Логин и пароль не требуются.'),
      h('a.btn.btn-primary.btn-l.btn-block', { href: 'https://t.me/DupnyApp', target: '_blank', rel: 'noopener noreferrer' }, 'Открыть Dupny в Telegram')
    )));
}
export function invitePage(root) { loginPage(root); }
