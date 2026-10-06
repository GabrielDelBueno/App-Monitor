import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:3344",
    headless: true,
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      args: ["--no-sandbox"],
    },
  },
  webServer: {
    command: "node tests/browser/server.js",
    url: "http://127.0.0.1:3344/health",
    reuseExistingServer: false,
    timeout: 15000,
  },
  reporter: "list",
});
