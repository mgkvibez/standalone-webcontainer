const params = new URLSearchParams(window.location.search);
if (params.get("__preview_shell") === "1") {
  document.getElementById("app")?.setAttribute("hidden", "");
  document.getElementById("preview-shell")?.removeAttribute("hidden");
  await import("./preview-shell.js");
} else {
  await import("./main.js");
}
