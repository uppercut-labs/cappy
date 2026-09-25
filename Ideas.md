# Cappy Ideas

Valuable work intentionally outside the currently agreed V1 unless explicitly promoted.

## Desktop GUI

Add a desktop GUI for browsing projects, scenarios, sessions, takes, timelines, manifests, and capture media. The V1 CLI and structured JSON contracts should make a later GUI a client of the same core operations rather than a second implementation.

## Additional engine adapters

- Unity adapter.
- Unreal adapter.
- Native/custom-engine adapter templates.
- Emulator-specific adapters for systems such as DuckStation or Dolphin.

V1 preserves adapter boundaries without implementing these merely to prove generality.

## Linux host acceptance

Avoid Windows/macOS assumptions that would make Linux expensive later, but do not make Linux installation or acceptance a V1 release gate.

The owner's Mac has OrbStack, so a Linux container can run the suite, real FFmpeg, and headless Godot without a separate host. Real OBS on headless Linux would need a virtual display.

## Cinematic replay tooling

- camera rails;
- alternate replay cameras;
- free camera;
- slow motion;
- shot lists;
- automatic multi-angle passes.

The V1 capability model can preserve room for these without requiring a cinematic editor.

## Remote/distributed capture

Run Cappy controllers or capture workers on another machine, CI host, or dedicated capture rig.

## Additional recording backends

Direct FFmpeg/window capture or platform-native capture APIs could become alternative recorders if OBS proves insufficient.

## Managed tool binaries

Optionally install/pin FFmpeg or other helper binaries rather than requiring them to be available on the host.

## Shared timeline interchange

Cappy-produced timelines may eventually be consumable by separate replay/commentary-review tools. Keep the event envelope exportable without coupling Cappy to that future application.

## Cross-build replay orchestration

`cappy compare` compares two existing captures (ADR-015). A later version could run one session's replay against two configured builds itself, then compare the results in one command.

## Comparison gates beyond mean SSIM

Gate on per-frame SSIM (a glitch on a single frame), on regions of interest, or on the timeline diff (missing events or drift beyond a tolerance). The first version gates only on mean SSIM, and the timeline diff is informational.

## One clip per matching event

An `occurrence: "every"` anchor mode, producing one clip per matching event (`highlight-1`, `highlight-2`, …), for montages. The first version produces one output per preset derivative (ADR-014).
