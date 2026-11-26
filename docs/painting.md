# Kekborn v2 painting contract

1. **Paint every layer with an image model.** Use the locked prompt and the negative prompt from [the style guide](../style-guide.md) for every generation or edit. Append a layer-specific suffix to the locked prompt describing the subject, materials and placement. Keep both shared prompts intact. Never draw a layer by code or copy existing artwork. If no image model answers, leave the assigned files untouched and report what stopped you. **Reason.** The shared prompts keep the library in one Tudor court oil style, while the suffix gives each layer its own subject and preserves the collection's original design.

2. **Export full-canvas PNGs.** Every layer must be 2048 × 2560 pixels in straight-alpha RGBA8, readable by `decodePNG` from `src/raster`, and strictly under 7,900,000 bytes (7.9 MB). Verify decoding and byte size on the final export. If it is too large, soften high-frequency noise and recompress while preserving the painted forms and alpha edges. Keep varnish, craquelure, vignette and frame shadow out of every layer. **Reason.** A common format stacks without conversion or offsets. The shared finishing pass applies fine texture and surface effects across layer boundaries.

3. **Light every layer from the upper left.** Keep highlights, turning forms and cast shadows consistent across skin, fabric, metal, gems, props, backdrops, heraldry and frames. **Reason.** A single light direction lets independently painted objects read as parts of the same scene.

4. **Inpaint attire, headwear, regalia and props on the master bust.** Use [template/master-reference.png](../template/master-reference.png) as the edit reference. Cut out only the assigned item and its gloved hands where present. Keep softly antialiased edges and make the rest of the full canvas transparent, with none of the reference bust in the layer. Glove every visible hand. **Reason.** Painting in place aligns overlaps and lighting with the bust, and an isolated cut-out works across skin variants without carrying skin from the reference.

5. **Build faces from skin, eyes and paired expression layers.**
   - Paint the skin as the bust with opaque dark socket beds and a lipless muzzle.
   - Paint eyes that fill the registered sockets. Leave lids out of the eye layer.
   - Put lids, brow and cheeks in `<name>.skin.png` using moss skin colours. The compositor recolours this paint for the selected skin.
   - Put lips, teeth, tears and shadow glazes in `<name>.png`.

   **Reason.** Opaque beds support the eye paint, and pairing the expression layers lets the compositor match facial skin while preserving the colours of lips, teeth, tears and glazes.

6. **Keep every layer registered.** Use the landmarks and reserves in [the style guide](../style-guide.md) and [template/master-reference.json](../template/master-reference.json). Preserve the full master canvas and align the relevant features to their fixed positions, including sockets, mouth, crown seat, neck opening, shoulder line, frame aperture and heraldic clear space. Inspect the layer in a stacked preview at the intended placement. **Reason.** Fixed geometry makes layers interchangeable and prevents gaps, floating accessories and collisions with the arms.

7. **Record provenance and stay within the assigned scope.** Write `provenance/<target>.json` with the model, settings, seed, prompt suffix, edit reference, cut-out method, each delivered layer's path, byte count and SHA-256, and what you actually saw in a preview-size render. Look for lighting consistency, fit, cut-out edges and any visible remnants of the reference bust. Record when a model does not expose a setting or seed. Change only assigned files and put throwaway work in `test/scratch/`. Add no dependency or submodule and keep every delivered file strictly under 7,900,000 bytes. Deploy, mint and spend nothing. **Reason.** Provenance makes the painting and export reviewable, and the scope and size limits keep handoff compatible with the plain Node repository and parallel work.
