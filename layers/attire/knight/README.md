# Knight court ensemble

Two full-canvas, transparent **2048 × 2560, straight RGBA8, sRGB** layers, registered to `template/bust.svg`.

| Asset ID | Slot | Category | File |
| --- | --- | --- | --- |
| `attire-front.knight-armour` | `attire-front` | `knight` | [armour](attire-front.knight-armour.png) |
| `prop-front.knight-gauntlet` | `prop-front` | `knight` | [gauntlet](prop-front.knight-gauntlet.png) |

The armour has a fitted silver gorget, a ridged breastplate, fluted light-side planes, overlapping shoulder lames, rivets, mail gussets and a restrained oxblood arming coat. The far pauldron is smaller; the near shoulder is higher and broader. The gauntlet has individually jointed fingers, an opposed thumb, telescoping wrist lames and a flared cuff joining the near forearm. It rests across the lower breastplate.

Paint follows the guide's silver/silver-shadow, forest, umber and warm-bone mixtures, with small ochre leather details. Directional bristle marks follow the plates and fingers. The key light comes from the upper left. Varnish, craquelure and frame shadow are absent; the shared compositor applies them once.

Both shoulder landmarks `(365,1760)` / `(1575,1712)` are covered. The gorget cups the front of the `(978,1600)` neck ellipse and leaves the throat landmark `(978,1536)` visible. Flexible mail and padding accommodate the moss foundation's broader neck. Both shield clear spaces and all facial sightlines remain clear.

Fit proofs, using the supplied moss skin and common frame:

- [Whole portrait](review/moss-common-fit.jpg), at 50% display size.
- [Collar, shoulders and gauntlet detail](review/armour-detail.jpg), at master resolution.
- [Template overlay](review/registration.jpg), with attire and prop at 50% opacity and guides read from the shared SVG.

The plain umber field is only a review backdrop. The foundation's eye sockets are shown as supplied; these proofs contain no eye, expression, headwear, banner, arms or finishing layers. The gauntlet is fitted to this armour. Other skins and frames were unavailable for fit checks. No known fit or export defect remains on moss/common.

The catalog is `catalog/attire-knight.json`. Only its two PNG records are compositor layers; the JPEGs and source files are review/authoring material.

Repaint locally with `python3 layers/attire/knight/source/paint.py` from the repository root. The authored curves, material mixtures and seeded bristle marks are in [source/paint.py](source/paint.py). The export was made with Python 3.13, Pillow 13.0.0, NumPy 2.5.5 and aggdraw 1.4.1. Identical versions and unchanged foundation inputs reproduce the PNG bytes.

Run `node layers/attire/knight/source/verify.cjs` to check the catalog, PNG CRCs and RGBA8 format, alpha edges, aperture, reserves, sightlines, attachment landmarks and complete gauntlet support. The checker uses the repository's own PNG decoder and requires no additional Node dependency.
