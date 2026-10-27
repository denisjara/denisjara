"""Primitivas 2D independientes del formato (se renderizan a PDF/PNG y a DXF).

Coordenadas en metros de modelo. Alturas de texto en mm de papel.
Los bloques (puertas, ventanas, sanitarios, mobiliario) son funciones
parametricas: en DXF se escriben como definiciones de BLOCK reutilizables con
atributos; en PDF se expanden.
"""
import math

# Capas (nombre: (color ACI, grosor mm, tipo de linea, color RGB para PDF))
LAYERS = {
    "A-MURO":        (8, 0.50, "CONTINUOUS", "#2b2b2b"),
    "A-MURO-BAJO":   (8, 0.25, "CONTINUOUS", "#2b2b2b"),
    "S-COLUMNA":     (7, 0.50, "CONTINUOUS", "#111111"),
    "A-PUERTA":      (30, 0.18, "CONTINUOUS", "#3a3a3a"),
    "A-VENTANA":     (4, 0.18, "CONTINUOUS", "#2c5f7a"),
    "A-ESCALERA":    (2, 0.18, "CONTINUOUS", "#333333"),
    "A-MOBILIARIO":  (9, 0.13, "CONTINUOUS", "#8a8a8a"),
    "A-SANITARIO":   (5, 0.13, "CONTINUOUS", "#5a7f99"),
    "A-PROYECCION":  (9, 0.13, "DASHED", "#7a7a7a"),
    "A-PISO":        (253, 0.09, "CONTINUOUS", "#c9c4ba"),
    "A-JARDIN":      (3, 0.13, "CONTINUOUS", "#5d8a4c"),
    "A-TEXTO":       (7, 0.18, "CONTINUOUS", "#1f1f1f"),
    "A-TEXTO-AREA":  (7, 0.13, "CONTINUOUS", "#555555"),
    "A-COTA":        (1, 0.13, "CONTINUOUS", "#303030"),
    "A-EJES":        (1, 0.13, "DASHDOT", "#b0472f"),
    "A-SIMBOLO":     (6, 0.25, "CONTINUOUS", "#1f1f1f"),
    "S-METALICA":    (5, 0.25, "CONTINUOUS", "#24435c"),
    "S-METALICA-PROY": (5, 0.13, "DASHED", "#24435c"),
    "A-CORTE":       (7, 0.50, "CONTINUOUS", "#1a1a1a"),
    "A-VISTA":       (8, 0.18, "CONTINUOUS", "#444444"),
    "A-VISTA-LEJOS": (9, 0.09, "CONTINUOUS", "#8a8a8a"),
    "A-TERRENO":     (32, 0.35, "CONTINUOUS", "#6b5a45"),
    "A-LOTE":        (1, 0.35, "PHANTOM", "#b0472f"),
    "A-ROTULO":      (7, 0.25, "CONTINUOUS", "#1a1a1a"),
}


class Drawing:
    def __init__(self, title=""):
        self.items = []
        self.title = title

    # --- primitivas
    def line(self, p1, p2, layer, lw=None, ls=None, color=None):
        self.items.append(("line", tuple(p1), tuple(p2), layer, lw, ls, color))

    def pline(self, pts, layer, closed=False, lw=None, ls=None, color=None):
        self.items.append(("pline", [tuple(p) for p in pts], closed, layer, lw, ls, color))

    def poly(self, pts, layer, fill=None, hatch=None, lw=None, edge=True, alpha=1.0, color=None, z=0):
        """Poligono relleno. fill: color RGB; hatch: 'muro'|'concreto'|'tierra'|'jardin'|'vidrio'|None"""
        self.items.append(("poly", [tuple(p) for p in pts], layer, fill, hatch, lw, edge, alpha, color, z))

    def arc(self, c, r, a0, a1, layer, lw=None, ls=None):
        self.items.append(("arc", tuple(c), r, a0, a1, layer, lw, ls))

    def circle(self, c, r, layer, fill=None, lw=None):
        self.items.append(("circle", tuple(c), r, layer, fill, lw))

    def text(self, p, s, h, layer="A-TEXTO", ha="center", va="center", rot=0, bold=False, color=None, font="sans"):
        self.items.append(("text", tuple(p), s, h, layer, ha, va, rot, bold, color, font))

    def dim(self, p1, p2, off, layer="A-COTA", text=None, h=2.0):
        """Cota lineal alineada entre p1 y p2, con linea de cota desplazada 'off' (m) a la izquierda de p1->p2."""
        self.items.append(("dim", tuple(p1), tuple(p2), off, layer, text, h))

    def insert(self, block, pos, rot=0.0, sx=1.0, sy=1.0, attrs=None):
        """Inserta un bloque parametrico (ver BLOCKS)."""
        self.items.append(("insert", block, tuple(pos), rot, sx, sy, attrs or {}))

    def extend(self, other):
        self.items += other.items

    # --- extensiones de dibujo
    def bbox(self):
        xs, ys = [], []
        for it in self.expanded():
            k = it[0]
            if k == "line":
                xs += [it[1][0], it[2][0]]; ys += [it[1][1], it[2][1]]
            elif k in ("pline",):
                xs += [p[0] for p in it[1]]; ys += [p[1] for p in it[1]]
            elif k == "poly":
                xs += [p[0] for p in it[1]]; ys += [p[1] for p in it[1]]
            elif k in ("circle", "arc"):
                xs += [it[1][0] - it[2], it[1][0] + it[2]]; ys += [it[1][1] - it[2], it[1][1] + it[2]]
            elif k == "text":
                xs.append(it[1][0]); ys.append(it[1][1])
            elif k == "dim":
                xs += [it[1][0], it[2][0]]; ys += [it[1][1], it[2][1]]
        return min(xs), min(ys), max(xs), max(ys)

    def expanded(self):
        """Primitivas con los bloques ya expandidos (para PDF)."""
        out = []
        for it in self.items:
            if it[0] == "insert":
                _, name, pos, rot, sx, sy, attrs = it
                sub = block_drawing(name)
                for s in transform_items(sub.items, pos, rot, sx, sy):
                    out.append(s)
                for k, (p, h, txt) in block_attr_positions(name, attrs).items():
                    q = _xf(p, pos, rot, sx, sy)
                    out.append(("text", q, txt, h, "A-TEXTO-AREA", "center", "center", 0, False, None, "sans"))
            else:
                out.append(it)
        return out


def _xf(p, pos, rot, sx, sy):
    x, y = p[0] * sx, p[1] * sy
    c, s = math.cos(math.radians(rot)), math.sin(math.radians(rot))
    return (pos[0] + x * c - y * s, pos[1] + x * s + y * c)


def transform_items(items, pos, rot, sx, sy):
    out = []
    mirror = (sx * sy) < 0
    for it in items:
        k = it[0]
        if k == "line":
            out.append(("line", _xf(it[1], pos, rot, sx, sy), _xf(it[2], pos, rot, sx, sy)) + it[3:])
        elif k == "pline":
            out.append(("pline", [_xf(p, pos, rot, sx, sy) for p in it[1]]) + it[2:])
        elif k == "poly":
            out.append(("poly", [_xf(p, pos, rot, sx, sy) for p in it[1]]) + it[2:])
        elif k == "circle":
            out.append(("circle", _xf(it[1], pos, rot, sx, sy), it[2] * abs(sx)) + it[3:])
        elif k == "arc":
            c = _xf(it[1], pos, rot, sx, sy)
            a0, a1 = it[3], it[4]
            pa = _xf((it[1][0] + it[2] * math.cos(math.radians(a0)), it[1][1] + it[2] * math.sin(math.radians(a0))), pos, rot, sx, sy)
            pb = _xf((it[1][0] + it[2] * math.cos(math.radians(a1)), it[1][1] + it[2] * math.sin(math.radians(a1))), pos, rot, sx, sy)
            b0 = math.degrees(math.atan2(pa[1] - c[1], pa[0] - c[0]))
            b1 = math.degrees(math.atan2(pb[1] - c[1], pb[0] - c[0]))
            if mirror:
                b0, b1 = b1, b0
            out.append(("arc", c, it[2] * abs(sx), b0, b1) + it[5:])
        elif k == "text":
            out.append(("text", _xf(it[1], pos, rot, sx, sy)) + it[2:])
        else:
            out.append(it)
    return out


# ---------------------------------------------------------------------------
# BLOQUES PARAMETRICOS ("familias" 2D). Nombre = TIPO_param1_param2
# ---------------------------------------------------------------------------
def _rect(d, x1, y1, x2, y2, layer, **kw):
    d.pline([(x1, y1), (x2, y1), (x2, y2), (x1, y2)], layer, closed=True, **kw)


def block_drawing(name):
    parts = name.split("_")
    kind = parts[0]
    P = [float(x) for x in parts[1:]] if len(parts) > 1 else []
    d = Drawing()
    if kind == "PUERTA":            # w, t : bisagra en (0, t/2), abre hacia +y
        w, t = P
        d.line((0, t / 2), (0, t / 2 + w), "A-PUERTA", lw=0.25)
        d.line((-0.02, t / 2), (0.02, t / 2 + w), "A-PUERTA", lw=0.25)
        d.arc((0, t / 2), w, 0, 90, "A-PUERTA", lw=0.09)
    elif kind == "PIVOT":           # puerta principal pivotante
        w, t = P
        d.pline([(0, t / 2), (0.05, t / 2), (0.05, t / 2 + w), (0, t / 2 + w)], "A-PUERTA", closed=True, lw=0.25)
        d.arc((0, t / 2), w, 0, 90, "A-PUERTA", lw=0.09)
    elif kind == "CORREDIZA":       # w, t : a lo largo de x
        w, t = P
        _rect(d, 0, -0.035, w / 2 + 0.05, -0.005, "A-VENTANA")
        _rect(d, w / 2 - 0.05, 0.005, w, 0.035, "A-VENTANA")
        d.line((w * 0.30, 0.10), (w * 0.45, 0.10), "A-VENTANA")
        d.line((w * 0.45, 0.10), (w * 0.42, 0.12), "A-VENTANA")
        d.line((w * 0.45, 0.10), (w * 0.42, 0.08), "A-VENTANA")
    elif kind == "VENTANA":         # w, t
        w, t = P
        d.line((0, -t / 2), (w, -t / 2), "A-VENTANA", lw=0.13)
        d.line((0, t / 2), (w, t / 2), "A-VENTANA", lw=0.13)
        d.line((0, -0.015), (w, -0.015), "A-VENTANA", lw=0.25)
        d.line((0, 0.015), (w, 0.015), "A-VENTANA", lw=0.25)
        d.line((0, -t / 2), (0, t / 2), "A-VENTANA", lw=0.13)
        d.line((w, -t / 2), (w, t / 2), "A-VENTANA", lw=0.13)
    elif kind == "CAMA":            # w (ancho), l (largo); cabecera en y=l
        w, l = P
        _rect(d, 0, 0, w, l, "A-MOBILIARIO")
        _rect(d, 0.08, l - 0.45, w / 2 - 0.04, l - 0.12, "A-MOBILIARIO")
        _rect(d, w / 2 + 0.04, l - 0.45, w - 0.08, l - 0.12, "A-MOBILIARIO")
        d.pline([(0, l - 0.62), (w, l - 0.62)], "A-MOBILIARIO")
        d.pline([(0, l - 0.62), (w * 0.35, l * 0.30), (w, l * 0.25)], "A-MOBILIARIO")
    elif kind == "VELADOR":
        _rect(d, 0, 0, 0.45, 0.40, "A-MOBILIARIO")
        d.circle((0.225, 0.20), 0.10, "A-MOBILIARIO")
    elif kind == "SOFA":            # l, d
        l, dd = P
        _rect(d, 0, 0, l, dd, "A-MOBILIARIO")
        _rect(d, 0.15, 0.18, l - 0.15, dd, "A-MOBILIARIO")
        for i in range(3):
            x0 = 0.15 + i * (l - 0.30) / 3
            _rect(d, x0, 0.18, x0 + (l - 0.30) / 3, 0.0 + dd * 0.55, "A-MOBILIARIO")
    elif kind == "SILLON":
        _rect(d, 0, 0, 0.80, 0.80, "A-MOBILIARIO")
        _rect(d, 0.12, 0.15, 0.68, 0.80, "A-MOBILIARIO")
    elif kind == "MESA":            # l, w, n sillas por lado
        l, w, n = P
        _rect(d, 0, 0, l, w, "A-MOBILIARIO")
        n = int(n)
        for i in range(n):
            x0 = (i + 0.5) * l / n - 0.21
            _rect(d, x0, -0.45, x0 + 0.42, -0.05, "A-MOBILIARIO")
            _rect(d, x0, w + 0.05, x0 + 0.42, w + 0.45, "A-MOBILIARIO")
    elif kind == "MESACENTRO":
        l, w = P
        _rect(d, 0, 0, l, w, "A-MOBILIARIO")
        _rect(d, 0.06, 0.06, l - 0.06, w - 0.06, "A-MOBILIARIO")
    elif kind == "INODORO":         # respaldo en y=0, mira a +y
        _rect(d, -0.22, 0, 0.22, 0.20, "A-SANITARIO")
        n = 24
        pts = [(0.18 * math.cos(2 * math.pi * k / n), 0.43 + 0.24 * math.sin(2 * math.pi * k / n)) for k in range(n)]
        d.pline(pts, "A-SANITARIO", closed=True)
    elif kind == "LAVATORIO":       # l: mueble de lavatorio, pared en y=0
        l = P[0]
        _rect(d, 0, 0, l, 0.50, "A-SANITARIO")
        n = 24
        pts = [(l / 2 + 0.20 * math.cos(2 * math.pi * k / n), 0.26 + 0.15 * math.sin(2 * math.pi * k / n)) for k in range(n)]
        d.pline(pts, "A-SANITARIO", closed=True)
        d.circle((l / 2, 0.08), 0.02, "A-SANITARIO")
    elif kind == "DUCHA":           # w, l
        w, l = P
        _rect(d, 0, 0, w, l, "A-SANITARIO")
        d.line((0, 0), (w, l), "A-SANITARIO", lw=0.09)
        d.line((0, l), (w, 0), "A-SANITARIO", lw=0.09)
        d.circle((w / 2, l / 2), 0.04, "A-SANITARIO")
    elif kind == "MAMPARA":         # vidrio de ducha, largo l
        d.line((0, 0), (P[0], 0), "A-VENTANA", lw=0.25)
    elif kind == "CLOSET":          # l, d (puertas en y=0)
        l, dd = P
        _rect(d, 0, 0, l, dd, "A-MOBILIARIO")
        d.line((0.05, dd / 2), (l - 0.05, dd / 2), "A-MOBILIARIO", ls="DASHED")
        k = 0.10
        while k < l - 0.05:
            d.line((k, dd / 2 - 0.15), (k + 0.06, dd / 2 + 0.15), "A-MOBILIARIO", lw=0.09)
            k += 0.18
    elif kind == "MUEBLE":          # mueble de cocina l x 0.60
        l = P[0]
        _rect(d, 0, 0, l, 0.60, "A-MOBILIARIO")
        d.line((0, 0.03), (l, 0.03), "A-MOBILIARIO", lw=0.09)
    elif kind == "TARJA":
        _rect(d, 0, 0.08, 0.80, 0.52, "A-SANITARIO")
        _rect(d, 0.05, 0.12, 0.38, 0.48, "A-SANITARIO")
        _rect(d, 0.42, 0.12, 0.75, 0.48, "A-SANITARIO")
    elif kind == "COCINA":
        _rect(d, 0, 0.03, 0.60, 0.57, "A-MOBILIARIO")
        for (cx, cy) in [(0.16, 0.16), (0.44, 0.16), (0.16, 0.44), (0.44, 0.44)]:
            d.circle((cx, cy), 0.09, "A-MOBILIARIO")
    elif kind == "REFRI":
        _rect(d, 0, 0, 0.70, 0.70, "A-MOBILIARIO")
        d.line((0, 0), (0.70, 0.70), "A-MOBILIARIO", lw=0.09)
        d.text((0.35, 0.22), "R", 2.0, "A-MOBILIARIO")
    elif kind == "LAVADORA":
        _rect(d, 0, 0, 0.60, 0.60, "A-MOBILIARIO")
        d.circle((0.30, 0.30), 0.22, "A-MOBILIARIO")
    elif kind == "LAVADERO":
        _rect(d, 0, 0, 0.80, 0.60, "A-SANITARIO")
        _rect(d, 0.06, 0.06, 0.74, 0.40, "A-SANITARIO")
        for k in range(4):
            d.line((0.10 + k * 0.18, 0.44), (0.10 + k * 0.18, 0.56), "A-SANITARIO", lw=0.09)
    elif kind == "PARRILLA":        # l (barra) x 0.65
        l = P[0]
        _rect(d, 0, 0, 0.65, l, "A-MOBILIARIO")
        _rect(d, 0.08, l * 0.25, 0.58, l * 0.65, "A-MOBILIARIO")
        k = l * 0.25 + 0.05
        while k < l * 0.65:
            d.line((0.08, k), (0.58, k), "A-MOBILIARIO", lw=0.09)
            k += 0.06
        _rect(d, 0.10, l * 0.75, 0.55, l * 0.95, "A-SANITARIO")
    elif kind == "ESCRITORIO":
        l = P[0]
        _rect(d, 0, 0, l, 0.55, "A-MOBILIARIO")
        _rect(d, l / 2 - 0.22, -0.45, l / 2 + 0.22, -0.05, "A-MOBILIARIO")
    elif kind == "PLANTA":          # maceta / arbusto r
        r = P[0]
        d.circle((0, 0), r, "A-JARDIN")
        for k in range(8):
            a = 2 * math.pi * k / 8
            d.line((0, 0), (r * 0.8 * math.cos(a), r * 0.8 * math.sin(a)), "A-JARDIN", lw=0.09)
    elif kind == "TV":
        _rect(d, 0, 0, P[0], 0.40, "A-MOBILIARIO")
        _rect(d, 0.15, 0.30, P[0] - 0.15, 0.36, "A-MOBILIARIO")
    elif kind == "TAG":             # marca de puerta/ventana
        pass
    else:
        raise ValueError(name)
    return d


def block_attr_positions(name, attrs):
    """Posicion de atributos visibles (en coords locales del bloque)."""
    out = {}
    if "TAG" in attrs:
        out["TAG"] = ((0, 0), 1.8, attrs["TAG"])
    return out
