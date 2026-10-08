import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(root, "public-static");
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
// Copy only public assets, never local configuration or a database placed in frontend/.
for (const name of [
  "index.html",
  "app.js",
  "scanner.js",
  "inventory-import.js",
  "styles.css",
  "connection.js",
  "pwa.js",
  "sw.js",
  "offline.html",
  "manifest.webmanifest",
  "favicon.ico",
])
  cpSync(resolve(root, "frontend", name), resolve(target, name));
mkdirSync(resolve(target, "icons"), { recursive: true });
for (const name of [
  "icon-192.png",
  "icon-512.png",
  "app-monitor-192-v2.png",
  "app-monitor-512-v2.png",
  "apple-touch-icon.png",
  "apple-touch-icon-v2.png",
  "favicon-32-v2.png",
])
  cpSync(resolve(root, "frontend/icons", name), resolve(target, "icons", name));
mkdirSync(resolve(target, "vendor/zxing"), { recursive: true });
cpSync(
  resolve(root, "node_modules/@zxing/browser/umd/zxing-browser.min.js"),
  resolve(target, "vendor/zxing/zxing-browser.min.js"),
);
writeFileSync(
  resolve(target, "build-info.json"),
  JSON.stringify({
    interface: "App Monitor",
    builtAt: new Date().toISOString(),
    sourceVersion: process.env.RENDER_GIT_COMMIT || null,
  }),
);
console.log(
  "Interface estática pronta em public-static/. Nenhum dado ou segredo do backend foi copiado.",
);
