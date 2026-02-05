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
const MC_PASSWORD = process.env.MC_PASSWORD;

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
const leet = { "0":"o","1":"i","!":"i","3":"e","4":"a","5":"s","7":"t","@":"a","$":"s" };
const cyr  = { "а":"a","е":"e","о":"o","р":"p","с":"c","х":"x","у":"y","к":"k","м":"m","т":"t" };

function stripColors(s=""){ return s.replace(/§./g,""); }
function norm(s=""){
  s = stripColors(s).toLowerCase();
  s = [...s].map(ch => cyr[ch] || leet[ch] || ch).join("");
  s = s.replace(/[\s_\-\.]+/g,"");
  s = s.replace(/(.)\1{2,}/g,"$1$1");
  return s;
}
function has1488(s){ return s.includes("1488") || (s.includes("14") && s.includes("88")); }

function normArr(a){
  return (a || []).map(x => norm(String(x))).filter(Boolean);
}
function rebuildRules(){
  RULES = {
    ...RULES,
    whitelist_exact: normArr(RULES.whitelist_exact),
    hard_ban_roots:  normArr(RULES.hard_ban_roots),
    staff_roles:    normArr(RULES.staff_roles),
    project_roots:  normArr(RULES.project_roots),
    review_roots:   normArr(RULES.review_roots),
  };
}
rebuildRules();

/* ================== CHECKER ================== */
function checkNick(name){
  const n = norm(name);

  // whitelist_exact уже нормализован
  if ((RULES.whitelist_exact || []).includes(n)) return ["OK",["whitelist"]];

  if (has1488(n)) return ["BAN",["extremism:1488"]];

  const hard  = RULES.hard_ban_roots||[];
  const staff = RULES.staff_roles||[];
  const proj  = RULES.project_roots||[];
  const review= RULES.review_roots||[];

  const hardHit = hard.filter(w => n.includes(w));
  if (hardHit.length) return ["BAN", hardHit.map(x=>"hard:"+x)];

  const staffHit = staff.some(w => n.includes(w));
  const projHit  = proj.some(w => n.includes(w));

  if (staffHit && projHit) return ["BAN",["impersonation:project+role"]];
  if (projHit && /\d{2,4}$/.test(n)) return ["BAN",["impersonation:project+digits"]];

  const reasons = [];
  if (staffHit) reasons.push("impersonation:role");
  const revHit = review.filter(w => n.includes(w));
  reasons.push(...revHit.map(x=>"review:"+x));

  if (reasons.length) return ["REVIEW", reasons];
  return ["OK",[]];
}

/* ================== UTILS ================== */
function mention(uid){ return uid ? `(${uid})` : ""; } // без Markdown, чтобы не ломало ники с "_"

function splitText(t, max = 3500){
  const parts=[]; let buf="";
  for(const line of t.split("\n")){
    if((buf + line + "\n").length > max){
      parts.push(buf);
      buf="";
    }
    buf += line + "\n";
  }
  if(buf) parts.push(buf);
  return parts;
}

async function sendChunksReply(ctx, text){
  for(const part of splitText(text)){
    if(part.trim()) await ctx.reply(part);
  }
}

async function sendChunksChat(bot, chatId, text){
  for(const part of splitText(text)){
    if(part.trim()) await bot.telegram.sendMessage(chatId, part); // без parse_mode
  }
}

function report(title, names){
  const ban=[], rev=[];
  for(const n of names){
    const [s,r]=checkNick(n);
    if(s==="BAN") ban.push({n,r});
    else if(s==="REVIEW") rev.push({n,r});
  }

  let out = `${title}\nНайдено: ${names.length}\n\n`;

  if(ban.length){
    out += `❌ BAN (${ban.length}):\n`;
    ban.forEach((x,i)=> out += `${i+1}) ${x.n} → ${x.r.join("; ")}\n`);
    out += "\n";
  }
  if(rev.length){
    out += `⚠️ REVIEW (${rev.length}):\n`;
    rev.forEach((x,i)=> out += `${i+1}) ${x.n} → ${x.r.join("; ")}\n`);
  }
  return { out, ban:ban.length, rev:rev.length };
}

/* ================== MINEFLAYER ================== */
const mc = mineflayer.createBot({
  host: MC_HOST,
  port: MC_PORT,
  username: MC_USER,
  version: MC_VERSION
});

let loginSent=false, registerSent=false;

mc.on("messagestr",(msg)=>{
  const m = msg.toLowerCase();
  if(MC_PASSWORD && !loginSent && (m.includes("login") || m.includes("авториз") || m.includes("/l"))){
    loginSent=true;
    setTimeout(()=> mc.chat(`/login ${MC_PASSWORD}`),1500);
  }
  if(MC_PASSWORD && !registerSent && m.includes("register")){
    registerSent=true;
    setTimeout(()=> mc.chat(`/register ${MC_PASSWORD} ${MC_PASSWORD}`),1500);
  }
});

let mcReady = false;

mc.on("spawn", () => {
  mcReady = true;
  console.log("MC spawned (ready)");
});

mc.on("end", () => {
  mcReady = false;
  console.log("MC end");
});

mc.on("kicked", (r) => {
  mcReady = false;
  console.log("MC kicked", r);
});

mc.on("error", (e) => console.log("MC error", e.message));

/* ================== TAB COMPLETE ================== */
function extractMatches(p){
  const raw = p?.matches ?? p?.suggestions ?? [];
  return raw.map(x => {
    if (typeof x === "string") return x;
    return x?.match || x?.text || x?.suggestion || "";
  }).filter(Boolean);
}

async function tabComplete(bot, text){
  if (typeof bot.tabComplete === "function") {
    try {
      const r = await bot.tabComplete(text);
      return (r || []).map(String);
    } catch {}
  }

  const c = bot._client;

  const tryWrite = (payload) => {
    try { c.write("tab_complete", payload); return true; }
    catch { return false; }
  };

  return new Promise((res, rej) => {
    const to = setTimeout(() => { cleanup(); rej(new Error("tab_complete timeout")); }, 2500);

    const on = (p) => {
      cleanup();
      res(extractMatches(p));
    };

    function cleanup(){
      clearTimeout(to);
      c.removeListener("tab_complete", on);
      c.removeListener("tab_complete_response", on);
    }

    c.once("tab_complete", on);
    c.once("tab_complete_response", on);

    const payloads = [
      { text, assumeCommand: true, lookedAtBlock: null },
      { text, assumeCommand: false, lookedAtBlock: null },
      { text, assumeCommand: true },
      { text },
    ];

    let ok = false;
    for (const p of payloads) {
      if (tryWrite(p)) { ok = true; break; }
    }
    if (!ok) {
      cleanup();
      rej(new Error("cannot write tab_complete packet"));
    }
  });
}

function clean(s){ return String(s).replace(/[^A-Za-z0-9_]/g,""); }

async function byPrefix(p){
  const r = await tabComplete(mc, `/msg ${p}`);
  return r.map(clean).filter(n => n.length>=3 && n.length<=16);
}

function prefixes(){
  if(AUTO_PREFIXES) return AUTO_PREFIXES.split(",").map(x=>x.trim()).filter(Boolean);
  const a=[];
  for(let i=97;i<=122;i++) a.push(String.fromCharCode(i));
  for(let i=0;i<=9;i++) a.push(String(i));
  a.push("_");
  return a;
}

async function collect(ps){
  const all=new Set();
  for(const p of ps){
    if(!mcReady) throw new Error("MC not ready");
    try{
      (await byPrefix(p)).forEach(n=>all.add(n));
    }catch{}
    await new Promise(r=>setTimeout(r,SCAN_DELAY_MS));
  }
  return [...all];
}

/* ================== TELEGRAM ================== */
const tg = new Telegraf(BOT_TOKEN);

tg.start(c=>c.reply("Готов.\n/tab <префикс>\n/tabcheck <префикс>\n/scanall\n/myid"));
tg.command("myid",c=>c.reply(`user_id: ${c.from.id}\nchat_id: ${c.chat.id}`));

tg.command("tab", async c=>{
  const a=c.message.text.split(" ").slice(1).join(" ").trim();
  if(!a) return c.reply("Пример: /tab ager");
  const n=[...new Set(await byPrefix(a))];
  let t=`Tab /msg ${a}\nНайдено: ${n.length}\n\n`;
  n.slice(0,120).forEach((x,i)=>t+=`${i+1}) ${x}\n`);
  await sendChunksReply(c,t);
});

async function doTabCheck(c, prefix){
  const n=[...new Set(await byPrefix(prefix))];
  const r=report(`Tabcheck ${prefix}`,n);
  await sendChunksReply(c,r.out);
}

tg.command("tabcheck", async c=>{
  const a=c.message.text.split(" ").slice(1).join(" ").trim();
  if(!a) return c.reply("Пример: /tabcheck ager");
  await doTabCheck(c,a);
});

// алиас под твою частую опечатку
tg.command("tabcheak", async c=>{
  const a=c.message.text.split(" ").slice(1).join(" ").trim();
  if(!a) return c.reply("Пример: /tabcheak ager (алиас /tabcheck)");
  await doTabCheck(c,a);
});

tg.command("scanall", async c=>{
  await c.reply("Сканирую...");
  try{
    const n=await collect(prefixes());
    const r=report("Full scan",n);
    await sendChunksReply(c,r.out);
  }catch(e){
    await c.reply(`Ошибка: ${e?.message || e}`);
  }
});

/* ================== AUTO SCAN ================== */
let lastKey="";

async function autoScan(){
  if(!AUTO_SCAN) return;
  try{
    const n = await collect(prefixes());
    const r = report("Auto scan", n);

    if(r.ban===0 && r.rev===0){ lastKey=""; return; }

    const key = norm(r.out).slice(0,300);
    if(key===lastKey) return;
    lastKey = key;

    const msg = `Найдены нарушения ${mention(PING_USER_ID)}\n\n` + r.out;
    if (CHAT_ID) await sendChunksChat(tg, CHAT_ID, msg);
  }catch(e){
    console.log("AutoScan error:", e?.message || e);
  }
}

/* ======== TG launch (409 fix) ======== */
async function startTG(){
  try{ await tg.telegram.deleteWebhook({ drop_pending_updates:true }); }catch{}
  await tg.launch({ dropPendingUpdates:true });
  console.log("TG bot started");
}
startTG();

process.once("SIGINT",()=>tg.stop("SIGINT"));
process.once("SIGTERM",()=>tg.stop("SIGTERM"));

if(AUTO_SCAN){
  setTimeout(autoScan,10000);
  setInterval(autoScan, AUTO_SCAN_MINUTES*60*1000);
}
```0
