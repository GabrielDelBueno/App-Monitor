(() => {
  const button = document.querySelector("#install-app");
  const dialog = document.querySelector("#install-help");
  const standalone = () =>
    matchMedia("(display-mode: standalone)").matches ||
    navigator.standalone === true;
  let installPrompt;
  const update = () => {
    button.hidden = standalone();
  };
  update();
  matchMedia("(display-mode: standalone)").addEventListener("change", update);
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event;
    update();
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    button.hidden = true;
  });
  button.addEventListener("click", async () => {
    if (installPrompt) {
      const prompt = installPrompt;
      installPrompt = null;
      try {
        await prompt.prompt();
        await prompt.userChoice;
      } catch {
        dialog.showModal();
      }
    } else dialog.showModal();
  });
  document
    .querySelector("#close-install-help")
    .addEventListener("click", () => dialog.close());
  if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker
      .register("/sw.js", { updateViaCache: "none" })
      .catch(() => {
        // Browser installation instructions remain available if registration fails.
      });
  }
})();
