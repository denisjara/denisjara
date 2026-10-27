"""Regenera todos los entregables desde el modelo parametrico.

    python3 src/build_all.py

Requiere: ezdxf, ifcopenshell, matplotlib, shapely, pillow; node + playwright (renders).
"""
import os, subprocess, shutil, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "entregables")
REN = os.path.join(OUT, "renders")
LAM = os.path.join(OUT, "laminas")
for d in (OUT, REN, LAM):
    os.makedirs(d, exist_ok=True)

from views import all_views
from sheets import render_sheets, SHEETS
import build_viewer, dxf_export, ifc_export, revit_export
from PIL import Image

# 1) visor sin laminas -> renders 3D
tmp = os.path.join(OUT, "_visor_tmp.html")
build_viewer.build(tmp)
try:
    subprocess.run(["node", os.path.join(HERE, "render3d.js"), tmp, REN], check=True)
finally:
    os.remove(tmp)

# 2) laminas PDF + PNG
V = all_views()
render_sheets(V, os.path.join(OUT, "CasaLinterna_Planos_A1.pdf"), LAM, REN, dpi_png=150)

# 3) visor final con laminas embebidas (JPEG livianos)
emb = os.path.join(OUT, "_emb")
os.makedirs(emb, exist_ok=True)
titles = {}
for sh in SHEETS:
    im = Image.open(os.path.join(LAM, sh["code"] + ".png")).convert("RGB")
    im = im.resize((int(im.width * 0.62), int(im.height * 0.62)), Image.LANCZOS)
    im.save(os.path.join(emb, sh["code"] + ".jpg"), quality=82, optimize=True)
    titles[sh["code"]] = f"{sh['code']} · {sh['title'].title()}"
build_viewer.build(os.path.join(OUT, "visor-3d.html"), emb, titles)
shutil.rmtree(emb)

# 4) DXF, IFC y datos para Revit
dxf_export.export(V, os.path.join(OUT, "CasaLinterna_Planos.dxf"))
ifc_export.export(os.path.join(OUT, "CasaLinterna_Modelo.ifc"))
revit_export.export(os.path.join(ROOT, "revit", "casa_linterna_revit.json"))
print("Listo.")
