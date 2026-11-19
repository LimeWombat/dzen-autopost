#!/usr/bin/env node
// Следующая статья gta6spot.ru → статья в Дзен-канале (gta6info): вступление и первые разделы с картинками,
// дальше список остальных разделов и ссылка на полную версию на сайте. Тот же анонс, что уходит на DTF.
//
//   node gta6spot.mjs [--slug kak-prodat-mashinu-gta-6] [--draft] [--dry]
//
// Без --slug берёт первую ещё не опубликованную: сначала гайды (/tema/gaydy/), потом остальное из sitemap.
// Опубликованные пишет в posted.json ({slug: {id, url, date}}). Таймер: 4 раза в день, по одной статье, через flock.
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const SITE = "https://gta6spot.ru";
const SECTIONS = 2; // сколько разделов статьи идут в анонс целиком
const IMAGES = 4;
const { values: a } = parseArgs({ options: { slug: { type: "string" }, draft: { type: "boolean" }, dry: { type: "boolean" } } });
const STATE = new URL("posted.json", import.meta.url);
const posted = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};

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

export function toLines(html, url) {
  const title = decode(html.match(/<meta property="og:title" content="([^"]+)"/)[1]);
  const og = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1];
  const prose = html.match(/<div class="prose"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/article>|<div|<aside)/)?.[1];
  if (!prose) throw new Error(`${url}: нет <div class="prose">`);
  const parts = [...prose.matchAll(/<(h2|h3|p|ul|ol|table)\b[^>]*>([\s\S]*?)<\/\1>/g)].map(([, tag, body]) => ({ tag, body }));
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
    else if (tag === "p" && body.trim().startsWith("<img")) {
      if (images++ < IMAGES) lines.push(abs(body.match(/src="([^"]+)"/)[1]));
    } else if (tag === "p") {
      if (!/^\s*<em>(Скриншоты|Карта):/.test(body)) lines.push(plain(body)); // строку кредитов не берём
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

// --- что постить -----------------------------------------------------------------------------
let candidates = a.slug ? [a.slug] : null;
if (!candidates) {
  const sitemap = [...(await get("/sitemap.xml")).matchAll(/<loc>https:\/\/gta6spot\.ru\/([a-z0-9-]+)\/<\/loc>/g)].map((m) => m[1]);
  candidates = [...new Set([...slugs(await get("/tema/gaydy/")).filter((s) => sitemap.includes(s)), ...sitemap])].filter((s) => !posted[s]);
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
const { title, lines } = toLines(html, url);
if (a.dry) {
  console.log(`${title}\n\n${lines.join("\n")}`);
  process.exit(0);
}
const file = `/tmp/dzen-${slug}.txt`;
writeFileSync(file, lines.join("\n"));
// shortcut: при капче dzen-post.mjs падает и оставляет черновик; следующий запуск создаст ещё один — чистить руками, если капча станет частой
const out = execFileSync(process.execPath, [new URL("dzen-post.mjs", import.meta.url).pathname, "article", "--title", title, "--text", file, ...(a.draft ? ["--draft"] : [])], { encoding: "utf8" });
const res = JSON.parse(out.trim().split("\n").pop());
if (res.published) posted[slug] = { id: res.id, url: res.url, date: new Date().toISOString() };
writeFileSync(STATE, JSON.stringify(posted, null, 1));
console.log(JSON.stringify({ slug, ...res }));
