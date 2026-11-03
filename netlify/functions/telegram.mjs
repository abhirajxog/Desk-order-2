// Telegram webhook. Telegram calls POST /tg for every message and button tap.
//   GET /tg?setup=1   registers the webhook + the command list (open it once after adding BOT_TOKEN)
//   GET /tg?health=1  shows whether the bot is connected (no secrets)
import { botFromEnv, webhookSecret } from '../lib/bot.mjs';

export const config = { path: '/tg' };

const text = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });

export default async (req) => {
  const token = process.env.BOT_TOKEN;
  if (!token) return text('BOT_TOKEN is not set. Add it in Netlify > Site configuration > Environment variables, then redeploy.', 503);
  const url = new URL(req.url);
  const secret = webhookSecret(token);
  const { tg, bot } = botFromEnv(url.origin);

  if (req.method === 'GET') {
    if (url.searchParams.get('setup')) {
      const hook = await tg('setWebhook', {
        url: `${url.origin}/tg`,
        secret_token: secret,
        allowed_updates: ['message', 'callback_query'],
        max_connections: 20,
      });
      await tg('setMyCommands', {
        commands: [
          { command: 'start', description: 'Open the menu' },
          { command: 'menu', description: 'Show the menu' },
          { command: 'cancel', description: 'Cancel what you are typing' },
        ],
      });
      return text(hook.ok ? `Webhook is set to ${url.origin}/tg\nNow open your bot in Telegram and send /start.` : `Telegram refused the webhook: ${hook.description}`, hook.ok ? 200 : 500);
    }
    if (url.searchParams.get('health')) {
      const me = await tg('getMe', {});
      const wh = await tg('getWebhookInfo', {});
      return text(
        me.ok
          ? `Bot: @${me.result.username}\nWebhook: ${(wh.result && wh.result.url) || 'not set'}\nPending updates: ${wh.result ? wh.result.pending_update_count : '?'}\nLast error: ${(wh.result && wh.result.last_error_message) || 'none'}`
          : 'BOT_TOKEN looks wrong: Telegram did not accept it.'
      );
    }
    if (url.searchParams.get('kick') && req.headers.get('x-kick') === secret) {
      await bot.drain(8000);
      return text('ok');
    }
    return text('Order bot is running.');
  }

  if (req.method !== 'POST') return text('Method not allowed', 405);
  if (req.headers.get('x-telegram-bot-api-secret-token') !== secret) return text('Forbidden', 403);
  let upd;
  try {
    upd = await req.json();
  } catch {
    return text('Bad request', 400);
  }
  // always answer 200 so Telegram does not retry (retries could repeat an action)
  try {
    await bot.handleUpdate(upd);
  } catch (e) {
    console.error('webhook error:', e && e.message);
  }
  return text('ok');
};
