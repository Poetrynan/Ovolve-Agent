# Ovolve Agent v0.0.1

First public release of **Ovolve Agent** — a local-first, self-evolving coding agent with deterministic delivery gates.

## Highlights

- **Trust gates before main**: AST blocks empty/`TODO` stubs; sandbox tests must go green before write-back; acceptance fingerprints stay locked for the run.
- **Self-evolution (GEPA)**: failure signatures become durable rules in `MEMORY.md` so the same mistake is not repeated.
- **Long-context memory**: six-tier memory with a hard budget; Head-Tail spill keeps signal without blowing the window.
- **Offline embedder**: ships with bundled `Xenova/bge-base-zh-v1.5` ONNX weights under `resources/embedder` — no post-install model download for embeddings.
- **Desktop app**: Electron + local Python backend; data stays on-device by default.
- **License**: Apache-2.0

## Product site

https://poetrynan.github.io/OVOLVE.org/

## Repository

https://github.com/Poetrynan/Ovolve-Agent

## Notes

- Version `0.0.1` is the first tagged public cut. Expect rapid iteration on packaging and installers.
- LLM inference still uses your configured provider (API keys / Ollama). Only the **embedding** model is bundled offline in this release.
- Legacy `MyBuddy` packaging leftovers have been removed from the local build tree; product identity is **Ovolve** only (`com.ovolve.desktop`).
