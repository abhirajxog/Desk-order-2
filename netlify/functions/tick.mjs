// Runs every minute: closes expired orders, sends the 1 minute reminders, finishes slow broadcasts
// and posts the daily leaderboard at 9 PM IST. When nothing is live it only reads one small key.
import { botFromEnv } from '../lib/bot.mjs';

export const config = { schedule: '* * * * *' };

export default async () => {
  if (!process.env.BOT_TOKEN) return;
  try {
    await botFromEnv().bot.sweep();
  } catch (e) {
    console.error('tick error:', e && e.message);
  }
};
