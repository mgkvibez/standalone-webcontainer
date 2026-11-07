/// <reference types="vite/client" />

import { loadCorpusRegistry } from "../registry/corpus.js";

const assetUrls = import.meta.glob("../../fixtures/registry/**/*", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

/** Load and verify the committed corpus before exposing it to terminal commands. It never contacts a package registry. */
export async function loadOfflineRegistry(): Promise<Awaited<ReturnType<typeof loadCorpusRegistry>>["registry"]> {
  const urls = new Map<string, string>();
  for (const [key, url] of Object.entries(assetUrls)) {
    const relative = key.split("/fixtures/registry/")[1];
    if (relative !== undefined) urls.set(relative, url);
  }
  const manifestUrl = urls.get("manifest.json");
  if (manifestUrl === undefined) throw new Error("offline package corpus manifest is missing from this build");
  const manifestResponse = await fetch(manifestUrl);
  if (!manifestResponse.ok) throw new Error(`could not load offline corpus manifest (${manifestResponse.status})`);
  const manifestText = await manifestResponse.text();
  const files = new Map<string, Uint8Array>();
  await Promise.all([...urls].filter(([path]) => path !== "manifest.json").map(async ([path, url]) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`could not load offline corpus package ${path} (${response.status})`);
    files.set(path, new Uint8Array(await response.arrayBuffer()));
  }));
  const loaded = await loadCorpusRegistry({
    root: "/corpus",
    manifestText,
    mode: "resolution",
    read: (path) => {
      const relative = path.startsWith("/corpus/") ? path.slice("/corpus/".length) : path;
      const bytes = files.get(relative);
      if (bytes === undefined) throw new Error(`offline corpus file is missing: ${relative}`);
      return bytes;
    },
    listFiles: () => [...files.keys()],
  });
  return loaded.registry;
}
