import TelegramBot from 'node-telegram-bot-api';
const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("BOT_TOKEN is required");
  process.exit(1);
}
const bot = new TelegramBot(token, {polling: true});
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'مرحباً! البوت يعمل بنجاح على Render 🚀');
});
console.log("Bot is running...");
