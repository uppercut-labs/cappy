# CAP-032 Local capture MCP

Status: done; verified in source and the installed 1.0.1 release candidate.

Expose typed local tools through `cappy mcp` using existing command behavior,
structured results, cancellation and cleanup. Inventory discovers stored IDs;
recording is bounded; cleanup previews and explicit deletion are separate.

Acceptance: SDK client discovery and calls, simulator/fake-OBS capture/replay,
inventory, missing-config/invalid/empty behavior, cancellation, disconnect and
installed executable checks. Thirteen focused MCP cases pass; final package
and full-suite evidence is recorded in the launch handoff.
