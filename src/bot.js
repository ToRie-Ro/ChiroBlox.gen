const { Telegraf, Markup } = require('telegraf');
const { decryptSecret } = require('./security');
const db = require('./db');

function buildBot() {
  const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
  const apiBase = (process.env.INTERNAL_API_URL || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/$/, '');

  // Global bot error handler to avoid unhandled rejections during webhook updates
  bot.catch((err, ctx) => {
    console.error(`Error in bot update (${ctx.updateType}):`, err);
    ctx.reply('⚠️ An error occurred while processing your request. Please try again.').catch(() => {});
  });

  bot.start(async (ctx) => {
    await ctx.reply(
      `Welcome to ChiroBlox ✨\n\nUse the buttons below to check inventory or claim an available item.`,
      Markup.inlineKeyboard([
        [Markup.button.callback('📦 Check Stock', 'stock'), Markup.button.callback('🎲 Random Claim', 'random')],
        [Markup.button.callback('ℹ️ Help', 'help')]
      ])
    );
  });

  bot.help(async (ctx) => {
    await ctx.reply('Commands:\n/stock — available inventory\n/random — claim one available item\n/help — show help');
  });

  bot.command('stock', async (ctx) => {
    try {
      const stats = await db.getStats();
      await ctx.reply(`📦 ChiroBlox Stock\n\nAvailable: ${stats.available}\nClaimed: ${stats.claimed}\nTotal: ${stats.total}`);
    } catch (err) {
      console.error('Stock command error:', err);
      await ctx.reply('⚠️ Failed to retrieve stock.');
    }
  });

  async function randomClaim(ctx) {
    let payload;
    try {
      const response = await fetch(`${apiBase}/api/bot/claim-random`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-bot-token': process.env.BOT_INTERNAL_TOKEN
        },
        body: JSON.stringify({
          telegramUserId: ctx.from.id,
          telegramUsername: ctx.from.username || null
        })
      });
      payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Claim failed');
    } catch (fetchErr) {
      // Direct database fallback if internal loopback fetch is unreachable
      console.warn('Internal API claim failed, using direct DB fallback:', fetchErr.message);
      const claim = await db.claimRandomAccount({
        telegramUserId: ctx.from.id,
        telegramUsername: ctx.from.username || null
      });
      payload = { claim };
    }

    if (!payload.claim) {
      await ctx.reply('⚠️ There is no available stock right now.');
      return;
    }

    const password = decryptSecret(payload.claim);
    await ctx.reply(
      `✅ Claim successful\n\nUsername: ${payload.claim.username}\nSecret: ${password}\n\nKeep this information private.`,
      { disable_web_page_preview: true }
    );
  }

  bot.command('random', async (ctx) => {
    try {
      await randomClaim(ctx);
    } catch (err) {
      console.error('Random command error:', err);
      await ctx.reply('⚠️ Something went wrong while claiming stock.');
    }
  });

  bot.action('stock', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    try {
      const stats = await db.getStats();
      await ctx.reply(`📦 Available: ${stats.available}\n🎯 Claimed today: ${stats.claims_today}`);
    } catch (err) {
      await ctx.reply('⚠️ Failed to retrieve stock.');
    }
  });

  bot.action('random', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    try {
      await randomClaim(ctx);
    } catch (error) {
      await ctx.reply('⚠️ Something went wrong while claiming stock.');
    }
  });

  bot.action('help', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await ctx.reply('Use /stock to check inventory or /random to claim one available item.');
  });

  return bot;
}

module.exports = { buildBot };
