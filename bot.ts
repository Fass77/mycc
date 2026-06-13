import { Bot } from "grammy";
import { db } from "@workspace/db";
import { trackedProductsTable, priceHistoryTable, dealSubscribersTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { scrapeProduct, scrapeAllDeals, scrapeFlashDeals, FlashDeal, Deal, STORE_NAMES, detectStore } from "./scraper";
import { checkProductsForChat } from "./scheduler";
import { logger } from "./logger";

if (!process.env.TELEGRAM_BOT_TOKEN) {
throw new Error("TELEGRAM_BOT_TOKEN is required");
}

export const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

const WELCOME = `مرحباً بك في بوت تتبع الأسعار 🛍️

أراقب أسعار المنتجات في <b>3 متاجر</b> وأخبرك فور نزول السعر!

🛒 أمازون السعودية
🛍️ نون
👗 ترينديول

─────────────────────
📌 <b>تتبع منتجاتك:</b>
/track <رابط> — بدء تتبع منتج
/list — عرض منتجاتك المتتبعة
/check — فحص أسعار منتجاتك الآن
/untrack <رقم> — إيقاف تتبع منتج

🔥 <b>عروض المتاجر:</b>
/deals — أفضل عروض الـ3 متاجر الآن (10%+)
/flash — عروض الفلاش والخاطفة ⚡ (تنتهي قريباً!)
/subscribe — تنبيهات: انخفاض السوق + فلاش + عروض تلقائياً
/unsubscribe — إلغاء الاشتراك

/help — عرض هذه القائمة`;

bot.command("start", (ctx) => ctx.reply(WELCOME, { parse_mode: "HTML" }));
bot.command("help", (ctx) => ctx.reply(WELCOME, { parse_mode: "HTML" }));

// ─── /track ───────────────────────────────────────────────────────────────────

bot.command("track", async (ctx) => {
const text = ctx.message?.text?.trim() ?? "";
const parts = text.split(/\s+/);
if (parts.length < 2 || !parts[1]) {
await ctx.reply(
"❌ يرجى إدخال رابط المنتج.\n\nمثال:\n/track https://www.amazon.sa/dp/XXXXXXX\n/track https://www.noon.com/saudi-arabia-en/...\n/track https://www.trendyol.com/brand/product-p-12345"
);
return;
}

const url = parts[1];
const store = detectStore(url);
if (!store) {
await ctx.reply("❌ الرابط غير مدعوم.\nالمتاجر المدعومة: أمازون السعودية، نون، ترينديول.");
return;
}

const chatId = String(ctx.chat.id);
const userId = String(ctx.from?.id ?? ctx.chat.id);

const existing = await db
.select()
.from(trackedProductsTable)
.where(and(eq(trackedProductsTable.chatId, chatId), eq(trackedProductsTable.url, url)));

if (existing.length > 0) {
await ctx.reply("⚠️ هذا المنتج مضاف مسبقاً في قائمة تتبعك.");
return;
}

const loadingMsg = await ctx.reply(⏳ جارٍ جلب بيانات المنتج من ${STORE_NAMES[store]}...`);
try {
const result = await scrapeProduct(url);
const [product] = await db
.insert(trackedProductsTable)
.values({
chatId,
userId,
url,
name: result.name,
store: result.store,
currentPrice: result.price !== null ? String(result.price) : null,
lastChecked: new Date(),
})
.returning();

if (result.price !== null) {
await db.insert(priceHistoryTable).values({
productId: product.id,
price: String(result.price),
checkedAt: new Date(),
});
}

const priceText =
result.price !== null
? 💰 السعر الحالي: &lt;b&gt;${result.price} ر.س</b>`
: "💰 السعر: غير متوفر حالياً";

await ctx.api.editMessageText(
ctx.chat.id,
loadingMsg.message_id,
✅ تمت إضافة المنتج للتتبع!\n\n📦 &lt;b&gt;${result.name}</b>\n${priceText}\n🏪 ${STORE_NAMES[store as keyof typeof STORE_NAMES] ?? store}\n\nسأخبرك فور انخفاض السعر 🔔, { parse_mode: "HTML" } ); } catch (err) { const errMsg = err instanceof Error ? err.message : "خطأ غير معروف"; await ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id,❌ ${errMsg});
logger.error({ err, url }, "Track command failed");
}
});

// ─── /list ────────────────────────────────────────────────────────────────────

bot.command("list", async (ctx) => {
const chatId = String(ctx.chat.id);
const products = await db
.select()
.from(trackedProductsTable)
.where(eq(trackedProductsTable.chatId, chatId));

if (products.length === 0) {
await ctx.reply("📭 قائمة تتبعك فارغة.\nأضف منتجاً باستخدام /track ثم رابط المنتج.");
return;
}

const lines = products.map((p) => {
const price =
p.currentPrice !== null ? ${Number(p.currentPrice).toFixed(2)} ر.س: "غير متوفر"; const storeName = STORE_NAMES[p.store as keyof typeof STORE_NAMES] ?? p.store; const shortName = p.name.length &gt; 55 ? p.name.slice(0, 55) + "..." : p.name; return🔢 <b>#${p.id}&lt;/b&gt; — ${shortName}\n 💰 ${price} | 🏪 ${storeName}`;
});

await ctx.reply(
📋 &lt;b&gt;منتجاتك المتتبعة (${products.length})</b>\n\n${lines.join("\n\n")}\n\nللفحص الآن: /check | لإيقاف التتبع: /untrack ثم الرقم,
{ parse_mode: "HTML" }
);
});

// ─── /check ───────────────────────────────────────────────────────────────────

bot.command("check", async (ctx) => {
const chatId = String(ctx.chat.id);
const products = await db
.select()
.from(trackedProductsTable)
.where(eq(trackedProductsTable.chatId, chatId));

if (products.length === 0) {
await ctx.reply("📭 قائمة تتبعك فارغة. أضف منتجاً أولاً باستخدام /track");
return;
}

const loadingMsg = await ctx.reply(
⏳ جارٍ فحص${products.length} منتج في 3 متاجر...`
);

try {
const results = await checkProductsForChat(chatId);
const dropped = results.filter((r) => r.dropped && r.newPrice !== null && r.oldPrice !== null);
const unchanged = results.filter((r) => !r.dropped && !r.failed);
const failed = results.filter((r) => r.failed);

const lines: string[] = [];

if (dropped.length > 0) {
lines.push("📉 <b>انخفضت أسعارها:</b>");
for (const r of dropped) {
const shortName = r.name.length > 50 ? r.name.slice(0, 50) + "..." : r.name;
const badge = r.pct >= 20 ? " 🔥🔥" : r.pct >= 10 ? " 🔥" : r.pct >= 5 ? " ✨" : "";
const storeName = STORE_NAMES[r.store as keyof typeof STORE_NAMES] ?? r.store;
lines.push(
• ${shortName}${badge}\n 💸 من &lt;s&gt;${r.oldPrice!.toFixed(2)}</s> → <b>${r.newPrice!.toFixed(2)} ر.س&lt;/b&gt; (${r.pct.toFixed(1)}%) | ${storeName}\n &lt;a href="${r.url}">🔗 الرابط</a>`
);
}
lines.push("");
}

if (unchanged.length > 0) {
lines.push("📊 <b>لم يتغيّر سعرها:</b>");
for (const r of unchanged) {
const shortName = r.name.length > 50 ? r.name.slice(0, 50) + "..." : r.name;
const storeName = STORE_NAMES[r.store as keyof typeof STORE_NAMES] ?? r.store;
lines.push(
•${shortName} — {storeName}`
);
}
lines.push("");
}

if (failed.length > 0) {
lines.push("❌ <b>تعذّر فحصها:</b>");
for (const r of failed) {
lines.push(• ${r.name.length > 50 ? r.name.slice(0, 50) + "..." : r.name}`);
}
}

const summary =
dropped.length > 0
? ✅ انخفض سعر &lt;b&gt;${dropped.length}</b> من أصل {results.length} منتج`;

await ctx.api.editMessageText(
ctx.chat.id,
loadingMsg.message_id,
${summary}\n\n${lines.join("\n")},
{ parse_mode: "HTML", link_preview_options: { is_disabled: true } }
);
} catch (err) {
logger.error({ err }, "Check command failed");
await ctx.api.editMessageText(
ctx.chat.id,
loadingMsg.message_id,
"❌ حدث خطأ. حاول مجدداً."
);
}
});

// ─── /history ─────────────────────────────────────────────────────────────────

bot.command("history", async (ctx) => {
const parts = (ctx.message?.text?.trim() ?? "").split(/\s+/);
if (parts.length < 2 || !parts[1]) {
await ctx.reply("❌ يرجى إدخال رقم المنتج.\nمثال: /history 3\n\nاستخدم /list لمعرفة الأرقام.");
return;
}

const productId = parseInt(parts[1], 10);
if (isNaN(productId)) {
await ctx.reply("❌ الرقم غير صالح. استخدم /list لمعرفة أرقام منتجاتك.");
return;
}

const chatId = String(ctx.chat.id);

const [product] = await db
.select()
.from(trackedProductsTable)
.where(and(eq(trackedProductsTable.id, productId), eq(trackedProductsTable.chatId, chatId)));

if (!product) {
await ctx.reply("❌ لم يُعثر على هذا المنتج في قائمتك. استخدم /list للتحقق.");
return;
}

const history = await db
.select()
.from(priceHistoryTable)
.where(eq(priceHistoryTable.productId, productId))
.orderBy(desc(priceHistoryTable.checkedAt))
.limit(20);

if (history.length === 0) {
await ctx.reply("📭 لا يوجد سجل أسعار لهذا المنتج بعد.\nسيبدأ التسجيل من الفحص القادم.");
return;
}

const prices = history.map((h) => Number(h.price));
const minPrice = Math.min(...prices);
const maxPrice = Math.max(...prices);
const currentPrice = Number(product.currentPrice ?? prices[0]);
const storeName = STORE_NAMES[product.store as keyof typeof STORE_NAMES] ?? product.store;
const shortName = product.name.length > 60 ? product.name.slice(0, 60) + "…" : product.name;

// رسم بياني نصي (أحدث 10 قيم من اليسار)
const chartData = history.slice(0, 10).reverse();
const chartPrices = chartData.map((h) => Number(h.price));
const range = maxPrice - minPrice || 1;
const BARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const chart = chartPrices
.map((p) => BARS[Math.round(((p - minPrice) / range) * (BARS.length - 1))])
.join("");

// آخر 8 سجلات بالتواريخ
const recentLines = history.slice(0, 8).map((h) => {
const d = new Date(h.checkedAt);
const date = ${d.getDate()}/${d.getMonth() + 1};
const time = ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")};
const p = Number(h.price);
return • ${date} ${time} — &lt;b&gt;${p.toFixed(2)} ر.س</b>`;
});

const savingFromMax = maxPrice - currentPrice;
const savingPct = ((savingFromMax / maxPrice) * 100).toFixed(1);

await ctx.reply(
📊 &lt;b&gt;تاريخ سعر المنتج #${productId}</b>\n+latex
{shortName}\n🏪 

{storeName}\n\n+📉 أدنى سعر: <b>latex
{minPrice.toFixed(2)} ر.س&lt;/b&gt;\n` + `📈 أعلى سعر: &lt;b&gt;

{maxPrice.toFixed(2)} ر.س</b>\n+💰 السعر الآن: <b>{savingPct}% عن الأعلى 🎉): "") +\n\n<code>{chartData.length} قراءة\n\n+🕓 <b>آخر القراءات:</b>\n${recentLines.join("\n")},
{ parse_mode: "HTML" }
);
});

// ─── /deals ───────────────────────────────────────────────────────────────────

bot.command("deals", async (ctx) => {
const loadingMsg = await ctx.reply(
"🔍 جارٍ مسح العروض في أمازون 🛒، نون 🛍️ وترينديول 👗...\nقد يستغرق هذا 20-30 ثانية."
);

try {
const deals = await scrapeAllDeals(10);

if (deals.length === 0) {
await ctx.api.editMessageText(
ctx.chat.id,
loadingMsg.message_id,
"😔 لم أجد عروضاً بخصم 10% أو أكثر في الوقت الحالي. حاول لاحقاً."
);
return;
}

const topDeals = deals.slice(0, 15);
const text = formatDealsMessage(topDeals, deals.length);

await ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, text, {
parse_mode: "HTML",
link_preview_options: { is_disabled: true },
});
} catch (err) {
logger.error({ err }, "Deals command failed");
await ctx.api.editMessageText(
ctx.chat.id,
loadingMsg.message_id,
"❌ حدث خطأ أثناء جلب العروض. حاول مجدداً."
);
}
});

// ─── /flash ───────────────────────────────────────────────────────────────────

bot.command("flash", async (ctx) => {
const loadingMsg = await ctx.reply(
"⚡ جارٍ صيد عروض الفلاش من أمازون 🛒، نون 🛍️ وترينديول 👗...\nقد يستغرق 20-30 ثانية."
);

try {
const deals = await scrapeFlashDeals();

if (deals.length === 0) {
await ctx.api.editMessageText(
ctx.chat.id,
loadingMsg.message_id,
"😔 لم أجد عروض فلاش نشطة الآن في الـ3 متاجر.\nحاول لاحقاً — عروض الفلاش تتجدد كل ساعة تقريباً."
);
return;
}

const text = formatFlashDealsMessage(deals.slice(0, 12), deals.length);
await ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, text, {
parse_mode: "HTML",
link_preview_options: { is_disabled: true },
});
} catch (err) {
logger.error({ err }, "Flash command failed");
await ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, "❌ حدث خطأ. حاول مجدداً.");
}
});

// ─── /subscribe ───────────────────────────────────────────────────────────────

bot.command("subscribe", async (ctx) => {
const chatId = String(ctx.chat.id);
const existing = await db
.select()
.from(dealSubscribersTable)
.where(eq(dealSubscribersTable.chatId, chatId));

if (existing.length > 0) {
await ctx.reply(
"✅ أنت مشترك مسبقاً في تنبيهات العروض!\n\nستصلك تنبيهات كل ساعة من أمازون 🛒، نون 🛍️ وترينديول 👗 عند وجود عروض بخصم 10%+.\n\nلعرض العروض الآن: /deals\nلإلغاء الاشتراك: /unsubscribe"
);
return;
}

await db.insert(dealSubscribersTable).values({ chatId, minDiscount: 10 });
await ctx.reply(
"🔔 <b>تم الاشتراك في التنبيهات!</b>\n\nستصلك تلقائياً:\n📉 <b>انخفاض أسعار السوق</b> (أي منتج نزل) — كل ساعة\n⚡ <b>عروض الفلاش الخاطفة</b> — كل 30 دقيقة\n🏷️ <b>أفضل عروض اليوم</b> — كل ساعة\n📦 <b>منتجاتك الشخصية</b> عند انخفاض سعرها\n\nمن: 🛒 أمازون | 🛍️ نون | 👗 ترينديول\n\nللعروض الآن: /deals | /flash\nلإلغاء: /unsubscribe",
{ parse_mode: "HTML" }
);
});

// ─── /unsubscribe ─────────────────────────────────────────────────────────────

bot.command("unsubscribe", async (ctx) => {
const chatId = String(ctx.chat.id);
const [deleted] = await db
.delete(dealSubscribersTable)
.where(eq(dealSubscribersTable.chatId, chatId))
.returning();

if (!deleted) {
await ctx.reply("⚠️ أنت لست مشتركاً في التنبيهات.\nللاشتراك: /subscribe");
return;
}
await ctx.reply("✅ تم إلغاء اشتراكك في تنبيهات العروض.");
});

// ─── /untrack ─────────────────────────────────────────────────────────────────

bot.command("untrack", async (ctx) => {
const text = ctx.message?.text?.trim() ?? "";
const parts = text.split(/\s+/);
if (parts.length < 2 || !parts[1]) {
await ctx.reply(
"❌ يرجى إدخال رقم المنتج.\nمثال: /untrack 5\n\nاستخدم /list لمعرفة الأرقام."
);
return;
}

const productId = parseInt(parts[1], 10);
if (isNaN(productId)) {
await ctx.reply("❌ الرقم غير صالح. استخدم /list لمعرفة أرقام منتجاتك.");
return;
}

const chatId = String(ctx.chat.id);
const [deleted] = await db
.delete(trackedProductsTable)
.where(
and(eq(trackedProductsTable.id, productId), eq(trackedProductsTable.chatId, chatId))
)
.returning();

if (!deleted) {
await ctx.reply("❌ لم يُعثر على هذا المنتج في قائمتك. استخدم /list للتحقق.");
return;
}

const shortName = deleted.name.length > 60 ? deleted.name.slice(0, 60) + "..." : deleted.name;
await ctx.reply(✅ تم إيقاف تتبع:\n&lt;b&gt;${shortName}</b>`, { parse_mode: "HTML" });
});

// ─── Catch-all ────────────────────────────────────────────────────────────────

bot.on("message", (ctx) =>
ctx.reply("لم أفهم طلبك. استخدم /help لعرض الأوامر المتاحة.")
);

bot.catch((err) => {
logger.error({ err: err.error }, "Bot error");
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function formatDealsMessage(deals: Deal[], total: number): string {
const lines = deals.map((d, i) => {
const shortName = d.name.length > 55 ? d.name.slice(0, 55) + "..." : d.name;
const storeName = STORE_NAMES[d.store as keyof typeof STORE_NAMES] ?? d.store;
const badge = d.discount >= 30 ? " 🔥🔥" : d.discount >= 20 ? " 🔥" : "";
const linkLine = d.url ? \n &lt;a href="${d.url}">🔗 الرابط</a>: ""; return ( ``${i + 1}. ${shortName}${badge}\n +
💸 من &lt;s&gt;${d.originalPrice.toFixed(0)}</s> → <b>${d.salePrice.toFixed(0)} ر.س&lt;/b> +
| خصم &lt;b&gt;${d.discount}%</b> | ${storeName} +
linkLine
);
});

const header =
total > deals.length
? 🏷️ &lt;b&gt;أفضل ${deals.length} عرض من أصل ${total} (خصم 10%+) — 3 متاجر&lt;/b>
: 🏷️ &lt;b&gt;${total} عرض متاح (خصم 10%+) في 3 متاجر</b>`;

return ``${header}\n\n${lines.join("\n\n")};
}

export function formatFlashDealsMessage(deals: FlashDeal[], total: number): string {
const lines = deals.map((d, i) => {
const shortName = d.name.length > 55 ? d.name.slice(0, 55) + "…" : d.name;
const storeName = STORE_NAMES[d.store as keyof typeof STORE_NAMES] ?? d.store;
const badge = d.discount >= 40 ? " 🔥🔥🔥" : d.discount >= 25 ? " 🔥🔥" : " 🔥";
const claimedLine = d.claimedPct != null ? | تم المطالبة${d.claimedPct}%: ""; const expiresLine = d.expiresLabel ? | latex
{d.expiresLabel}` : ""; const linkLine = d.url ? `\n &lt;a href="

{d.url}">🔗 رابط العرض</a>: ""; return ({shortName}latex
{badge}\n` + ` 💸 من &lt;s&gt;

{d.originalPrice.toFixed(0)}</s> → <b>{d.discount}%</b> | ${storeName} +
claimedLine + expiresLine +
linkLine
);
});

const header =
total > deals.length
? ⚡ &lt;b&gt;عروض الفلاش: أفضل${deals.length} من أصل {total} عرض فلاش نشط الآن</b>`;

return ${header}\n\n${lines.join("\n\n")};
}

// ─── Alert Senders ────────────────────────────────────────────────────────────

export async function sendPriceDropAlert(
chatId: string,
productName: string,
oldPrice: number,
newPrice: number,
url: string,
store: string
): Promise<void> {
const diff = oldPrice - newPrice;
const pct = ((diff / oldPrice) * 100).toFixed(1);
const storeName = STORE_NAMES[store as keyof typeof STORE_NAMES] ?? store;
const shortName = productName.length > 80 ? productName.slice(0, 80) + "..." : productName;

await bot.api.sendMessage(
chatId,
🔔 &lt;b&gt;انخفض السعر!&lt;/b&gt;\n\n📦 ${shortName}\n\n💸 من <s>${oldPrice} ر.س&lt;/s&gt; إلى &lt;b&gt;${newPrice} ر.س</b>\n📉 وفّر ${diff.toFixed(2)} ر.س (${pct}%)\n🏪 ${storeName}\n\n🔗 &lt;a href="${url}">رابط المنتج</a>`,
{ parse_mode: "HTML", link_preview_options: { is_disabled: true } }
);
}

export async function sendDealAlert(chatId: string, deals: Deal[]): Promise<void> {
if (deals.length === 0) return;
const top = deals.slice(0, 10);
const text = formatDealsMessage(top, deals.length);
await bot.api.sendMessage(chatId, 🔔 &lt;b&gt;عروض جديدة من 3 متاجر!&lt;/b&gt;\n\n${text}`, {
parse_mode: "HTML",
link_preview_options: { is_disabled: true },
});
}

export async function sendFlashDealAlert(chatId: string, deals: FlashDeal[]): Promise<void> {
if (deals.length === 0) return;
const top = deals.slice(0, 10);
const text = formatFlashDealsMessage(top, deals.length);
await bot.api.sendMessage(chatId, ⚡ &lt;b&gt;عروض فلاش جديدة — لا تفوّتها!&lt;/b&gt;\n\n${text}`, {
parse_mode: "HTML",
link_preview_options: { is_disabled: true },
});
}

export interface MarketDrop {
name: string;
url: string;
store: string;
oldPrice: number;
newPrice: number;
pct: number;
}

export async function sendMarketDropAlert(chatId: string, drops: MarketDrop[]): Promise<void> {
if (drops.length === 0) return;
const top = drops.slice(0, 12);
const lines = top.map((d, i) => {
const shortName = d.name.length > 55 ? d.name.slice(0, 55) + "…" : d.name;
const storeName = STORE_NAMES[d.store as keyof typeof STORE_NAMES] ?? d.store;
const badge = d.pct >= 30 ? " 🔥🔥" : d.pct >= 15 ? " 🔥" : "";
const linkLine = d.url ? \n &lt;a href="${d.url}">🔗 الرابط</a>: ""; return ({shortName}latex
{badge}\n` + ` 💸 من &lt;s&gt;

{d.oldPrice.toFixed(0)}</s> → <b>{d.pct.toFixed(0)}% | latex
{storeName}` + linkLine ); }); const header = `📉 &lt;b&gt;

{drops.length} منتج انخفض سعره في السوق!</b>; await bot.api.sendMessage( chatId,latex
{header}\n\n

{lines.join("\n\n")}`,
{ parse_mode: "HTML", link_preview_options: { is_disabled: true } }
);
}
