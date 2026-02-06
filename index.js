import fs from "fs";
import mineflayer from "mineflayer";
import { Telegraf } from "telegraf";

/* ================== ENV ================== */
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const PING_USER_ID = process.env.PING_USER_ID ? Number(process.env.PING_USER_ID) : null;

const MC_HOST = process.env.MC_HOST;
const MC_PORT = Number(process.env.MC_PORT || 25565);
const MC_USER = process.env.MC_USER;
const MC_VERSION = process.env.MC_VERSION || undefined;

const AUTO_SCAN = (process.env.AUTO_SCAN || "1") === "1";
const AUTO_SCAN_MINUTES = Number(process.env.AUTO_SCAN_MINUTES || 10);
const SCAN_DELAY_MS = Number(process.env.SCAN_DELAY_MS || 200);
const AUTO_PREFIXES = (process.env.AUTO_PREFIXES || "").trim();

if (!BOT_TOKEN || !MC_HOST || !MC_USER) {
  throw new Error("Нужны BOT_TOKEN, MC_HOST, MC_USER");
}

/* ================== RULES ================== */
let RULES = JSON.parse(fs.readFileSync("rules.json", "utf8"));

/* ================== NORMALIZE ================== */
const cyr = { "а":"a","е":"e","о":"o","р":"p","с":"c","х":"x","у":"y","к":"k","м":"m","т":"t" };

const invisRe = new RegExp(
  RULES?.normalization?.strip_invisibles_regex || "[\\u200B-\\u200F\\u202A-\\u202E\\u2060\\uFEFF]",
  "g"
);
const sepRe = new RegExp(
  RULES?.normalization?.separators_regex || "[\\s\\-_.:,;|/\\\\~`'\"^*+=()\\[\\]{}<>]+",
  "g"
);
const leetMap = RULES?.normalization?.leet_map || { "0":"o","1":"i","3":"e","4":"a","5":"s","7":"t","@":"a","$":"s" };
const collapseRepeats = RULES?.normalization?.collapse_repeats ?? true;
const maxRepeat = RULES?.normalization?.max_repeat ?? 2;

function stripColors(s = "") { return s.replace(/§./g, ""); }

function norm(s = "") {
  s = stripColors(s);

  if (RULES?.normalization?.lowercase ?? true) s = s.toLowerCase();
  s = s.replace(invisRe, "");
  s = [...s].map(ch => cyr[ch] || leetMap[ch] || ch).join("");
  s = s.replace(sepRe, "");

  if (collapseRepeats) {
    const re = new RegExp(`(.)\\1{${maxRepeat},}`, "g");
    const rep = "$1".repeat(maxRepeat);
    s = s.replace(re, rep);
  }
  return s;
}

/* ================== CHECKER (под rules.json) ================== */
function checkNick(name) {
  const n = norm(name);

  // whitelist_exact
  const wl = new Set((RULES.whitelist_exact || []).map(norm));
  if (wl.has(n)) return ["OK", ["whitelist"]];

  // BAN rules
  const reasons = [];
  const banRules = (RULES.rules || []).filter(r => (r.action || "").toUpperCase() === "BAN");

  for (const rule of banRules) {
    const words = rule.words || [];
    for (const w0 of words) {
      const w = norm(String(w0));
      if (!w) continue;
      if (n.includes(w)) reasons.push(`${rule.reason || rule.id || "BAN"}:${w0}`);
    }
  }
  if (reasons.length) return ["BAN", reasons];

  // REVIEW
  const rev = [];
  for (const w0 of (RULES.review || [])) {
    const w = norm(String(w0));
    if (!w) continue;
    if (n.includes(w)) rev.push(`review:${w0}`);
  }
  if (rev.length) return ["REVIEW", rev];

  return ["OK", []];
}

/* ================== REPORT + TG SEND ================== */
function mention(uid) { return uid ? `[ты](tg://user?id=${uid})` : ""; }

function splitText(t, max = 3500) {
  const parts = [];
  let buf = "";
  for (const line of t.split("\n")) {
    if ((buf + line + "\n").length > max) {
      parts.push(buf);
      buf = "";
    }
    buf += line + "\n";
  }
  if (buf) parts.push(buf);
  return parts;
}

async function sendChunksReply(ctx, text) {
  for (const part of splitText(text)) {
    if (part.trim()) await ctx.reply(part);
  }
}

async function sendChunksChat(bot, chatId, text) {
  for (const part of splitText(text)) {
    if (part.trim()) await bot.telegram.sendMessage(chatId, part, { parse_mode: "Markdown" });
  }
}

function report(title, names) {
  const ban = [];
  const rev = [];
  for (const nick of names) {
    const [s, r] = checkNick(nick);
    if (s === "BAN") ban.push({ nick, r });
    else if (s === "REVIEW") rev.push({ nick, r });
  }

  let out = `${title}\nНайдено: ${names.length}\n\n`;

  if (ban.length) {
    out += `❌ BAN (${ban.length}):\n`;
    ban.forEach((x, i) => out += `${i + 1}) ${x.nick} → ${x.r.join("; ")}\n`);
    out += "\n";
  }
  if (rev.length) {
    out += `⚠️ REVIEW (${rev.length}):\n`;
    rev.forEach((x, i) => out += `${i + 1}) ${x.nick} → ${x.r.join("; ")}\n`);
    out += "\n";
  }

  if (ban.length === 0 && rev.length === 0) {
    out += "✅ Некорректных ников не найдено.\n";
  }

  return { out, ban: ban.length, rev: rev.length };
}

/* ================== MINEFLAYER ================== */
const mc = mineflayer.createBot({
  host: MC_HOST,
  port: MC_PORT,
  username: MC_USER,
  version: MC_VERSION,
});

const MC_PASSWORD = process.env.MC_PASSWORD;

let loginSent = false;
let registerSent = false;

// статус для /status
let mcReady = false;
let mcOnline = false;
let mcLastError = "";

mc.on("messagestr", (msg) => {
  const m = String(msg).toLowerCase();

  // не спамим /login
  if (MC_PASSWORD && !loginSent && (m.includes("login") || m.includes("авториз") || m.includes("/l"))) {
    loginSent = true;
    setTimeout(() => {
      mc.chat(`/login ${MC_PASSWORD}`);
      console.log("Sent /login");
    }, 1500);
  }

  if (MC_PASSWORD && !registerSent && m.includes("register")) {
    registerSent = true;
    setTimeout(() => {
      mc.chat(`/register ${MC_PASSWORD} ${MC_PASSWORD}`);
      console.log("Sent /register");
    }, 1500);
  }
});

mc.on("login", () => {
  mcReady = true;
  mcOnline = true;
  mcLastError = "";
  console.log("MC logged in");
});

mc.on("end", () => {
  mcReady = false;
  mcOnline = false;
  mcLastError = "disconnected";
  console.log("MC end/disconnected");
});

mc.on("kicked", (r) => {
  mcReady = false;
  mcOnline = false;
  mcLastError = "kicked: " + String(r);
  console.log("MC kicked", r);
});

mc.on("error", (e) => {
  mcLastError = "error: " + String(e?.message || e);
  console.log("MC error", e?.message || e);
});

/* ================== TAB COMPLETE ================== */
function tabComplete(bot, text) {
  return new Promise((res, rej) => {
    const c = bot._client;
    const to = setTimeout(() => { cleanup(); rej(new Error("TAB_TIMEOUT")); }, 2000);
    const on = (p) => {
      cleanup();
      const m = p?.matches?.map(x => typeof x === "string" ? x : (x.match || x.text || "")) || [];
      res(m);
    };
    function cleanup() {
      clearTimeout(to);
      c.removeListener("tab_complete", on);
      c.removeListener("tab_complete_response", on);
    }
    c.once("tab_complete", on);
    c.once("tab_complete_response", on);
    c.write("tab_complete", { text, assumeCommand: true, lookedAtBlock: null });
  });
}

function clean(s) { return String(s).replace(/[^A-Za-z0-9_]/g, ""); }

async function byPrefix(prefix) {
  const raw = await tabComplete(mc, `/msg ${prefix}`);
  const pref = clean(prefix).toLowerCase();

  const out = [];
  for (const x of raw) {
    const n = clean(x);
    if (!n) continue;
    // фильтруем по префиксу (иначе “рандом”)
    if (n.toLowerCase().startsWith(pref)) out.push(n);
  }
  return out.filter(n => n.length >= 3 && n.length <= 16);
}

function prefixes() {
  if (AUTO_PREFIXES) return AUTO_PREFIXES.split(",").map(x => x.trim()).filter(Boolean);
  const a = [];
  for (let i = 97; i <= 122; i++) a.push(String.fromCharCode(i));
  for (let i = 0; i <= 9; i++) a.push(String(i));
  a.push("_");
  return a;
}

async function collect(ps) {
  if (!mcReady) throw new Error("MC_NOT_READY");

  const all = new Set();
  for (const p of ps) {
    if (!mcReady) throw new Error("MC_NOT_READY");
    try { (await byPrefix(p)).forEach(n => all.add(n)); } catch {}
    await new Promise(r => setTimeout(r, SCAN_DELAY_MS));
  }
  return [...all];
}

/* ================== TELEGRAM ================== */
const tg = new Telegraf(BOT_TOKEN);

tg.start(c => c.reply("Готов.\n/tab <префикс>\n/tabcheck <префикс>\n/tabcheak <префикс>\n/scanall\n/myid\n/status"));

tg.command("myid", c => c.reply(`user_id: ${c.from.id}\nchat_id: ${c.chat.id}`));

tg.command("status", async (c) => {
  let s = "❌ не в сети / не готов";
  if (mcOnline && mcReady) s = "✅ на сервере (готов)";
  else if (mcOnline && !mcReady) s = "🟡 подключён, но ещё не готов";
  const extra = mcLastError ? `\nПричина: ${mcLastError}` : "";
  await c.reply(`Статус MC-бота: ${s}\nНик: ${MC_USER}${extra}`);
});

tg.command("tab", async (c) => {
  try {
    if (!mcReady) return c.reply("❌ MC-бот не на сервере (MC not ready). Напиши /status.");

    const a = c.message.text.split(" ").slice(1).join(" ").trim();
    if (!a) return c.reply("Пример: /tab ebl");

    const n = [...new Set(await byPrefix(a))];
    let t = `Tab /msg ${a}\nНайдено: ${n.length}\n\n`;
    n.slice(0, 200).forEach((x, i) => t += `${i + 1}) ${x}\n`);
    if (n.length > 200) t += `\n…ещё ${n.length - 200} (обрежено для /tab)`;

    await sendChunksReply(c, t);
  } catch (e) {
    console.log("tab error:", e);
    await c.reply("❌ Ошибка /tab. Напиши /status.");
  }
});

async function tabcheckHandler(c) {
  try {
    if (!mcReady) return c.reply("❌ MC-бот не на сервере (MC not ready). Напиши /status.");

    const a = c.message.text.split(" ").slice(1).join(" ").trim();
    if (!a) return c.reply("Пример: /tabcheck kotak");

    const n = [...new Set(await byPrefix(a))];
    const r = report(`Tabcheck ${a}`, n);
    await sendChunksReply(c, r.out);
  } catch (e) {
    console.log("tabcheck error:", e);
    await c.reply("❌ Ошибка /tabcheck. Напиши /status.");
  }
}

tg.command("tabcheck", tabcheckHandler);
tg.command("tabcheak", tabcheckHandler); // алиас на опечатку

tg.command("scanall", async (c) => {
  try {
    if (!mcReady) return c.reply("❌ MC-бот не на сервере (MC not ready). Напиши /status.");

    await c.reply("Сканирую...");
    const n = await collect(prefixes());
    const r = report("Full scan", n);
    await sendChunksReply(c, r.out);
  } catch (e) {
    console.log("scanall error:", e);
    await c.reply("❌ Ошибка скана. Возможно бот кикнуло/не готов. Напиши /status и попробуй позже.");
  }
});

/* ================== AUTO SCAN ================== */
let lastKey = "";

async function autoScan() {
  if (!AUTO_SCAN) return;
  if (!mcReady) return; // молча, чтобы не крашило

  try {
    const n = await collect(prefixes());
    const r = report("Auto scan", n);

    if (r.ban === 0 && r.rev === 0) { lastKey = ""; return; }

    const key = norm(r.out).slice(0, 300);
    if (key === lastKey) return;
    lastKey = key;

    const msg = `Найдены нарушения ${mention(PING_USER_ID)}\n\n` + r.out;
    await sendChunksChat(tg, CHAT_ID, msg);
  } catch (e) {
    console.log("autoScan error:", e);
  }
}

/* ======== TG launch (409 fix) ======== */
async function startTG() {
  try { await tg.telegram.deleteWebhook({ drop_pending_updates: true }); } catch {}
  await tg.launch({ dropPendingUpdates: true });
  console.log("TG bot started");
}
startTG();

process.once("SIGINT", () => tg.stop("SIGINT"));
process.once("SIGTERM", () => tg.stop("SIGTERM"));

// защита от падений (Railway перестанет перезапускать по кругу из-за мелочей)
process.on("unhandledRejection", (reason) => {
  console.log("UnhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.log("UncaughtException:", err);
});

if (AUTO_SCAN) {
  setTimeout(autoScan, 10000);
  setInterval(autoScan, AUTO_SCAN_MINUTES * 60 * 1000);
}
