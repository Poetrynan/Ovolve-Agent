# Third-Party Licenses

Ovolve Agent is distributed under the Apache License 2.0. See [LICENSE](./LICENSE)
for the full text governing this project itself.

This file records the third-party material Ovolve builds on and the terms each
project publishes. The origin of every catalogued capability is declared in one
place in code — `SOURCE_REGISTRY` in `app/backend/skill_registry.py` — and this
file is the human-readable counterpart of that table. When the two disagree, the
upstream project's own LICENSE file is authoritative.

---

## 1. Marketplace skills

Seven skills are offered in the marketplace catalogue. All seven come from a
single upstream repository, fetched at install time from a pinned revision; they
are not vendored into this repository.

| Skill | Upstream path |
|---|---|
| `code-review-excellence` | `plugins/developer-essentials/skills/code-review-excellence` |
| `hybrid-search-implementation` | `plugins/llm-application-dev/skills/hybrid-search-implementation` |
| `rag-implementation` | `plugins/llm-application-dev/skills/rag-implementation` |
| `design-system-patterns` | `plugins/ui-design/skills/design-system-patterns` |
| `visual-design-foundations` | `plugins/ui-design/skills/visual-design-foundations` |
| `architecture-decision-records` | `plugins/documentation-generation/skills/architecture-decision-records` |
| `protect-mcp-setup` | `plugins/protect-mcp/skills/protect-mcp-setup` |

- **Project:** [wshobson/agents](https://github.com/wshobson/agents)
- **License:** MIT
- **Pinned revision:** `4236bb91f8395b0435f1d8b8baf9e8e4c69a8620`
- **Upstream status:** active

The revision is pinned deliberately so that upstream changes take effect only
when this project advances the recorded hash.

## 2. MCP connectors

Six connectors are catalogued. All six come from the Model Context Protocol
project, which publishes its terms as MIT for pre-existing code and Apache-2.0
for new contributions.

### Active — [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers)

- **License:** MIT (existing code) / Apache-2.0 (new contributions)
- **Pinned revision:** `d73f99efbfd40c3aa1b61e88728b3d49fb52608f`
- **Upstream status:** active
- **Connectors:** `filesystem`, `fetch`

### Archived — [modelcontextprotocol/servers-archived](https://github.com/modelcontextprotocol/servers-archived)

- **License:** MIT (existing code) / Apache-2.0 (new contributions)
- **Pinned revision:** `9be4674d1ddf8c469e6461a27a337eeb65f76c2e`
- **Upstream status:** **archived** — upstream describes this repository as no
  longer maintained. The connectors remain installable, but nothing upstream is
  being fixed.
- **Connectors:** `github`, `sqlite`, `postgres`, `puppeteer`

These four were moved out of the active repository. The catalogue records them
against the archived source so the maintenance status is visible rather than
implied.

## 3. Bundled plugins

The three bundled plugins (`plugin-git-suite`, `plugin-office-suite`,
`plugin-quality-gate`) are distributed with this project.

- **License:** Apache-2.0 (same as this project)

## 4. Bundled frontend dependencies

Licenses below are read from each package's own published metadata.

| Package | License |
|---|---|
| react, react-dom | MIT |
| @radix-ui/react-* (23 packages) | MIT |
| vite, @vitejs/plugin-react | MIT |
| electron | MIT |
| typescript | Apache-2.0 |
| tailwindcss, tailwind-merge, tailwindcss-animate | MIT |
| framer-motion | MIT |
| lucide-react | ISC |
| zustand | MIT |
| recharts | MIT |
| react-markdown, remark-gfm, remark-math | MIT |
| rehype-highlight, rehype-katex | MIT |
| highlight.js | BSD-3-Clause |
| katex | MIT |
| clsx, cmdk, sonner, class-variance-authority | MIT / Apache-2.0 |
| react-resizable-panels, tree-kill | MIT |
| postcss, autoprefixer, esbuild | MIT |

## 5. Bundled backend dependencies

Declared in `app/requirements.txt`.

| Package | License |
|---|---|
| aiohttp | Apache-2.0 AND MIT |
| selenium | Apache-2.0 |
| mcp | MIT |
| psutil | BSD-3-Clause |
| python-dotenv | BSD-3-Clause |
| croniter | MIT |
| jsonschema, pytest | MIT |
| websockets, cryptography, pytest-asyncio, Pillow | see note below |

**Note on the last row.** The installed distributions for these four do not
carry a license field or classifier in their metadata, so no value could be read
from the package itself. Their terms are those published by each upstream
project, and the authoritative text is in each project's own repository.

## 6. Optional semantic-memory dependencies

Layer 2 semantic memory is optional. When enabled it pulls `fastembed` and, at
first use, the `BAAI/bge-base-zh-v1.5` weights (ONNX form published as
`Xenova/bge-base-zh-v1.5`). Neither is required to run Ovolve; both are fetched
on demand rather than bundled. Their licenses are those published by their
respective projects.

---

## License texts

### MIT License

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### BSD 3-Clause License

```
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### ISC License

```
Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
```

### Apache License 2.0

The full text of the Apache License 2.0 is in [LICENSE](./LICENSE) at the root
of this repository. It is not repeated here because it is identical for every
component listed under Apache-2.0 above, including this project itself.
