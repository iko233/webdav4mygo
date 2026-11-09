const t = host.t;
const folderCache = new Map();
const cacheLifetime = 120_000;
const folderLimit = 512;
const searchPageSize = 50;
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

export async function browse({ page }) {
  const settings = config();
  const folder = page === "root" ? settings.root : readId(settings, page, true);
  const links = [];
  const tracks = [];
  if (folder !== settings.root) {
    const parent = folder.slice(0, folder.lastIndexOf("/", folder.length - 2) + 1);
    links.push({ title: t("Parent folder"), page: itemId(settings, parent) });
  }
  for (const [path, name] of await listFolder(settings, folder)) {
    if (path.endsWith("/")) links.push({ title: name, page: itemId(settings, path) });
    else tracks.push(track(settings, path, name));
  }
  return {
    title: folder === settings.root ? t("Music folders") : basename(folder),
    sections: [
      ...(links.length ? [{ title: t("Folders"), links }] : []),
      { title: t("Tracks"), tracks, empty: t("No supported audio files in this folder.") },
    ],
  };
}

export async function search({ query, kind, offset = 0 }) {
  if (kind !== "tracks") return { [kind]: [], more: false };
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return { tracks: [], more: false };

  const settings = config();
  const folders = [settings.root];
  const matches = [];
  const deadline = Date.now() + 22_000;
  for (let index = 0; index < folders.length;) {
    const timeout = Math.min(8_000, deadline - Date.now());
    if (timeout <= 0) throw fail(t("Search timed out. Try again or choose a smaller WebDAV music folder."));
    const batch = folders.slice(index, index + 6);
    index += batch.length;
    const listings = await Promise.all(batch.map(folder => listFolder(settings, folder, timeout)));
    for (const listing of listings) {
      for (const [path, name] of listing) {
        if (path.endsWith("/")) {
          folders.push(path);
        } else {
          const relative = decodeURIComponent(path.slice(settings.root.length)).toLowerCase();
          if (terms.every(term => relative.includes(term))) matches.push(track(settings, path, name));
        }
      }
    }
    if (matches.length > offset + searchPageSize) break;
    if (folders.length > folderLimit) {
      throw fail(t("Search covers up to 512 folders. Choose a smaller WebDAV music folder."));
    }
  }
  return { tracks: matches.slice(offset, offset + searchPageSize), more: matches.length > offset + searchPageSize };
}

export function stream({ id }) {
  const settings = config();
  const path = readId(settings, id, false);
  const type = audioType(path);
  if (!type) throw fail(t("This audio format is unsupported."), "unavailable");
  return { url: settings.origin + path, type, headers: settings.headers };
}
