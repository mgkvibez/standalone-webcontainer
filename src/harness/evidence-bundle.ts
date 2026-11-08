/**
 * The shape of a written evidence bundle, kept apart from the writer.
 *
 * `evidence.ts` reaches for `node:fs/promises`, which the runtime lane must never import. The type lived next to the
 * writer, so `harness/index.ts` re-exporting it dragged Node typings into every consumer of the harness barrel.
 * Splitting the type out is what lets `tsconfig.runtime.json` compile src/ without Node types at all.
 */

export interface EvidenceBundle {
  readonly dir: string;
  readonly files: readonly string[];
}
