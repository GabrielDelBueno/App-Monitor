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
        fallback = new library.BrowserMultiFormatReader();
        fallback.possibleFormats = [
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
      if (!detector) useFallback();
      if (!video.isConnected) {
        controls.stop();
        return controls;
      }
      const read = async () => {
        if (stopped || !video.isConnected) {
          controls.stop();
          return;
        }
        if (video.readyState >= 2) {
          const target = captureTarget();
          if (target) {
            if (detector) {
              try {
                const results = await detector.detect(target);
                if (results[0]?.rawValue) deliver(results[0].rawValue);
              } catch {
                detector = null;
                try {
                  useFallback();
                } catch {
                  controls.stop();
                }
              }
            } else {
              let result;
              try {
                result = fallback.decodeFromCanvas(target);
              } catch {
                // No complete readable code in the target yet; try the next frame.
              }
              if (result) deliver(result.getText());
            }
          }
        }
        if (!stopped) timer = setTimeout(read, detector ? 100 : 120);
      };
      timer = setTimeout(read, 0);
      return controls;
    } catch (error) {
      controls.stop();
      throw error;
    }
  };
})();
