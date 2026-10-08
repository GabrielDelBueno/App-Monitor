import { test, expect } from "@playwright/test";
import QRCode from "qrcode";

function code39(text) {
  const patterns = {
    "*": "010010100",
    A: "100001001",
    B: "001001001",
    C: "101001000",
  };
  let x = 40;
  const bars = [];
  for (const character of `*${text}*`) {
    [...patterns[character]].forEach((wide, index) => {
      const width = wide === "1" ? 9 : 3;
      if (index % 2 === 0)
        bars.push(`<rect x="${x}" y="40" width="${width}" height="160"/>`);
      x += width;
    });
    x += 3;
  }
  return (
    "data:image/svg+xml;base64," +
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${x + 40}" height="240"><rect width="100%" height="100%" fill="white"/><g fill="black">${bars.join("")}</g></svg>`,
    ).toString("base64")
  );
}

for (const [label, source, value] of [
  [
    "QR Code",
    await QRCode.toDataURL("MONITOR-123", { width: 320, margin: 4 }),
    "MONITOR-123",
  ],
  ["código de barras Code 39", code39("ABC"), "ABC"],
]) {
  test(`lê ${label} de uma imagem real pela câmera e libera a câmera`, async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForFunction(
      () => typeof window.startMonitorScanner === "function",
    );
    await page.evaluate(
      async ({ source }) => {
        window.BarcodeDetector = undefined;
        const canvas = document.createElement("canvas");
        canvas.width = 1280;
        canvas.height = 720;
        const context = canvas.getContext("2d");
        context.fillStyle = "white";
        context.fillRect(0, 0, 1280, 720);
        const image = new Image();
        image.src = source;
        await image.decode();
        context.drawImage(
          image,
          (1280 - image.width) / 2,
          (720 - image.height) / 2,
        );
        const stream = canvas.captureStream(24);
        window.scannerTrack = stream.getVideoTracks()[0];
        navigator.mediaDevices.getUserMedia = async () => stream;
        const video = document.createElement("video");
        document.body.append(video);
        window.scannerResult = null;
        await window.startMonitorScanner(video, (code) => {
          window.scannerResult = code;
          return true;
        });
      },
      { source },
    );
    await expect
      .poll(() => page.evaluate(() => window.scannerResult))
      .toBe(value);
    await expect
      .poll(() => page.evaluate(() => window.scannerTrack.readyState))
      .toBe("ended");
  });
}

test("fecha a câmera quando a janela é removida antes da permissão", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForFunction(
    () => typeof window.startMonitorScanner === "function",
  );
  const result = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    const stream = canvas.captureStream();
    const track = stream.getVideoTracks()[0];
    let permit;
    navigator.mediaDevices.getUserMedia = () =>
      new Promise((resolve) => {
        permit = resolve;
      });
    const video = document.createElement("video");
    document.body.append(video);
    const pending = window.startMonitorScanner(video, () => true);
    video.remove();
    permit(stream);
    await pending;
    return track.readyState;
  });
  expect(result).toBe("ended");
});

test("detecção nativa continua após código recusado e encerra após aceitação", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForFunction(
    () => typeof window.startMonitorScanner === "function",
  );
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.getContext("2d").fillRect(0, 0, 300, 150);
    const stream = canvas.captureStream(24);
    window.scannerTrack = stream.getVideoTracks()[0];
    navigator.mediaDevices.getUserMedia = async () => stream;
    window.BarcodeDetector = class {
      static async getSupportedFormats() {
        return [
          "qr_code",
          "code_128",
          "code_39",
          "ean_13",
          "ean_8",
          "upc_a",
          "upc_e",
          "itf",
          "codabar",
        ];
      }
      async detect() {
        return [
          {
            rawValue: window.nativeResults.length
              ? "CADASTRADO"
              : "DESCONHECIDO",
          },
        ];
      }
    };
    window.nativeResults = [];
    const video = document.createElement("video");
    document.body.append(video);
    await window.startMonitorScanner(video, (code) => {
      window.nativeResults.push(code);
      return code === "CADASTRADO";
    });
  });
  await expect
    .poll(() => page.evaluate(() => window.nativeResults))
    .toEqual(["DESCONHECIDO", "CADASTRADO"]);
  await expect
    .poll(() => page.evaluate(() => window.scannerTrack.readyState))
    .toBe("ended");
});

test("ignora QR fora da moldura e lê quando alinhado ao centro", async ({
  page,
}) => {
  const source = await QRCode.toDataURL("ALVO-CENTRAL", {
    width: 120,
    margin: 4,
  });
  await page.goto("/");
  await page.waitForFunction(
    () => typeof window.startMonitorScanner === "function",
  );
  await page.evaluate(async (source) => {
    window.BarcodeDetector = undefined;
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const context = canvas.getContext("2d");
    const image = new Image();
    image.src = source;
    await image.decode();
    window.positionTarget = (centered) => {
      context.fillStyle = "white";
      context.fillRect(0, 0, 1280, 720);
      context.drawImage(image, 580, centered ? 300 : 0);
    };
    window.positionTarget(false);
    const stream = canvas.captureStream(24);
    navigator.mediaDevices.getUserMedia = async () => stream;
    const video = document.createElement("video");
    video.style.cssText = "width:640px;height:360px;object-fit:cover";
    document.body.append(video);
    window.targetResults = [];
    await window.startMonitorScanner(video, (code) => {
      window.targetResults.push(code);
      return true;
    });
  }, source);
  // Let several scan attempts run with the code outside the actual crop.
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => window.targetResults)).toEqual([]);
  await page.evaluate(() => window.positionTarget(true));
  await expect
    .poll(() => page.evaluate(() => window.targetResults))
    .toEqual(["ALVO-CENTRAL"]);
});
