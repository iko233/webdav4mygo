const t = host.t;
const folderCache = new Map();
const cacheLifetime = 120_000;
const folderLimit = 512;
const pageSize = 50;
const audioTypes = new Set(["mp3", "flac", "wav", "m4a", "aac", "ogg"]);
const propfind = '<propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>';

function fail(message, code) {
  const error = new Error(message);
  if (code) error.code = code;
  return error;
}

function base64(text) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes = new TextEncoder().encode(text);
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
      if (path && (path.endsWith("/") || audioType(path))) entries.set(path, basename(path));
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
  durationCache.clear();
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
  const files = [];
  if (folder !== settings.root) {
    const parent = folder.slice(0, folder.lastIndexOf("/", folder.length - 2) + 1);
    links.push({ title: t("Parent folder"), page: itemId(settings, parent) });
  }
  for (const entry of await listFolder(settings, folder)) {
    const [path, name] = entry;
    if (path.endsWith("/")) links.push({ title: name, page: itemId(settings, path) });
    else files.push(entry);
  }
  const tracks = await tracksWithDuration(settings, files.slice(offset, offset + pageSize));
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
      { links: [{ title: t("Music folders"), page: "root" }] },
      { title: t("Tracks"), tracks: await tracksWithDuration(settings, files), empty: t("No supported audio files found.") },
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
  return { tracks: await tracksWithDuration(settings, files), more };
}

export function stream({ id }) {
  const settings = config();
  const path = readId(settings, id, false);
  const type = audioType(path);
  if (!type) throw fail(t("This audio format is unsupported."), "unavailable");
  return { url: settings.origin + path, type, headers: settings.headers };
}

const durationCache = new Map();
const probeBytes = 16 * 1024;

async function readAudioRange(url, headers, signal, start, count) {
  const response = await fetch(url, {
    headers: { ...headers, Range: `bytes=${start}-${start + count - 1}` },
    redirect: "error",
    signal,
  });
  const reader = response.body?.getReader();
  if (!reader) return null;

  try {
    const range = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(response.headers.get("content-range") || "");
    const partial = response.status === 206 && range && Number(range[1]) === start;
    if (!partial && (response.status !== 200 || start !== 0)) return null;
    const size = Number(partial ? range[3] : response.headers.get("content-length"));
    const bytes = new Uint8Array(count);
    let length = 0;
    while (length < count) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, count - length);
      bytes.set(chunk, length);
      length += chunk.length;
    }
    return { bytes: bytes.subarray(0, length), size };
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

async function probeDuration(settings, path, signal) {
  const url = settings.origin + path;
  const head = await readAudioRange(url, settings.headers, signal, 0, probeBytes);
  if (!head) return 0;

  let window = { start: 0, bytes: head.bytes };
  const read = async (start, count) => {
    if (head.size > 0) count = Math.min(count, head.size - start);
    if (count <= 0) return new Uint8Array();
    const offset = start - window.start;
    if (offset >= 0 && offset + count <= window.bytes.length) return window.bytes.subarray(offset, offset + count);
    const range = await readAudioRange(url, settings.headers, signal, start, Math.max(count, 2048));
    window = { start, bytes: range?.bytes ?? new Uint8Array() };
    return window.bytes.subarray(0, count);
  };

  const type = audioType(path);
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
  return Number.isFinite(seconds) && seconds > 0 && seconds < 31536000 ? Math.round(seconds * 1000) : 0;
}

async function tracksWithDuration(settings, files) {
  const tracks = files.map(([path, name]) => track(settings, path, name));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6_000);
  let next = 0;
  async function worker() {
    while (!controller.signal.aborted && next < files.length) {
      const index = next++;
      const key = tracks[index].id;
      const cached = durationCache.get(key);
      let duration = cached?.until > Date.now() ? cached.duration : undefined;
      if (duration === undefined) {
        try {
          duration = await probeDuration(settings, files[index][0], controller.signal);
          durationCache.set(key, { duration, until: Date.now() + (duration ? 600_000 : 120_000) });
          if (durationCache.size > 4096) durationCache.delete(durationCache.keys().next().value);
        } catch {
          // Metadata is optional. The track stays playable if probing fails.
        }
      }
      if (duration) tracks[index].duration = duration;
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(files.length, 8) }, worker));
    return tracks;
  } finally {
    clearTimeout(timer);
  }
}
