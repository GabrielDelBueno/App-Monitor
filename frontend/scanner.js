(() => {
  const formats = [
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
  window.startMonitorScanner = async (video, onResult) => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 },
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
        fallback?.stop();
        stream.getTracks().forEach((track) => track.stop());
        if (video.srcObject === stream) video.srcObject = null;
      },
    };
    const deliver = (text) => {
      if (!stopped && video.isConnected && onResult(text) === true)
        controls.stop();
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
      async function useFallback() {
        if (stopped || !video.isConnected) {
          controls.stop();
          return;
        }
        const library = window.ZXingBrowser;
        if (!library) throw Error("Leitor indisponível.");
        const reader = new library.BrowserMultiFormatReader(undefined, {
          delayBetweenScanAttempts: 120,
          delayBetweenScanSuccess: 120,
        });
        reader.possibleFormats = [
          "QR_CODE",
          "CODE_128",
          "CODE_39",
          "EAN_13",
          "EAN_8",
          "UPC_A",
          "UPC_E",
          "ITF",
          "CODABAR",
        ].map((name) => library.BarcodeFormat[name]);
        fallback = await reader.decodeFromVideoElement(video, (result) => {
          if (result) deliver(result.getText());
        });
        if (stopped) fallback.stop();
      }
      let detector;
      try {
        if (window.BarcodeDetector) {
          const supported = await BarcodeDetector.getSupportedFormats();
          if (formats.every((format) => supported.includes(format)))
            detector = new BarcodeDetector({ formats });
        }
      } catch {
        /* Use the compatible reader if native detection is unavailable. */
      }
      if (detector) {
        const read = async () => {
          if (stopped || !video.isConnected) {
            controls.stop();
            return;
          }
          try {
            if (video.readyState >= 2) {
              const results = await detector.detect(video);
              if (results[0]?.rawValue) deliver(results[0].rawValue);
            }
          } catch {
            try {
              await useFallback();
            } catch {
              controls.stop();
            }
            return;
          }
          if (!stopped) timer = setTimeout(read, 100);
        };
        timer = setTimeout(read, 0);
      } else await useFallback();
      return controls;
    } catch (error) {
      controls.stop();
      throw error;
    }
  };
})();
