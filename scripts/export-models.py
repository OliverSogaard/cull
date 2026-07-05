#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "torch>=2.4", "transformers>=4.44", "onnx>=1.16",
#   "onnxruntime>=1.19", "onnxconverter-common>=1.14",
#   "open_clip_torch>=2.26", "pillow>=10", "numpy>=1.26", "requests>=2.31",
# ]
# ///
"""One-off exporter for CULL's Tier-2 phase 3d/3c models (dev-only, never shipped).

Exports from OFFICIAL weights and parity-checks every ONNX graph against the
PyTorch original on real corpus previews BEFORE anything is committed:
  - DINOv2-small  (facebook/dinov2-small, Apache-2.0)  -> dinov2s.onnx (fp16)
  - CLIP ViT-B/32 image tower (openai, MIT via open_clip) -> clip_vitb32_visual.onnx (fp16)
  - LAION improved-aesthetic-predictor head (Apache-2.0)  -> laion_aesthetic.onnx (fp32, tiny)

Usage:  CULL_TEST_JPEG_DIR=<dir with a few .jpg previews> ./scripts/export-models.py
Gates:  embedding cosine >= 0.999, |aesthetic delta| < 0.05, else non-zero exit.
"""
import hashlib, os, sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch
from PIL import Image

OUT = Path(__file__).resolve().parent.parent / "src-tauri" / "models"
SAMPLES_DIR = os.environ.get("CULL_TEST_JPEG_DIR")

def sample_images(n=5):
    if not SAMPLES_DIR:
        sys.exit("set CULL_TEST_JPEG_DIR to a folder of real preview JPEGs")
    paths = sorted(Path(SAMPLES_DIR).glob("*.jpg"))[:n]
    if len(paths) < 3:
        sys.exit(f"need >=3 jpegs in {SAMPLES_DIR}, found {len(paths)}")
    return [Image.open(p).convert("RGB").resize((224, 224), Image.BILINEAR) for p in paths]

def to_tensor(img, mean, std):
    x = np.asarray(img, dtype=np.float32) / 255.0
    x = (x - np.array(mean, dtype=np.float32)) / np.array(std, dtype=np.float32)
    return torch.from_numpy(x.transpose(2, 0, 1)[None])  # [1,3,224,224]

_NONFLOAT_NODE_OUTPUTS = {
    "Shape": 7, "NonZero": 7, "Size": 7, "ArgMax": 7, "ArgMin": 7,  # -> INT64
    "Equal": 9, "Greater": 9, "Less": 9, "GreaterOrEqual": 9,       # -> BOOL
    "LessOrEqual": 9, "And": 9, "Or": 9, "Not": 9,
}

# Ops whose outputs are heterogeneous in type -- NOT every output shares the
# node's float-domain type. Each entry is a list of per-output overrides in
# ONNX output order; `None` in a slot means "use the node's derived float
# out_type" (the primary, data-carrying output). A concrete TensorProto code
# means that output is fixed and must never be blanket-assigned the node's
# harmonized float type. Any multi-output op NOT listed here raises instead
# of being silently (and possibly wrongly) mistyped -- see the hard guard
# below.
_MULTI_OUTPUT_FIXED_TYPES = {
    "Dropout": [None, 9],  # [output: same dtype as input], mask: BOOL
    "TopK": [None, 7],     # [Values: same dtype as input], Indices: INT64
}

def harmonize_fp16_types(model):
    """Fix mismatched float32/float16 node inputs left by onnxconverter_common.

    Adaptation from the brief: with keep_io_types=True, onnxconverter_common
    does not always insert a Cast where a still-float32 tensor (the graph
    input itself, or a value it deliberately kept in float32 -- e.g. Resize's
    bicubic path) flows into a node that now expects float16 (its weights or
    sibling inputs got converted). onnxruntime's loader/executor rejects the
    resulting type mismatch outright (observed on the patch-embedding Conv
    and on the Concat that re-joins the position-embedding path in both
    DINOv2 and CLIP's visual tower).

    ONNX graphs are topologically ordered (producers before consumers), and
    ONNX ops require exact type agreement between float-ish inputs (no
    implicit promotion), so a single forward pass that tracks each tensor's
    known element type and inserts a Cast(FLOAT->FLOAT16) wherever a node
    mixes FLOAT and FLOAT16 inputs is sufficient to resolve every such
    mismatch.

    IMPORTANT -- this deliberately overrides onnxconverter_common's intent.
    `convert_float_to_float16(..., keep_io_types=True)` leaves certain
    subgraphs in float32 ON PURPOSE (e.g. the Resize/bicubic path), precisely
    to preserve numerical precision where it judged fp16 unsafe. This pass
    downcasts those tensors to float16 anyway at every mixed-type boundary,
    which is a real loss of the precision onnxconverter_common intentionally
    preserved. That tradeoff is accepted ONLY because the consuming contract
    here is coarse: cosine-similarity comparisons at ~0.92 granularity
    (embedding similarity) and aesthetic score deltas of |delta| < 0.05 --
    both gated by this same script's parity checks before export succeeds.
    This is NOT a general-purpose harmonizer; do not reuse it on a graph
    whose consumer needs float32-grade precision without re-validating that
    the parity gates it relies on still make sense for that use case.
    """
    from onnx import TensorProto, helper
    FLOAT, FLOAT16 = TensorProto.FLOAT, TensorProto.FLOAT16
    g = model.graph
    type_of = {}
    for i in g.input:
        elem_type = i.type.tensor_type.elem_type
        if elem_type:
            type_of[i.name] = elem_type
    for init in g.initializer:
        type_of[init.name] = init.data_type

    new_nodes = []
    cast_cache = {}
    for n in g.node:
        in_types = [(inp, type_of.get(inp)) for inp in n.input if inp != ""]

        if len(n.output) > 1 and n.op_type not in _MULTI_OUTPUT_FIXED_TYPES:
            raise RuntimeError(
                f"harmonize_fp16_types: unhandled heterogeneous-output op "
                f"'{n.op_type}' ({n.name or '<unnamed>'}) with "
                f"{len(n.output)} outputs. Blanket-assigning this node's "
                f"float out_type to every output would silently mistype "
                f"non-float outputs (e.g. Dropout's mask, TopK's indices). "
                f"Add '{n.op_type}' to _MULTI_OUTPUT_FIXED_TYPES with each "
                f"output's true type before exporting a graph containing it."
            )

        if n.op_type == "Cast":
            out_type = next(a.i for a in n.attribute if a.name == "to")
        elif n.op_type == "Constant":
            out_type = FLOAT
            for a in n.attribute:
                if a.name == "value" and a.t.data_type:
                    out_type = a.t.data_type
        elif n.op_type in _NONFLOAT_NODE_OUTPUTS:
            out_type = _NONFLOAT_NODE_OUTPUTS[n.op_type]
        else:
            float_types = {t for _, t in in_types if t in (FLOAT, FLOAT16)}
            if len(float_types) > 1:
                for tensor_name, t in in_types:
                    if t != FLOAT:
                        continue
                    cast_out = cast_cache.get(tensor_name)
                    if cast_out is None:
                        cast_out = f"{tensor_name}__harmonize_fp16"
                        new_nodes.append(helper.make_node(
                            "Cast", [tensor_name], [cast_out], to=FLOAT16,
                            name=f"{tensor_name}_harmonize_cast",
                        ))
                        type_of[cast_out] = FLOAT16
                        cast_cache[tensor_name] = cast_out
                    for idx, val in enumerate(n.input):
                        if val == tensor_name:
                            n.input[idx] = cast_out
                out_type = FLOAT16
            else:
                out_type = next((t for _, t in in_types if t is not None), None)

        if n.op_type in _MULTI_OUTPUT_FIXED_TYPES:
            fixed = _MULTI_OUTPUT_FIXED_TYPES[n.op_type]
            for idx, o in enumerate(n.output):
                fixed_t = fixed[idx] if idx < len(fixed) else None
                type_of[o] = fixed_t if fixed_t is not None else out_type
        else:
            for o in n.output:
                if out_type is not None:
                    type_of[o] = out_type
        new_nodes.append(n)
    del g.node[:]
    g.node.extend(new_nodes)
    # Stale intermediate value_info entries (declared dtype from the
    # pre-conversion fp32 graph) can now disagree with actual node output
    # dtypes; onnxruntime's loader validates declared value_info against
    # actual node output types, so drop the stale annotations and let it
    # re-derive types itself at load time.
    del g.value_info[:]
    return model

def fp16_convert(path):
    """Convert to fp16 with fp32 I/O (keep_io_types=True), then repair any
    float32/float16 type mismatches onnxconverter_common's conversion leaves
    behind (see harmonize_fp16_types)."""
    import onnx
    from onnxconverter_common import float16
    m = onnx.load(str(path))
    m = float16.convert_float_to_float16(m, keep_io_types=True)
    m = harmonize_fp16_types(m)
    onnx.save(m, str(path))

def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def cosine(a, b):
    a, b = a.flatten(), b.flatten()
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))

def freeze_dinov2_pos_encoding(model):
    """Bake DINOv2's position-embedding interpolation in as a constant.

    Adaptation from the brief's starting point: DINOv2-small's pretrained
    position embeddings are for a 518x518 (37x37-patch) grid, so for our
    FIXED 224x224 (16x16-patch) contract, transformers.modeling_dinov2
    always bicubic-interpolates them down to 16x16 -- and that interpolation
    depends only on the (fixed) target height/width and the frozen
    position_embeddings parameter, never on image content. Exporting the
    dynamic interpolation as a graph subgraph hits a real onnxruntime CPU
    Resize-kernel limitation (dynamically-computed bicubic scale factors on
    4-D tensors raise a ScalesValidation error at run time, independent of
    fp16 conversion). Precomputing it once and monkey-patching it in as a
    constant is bit-exact vs. the reference model (which recomputes the same
    content-independent value on every call) and yields a smaller,
    fp16-conversion-friendly graph.
    """
    emb_mod = model.embeddings
    num_patches = (224 // emb_mod.patch_size) ** 2
    with torch.no_grad():
        dummy_tokens = torch.zeros(1, num_patches + 1, emb_mod.position_embeddings.shape[-1])
        orig_interp = type(emb_mod).interpolate_pos_encoding
        fixed_pos_embed = orig_interp(emb_mod, dummy_tokens, 224, 224)

    def _fixed_interp(self, embeddings, height, width):
        return fixed_pos_embed

    emb_mod.interpolate_pos_encoding = _fixed_interp.__get__(emb_mod, type(emb_mod))

def export_dinov2(imgs):
    from transformers import AutoModel
    model = AutoModel.from_pretrained("facebook/dinov2-small").eval()
    mean, std = [0.485, 0.456, 0.406], [0.229, 0.224, 0.225]

    # Compute references from the TRUE UNPATCHED model first. Doing this
    # after freeze_dinov2_pos_encoding() would make the parity check
    # circular -- it would only prove ONNX ~= patched-model, never ONNX ~=
    # the real pretrained original, since both sides of the comparison
    # would share the same monkey-patched interpolate_pos_encoding.
    pre_patch_refs = []
    for img in imgs:
        x = to_tensor(img, mean, std)
        with torch.no_grad():
            pre_patch_refs.append(model(pixel_values=x).last_hidden_state[0, 0].numpy())

    freeze_dinov2_pos_encoding(model)

    # Sanity-check the patch itself: it must reproduce the unpatched model's
    # output on every sample before we trust it as the export source. This
    # is the guard that makes the freeze safe to rely on -- if a future
    # transformers version changes interpolate_pos_encoding's semantics,
    # this fails loudly instead of silently shipping a diverged graph.
    patch_worst = 1.0
    for img, pre_ref in zip(imgs, pre_patch_refs):
        x = to_tensor(img, mean, std)
        with torch.no_grad():
            post_ref = model(pixel_values=x).last_hidden_state[0, 0].numpy()
        patch_worst = min(patch_worst, cosine(pre_ref, post_ref))
    assert patch_worst >= 0.99999, (
        f"freeze_dinov2_pos_encoding DIVERGED from the unpatched model: "
        f"worst cosine {patch_worst} (expected >= 0.99999 -- bit-exact)"
    )

    path = OUT / "dinov2s.onnx"
    ex = to_tensor(imgs[0], mean, std)
    torch.onnx.export(
        model, (ex,), str(path), input_names=["pixel_values"],
        output_names=["last_hidden_state"], opset_version=17,
        dynamo=False,
    )
    fp16_convert(path)
    sess = ort.InferenceSession(str(path))

    # Parity gate against the PRE-PATCH references (the true original),
    # never against the patched model's own output.
    worst = 1.0
    for img, pre_ref in zip(imgs, pre_patch_refs):
        x = to_tensor(img, mean, std)
        out = sess.run(None, {"pixel_values": x.numpy()})[0][0, 0]
        worst = min(worst, cosine(pre_ref, out))
    assert worst >= 0.999, f"DINOv2 parity FAILED: worst cosine {worst}"
    print(f"dinov2s.onnx  OK  worst-cosine={worst:.5f}  sha256={sha256(path)}")

def export_clip(imgs):
    import open_clip
    model, _, _ = open_clip.create_model_and_transforms("ViT-B-32", pretrained="openai")
    model = model.eval()
    visual = model.visual
    mean = [0.48145466, 0.4578275, 0.40821073]
    std = [0.26862954, 0.26130258, 0.27577711]
    path = OUT / "clip_vitb32_visual.onnx"
    ex = to_tensor(imgs[0], mean, std)
    torch.onnx.export(
        visual, (ex,), str(path), input_names=["pixel_values"],
        output_names=["embedding"], opset_version=17, dynamo=False,
    )
    fp16_convert(path)
    sess = ort.InferenceSession(str(path))
    worst = 1.0
    embeds = []
    for img in imgs:
        x = to_tensor(img, mean, std)
        with torch.no_grad():
            ref = visual(x)[0].numpy()
        out = sess.run(None, {"pixel_values": x.numpy()})[0][0]
        worst = min(worst, cosine(ref, out))
        embeds.append(ref)
    assert worst >= 0.999, f"CLIP parity FAILED: worst cosine {worst}"
    print(f"clip_vitb32_visual.onnx  OK  worst-cosine={worst:.5f}  sha256={sha256(path)}")
    return embeds

def export_laion_head(clip_embeds):
    import requests
    # Official weights from LAION-AI/aesthetic-predictor (improved v1, ViT-B/32 head).
    url = ("https://github.com/LAION-AI/aesthetic-predictor/raw/main/"
           "sa_0_4_vit_b_32_linear.pth")
    w = Path("/tmp/laion_vitb32_head.pth")
    if not w.exists():
        resp = requests.get(url, timeout=60)
        resp.raise_for_status()
        w.write_bytes(resp.content)
    head = torch.nn.Linear(512, 1)
    head.load_state_dict(torch.load(w, map_location="cpu", weights_only=True))
    head = head.eval()
    path = OUT / "laion_aesthetic.onnx"
    ex = torch.randn(1, 512)
    torch.onnx.export(head, (ex,), str(path), input_names=["embedding"],
                      output_names=["score"], opset_version=17, dynamo=False)
    sess = ort.InferenceSession(str(path))
    worst = 0.0
    for e in clip_embeds:
        x = torch.from_numpy(e[None] / np.linalg.norm(e))  # L2-normalized input!
        with torch.no_grad():
            ref = float(head(x)[0, 0])
        out = float(sess.run(None, {"embedding": x.numpy()})[0][0, 0])
        worst = max(worst, abs(ref - out))
        print(f"  aesthetic sample: {ref:.3f}")
    assert worst < 0.05, f"LAION head parity FAILED: worst delta {worst}"
    print(f"laion_aesthetic.onnx  OK  worst-delta={worst:.5f}  sha256={sha256(path)}")

if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    imgs = sample_images()
    export_dinov2(imgs)
    embeds = export_clip(imgs)
    export_laion_head(embeds)
    print("ALL PARITY CHECKS PASSED")
