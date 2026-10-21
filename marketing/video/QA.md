# Film review

Production playback passed on phone and desktop: controls and poster are
visible, playback starts only on request, and seeking reaches exactly 6 and
10.5 seconds. The first shows gameplay and the second the glass closing slate.
The Worker returns HTTP 206 with the requested bytes and correct range headers.

Prepared: four scenes, 12 seconds, 1920x1080, 30 fps, silent.

- Blender rendered 90 frames at 900x900, 16 samples with denoising. The packed texture is the unchanged supplied Cappy cutout. Opening and closing use the same physical plate.
- Both original gameplay source SHA-256 values matched their successful Cappy manifest. `SOURCES.json` records the capture and event-anchored knockdown window.
- `hyperframes check --strict` passed with zero lint, runtime, layout, contrast or motion findings. Motion assertions ran at 241 samples; contrast passed all 13 sampled text checks.
- Midpoint snapshots at 1.5, 4.5, 7.5 and 10.5 seconds were visually reviewed. The glass, original mascot, gameplay, command, event-output label and closing install/site credit are legible and unclipped.
- The animation map's static windows refer to held text; actual gameplay and the pre-rendered logo plate continue moving. Video behind labels is intentional layering. Decoded-MP4 verification is recorded below.
- One repeated snapshot pass omitted the logo media while a subsequent unchanged two-frame pass displayed it correctly. The source plate decodes correctly and has 90 frames / 3 seconds. That run triggered explicit decoded first/last and scene-midpoint film verification, completed below.
- Public source was scanned for personal filesystem paths and internal addresses; none were found. Font license is retained; the unmodified animation runtime retains its own license header.

## Delivered

The user approved the final assembled preview with "Render this version". Final render used pinned HyperFrames 0.8.181, hardware GPU screenshot capture, 4 workers, and completed in approximately 10 seconds.

- `public/cappy-film.mp4`: 7,183,731 bytes; SHA-256 `64247a73c7a8e57ed732e261f4111eda667b46a8a5a0de1446d3ca1b29deb1da`.
- FFprobe confirms one H.264 video stream, 1920x1080, 30/1 fps, 360 frames, exactly 12.000000 seconds. No audio stream.
- Decoded frames 0, 45, 135, 225, 315 and 359 were inspected as a six-frame contact sheet. The physical glass plate is present at first frame, opening midpoint, closing midpoint and last frame; gameplay and event-output scenes are present at their midpoints. No missing logo, black frame, clipped type or malformed artwork was found.
- Source clips now use 1-second GOPs (`-g 30 -keyint_min 30 -sc_threshold 0`), removing sparse-keyframe warnings and improving preview seeking. The glass plate has explicit BT.709 conversion/tags; the composition's matte matches the decoded plate within one RGB level in the delivered encode.
- The final was copied to `../../site/public/cappy-film.mp4` and its SHA-256 rechecked byte-for-byte.
- Decoded contact sheet: `public/delivery-qc/contact-sheet.jpg`; machine-readable probe: `public/delivery-qc/probe.json` (local, ignored).

Website deployment/playback verification belongs to the site workflow. The source and delivery media remain locally available; no external-disk backup was attempted because its backup mount is unavailable.
