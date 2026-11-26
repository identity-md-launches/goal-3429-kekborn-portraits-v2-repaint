# Shared oil-paint finish

`require('./src/raster/index.cjs').finish(image, seedBytes)` synchronously mutates
and returns the supplied straight-RGBA8 raster. Apply it **once, after all layers,
heraldry and the frame**, before `encodePNG`. The existing two-argument compositor
call enables every stage. This procedural surface treatment complements the
image-model-painted layers; it does not generate or repaint their subject matter.

All effects use stored sRGB display values. Let `L` be the **original** pixel's
luminance `(0.2126R + 0.7152G + 0.0722B) / 255`, independent of alpha. Using the
same original luminance throughout keeps the later effects from reacting to
texture noise or twice weighting the glaze. Intermediate RGB stays floating
point; clamp to 0–255 and round only at the final write.

## Order and strengths

These named constants are exported from `src/raster/index.cjs`. Tint arrays are
frozen. The order is deliberate: colour glazes under the surface relief and
varnish, cracks in the aged surface, then the frame's cast shadow over everything.

| Stage | Exported settings | Operation and reason |
|---|---|---|
| 1. Warm glaze | `GLAZE_STRENGTH = 0.16`; `GLAZE_TINT = [180,120,64]` (`#B47840`) | Multiply toward ochre/umber with opacity `0.16(1−L)²`. This deepens and warms shadows across layer boundaries, while leaving white unchanged and never lifting black. |
| 2. Brush texture | `BRUSH_STRENGTH = 0.03`; `CANVAS_WEAVE_WEIGHT = 0.30`; `STROKE_RELIEF_WEIGHT = 0.70` | Neutral lightness modulation from canvas weave and seeded stroke relief. Multiply RGB by `1 + 0.03T·4L(1−L)`, with `T` bounded to −1…1. The maximum modulation is ±3%; black and white are protected. It unifies surface texture while preserving painted forms and colour. |
| 3. Warm varnish | `VARNISH_STRENGTH = 0.06`; `VARNISH_HIGHLIGHT_STRENGTH = 0.01`; `VARNISH_TINT = [224,184,112]` (`#E0B870`) | Multiply with opacity `0.06 + 0.01L²`. The restrained amber film gives highlights slightly more yellowing without an additive wash lifting the shadows. |
| 4. Fine craquelure | `CRAQUELURE_STRENGTH = 24` **mask-byte units**; `CRAQUELURE_TINT = [42,30,23]` (`#2A1E17`) | Blend toward warm umber with opacity `mask/255 · (1−L)²`. Fine antialiased lines reach at most 24/255 before shadow weighting. Intersections use maximum coverage, never accumulated ink, so they do not become black knots. |
| 5. Frame inner shadow | `FRAME_SHADOW_STRENGTH = 0.23`; `FRAME_SHADOW_FADE = 44` **master pixels** | Up to 23% darkening inside the opening, fading smoothly from its top and left rails. Applying it last places the finished paint beneath the frame. |

For either multiply tint, each channel `C` becomes
`C · (1 − opacity + opacity · tintChannel/255)`.

## Texture, light and registration

The canvas weave has 6-pixel warp and 7-pixel weft periods at master size, with
seeded phases. Stroke relief comes from a small seeded height field with
18×72-master-pixel cells slanted down-right by `x += 0.28y`. Smooth cubic
interpolation and a directional height derivative illuminate slopes facing the
upper-left key. The weighted texture contains coherent elongated marks rather
than independent pixel noise. It supplements the brushwork already in each layer.

Texture coordinates use the [2048×2560 bust grid](../template/bust.svg). Weave and
relief fade out between four and two output pixels per shortest period, avoiding
moire in small previews. Craquelure retains the existing seeded, irregular net
with roughly one-output-pixel antialiased hairlines; cell spacing is
`max(8, round(min(width,height)/38))` output pixels.

The frame opening is the exported, frozen `FRAME_APERTURE`:
`[144,1904) × [144,2368)` in master coordinates. Map output pixel centres to that
grid independently on each axis. Inside it, set `d = min(x−144, y−144)`.
For `d < 44`, multiply RGB by `1 − 0.23t²(3−2t)`, where `t = 1−d/44`.
Elsewhere the shadow multiplier is 1. The nearest casting edge wins; the
top-left corner does not double the shadow. The right and bottom edges only
clip the opening: they cast no independent shadow. No frame rail receives this
shadow, including the lower shield and plaque reserves. Other finish stages
still affect painted rails.

## Determinism and coverage

Use a nonempty `Uint8Array` seed; `Buffer` and sliced views are accepted. SHA-256
seeds separate deterministic streams under `kekborn/brush/v1\0` and
`kekborn/craquelure/v1\0`. Brush generation cannot shift the crack stream, and
neither stream depends on which pixels are transparent. No clock, external
randomness, network, image model or dependency is used. Identical pristine input,
dimensions, seed and switches yield identical RGBA and encoded PNG bytes in the
same runtime, including across fresh Node processes. Reapplying `finish` to an
already finished raster compounds the treatment; keep pristine input for reruns.

Every alpha byte is preserved, including partial coverage. A pixel with alpha 0
is skipped entirely, retaining its hidden RGB. Partially covered pixels receive
the same straight-RGB treatment as opaque paint at the same position; coverage
neither weakens the effect nor creates an edge halo.

For stage comparisons, an optional third argument accepts boolean switches
`glaze`, `brush`, `varnish`, `craquelure` and `frameShadow`. Omitted switches are
true. For example, `finish(image, seed, {brush:false})` disables only texture.
Setting all five false leaves the bytes unchanged. Unknown keys, nonboolean
values and invalid seeds fail before mutation. Production rendering should keep
the two-argument call so every portrait receives the same treatment.

## Checks and cost

`node --test test/raster/finish.test.cjs test/raster/core.test.cjs` checks repeatable
RGBA/PNG bytes, each stage's measurable contribution, restrained and coherent
brush relief, shadow weighting, warm pigment, full alpha/hidden-RGB preservation,
the top/left shadow rule and its scaled boundaries. The existing cross-process
test renders the full master size. Run `node --test test/*/*.test.cjs` for the
catalog, compositor and heraldry integration checks as well.

The pass is linear in pixel count. Additional storage is one byte per output
pixel for the crack mask, a small stroke grid, and two one-dimensional weave
arrays; there are no full floating-point image copies. A local default
2048×2560 pass over opaque paint measured about **1.45 seconds**, excluding PNG
encoding, comfortably within the approximately ten-second budget. Timing varies
with hardware and load, so it is measured separately from functional assertions.
