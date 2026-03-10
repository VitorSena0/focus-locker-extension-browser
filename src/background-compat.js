// Compat loader for Firefox MV2 background.
// Loads the MV3 module-based background logic.
(async () => {
  try {
    await import("./background.js");
  } catch (error) {
    console.error("Falha ao carregar background.js (module).", error);
  }
})();
