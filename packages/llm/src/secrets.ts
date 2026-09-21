import crypto from "node:crypto";
import fs from "node:fs";
import { dataPath, logger } from "@prowl/shared";

const log = logger("secrets");

/*
 * Secret storage for API keys and OAuth tokens.
 *
 * Windows Credential Manager limits entries to 1,280 characters, and OAuth tokens are longer, so
 * secrets are not stored in the keychain directly. Instead a random 256-bit master key lives in the
 * OS keychain **outside the data directory** (service `prowl`, account `master-key`; Windows
 * Credential Manager / macOS login keychain / Linux Secret Service). Settings → Delete all data
 * wipes `PROWL_DATA_DIR` but does **not** remove that keychain entry — delete it yourself in the
 * OS credential UI if you want the key gone too.
 * Secrets themselves are AES-256-GCM encrypted in data/secrets.json. If the keychain is
 * unavailable the master key is kept in data/secrets.key and `keyStorage()` reports "file".
 */

const SERVICE = "prowl";
const ACCOUNT = "master-key";

type Envelope = Record<string, { iv: string; tag: string; data: string }>;

let masterKey: Buffer | undefined;
let storage: "keychain" | "file" | undefined;

function secretsFile(): string {
  return process.env.PROWL_SECRETS_FILE ?? dataPath("secrets.json");
}

async function loadKeyring(): Promise<typeof import("@napi-rs/keyring") | null> {
  if (process.env.PROWL_SECRETS_NO_KEYCHAIN === "1") return null;
  try {
    return await import("@napi-rs/keyring");
  } catch {
    return null;
  }
}

async function getMasterKey(): Promise<Buffer> {
  if (masterKey) return masterKey;
  const keyring = await loadKeyring();
  if (keyring) {
    try {
      const entry = new keyring.Entry(SERVICE, ACCOUNT);
      let hex = entry.getPassword();
      if (!hex) {
        hex = crypto.randomBytes(32).toString("hex");
        entry.setPassword(hex);
      }
      masterKey = Buffer.from(hex, "hex");
      storage = "keychain";
      return masterKey;
    } catch (err) {
      log.warn(`OS keychain unavailable, using a key file instead: ${(err as Error).message}`);
    }
  }
  const keyFile = dataPath("secrets.key");
  if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  masterKey = Buffer.from(fs.readFileSync(keyFile, "utf8").trim(), "hex");
  storage = "file";
  return masterKey;
}

function readEnvelope(): Envelope {
  try {
    return JSON.parse(fs.readFileSync(secretsFile(), "utf8")) as Envelope;
  } catch {
    return {};
  }
}

function writeEnvelope(env: Envelope): void {
  const file = secretsFile();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(env, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const keyName = (connectionId: string, name: string) => `${connectionId}/${name}`;

export async function setSecret(connectionId: string, name: string, value: string): Promise<void> {
  const key = await getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const env = readEnvelope();
  env[keyName(connectionId, name)] = { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
  writeEnvelope(env);
}

export async function getSecret(connectionId: string, name: string): Promise<string | null> {
  const item = readEnvelope()[keyName(connectionId, name)];
  if (!item) return null;
  const key = await getMasterKey();
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(item.iv, "base64"));
    decipher.setAuthTag(Buffer.from(item.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(item.data, "base64")), decipher.final()]).toString("utf8");
  } catch {
    log.error(`Could not decrypt secret ${keyName(connectionId, name)}. The master key may have changed; sign in or enter the key again.`);
    return null;
  }
}

export async function deleteSecrets(connectionId: string): Promise<void> {
  const env = readEnvelope();
  for (const k of Object.keys(env)) if (k.startsWith(`${connectionId}/`)) delete env[k];
  writeEnvelope(env);
}

export async function keyStorage(): Promise<"keychain" | "file"> {
  await getMasterKey();
  return storage!;
}

export function maskKey(key: string): string {
  const k = key.trim();
  if (k.length <= 8) return "••••";
  return `${k.slice(0, Math.min(4, k.indexOf("-") > 0 && k.indexOf("-") < 6 ? k.indexOf("-") + 1 : 3))}…${k.slice(-4)}`;
}

/** Forget the cached master key (local data wipe, or a changed env/file). */
export function resetSecretsCache(): void {
  masterKey = undefined;
  storage = undefined;
}

/** Test hook: forget the cached master key so a changed env/file is re-read. */
export function _resetSecretsForTests(): void {
  resetSecretsCache();
}
