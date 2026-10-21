# Cappy product film

12 seconds, 1920x1080, 30 fps, deliberately silent. Four three-second scenes: purple Blender glass logo, real capture, event-anchored output from the same capture, install/site lockup.

The mascot texture remains unchanged. `SOURCES.json` contains the verified provenance and exact source hashes. The command is an illustrative valid invocation of the captured scenario; it is not a terminal recording. No slow-motion or replay claim is made.

## Prepare

Requires Blender 5.2+, Python 3 and FFmpeg. Original user-owned captures are kept separately; pass the directory containing the capture-ID folders. Preparation rejects mismatched hashes. The resulting media clips and render intermediates are ignored by Git.

```sh
python3 prepare.py --captures /path/to/captures --blender /path/to/blender
npm run check
npx hyperframes snapshot --at 1.5,4.5,7.5,10.5
npx hyperframes preview --background
```

Use `--skip-blender` only when the original 90-frame plate is already present. Scene source, local fonts and animation runtime are bundled. No render-time external network is needed.

## Delivery

The assembled preview was approved with "Render this version". Reproduce the verified delivery:

```sh
npm run render -- --quality delivery --output public/cappy-film.mp4
ffprobe -v error -show_format -show_streams public/cappy-film.mp4
```

The delivered MP4 is verified: 12.000 seconds, 1920x1080, 30 fps, 360 frames and no audio stream. First/last frames and all scene midpoints were decoded and visually inspected. The byte-identical curated file is copied to `../../site/public/cappy-film.mp4`; website deployment and playback are verified separately by the site workflow. See `QA.md` for the delivery hash.

## Third-party notices

`assets/geist.woff2` is Geist under OFL; see `assets/GEIST-OFL.txt`. `assets/gsap.min.js` is the unmodified GSAP 3.14.2 distribution, including its copyright and license URL in the file header. Cappy and its supplied artwork belong to their owner.
