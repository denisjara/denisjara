"""Exporta el juego de planos a DXF (AutoCAD 2018).

- Espacio modelo: cada vista a escala real (metros) en su propia zona.
- Espacio papel: un layout A1 por lamina con viewports a 1/50 o 1/10, rotulo y cuadros.
- Puertas, ventanas, sanitarios y mobiliario como BLOQUES reutilizables
  (familias por tamaño, p.ej. PUERTA_0.80_0.15) con atributos CODIGO/ANCHO/ALTO.
- Cotas como entidades DIMENSION nativas con estilo arquitectonico (tick).
"""
import math, os
import ezdxf
from ezdxf.enums import TextEntityAlignment
from ezdxf import colors as ezcolors
from drawing import LAYERS, block_drawing
from sheets import SHEETS, schedule_vanos, schedule_areas, schedule_rooms, METAL_ROWS, NOTES, PROJECT, DATE, SHEET_W, SHEET_H, TB_X

MODEL_POS = {
    "P1": (0, 0), "P2": (25, 0), "P3": (50, 0), "PT": (75, 0), "PE": (100, 0),
    "SA": (0, -30), "SB": (25, -30), "SC": (50, -30), "SD": (75, -30),
    "EF": (0, -55), "EL": (25, -55), "DET": (55, -55),
}


def _rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def _align(ha, va):
    v = {"center": "MIDDLE", "bottom": "BOTTOM", "top": "TOP", "baseline": "BOTTOM"}[va]
    h = {"center": "CENTER", "left": "LEFT", "right": "RIGHT"}[ha]
    return TextEntityAlignment[f"{v}_{h}"]


class Writer:
    def __init__(self, doc, space, off=(0, 0), sc=50.0):
        self.doc, self.sp, self.off, self.sc = doc, space, off, sc
        self.blocks = doc.blocks

    def P(self, p):
        return (p[0] + self.off[0], p[1] + self.off[1])

    def th(self, h_mm):
        return h_mm * self.sc / 1000.0

    def ensure_block(self, name):
        if name in self.blocks:
            return
        blk = self.blocks.new(name=name)
        sub = Writer(self.doc, blk, (0, 0), self.sc)
        sub.draw_items(block_drawing(name).items)
        if name.startswith(("PUERTA", "PIVOT", "VENTANA", "CORREDIZA")):
            for i, tag in enumerate(("CODIGO", "ANCHO", "ALTO")):
                blk.add_attdef(tag, (0, -0.1 * (i + 1)), dxfattribs={"height": 0.05, "layer": "A-TEXTO-AREA", "invisible": 1})

    def draw_items(self, items, attrs_map=None):
        sp = self.sp
        for it in items:
            k = it[0]
            if k == "line":
                _, p1, p2, layer, lw, ls, color = it
                e = sp.add_line(self.P(p1), self.P(p2), dxfattribs={"layer": layer})
                if ls == "DASHED":
                    e.dxf.linetype = "DASHED"
                if lw is not None:
                    e.dxf.lineweight = int(round(lw * 100 / 5.0) * 5) if lw >= 0.05 else 5
            elif k == "pline":
                _, pts, closed, layer, lw, ls, color = it
                e = sp.add_lwpolyline([self.P(p) for p in pts], close=closed, dxfattribs={"layer": layer})
                if ls == "DASHED":
                    e.dxf.linetype = "DASHED"
            elif k == "poly":
                _, pts, layer, fill, hatch, lw, edge, alpha, color, _z = it
                Q = [self.P(p) for p in pts]
                if fill and fill.lower() not in ("#ffffff", "white") or hatch:
                    h = sp.add_hatch(dxfattribs={"layer": layer})
                    if hatch == "muro":
                        h.set_pattern_fill("ANSI31", scale=0.02, color=8)
                    elif hatch == "tierra":
                        h.set_pattern_fill("EARTH", scale=0.03, color=32)
                    elif hatch == "concreto":
                        h.set_pattern_fill("AR-CONC", scale=0.002, color=8)
                    else:
                        h.set_solid_fill(color=7)
                        h.rgb = _rgb(fill)
                    h.paths.add_polyline_path(Q, is_closed=True)
                if edge:
                    sp.add_lwpolyline(Q, close=True, dxfattribs={"layer": layer})
            elif k == "arc":
                _, c, r, a0, a1, layer, lw, ls = it
                sp.add_arc(self.P(c), r, a0, a1, dxfattribs={"layer": layer})
            elif k == "circle":
                _, c, r, layer, fill, lw = it
                sp.add_circle(self.P(c), r, dxfattribs={"layer": layer})
                if fill and fill.lower() not in ("#ffffff", "white"):
                    h = sp.add_hatch(dxfattribs={"layer": layer})
                    h.set_solid_fill(); h.rgb = _rgb(fill)
                    pts = [(c[0] + r * math.cos(2 * math.pi * i / 24), c[1] + r * math.sin(2 * math.pi * i / 24)) for i in range(24)]
                    h.paths.add_polyline_path([self.P(p) for p in pts], is_closed=True)
            elif k == "text":
                _, p, s, h, layer, ha, va, rot, bold, color, font = it
                if "\n" in s:
                    mt = sp.add_mtext(s.replace("\n", "\\P"), dxfattribs={"layer": layer, "char_height": self.th(h),
                                                                          "style": "PLANO-B" if bold else "PLANO", "rotation": rot})
                    mt.set_location(self.P(p), attachment_point=5)
                else:
                    t = sp.add_text(s, height=self.th(h), rotation=rot,
                                    dxfattribs={"layer": layer, "style": "PLANO-B" if bold else "PLANO"})
                    t.set_placement(self.P(p), align=_align(ha, va))
            elif k == "dim":
                _, p1, p2, off, layer, text, h = it
                try:
                    dim = sp.add_aligned_dim(p1=self.P(p1), p2=self.P(p2), distance=off if abs(off) > 1e-6 else 0.001,
                                             dimstyle="COTA-%d" % int(self.sc), dxfattribs={"layer": layer})
                    dim.render()
                except Exception:
                    pass
            elif k == "insert":
                _, name, pos, rot, sx, sy, attrs = it
                self.ensure_block(name)
                ins = sp.add_blockref(name, self.P(pos), dxfattribs={"rotation": rot, "xscale": sx, "yscale": sy, "layer": "0"})
                if name.startswith(("PUERTA", "PIVOT", "VENTANA", "CORREDIZA")):
                    w = name.split("_")[1]
                    ins.add_auto_attribs({"CODIGO": attrs.get("TAG", ""), "ANCHO": w, "ALTO": attrs.get("ALTO", "")})


def setup(doc):
    doc.header["$INSUNITS"] = 6          # metros
    doc.header["$MEASUREMENT"] = 1
    doc.header["$LUNITS"] = 2
    doc.header["$LUPREC"] = 2
    for name, (aci, lw, lt, rgb) in LAYERS.items():
        if name not in doc.layers:
            lay = doc.layers.add(name, color=aci, linetype=lt if lt in doc.linetypes else "CONTINUOUS")
            lay.dxf.lineweight = int(round(lw * 100 / 5.0) * 5)
    doc.styles.add("PLANO", font="arial.ttf")
    doc.styles.add("PLANO-B", font="arialbd.ttf")
    for sc in (10, 20, 50, 1):
        k = sc / 1000.0
        ds = doc.dimstyles.new("COTA-%d" % sc)
        ds.dxf.dimtxt = 2.0 * k
        ds.dxf.dimtsz = 1.2 * k
        ds.dxf.dimexo = 1.0 * k
        ds.dxf.dimexe = 1.2 * k
        ds.dxf.dimgap = 0.8 * k
        ds.dxf.dimdec = 2
        ds.dxf.dimtad = 1
        ds.dxf.dimtxsty = "PLANO"
        ds.dxf.dimclrd = 1
        ds.dxf.dimclre = 1
        ds.dxf.dimdsep = ord(".")
        ds.dxf.dimzin = 0


def export(V, out_path, render_dir_rel="renders"):
    doc = ezdxf.new("R2018", setup=True)
    setup(doc)
    msp = doc.modelspace()
    # --- espacio modelo
    placed = {}
    for key, off in MODEL_POS.items():
        if key == "DET":
            d = V["_DB"]
            Writer(doc, msp, off, 20).draw_items(d.items)
            Writer(doc, msp, off, 20).draw_items(V["_N1"].items)
            Writer(doc, msp, off, 20).draw_items(V["_N2"].items)
            placed["D1"] = placed["D2"] = off
            continue
        d = V[key]
        Writer(doc, msp, off, 50).draw_items(d.items)
        placed[key] = off
        x0, y0, x1, y1 = d.bbox()
        t = msp.add_text(d.title, height=0.25, dxfattribs={"layer": "A-TEXTO", "style": "PLANO-B"})
        t.set_placement((x0 + off[0], y0 + off[1] - 0.8), align=TextEntityAlignment.LEFT)
    # --- espacio papel
    for idx, sh in enumerate(SHEETS):
        lay = doc.layouts.new(sh["code"])
        lay.page_setup(size=(SHEET_W, SHEET_H), margins=(0, 0, 0, 0), units="mm")
        pw = Writer(doc, lay, (0, 0), 1)
        frame(lay, sh, idx)
        for vw in sh.get("views", []):
            key, o, ref, sc, title, sub = vw[:6]
            clip = vw[6] if len(vw) > 6 else None
            d = V[key]
            x0, y0, x1, y1 = clip if clip else d.bbox()
            if not clip:
                x0, y0, x1, y1 = x0 - 0.3, y0 - 0.3, x1 + 0.3, y1 + 0.3
            k = 1000.0 / sc
            px0, py0 = o[0] + (x0 - ref[0]) * k, o[1] + (y0 - ref[1]) * k
            pw_, ph_ = (x1 - x0) * k, (y1 - y0) * k
            mo = placed[key]
            vp = lay.add_viewport(center=(px0 + pw_ / 2, py0 + ph_ / 2), size=(pw_, ph_),
                                  view_center_point=((x0 + x1) / 2 + mo[0], (y0 + y1) / 2 + mo[1]), view_height=(y1 - y0))
            vp.dxf.layer = "A-ROTULO"
            ptext(lay, px0, py0 - 8, title, 3.2, bold=True)
            ptext(lay, px0, py0 - 13, f"ESC. 1/{sc}   ·   {sub}", 2.0)
        for kind, (x, y), w in sh.get("tables", []):
            if kind == "vanos":
                h, r = schedule_vanos(); ptable(lay, x, y, w, h, r, [7, 8, 6, 6, 6, 5, 34], "CUADRO DE VANOS", fs=1.7)
            elif kind == "rooms":
                h2, r2 = schedule_rooms(); ptable(lay, x, y, w, h2, r2, [5, 20, 7, 24], "CUADRO DE AMBIENTES", fs=1.7)
            elif kind == "areas":
                h, r = schedule_areas(); ptable(lay, x, y, w, h, r, [26, 14, 14], "CUADRO DE ÁREAS")
            elif kind == "notes":
                ptext(lay, x, y + 3, "NOTAS GENERALES", 2.6, bold=True)
                for i, n in enumerate(NOTES):
                    ptext(lay, x, y - 5 - i * 6.2, n, 1.75)
            elif kind == "legend":
                ptext(lay, x, y + 3, "LEYENDA: muro (ANSI31) · columna (sólido) · proyección (DASHED) · eje (DASHDOT)", 1.9, bold=True)
            elif kind == "metal":
                ptable(lay, x, y, w, ["CÓD.", "ELEMENTO", "SECCIÓN / ESPECIFICACIÓN", "CANT."], METAL_ROWS, [6, 12, 30, 6],
                       "CUADRO DE ELEMENTOS METÁLICOS", fs=1.6)
        for name, (x, y), w in sh.get("images", []):
            fn = os.path.join(os.path.dirname(out_path), render_dir_rel, name + ".png")
            if os.path.exists(fn):
                from PIL import Image
                im = Image.open(fn)
                h = w * im.height / im.width
                idef = doc.add_image_def(filename=f"{render_dir_rel}/{name}.png", size_in_pixel=im.size)
                lay.add_image(idef, insert=(x, y), size_in_units=(w, h), dxfattribs={"layer": "A-ROTULO"})
    if "Layout1" in doc.layouts:
        doc.layouts.delete("Layout1")
    doc.set_modelspace_vport(height=90, center=(55, -25))
    doc.saveas(out_path)
    print("DXF:", out_path)


def ptext(lay, x, y, s, h, bold=False, color=None, ha="left"):
    t = lay.add_text(s, height=h, dxfattribs={"layer": "A-ROTULO", "style": "PLANO-B" if bold else "PLANO"})
    if color:
        t.rgb = _rgb(color)
    t.set_placement((x, y), align=TextEntityAlignment.LEFT if ha == "left" else TextEntityAlignment.RIGHT)


def ptable(lay, x, y, w, header, rows, colw, title, fs=1.9):
    rh = 4.6
    ptext(lay, x, y + 3, title, 2.6, bold=True)
    tot = sum(colw)
    cw = [c * w / tot for c in colw]
    yy = y
    h = lay.add_hatch(dxfattribs={"layer": "A-ROTULO"}); h.set_solid_fill(); h.rgb = (31, 35, 38)
    h.paths.add_polyline_path([(x, yy), (x + w, yy), (x + w, yy - rh), (x, yy - rh)], is_closed=True)
    cx = x
    for hd, c in zip(header, cw):
        ptext(lay, cx + 1.2, yy - rh / 2 - fs / 2, hd, fs, bold=True, color="#ffffff")
        cx += c
    yy -= rh
    for r in rows:
        cx = x
        for v, c in zip(r, cw):
            ptext(lay, cx + 1.2, yy - rh / 2 - fs / 2, v, fs)
            cx += c
        yy -= rh
        lay.add_line((x, yy), (x + w, yy), dxfattribs={"layer": "A-ROTULO", "color": 8})
    lay.add_lwpolyline([(x, y), (x + w, y), (x + w, yy), (x, yy)], close=True, dxfattribs={"layer": "A-ROTULO"})


def frame(lay, sh, idx):
    lay.add_lwpolyline([(25, 10), (TB_X - 4, 10), (TB_X - 4, SHEET_H - 10), (25, SHEET_H - 10)], close=True,
                       dxfattribs={"layer": "A-ROTULO", "lineweight": 70})
    x0, y0, x1, y1 = TB_X, 10, SHEET_W - 10, SHEET_H - 10
    lay.add_lwpolyline([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], close=True, dxfattribs={"layer": "A-ROTULO", "lineweight": 70})
    cx = x0 + 5
    ptext(lay, cx, y1 - 14, "CASA", 9, bold=True)
    ptext(lay, cx, y1 - 26, "LINTERNA", 9, bold=True, color="#a95f28")
    ptext(lay, cx, y1 - 33, "VIVIENDA UNIFAMILIAR · 2 PISOS + TERRAZA + COCHERA", 1.9)
    rows = [("TERRENO", "13.00 x 12.00 m = 156.00 m²"), ("VIVIENDA", "8.00 x 12.00 m · 2 pisos (material noble)"),
            ("FRANJA LIBRE", "5.00 x 12.00 m · cochera / reuniones"), ("PROPIETARIO", "____________________"),
            ("UBICACIÓN", "____________________"), ("PROYECTISTA", "____________________"),
            ("CAP / CIP N°", "__________"), ("ESPECIALIDAD", "ARQUITECTURA")]
    yy = y1 - 45
    for k, v in rows:
        ptext(lay, cx, yy, k, 1.6, color="#6a6a6a")
        ptext(lay, cx, yy - 4.5, v, 2.0)
        yy -= 11
    for i, s in enumerate(SHEETS):
        ptext(lay, cx, yy - 6 - i * 4.3, f"{s['code']}  {s['title']}", 1.65, bold=(i == idx), color="#a95f28" if i == idx else None)
    yb = y0 + 62
    lay.add_line((x0, yb), (x1, yb), dxfattribs={"layer": "A-ROTULO"})
    ptext(lay, cx, yb - 6, "LÁMINA", 1.6, color="#6a6a6a")
    ptext(lay, cx, yb - 13, sh["title"], 2.4, bold=True)
    ptext(lay, cx, yb - 26, "ESCALA", 1.6, color="#6a6a6a")
    ptext(lay, cx, yb - 33, sh["scale"], 2.6, bold=True)
    ptext(lay, cx + 45, yb - 26, "FECHA", 1.6, color="#6a6a6a")
    ptext(lay, cx + 45, yb - 33, DATE, 2.2, bold=True)
    ptext(lay, x1 - 5, y0 + 5, sh["code"], 8, bold=True, ha="right")
