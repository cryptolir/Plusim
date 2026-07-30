/**
 * Google Drive integration (admin transcripts feature).
 *
 * OAuth 2.0 as the OWNER (one-time admin connect → refresh token stored
 * encrypted in AppSetting). Full `drive` scope so we can browse a pre-existing
 * shared folder AND write summaries into it. All Drive calls go through the
 * owner's access token (auto-refreshed). See docs/DRIVE_INTEGRATION.md.
 *
 * SECURITY: the owner token can reach the owner's entire Drive, so every
 * caller-supplied id is checked with assertEntryUnderRoot() before any
 * read/write. Routes never trust a raw fileId/folderId.
 */
import { OAuth2Client } from "google-auth-library";
import { db } from "@/lib/db";
import { decryptJson, encryptJson } from "@/lib/driveCrypto";
import { TOKEN_REFRESH_TIMEOUT_MS } from "@/lib/chatTimeouts";

/**
 * Reject `p` if it doesn't settle within `ms`. Guarantees the returned promise
 * always settles, so a caller can never be pinned by a hung upstream call.
 * Exported for tests.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(id);
        resolve(v);
      },
      (e) => {
        clearTimeout(id);
        reject(e);
      },
    );
  });
}

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_OAUTH_REDIRECT_URI;

export const DRIVE_ROOT_FOLDER_ID = process.env.PLUSIM_DRIVE_ROOT_FOLDER_ID ?? "";
export const DRIVE_SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
];

const DRIVE_AUTH_KEY = "drive_oauth";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FIELDS = "id,name,mimeType,createdTime,modifiedTime,parents,appProperties";

export class DriveNotConnectedError extends Error {}
export class DriveOutsideRootError extends Error {}
export class UnsupportedTranscriptTypeError extends Error {}

export interface DriveEntry {
  id: string;
  name: string;
  mimeType: string;
  isFolder: boolean;
  createdTime: string;
  modifiedTime: string;
  parents?: string[];
  appProperties?: Record<string, string>;
}

interface DriveApiFile {
  id: string;
  name: string;
  mimeType: string;
  createdTime?: string;
  modifiedTime?: string;
  parents?: string[];
  appProperties?: Record<string, string>;
}

interface DriveAuthBlob {
  refreshToken: string;
  scope: string;
  connectedEmail?: string;
  connectedAt: string;
}

function oauthClient(): OAuth2Client {
  if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
    throw new Error("Google OAuth env not configured (GOOGLE_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI)");
  }
  return new OAuth2Client({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI });
}

// --------------------------------------------------------------------------
// Connect / token store
// --------------------------------------------------------------------------

export function buildConsentUrl(state: string): string {
  return oauthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // always return a refresh_token, even on re-connect
    scope: DRIVE_SCOPES,
    include_granted_scopes: true,
    state,
  });
}

function emailFromIdToken(idToken: string | null | undefined): string | undefined {
  if (!idToken) return undefined;
  try {
    const part = idToken.split(".")[1];
    const payload = JSON.parse(Buffer.from(part, "base64").toString("utf8")) as { email?: string };
    return payload.email;
  } catch {
    return undefined;
  }
}

/** Exchange the OAuth code for tokens and persist the (encrypted) refresh token. */
export async function exchangeCodeAndStore(code: string): Promise<{ email?: string }> {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      "Google returned no refresh_token. Ensure access_type=offline + prompt=consent, or revoke the prior grant and reconnect.",
    );
  }
  const email = emailFromIdToken(tokens.id_token);
  await saveDriveAuth({
    refreshToken: tokens.refresh_token,
    scope: tokens.scope ?? DRIVE_SCOPES.join(" "),
    connectedEmail: email,
    connectedAt: new Date().toISOString(),
  });
  return { email };
}

async function saveDriveAuth(blob: DriveAuthBlob): Promise<void> {
  const value = encryptJson(blob);
  await db.appSetting.upsert({
    where: { key: DRIVE_AUTH_KEY },
    update: { value },
    create: { key: DRIVE_AUTH_KEY, value },
  });
  accessCache = null;
}

async function loadDriveAuth(): Promise<DriveAuthBlob | null> {
  const row = await db.appSetting.findUnique({ where: { key: DRIVE_AUTH_KEY } });
  if (!row) return null;
  try {
    return decryptJson<DriveAuthBlob>(row.value);
  } catch {
    return null;
  }
}

export async function clearDriveAuth(): Promise<void> {
  await db.appSetting.deleteMany({ where: { key: DRIVE_AUTH_KEY } });
  accessCache = null;
}

export async function isDriveConnected(): Promise<boolean> {
  return (await loadDriveAuth()) !== null;
}

export async function getConnectedEmail(): Promise<string | null> {
  return (await loadDriveAuth())?.connectedEmail ?? null;
}

// --------------------------------------------------------------------------
// Access token (cached, auto-refreshed)
// --------------------------------------------------------------------------

let accessCache: { token: string; exp: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (accessCache && Date.now() < accessCache.exp - 60_000) return accessCache.token;
  const auth = await loadDriveAuth();
  if (!auth) throw new DriveNotConnectedError("Google Drive not connected");
  const client = oauthClient();
  client.setCredentials({ refresh_token: auth.refreshToken });
  try {
    // Hard-bound the refresh so this promise ALWAYS settles. google-auth-library
    // does not time out getAccessToken(), so a hung Google token endpoint would
    // otherwise block every Drive caller (chat, admin, reports) unbounded until
    // the process restarts. On timeout we reject; callers degrade gracefully.
    const res = await withTimeout(
      client.getAccessToken(),
      TOKEN_REFRESH_TIMEOUT_MS,
      "getAccessToken timed out",
    );
    if (!res.token) throw new Error("no access token returned");
    accessCache = { token: res.token, exp: client.credentials.expiry_date ?? Date.now() + 50 * 60_000 };
    return res.token;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("invalid_grant")) {
      await clearDriveAuth();
      throw new DriveNotConnectedError("Google Drive token expired or revoked — reconnect");
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Write throttle: Drive tolerates ~3 writes/s per user. driveFetch is the single
// choke point every helper routes through, so gating non-GET here covers every
// mutation, present and future, by construction (invariant I6). The method is
// NORMALIZED first — most read calls pass no init at all, and a literal non-GET
// check would throttle listChildren/getEntry/downloads (F13). In-process is
// sufficient while every Drive write lives in this single-replica web app; move
// to a Postgres-backed bucket the day any second process writes to Drive.
// ---------------------------------------------------------------------------
const DRIVE_WRITES_PER_SEC = 3;
const DRIVE_WRITE_BURST = 3;
let driveWriteTokens = DRIVE_WRITE_BURST;
let driveWriteLastRefill = Date.now();

/** Take one write token, waiting for a refill when the bucket is dry. Exported for tests. */
export async function takeDriveWriteToken(): Promise<void> {
  for (;;) {
    const now = Date.now();
    driveWriteTokens = Math.min(
      DRIVE_WRITE_BURST,
      driveWriteTokens + ((now - driveWriteLastRefill) / 1000) * DRIVE_WRITES_PER_SEC,
    );
    driveWriteLastRefill = now;
    if (driveWriteTokens >= 1) {
      driveWriteTokens -= 1;
      return;
    }
    const waitMs = Math.ceil(((1 - driveWriteTokens) / DRIVE_WRITES_PER_SEC) * 1000);
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

/** Refill the bucket to full. Exported for tests only. */
export function resetDriveWriteBucketForTests(): void {
  driveWriteTokens = DRIVE_WRITE_BURST;
  driveWriteLastRefill = Date.now();
}

/** null → no throttle (a read); otherwise the pending bucket take. Exported for tests. */
export function driveWriteGate(init?: RequestInit): Promise<void> | null {
  const method = (init?.method ?? "GET").toUpperCase();
  return method === "GET" ? null : takeDriveWriteToken();
}

async function driveFetch(url: string, init?: RequestInit): Promise<Response> {
  // Token FIRST, gate second (F29). Taking the gate before awaiting an OAuth
  // refresh lets the bucket refill during that wait, so calls admitted while a
  // cold/expired token refreshes (e.g. concurrent trashFile under
  // Promise.allSettled) all reach fetch together and blow past ~3 writes/s.
  // Held immediately before the request, the gate paces actual Drive traffic.
  const token = await getAccessToken();
  await driveWriteGate(init);
  return fetch(url, {
    ...init,
    headers: { ...(init?.headers ?? {}), authorization: `Bearer ${token}` },
    cache: "no-store",
  });
}

function toEntry(f: DriveApiFile): DriveEntry {
  return {
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    isFolder: f.mimeType === FOLDER_MIME,
    createdTime: f.createdTime ?? "",
    modifiedTime: f.modifiedTime ?? "",
    parents: f.parents,
    appProperties: f.appProperties,
  };
}

// --------------------------------------------------------------------------
// Drive REST helpers
// --------------------------------------------------------------------------

export async function listChildren(folderId: string): Promise<DriveEntry[]> {
  const out: DriveEntry[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed=false`,
      fields: `nextPageToken,files(${FIELDS})`,
      orderBy: "folder,name",
      pageSize: "200",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await driveFetch(`${DRIVE_API}/files?${params.toString()}`);
    if (!res.ok) throw new Error(`drive list ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { files?: DriveApiFile[]; nextPageToken?: string };
    for (const f of data.files ?? []) out.push(toEntry(f));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return out;
}

export async function getEntry(id: string): Promise<DriveEntry> {
  const params = new URLSearchParams({ fields: FIELDS, supportsAllDrives: "true" });
  const res = await driveFetch(`${DRIVE_API}/files/${encodeURIComponent(id)}?${params.toString()}`);
  if (!res.ok) throw new Error(`drive get ${res.status}: ${await res.text()}`);
  return toEntry((await res.json()) as DriveApiFile);
}

export async function getFileText(entry: DriveEntry, signal?: AbortSignal): Promise<string> {
  let url: string;
  if (entry.mimeType === GOOGLE_DOC_MIME) {
    url = `${DRIVE_API}/files/${encodeURIComponent(entry.id)}/export?mimeType=text/plain&supportsAllDrives=true`;
  } else if (entry.mimeType.startsWith("text/")) {
    url = `${DRIVE_API}/files/${encodeURIComponent(entry.id)}?alt=media&supportsAllDrives=true`;
  } else {
    throw new UnsupportedTranscriptTypeError(`Unsupported transcript type: ${entry.mimeType}`);
  }
  const res = await driveFetch(url, signal ? { signal } : undefined);
  if (!res.ok) throw new Error(`drive read ${res.status}: ${await res.text()}`);
  return res.text();
}

export async function createTextFile(opts: {
  parentFolderId: string;
  name: string;
  text: string;
  appProperties?: Record<string, string>;
}): Promise<DriveEntry> {
  const metadata = {
    name: opts.name,
    parents: [opts.parentFolderId],
    mimeType: "text/plain",
    ...(opts.appProperties ? { appProperties: opts.appProperties } : {}),
  };
  const boundary = `plusim_${crypto.randomUUID()}`;
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: text/plain; charset=UTF-8\r\n\r\n` +
    `${opts.text}\r\n` +
    `--${boundary}--`;
  const params = new URLSearchParams({ uploadType: "multipart", fields: FIELDS, supportsAllDrives: "true" });
  const res = await driveFetch(`${DRIVE_UPLOAD}/files?${params.toString()}`, {
    method: "POST",
    headers: { "content-type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error(`drive create ${res.status}: ${await res.text()}`);
  return toEntry((await res.json()) as DriveApiFile);
}

/**
 * Upload an xlsx and let Drive convert it into a native Google Spreadsheet
 * (target mimeType application/vnd.google-apps.spreadsheet). Used by the
 * reports pipeline on publish; tagged with appProperties for idempotency.
 * Returns the created entry — webViewLink is fetched separately by callers
 * that need it (FIELDS here excludes it).
 */
export async function uploadXlsxAsSpreadsheet(opts: {
  parentFolderId: string;
  name: string;
  xlsx: Buffer;
  appProperties?: Record<string, string>;
}): Promise<DriveEntry> {
  const metadata = {
    name: opts.name,
    parents: [opts.parentFolderId],
    mimeType: "application/vnd.google-apps.spreadsheet",
    ...(opts.appProperties ? { appProperties: opts.appProperties } : {}),
  };
  const boundary = `plusim_${crypto.randomUUID()}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n` +
      `Content-Transfer-Encoding: base64\r\n\r\n`,
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--`, "utf8");
  const body = Buffer.concat([head, Buffer.from(opts.xlsx.toString("base64"), "utf8"), tail]);
  const params = new URLSearchParams({ uploadType: "multipart", fields: FIELDS, supportsAllDrives: "true" });
  const res = await driveFetch(`${DRIVE_UPLOAD}/files?${params.toString()}`, {
    method: "POST",
    headers: { "content-type": `multipart/related; boundary=${boundary}` },
    body: new Uint8Array(body),
  });
  if (!res.ok) throw new Error(`drive xlsx→sheet upload ${res.status}: ${await res.text()}`);
  return toEntry((await res.json()) as DriveApiFile);
}

/**
 * Replace an EXISTING native Google Spreadsheet's content with a new xlsx
 * (media PATCH; Drive re-converts in place, the file id and mimeType survive).
 * Used by report re-publish so the client's bookmarked Sheet link keeps working
 * and shows the current workbook instead of the first run's.
 * Callers must contain the id first — assertEntryUnderRoot(folder) AND
 * assertEntryUnderFolder(fileId, folder); this helper trusts neither.
 */
export async function updateXlsxSpreadsheet(opts: { fileId: string; xlsx: Buffer }): Promise<DriveEntry> {
  const params = new URLSearchParams({ uploadType: "media", fields: FIELDS, supportsAllDrives: "true" });
  const res = await driveFetch(`${DRIVE_UPLOAD}/files/${encodeURIComponent(opts.fileId)}?${params.toString()}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
    body: new Uint8Array(opts.xlsx),
  });
  if (!res.ok) throw new Error(`drive sheet update ${res.status}: ${await res.text()}`);
  return toEntry((await res.json()) as DriveApiFile);
}

/**
 * Upload a raw binary file (statement pdf/xlsx) into a Drive folder, preserving
 * the ORIGINAL mime — no Google-Docs conversion. Used by the reports upload flow
 * to store raw statements in the client's folder. Tagged with appProperties.
 */
export async function uploadBinaryFile(opts: {
  parentFolderId: string;
  name: string;
  mime: string;
  bytes: Buffer;
  appProperties?: Record<string, string>;
}): Promise<DriveEntry> {
  const metadata = {
    name: opts.name,
    parents: [opts.parentFolderId],
    mimeType: opts.mime,
    ...(opts.appProperties ? { appProperties: opts.appProperties } : {}),
  };
  const boundary = `plusim_${crypto.randomUUID()}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${opts.mime}\r\n` +
      `Content-Transfer-Encoding: base64\r\n\r\n`,
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--`, "utf8");
  const body = Buffer.concat([head, Buffer.from(opts.bytes.toString("base64"), "utf8"), tail]);
  const params = new URLSearchParams({ uploadType: "multipart", fields: FIELDS, supportsAllDrives: "true" });
  const res = await driveFetch(`${DRIVE_UPLOAD}/files?${params.toString()}`, {
    method: "POST",
    headers: { "content-type": `multipart/related; boundary=${boundary}` },
    body: new Uint8Array(body),
  });
  if (!res.ok) throw new Error(`drive binary upload ${res.status}: ${await res.text()}`);
  return toEntry((await res.json()) as DriveApiFile);
}

/**
 * Download raw bytes of a Drive file (alt=media). Google-Docs-native types have
 * no direct media and are rejected — statements are only ever pdf/xlsx binaries.
 * Callers must contain the id first (assertEntryUnderRoot / assertEntryUnderFolder).
 */
export async function getFileBytes(entry: DriveEntry): Promise<Buffer> {
  if (entry.isFolder || entry.mimeType.startsWith("application/vnd.google-apps.")) {
    throw new UnsupportedTranscriptTypeError(`Not a downloadable binary: ${entry.mimeType}`);
  }
  const url = `${DRIVE_API}/files/${encodeURIComponent(entry.id)}?alt=media&supportsAllDrives=true`;
  const res = await driveFetch(url);
  if (!res.ok) throw new Error(`drive media read ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Overwrite a plain-text file's contents (media upload). Google Docs are not editable this way. */
export async function updateTextFile(entry: DriveEntry, text: string): Promise<DriveEntry> {
  if (entry.mimeType === GOOGLE_DOC_MIME || !entry.mimeType.startsWith("text/")) {
    throw new UnsupportedTranscriptTypeError(`Cannot edit this file type: ${entry.mimeType}`);
  }
  const params = new URLSearchParams({ uploadType: "media", fields: FIELDS, supportsAllDrives: "true" });
  const res = await driveFetch(`${DRIVE_UPLOAD}/files/${encodeURIComponent(entry.id)}?${params.toString()}`, {
    method: "PATCH",
    headers: { "content-type": "text/plain; charset=UTF-8" },
    body: text,
  });
  if (!res.ok) throw new Error(`drive update ${res.status}: ${await res.text()}`);
  return toEntry((await res.json()) as DriveApiFile);
}

/** Move a file to Drive trash (recoverable). */
export async function trashFile(id: string): Promise<void> {
  const params = new URLSearchParams({ supportsAllDrives: "true" });
  const res = await driveFetch(`${DRIVE_API}/files/${encodeURIComponent(id)}?${params.toString()}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ trashed: true }),
  });
  if (!res.ok) throw new Error(`drive trash ${res.status}: ${await res.text()}`);
}

/**
 * Summary files are tagged with appProperties.havayaSummary=true (survives
 * rename). NOTE: the tag string is a legacy name kept deliberately — existing
 * Drive files already carry it, so renaming it would make them undiscoverable.
 */
export async function listSummaries(folderId: string, signal?: AbortSignal): Promise<DriveEntry[]> {
  const params = new URLSearchParams({
    q: `'${folderId}' in parents and trashed=false and appProperties has { key='havayaSummary' and value='true' }`,
    fields: `files(${FIELDS})`,
    orderBy: "createdTime desc",
    pageSize: "100",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  const res = await driveFetch(`${DRIVE_API}/files?${params.toString()}`, signal ? { signal } : undefined);
  if (!res.ok) throw new Error(`drive summaries ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { files?: DriveApiFile[] };
  return (data.files ?? []).map(toEntry);
}

// --------------------------------------------------------------------------
// Root containment guard — every caller-supplied id passes through this.
// --------------------------------------------------------------------------

const containmentCache = new Map<string, number>(); // id -> expiry ms (proven-under-root)

export async function assertEntryUnderRoot(id: string): Promise<DriveEntry> {
  if (!DRIVE_ROOT_FOLDER_ID) throw new Error("PLUSIM_DRIVE_ROOT_FOLDER_ID not configured");
  const entry = await getEntry(id);
  if (id === DRIVE_ROOT_FOLDER_ID) return entry;

  const cached = containmentCache.get(id);
  if (cached && Date.now() < cached) return entry;

  let current = entry;
  const seen = new Set<string>([id]);
  for (let i = 0; i < 50; i++) {
    const parents = current.parents ?? [];
    if (parents.includes(DRIVE_ROOT_FOLDER_ID)) {
      containmentCache.set(id, Date.now() + 5 * 60_000);
      return entry;
    }
    const next = parents.find((p) => !seen.has(p));
    if (!next) break;
    seen.add(next);
    current = await getEntry(next);
  }
  throw new DriveOutsideRootError(`Entry ${id} is not under the configured root folder`);
}

/**
 * Tighter than assertEntryUnderRoot: prove `fileId` lives under a SPECIFIC
 * `folderId` (the job user's assigned folder), not merely somewhere under the
 * owner root. Used by the agent file-download route so a stale/cross-linked
 * StatementFile pointing at another client's folder under the same root is
 * rejected. Throws DriveOutsideRootError if the parent chain never reaches
 * `folderId`. Returns the entry on success.
 */
export async function assertEntryUnderFolder(fileId: string, folderId: string): Promise<DriveEntry> {
  if (!folderId) throw new Error("assertEntryUnderFolder: folderId required");
  const entry = await getEntry(fileId);
  if (fileId === folderId) return entry;

  let current = entry;
  const seen = new Set<string>([fileId]);
  for (let i = 0; i < 50; i++) {
    const parents = current.parents ?? [];
    if (parents.includes(folderId)) return entry;
    const next = parents.find((p) => !seen.has(p));
    if (!next) break;
    seen.add(next);
    current = await getEntry(next);
  }
  throw new DriveOutsideRootError(`Entry ${fileId} is not under folder ${folderId}`);
}
