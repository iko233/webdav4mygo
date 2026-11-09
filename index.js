const t = host.t;
const folderCache = new Map();
const cacheLifetime = 120_000;
const folderLimit = 512;
const pageSize = 50;
const lyricType = /\.lrc$/i;
const imageTypes = /\.(?:jpe?g|png|gif|webp)$/i;
const audioTypes = new Set(["mp3", "flac", "wav", "m4a", "aac", "ogg"]);
const propfind = '<propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>';

function fail(message, code) {
  const error = new Error(message);
  if (code) error.code = code;
  return error;
}

function base64(text) {
  return encodeBase64(new TextEncoder().encode(text));
}

function encodeBase64(bytes) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const value = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    result += alphabet[value >> 18] + alphabet[(value >> 12) & 63];
    result += i + 1 < bytes.length ? alphabet[(value >> 6) & 63] : "=";
    result += i + 2 < bytes.length ? alphabet[value & 63] : "=";
  }
  return result;
}

function canonicalPath(path) {
  const segments = path.replace(/^\//, "").replace(/\/$/, "").split("/");
  if (segments.length === 1 && segments[0] === "") return "/";
  return "/" + segments.map(segment => {
    const name = decodeURIComponent(segment);
    if (!name || name === "." || name === ".." || /[/\\\u0000-\u001f\u007f]/.test(name)) {
      throw new Error("Invalid path segment");
    }
    return encodeURIComponent(name);
  }).join("/");
}

function directory(path) {
  return path.endsWith("/") ? path : path + "/";
}

function config() {
  const address = (host.setting("server") || "").trim();
  if (!address) throw fail(t("Enter the WebDAV music folder URL in plugin settings."), "setup");

  let url, root;
  try {
    url = new URL(address);
    if (!["http:", "https:"].includes(url.protocol) || !url.host ||
        url.username || url.password || url.search || url.hash) throw new Error();
    root = directory(canonicalPath(url.pathname));
  } catch {
    throw fail(t("Use a full HTTP or HTTPS folder URL without credentials, a query or a fragment."), "setup");
  }

  const username = host.setting("username") || "";
  const password = host.setting("password") || "";
  if (username.includes(":") || (!username && password)) {
    throw fail(t("Enter a WebDAV username without a colon, or clear both fields for anonymous access."), "setup");
  }

  const origin = url.origin;
  return {
    origin,
    root,
    library: host.crypto.md5(JSON.stringify([origin, root, username])),
    headers: username ? { Authorization: "Basic " + base64(username + ":" + password) } : {},
  };
}

function xmlText(text) {
  const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return text.replace(/&(amp|lt|gt|quot|apos|#x[\da-f]+|#\d+);/gi, (entity, key) => {
    if (key[0] !== "#") return entities[key] ?? entity;
    const code = key[1].toLowerCase() === "x" ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

function successful(status) {
  return /^HTTP\/\S+\s+2\d\d(?:\s|$)/.test(status.trim());
}

// Read the DAV fields used by Depth: 1 without relying on a browser DOM.
function davResponses(xml) {
  const tokens = /<!--[^]*?-->|<\?[^]*?\?>|<!\[CDATA\[([^]*?)\]\]>|<(\/?)([\w:.-]+)(?:[^<>"']|"[^"]*"|'[^']*')*>|[^<]+|</g;
  const stack = [];
  const entries = [];
  let sawRoot = false;
  let response, properties;

  for (const match of xml.matchAll(tokens)) {
    const [raw, cdata, closing, qualified] = match;
    if (raw.startsWith("<!--") || raw.startsWith("<?")) continue;
    if (!qualified) {
      if (raw === "<") throw fail(t("The server returned invalid WebDAV XML."));
      const field = stack.join("/");
      const value = cdata ?? xmlText(raw);
      if (field === "multistatus/response/href") response.href += value;
      if (field === "multistatus/response/status") response.status += value;
      if (field === "multistatus/response/propstat/status") properties.status += value;
      continue;
    }

    const name = qualified.split(":").pop();
    if (!closing) {
      stack.push(name);
      const field = stack.join("/");
      if (stack.length === 1) sawRoot = name === "multistatus";
      if (field === "multistatus/response") response = { href: "", status: "", listed: false, folder: false };
      if (field === "multistatus/response/propstat") properties = { status: "", folder: false };
      if (field === "multistatus/response/propstat/prop/resourcetype/collection") properties.folder = true;
      if (!raw.endsWith("/>")) continue;
    }
    if (stack[stack.length - 1] !== name) throw fail(t("The server returned invalid WebDAV XML."));
    const field = stack.join("/");
    if (field === "multistatus/response/propstat" && successful(properties.status)) {
      response.listed = true;
      response.folder ||= properties.folder;
    }
    if (field === "multistatus/response" && response.href.trim() &&
        (response.status ? successful(response.status) : response.listed)) {
      entries.push(response);
    }
    stack.pop();
  }
  if (!sawRoot || stack.length) throw fail(t("The server returned invalid WebDAV XML."));
  return entries;
}

function entryPath(entry, settings, folder) {
  try {
    const url = new URL(entry.href.trim(), settings.origin + folder);
    if (url.origin !== settings.origin || url.username || url.password || url.search || url.hash) return null;
    const path = canonicalPath(url.pathname);
    // Depth: 1 should only contain the requested directory and direct children.
    if (!path.startsWith(folder) || !path.slice(folder.length) || path.slice(folder.length).includes("/")) return null;
    return entry.folder || url.pathname.endsWith("/") ? directory(path) : path;
  } catch {
    return null;
  }
}

function basename(path) {
  return decodeURIComponent(path.replace(/\/$/, "").split("/").pop());
}

function audioType(path) {
  const extension = /\.([^.]+)$/.exec(basename(path))?.[1].toLowerCase();
  if (extension === "wave") return "wav";
  if (extension === "oga") return "ogg";
  return audioTypes.has(extension) ? extension : null;
}

async function requestFolder(settings, folder, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(settings.origin + folder, {
      method: "PROPFIND",
      headers: { ...settings.headers, Depth: "1", "Content-Type": "application/xml; charset=utf-8" },
      body: propfind,
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      throw fail(t("Access denied. Check the WebDAV credentials and folder permissions."), "setup");
    }
    if (response.status >= 300 && response.status < 400 || response.type === "opaqueredirect") {
      throw fail(t("The WebDAV URL redirects. Enter the final music folder URL."), "setup");
    }
    if (response.status === 404 || response.status === 405 || response.status === 501) {
      throw fail(t("This URL does not provide a WebDAV folder.") + " (HTTP " + response.status + ")", "setup");
    }
    if (response.status !== 207) {
      throw fail(t("WebDAV could not list the folder.") + " (HTTP " + response.status + ")");
    }

    const entries = new Map();
    for (const entry of davResponses(await response.text())) {
      const path = entryPath(entry, settings, folder);
      if (path && (path.endsWith("/") || audioType(path) || imageTypes.test(path) || lyricType.test(path))) entries.set(path, basename(path));
    }
    return [...entries].sort((a, b) => a[1].localeCompare(b[1], host.language(), { numeric: true }));
  } catch (error) {
    if (controller.signal.aborted) throw fail(t("The WebDAV server took too long to respond."));
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function listFolder(settings, folder, timeout = 8_000) {
  const key = settings.library + folder;
  const cached = folderCache.get(key);
  if (cached && cached.until > Date.now()) return cached.result;
  folderCache.delete(key);
  const result = requestFolder(settings, folder, timeout);
  const item = { result, until: Date.now() + cacheLifetime };
  folderCache.set(key, item);
  if (folderCache.size > folderLimit) folderCache.delete(folderCache.keys().next().value);
  result.catch(() => {
    if (folderCache.get(key) === item) folderCache.delete(key);
  });
  return result;
}

export function setSetting() {
  folderCache.clear();
  metadataCache.clear();
  sidecarCache.clear();
  folderCoverCache.clear();
}

function readId(settings, id, isFolder) {
  const prefix = settings.library + ":";
  if (typeof id === "string" && id.startsWith(prefix)) {
    const path = id.slice(prefix.length);
    try {
      const canonical = canonicalPath(path);
      if (path.startsWith(settings.root) && path === (isFolder ? directory(canonical) : canonical)) return path;
    } catch {
      // Treat invalid or outdated IDs the same way.
    }
  }
  throw fail(t("This item is outside the current WebDAV music folder."), "unavailable");
}

function itemId(settings, path) {
  return settings.library + ":" + path;
}

function track(settings, path, name) {
  return { id: itemId(settings, path), name: name.replace(/\.[^.]+$/, "") || name };
}

function coversIn(listing) {
  const images = new Map(listing.filter(([path]) => imageTypes.test(path)).map(([path, name]) => [name.toLowerCase(), path]));
  const named = names => {
    for (const name of names) {
      for (const ext of ["jpg", "jpeg", "png", "webp", "gif"]) {
        const path = images.get(name + "." + ext);
        if (path) return path;
      }
    }
  };
  return { named };
}

function playlistEntry(settings, folder, name) {
  return { id: itemId(settings, folder), name, mine: true, fixed: true };
}

export async function playlists() {
  if (!host.setting("server")?.trim()) return [];
  const settings = config();
  const folders = (await listFolder(settings, settings.root)).filter(([path]) => path.endsWith("/"));
  const artwork = await folderCovers(settings, folders);
  return folders.map(([path, name]) => ({
    ...playlistEntry(settings, path, name),
    imageUrl: artwork.get(path) || blankFolderCover(),
  }));
}

export async function playlist({ id }) {
  const settings = config();
  const folder = readId(settings, id, true);
  const listing = await listFolder(settings, folder);
  const files = listing.filter(([path]) => !path.endsWith("/") && audioType(path));
  const tracks = await tracksWithMetadata(settings, files);
  return {
    ...playlistEntry(settings, folder, folder === settings.root ? t("Music folders") : basename(folder)),
    trackCount: tracks.length,
    tracks,
    imageUrl: tracks.find(track => track.album?.imageUrl)?.album.imageUrl || blankFolderCover(),
  };
}

export async function artist({ id }) {
  const settings = config();
  const path = readId(settings, id, false);
  const folder = path.slice(0, path.lastIndexOf("/") + 1);
  const listing = await listFolder(settings, folder);
  const files = listing.filter(([file]) => !file.endsWith("/") && audioType(file));
  const selected = files.find(([file]) => file === path);
  if (!selected) throw fail(t("This song is no longer in the WebDAV folder."), "unavailable");
  const nearby = files.filter(entry => entry !== selected).slice(0, pageSize - 1);
  const tracks = await tracksWithMetadata(settings, [selected, ...nearby]);
  const singer = tracks[0].artists?.[0];
  if (!singer) throw fail(t("This song has no artist information."), "unavailable");
  const matches = tracks.filter(track => track.artists?.[0]?.name === singer.name);
  const portrait = matches.find(track => track.artists[0].imageUrl)?.artists[0].imageUrl;
  return { artist: { ...singer, imageUrl: portrait }, tracks: matches };
}

function pageLinks(offset, more, pageFor) {
  const links = [];
  if (offset) links.push({ title: t("Previous page"), page: pageFor(offset - pageSize) });
  if (more) links.push({ title: t("Next page"), page: pageFor(offset + pageSize) });
  return links.length ? [{ links }] : [];
}

export function home() {
  return allMusic(config(), 0);
}

export async function browse({ page }) {
  const settings = config();
  const all = /^all:(\d+)$/.exec(page);
  if (all) return allMusic(settings, Number(all[1]));

  const paged = /^folder:(\d+):(.+)$/.exec(page);
  const offset = paged ? Number(paged[1]) : 0;
  const folder = page === "root" ? settings.root : readId(settings, paged ? paged[2] : page, true);
  const links = [];
  const children = [];
  const files = [];
  if (folder !== settings.root) {
    const parent = folder.slice(0, folder.lastIndexOf("/", folder.length - 2) + 1);
    links.push({ title: t("Parent folder"), page: itemId(settings, parent) });
  }
  for (const entry of await listFolder(settings, folder)) {
    const [path] = entry;
    if (path.endsWith("/")) children.push(entry);
    else if (audioType(path)) files.push(entry);
  }
  const [tracks, artwork] = await Promise.all([
    tracksWithMetadata(settings, files.slice(offset, offset + pageSize)),
    folderCovers(settings, children),
  ]);
  for (const [path, name] of children) {
    links.push({ title: name, page: itemId(settings, path), imageUrl: artwork.get(path) || blankFolderCover() });
  }
  return {
    title: folder === settings.root ? t("Music folders") : basename(folder),
    sections: [
      { title: t("Subfolders"), links, empty: t("No subfolders.") },
      { title: t("Tracks"), tracks, empty: t("No supported audio files in this folder.") },
      ...pageLinks(offset, files.length > offset + pageSize, n => `folder:${n}:${itemId(settings, folder)}`),
    ],
  };
}

async function catalogPage(settings, offset, terms) {
  const folders = [settings.root];
  const files = [];
  let matched = 0;
  const deadline = Date.now() + 17_000;
  for (let index = 0; index < folders.length;) {
    const timeout = Math.min(8_000, deadline - Date.now());
    if (timeout <= 0) throw fail(t("The music scan timed out. Try again or choose a smaller music folder."));
    if (index >= folderLimit) throw fail(t("The music scan covers up to 512 folders. Choose a smaller music folder."));
    const batch = folders.slice(index, Math.min(index + 6, folderLimit));
    index += batch.length;
    const listings = await Promise.all(batch.map(folder => listFolder(settings, folder, timeout)));
    for (const listing of listings) {
      for (const entry of listing) {
        const [path] = entry;
        if (path.endsWith("/")) {
          folders.push(path);
          continue;
        }
        if (!audioType(path)) continue;
        const relative = terms.length ? decodeURIComponent(path.slice(settings.root.length)).toLowerCase() : "";
        if (!terms.every(term => relative.includes(term))) continue;
        if (matched++ >= offset) files.push(entry);
        if (files.length > pageSize) return { files: files.slice(0, pageSize), more: true };
      }
    }
  }
  return { files, more: false };
}

async function allMusic(settings, offset) {
  const { files, more } = await catalogPage(settings, offset, []);
  return {
    title: t("All music"),
    subtitle: t("Page {number}").replace("{number}", String(offset / pageSize + 1)),
    sections: [
      // The app shows the first Home section as a card if it contains tracks.
      {},
      { title: t("Tracks"), tracks: await tracksWithMetadata(settings, files), empty: t("No supported audio files found.") },
      ...pageLinks(offset, more, n => `all:${n}`),
    ],
  };
}

export async function search({ query, kind, offset = 0 }) {
  if (kind !== "tracks") return { [kind]: [], more: false };
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return { tracks: [], more: false };

  const settings = config();
  const { files, more } = await catalogPage(settings, offset, terms);
  return { tracks: await tracksWithMetadata(settings, files), more };
}

export async function lyrics({ id }) {
  const settings = config();
  const path = readId(settings, id, false);
  if (!audioType(path)) return {};
  const stem = path.slice(0, path.lastIndexOf("."));
  const folder = path.slice(0, path.lastIndexOf("/") + 1);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6_000);
  const limit = 256 * 1024;
  async function loadLrc(urlPath) {
    const response = await fetch(settings.origin + urlPath, {
      headers: settings.headers, redirect: "error", signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return "";
    }
    const bytes = await readResponseBytes(response, limit + 1);
    return bytes.length <= limit ? normalizeLrc(bytes) : "";
  }
  try {
    const direct = stem + ".lrc";
    let lrc = await loadLrc(direct);
    if (!lrc && !controller.signal.aborted) {
      const listing = await listFolder(settings, folder, 4_000);
      const alternate = listing.find(([entry]) => entry !== direct && lyricType.test(entry) && entry.slice(0, -4) === stem);
      if (alternate) lrc = await loadLrc(alternate[0]);
    }
    return lrc ? { lrc } : {};
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}

function normalizeLrc(bytes) {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" :
    bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
  const text = new TextDecoder(encoding).decode(bytes).replace(/^\uFEFF/, "");
  // NetEase exports some credits as JSON lines before the timestamped lyrics.
  return text.split(/\r?\n/).map(line => {
    if (!line.trimStart().startsWith("{")) return line;
    try {
      const entry = JSON.parse(line);
      if (!Number.isSafeInteger(entry.t) || entry.t < 0 || !Array.isArray(entry.c)) return "";
      const credit = entry.c.map(part => typeof part?.tx === "string" ? part.tx : "").join("").trim();
      if (!credit) return "";
      const seconds = Math.floor(entry.t / 1000);
      const time = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}.${String(entry.t % 1000).padStart(3, "0")}`;
      return `[${time}]${credit}`;
    } catch {
      return "";
    }
  }).join("\n");
}

export function stream({ id }) {
  const settings = config();
  const path = readId(settings, id, false);
  const type = audioType(path);
  if (!type) throw fail(t("This audio format is unsupported."), "unavailable");
  return { url: settings.origin + path, type, headers: settings.headers };
}

const metadataCache = new Map();
const probeBytes = 16 * 1024;

async function readAudioRange(url, headers, signal, start, count) {
  const response = await fetch(url, {
    headers: { ...headers, Range: `bytes=${start}-${start + count - 1}` },
    redirect: "error",
    signal,
  });
  const range = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(response.headers.get("content-range") || "");
  const partial = response.status === 206 && range && Number(range[1]) === start;
  if (!partial && (response.status !== 200 || start !== 0)) {
    await response.body?.cancel();
    return null;
  }
  const size = Number(partial ? range[3] : response.headers.get("content-length"));
  return { bytes: await readResponseBytes(response, count), size };
}

async function readResponseBytes(response, count) {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  try {
    const bytes = new Uint8Array(count);
    let length = 0;
    while (length < count) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, count - length);
      bytes.set(chunk, length);
      length += chunk.length;
    }
    return bytes.subarray(0, length);
  } finally {
    try { await reader.cancel(); } catch { /* The request may already be closed. */ }
  }
}

function data(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function ascii(bytes, offset, text) {
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function uint64(view, offset, little = false) {
  const low = view.getUint32(offset + (little ? 0 : 4), little);
  const high = view.getUint32(offset + (little ? 4 : 0), little);
  return high * 0x100000000 + low;
}

function id3Length(bytes) {
  if (bytes.length < 10 || !ascii(bytes, 0, "ID3")) return 0;
  const size = (bytes[6] << 21) + (bytes[7] << 14) + (bytes[8] << 7) + bytes[9];
  return 10 + size + (bytes[3] === 4 && (bytes[5] & 0x10) ? 10 : 0);
}

function flacSeconds(bytes) {
  if (bytes.length < 42 || !ascii(bytes, 0, "fLaC") || (bytes[4] & 127) !== 0) return 0;
  const view = data(bytes);
  const info = view.getUint32(18);
  const samples = (info & 15) * 0x100000000 + view.getUint32(22);
  return samples / (info >>> 12);
}

async function wavSeconds(bytes, read) {
  if (!ascii(bytes, 0, "RIFF") || !ascii(bytes, 8, "WAVE")) return 0;
  let byteRate = 0;
  let audioBytes = 0;
  let offset = 12;
  for (let i = 0; i < 40; i++) {
    const chunk = await read(offset, 20);
    if (chunk.length < 8) break;
    const view = data(chunk);
    const length = view.getUint32(4, true);
    if (ascii(chunk, 0, "fmt ") && length >= 16 && chunk.length >= 20) byteRate = view.getUint32(16, true);
    if (ascii(chunk, 0, "data")) audioBytes = length;
    if (byteRate && audioBytes) return audioBytes / byteRate;
    offset += 8 + length + (length % 2);
  }
  return 0;
}

function mp3Frame(bytes, i) {
  if (bytes[i] !== 255 || (bytes[i + 1] & 0xe6) !== 0xe2) return null;
  const version = (bytes[i + 1] >> 3) & 3;
  const rateIndex = (bytes[i + 2] >> 2) & 3;
  const bitrateIndex = bytes[i + 2] >> 4;
  if (version === 1 || rateIndex === 3 || bitrateIndex === 0 || bitrateIndex === 15) return null;
  const mpeg1 = version === 3;
  const rate = [44100, 48000, 32000][rateIndex] / (mpeg1 ? 1 : version === 2 ? 2 : 4);
  const bitrates = mpeg1 ? [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] :
    [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const bitrate = bitrates[bitrateIndex - 1] * 1000;
  const samples = mpeg1 ? 1152 : 576;
  const length = Math.floor(samples * bitrate / (8 * rate)) + ((bytes[i + 2] >> 1) & 1);
  const mono = (bytes[i + 3] >> 6) === 3;
  const side = mpeg1 ? (mono ? 17 : 32) : (mono ? 9 : 17);
  return { rate, bitrate, samples, length, side };
}

function mp3Seconds(bytes, size) {
  const view = data(bytes);
  for (let i = 0; i + 48 < bytes.length; i++) {
    const frame = mp3Frame(bytes, i);
    if (!frame || mp3Frame(bytes, i + frame.length)?.rate !== frame.rate) continue;
    for (const marker of [i + 4 + frame.side, i + 6 + frame.side]) {
      if ((ascii(bytes, marker, "Xing") || ascii(bytes, marker, "Info")) && (view.getUint32(marker + 4) & 1)) {
        return view.getUint32(marker + 8) * frame.samples / frame.rate;
      }
    }
    if (i + 54 <= bytes.length && ascii(bytes, i + 36, "VBRI")) {
      return view.getUint32(i + 50) * frame.samples / frame.rate;
    }
    return (size - i) * 8 / frame.bitrate;
  }
  return 0;
}

function aacSeconds(bytes, size) {
  const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  let length = 0;
  let seconds = 0;
  let frames = 0;
  for (let i = 0; i + 7 <= bytes.length;) {
    const rate = rates[(bytes[i + 2] >> 2) & 15];
    const frameLength = ((bytes[i + 3] & 3) << 11) + (bytes[i + 4] << 3) + (bytes[i + 5] >> 5);
    if (bytes[i] !== 255 || (bytes[i + 1] & 0xf6) !== 0xf0 || !rate || frameLength < 7) break;
    if (i + frameLength > bytes.length) break;
    length += frameLength;
    seconds += 1024 * ((bytes[i + 6] & 3) + 1) / rate;
    frames++;
    i += frameLength;
  }
  return frames >= 2 ? seconds * size / length : 0;
}

async function mp4Seconds(size, read) {
  if (!(size > 0)) return 0;
  let offset = 0;
  let end = size;
  let inMovie = false;
  for (let i = 0; i < 48 && offset + 8 <= end; i++) {
    const box = await read(offset, 16);
    if (box.length < 8) break;
    const view = data(box);
    let length = view.getUint32(0);
    const header = length === 1 ? 16 : 8;
    if (box.length < header) break;
    if (length === 1) length = uint64(view, 8);
    if (length === 0) length = end - offset;
    if (length < header || length > end - offset) break;
    if (!inMovie && ascii(box, 4, "moov")) {
      inMovie = true;
      end = offset + length;
      offset += header;
      continue;
    }
    if (inMovie && ascii(box, 4, "mvhd")) {
      const body = await read(offset + header, Math.min(length - header, 32));
      const values = data(body);
      if (body[0] === 0 && body.length >= 20) return values.getUint32(16) / values.getUint32(12);
      if (body[0] === 1 && body.length >= 32) return uint64(values, 24) / values.getUint32(20);
      break;
    }
    offset += length;
  }
  return 0;
}

async function oggSeconds(bytes, size, read) {
  if (bytes.length < 28 || !ascii(bytes, 0, "OggS") || !(size > 0)) return 0;
  const packet = 27 + bytes[26];
  if (packet + 16 > bytes.length || bytes[packet] !== 1 || !ascii(bytes, packet + 1, "vorbis")) return 0;
  const rate = data(bytes).getUint32(packet + 12, true);
  const serial = data(bytes).getUint32(14, true);
  const tailSize = Math.min(size, 64 * 1024);
  const tail = await read(size - tailSize, tailSize);
  const view = data(tail);
  for (let i = tail.length - 27; i >= 0; i--) {
    if (!ascii(tail, i, "OggS") || tail[i + 4] !== 0 || !(tail[i + 5] & 4)) continue;
    if (view.getUint32(i + 14, true) === serial) return uint64(view, i + 6, true) / rate;
  }
  return 0;
}

async function probeMetadata(settings, path, signal) {
  const url = settings.origin + path;
  const head = await readAudioRange(url, settings.headers, signal, 0, probeBytes);
  if (!head) return {};

  let window = { start: 0, bytes: head.bytes };
  const read = async (start, count) => {
    if (head.size > 0) count = Math.min(count, head.size - start);
    if (count <= 0) return new Uint8Array();
    const offset = start - window.start;
    if (offset >= 0 && offset + count <= window.bytes.length) return window.bytes.subarray(offset, offset + count);
    if (start + count <= head.bytes.length) return head.bytes.subarray(start, start + count);
    const range = await readAudioRange(url, settings.headers, signal, start, Math.max(count, 2048));
    window = { start, bytes: range?.bytes ?? new Uint8Array() };
    return window.bytes.subarray(0, count);
  };

  const type = audioType(path);
  const tags = {};
  let seconds;
  if (type === "m4a") seconds = await mp4Seconds(head.size, read);
  else if (type === "wav") seconds = await wavSeconds(head.bytes, read);
  else if (type === "ogg") seconds = await oggSeconds(head.bytes, head.size, read);
  else {
    const start = id3Length(head.bytes);
    const bytes = start ? await read(start, probeBytes) : head.bytes;
    if (type === "flac") seconds = flacSeconds(bytes);
    if (type === "mp3") seconds = mp3Seconds(bytes, head.size - start);
    if (type === "aac") seconds = aacSeconds(bytes, head.size - start);
  }
  if (Number.isFinite(seconds) && seconds > 0 && seconds < 31536000) tags.duration = Math.round(seconds * 1000);

  try {
    const tagLength = id3Length(head.bytes);
    if (tagLength) id3Tags(await read(0, Math.min(tagLength, maxTagBytes)), tags);
    if (type === "flac") await flacTags(tagLength, read, tags);
    if (type === "m4a") await mp4Tags(head.size, read, tags);
    if (type === "ogg" && !oggTags(head.bytes, tags) && head.size > head.bytes.length) {
      oggTags(await read(0, Math.min(head.size, maxTagBytes)), tags);
    }
    if (type === "wav") wavTags(head.bytes, tags);
  } catch {
    // Duration and any tags already parsed remain usable.
  }
  return tags;
}

const sidecarCache = new Map();

async function cachePicture(bytes) {
  if (!bytes?.length || bytes.length > maxTagBytes) return;
  let child;
  try {
    const extension = host.platform === "windows" ? ".exe" : "";
    child = host.spawn(`bin/cover-${host.platform}-${host.arch}${extension}`, [host.dataDir]);
    child.write(encodeBase64(bytes));
    child.closeStdin();
    const path = await child.readLine();
    if (await child.wait() === 0 && path?.startsWith("file://")) return path;
  } catch {
    try { child?.kill(); } catch { /* It already stopped. */ }
  }
}

function sidecarPicture(settings, path, signal) {
  if (!path) return;
  const url = settings.origin + path;
  if (!settings.headers.Authorization) return url;
  const key = settings.library + ":" + path;
  if (!sidecarCache.has(key)) {
    const value = (async () => {
      try {
        const image = await readAudioRange(url, settings.headers, signal, 0, maxTagBytes + 1);
        if (image && image.bytes.length <= maxTagBytes) return await cachePicture(image.bytes);
      } catch {
        // A missing or inaccessible sidecar leaves the artwork blank.
      }
    })();
    sidecarCache.set(key, value);
    if (sidecarCache.size > 512) sidecarCache.delete(sidecarCache.keys().next().value);
    value.then(result => { if (!result && sidecarCache.get(key) === value) sidecarCache.delete(key); });
  }
  return sidecarCache.get(key);
}

async function metadataFor(settings, path, name, signal) {
  const tags = await probeMetadata(settings, path, signal).catch(() => ({}));
  const metadata = {
    name: tags.name,
    artist: tags.artist || tags.albumArtist,
    album: tags.album,
    duration: tags.duration,
  };
  metadata.cover = await cachePicture(tags.cover);
  metadata.artistPicture = await cachePicture(tags.artistPicture);
  if ((!metadata.cover || !metadata.artistPicture) && !signal.aborted) {
    const folder = path.slice(0, path.lastIndexOf("/") + 1);
    const { named } = coversIn(await listFolder(settings, folder));
    const stem = name.replace(/\.[^.]+$/, "").toLowerCase();
    metadata.cover ||= await sidecarPicture(settings, named([stem, "cover", "folder", "front", "album", "artwork"]), signal);
    metadata.artistPicture ||= await sidecarPicture(settings, named(["artist", "performer", "band"]), signal);
  }
  metadata.cover ||= metadata.artistPicture;
  return metadata;
}

const folderCoverCache = new Map();

function blankFolderCover() {
  const path = host.dir.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");
  return `file://${path.startsWith("/") ? "" : "/"}${path}/assets/blank.png`;
}

function cachedMetadata(settings, path) {
  const cached = metadataCache.get(itemId(settings, path));
  if (cached?.until > Date.now()) return cached.metadata;
}

async function readMetadata(settings, entry, signal) {
  const [path, name] = entry;
  const cached = cachedMetadata(settings, path);
  if (cached || signal.aborted) return cached;
  try {
    const metadata = await metadataFor(settings, path, name, signal);
    if (!signal.aborted) {
      metadataCache.set(itemId(settings, path), { metadata, until: Date.now() + 600_000 });
      if (metadataCache.size > 4096) metadataCache.delete(metadataCache.keys().next().value);
    }
    return metadata;
  } catch {
    // Metadata is optional. The track stays playable if probing fails.
  }
}

function folderCover(settings, path, signal) {
  const key = itemId(settings, path);
  const cached = folderCoverCache.get(key);
  if (cached?.until > Date.now()) return cached.result;

  const result = (async () => {
    const listing = await listFolder(settings, path, 4_000);
    const files = listing.filter(([file]) => audioType(file) && !file.endsWith("/"));
    for (const [file] of files) {
      const cover = cachedMetadata(settings, file)?.cover;
      if (cover) return cover;
    }
    for (const entry of files) {
      if (signal.aborted) return;
      const meta = await readMetadata(settings, entry, signal);
      if (meta?.cover) return meta.cover;
    }
  })().catch(() => undefined);
  const item = { result, until: Date.now() + cacheLifetime };
  folderCoverCache.set(key, item);
  if (folderCoverCache.size > folderLimit) folderCoverCache.delete(folderCoverCache.keys().next().value);
  result.then(cover => {
    if (!cover && folderCoverCache.get(key) === item) folderCoverCache.delete(key);
  });
  return result;
}

async function folderCovers(settings, folders) {
  const artwork = new Map();
  if (!folders.length) return artwork;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  let next = 0;
  async function worker() {
    while (!controller.signal.aborted && next < folders.length) {
      const [path] = folders[next++];
      const cover = await folderCover(settings, path, controller.signal);
      if (cover) artwork.set(path, cover);
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(folders.length, 4) }, worker));
    return artwork;
  } finally {
    clearTimeout(timer);
  }
}

async function tracksWithMetadata(settings, files) {
  const tracks = files.map(([path, name]) => track(settings, path, name));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  let next = 0;
  async function worker() {
    while (next < files.length) {
      const index = next++;
      const result = tracks[index];
      const meta = await readMetadata(settings, files[index], controller.signal);
      if (!meta) continue;
      if (meta.name) result.name = meta.name;
      if (meta.duration) result.duration = meta.duration;
      if (meta.artist) result.artists = [{
        id: result.id,
        name: meta.artist,
        imageUrl: meta.artistPicture,
      }];
      if (meta.album || meta.cover) result.album = { name: meta.album || "", imageUrl: meta.cover };
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(files.length, 8) }, worker));
    return tracks;
  } finally {
    clearTimeout(timer);
  }
}

const maxTagBytes = 1024 * 1024;
const utf8 = new TextDecoder();

function textTag(bytes, encoding = 3) {
  const utf16 = bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-16le";
  const label = ["windows-1252", utf16, "utf-16be", "utf-8"][encoding] || "utf-8";
  try {
    return new TextDecoder(label).decode(bytes).replace(/\0/g, " / ").replace(/(?:\s*\/\s*)+$/, "").trim();
  } catch {
    // Some MyGo runtimes expose only a subset of TextDecoder encodings.
    if (encoding === 0) return Array.from(bytes, byte => String.fromCharCode(byte)).join("").replace(/\0/g, " ").trim();
    if (encoding === 1 || encoding === 2) {
      const big = encoding === 2 || (bytes[0] === 0xfe && bytes[1] === 0xff);
      const bom = (bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0xff && bytes[1] === 0xfe);
      const view = data(bytes);
      let value = "";
      for (let offset = bom ? 2 : 0; offset + 1 < bytes.length; offset += 2) {
        const code = view.getUint16(offset, !big);
        if (code) value += String.fromCharCode(code);
      }
      return value.trim();
    }
    return "";
  }
}

function picture(tags, type, bytes) {
  if (!bytes.length || bytes.length > maxTagBytes) return;
  if (type === 8) tags.artistPicture ||= bytes;
  else if (type === 3 || type === 0) {
    if (!tags.cover || type === 3) tags.cover = bytes;
  }
}

function id3Tags(bytes, tags) {
  if (bytes.length < 10 || !ascii(bytes, 0, "ID3")) return;
  const version = bytes[3];
  if (version < 2 || version > 4) return;
  const syncSize = (at, b) => (b[at] << 21) + (b[at + 1] << 14) + (b[at + 2] << 7) + b[at + 3];
  const names = { TT2: "name", TIT2: "name", TP1: "artist", TPE1: "artist", TAL: "album", TALB: "album" };
  let frames = bytes.subarray(10, Math.min(bytes.length, 10 + syncSize(6, bytes)));
  if ((bytes[5] & 128) && version < 4) frames = frames.filter((byte, i) => byte !== 0 || frames[i - 1] !== 255);
  const view = data(frames);
  let at = 0;
  if (version > 2 && (bytes[5] & 64)) {
    if (frames.length < 4) return;
    at = version === 4 ? syncSize(0, frames) : 4 + view.getUint32(0);
  }
  const header = version === 2 ? 6 : 10;
  const idLength = version === 2 ? 3 : 4;
  while (at + header <= frames.length) {
    const key = utf8.decode(frames.subarray(at, at + idLength));
    if (!/^[A-Z0-9]+$/.test(key)) break;
    const size = version === 2 ? view.getUint32(at + 2) & 0xffffff :
      version === 4 ? syncSize(at + 4, frames) : view.getUint32(at + 4);
    const flags = version === 2 ? 0 : frames[at + 9];
    const end = at + header + size;
    if (end > frames.length) break;
    let value = frames.subarray(at + header, end);
    at = end;
    if (!size || (version === 3 && (flags & 224)) || (version === 4 && (flags & 77))) continue;
    if (version === 4 && (flags & 2)) value = value.filter((byte, i) => byte !== 0 || value[i - 1] !== 255);
    const encoding = value[0];
    if (names[key]) tags[names[key]] ||= textTag(value.subarray(1), encoding);
    if (key !== "APIC" && key !== "PIC") continue;
    const kindAt = key === "PIC" ? 4 : value.indexOf(0, 1) + 1;
    if (kindAt <= 1 || kindAt + 1 >= value.length) continue;
    const step = encoding === 1 || encoding === 2 ? 2 : 1;
    let start = kindAt + 1;
    while (start + step <= value.length && (value[start] || (step === 2 && value[start + 1]))) start += step;
    picture(tags, value[kindAt], value.subarray(start + step));
  }
}

function vorbisTags(bytes, tags) {
  if (bytes.length < 8) return;
  const view = data(bytes);
  let at = 4 + view.getUint32(0, true);
  if (at + 4 > bytes.length) return;
  const count = view.getUint32(at, true);
  at += 4;
  const names = { TITLE: "name", ARTIST: "artist", ALBUM: "album" };
  for (let i = 0; i < count && at + 4 <= bytes.length; i++) {
    const length = view.getUint32(at, true);
    at += 4;
    if (at + length > bytes.length) break;
    const field = bytes.subarray(at, at + length);
    at += length;
    const equals = field.indexOf(61);
    if (equals < 0) continue;
    const key = utf8.decode(field.subarray(0, equals)).toUpperCase();
    if (names[key]) tags[names[key]] ||= textTag(field.subarray(equals + 1));
    if (key === "METADATA_BLOCK_PICTURE" && field.length <= maxTagBytes) {
      try {
        const raw = atob(utf8.decode(field.subarray(equals + 1)));
        flacPicture(Uint8Array.from(raw, char => char.charCodeAt(0)), tags);
      } catch {
        // A malformed picture leaves the text tags usable.
      }
    }
  }
}

function flacPicture(bytes, tags) {
  if (bytes.length < 32) return;
  const view = data(bytes);
  const description = 8 + view.getUint32(4);
  if (description + 24 > bytes.length) return;
  const payload = description + 24 + view.getUint32(description);
  if (payload > bytes.length) return;
  const size = view.getUint32(payload - 4);
  if (size <= bytes.length - payload) picture(tags, view.getUint32(0), bytes.subarray(payload, payload + size));
}

async function flacTags(start, read, tags) {
  let at = start + 4;
  for (let block = 0; block < 32; block++) {
    const header = await read(at, 4);
    if (header.length !== 4) return;
    const type = header[0] & 127;
    const size = (header[1] << 16) + (header[2] << 8) + header[3];
    if ((type === 4 || type === 6) && size <= maxTagBytes) {
      const bytes = await read(at + 4, size);
      if (type === 4) vorbisTags(bytes, tags);
      if (type === 6) flacPicture(bytes, tags);
    }
    if (header[0] & 128) return;
    at += 4 + size;
  }
}

function oggTags(bytes, tags) {
  let at = 0;
  let packet = [];
  while (at + 27 <= bytes.length && ascii(bytes, at, "OggS")) {
    const count = bytes[at + 26];
    let payload = at + 27 + count;
    if (payload > bytes.length) return;
    for (let i = 0; i < count; i++) {
      const size = bytes[at + 27 + i];
      if (payload + size > bytes.length) return;
      packet.push(bytes.subarray(payload, payload + size));
      payload += size;
      if (size === 255) continue;
      if (packet[0][0] === 3 && ascii(packet[0], 1, "vorbis")) {
        const joined = new Uint8Array(packet.reduce((total, part) => total + part.length, 0));
        let offset = 0;
        for (const part of packet) {
          joined.set(part, offset);
          offset += part.length;
        }
        vorbisTags(joined.subarray(7), tags);
        return true;
      }
      packet = [];
    }
    at = payload;
  }
}

async function mp4Box(start, end, read, predicate) {
  for (let i = 0; i < 128 && start + 8 <= end; i++) {
    const head = await read(start, 16);
    if (head.length < 8) return;
    const view = data(head);
    let size = view.getUint32(0);
    const header = size === 1 ? 16 : 8;
    if (head.length < header) return;
    if (size === 1) size = uint64(view, 8);
    if (size === 0) size = end - start;
    if (size < header || size > end - start) return;
    const type = String.fromCharCode(...head.subarray(4, 8));
    const box = { type, start: start + header, end: start + size };
    if (predicate(box)) return box;
    start += size;
  }
}

async function mp4Tags(size, read, tags) {
  const moov = await mp4Box(0, size, read, box => box.type === "moov");
  if (!moov) return;
  const udta = await mp4Box(moov.start, moov.end, read, box => box.type === "udta");
  const parent = udta || moov;
  const meta = await mp4Box(parent.start, parent.end, read, box => box.type === "meta");
  if (!meta) return;
  const ilst = await mp4Box(meta.start + 4, meta.end, read, box => box.type === "ilst");
  if (!ilst) return;
  const names = { "©nam": "name", "©ART": "artist", "©alb": "album", aART: "albumArtist", covr: "cover" };
  let at = ilst.start;
  for (let i = 0; i < 20; i++) {
    const field = await mp4Box(at, ilst.end, read, box => !!names[box.type]);
    if (!field) return;
    at = field.end;
    const value = await mp4Box(field.start, field.end, read, box => box.type === "data");
    if (!value) continue;
    const length = value.end - value.start - 8;
    if (length <= 0 || length > maxTagBytes) continue;
    const bytes = await read(value.start + 8, length);
    if (field.type === "covr") picture(tags, 3, bytes);
    else tags[names[field.type]] ||= textTag(bytes);
  }
}

function wavTags(bytes, tags) {
  const names = { INAM: "name", IART: "artist", IPRD: "album" };
  if (bytes.length < 12 || !ascii(bytes, 0, "RIFF")) return;
  const view = data(bytes);
  for (let at = 12; at + 8 <= bytes.length;) {
    const length = view.getUint32(at + 4, true);
    const end = at + 8 + length;
    if (end > bytes.length) return;
    if (ascii(bytes, at, "id3 ") || ascii(bytes, at, "ID3 ")) id3Tags(bytes.subarray(at + 8, end), tags);
    if (ascii(bytes, at, "LIST") && ascii(bytes, at + 8, "INFO")) {
      for (let field = at + 12; field + 8 <= end;) {
        const size = view.getUint32(field + 4, true);
        if (field + 8 + size > end) break;
        const name = names[utf8.decode(bytes.subarray(field, field + 4))];
        if (name) tags[name] ||= textTag(bytes.subarray(field + 8, field + 8 + size));
        field += 8 + size + (size % 2);
      }
    }
    at = end + (length % 2);
  }
}
