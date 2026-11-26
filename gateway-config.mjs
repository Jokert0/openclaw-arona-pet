import { constants } from "node:fs";
import { copyFile, readFile } from "node:fs/promises";
import { join } from "node:path";

export async function readGatewayConfig(directory) {
  const file = join(directory, "gateway.json");
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    try {
      await copyFile(new URL("./gateway.example.json", import.meta.url), file, constants.COPYFILE_EXCL);
    } catch (copyError) {
      if (copyError.code !== "EEXIST") throw copyError;
    }
    text = await readFile(file, "utf8");
  }
  const config = JSON.parse(text.replace(/^\uFEFF/, ""));
  const { port, token = "", password = "" } = config;
  if (!Number.isInteger(port) || port < 1 || port > 65535 ||
      typeof token !== "string" || typeof password !== "string" || (token && password)) {
    throw new Error("Invalid Gateway configuration");
  }
  return { url: `ws://127.0.0.1:${port}`, token: token || undefined, password: password || undefined };
}
