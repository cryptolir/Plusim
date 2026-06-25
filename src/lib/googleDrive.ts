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
    const res = await client.getAccessToken();
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

async function driveFetch(url: string, init?: RequestInit): Promise<Response> {
  const token = await getAccessToken();
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

export async function getFileText(entry: DriveEntry): Promise<string> {
  let url: string;
  if (entry.mimeType === GOOGLE_DOC_MIME) {
    url = `${DRIVE_API}/files/${encodeURIComponent(entry.id)}/export?mimeType=text/plain&supportsAllDrives=true`;
  } else if (entry.mimeType.startsWith("text/")) {
    url = `${DRIVE_API}/files/${encodeURIComponent(entry.id)}?alt=media&supportsAllDrives=true`;
  } else {
    throw new UnsupportedTranscriptTypeError(`Unsupported transcript type: ${entry.mimeType}`);
  }
  const res = await driveFetch(url);
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
  const boundary = `havaya_${crypto.randomUUID()}`;
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

/** Summary files are tagged with appProperties.havayaSummary=true (survives rename). */
export async function listSummaries(folderId: string): Promise<DriveEntry[]> {
  const params = new URLSearchParams({
    q: `'${folderId}' in parents and trashed=false and appProperties has { key='havayaSummary' and value='true' }`,
    fields: `files(${FIELDS})`,
    orderBy: "createdTime desc",
    pageSize: "100",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  const res = await driveFetch(`${DRIVE_API}/files?${params.toString()}`);
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
