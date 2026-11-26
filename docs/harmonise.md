# Optional portrait harmonisation

Plain rendering works offline and never needs an image model. Harmonisation is a
separate step after the compositor's finishing pass.

```sh
node bin/render.cjs sample-inputs/01.json plain.png
node bin/harmonise.cjs request plain.png request.json
```

Open `request.json` and give the image-to-image model the PNG named by `input`,
the locked `prompt`, and the separate `negativePrompt`. Set its image-to-image
strength (often called denoising strength) to **0.22** and its seed to **1536**.
Choose a model that exposes these controls. Strength must never exceed 0.30.
Keep the full **2048 × 2560** canvas aligned with the input. If the model
supports masking, use the `aperture` rectangle as the editable area on the
full canvas. Its origin is the top left, and the right and bottom bounds are
exclusive. Export the result as an sRGB PNG. Reproducing the model step also
requires recording the model, version and any other generation settings.

```sh
node bin/harmonise.cjs apply plain.png model.png harmonised.png
```

Use the same plain PNG as for the request. Both inputs must be 2048 × 2560.
The apply step runs offline. It mixes up to 22% of the model RGB into the
plain RGB, scaled by model opacity. The mix ramps smoothly from zero at
the aperture boundary to its full weight 64 pixels inward. The plain alpha
channel stays intact. All four decoded pixel bytes on the frame rails,
including the plaque and rail arms, stay identical to the plain PNG.
The output is re-encoded as a PNG and is byte-reproducible from the same
inputs with the same Node and zlib versions.
