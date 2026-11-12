// Friends tab for everyone; private invite relationships for non-owners.
import fs from 'node:fs';
import path from 'node:path';
export function applyFriendAccess(root) {
  function modify(filename, transform) {
    const file = path.join(root, filename);
    const source = fs.readFileSync(file, 'utf8');
    const changed = transform(source);
    if (changed === source) throw Error('No friend access changes in ' + filename);
    fs.writeFileSync(file, changed);
  }
  function once(text, original, replacement, label) {
    const matches = text.split(original).length - 1;
    if (matches !== 1) throw Error('Friend access patch ' + label + ': ' + matches + ' matches');
    return text.replace(original, replacement);
  }
  modify('public/js/app.js', c => {
    c = once(c, "{ re: /^\\/friends\\/?$/, mount: friendsPage, nav: 'friends', owner: true },",
      "{ re: /^\\/friends\\/?$/, mount: friendsPage, nav: 'friends' },", 'public route');
    c = once(c, "    me.role === 'owner' ? { key: 'friends', href: '/friends', icon: 'users', label: 'Друзья' } : null,",
      "    { key: 'friends', href: '/friends', icon: 'users', label: 'Друзья' },", 'navbar');
    return c;
  });
  modify('server/routes.js', c => {
    const old = /  route\('GET', '\/api\/friends', async \(\{ res \}\) => \{[\s\S]*?\n  \}, \{ auth: 'owner' \}\);/;
    if (!old.test(c)) throw Error('Owner-only friends API not found');
    const fresh = [
      "  route('GET', '/api/friends', async ({ res, user }) => {",
      "    const online = new Set(hub.onlineIds());",
      "    const now = Date.now();",
      "    let friends;",
      "    if (user.role === 'owner') {",
      "      friends = sql('SELECT * FROM users ORDER BY role DESC, created_at').all();",
      "    } else {",
      "      // Only expose the inviter and accounts invited by this user.",
      "      const me = sql('SELECT telegram_id, referred_by FROM telegram_accounts WHERE user_id = ?').get(user.id);",
      "      friends = me ? sql(",
      "        'SELECT u.* FROM users u JOIN telegram_accounts a ON a.user_id = u.id ' +",
      "        'WHERE a.telegram_id = ? OR a.referred_by = ? ORDER BY u.created_at DESC'",
      "      ).all(me.referred_by || 'none', me.telegram_id) : [];",
      "    }",
      "    sendJson(res, 200, {",
      "      friends: friends.map(u => ({",
      "        ...auth.publicUser(u), createdAt: u.created_at, online: online.has(u.id),",
      "      })),",
      "      invites: user.role === 'owner'",
      "        ? sql('SELECT * FROM invites WHERE used_by IS NULL AND expires_at > ? ORDER BY created_at DESC').all(now)",
      "          .map(i => ({ token: i.token, createdAt: i.created_at, expiresAt: i.expires_at }))",
      "        : [],",
      "    });",
      "  });"
    ].join('\n');
    return c.replace(old, fresh);
  });
}
