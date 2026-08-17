import { scrypt } from "@noble/hashes/scrypt.js";

/**
 * Encrypted key backup — Buzz's EncryptedBackupCreator decision: a
 * passworded file the user can stash anywhere (drive, email, USB),
 * strictly better than a raw hex note. scrypt (N=2^15) stretches the
 * password, AES-GCM seals the key; both primitives ship with the
 * platform + noble — nothing fetched, nothing invented.
 */

const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1, dkLen: 32 };

interface BackupFile {
  v: 1;
  kdf: "scrypt";
  N: number;
  r: number;
  p: number;
  salt: string; // base64
  iv: string; // base64
  ct: string; // base64
}

const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromB64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function deriveAesKey(password: string, salt: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  const derived = scrypt(new TextEncoder().encode(password.normalize("NFKC")), salt, SCRYPT_PARAMS);
  return crypto.subtle.importKey("raw", derived as BufferSource, "AES-GCM", false, [usage]);
}

export async function createBackup(keyHex: string, password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await deriveAesKey(password, salt, "encrypt");
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, aesKey, new TextEncoder().encode(keyHex));
  const file: BackupFile = {
    v: 1,
    kdf: "scrypt",
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    salt: toB64(salt),
    iv: toB64(iv),
    ct: toB64(new Uint8Array(ct)),
  };
  return JSON.stringify(file, null, 2);
}

/** Throws on a wrong password or a mangled file. */
export async function openBackup(json: string, password: string): Promise<string> {
  const file = JSON.parse(json) as BackupFile;
  if (file.v !== 1 || file.kdf !== "scrypt") throw new Error("not a fez backup file");
  const derived = scrypt(new TextEncoder().encode(password.normalize("NFKC")), fromB64(file.salt), {
    N: file.N,
    r: file.r,
    p: file.p,
    dkLen: 32,
  });
  const aesKey = await crypto.subtle.importKey("raw", derived as BufferSource, "AES-GCM", false, ["decrypt"]);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(file.iv) as BufferSource }, aesKey, fromB64(file.ct) as BufferSource);
  } catch {
    throw new Error("wrong password (or the file is damaged)");
  }
  const keyHex = new TextDecoder().decode(plain);
  if (!/^[0-9a-f]{64}$/.test(keyHex)) throw new Error("backup decrypted to something that isn't a key");
  return keyHex;
}

export function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
