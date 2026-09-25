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

## Automated regression comparison

Replay the same session across two builds, capture synchronized frames, and produce image/video comparisons for visual regression review.

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
