#!/usr/bin/env node
// Постинг в Дзен через внутренний API студии (форматы сняты с редактора dzen.ru 19.11.2026:
// zen-apps/editor 1.328.2, article-editor-desktop 1.37.9).
//
//   node dzen-post.mjs article --title "Заголовок" --text статья.md [--draft]
//   node dzen-post.mjs post    --text пост.txt [--image URL|файл ...] [--draft]
//   node dzen-post.mjs video   --file ролик.mp4 --title "Заголовок" [--text описание.txt] [--draft]
//   node dzen-post.mjs delete  --id ID
//
// Вход: cookies.txt рядом со скриптом (экспорт кук dzen.ru из браузера, формат Netscape).
// Канал: DZEN_CHANNEL (по умолчанию gta6info). Для video нужен ffprobe.
// Текст: «## »/«### » подзаголовки, «- » список, «1. » нумерованный, «> » цитата,
// строка-картинка (![](url), URL .jpg/.png/.webp или путь к файлу) = картинка, остальное абзацы; голые ссылки кликабельны.
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { parseArgs } from "node:util";

const CHANNEL = process.env.DZEN_CHANNEL ?? "gta6info";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36";
const {
  positionals: [kind],
  values: a,
} = parseArgs({
  allowPositionals: true,
  options: {
    title: { type: "string" },
    text: { type: "string" },
    image: { type: "string", multiple: true },
    file: { type: "string" },
    id: { type: "string" },
    draft: { type: "boolean" },
  },
});

// ---------- текст → Draft.js raw (как сохраняет редактор Дзена) ----------
const IMG_LINE = /^!\[[^\]]*\]\((\S+)\)$|^(https?:\/\/\S+\.(?:jpe?g|png|webp)(?:\?\S*)?)$|^(\S+\.(?:jpe?g|png|webp))$/i;
const PREFIX = [
  [/^### /, "header-three"],
  [/^## /, "header-two"],
  [/^[-*] /, "unordered-list-item"],
  [/^\d+[.)] /, "ordered-list-item"],
  [/^> /, "blockquote"],
];
// строки → [{type, text}] или [{image: src}]
function parse(src) {
  return src
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const img = line.match(IMG_LINE);
      if (img) return { image: img[1] ?? img[2] ?? img[3] };
      const [re, type] = PREFIX.find(([re]) => re.test(line)) ?? [/^/, "unstyled"];
      return { type, text: line.replace(re, "") };
    });
}
// Draft считает offset в символах (code points), а не в UTF-16
const cp = (s) => [...s].length;
function toRaw(items, imageIds = []) {
  const entityMap = {};
  let e = 0;
  let img = 0;
  const blocks = items.map((it, i) => {
    const base = { key: `k${i}`, depth: 0, inlineStyleRanges: [], entityRanges: [], data: {} };
    if (it.image) return { ...base, text: "", type: "atomic:image", data: { image: { id: imageIds[img++] } } };
    const entityRanges = [...it.text.matchAll(/https?:\/\/\S+[^\s.,;:!?)»"]/g)].map((m) => {
      entityMap[e] = { type: "LINK", mutability: "MUTABLE", data: { url: m[0] } };
      return { offset: cp(it.text.slice(0, m.index)), length: cp(m[0]), key: e++ };
    });
    return { ...base, text: it.text, type: it.type, entityRanges };
  });
  return { blocks, entityMap };
}
{
  const r = toRaw(parse("## Итоги\n🔥 Смотрите https://x.ru/a, ок\n![](https://x.ru/p.jpg)\n- пункт"), ["IMG"]);
  assert.deepEqual(r.blocks.map((b) => b.type), ["header-two", "unstyled", "atomic:image", "unordered-list-item"]);
  assert.deepEqual(r.blocks[1].entityRanges, [{ offset: 11, length: 14, key: 0 }]); // в UTF-16 было бы 12
  assert.equal(r.blocks[2].data.image.id, "IMG");
}
if (!["article", "post", "video", "delete"].includes(kind)) throw new Error("первый аргумент: article | post | video | delete");

// ---------- сессия: куки → csrf, publisherId ----------
const jar = readFileSync(new URL("cookies.txt", import.meta.url), "utf8")
  .split("\n")
  .map((l) => l.trim().replace(/^#HttpOnly_/, ""))
  .filter((l) => l && !l.startsWith("#"))
  .map((l) => l.split(/\s+/))
  .filter((c) => c.length >= 7)
  .map((c) => `${c[5]}=${c[6]}`)
  .join("; ");
const H = { Cookie: jar, "User-Agent": UA, Accept: "application/json" };
const studio = await (await fetch(`https://dzen.ru/profile/editor/${CHANNEL}`, { headers: H })).text();
const PID = studio.match(/"publisherId":"([^"]+)"/)?.[1];
if (!PID) throw new Error(`студия ${CHANNEL} не открылась: куки устарели, экспортируйте cookies.txt заново`);
let csrf = "";
async function req(path, { query, json, form, method } = {}) {
  const u = new URL(path, "https://dzen.ru");
  for (const [k, v] of Object.entries(query ?? {})) u.searchParams.set(k, v);
  const body = json ? JSON.stringify({ ...json, fp: "" }) : form;
  const r = await fetch(u, {
    method: method ?? (body ? "POST" : "GET"),
    body,
    headers: { ...H, "X-Csrf-Token": csrf, ...(json && { "Content-Type": "application/json" }) },
  });
  const t = await r.text();
  let j;
  try {
    j = JSON.parse(t);
  } catch {
    j = t.slice(0, 200);
  }
  if (!r.ok || j?.errors?.length) throw new Error(`${u.pathname} → ${r.status} ${JSON.stringify(j).slice(0, 400)}`);
  return j;
}
csrf = (await req("/media-api/csrf-token")).result;

const create = async (publicationType, title = "") => (await req("/editor-api/v2/add-publication", { query: { publisherId: PID }, json: { title, publisherId: PID, publicationType } })).id;
const read = async (id) => (await req(`/editor-api/v2/publisher/${PID}/publication/${id}`)).publications[0];
async function upload(id, src) {
  if (/^https?:/.test(src)) return req("/editor-api/v2/add-image-from-url", { query: { publicationId: id, url: src, publisherId: PID }, json: {} });
  const form = new FormData();
  form.append("image", new Blob([readFileSync(src)]), basename(src));
  return req("/editor-api/v2/add-image", { query: { publicationId: id, publisherId: PID }, form });
}
// общие поля, которые редактор шлёт для любого типа
const common = (id, preview) => ({
  id, preview, snippetFrozen: false, hasNativeAds: false, commentsFlagState: "on", delayedPublicationFlagState: "off",
  visibleComments: "subscribe-visible", visibilityType: "all", premiumTariffs: [], tagsInput: { tags: [], detectedTagsShown: false },
});
async function save(id, body, editUrl) {
  try {
    await req("/editor-api/v2/update-publication-content", { query: { publisherId: PID }, json: body });
  } catch (e) {
    // otherwise every failed run leaves an empty draft in the studio
    await req(`/editor-api/v2/publisher/${PID}/publications/${id}`, { method: "DELETE" }).catch(() => {});
    throw e;
  }
  if (!a.draft) {
    try {
      await req("/editor-api/v2/update-publication-content-and-publish", { query: { publisherId: PID }, json: body });
    } catch (e) {
      if (/captcha/.test(e.message)) throw new Error(`Дзен требует капчу, черновик сохранён — опубликуйте руками: ${editUrl}`);
      throw e;
    }
  }
  console.log(JSON.stringify({ id, type: kind, published: !a.draft, url: a.draft ? editUrl : `https://dzen.ru/media/id/${PID}/${id}` }));
}
const editor = `https://dzen.ru/profile/editor/id/${PID}`;
const snippet = (items) => items.filter((i) => i.text && i.type === "unstyled").map((i) => i.text).slice(0, 3).join("\n").slice(0, 300);

if (kind === "delete") {
  if (!a.id) throw new Error("нужен --id");
  await req(`/editor-api/v2/publisher/${PID}/publications/${a.id}`, { method: "DELETE" });
  console.log(JSON.stringify({ id: a.id, deleted: true }));
} else if (kind === "article") {
  if (!a.title || !a.text) throw new Error("нужны --title и --text");
  const items = parse(readFileSync(a.text, "utf8"));
  const id = await create("article");
  const ids = [];
  for (const it of items.filter((i) => i.image)) ids.push((await upload(id, it.image)).id);
  const raw = toRaw(items, ids);
  const body = { ...common(id, { title: a.title, snippet: snippet(items), galleryPreviewImages: [] }), articleContent: { contentState: JSON.stringify(raw) } };
  await save(id, body, `${editor}/${id}/edit`);
} else if (kind === "post") {
  if (!a.text) throw new Error("нужен --text");
  const items = parse(readFileSync(a.text, "utf8")).filter((i) => !i.image);
  const id = await create("brief");
  const imgs = [];
  for (const src of a.image ?? []) imgs.push(await upload(id, src));
  // соотношение галереи редактор выбирает по первой картинке
  const s = imgs[0]?.sizes?.orig ?? imgs[0]?.sizes?.scale_1200;
  const k = s ? s.width / s.height : 16 / 9;
  const ratio = k > 1.5 ? "ratio-16x9" : k > 1.15 ? "ratio-4x3" : k > 0.9 ? "ratio-1x1" : "ratio-4x5";
  const contentState = JSON.stringify({ gallery: { ratio, baseRatio: ratio, items: imgs.map((i) => ({ imageId: { id: i.id } })) }, content: JSON.stringify(toRaw(items)) });
  const body = { ...common(id, { title: "", snippet: "", galleryPreviewImages: [] }), articleContent: { contentState }, darkPost: false };
  await save(id, body, `${editor}?briefEditorPublicationId=${id}`);
} else {
  if (!a.file || !a.title) throw new Error("нужны --file и --title");
  if (!existsSync(a.file)) throw new Error(`${a.file}: нет файла`);
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", a.file], { encoding: "utf8" }));
  const { width, height } = probe.streams[0];
  const duration = Math.round(Number(probe.format.duration));
  const size = statSync(a.file).size;
  const fmt = extname(a.file).slice(1).toLowerCase();
  const mime = { mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska", avi: "video/x-msvideo" }[fmt] ?? "video/mp4";
  const v = await req("/media-api-video/validate-video", { query: { fileSize: size, mimeType: mime, duration, width, height }, json: {} });
  if (!v.ok) throw new Error(`Дзен не принял видео: ${JSON.stringify(v.errors)}`);
  const isShort = v.videoType === "short"; // shortcut: шортсы не проверены вживую, проверить на первом вертикальном ролике
  const id = await create(isShort ? "short_video" : "gif", a.title);
  const form = (o) => Object.entries(o).reduce((f, [k, val]) => (f.append(k, String(val)), f), new FormData());
  const { uploadUrl } = await req("/media-api-video/start-upload-video", {
    form: form({ isShort, publisherId: PID, publicationId: id, fileSize: size, fileName: basename(a.file), originalFormat: fmt, width, height, duration }),
  });
  // tus-загрузка на vu.okcdn.ru кусками по 32 МБ
  const data = readFileSync(a.file);
  const TUS = { "Tus-Resumable": "1.0.0" };
  let off = Number((await fetch(uploadUrl, { method: "HEAD", headers: TUS })).headers.get("upload-offset") ?? 0);
  while (off < size) {
    const r = await fetch(uploadUrl, {
      method: "PATCH",
      headers: { ...TUS, "Upload-Offset": String(off), "Content-Type": "application/offset+octet-stream" },
      body: data.subarray(off, off + 32 * 2 ** 20),
    });
    if (!r.ok) throw new Error(`загрузка видео → ${r.status} на offset ${off}`);
    off = Number(r.headers.get("upload-offset") ?? off + 32 * 2 ** 20);
  }
  await req("/media-api-video/finish-upload-video", { form: form({ publisherId: PID, publicationId: id }) });
  let pub;
  for (let t = 0; ; t++) {
    pub = await read(id);
    const g = pub.content.gifContent;
    if (g.isFailed) throw new Error(`Дзен не смог обработать видео, черновик ${id}`);
    if (g.isConverted) break;
    if (t > 180) throw new Error(`видео не сконвертировалось за 15 минут, черновик: ${editor}?videoEditorPublicationId=${id}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  const description = a.text ? readFileSync(a.text, "utf8").trim() : "";
  const body = {
    ...common(id, { title: a.title, snippet: description, ...(pub.content.preview.image && { image: pub.content.preview.image }) }),
    customCommentsTitle: "", gifContent: pub.content.gifContent, gifMentions: [],
  };
  await save(id, body, `${editor}?videoEditorPublicationId=${id}`);
}
