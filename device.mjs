import { createHash, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

// Gateway-issued device credentials are local to this desktop profile and endpoint.
export async function deviceAuth(directory, vault, origin) {
  if (!(await vault.isAsyncEncryptionAvailable())) throw new Error("系统凭据存储不可用");
  const id = createHash("sha256").update(origin).digest("hex").slice(0, 16);
  const file = path.join(directory, `gateway-device-${id}.bin`);
  let record;
  const persist = async (next, operation) => {
    const encrypted = await vault.encryptStringAsync(JSON.stringify(next));
    operation?.signal?.throwIfAborted();
    operation?.assertCurrent?.();
    writeFileSync(`${file}.tmp`, encrypted, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
    record = next;
  };
  if (existsSync(file)) {
    const { result, shouldReEncrypt } = await vault.decryptStringAsync(readFileSync(file));
    record = JSON.parse(result);
    if (shouldReEncrypt) await persist(record);
  } else {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    await persist({
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
    });
  }
  const raw = createPublicKey(record.publicKeyPem).export({ format: "jwk" }).x;
  const deviceId = createHash("sha256").update(Buffer.from(raw, "base64url")).digest("hex");
  return {
    deviceIdentity: {
      deviceId,
      publicKeyPem: record.publicKeyPem,
      privateKeyPem: record.privateKeyPem,
    },
    hostDeps: {
      signDevicePayload: (key, text) => sign(null, Buffer.from(text), key).toString("base64url"),
      publicKeyRawBase64UrlFromPem: () => raw,
      loadDeviceAuthToken: () => record.auth ?? null,
      storeDeviceAuthToken: (operation) => {
        const { token, scopes } = operation;
        return persist({ ...record, auth: { token, scopes } }, operation);
      },
      clearDeviceAuthToken: (operation) => {
        if (record.auth && (!operation.expectedToken || record.auth.token === operation.expectedToken)) {
          const next = { ...record };
          delete next.auth;
          return persist(next, operation);
        }
      },
    },
  };
}
