# Cappy site

The landing page and documentation share one static build. The Worker owns the hosted MCP endpoint and selects the correct page by host. Documentation assets and resources stay under `/cappy/` so other Uppercut Labs documentation can coexist on the docs domain.

`wrangler.jsonc` assigns the Cappy custom domain. The existing Uppercut Labs
Worker delegates only the docs host's `/cappy` namespace through its
`CAPPY_DOCS` service binding to `cappy`. Deploying this repository updates both
Cappy surfaces; unrelated documentation remains with its existing Worker.

## Build

From the repository root:

```bash
npm install
node site/build.mjs
```

Output is `site/dist/`. Root `index.html` is the landing page. `/cappy/` is the documentation home. Each documentation topic has both `/cappy/<topic>/` HTML and `/cappy/<topic>.md` Markdown. Public skill references are retained at `/cappy/skill/`.

The setup prompt points to `https://docs.uppercut-labs.com/cappy/guides/setup-cappy.md`. Discovery is `/cappy/llms.txt`. Shared artwork, font, CSS, and JavaScript live under `/cappy/assets/`. Every first-screen agent control uses authentic Codex, Claude Code, and Cursor artwork with visible names.

The source pages combine focused public guides in `site/content/` with the existing repository documentation. Link rewriting uses the explicit page registry and preserves raw nested skill resources. Rebuild after editing source documentation.

## Preview and visual QA

```bash
python3 -m http.server 4178 --directory site/dist
```

In another terminal, run the browser checks with an unpacked genuine Dark Reader extension:

```bash
DARK_READER_PATH=/path/to/unpacked/darkreader node site/qa.mjs
```

Optional `CAPPY_QA_ORIGIN` selects another preview URL. `CAPPY_DOCS_QA_ORIGIN` checks documentation on a separate origin, and `CAPPY_QA_OUTPUT` selects an output folder outside Git. Playwright Chromium must be installed. QA checks both home pages at phone, tablet, and desktop sizes; clipboard parity and denied-clipboard recovery; focus return; reduced motion; and computed page transformation by the actual extension. Screenshots and browser profiles are generated outside the repository.

## Film

Place an approved 12-second film at `site/public/cappy-film.mp4` before building to replace the glass still with a video player. The player never autoplays. The supplied mascot remains unchanged in both the site and glass treatment. Large generated media should use the project's approved artifact storage rather than being committed accidentally.

Artwork provenance and retained notices are in `site/THIRD_PARTY_NOTICES.md`, `site/public/brands/`, and `site/public/fonts/`.
