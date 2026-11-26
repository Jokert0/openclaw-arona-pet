const fs = require("node:fs/promises");
const path = require("node:path");

const { homedir } = require("node:os");
const soundRoot = path.join(homedir(), ".dsh", "profiles", "desktop", "node_modules", "dsh-arona-pet", "assets", "audio");
const soundFiles = new Set(["pinch_press.mp3", "pinch_release.mp3", "halo.mp3"]);
const MODEL_URL = "petasset://local/model/entry.model3.json";
const CORE_URL = "petasset://local/core/live2dcubismcore.min.js";
const mime = new Map([
  [".json", "application/json"],
  [".moc3", "application/octet-stream"],
  [".png", "image/png"],
  [".wav", "audio/wav"],
  [".mp3", "audio/mpeg"],
  [".ogg", "audio/ogg"],
]);

async function confinedFile(root, name) {
  // Validate on Windows rules even when inspecting the asset bundle on another OS.
  if (
    name.split("/").some((part) => !part || part === "." || /[. ]$|[:\\%?#\x00-\x1f]/.test(part))
  ) {
    throw new Error("模型清单包含无效的资源路径");
  }
  const file = await fs.realpath(path.join(root, name));
  const relative = path.relative(root, file);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("模型资源超出模型目录");
  }
  return file;
}

async function loadCatalog(directory) {
  const root = await fs.realpath(directory);
  const entries = (await fs.readdir(root)).filter((name) => name.endsWith(".model3.json"));
  if (entries.length !== 1) throw new Error("模型目录需要恰好一个 .model3.json 入口文件");
  const manifest = await fs.readFile(await confinedFile(root, entries[0]));
  const refs = JSON.parse(manifest.toString("utf8")).FileReferences;
  const files = [
    refs.Moc,
    ...(refs.Textures || []),
    refs.Physics,
    refs.Pose,
    refs.DisplayInfo,
    refs.UserData,
    ...(refs.Expressions || []).map((item) => item.File),
  ];
  for (const motions of Object.values(refs.Motions || {})) {
    for (const motion of motions) files.push(motion.File, motion.Sound);
  }
  return { root, manifest, files: new Set(files.filter((name) => typeof name === "string")) };
}

function createAssets({ directory, core }) {
  let catalog;
  return async function handle(request) {
    const headers = { "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff" };
    const fail = (message, status) => new Response(message, { status, headers });
    if (request.method !== "GET" && request.method !== "HEAD")
      return fail("Method not allowed", 405);
    const url = new URL(request.url);
    if (url.protocol !== "petasset:" || url.host !== "local" || url.username || url.password)
      return fail("Not found", 404);
    let body, type;
    try {
      if (url.pathname === "/core/live2dcubismcore.min.js") {
        if (!core) return fail("请通过 ARONA_CUBISM_CORE 指定 Cubism Core 文件", 404);
        body = await fs.readFile(core);
        type = "text/javascript";
      } else if (url.pathname.startsWith("/sound/") && soundFiles.has(url.pathname.slice(7))) {
        body = await fs.readFile(await confinedFile(soundRoot, url.pathname.slice(7)));
        type = "audio/mpeg";
      } else if (url.pathname.startsWith("/model/")) {
        const name = decodeURIComponent(url.pathname.slice("/model/".length));
        const model = await (catalog ??= loadCatalog(directory).catch((error) => {
          catalog = undefined;
          throw error;
        }));
        if (name === "entry.model3.json") {
          body = model.manifest;
          type = "application/json";
        } else {
          type = mime.get(path.extname(name).toLowerCase());
          if (!type || !model.files.has(name)) return fail("Not found", 404);
          body = await fs.readFile(await confinedFile(model.root, name));
        }
      } else {
        return fail("Not found", 404);
      }
    } catch (error) {
      return fail(
        error instanceof URIError ? "Invalid URL" : "本地资源不可用，请检查模型目录或 Core 配置",
        error instanceof URIError ? 400 : 404,
      );
    }
    return new Response(request.method === "HEAD" ? null : body, {
      headers: { ...headers, "Content-Type": type },
    });
  };
}

module.exports = { createAssets, MODEL_URL, CORE_URL };
