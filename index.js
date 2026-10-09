const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { Pool } = require('pg');

(function loadEnv() {
  try {
    const lines = fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
})();

const TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_ID = Number(process.env.ADMIN_ID || 0);
const EXPIRE_SECONDS = Number(process.env.EXPIRE_SECONDS ?? 900);
const STORAGE_LIMIT = 2 * 1024 * 1024 * 1024;
const HEALTH_PORT = Number(process.env.HEALTH_PORT || process.env.PORT || 3999);

const startedAt = Date.now();
let lastPollOk = 0;

const DB = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL }
  : {
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT || 5432),
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASS || '890890',
      database: process.env.DB_NAME || 'videovault',
    };

let BOT_USERNAME = '';
let pool;

async function ensureDatabase() {
  if (DB.connectionString) {
    const t = new Pool({ connectionString: DB.connectionString, max: 1 });
    await t.query('SELECT 1');
    await t.end();
    return;
  }
  const admin = new Pool({ ...DB, database: 'postgres', max: 1 });
  const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB.database]);
  if (!rows.length) await admin.query(`CREATE DATABASE ${DB.database}`);
  await admin.end();
}

async function ensureTable() {
  pool = new Pool(DB);
  await pool.query(`CREATE TABLE IF NOT EXISTS files (
    id text PRIMARY KEY,
    file_id text NOT NULL,
    kind text NOT NULL,
    name text,
    mime text,
    size bigint DEFAULT 0,
    views integer DEFAULT 0,
    stored_at timestamptz DEFAULT now()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS bundles (
    id text PRIMARY KEY,
    file_ids jsonb NOT NULL,
    views integer DEFAULT 0,
    stored_at timestamptz DEFAULT now()
  )`);
  await pool.query('ALTER TABLE files ADD COLUMN IF NOT EXISTS bundle_id text');
  await pool.query(`UPDATE files f SET bundle_id = b.id FROM bundles b
    WHERE f.bundle_id IS NULL AND f.id IN (SELECT jsonb_array_elements_text(b.file_ids))`);
}

async function api(method, params = {}) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || method);
  return data.result;
}

function send(chatId, html, extra = {}) {
  return api('sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function humanSize(bytes) {
  bytes = Number(bytes) || 0;
  if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 ** 3).toFixed(2) + ' GB';
  if (bytes >= 1024 * 1024) return (bytes / 1024 ** 2).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

function bar(used, limit, width = 10) {
  const filled = Math.max(0, Math.min(width, Math.round((used / limit) * width)));
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

function expiryLabel() {
  if (EXPIRE_SECONDS <= 0) return 'stays in the chat';
  const mins = Math.max(1, Math.round(EXPIRE_SECONDS / 60));
  return `gone after ${mins} mins`;
}

function kindIcon(kind) {
  if (kind === 'photo') return '🖼';
  if (kind === 'video' || kind === 'document_video' || kind === 'animation') return '🎬';
  if (kind === 'audio' || kind === 'voice') return '🎵';
  return '📦';
}

function trunc(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

async function usedBytes() {
  const { rows } = await pool.query('SELECT COALESCE(SUM(size), 0) AS total FROM files');
  return Number(rows[0].total);
}

async function getFilesOrdered() {
  const { rows } = await pool.query('SELECT * FROM files WHERE bundle_id IS NULL ORDER BY stored_at ASC, id ASC');
  return rows;
}

async function getBundles() {
  const { rows } = await pool.query('SELECT * FROM bundles ORDER BY stored_at ASC, id ASC');
  return rows;
}

function pickFile(msg) {
  if (msg.video) return { kind: 'video', fileId: msg.video.file_id, name: msg.video.file_name || 'video.mp4', size: msg.video.file_size || 0, mime: msg.video.mime_type || 'video/mp4' };
  if (msg.animation) return { kind: 'animation', fileId: msg.animation.file_id, name: msg.animation.file_name || 'animation.mp4', size: msg.animation.file_size || 0, mime: msg.animation.mime_type || 'video/mp4' };
  if (msg.photo && msg.photo.length) {
    const p = msg.photo[msg.photo.length - 1];
    return { kind: 'photo', fileId: p.file_id, name: 'photo.jpg', size: p.file_size || 0, mime: 'image/jpeg' };
  }
  if (msg.audio) return { kind: 'audio', fileId: msg.audio.file_id, name: msg.audio.file_name || 'audio.mp3', size: msg.audio.file_size || 0, mime: msg.audio.mime_type || 'audio/mpeg' };
  if (msg.voice) return { kind: 'voice', fileId: msg.voice.file_id, name: 'voice.ogg', size: msg.voice.file_size || 0, mime: 'audio/ogg' };
  if (msg.document) {
    const mime = msg.document.mime_type || '';
    if (mime.startsWith('video/')) return { kind: 'document_video', fileId: msg.document.file_id, name: msg.document.file_name || 'video.mp4', size: msg.document.file_size || 0, mime };
    return { kind: 'document', fileId: msg.document.file_id, name: msg.document.file_name || 'file.bin', size: msg.document.file_size || 0, mime };
  }
  return null;
}

async function sendMedia(chatId, entry, caption, reply_markup) {
  const base = { chat_id: chatId, parse_mode: 'HTML', reply_markup };
  if (entry.kind === 'photo') return api('sendPhoto', { ...base, photo: entry.file_id, caption });
  if (entry.kind === 'video' || entry.kind === 'document_video') return api('sendVideo', { ...base, video: entry.file_id, supports_streaming: true, caption });
  if (entry.kind === 'animation') return api('sendAnimation', { ...base, animation: entry.file_id, caption });
  if (entry.kind === 'audio') return api('sendAudio', { ...base, audio: entry.file_id, caption });
  if (entry.kind === 'voice') return api('sendVoice', { ...base, voice: entry.file_id, caption });
  return api('sendDocument', { ...base, document: entry.file_id, caption, disable_content_type_detection: true });
}

async function deliver(chatId, id) {
  const { rows } = await pool.query('SELECT * FROM files WHERE id = $1', [id]);
  if (rows[0]) return deliverFile(chatId, rows[0]);
  const b = await pool.query('SELECT * FROM bundles WHERE id = $1', [id]);
  if (b.rows[0]) return deliverBundle(chatId, b.rows[0]);
  await send(chatId, '⛔ <b>Link expired</b>\nThis file is no longer available.');
}

async function deliverFile(chatId, entry) {
  const caption = `${kindIcon(entry.kind)} <b>${esc(entry.name)}</b>`;
  let sent;
  try {
    sent = await sendMedia(chatId, entry, caption);
  } catch {
    await send(chatId, '⛔ Could not deliver this file. Ask the owner to re-upload it.');
    return;
  }
  await pool.query('UPDATE files SET views = views + 1 WHERE id = $1', [entry.id]);
  const ids = [sent.message_id];
  const warn = await expiryWarning(chatId);
  if (warn) ids.push(warn.message_id);
  scheduleDelete(chatId, ids);
}

async function deliverBundle(chatId, bundle) {
  const { rows: files } = await pool.query('SELECT * FROM files WHERE bundle_id = $1 ORDER BY stored_at ASC, id ASC', [bundle.id]);
  if (!files.length) {
    await send(chatId, '⛔ <b>Link expired</b>\nAll files in this bundle were removed.');
    return;
  }
  await send(chatId, `💼 <b>Bundle</b> — ${files.length} files coming one by one...`);
  const ids = [];
  for (const f of files) {
    const caption = `${kindIcon(f.kind)} <b>${esc(f.name)}</b>`;
    try {
      const s = await sendMedia(chatId, f, caption);
      ids.push(s.message_id);
    } catch {}
    await sleep(1200);
  }
  await pool.query('UPDATE bundles SET views = views + 1 WHERE id = $1', [bundle.id]);
  const warn = await expiryWarning(chatId);
  if (warn) ids.push(warn.message_id);
  scheduleDelete(chatId, ids);
}

async function expiryWarning(chatId) {
  if (EXPIRE_SECONDS <= 0) return null;
  const mins = Math.max(1, Math.round(EXPIRE_SECONDS / 60));
  return send(chatId,
    `⏳ <b>Heads up!</b>\n\nThese files delete themselves from this chat in ${mins} minutes.\n💾 <b>Save or forward them NOW</b> if you want to keep them!`
  ).catch(() => null);
}

function scheduleDelete(chatId, messageIds) {
  if (EXPIRE_SECONDS <= 0) return;
  setTimeout(() => {
    for (const mid of messageIds) {
      api('deleteMessage', { chat_id: chatId, message_id: mid }).catch(() => {});
    }
  }, EXPIRE_SECONDS * 1000);
}

let collection = [];
let collectionMsg = null;

const collectionKeyboard = {
  inline_keyboard: [
    [{ text: '✅ Create Link', callback_data: 'c:make' }, { text: '⭮ Cancel', callback_data: 'c:cancel' }],
  ],
};

function collectionCard() {
  const lines = collection.map((f, i) => `${i + 1}. ${kindIcon(f.kind)} ${esc(f.name)}`);
  return `📥 <b>Bulk: ${collection.length} file${collection.length === 1 ? '' : 's'}</b>\n\n${lines.join('\n')}\n\nKeep sending files to add them —\nor press ✅ to get your link`;
}

async function addToCollection(msg, entry) {
  const queued = collection.reduce((s, f) => s + f.size, 0);
  const projected = (await usedBytes()) + queued + entry.size;
  if (projected > STORAGE_LIMIT) {
    const used = await usedBytes();
    await send(msg.chat.id, `🚫 <b>Storage full</b>\n\n${bar(used, STORAGE_LIMIT)} ${humanSize(used)} of 2 GB\nDelete something with 📂 My Files.`);
    return;
  }
  collection.push(entry);
  if (collectionMsg) {
    try {
      await api('editMessageText', { chat_id: msg.chat.id, message_id: collectionMsg, text: collectionCard(), parse_mode: 'HTML', reply_markup: collectionKeyboard });
      return;
    } catch {
      collectionMsg = null;
    }
  }
  const sent = await send(msg.chat.id, collectionCard(), { reply_markup: collectionKeyboard });
  collectionMsg = sent.message_id;
}

async function finalizeCollection(chatId) {
  if (!collection.length) return { toast: 'Nothing collected yet' };
  const count = collection.length;
  let linkId;
  if (count > 1) {
    linkId = crypto.randomBytes(16).toString('base64url');
    const ids = collection.map(() => crypto.randomBytes(16).toString('base64url'));
    await pool.query('INSERT INTO bundles (id, file_ids) VALUES ($1, $2::jsonb)', [linkId, JSON.stringify(ids)]);
    for (let i = 0; i < count; i++) {
      const f = collection[i];
      await pool.query('INSERT INTO files (id, file_id, kind, name, mime, size, bundle_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [ids[i], f.fileId, f.kind, f.name, f.mime, f.size, linkId]);
    }
  } else {
    linkId = crypto.randomBytes(16).toString('base64url');
    const f = collection[0];
    await pool.query('INSERT INTO files (id, file_id, kind, name, mime, size) VALUES ($1, $2, $3, $4, $5, $6)',
      [linkId, f.fileId, f.kind, f.name, f.mime, f.size]);
  }
  collection = [];
  collectionMsg = null;
  const link = `${BOT_USERNAME}?start=${linkId}`;
  await send(chatId,
    `${count > 1 ? `🚀 <b>One link · ${count} files</b>` : '🚀 <b>Link ready</b>'}\n\n🔗 <a href="${link}">Open</a> · <code>${link}</code>\n⏳ Viewers: ${expiryLabel()}`,
    { reply_markup: { inline_keyboard: [[{ text: '📂 My Files', callback_data: 'm:files' }]] } });
  return { toast: 'Link created ✅' };
}

function listText(files, bundles) {
  const lines = files.map((f, i) => `${i + 1}. ${kindIcon(f.kind)} <b>${esc(f.name)}</b> · ${f.views} views · <a href="${BOT_USERNAME}?start=${f.id}">link</a>`);
  const bl = bundles.map((b, i) => `${files.length + i + 1}. 💼 <b>Bundle</b> · ${b.file_ids.length} files · ${b.views} views · <a href="${BOT_USERNAME}?start=${b.id}">link</a>`);
  return `📂 <b>My Stuff</b> — ${files.length} files · ${bundles.length} bundles\n\n${[...lines, ...bl].join('\n\n')}\n\n🗑 Tap a button below to delete:`;
}

function listKeyboard(files, bundles) {
  const rows = [];
  const perRow = 2;
  const items = [
    ...files.map((f) => ({ text: `🗑 ${trunc(f.name, 24)}`, callback_data: `d:f:${f.id}` })),
    ...bundles.map((b, i) => ({ text: `🗑 Bundle ${i + 1} (${b.file_ids.length})`, callback_data: `d:b:${b.id}` })),
  ];
  for (let i = 0; i < items.length; i += perRow) rows.push(items.slice(i, i + perRow));
  rows.push([{ text: '💾 Storage', callback_data: 'm:storage' }, { text: '✖️ Close', callback_data: 'c:close' }]);
  return { inline_keyboard: rows };
}

async function storageText() {
  const used = await usedBytes();
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM files');
  const { rows: br } = await pool.query('SELECT COUNT(*)::int AS c FROM bundles');
  return `💾 <b>Storage</b>\n\n${bar(used, STORAGE_LIMIT)}\n${humanSize(used)} used · ${humanSize(STORAGE_LIMIT - used)} free\nLimit: 2 GB\nFiles: ${rows[0].c} · Bundles: ${br[0].c}`;
}

async function editBackToList(chatId, mid) {
  const files = await getFilesOrdered();
  const bundles = await getBundles();
  if (!files.length && !bundles.length) {
    await api('editMessageText', { chat_id: chatId, message_id: mid, text: '📂 <b>Empty</b> — nothing left.\nSend me a file to store a new one.', parse_mode: 'HTML' });
    return;
  }
  await api('editMessageText', { chat_id: chatId, message_id: mid, text: listText(files, bundles), parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: listKeyboard(files, bundles) });
}

async function handleCallback(q) {
  const answer = (opts = {}) => api('answerCallbackQuery', { callback_query_id: q.id, ...opts }).catch(() => {});
  const msg = q.message;
  if (!msg || !msg.chat) return answer();
  const chatId = msg.chat.id;
  const mid = msg.message_id;
  const data = q.data || '';

  try {
    if (chatId !== ADMIN_ID) return answer({ text: '🔒 Owner only', show_alert: true });

    if (data === 'm:files') {
      const files = await getFilesOrdered();
      const bundles = await getBundles();
      if (!files.length && !bundles.length) return answer({ text: 'Empty! Send me a file first 😄' });
      await api('editMessageText', { chat_id: chatId, message_id: mid, text: listText(files, bundles), parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: listKeyboard(files, bundles) });
      return answer();
    }

    if (data === 'm:storage') {
      await api('editMessageText', {
        chat_id: chatId, message_id: mid, text: await storageText(), parse_mode: 'HTML', disable_web_page_preview: true,
        reply_markup: { inline_keyboard: [[{ text: '📂 My Files', callback_data: 'm:files' }, { text: '🔄 Refresh', callback_data: 'm:storage' }]] },
      });
      return answer();
    }

    if (data.startsWith('d:f:')) {
      const id = data.slice(4);
      const { rows } = await pool.query('DELETE FROM files WHERE id = $1 RETURNING name, kind', [id]);
      await editBackToList(chatId, mid);
      return answer(rows.length ? { text: `🗑 ${trunc(rows[0].name, 30)}` } : { text: 'Already deleted' });
    }

    if (data.startsWith('d:b:')) {
      const id = data.slice(4);
      const { rows } = await pool.query('DELETE FROM bundles WHERE id = $1 RETURNING file_ids', [id]);
      if (rows.length) await pool.query('DELETE FROM files WHERE bundle_id = $1', [id]);
      await editBackToList(chatId, mid);
      return answer(rows.length ? { text: `🗑 Bundle deleted · ${rows[0].file_ids.length} files removed too` } : { text: 'Already deleted' });
    }

    if (data === 'c:make') {
      const r = await finalizeCollection(chatId);
      await api('editMessageText', { chat_id: chatId, message_id: mid, text: '✅ <b>Link created</b> — check below 👇', parse_mode: 'HTML' }).catch(() => {});
      return answer(r.toast ? { text: r.toast, show_alert: !r.ok && r.toast !== 'Link created ✅' } : {});
    }

    if (data === 'c:cancel') {
      const n = collection.length;
      collection = [];
      collectionMsg = null;
      await api('editMessageText', { chat_id: chatId, message_id: mid, text: `⭮ <b>Cancelled</b>\n${n} file${n === 1 ? '' : 's'} discarded — nothing was saved.`, parse_mode: 'HTML' });
      return answer();
    }

    if (data === 'c:close') {
      await api('deleteMessage', { chat_id: chatId, message_id: mid }).catch(() => {});
      return answer();
    }

    return answer();
  } catch (err) {
    return answer({ text: '⛔ ' + err.message, show_alert: true });
  }
}

async function welcome(chatId) {
  if (chatId === ADMIN_ID) {
    const used = await usedBytes();
    await send(chatId,
      `👑 <b>Your vault is ready</b>\n\nSend me any video, photo or file.\nI'll ask for more — or confirm for your link.\nOne link can carry as many files as you want.\n\n💾 ${bar(used, STORAGE_LIMIT)} ${humanSize(used)} / 2 GB`,
      { reply_markup: { inline_keyboard: [[{ text: '📂 My Files', callback_data: 'm:files' }, { text: '💾 Storage', callback_data: 'm:storage' }]] } });
  } else {
    await send(chatId, '📁 <b>Temporary File Vault</b>\n\nThis bot stores files for a short time and hands them out through share links.\n\n🔑 Got a link from the owner? Open it and your file will appear here.\n⏳ It stays only for a few minutes — save or forward it before it disappears.');
  }
}

async function handleMessage(msg) {
  if (!msg || !msg.from || msg.chat.type !== 'private') return;
  const chatId = msg.chat.id;

  if (msg.text && msg.text.startsWith('/start')) {
    const arg = msg.text.split(' ')[1] || '';
    if (arg && !arg.startsWith('/')) {
      await deliver(chatId, arg);
      return;
    }
    await welcome(chatId);
    return;
  }

  if (chatId !== ADMIN_ID) {
    const entry = pickFile(msg);
    if (entry) await send(chatId, '🔒 Only the owner can store files here.');
    return;
  }

  const entry = pickFile(msg);
  if (entry) {
    await addToCollection(msg, entry);
    return;
  }

  if (msg.text) await send(chatId, '🎞 Send me a video, photo or any file.\n📂 My Files below to manage links.', {
    reply_markup: { inline_keyboard: [[{ text: '📂 My Files', callback_data: 'm:files' }, { text: '💾 Storage', callback_data: 'm:storage' }]] },
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startHealthServer() {
  http.createServer((req, res) => {
    if (req.url !== '/health' && req.url !== '/') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found', endpoints: ['/health'] }));
      return;
    }
    (async () => {
      let dbOk = false;
      let fileCount = 0;
      let used = 0;
      try {
        await pool.query('SELECT 1');
        dbOk = true;
        const r = await pool.query('SELECT COUNT(*)::int AS c, COALESCE(SUM(size), 0) AS s FROM files');
        fileCount = r.rows[0].c;
        used = Number(r.rows[0].s);
      } catch {}
      const botOk = lastPollOk > 0 && Date.now() - lastPollOk < 90000;
      const healthy = dbOk && botOk;
      res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: healthy ? 'ok' : 'degraded',
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        bot: { ok: botOk, username: BOT_USERNAME || null, lastPollOk: lastPollOk ? new Date(lastPollOk).toISOString() : null },
        database: { ok: dbOk, name: DB.database || 'external', filesStored: fileCount, usedBytes: used, limitBytes: STORAGE_LIMIT },
      }));
    })();
  }).listen(HEALTH_PORT, () => console.log(`Health router: http://localhost:${HEALTH_PORT}/health`));
}

async function main() {
  if (!TOKEN) {
    console.error('BOT_TOKEN missing. Put your token from @BotFather into the .env file');
    process.exit(1);
  }
  try {
    await ensureDatabase();
    await ensureTable();
    console.log(DB.connectionString ? 'PostgreSQL ready (DATABASE_URL)' : `PostgreSQL ready: ${DB.user}@${DB.host}:${DB.port}/${DB.database}`);
  } catch (err) {
    console.error('Database failed:', err.message);
    console.error('Check Postgres is running and DB_PASS (default 890890) is correct.');
    process.exit(1);
  }

  startHealthServer();

  let me = null;
  while (!me) {
    try {
      me = await api('getMe');
    } catch (err) {
      console.error('Telegram getMe failed:', err.message, '— retrying in 5s');
      await sleep(5000);
    }
  }
  BOT_USERNAME = `https://t.me/${me.username}`;
  await api('deleteWebhook', { drop_pending_updates: false }).catch(() => {});
  console.log(`Bot @${me.username} running. Admin ID: ${ADMIN_ID || 'NOT SET'}. Link base: ${BOT_USERNAME}`);

  let offset = 0;
  while (true) {
    try {
      const updates = await api('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] });
      lastPollOk = Date.now();
      for (const u of updates) {
        offset = u.update_id + 1;
        try {
          if (u.callback_query) await handleCallback(u.callback_query);
          else if (u.message) await handleMessage(u.message);
        } catch (err) {
          console.error('handler error:', err.message);
        }
      }
    } catch (err) {
      console.error('poll error:', err.message);
      await sleep(3000);
    }
  }
}

main();
