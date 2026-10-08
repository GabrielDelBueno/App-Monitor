(() => {
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  window.monitorConnection = {
    async ready() {
      while (true) {
        const status = document.querySelector("#connection-status");
        const retry = document.querySelector("#retry-connection");
        if (status) status.textContent = "Conectando ao servidor…";
        if (retry) retry.hidden = true;
        const deadline = Date.now() + 120000;
        while (Date.now() < deadline) {
          if (status && !navigator.onLine)
            status.textContent = "Sem internet. Verifique sua conexão.";
          else if (status)
            status.textContent =
              "Conectando ao servidor… O primeiro acesso pode levar cerca de um minuto.";
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 12000);
          try {
            // Read-only requests may be retried. Never retry a registration or loan mutation.
            const response = await fetch("/api/auth/config", {
              cache: "no-store",
              signal: controller.signal,
            });
            if (
              response.ok &&
              response.headers.get("content-type")?.includes("application/json")
            ) {
              const config = await response.json();
              if (
                typeof config.govbr === "boolean" &&
                typeof config.needsSetup === "boolean"
              )
                return config;
            }
          } catch {
            /* Keep the school's screen while the backend wakes or the connection returns. */
          } finally {
            clearTimeout(timeout);
          }
          await delay(2000);
        }
        if (status)
          status.textContent =
            "Não foi possível conectar agora. Confira sua internet e tente novamente.";
        if (!retry) throw Error("Servidor indisponível. Tente novamente.");
        retry.hidden = false;
        await new Promise((resolve) =>
          retry.addEventListener("click", resolve, { once: true }),
        );
      }
    },
  };
})();
