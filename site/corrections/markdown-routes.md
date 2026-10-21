# Preserve resource routes when rendering Markdown

Trigger: the human docs renderer initially changed every local Markdown URL into an HTML page URL.

Evidence: the downloadable skill at `skill/SKILL.md` is a raw resource, not a generated human page. A blanket rewrite would have pointed it to an absent directory.

Repair: rewrite only the explicit generated page registry. Leave nested skill resources as raw Markdown.

Verification: build the site, follow the skill link, and retrieve its adjacent references. Audit all local links against built files.

Guardrail: use a route registry when a site serves both human pages and agent instruction resources.
