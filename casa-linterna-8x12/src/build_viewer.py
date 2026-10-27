"""Genera el visor 3D interactivo (three.js) a partir del modelo parametrico."""
import json, os, sys, base64
sys.path.insert(0, os.path.dirname(__file__))
from model import all_prisms, MATERIALS, build_rooms, LV

HERE = os.path.dirname(__file__)


def model_json():
    P = all_prisms()
    out = []
    for p in P:
        out.append({"x1": round(p.x1, 4), "x2": round(p.x2, 4),
                    "p": [[round(y, 4), round(z, 4)] for y, z in p.poly],
                    "m": p.mat, "c": p.cat, "l": p.level, "f": p.phase, "n": p.name, "g": p.group or ""})
    return out


def sheets_payload(sheet_dir):
    """Laminas (PNG) para la pestaña de planos, si ya fueron generadas."""
    items = []
    if not os.path.isdir(sheet_dir):
        return items
    for fn in sorted(os.listdir(sheet_dir)):
        if fn.endswith((".png", ".jpg")):
            with open(os.path.join(sheet_dir, fn), "rb") as fh:
                b64 = base64.b64encode(fh.read()).decode()
            mime = "image/png" if fn.endswith(".png") else "image/jpeg"
            items.append({"id": fn[:-4], "src": f"data:{mime};base64," + b64})
    return items


def build(out_path, sheet_dir=None, sheet_titles=None):
    data = model_json()
    sheets = sheets_payload(sheet_dir) if sheet_dir else []
    titles = sheet_titles or {}
    for s in sheets:
        s["t"] = titles.get(s["id"], s["id"])
    with open(os.path.join(HERE, "viewer_template.html"), encoding="utf-8") as fh:
        tpl = fh.read()
    html = (tpl.replace("/*__MODEL__*/[]", json.dumps(data, separators=(",", ":")))
               .replace("/*__MATS__*/{}", json.dumps(MATERIALS))
               .replace("/*__SHEETS__*/[]", json.dumps(sheets, separators=(",", ":"))))
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(html)
    print("visor:", out_path, f"{len(html)/1e6:.2f} MB", len(data), "elementos", len(sheets), "laminas")


if __name__ == "__main__":
    build(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "entregables", "visor-3d.html"))
