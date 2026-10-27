"""Definicion de laminas A1 y renderizado vectorial a PDF/PNG (matplotlib)."""
import math, os
from collections import OrderedDict
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Polygon as MPoly, Arc, Circle, Rectangle
from matplotlib.backends.backend_pdf import PdfPages
from matplotlib import font_manager
from drawing import LAYERS
from model import build_walls, build_rooms, LV

plt.rcParams["font.family"] = "Inter"
plt.rcParams["hatch.linewidth"] = 0.35
PT = 72 / 25.4                    # puntos por mm
SHEET_W, SHEET_H = 841.0, 594.0   # A1
PROJECT = "CASA LINTERNA"
DATE = "OCTUBRE 2026"
TB_X = 731.0                      # inicio del rotulo


# ---------------------------------------------------------------------------
# Tablas
# ---------------------------------------------------------------------------
def schedule_vanos():
    acc = OrderedDict()
    for w in build_walls():
        for o in w.openings:
            k = o.name
            if k not in acc:
                acc[k] = {"tipo": "VANO" if o.kind == "vano" else "PUERTA" if o.kind in ("door", "door2", "slide") else "VENTANA",
                          "ancho": o.s2 - o.s1, "alto": o.head - o.sill, "alf": o.sill, "n": 0, "desc": o.desc,
                          "f2": 0}
            acc[k]["n"] += 1
            if w.level >= 3:
                acc[k]["f2"] += 1
    rows = []
    for k in sorted(acc, key=lambda s: (s[0] != "P", s)):
        a = acc[k]
        n = f"{a['n'] - a['f2']}" + (f" (+{a['f2']})" if a["f2"] else "")
        rows.append([k, a["tipo"], f"{a['ancho']:.2f}", f"{a['alto']:.2f}", f"{a['alf']:.2f}", n, a["desc"][:44]])
    return ["CÓD.", "TIPO", "ANCHO", "ALTO", "ALF.", "CANT.", "DESCRIPCIÓN"], rows


def schedule_areas():
    rows = [["TERRENO", "8.00 x 17.00", "136.00"],
            ["ÁREA TECHADA 1er PISO", "8.00 x 12.00 - 2 ductos", "95.50"],
            ["ÁREA TECHADA 2do PISO", "8.00 x 12.00 - 2 ductos", "95.50"],
            ["BALCONES (volados sobre la cochera)", "2 x 3.30 x 1.10", "7.21"],
            ["TOTAL MATERIAL NOBLE", "", "198.21"],
            ["TERRAZA (cobertura liviana)", "8.00 x 12.00", "96.00"],
            ["COCHERA / REUNIONES (cob. liviana)", "8.00 x 5.00", "40.00 (29.4 %)"],
            ["DUCTOS DE LUZ Y VENTILACIÓN", "2 x 0.50 x 0.50", "0.50 (0.4 %)"]]
    return ["ÍTEM", "MEDIDAS (m)", "ÁREA (m²)"], rows


def schedule_rooms():
    rows = []
    for r in build_rooms():
        if r.level <= 3:
            rows.append([f"{r.level}°", r.name, f"{r.area:.2f}", r.finish])
    return ["NIV.", "AMBIENTE", "m²", "ACABADO DE PISO"], rows


LEGEND = [
    ("muro", "Muro de albañilería (ladrillo KK 18 huecos)"),
    ("col", "Columna / placa de concreto armado"),
    ("proy", "Proyección superior / elemento oculto"),
    ("met", "Estructura metálica (tubo LAC ASTM A500)"),
    ("eje", "Eje estructural"),
    ("vid", "Vidrio / policarbonato"),
]

NOTES = [
    "1. Cotas y niveles en metros; verificar en obra antes de ejecutar.",
    "2. Muros: albañilería confinada de ladrillo KK e=0.15; tabiques de baño e=0.10.",
    "3. Losas aligeradas h=0.20; vigas 0.25x0.40; columnas 0.25x0.25.",
    "4. Estructura referencial: diseño y firma de Ing. Civil colegiado (E.030, E.060, E.070, E.090).",
    "5. Cochera 8.00 x 5.00 SIN muros ni cerramientos: 2 autos lado a lado o zona de reuniones.",
    "6. Columnas metálicas de la cochera sobre pedestales C°A° 0.40x0.40 (h=0.50 sobre piso) y zapatas.",
    "7. Sala, comedor y dormitorios 2 y 3 (con balcón) miran a la cochera techada.",
    "8. Dorm. 1, 4, 5 y cocina: ventanas altas a ductos 0.50x0.50; baños con extractor mecánico.",
    "9. Escalera: contrapaso 0.175, paso 0.25, ancho 1.00 m por tramo.",
]


# ---------------------------------------------------------------------------
# Composicion de laminas
# ---------------------------------------------------------------------------
# (clave_vista, origen_papel_mm(x,y) del punto modelo (u0,v0), (u0,v0), escala, titulo, subtitulo)
SHEETS = [
    {"code": "A-01", "title": "PLANTA 1er PISO", "scale": "1/50",
     "views": [("P1", (135, 100), (0, 0), 50, "PLANTA 1er PISO — GENERAL", "NPT ±0.00  |  cochera, sala, comedor, cocina abierta, dormitorio con baño")],
     "tables": [("vanos", (400, 540), 320)]},
    {"code": "A-02", "title": "PLANTA 2do PISO", "scale": "1/50",
     "views": [("P2", (135, 100), (0, 0), 50, "PLANTA 2do PISO", "NPT +2.80  |  4 dormitorios amplios con baño, 2 con balcón a la cochera")],
     "tables": [("rooms", (400, 540), 320), ("areas", (400, 300), 320)]},
    {"code": "A-03", "title": "PLANTA DE TERRAZA", "scale": "1/50",
     "views": [("P3", (135, 100), (0, 0), 50, "PLANTA TERRAZA (3er NIVEL)", "NPT +5.60  |  terraza techada con parrilla, sala y comedor exterior")],
     "tables": [("legend", (410, 540), 300), ("notes", (410, 420), 300)]},
    {"code": "A-04", "title": "TECHOS, ESTRUCTURA METÁLICA Y DETALLES", "scale": "INDICADA",
     "views": [("PT", (70, 255), (0, 0), 75, "PLANTA DE TECHOS", "coberturas a una sola agua"),
               ("PE", (285, 255), (0, 0), 75, "ESTRUCTURA DE COBERTURAS", "vigas, correas, columnas y arriostres"),
               ("D1", (500, 410), (-0.35, -1.45), 20, "DETALLE 1 — PEDESTAL Y BASE", "columna CM-1 de la cochera", (-0.35, -1.45, 2.0, 0.95)),
               ("D2", (500, 250), (2.50, 4.55), 20, "DETALLE 2 — APOYO EN LA VIVIENDA", "ángulo AN-1 sobre viga de borde", (2.50, 4.55, 5.60, 6.20))],
     "tables": [("metal", (40, 175), 440)]},
    {"code": "A-05", "title": "CORTES LONGITUDINALES A-A Y B-B", "scale": "1/50",
     "views": [("SA", (75, 335), (0, 0), 50, "CORTE A-A", "por comedor, hall, cocina y dormitorios 3 y 5 — calle a la izquierda"),
               ("SB", (75, 70), (0, 0), 50, "CORTE B-B", "por escalera, sala, dormitorio 1 y dormitorios 2 y 4")],
     "images": [("render-corte", (505, 330), 215), ("render-p2", (505, 70), 215)]},
    {"code": "A-06", "title": "CORTES TRANSVERSALES Y ELEVACIONES", "scale": "1/50",
     "views": [("SC", (60, 330), (0, 0), 50, "CORTE C-C", "por sala, comedor y dormitorios 2 y 3, mirando a la calle"),
               ("SD", (400, 330), (0, 0), 50, "CORTE D-D", "por escalera y hall, mirando al fondo"),
               ("EF", (60, 62), (0, 0), 50, "ELEVACIÓN PRINCIPAL (CALLE)", "cochera abierta, balcones y celosía de la terraza")],
     "images": [("foto-aerea", (400, 40), 300)]},
    {"code": "A-07", "title": "VISTAS FOTORREALISTAS · EXTERIOR", "scale": "S/E",
     "images": [("foto-calle", (34, 175), 342), ("foto-cochera", (384, 175), 342)]},
    {"code": "A-08", "title": "VISTAS FOTORREALISTAS · INTERIOR", "scale": "S/E",
     "images": [("foto-sala", (34, 305), 342), ("foto-cocina", (384, 305), 342),
                ("foto-dormitorio", (34, 38), 342), ("foto-terraza", (384, 38), 342)]},
]


class Paper:
    """Dibuja primitivas de modelo en un eje en mm de papel."""
    def __init__(self, ax):
        self.ax = ax
        self.z = 1

    def _tr(self, p, o, ref, sc):
        return (o[0] + (p[0] - ref[0]) * 1000.0 / sc, o[1] + (p[1] - ref[1]) * 1000.0 / sc)

    def draw(self, d, o, ref, sc, clip=None):
        ax = self.ax
        k = 1000.0 / sc
        n0 = (len(ax.patches), len(ax.lines), len(ax.texts))
        for it in d.expanded():
            kind = it[0]
            if clip and kind == "text":
                if not (clip[0] <= it[1][0] <= clip[2] and clip[1] <= it[1][1] <= clip[3]):
                    continue
            self.z += 1
            if kind == "poly":
                _, pts, layer, fill, hatch, lw, edge, alpha, color, _z = it
                L = LAYERS[layer]
                ec = color or L[3]
                P = [self._tr(p, o, ref, sc) for p in pts]
                hp = {"muro": "/////", "concreto": "...", "tierra": "\\\\\\", "vidrio": None, "jardin": "..."}.get(hatch)
                patch = MPoly(P, closed=True, facecolor=fill if fill else "none",
                              edgecolor=ec if edge else "none", linewidth=(lw if lw is not None else L[1]) * PT,
                              hatch=hp, alpha=alpha, zorder=self.z, joinstyle="miter")
                if hp:
                    patch.set_edgecolor(ec if edge else "#00000000")
                ax.add_patch(patch)
                if hp and edge is False:
                    pass
            elif kind in ("line", "pline"):
                if kind == "line":
                    _, p1, p2, layer, lw, ls, color = it
                    pts = [p1, p2]; closed = False
                else:
                    _, pts, closed, layer, lw, ls, color = it
                L = LAYERS[layer]
                P = [self._tr(p, o, ref, sc) for p in pts]
                if closed:
                    P = P + [P[0]]
                lt = ls or L[2]
                dash = {"DASHED": (0, (4, 2.5)), "DASHDOT": (0, (8, 2, 1.5, 2)), "PHANTOM": (0, (12, 2.5, 2, 2.5, 2, 2.5))}.get(lt, "-")
                ax.plot([q[0] for q in P], [q[1] for q in P], color=color or L[3], lw=(lw if lw is not None else L[1]) * PT,
                        linestyle=dash, zorder=self.z, solid_capstyle="butt", dash_capstyle="butt")
            elif kind == "arc":
                _, c, r, a0, a1, layer, lw, ls = it
                L = LAYERS[layer]
                C = self._tr(c, o, ref, sc)
                ax.add_patch(Arc(C, 2 * r * k, 2 * r * k, theta1=a0, theta2=a1, color=L[3],
                                 lw=(lw if lw is not None else L[1]) * PT, zorder=self.z))
            elif kind == "circle":
                _, c, r, layer, fill, lw = it
                L = LAYERS[layer]
                C = self._tr(c, o, ref, sc)
                ax.add_patch(Circle(C, r * k, facecolor=fill or ("white" if layer in ("A-EJES", "A-SIMBOLO") else "none"),
                                    edgecolor=L[3], lw=(lw if lw is not None else max(L[1], 0.18)) * PT, zorder=self.z))
            elif kind == "text":
                _, p, s, h, layer, ha, va, rot, bold, color, font = it
                L = LAYERS[layer]
                P = self._tr(p, o, ref, sc)
                ax.text(P[0], P[1], s, fontsize=h / 0.72 * PT, ha=ha, va=va, rotation=rot, color=color or L[3],
                        fontweight="bold" if bold else "normal", zorder=self.z + 500, linespacing=1.15,
                        rotation_mode="anchor")
            elif kind == "dim":
                if clip:
                    continue
                self._dim(it, o, ref, sc)
        if clip:
            A = self._tr((clip[0], clip[1]), o, ref, sc)
            B = self._tr((clip[2], clip[3]), o, ref, sc)
            cp = Rectangle(A, B[0] - A[0], B[1] - A[1], transform=ax.transData)
            for art in ax.patches[n0[0]:] + ax.lines[n0[1]:] + ax.texts[n0[2]:]:
                art.set_clip_path(cp)
            ax.add_patch(Rectangle(A, B[0] - A[0], B[1] - A[1], facecolor="none", edgecolor="#1a1a1a", lw=0.6, zorder=self.z + 900))

    def _dim(self, it, o, ref, sc):
        _, p1, p2, off, layer, text, h = it
        L = LAYERS[layer]
        dx, dy = p2[0] - p1[0], p2[1] - p1[1]
        ln = math.hypot(dx, dy)
        if ln < 1e-6:
            return
        ux, uy = dx / ln, dy / ln
        nx, ny = -uy, ux
        sgn = 1 if off >= 0 else -1
        q1 = (p1[0] + nx * off, p1[1] + ny * off)
        q2 = (p2[0] + nx * off, p2[1] + ny * off)
        k = sc / 1000.0          # m por mm de papel
        lw = L[1] * PT
        col = L[3]
        Q1, Q2 = self._tr(q1, o, ref, sc), self._tr(q2, o, ref, sc)
        ax = self.ax
        ax.plot([Q1[0], Q2[0]], [Q1[1], Q2[1]], color=col, lw=lw, zorder=self.z)
        for p, q in ((p1, q1), (p2, q2)):
            if abs(off) > 1e-3:
                a = (p[0] + nx * sgn * 1.0 * k, p[1] + ny * sgn * 1.0 * k)
                b = (q[0] + nx * sgn * 1.2 * k, q[1] + ny * sgn * 1.2 * k)
                A, B = self._tr(a, o, ref, sc), self._tr(b, o, ref, sc)
                ax.plot([A[0], B[0]], [A[1], B[1]], color=col, lw=lw * 0.8, zorder=self.z)
            Q = self._tr(q, o, ref, sc)
            t = 1.1
            ax.plot([Q[0] - (ux + nx) * t * 0.7, Q[0] + (ux + nx) * t * 0.7],
                    [Q[1] - (uy + ny) * t * 0.7, Q[1] + (uy + ny) * t * 0.7], color=col, lw=lw * 2.2, zorder=self.z)
        val = text or f"{ln:.2f}"
        ang = math.degrees(math.atan2(uy, ux))
        if ang > 90.01 or ang <= -90:
            ang += 180
        side = sgn if abs(off) > 1e-3 else -1
        short = ln * 1000 / sc < len(val) * h * 0.62
        mx, my = (q1[0] + q2[0]) / 2, (q1[1] + q2[1]) / 2
        dist = (1.0 + (h * 1.2 if short else 0)) * k
        tp = (mx + nx * side * dist, my + ny * side * dist)
        T = self._tr(tp, o, ref, sc)
        va = "bottom" if side * (ny if abs(ny) > 0.5 else -nx) >= 0 else "top"
        if abs(nx) > 0.5:
            va = "bottom" if side * nx < 0 else "top"
        ax.text(T[0], T[1], val, fontsize=(h * (0.85 if short else 1.0)) / 0.72 * PT, ha="center", va=va,
                rotation=ang, rotation_mode="anchor", color="#202020", zorder=self.z + 500)


def _table(ax, x, y, w, header, rows, colw, title, fs=1.9):
    rh = 4.6
    ax.text(x, y + 3, title, fontsize=2.6 / 0.72 * PT, fontweight="bold", va="bottom")
    tot = sum(colw)
    cw = [c * w / tot for c in colw]
    yy = y
    ax.add_patch(Rectangle((x, yy - rh), w, rh, facecolor="#1f2326", edgecolor="#1f2326", lw=0.3))
    cx = x
    for h, c in zip(header, cw):
        ax.text(cx + 1.2, yy - rh / 2, h, fontsize=fs / 0.72 * PT, color="white", va="center", fontweight="bold")
        cx += c
    yy -= rh
    for i, r in enumerate(rows):
        bold = r[0].startswith(("SUBTOTAL", "TOTAL"))
        if i % 2 == 0:
            ax.add_patch(Rectangle((x, yy - rh), w, rh, facecolor="#f1efea", edgecolor="none"))
        cx = x
        for v, c in zip(r, cw):
            ax.text(cx + 1.2, yy - rh / 2, v, fontsize=fs / 0.72 * PT, va="center",
                    fontweight="bold" if bold else "normal", color="#1a1a1a")
            cx += c
        yy -= rh
        ax.plot([x, x + w], [yy, yy], color="#bdb8ae", lw=0.25)
    ax.add_patch(Rectangle((x, yy), w, y - yy, facecolor="none", edgecolor="#1f2326", lw=0.6))
    return yy


METAL_ROWS = [
    ["CM-1", "Columna cochera", "Tubo LAC 150x150x4 mm (h ≈ 4.0 m)", "2"],
    ["VM-2", "Viga frontal cochera", "Tubo LAC 150x300x4 mm (L = 7.90 m)", "1"],
    ["VM-1", "Vigas de cubierta cochera", "Tubo LAC 100x200x3 mm @1.233", "7"],
    ["AN-1", "Apoyo en vivienda", "Ángulo L100x100x6 + pernos Ø5/8\" @0.60", "1"],
    ["PD-1", "Pedestal", "C°A° 0.40x0.40 h=1.10, 4Ø5/8\" + est. Ø3/8\"", "2"],
    ["PL-1", "Placa base", "PL 300x300x12 + 4 pernos Ø5/8\" L=0.50", "2"],
    ["CT-1", "Columna terraza", "Tubo LAC 100x100x3 mm + PL 200x200x9", "12"],
    ["VT-1", "Viga terraza", "Tubo LAC 100x250x3 mm (L = 11.90 m)", "3"],
    ["CO-1", "Correas", "Tubo LAC 50x100x2 mm @0.75-1.00", "20"],
    ["AR-1", "Arriostres", "Varilla lisa Ø1/2\" con templador", "4"],
    ["CB-1", "Cobertura", "Panel termoacústico TR4 e=50 mm", "~ 118 m²"],
    ["CB-2", "Paños de luz", "Policarbonato alveolar 10 mm UV", "~ 17 m²"],
    ["CA-1", "Canaletas + bajantes", "Plancha galv. e=0.9 mm + 4 Ø3\" PVC", "2"],
]




def title_block(ax, sheet, idx, n):
    x0, y0, x1, y1 = TB_X, 10, SHEET_W - 10, SHEET_H - 10
    ax.add_patch(Rectangle((x0, y0), x1 - x0, y1 - y0, facecolor="none", edgecolor="#1a1a1a", lw=0.9))
    w = x1 - x0
    cx = x0 + 5
    y = y1 - 14
    ax.text(cx, y, "CASA", fontsize=13 / 0.72 * PT * 0.72, fontweight="bold", color="#1a1a1a")
    ax.text(cx, y - 13, "LINTERNA", fontsize=13 / 0.72 * PT * 0.72, fontweight="bold", color="#a95f28")
    ax.text(cx, y - 21, "VIVIENDA UNIFAMILIAR · 2 PISOS + TERRAZA + COCHERA TECHADA", fontsize=1.9 / 0.72 * PT, color="#333333")
    ax.plot([x0, x1], [y - 26, y - 26], color="#1a1a1a", lw=0.5)
    rows = [("TERRENO", "8.00 x 17.00 m = 136.00 m²"), ("VIVIENDA", "8.00 x 12.00 m · 2 pisos (material noble)"),
            ("COCHERA", "8.00 x 5.00 m · al frente (cob. liviana)"), ("PROPIETARIO", "________________________"),
            ("UBICACIÓN", "________________________"), ("PROYECTISTA", "________________________"),
            ("CAP / CIP N°", "____________"), ("ESPECIALIDAD", "ARQUITECTURA")]
    yy = y - 33
    for k, v in rows:
        ax.text(cx, yy, k, fontsize=1.6 / 0.72 * PT, color="#6a6a6a")
        ax.text(cx, yy - 4.2, v, fontsize=2.0 / 0.72 * PT, color="#1a1a1a")
        yy -= 11
    ax.plot([x0, x1], [yy + 3, yy + 3], color="#1a1a1a", lw=0.5)
    # mini plano de ubicacion de la lamina (indice)
    yy -= 4
    ax.text(cx, yy, "ÍNDICE DE LÁMINAS", fontsize=1.7 / 0.72 * PT, color="#6a6a6a")
    yy -= 5
    for i, s in enumerate(SHEETS):
        col = "#a95f28" if i == idx else "#1a1a1a"
        ax.text(cx, yy, f"{s['code']}  {s['title']}", fontsize=1.65 / 0.72 * PT, color=col,
                fontweight="bold" if i == idx else "normal")
        yy -= 4.3
    # bloque inferior
    yb = y0 + 62
    ax.plot([x0, x1], [yb, yb], color="#1a1a1a", lw=0.5)
    ax.text(cx, yb - 6, "LÁMINA", fontsize=1.6 / 0.72 * PT, color="#6a6a6a")
    ax.text(cx, yb - 12, sheet["title"], fontsize=2.4 / 0.72 * PT, fontweight="bold", wrap=True)
    ax.plot([x0, x1], [yb - 20, yb - 20], color="#1a1a1a", lw=0.3)
    ax.text(cx, yb - 26, "ESCALA", fontsize=1.6 / 0.72 * PT, color="#6a6a6a")
    ax.text(cx, yb - 32, sheet["scale"], fontsize=2.6 / 0.72 * PT, fontweight="bold")
    ax.text(cx + 45, yb - 26, "FECHA", fontsize=1.6 / 0.72 * PT, color="#6a6a6a")
    ax.text(cx + 45, yb - 32, DATE, fontsize=2.2 / 0.72 * PT, fontweight="bold")
    ax.plot([x0, x1], [yb - 37, yb - 37], color="#1a1a1a", lw=0.3)
    ax.text(x1 - 5, y0 + 5, sheet["code"], fontsize=11 / 0.72 * PT * 0.8, fontweight="bold", ha="right", va="bottom")
    ax.text(cx, y0 + 6, f"{idx + 1} / {n}", fontsize=2.0 / 0.72 * PT, va="bottom")


def view_title(ax, x, y, title, sub, scale):
    ax.add_patch(Circle((x + 4, y + 1.2), 3.6, facecolor="#1a1a1a", edgecolor="none"))
    ax.text(x + 10, y + 1.5, title, fontsize=3.2 / 0.72 * PT, fontweight="bold", va="center")
    ax.plot([x + 10, x + 10 + max(60, len(title) * 2.6)], [y - 2.0, y - 2.0], color="#1a1a1a", lw=0.8)
    ax.text(x + 10, y - 5.0, f"ESC. {scale}   ·   {sub}", fontsize=2.0 / 0.72 * PT, va="center", color="#444444")


def legend_block(ax, x, y, w):
    ax.text(x, y + 3, "LEYENDA", fontsize=2.6 / 0.72 * PT, fontweight="bold", va="bottom")
    yy = y - 6
    for key, txt in LEGEND:
        if key == "muro":
            ax.add_patch(Rectangle((x, yy - 2), 12, 4, facecolor="#d8d3ca", edgecolor="#2b2b2b", hatch="/////", lw=0.5))
        elif key == "col":
            ax.add_patch(Rectangle((x, yy - 2), 12, 4, facecolor="#1c1c1c", edgecolor="#1c1c1c"))
        elif key == "proy":
            ax.plot([x, x + 12], [yy, yy], color="#7a7a7a", lw=0.5, linestyle=(0, (4, 2.5)))
        elif key == "met":
            ax.add_patch(Rectangle((x, yy - 1.2), 12, 2.4, facecolor="#9fb3c3", edgecolor="#24435c", lw=0.5))
        elif key == "eje":
            ax.plot([x, x + 12], [yy, yy], color="#b0472f", lw=0.4, linestyle=(0, (8, 2, 1.5, 2)))
        elif key == "vid":
            ax.add_patch(Rectangle((x, yy - 1.2), 12, 2.4, facecolor="#d5e8f0", edgecolor="#2c5f7a", lw=0.5))
        ax.text(x + 16, yy, txt, fontsize=1.9 / 0.72 * PT, va="center")
        yy -= 8.5


def notes_block(ax, x, y, w):
    ax.text(x, y + 3, "NOTAS GENERALES", fontsize=2.6 / 0.72 * PT, fontweight="bold", va="bottom")
    yy = y - 5
    for n in NOTES:
        ax.text(x, yy, n, fontsize=1.75 / 0.72 * PT, va="center", wrap=True)
        yy -= 6.2


def render_sheets(V, out_pdf, png_dir=None, img_dir=None, dpi_png=110):
    from PIL import Image
    os.makedirs(png_dir, exist_ok=True) if png_dir else None
    with PdfPages(out_pdf) as pdf:
        for idx, sh in enumerate(SHEETS):
            fig = plt.figure(figsize=(SHEET_W / 25.4, SHEET_H / 25.4))
            ax = fig.add_axes([0, 0, 1, 1])
            ax.set_xlim(0, SHEET_W); ax.set_ylim(0, SHEET_H); ax.set_aspect("equal"); ax.axis("off")
            ax.add_patch(Rectangle((25, 10), TB_X - 25 - 4, SHEET_H - 20, facecolor="none", edgecolor="#1a1a1a", lw=0.9))
            paper = Paper(ax)
            for vw in sh.get("views", []):
                key, o, ref, sc, title, sub = vw[:6]
                clip = vw[6] if len(vw) > 6 else None
                d = V[key]
                paper.draw(d, o, ref, sc, clip)
                x0, y0, x1, y1 = clip if clip else d.bbox()
                tx = o[0] + (x0 - ref[0]) * 1000 / sc
                ty = o[1] + (y0 - ref[1]) * 1000 / sc - 14
                view_title(ax, tx, ty, title, sub, f"1/{sc}")
            for kind, (x, y), w in sh.get("tables", []):
                if kind == "vanos":
                    h, r = schedule_vanos()
                    _table(ax, x, y, w, h, r, [7, 8, 6, 6, 6, 5, 34], "CUADRO DE VANOS", fs=1.7)
                elif kind == "rooms":
                    h2, r2 = schedule_rooms()
                    _table(ax, x, y, w, h2, r2, [5, 20, 7, 24], "CUADRO DE AMBIENTES", fs=1.7)
                elif kind == "areas":
                    h, r = schedule_areas()
                    _table(ax, x, y, w, h, r, [26, 14, 14], "CUADRO DE ÁREAS")
                elif kind == "legend":
                    legend_block(ax, x, y, w)
                elif kind == "notes":
                    notes_block(ax, x, y, w)
                elif kind == "metal":
                    _table(ax, x, y, w, ["CÓD.", "ELEMENTO", "SECCIÓN / ESPECIFICACIÓN", "CANT."], METAL_ROWS,
                           [6, 12, 30, 6], "CUADRO DE ELEMENTOS METÁLICOS — COBERTURA", fs=1.6)
            for name, (x, y), w in sh.get("images", []):
                path = os.path.join(img_dir or "", name + ".png")
                if img_dir and os.path.exists(path):
                    im = Image.open(path)
                    h = w * im.height / im.width
                    ax.imshow(im, extent=(x, x + w, y, y + h), zorder=0, interpolation="lanczos")
                    ax.add_patch(Rectangle((x, y), w, h, facecolor="none", edgecolor="#1a1a1a", lw=0.4))
                    cap = {"foto-calle": "VISTA DESDE LA CALLE (CYCLES)", "foto-cochera": "COCHERA TECHADA BAJO LOS BALCONES",
                           "foto-aerea": "VISTA AÉREA CON CONTEXTO URBANO", "foto-sala": "SALA Y COMEDOR ABIERTOS A LA COCHERA",
                           "foto-cocina": "COCINA ABIERTA CON ISLA", "foto-dormitorio": "DORMITORIO 2 CON BALCÓN (2do PISO)",
                           "foto-terraza": "TERRAZA TECHADA (3er NIVEL)", "render-corte": "CORTE FUGADO LONGITUDINAL",
                           "render-p2": "2do PISO — 4 DORMITORIOS CON BAÑO"}.get(name, name)
                    ax.text(x, y - 4, cap, fontsize=2.4 / 0.72 * PT, fontweight="bold", va="top")
            title_block(ax, sh, idx, len(SHEETS))
            pdf.savefig(fig)
            if png_dir:
                fig.savefig(os.path.join(png_dir, f"{sh['code']}.png"), dpi=dpi_png)
            plt.close(fig)
    print("PDF:", out_pdf)
