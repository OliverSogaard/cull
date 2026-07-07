# Third-party model notices

CULL's smart-culling tier bundles (or fetches at build time) the following
pre-trained models, converted to ONNX by `scripts/export-models.py` with
parity gates against the original weights. Each model remains under its
original license; nothing here changes CULL's own MIT license (see
[LICENSE](LICENSE)).

## DINOv2-small

- **Source:** `facebook/dinov2-small` (Meta AI), via Hugging Face —
  https://huggingface.co/facebook/dinov2-small
- **License:** Apache-2.0
- **Use in CULL:** burst-level image-similarity embeddings.
- **Shipped as:** `dinov2s.onnx` (fp16 export), bundled in `src-tauri/models/`.

## CLIP ViT-B/32 (visual tower)

- **Source:** OpenAI CLIP ViT-B/32 image tower, exported via `open_clip`
  (MIT) — https://github.com/mlfoundations/open_clip /
  https://github.com/openai/CLIP
- **License:** MIT
- **Use in CULL:** image embeddings feeding the aesthetic head.
- **Shipped as:** `clip_vitb32_visual.onnx` (fp16 export, ~175 MB) — not
  tracked in git; fetched sha256-pinned from the `models-v1` GitHub release
  by `scripts/fetch-models.sh`.

## LAION improved-aesthetic-predictor (head)

- **Source:** LAION improved-aesthetic-predictor linear head —
  https://github.com/christophschuhmann/improved-aesthetic-predictor
- **License:** Apache-2.0
- **Use in CULL:** aesthetic scoring on top of CLIP embeddings.
- **Shipped as:** `laion_aesthetic.onnx` (fp32, tiny), bundled in
  `src-tauri/models/`.

## YuNet face detection (2023mar)

- **Source:** OpenCV Zoo, `face_detection_yunet_2023mar.onnx` —
  https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet
- **License:** MIT
- **Use in CULL:** face detection for the smart-culling face/eye signals.
- **Shipped as:** `face_detection_yunet_2023mar.onnx`, bundled in
  `src-tauri/models/`.

## OCEC (Open/Closed Eye Classification)

- **Source:** https://github.com/PINTO0309/OCEC
- **License:** MIT
- **Use in CULL:** eyes-open probability on eye crops around YuNet landmarks.
- **Shipped as:** `ocec_s.onnx`, bundled in `src-tauri/models/`.
