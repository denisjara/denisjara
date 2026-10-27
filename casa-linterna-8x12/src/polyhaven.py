"""Descarga recursos CC0 de Poly Haven (texturas PBR, modelos glTF y cielos HDRI) para el render.

Los archivos se guardan en blender/assets/ (no se versionan; se vuelven a descargar si faltan).
"""
import json
import os
import urllib.request

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "blender", "assets")
API = "https://api.polyhaven.com/files/"


def _get(url, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return dest
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "casa-linterna-render/1.0"})
    with urllib.request.urlopen(req, timeout=120) as r, open(dest + ".part", "wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    os.replace(dest + ".part", dest)
    return dest


def _files(asset):
    cache = os.path.join(ROOT, "_api", asset + ".json")
    if not os.path.exists(cache):
        os.makedirs(os.path.dirname(cache), exist_ok=True)
        req = urllib.request.Request(API + asset, headers={"User-Agent": "casa-linterna-render/1.0"})
        with urllib.request.urlopen(req, timeout=60) as r:
            open(cache, "wb").write(r.read())
    return json.load(open(cache))


def texture(asset, res="1k"):
    """Devuelve {'diff': ruta, 'nor': ruta, 'rough': ruta} (las que existan)."""
    info = _files(asset)
    out = {}
    for key, names in (("diff", ("Diffuse", "diff")), ("nor", ("nor_gl",)), ("rough", ("Rough", "rough"))):
        for n in names:
            if n in info and res in info[n]:
                fmt = "jpg" if "jpg" in info[n][res] else "png"
                url = info[n][res][fmt]["url"]
                out[key] = _get(url, os.path.join(ROOT, "tex", asset, os.path.basename(url)))
                break
    return out


def model(asset, res="1k"):
    """Descarga el glTF del modelo con sus texturas; devuelve la ruta del .gltf."""
    info = _files(asset)["gltf"][res]["gltf"]
    base = os.path.join(ROOT, "models", asset)
    path = _get(info["url"], os.path.join(base, os.path.basename(info["url"])))
    for rel, inc in info.get("include", {}).items():
        _get(inc["url"], os.path.join(base, rel))
    return path


def hdri(asset, res="2k"):
    info = _files(asset)["hdri"][res]["hdr"]
    return _get(info["url"], os.path.join(ROOT, "hdri", os.path.basename(info["url"])))


TEXTURES = ["painted_plaster_wall", "grey_plaster_02", "brushed_concrete", "concrete_floor_01", "laminate_floor_02",
            "marble_tiles", "anti_slip_concrete", "asphalt_02", "concrete_tiles", "corrugated_iron_02", "oak_veneer_01",
            "mocha_oak_veneer", "fabric_pattern_07", "marble_01", "floor_tiles_06", "plastered_wall_04"]
MODELS = ["sofa_02", "modern_arm_chair_01", "modern_coffee_table_01", "dining_chair_02", "potted_plant_01",
          "potted_plant_04", "bar_chair_round_01", "street_lamp_01", "outdoor_table_chair_set_01", "island_tree_02"]
HDRI = "kloofendal_48d_partly_cloudy_puresky"

if __name__ == "__main__":
    for t in TEXTURES:
        try:
            print("tex", t, list(texture(t)))
        except Exception as e:
            print("tex FAIL", t, e)
    for m in MODELS:
        try:
            p = model(m)
            print("model", m, round(sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(os.path.dirname(p)) for f in fs) / 1e6, 1), "MB")
        except Exception as e:
            print("model FAIL", m, e)
    print("hdri", hdri(HDRI))
