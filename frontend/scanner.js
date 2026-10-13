(() => {
  const formats = [
    "qr_code",
    "code_128",
    "code_39",
    "code_93",
    "ean_13",
    "ean_8",
    "upc_a",
    "upc_e",
    "itf",
    "codabar",
  ];
  window.startMonitorScanner = async (video, onResult) => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 24, max: 30 },
      },
    });
    let stopped = false,
      timer,
      fallback;
    const controls = {
      stop() {
        if (stopped) return;
        stopped = true;
        clearTimeout(timer);

        stream.getTracks().forEach((track) => track.stop());
        if (video.srcObject === stream) video.srcObject = null;
      },
    };
    let lastRejected = "",
      rejectedAt = 0;
    const deliver = (text) => {
      if (stopped || !video.isConnected) return false;
      if (text === lastRejected && Date.now() - rejectedAt < 1500) return false;
      if (onResult(text) === true) {
        controls.stop();
        return true;
      }
      lastRejected = text;
      rejectedAt = Date.now();
      return false;
    };
    try {
      if (!video.isConnected) {
        controls.stop();
        return controls;
      }
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      const track = stream.getVideoTracks()[0];
      try {
        if (track.getCapabilities?.().focusMode?.includes("continuous"))
          await track.applyConstraints({
            advanced: [{ focusMode: "continuous" }],
          });
      } catch {
        /* Optional autofocus must not prevent scanning. */
      }
      // Match the central guide to the visible object-fit: cover preview.
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d", { willReadFrequently: true });
      function captureTarget() {
        const bounds = video.getBoundingClientRect();
        const width = video.videoWidth,
          height = video.videoHeight;
        const scale = Math.max(bounds.width / width, bounds.height / height);
        const cropWidth = Math.round((bounds.width * 0.8) / scale);
        const cropHeight = Math.round((bounds.height * 0.6) / scale);
        if (!cropWidth || !cropHeight) return null;
        if (canvas.width !== cropWidth) canvas.width = cropWidth;
        if (canvas.height !== cropHeight) canvas.height = cropHeight;
        context.drawImage(
          video,
          (width - cropWidth) / 2,
          (height - cropHeight) / 2,
          cropWidth,
          cropHeight,
          0,
          0,
          cropWidth,
          cropHeight,
        );
        return canvas;
      }
      function useFallback() {
        if (stopped || !video.isConnected) {
          controls.stop();
          return;
        }
        const library = window.ZXingBrowser;
        if (!library) throw Error("Leitor indisponível.");
        // ZXing DecodeHintType.TRY_HARDER = 3: sample more rows on small factory labels.
        fallback = new library.BrowserMultiFormatReader(new Map([[3, true]]));
        fallback.possibleFormats = [
          "QR_CODE",
          "CODE_128",
          "CODE_39",
          "CODE_93",
          "EAN_13",
          "EAN_8",
          "UPC_A",
          "UPC_E",
          "ITF",
          "CODABAR",
        ].map((name) => library.BarcodeFormat[name]);
      }
      let detector;
      try {
        if (window.BarcodeDetector) {
          const supported = await BarcodeDetector.getSupportedFormats();
          const nativeFormats = formats.filter((format) =>
            supported.includes(format),
          );
          if (nativeFormats.length)
            detector = new BarcodeDetector({ formats: nativeFormats });
        }
      } catch {
        /* Use the compatible reader if native detection is unavailable. */
      }
      useFallback();
      if (!video.isConnected) {
        controls.stop();
        return controls;
      }
      const strip = document.createElement("canvas"),
        rotated = document.createElement("canvas");
      let frame = 0;
      const decodeFallback = (target) => {
        try {
          return deliver(fallback.decodeFromCanvas(target).getText());
        } catch {
          return false;
        }
      };
      const read = async () => {
        if (stopped || !video.isConnected) {
          controls.stop();
          return;
        }
        if (video.readyState >= 2) {
          const target = captureTarget();
          if (target) {
            // First read the horizontal band on the red aiming line, away from nearby IMEI labels.
            strip.width = target.width;
            strip.height = Math.max(1, Math.round(target.height * 0.25));
            strip
              .getContext("2d")
              .drawImage(
                target,
                0,
                (target.height - strip.height) / 2,
                strip.width,
                strip.height,
                0,
                0,
                strip.width,
                strip.height,
              );
            if (detector) {
              try {
                const results = await detector.detect(strip);
                for (const result of results)
                  if (result.rawValue && deliver(result.rawValue)) break;
              } catch {
                detector = null;
              }
            }
            if (!stopped) decodeFallback(strip);
            if (!stopped) {
              // Alternate QR/full-frame decoding and rotated barcode decoding to bound work per frame.
              if (frame++ % 2 === 0) decodeFallback(target);
              else {
                rotated.width = target.height;
                rotated.height = target.width;
                const ctx = rotated.getContext("2d");
                ctx.translate(rotated.width / 2, rotated.height / 2);
                ctx.rotate(Math.PI / 2);
                ctx.drawImage(target, -target.width / 2, -target.height / 2);
                decodeFallback(rotated);
              }
            }
          }
        }
        if (!stopped) timer = setTimeout(read, 120);
      };
      timer = setTimeout(read, 0);
      return controls;
    } catch (error) {
      controls.stop();
      throw error;
    }
  };
})();
