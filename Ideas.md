# Cappy Ideas

Valuable work intentionally outside the currently agreed V1 unless explicitly promoted.

## Desktop GUI

Add a desktop GUI for browsing projects, scenarios, sessions, takes, timelines, manifests, and capture media. The V1 CLI and structured JSON contracts should make a later GUI a client of the same core operations rather than a second implementation.

A first step was designed on 2026-09-25 and deferred by the owner: `cappy ui`, a read-only local viewer over the CLI's JSON. It would list items, play masters and triptychs with WebVTT event captions, and show manifests. It would bind to loopback with a per-launch token, and actions would stay in the CLI.

## Additional engine adapters

- Unity adapter.
- Unreal adapter.
- Native/custom-engine adapter templates.
- Emulator-specific adapters for systems such as DuckStation or Dolphin.

V1 preserves adapter boundaries without implementing these merely to prove generality. Titan, the owner's Windows machine, has Unity 2022.3.44f1 and Unreal Engine 5.2 installed, so a Unity adapter is feasible there; Unreal needs a C++ plugin and long builds.

## Linux OBS capture

Linux is a supported host (ADR-021), but real OBS capture on Linux is unverified. Verifying it would need OBS with a virtual display (for example Xvfb) or a Linux desktop host.

## Cinematic replay tooling

- camera rails;
- free camera;
- shot lists;
- automatic multi-angle passes.

Slow motion (`timeScale`) and alternate cameras (`camera`) as presentation parameters were promoted as ADR-022.

The V1 capability model can preserve room for these without requiring a cinematic editor.

## Remote/distributed capture

Run Cappy controllers or capture workers on another machine, CI host, or dedicated capture rig.

## Additional recording backends

Direct FFmpeg/window capture or platform-native capture APIs could become alternative recorders if OBS proves insufficient.

## Managed tool binaries

Optionally install/pin FFmpeg or other helper binaries rather than requiring them to be available on the host.
