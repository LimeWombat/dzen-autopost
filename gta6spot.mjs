#!/usr/bin/env node
// Следующая статья gta6spot.ru → статья в Дзен-канале (gta6info): вступление и первые разделы с картинками,
// дальше список остальных разделов и ссылка на полную версию на сайте. Тот же анонс, что уходит на DTF.
//
//   node gta6spot.mjs [--slug kak-prodat-mashinu-gta-6] [--video] [--draft] [--dry]
//
// Без --slug берёт первую ещё не опубликованную: сначала хайп из baits.json (с его заголовком), потом гайды (/tema/gaydy/), потом остальное из sitemap.
// Опубликованные пишет в posted.json ({slug: {id, url, date}}). Таймер: 4 раза в день, по одной статье, через flock.
// --video: вместо статьи вертикальный ролик до минуты (озвучка edge-tts, кадры статьи, субтитры, стинг в конце),
// состояние в posted-video.json. Нужны ffmpeg и uvx. --dry с --video собирает mp4 и не грузит.
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const SITE = "https://gta6spot.ru";
const SECTIONS = 2; // сколько разделов статьи идут в анонс целиком
const IMAGES = 4;
const { values: a } = parseArgs({ options: { slug: { type: "string" }, video: { type: "boolean" }, draft: { type: "boolean" }, dry: { type: "boolean" } } });
const STATE = new URL(a.video ? "posted-video.json" : "posted.json", import.meta.url);
const posted = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
// хайповые статьи с цепляющими заголовками для ленты Дзена: идут в очередь первыми, порядок = порядок в файле
const BAIT = JSON.parse(readFileSync(new URL("baits.json", import.meta.url), "utf8"));

const get = async (u) => {
  const r = await fetch(u.startsWith("http") ? u : SITE + u);
  if (!r.ok) throw new Error(`${u} → ${r.status}`);
  return r.text();
};
const slugs = (html) => [...html.matchAll(/href="(?:https:\/\/gta6spot\.ru)?\/([a-z0-9-]+)\/"/g)].map((m) => m[1]);

// --- HTML статьи → строки для dzen-post.mjs («## », «### », «- », «1. », строка-картинка, абзацы) ---------------
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s) => s.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === "#" ? String.fromCodePoint(Number(e.replace("#", "0"))) : ENT[e] ?? m));
const plain = (h) => decode(h.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").replace(/ ([.,;:!?)»])/g, "$1").trim();
const abs = (src) => (src.startsWith("/") ? SITE + src : src);

const CREDIT = /^\s*<em>(Скриншоты|Карта):/;
const imgSrc = (p) => p.tag === "p" && p.body.trim().startsWith("<img") && abs(p.body.match(/src="([^"]+)"/)[1]);
function page(html, url) {
  const title = BAIT[url.split("/").at(-2)] ?? decode(html.match(/<meta property="og:title" content="([^"]+)"/)[1]);
  const og = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1];
  const prose = html.match(/<div class="prose"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/article>|<div|<aside)/)?.[1];
  if (!prose) throw new Error(`${url}: нет <div class="prose">`);
  // верхний уровень markdown-вывода Astro: h2/h3, p (в т.ч. с картинкой), ul/ol, table
  return { title, og, parts: [...prose.matchAll(/<(h2|h3|p|ul|ol|table)\b[^>]*>([\s\S]*?)<\/\1>/g)].map(([, tag, body]) => ({ tag, body })) };
}

export function toLines(html, url) {
  const { title, og, parts } = page(html, url);
  const lines = [];
  const rest = [];
  let section = 0;
  let images = 0;
  for (const { tag, body } of parts) {
    if (tag === "h2") section++;
    if (section > SECTIONS) {
      if (tag === "h2") rest.push(plain(body));
      continue;
    }
    if (tag === "h2" || tag === "h3") lines.push(`${tag === "h2" ? "##" : "###"} ${plain(body)}`);
    else if (imgSrc({ tag, body })) {
      if (images++ < IMAGES) lines.push(imgSrc({ tag, body }));
    } else if (tag === "p") {
      if (!CREDIT.test(body)) lines.push(plain(body)); // строку кредитов не берём
    } else if (tag === "ul" || tag === "ol")
      [...body.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].forEach((m, i) => lines.push(`${tag === "ul" ? "-" : `${i + 1}.`} ${plain(m[1])}`));
    else {
      // таблиц в Дзене нет: строка таблицы → пункт «ячейка — ячейка — Столбец: число»
      const rows = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => [...m[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => plain(c[1])));
      const head = rows[0] ?? [];
      const cell = (c, i) => (i && /^[\d\s.,–-]+$/.test(c) ? `${head[i]}: ${c}` : c);
      for (const r of rows.slice(1)) lines.push(`- ${r.map(cell).filter(Boolean).join(" — ")}`);
    }
  }
  if (og) lines.splice(1, 0, og); // обложка после первого абзаца
  if (rest.length) lines.push("В полной версии гайда ещё:", ...rest.map((r) => `- ${r}`));
  lines.push(`Всё целиком, с таблицами, картами и скриншотами, — на сайте: ${url}`);
  return { title, lines: lines.filter((l) => !/^(-|\d+\.|#+)?\s*$/.test(l)) };
}

// самопроверка на маленьком куске разметки Astro
{
  const html = `<meta property="og:title" content="Как &quot;быстро&quot; заработать"><meta property="og:image" content="https://gta6spot.ru/c.jpg">
<div class="prose" x><p>Вступление <a href="/karta-gta-6/#p1">карта</a> и <strong>жирное</strong> .</p>
<h2 id="a">Раздел 1</h2><p><img alt="x" src="/_astro/a.webp"></p><table><thead><tr><th>Гараж</th><th>Цена</th><th>Мест</th></tr></thead><tbody><tr><td>Mitchell</td><td>$4&nbsp;000</td><td>1</td></tr></tbody></table>
<h2 id="b">Раздел 2</h2><ol><li>раз</li><li>два</li></ol><ul><li></li></ul><h2 id="c">Раздел 3</h2><p>скрыто</p><p><em>Скриншоты: Rockstar Games.</em></p></div></article>`;
  const { title, lines } = toLines(html, "https://gta6spot.ru/x/");
  assert.equal(title, 'Как "быстро" заработать');
  assert.deepEqual(lines, [
    "Вступление карта и жирное.",
    "https://gta6spot.ru/c.jpg",
    "## Раздел 1",
    "https://gta6spot.ru/_astro/a.webp",
    "- Mitchell — $4 000 — Мест: 1",
    "## Раздел 2",
    "1. раз",
    "2. два",
    "В полной версии гайда ещё:",
    "- Раздел 3",
    "Всё целиком, с таблицами, картами и скриншотами, — на сайте: https://gta6spot.ru/x/",
  ]);
}

// --- HTML статьи → сценарий ролика: [{text: что сказать, cap: надпись сверху, img, optional}] ---------------
const first = (t, n) => (t.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [t]).slice(0, n).join("").trim();
export function toScript(html, url) {
  const { title, og, parts } = page(html, url);
  const intro = { paras: [], imgs: [] };
  const secs = [];
  let cur = intro;
  for (const p of parts) {
    if (p.tag === "h2") secs.push((cur = { head: plain(p.body), paras: [], imgs: [] }));
    else if (imgSrc(p)) cur.imgs.push(imgSrc(p));
    else if (p.tag === "p" && !CREDIT.test(p.body)) cur.paras.push(plain(p.body));
  }
  const pool = [...intro.imgs, ...secs.flatMap((s) => s.imgs)];
  const used = new Set();
  const pick = (own) => {
    const img = own.find((i) => !used.has(i)) ?? pool.find((i) => !used.has(i)) ?? og;
    used.add(img);
    return img;
  };
  const segs = [{ text: title, cap: title, img: og ?? pick([]) }];
  // каждая фраза вступления — свой кадр, чтобы картинка не стояла по 20 секунд
  for (const t of first(intro.paras[0] ?? "", 2).match(/[^.!?]+(?:[.!?]+|$)/g) ?? []) segs.push({ text: t.trim(), cap: "", img: pick(intro.imgs) });
  for (const s of secs.filter((s) => s.paras[0]).slice(0, 3))
    segs.push({ text: `${s.head}${/[.!?]$/.test(s.head) ? "" : "."} ${first(s.paras[0], 1)}`, cap: s.head, img: pick(s.imgs), optional: true });
  segs.push({ text: "Полный гайд с картами и скриншотами на сайте gta6spot.ru.", cap: "Полный гайд на сайте", img: segs.at(-1).img });
  return { title, segs, pool: [...new Set([...pool, og].filter(Boolean))], description: `${first(intro.paras[0] ?? title, 2)}\n\nПолный гайд: ${url}` };
}
{
  const html = `<meta property="og:title" content="Заголовок"><meta property="og:image" content="https://gta6spot.ru/c.jpg">
<div class="prose" x><p>Первое. Второе! Третье.</p><p><img src="/_astro/i.webp"></p>
<h2>Раздел?</h2><p>Раз. Два.</p><h2>Пустой</h2><ul><li>x</li></ul><h2>Третий</h2><p><img src="/_astro/t.webp"></p><p>Три</p></div></article>`;
  const { segs, description } = toScript(html, "https://gta6spot.ru/x/");
  assert.deepEqual(segs.map((s) => [s.text, s.img.replace(/.*\//, "")]), [
    ["Заголовок", "c.jpg"],
    ["Первое.", "i.webp"],
    ["Второе!", "t.webp"], // своих картинок не хватило — следующая неиспользованная
    ["Раздел? Раз.", "c.jpg"], // картинки кончились — обложка
    ["Третий. Три", "c.jpg"],
    ["Полный гайд с картами и скриншотами на сайте gta6spot.ru.", "c.jpg"],
  ]);
  assert.equal(description, "Первое. Второе!\n\nПолный гайд: https://gta6spot.ru/x/");
}

// --- сценарий → mp4 1080x1920: размытый фон, кадр 16:9 с медленным наездом, надпись, субтитры, стинг ------------
const ASSETS = new URL("assets/", import.meta.url).pathname;
const MAX = 52; // секунд без стинга: Дзен считает шортсом ролик до минуты
const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const dur = (f) => Number(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]));
const say = (t) => t.replace(/gta6spot\.ru/gi, "ГТА 6 спот точка ру").replace(/GTA/g, "ГТА");
const unsay = (t) => t.replace(/ГТА 6 спот точка ру/g, "gta6spot.ru").replace(/ГТА/g, "GTA");
const ts = (s) => `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${(s % 60).toFixed(2).padStart(5, "0")}`;
const srt = (f) =>
  readFileSync(f, "utf8").trim().split(/\n\s*\n/).map((b) => {
    const [, t, ...txt] = b.split("\n");
    const [s, e] = t.split(" --> ").map((x) => x.split(/[:,]/).reduce((acc, v, i) => acc + Number(v) * [3600, 60, 1, 0.001][i], 0));
    return { s, e, text: txt.join(" ").trim() };
  });
// длинную фразу режем на куски до 2 строк, время делим по длине
const chunks = (text, max = 34) => text.split(" ").reduce((o, w) => ((o.at(-1) + " " + w).trim().length > max ? o.push(w) : (o[o.length - 1] = (o.at(-1) + " " + w).trim()), o), [""]);
assert.deepEqual(chunks("раз два три", 7), ["раз два", "три"]);
const ass = (s) => s.replace(/[{}\\]/g, "");
const COLOR = { white: "&H00FFFFFF", yellow: "&H005CE4FF", pink: "&H00D3B0FF", navy: "&H001F0D0E" }; // ASS: &HAABBGGRR

export function render(segs, pool, dir) {
  mkdirSync(dir, { recursive: true });
  const ev = [];
  const clips = [];
  const audio = [];
  let t = 0;
  for (const [i, s] of segs.entries()) {
    run("uvx", ["--from", "edge-tts@latest", "edge-tts", "--voice", "ru-RU-SvetlanaNeural", "--rate=+10%", "--text", say(s.text), "--write-media", `${dir}/a${i}.mp3`, "--write-subtitles", `${dir}/a${i}.srt`]);
    const d = dur(`${dir}/a${i}.mp3`) + 0.35;
    if (s.optional && t + d > MAX - 5) continue; // на финальную фразу место оставляем
    // фраза длиннее ~5 с делится на несколько кадров: дальше по статье, по кругу
    const m = Math.max(1, Math.round(d / 5));
    for (let j = 0; j < m; j++) {
      const src = j ? pool[(pool.indexOf(s.img) + j) % pool.length] : s.img;
      const img = `${dir}/i${i}-${j}`;
      run("curl", ["-sfL", "-o", img, src]);
      run("ffmpeg", ["-y", "-v", "error", "-i", img, "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=40,eq=brightness=-0.3", "-frames:v", "1", `${img}.png`]);
      const n = Math.round(((j + 1) * d * 30) / m) - Math.round((j * d * 30) / m);
      run("ffmpeg", ["-y", "-v", "error", "-loop", "1", "-i", `${img}.png`, "-i", img, "-filter_complex",
        `[1:v]scale=2160:1216:force_original_aspect_ratio=increase,crop=2160:1216,zoompan=z='1+0.07*on/${n}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=${n}:s=1080x608:fps=30[fg];[0:v][fg]overlay=0:600,setsar=1`,
        "-frames:v", String(n), "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", `${img}.mp4`]);
      clips.push(`${img}.mp4`);
    }
    audio.push([`${dir}/a${i}.mp3`, d]);
    if (s.cap) ev.push(`Dialogue: 0,${ts(t)},${ts(t + d)},Cap,,0,0,0,,${ass(s.cap.toUpperCase())}`);
    for (const c of s.cap === s.text ? [] : srt(`${dir}/a${i}.srt`)) {
      const parts = chunks(unsay(c.text));
      const len = parts.join("").length;
      let s0 = t + c.s;
      for (const p of parts) {
        const e = s0 + ((c.e - c.s) * p.length) / len;
        ev.push(`Dialogue: 0,${ts(s0)},${ts(e)},Sub,,0,0,0,,${ass(p)}`);
        s0 = e;
      }
    }
    t += d;
  }
  ev.push(`Dialogue: 0,${ts(0)},${ts(t)},Site,,0,0,0,,GTA6SPOT.RU`);
  writeFileSync(`${dir}/subs.ass`, `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Oswald,84,${COLOR.yellow},${COLOR.yellow},${COLOR.navy},&H00000000,-1,0,0,0,100,100,0,0,1,5,0,8,70,70,230,1
Style: Sub,Oswald,76,${COLOR.white},${COLOR.white},${COLOR.navy},&H00000000,-1,0,0,0,100,100,0,0,1,4,0,8,70,70,1270,1
Style: Site,Oswald,58,${COLOR.pink},${COLOR.pink},${COLOR.navy},&H00000000,-1,0,0,0,100,100,2,0,1,4,0,2,70,70,150,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${ev.join("\n")}
`);
  const out = `${dir}/out.mp4`;
  const k = clips.length;
  const norm = (j) => `[${j}:v]fps=30,scale=1080:1920,setsar=1,format=yuv420p[v${j}]`;
  run("ffmpeg", ["-y", "-v", "error", ...clips.flatMap((c) => ["-i", c]), "-i", `${ASSETS}sting.mp4`, ...audio.flatMap(([f]) => ["-i", f]), "-filter_complex", [
    ...[...Array(k + 1).keys()].map(norm),
    `${[...Array(k + 1).keys()].map((j) => `[v${j}]`).join("")}concat=n=${k + 1}:v=1:a=0,ass=${dir}/subs.ass:fontsdir=${ASSETS}[v]`,
    ...audio.map(([, d], j) => `[${k + 1 + j}:a]apad=whole_dur=${d.toFixed(3)}[a${j}]`),
    `${audio.map((_, j) => `[a${j}]`).join("")}concat=n=${audio.length}:v=0:a=1,apad[a]`,
  ].join(";"), "-map", "[v]", "-map", "[a]", "-t", (t + dur(`${ASSETS}sting.mp4`)).toFixed(3),
    "-c:v", "libx264", "-preset", "medium", "-crf", "21", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out]);
  return out;
}

// ссылка на черновик из ошибки dzen-post.mjs при капче
const draftUrl = (err) => err.match(/капчу[^\n]*?(https:\/\/dzen\.ru\/profile\/editor\/\S+)\s*$/m)?.[1];
assert.equal(draftUrl("throw new Error(`Дзен требует капчу: ${editUrl}`);\nError: Дзен требует капчу, черновик сохранён — опубликуйте руками: https://dzen.ru/profile/editor/id/6a05/6afe/edit\n    at"), "https://dzen.ru/profile/editor/id/6a05/6afe/edit");
// уведомление владельцу в Telegram: бот канала gta6spot (TG_TOKEN), личный чат (TG_NOTIFY_CHAT) — из EnvironmentFile юнита
async function notify(text) {
  const { TG_TOKEN, TG_NOTIFY_CHAT } = process.env;
  if (!TG_TOKEN || !TG_NOTIFY_CHAT) return console.error("TG_TOKEN/TG_NOTIFY_CHAT не заданы, уведомление не ушло");
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TG_NOTIFY_CHAT, text, disable_web_page_preview: true }),
  });
  if (!r.ok) console.error(`Telegram → ${r.status} ${(await r.text()).slice(0, 200)}`);
}

// --- что постить -----------------------------------------------------------------------------
let candidates = a.slug ? [a.slug] : null;
if (!candidates) {
  const sitemap = [...(await get("/sitemap.xml")).matchAll(/<loc>https:\/\/gta6spot\.ru\/([a-z0-9-]+)\/<\/loc>/g)].map((m) => m[1]);
  candidates = [...new Set([...Object.keys(BAIT).filter((s) => sitemap.includes(s)), ...slugs(await get("/tema/gaydy/")).filter((s) => sitemap.includes(s)), ...sitemap])].filter((s) => !posted[s]);
}
let slug, url, html;
for (const s of candidates) {
  const h = await get(`${SITE}/${s}/`);
  if (h.includes("data-pagefind-body")) {
    [slug, url, html] = [s, `${SITE}/${s}/`, h];
    break;
  }
  posted[s] = { skipped: "не статья" }; // разделы и служебные страницы больше не проверяем
}
writeFileSync(STATE, JSON.stringify(posted, null, 1));
if (!slug) {
  console.log(JSON.stringify({ skipped: a.slug ? `${a.slug}: не статья` : "всё уже опубликовано" }));
  process.exit(0);
}
if (a.video) {
  const { title, segs, pool, description } = toScript(html, url);
  const file = render(segs, pool, `/tmp/dzen-video-${slug}`);
  if (a.dry) {
    console.log(JSON.stringify({ slug, file, seconds: dur(file) }));
    process.exit(0);
  }
  writeFileSync(`/tmp/dzen-video-${slug}/desc.txt`, description);
  await publish(["video", "--file", file, "--title", title, "--text", `/tmp/dzen-video-${slug}/desc.txt`], title);
} else {
  const { title, lines } = toLines(html, url);
  if (a.dry) {
    console.log(`${title}\n\n${lines.join("\n")}`);
    process.exit(0);
  }
  writeFileSync(`/tmp/dzen-${slug}.txt`, lines.join("\n"));
  await publish(["article", "--title", title, "--text", `/tmp/dzen-${slug}.txt`], title);
}

async function publish(args, title) {
  let out;
  try {
    out = execFileSync(process.execPath, [new URL("dzen-post.mjs", import.meta.url).pathname, ...args, ...(a.draft ? ["--draft"] : [])], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // Дзен с зарубежного IP просит капчу: его запросы идут через российский прокси (DZEN_PROXY из .env; туннель dzen-ru-socks.service + privoxy dzen-ru-http.service), остальное напрямую
      env: { ...process.env, ...(process.env.DZEN_PROXY && { NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: process.env.DZEN_PROXY, HTTP_PROXY: process.env.DZEN_PROXY }) },
    });
  } catch (e) {
    const url = draftUrl(String(e.stderr));
    if (!url) {
      // протухшие куки и прочие сбои: владелец узнаёт сразу, а не по пустой ленте
      await notify(`Дзен-автопост упал (${a.video ? "ролик" : "статья"}): ${String(e.stderr).match(/^Error: .*$/m)?.[0] ?? e.message}`);
      throw e;
    }
    // капча: черновик остаётся, владелец публикует руками по ссылке из Telegram, очередь идёт дальше
    posted[slug] = { draft: url, date: new Date().toISOString() };
    writeFileSync(STATE, JSON.stringify(posted, null, 1));
    await notify(`Дзен просит капчу — опубликуй ${a.video ? "ролик" : "статью"} руками:\n${title}\n${url}`);
    console.log(JSON.stringify({ slug, draft: url }));
    return;
  }
  const res = JSON.parse(out.trim().split("\n").pop());
  if (res.published) posted[slug] = { id: res.id, url: res.url, date: new Date().toISOString() };
  writeFileSync(STATE, JSON.stringify(posted, null, 1));
  console.log(JSON.stringify({ slug, ...res }));
}
