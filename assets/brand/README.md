# Cappy artwork

The supplied camera mascot is the base identity. Keep its shape, proportions,
facets, colors, cap lettering and large C unchanged. Glass, lighting and motion
are presentation treatments around that artwork, not a mascot redesign.

| Asset | Use |
| --- | --- |
| [cappy-original.jpg](cappy-original.jpg) | Original supplied artwork, preserved byte for byte. |
| [cappy-transparent.png](cappy-transparent.png) | Full-color mascot with transparent exterior and internal cutouts. |
| [cappy.svg](cappy.svg) | Vector mascot made from filled paths; no embedded image or white background. |
| [cappy-glass-preview.png](cappy-glass-preview.png) | Blender preview of the unchanged mascot inside purple glass. |

Use the SVG or transparent PNG in the README, docs and site; use the glass
treatment in marketing imagery and film. Preserve aspect ratio and show the
entire mascot. Do not invert or recolor this full-color artwork for dark mode.

## Blender glass scene

Blender 5.2 or newer builds the scene without extra Python packages or downloads:

```sh
blender -b --factory-startup --python-exit-code 1 \
  -P scripts/brand/glass-logo.py -- --preview --size 1024 --samples 32
```

The reproducible source is [glass-logo.py](../../scripts/brand/glass-logo.py).
It creates `artifacts/brand/cappy-glass.blend` and a transparent PNG preview.
The scene packs the original transparent artwork and includes a six-second
gentle turn and reflection sweep, ready to use as a film plate. No video export
is claimed by this asset preparation. Generated scenes and frame sequences stay
outside Git; the script and inputs are the durable source.

The setup follows the glass-body, internal artwork, strip-light and controlled
reflection approach of the owner's Lil Gohan trailer. It uses a violet metal
backing, polished glass shell, smooth bevels and a thin-film rim. The mascot
texture is unmodified. Its lighting uses procedural studio lights, with no
external HDRI or other third-party artwork.

## Vector export

The transparent cutout was prepared from the supplied original; the SVG was
traced with VTracer 0.6.15 using color, stacked layers, spline paths,
`filter_speckle=8`, `color_precision=6`, `layer_difference=8`,
`corner_threshold=65`, `length_threshold=3`, `max_iterations=10`,
`splice_threshold=45` and `path_precision=2`. The SVG has a 1254-square viewBox.
The original JPEG is retained for comparison and future exports.
