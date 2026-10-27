"""
CASA LINTERNA - Modelo parametrico (fuente unica de verdad). Version 4.

Terreno 8.00 (frente a la calle) x 17.00 (fondo) = 136.00 m2
  Cochera / reuniones : 8.00 x 5.00 al frente, sin muros, cobertura metalica a una sola agua
  Vivienda            : 8.00 x 12.00 (material noble) ocupada al 100 %, 2 pisos + terraza techada;
                        solo 2 ductos de luz y ventilacion de 0.50 x 0.50 en las esquinas posteriores

Sistema de coordenadas del MODELO (metros):
  x : ancho del lote, 0 = medianera izquierda (mirando desde la calle) -> 8 = medianera derecha
  y : fondo, 0 = linea de propiedad en la calle -> 5 = fachada -> 17 = lindero posterior
  z : altura, 0.00 = NPT 1er piso
Las plantas se dibujan sin giro: calle abajo, fondo arriba.

Cada elemento 3D es un PRISMA: poligono en el plano YZ extruido en X entre x1 y x2.
Asi las coberturas inclinan hacia la calle con un solo prisma y los autos se modelan
con su perfil lateral real.
"""
from dataclasses import dataclass, field
import math

# --------------------------------------------------------------------------
# PARAMETROS GENERALES
# --------------------------------------------------------------------------
LOT_X, LOT_Y = 8.00, 17.00
LOT_W = LOT_X
Y0 = 5.00                       # fachada principal (hacia la cochera)
YB = 17.00                      # lindero posterior (la vivienda ocupa todo el fondo)
HOUSE_Y = Y0                    # compatibilidad: limite cochera / vivienda
TE, TI, TP = 0.15, 0.15, 0.10
SLAB = 0.20
BEAM_H = 0.40
LV = {1: 0.00, 2: 2.80, 3: 5.60, 4: 8.40}
LEVEL_NAMES = {1: "1er PISO", 2: "2do PISO", 3: "TERRAZA (3er NIVEL)", 4: "TECHO"}
PHASE = {1: "F1", 2: "F1", 3: "F1", 4: "F1"}

# Ejes estructurales (columnas de concreto): letras a lo ancho, numeros a lo largo
COL_X = {"A": (0.0, 0.25), "B": (3.825, 4.075), "C": (7.75, 8.0)}
COL_Y = {"1": (5.0, 5.25), "2": (9.775, 10.025), "3": (12.125, 12.375), "4": (16.75, 17.0)}
AX_X = {k: (a + b) / 2 for k, (a, b) in COL_X.items()}
AX_Y = {k: (a + b) / 2 for k, (a, b) in COL_Y.items()}
STRIP_COLS_X = (0.30, 7.70)                      # columnas metalicas de la cochera (junto a la calle)
STRIP_COL_Y = 0.30

# Escalera en U (tramos a lo ancho, descanso contra la medianera izquierda)
RISER, TREAD, N_TREADS = 0.175, 0.25, 7
ST_Y_A = (10.03, 11.03)        # tramo que arranca (sube hacia la medianera)
ST_Y_B = (11.13, 12.12)        # tramo que regresa hacia el hall
ST_X_LAND = (0.15, 1.15)
ST_X_FL = (1.15, 2.90)
STAIR_ZONE = (0.15, 10.025, 2.90, 12.125)         # x1, y1, x2, y2
DUCTS = ((0.15, 16.35, 0.65, 16.85), (7.35, 16.35, 7.85, 16.85))   # ductos de luz y ventilacion 0.50 x 0.50
YF, YM1, YM2 = 9.90, 12.25, 16.85                  # ejes de tabiques: frente | franja central | fondo interior
BALCONIES = ((0.40, 3.65), (4.30, 7.60))          # x1, x2 ; vuelan 1.10 m sobre la cochera
BAL_D = 1.10


def strip_top(y):
    """Cara superior de la cobertura de la cochera: +5.10 en la calle -> +5.60 en la fachada (10 %)."""
    return 5.10 + 0.10 * y


def terrace_top(y):
    """Cobertura de la terraza: +8.60 sobre la fachada principal -> cae 5 % hacia el patio posterior."""
    return 8.60 - 0.05 * (y - Y0)


carport_top = strip_top
roof_top = strip_top


# --------------------------------------------------------------------------
# PRIMITIVA 3D
# --------------------------------------------------------------------------
@dataclass
class Prism:
    x1: float
    x2: float
    poly: list
    mat: str
    cat: str
    level: int = 1
    phase: str = "F1"
    name: str = ""
    group: str = ""

    def yz_bounds(self):
        ys = [p[0] for p in self.poly]
        zs = [p[1] for p in self.poly]
        return min(ys), max(ys), min(zs), max(zs)


def box(x1, x2, y1, y2, z1, z2, mat, cat, **kw):
    return Prism(min(x1, x2), max(x1, x2), [(min(y1, y2), min(z1, z2)), (max(y1, y2), min(z1, z2)),
                                            (max(y1, y2), max(z1, z2)), (min(y1, y2), max(z1, z2))], mat, cat, **kw)


def sloped(x1, x2, y1, y2, top, dz_top, dz_bot, mat, cat, name, level=1, group="COBERTURA"):
    poly = [(y1, top(y1) - dz_bot), (y2, top(y2) - dz_bot), (y2, top(y2) - dz_top), (y1, top(y1) - dz_top)]
    return Prism(x1, x2, poly, mat, cat, level, "F1", name, group)


# --------------------------------------------------------------------------
# MUROS Y VANOS
# --------------------------------------------------------------------------
@dataclass
class Opening:
    name: str
    kind: str          # door | door2 | slide | window
    s1: float
    s2: float
    sill: float
    head: float
    hinge: str = "a"
    side: int = 1
    desc: str = ""


@dataclass
class Wall:
    name: str
    a: tuple
    b: tuple
    t: float
    level: int
    h: float = None
    kind: str = "albanileria"
    openings: list = field(default_factory=list)
    z0: float = None
    top_poly: list = None

    @property
    def horizontal(self):
        """True si el muro corre a lo largo de X."""
        return abs(self.a[1] - self.b[1]) < 1e-9

    def base(self):
        return LV[self.level] if self.z0 is None else self.z0

    def height(self):
        if self.h is not None:
            return self.h
        return LV[self.level + 1] - SLAB - LV[self.level]

    def rect(self):
        if self.horizontal:
            x1, x2 = sorted([self.a[0], self.b[0]])
            return (x1, self.a[1] - self.t / 2, x2, self.a[1] + self.t / 2)
        y1, y2 = sorted([self.a[1], self.b[1]])
        return (self.a[0] - self.t / 2, y1, self.a[0] + self.t / 2, y2)


def W(name, a, b, t, level, **kw):
    return Wall(name, a, b, t, level, **kw)


def _shell(L):
    """Medianeras (incluyen el patio posterior) y lindero de fondo."""
    return [W("M-MED-I", (0.075, Y0), (0.075, LOT_Y), TE, L, kind="medianera"),
            W("M-MED-D", (7.925, Y0), (7.925, LOT_Y), TE, L, kind="medianera"),
            W("M-FONDO", (0.15, 16.925), (7.85, 16.925), TE, L, kind="medianera")]


def _bath_walls(L, side, back):
    """Tabiques de un baño de 1.90 x 1.70 en la esquina del dormitorio, junto a la franja central."""
    if side == "I":
        xw, xa, xb, hinge_side = 2.10, 0.15, 2.15, 1
    else:
        xw, xa, xb, hinge_side = 5.90, 5.85, 7.85, -1
    if back:                       # dormitorio posterior: baño y 12.30 - 14.00
        return [W(f"T-BAN-{side}{L}a", (xw, 12.30), (xw, 14.05), TP, L, openings=[
                    Opening("P-02", "door", 13.15, 13.85, 0.0, 2.10, "a", hinge_side, "Baño de dormitorio")]),
                W(f"T-BAN-{side}{L}b", (xa, 14.05), (xb, 14.05), TP, L)]
    return [W(f"T-BAN-{side}{L}a", (xw, 8.10), (xw, 9.85), TP, L, openings=[
                Opening("P-02", "door", 8.25, 8.95, 0.0, 2.10, "b", hinge_side, "Baño de dormitorio")]),
            W(f"T-BAN-{side}{L}b", (xa, 8.10), (xb, 8.10), TP, L)]


def _duct_walls(L, h=None, kind="albanileria", openings=True):
    """Ductos de 0.50 x 0.50 en las esquinas posteriores; ventanas altas hacia el ducto."""
    out = []
    for side, (xa, xb, xw) in (("I", (0.15, 0.75, 0.70)), ("D", (7.25, 7.85, 7.30))):
        ops_h = [Opening("V-12", "window", xa + 0.05 if side == "I" else xb - 0.45, xa + 0.45 if side == "I" else xb - 0.05,
                         1.00, 2.20, desc="Ventana alta al ducto de luz")] if openings else []
        ops_v = [Opening("V-12", "window", 16.40, 16.80, 1.00, 2.20, desc="Ventana alta al ducto de luz")] if openings else []
        out += [W(f"T-DUCTO-{side}a", (xa, 16.30), (xb, 16.30), TP, L, h=h, kind=kind, openings=ops_h),
                W(f"T-DUCTO-{side}b", (xw, 16.35), (xw, 16.85), TP, L, h=h, kind=kind, openings=ops_v)]
    return out


def build_walls():
    walls = []
    # ================= 1er PISO: sala, comedor, cocina, dormitorio con baño =================
    L = 1
    walls += _shell(L) + [
        W("M-FRE", (0.15, 5.075), (7.85, 5.075), TE, L, kind="fachada", openings=[
            Opening("MP-01", "slide", 0.45, 2.35, 0.0, 2.40, desc="Mampara corrediza sala-cochera"),
            Opening("PP", "door2", 2.60, 3.65, 0.0, 2.40, "a", 1, "Puerta principal pivotante de madera"),
            Opening("MP-02", "slide", 4.35, 7.45, 0.0, 2.40, desc="Mampara corrediza comedor-cochera")]),
        W("T-ESC", (0.15, YF), (2.90, YF), TP, L),
        W("T-BV-1", (6.40, 9.95), (6.40, 11.50), TP, L, openings=[
            Opening("P-03", "door", 10.05, 10.70, 0.0, 2.10, "a", -1, "Baño de visitas")]),
        W("T-BV-2", (6.35, 11.50), (7.85, 11.50), TP, L),
        W("T-POST", (0.15, YM1), (7.85, YM1), TP, L, openings=[
            Opening("P-01", "door", 2.95, 3.75, 0.0, 2.10, "a", 1, "Puerta de dormitorio"),
            Opening("VN-01", "vano", 4.15, 6.30, 0.0, 2.40, desc="Vano cocina abierta-comedor")]),
        W("T-DIV-B", (3.95, 12.30), (3.95, YM2), TI, L),
    ] + _bath_walls(L, "I", True) + _duct_walls(L)
    # ================= 2do PISO: 4 dormitorios, cada uno con baño =================
    L = 2
    walls += _shell(L) + [
        W("M-FRE", (0.15, 5.075), (7.85, 5.075), TE, L, kind="fachada", openings=[
            Opening("MP-03", "slide", 0.55, 3.05, 0.0, 2.40, desc="Mampara corrediza a balcón"),
            Opening("MP-03", "slide", 4.80, 7.30, 0.0, 2.40, desc="Mampara corrediza a balcón")]),
        W("T-ANT", (0.15, YF), (7.85, YF), TP, L, openings=[
            Opening("P-01", "door", 2.95, 3.75, 0.0, 2.10, "a", -1, "Puerta de dormitorio"),
            Opening("P-01", "door", 4.15, 4.95, 0.0, 2.10, "b", -1, "Puerta de dormitorio")]),
        W("T-POST", (0.15, YM1), (7.85, YM1), TP, L, openings=[
            Opening("P-01", "door", 2.95, 3.75, 0.0, 2.10, "a", 1, "Puerta de dormitorio"),
            Opening("P-01", "door", 4.15, 4.95, 0.0, 2.10, "b", 1, "Puerta de dormitorio")]),
        W("T-DIV-F", (3.95, 5.15), (3.95, 9.85), TI, L),
        W("T-DIV-B", (3.95, 12.30), (3.95, YM2), TI, L),
    ] + _bath_walls(L, "I", False) + _bath_walls(L, "D", False) + _bath_walls(L, "I", True) + _bath_walls(L, "D", True) + _duct_walls(L)
    # ================= TERRAZA: parapetos y barandas =================
    L = 3
    walls += [
        W("PAR-MED-I", (0.075, Y0), (0.075, LOT_Y), TE, L, h=1.10, kind="parapeto"),
        W("PAR-MED-D", (7.925, Y0), (7.925, LOT_Y), TE, L, h=1.10, kind="parapeto"),
        W("PAR-FONDO", (0.15, 16.925), (7.85, 16.925), TE, L, h=1.10, kind="parapeto"),
        W("PAR-FRE", (0.15, 5.075), (7.85, 5.075), TE, L, h=1.00, kind="parapeto"),
        W("PAR-ESC-1", (0.15, 9.975), (2.90, 9.975), TP, L, h=1.00, kind="parapeto"),
        W("PAR-ESC-2", (0.15, 12.175), (2.90, 12.175), TP, L, h=1.00, kind="parapeto"),
        W("PAR-ESC-3", (2.95, 10.025), (2.95, 11.08), TP, L, h=1.00, kind="parapeto"),
    ] + _duct_walls(L, h=1.00, kind="parapeto", openings=False)
    return walls


# --------------------------------------------------------------------------
# AMBIENTES
# --------------------------------------------------------------------------
@dataclass
class Room:
    name: str
    level: int
    rect: tuple                # x1, y1, x2, y2 (modelo)
    finish: str = ""
    label_at: tuple = None     # (x, y) modelo
    area_m2: float = None

    @property
    def area(self):
        if self.area_m2 is not None:
            return self.area_m2
        x1, y1, x2, y2 = self.rect
        return (x2 - x1) * (y2 - y1)


BATH_FOOT = 2.00 * 1.80          # baño + tabiques dentro del dormitorio
DUCT_FOOT = 0.60 * 0.55          # ducto + tabiques dentro del ambiente


def build_rooms():
    lam, por, pg = "Piso laminado", "Porcelanato", "Porcelanato 60x120"
    wf, wr, db = 3.725 * 4.70, 3.825 * 4.70, 4.55
    return [
        Room("COCHERA / REUNIONES", 1, (0.0, 0.0, 8.0, 5.0), "Concreto estampado", (3.30, 2.30)),
        Room("SALA", 1, (0.15, 5.15, 3.875, 9.85), pg, (1.40, 5.75)),
        Room("COMEDOR", 1, (4.025, 5.15, 7.85, 9.85), pg, (5.80, 5.72)),
        Room("HALL", 1, (2.90, 9.95, 6.35, 12.20), pg, (3.55, 11.60), 3.45 * 2.25 + 1.45 * 0.70),
        Room("BAÑO VISITAS", 1, (6.45, 9.95, 7.85, 11.45), "Cerámico", (6.95, 10.55)),
        Room("DORMITORIO 1", 1, (0.15, 12.30, 3.875, YM2), lam, (2.70, 14.75), 3.725 * db - BATH_FOOT - DUCT_FOOT),
        Room("BAÑO 1", 1, (0.15, 12.30, 2.05, 14.00), por, (1.50, 13.45)),
        Room("COCINA", 1, (4.025, 12.30, 7.85, YM2), pg, (5.85, 15.50), 3.825 * db - DUCT_FOOT),
        Room("DORMITORIO 2", 2, (0.15, 5.15, 3.875, 9.85), lam, (2.70, 6.62), wf - BATH_FOOT),
        Room("BAÑO 2", 2, (0.15, 8.15, 2.05, 9.85), por, (1.50, 8.75)),
        Room("DORMITORIO 3", 2, (4.025, 5.15, 7.85, 9.85), lam, (5.25, 6.62), wr - BATH_FOOT),
        Room("BAÑO 3", 2, (5.95, 8.15, 7.85, 9.85), por, (6.50, 8.75)),
        Room("BALCÓN 2", 2, (0.40, 3.90, 3.65, 5.00), "Porcelanato antideslizante", (2.35, 4.50)),
        Room("BALCÓN 3", 2, (4.30, 3.90, 7.60, 5.00), "Porcelanato antideslizante", (5.75, 4.50)),
        Room("HALL", 2, (2.90, 9.95, 7.85, 12.20), lam, (4.40, 11.60), 4.95 * 2.25),
        Room("DORMITORIO 4", 2, (0.15, 12.30, 3.875, YM2), lam, (2.70, 14.75), 3.725 * db - BATH_FOOT - DUCT_FOOT),
        Room("BAÑO 4", 2, (0.15, 12.30, 2.05, 14.00), por, (1.50, 13.45)),
        Room("DORMITORIO 5", 2, (4.025, 12.30, 7.85, YM2), lam, (5.25, 14.75), 3.825 * db - BATH_FOOT - DUCT_FOOT),
        Room("BAÑO 5", 2, (5.95, 12.30, 7.85, 14.00), por, (6.50, 13.45)),
        Room("TERRAZA", 3, (0.15, 5.15, 7.85, YM2), "Porcelanato antideslizante", (4.45, 11.60),
             7.70 * 11.70 - 2.75 * 2.10 - 2 * DUCT_FOOT),
    ]


# --------------------------------------------------------------------------
# GENERACION DE PRISMAS 3D
# --------------------------------------------------------------------------
def wall_prisms(w: Wall):
    out = []
    mat = {"medianera": "muro_gris", "fachada": "muro_blanco", "parapeto": "muro_blanco"}.get(w.kind, "muro_int")
    z0 = w.base()
    H = w.height()
    x1, y1, x2, y2 = w.rect()
    s_lo, s_hi = (x1, x2) if w.horizontal else (y1, y2)
    ops = sorted(w.openings, key=lambda o: o.s1)
    cuts, cur = [], s_lo
    for o in ops:
        if o.s1 > cur:
            cuts.append((cur, o.s1, 0.0, H))
        if o.sill > 0:
            cuts.append((o.s1, o.s2, 0.0, o.sill))
        if o.head < H:
            cuts.append((o.s1, o.s2, o.head, H))
        cur = o.s2
    if cur < s_hi:
        cuts.append((cur, s_hi, 0.0, H))
    for (a, b, zl, zh) in cuts:
        if w.horizontal:
            out.append(box(a, b, y1, y2, z0 + zl, z0 + zh, mat, "muro", level=w.level, name=w.name, group=f"{w.name}@{w.level}"))
        else:
            out.append(box(x1, x2, a, b, z0 + zl, z0 + zh, mat, "muro", level=w.level, name=w.name, group=f"{w.name}@{w.level}"))
    for o in ops:
        zl, zh = z0 + o.sill, z0 + o.head
        gid = f"{o.name}@{w.name}@{o.s1:.2f}@{w.level}"
        if o.kind == "vano":
            continue
        if o.kind == "window":
            m, c = "vidrio", "ventana"
        elif o.kind == "slide":
            m, c = "vidrio", "puerta"
        elif o.kind == "door2":
            m, c = "madera_osc", "puerta"
        else:
            m, c = "madera", "puerta"
        if w.horizontal:
            yc = (y1 + y2) / 2
            out.append(box(o.s1, o.s2, yc - 0.03, yc + 0.03, zl, zh, m, c, level=w.level, name=o.name, group=gid))
            if m == "vidrio":
                xs = [o.s1, o.s2 - 0.05] + ([(o.s1 + o.s2) / 2 - 0.025] if o.kind == "slide" else [])
                for xx in xs:
                    out.append(box(xx, xx + 0.05, yc - 0.04, yc + 0.04, zl, zh, "aluminio", c, level=w.level, name=o.name, group=gid))
                for zz in (zl, zh - 0.05):
                    out.append(box(o.s1, o.s2, yc - 0.04, yc + 0.04, zz, zz + 0.05, "aluminio", c, level=w.level, name=o.name, group=gid))
            elif o.kind in ("door", "door2"):
                out.append(box(o.s1 + 0.05, o.s1 + 0.12, yc + 0.03, yc + 0.06, zl + 1.0, zl + 1.05, "acero_galv", c, level=w.level, name=o.name, group=gid))
        else:
            xc = (x1 + x2) / 2
            out.append(box(xc - 0.03, xc + 0.03, o.s1, o.s2, zl, zh, m, c, level=w.level, name=o.name, group=gid))
            if m == "vidrio":
                for yy in (o.s1, o.s2 - 0.05):
                    out.append(box(xc - 0.04, xc + 0.04, yy, yy + 0.05, zl, zh, "aluminio", c, level=w.level, name=o.name, group=gid))
                for zz in (zl, zh - 0.05):
                    out.append(box(xc - 0.04, xc + 0.04, o.s1, o.s2, zz, zz + 0.05, "aluminio", c, level=w.level, name=o.name, group=gid))
    return out


def stair_prisms(storey):
    """Escalera en U con tramos a lo ancho del lote: escalones macizos (soffit escalonado)."""
    z0 = LV[storey]
    g = f"ESC-{storey}"
    out = []
    xf, xl = ST_X_FL[1], ST_X_FL[0]
    for i in range(1, N_TREADS + 1):                                   # tramo A: sube hacia la medianera
        xa = xf - TREAD * i
        zt = z0 + RISER * i
        out.append(box(xa, xa + TREAD, ST_Y_A[0], ST_Y_A[1], max(z0 - 0.02, zt - 0.32), zt, "concreto", "escalera",
                       level=storey, name=f"ESC-T1-{storey}", group=g))
    zl = z0 + 8 * RISER
    out.append(box(ST_X_LAND[0], ST_X_LAND[1], STAIR_ZONE[1], STAIR_ZONE[3], zl - SLAB, zl, "concreto", "escalera",
                   level=storey, name=f"ESC-DESC-{storey}", group=g))
    for j in range(1, N_TREADS + 1):                                   # tramo B: regresa hacia el hall
        xa = xl + TREAD * (j - 1)
        zt = zl + RISER * j
        out.append(box(xa, xa + TREAD, ST_Y_B[0], ST_Y_B[1], zt - 0.32, zt, "concreto", "escalera",
                       level=storey, name=f"ESC-T2-{storey}", group=g))
    ym = (ST_Y_A[1] + ST_Y_B[0]) / 2
    for k in range(N_TREADS):
        xa = xl + TREAD * k
        out.append(box(xa, xa + TREAD, ym - 0.03, ym + 0.03, zl + RISER * (k + 1) - 0.30, zl + RISER * (k + 1) + 0.95, "vidrio", "baranda",
                       level=storey, name=f"BAR-{storey}", group=g))
    return out


def _slab(L, z, name):
    t = (z - SLAB, z)
    sx1, sy1, sx2, sy2 = STAIR_ZONE
    (a1, b1, a2, b2), (c1, _, c2, _) = DUCTS
    kw = dict(level=L, name=name, group=name)
    return [box(0, 8, Y0, sy1, *t, "concreto", "losa", **kw),
            box(0, 8, sy2, b1, *t, "concreto", "losa", **kw),
            box(0, sx1, sy1, sy2, *t, "concreto", "losa", **kw),
            box(sx2, 8, sy1, sy2, *t, "concreto", "losa", **kw),
            box(0, a1, b1, YB, *t, "concreto", "losa", **kw),
            box(a2, c1, b1, YB, *t, "concreto", "losa", **kw),
            box(c2, 8, b1, YB, *t, "concreto", "losa", **kw)]


def slab_prisms():
    out = [box(0, 8, Y0, YB, -0.10, 0.0, "piso_int", "losa", level=1, name="CONTRAPISO-1"),
           box(0, 8, 0, Y0, -0.15, -0.05, "piso_cochera", "losa", level=1, name="LOSA-COCHERA"),
           box(0, 8, -1.20, 0, -0.30, -0.15, "vereda", "losa", level=1, name="VEREDA")]
    out += _slab(2, LV[2], "LOSA-2")
    out += _slab(3, LV[3], "LOSA-3")
    # balcones del 2do piso (volados sobre la cochera) + barandas de vidrio
    yb = Y0 - BAL_D
    for (x1, x2) in BALCONIES:
        g = f"BALCON-{x1}"
        out.append(box(x1, x2, yb, Y0, LV[2] - SLAB, LV[2], "concreto_visto", "losa", level=2, name="BALCÓN", group=g))
        out.append(box(x1, x2, yb + 0.02, yb + 0.05, LV[2], LV[2] + 1.0, "vidrio", "baranda", level=2, name="BARANDA BALCÓN", group=g))
        out.append(box(x1, x2, yb, yb + 0.07, LV[2] + 0.98, LV[2] + 1.03, "acero", "baranda", level=2, name="PASAMANOS", group=g))
        for xx in (x1, x2 - 0.03):
            out.append(box(xx, xx + 0.03, yb + 0.02, Y0, LV[2], LV[2] + 1.0, "vidrio", "baranda", level=2, name="BARANDA BALCÓN", group=g))
    return out


def structure_prisms():
    out = []
    for ax, (x1, x2) in COL_X.items():
        for ay, (y1, y2) in COL_Y.items():
            nm = f"C-{ax}{ay}"
            out.append(box(x1, x2, y1, y2, -1.0, LV[3] + 1.0, "concreto", "columna", level=1, name=nm, group=nm))
            out.append(box(max(x1 - 0.35, 0), min(x2 + 0.35, 8), y1 - 0.35, y2 + 0.35,
                           -1.60, -1.00, "cimiento", "cimentacion", level=1, name=f"Z-{ax}{ay}"))
    for L in (2, 3):
        z = LV[L]
        b = (z - BEAM_H, z - SLAB)
        for ay, (y1, y2) in COL_Y.items():
            out.append(box(0.0, 8.0, y1, y2, *b, "concreto", "viga", level=L, name=f"VP-{ay}"))
        for ax, (x1, x2) in COL_X.items():
            out.append(box(x1, x2, Y0, YB, *b, "concreto", "viga", level=L, name=f"VS-{ax}"))
        out.append(box(2.90, 3.15, STAIR_ZONE[1], STAIR_ZONE[3], *b, "concreto", "viga", level=L, name="VB-ESC"))
    for (x1, x2, y1, y2) in [(0, 8, Y0, 5.60), (0, 0.60, Y0, LOT_Y), (7.40, 8.0, Y0, LOT_Y),
                             (0, 8, 16.40, LOT_Y), (0, 8, 9.62, 10.18), (0, 8, 11.97, 12.53), (3.68, 4.23, Y0, YB)]:
        out.append(box(x1, x2, y1, y2, -1.00, -0.30, "cimiento", "cimentacion", level=1, name="CIMIENTO"))
    return out


def facade_prisms():
    """Bandas de losa en la fachada principal y jardinera del pozo de luz."""
    out = []
    for (zb, zt_, L) in ((LV[2] - SLAB, LV[2], 2), (LV[3] - SLAB, LV[3] + 1.0, 3)):
        out.append(box(0.0, 8.0, Y0 - 0.08, Y0 + 0.02, zb, zt_, "concreto_visto", "fachada", level=L, name="BANDA-LOSA"))
    # celosia de madera en el frente de la terraza (sobre el parapeto)
    x = 0.20
    while x < 7.80:
        out.append(box(x, x + 0.04, Y0 - 0.06, Y0 - 0.02, LV[3] + 1.0, LV[3] + 2.35, "madera", "celosia", level=3,
                       name="CELOSÍA TERRAZA", group="CELOSIA-TERRAZA"))
        x += 0.12
    return out


def strip_cover_prisms():
    """Cobertura de la cochera 8 x 5: una sola agua hacia la calle, 2 columnas sobre pedestales."""
    out = []
    t = strip_top
    out.append(sloped(0.0, 8.0, 3.70, 4.95, t, 0.0, 0.012, "policarbonato", "cobertura", "POLICARBONATO (luz a fachada)"))
    out.append(sloped(0.0, 8.0, 0.05, 3.70, t, 0.0, 0.05, "panel_tr4", "cobertura", "PANEL TR4 COCHERA"))
    for yc in (0.20, 0.95, 1.70, 2.45, 3.20, 3.95, 4.70):
        out.append(sloped(0.05, 7.95, yc - 0.025, yc + 0.025, t, 0.05, 0.15, "acero", "correa", "CORREA CO-1 50x100x2"))
    for i in range(7):
        xc = 0.30 + i * 7.40 / 6
        out.append(sloped(xc - 0.05, xc + 0.05, 0.05, 4.95, t, 0.15, 0.35, "acero", "viga_met", "VIGA VM-1 100x200x3"))
    out.append(box(0.05, 7.95, 4.90, 5.00, t(4.95) - 0.55, t(4.95) - 0.35, "acero", "viga_met", name="ÁNGULO AN-1 L100x100x6", group="COBERTURA"))
    ztop = t(STRIP_COL_Y) - 0.35
    out.append(box(0.05, 7.95, STRIP_COL_Y - 0.075, STRIP_COL_Y + 0.075, ztop - 0.30, ztop, "acero", "viga_met", name="VIGA VM-2 150x300x4", group="COBERTURA"))
    for xc in STRIP_COLS_X:
        yc = STRIP_COL_Y
        nm = f"CM-{xc:.2f}"
        out.append(box(xc - 0.075, xc + 0.075, yc - 0.075, yc + 0.075, 0.512, ztop - 0.30, "acero", "columna_met", name="COL CM-1 150x150x4", group=nm))
        out.append(box(xc - 0.15, xc + 0.15, yc - 0.15, yc + 0.15, 0.50, 0.512, "acero", "columna_met", name="PLANCHA BASE 300x300x12", group=nm))
        for dx in (-0.10, 0.10):
            for dy in (-0.10, 0.10):
                out.append(box(xc + dx - 0.008, xc + dx + 0.008, yc + dy - 0.008, yc + dy + 0.008, 0.05, 0.56, "acero_galv", "columna_met", name="PERNO DE ANCLAJE 5/8", group=nm))
        out.append(box(xc - 0.20, xc + 0.20, yc - 0.20, yc + 0.20, -0.60, 0.50, "concreto_visto", "pedestal", name="PEDESTAL 0.40x0.40", group=nm))
        zx = min(max(xc - 0.45, 0.0), 7.10)
        out.append(box(zx, zx + 0.90, 0.0, 0.90, -1.20, -0.60, "cimiento", "cimentacion", name=f"ZAPATA {nm}"))
        xb = xc + 0.10 if xc < 4 else xc - 0.18
        out.append(box(xb, xb + 0.08, 0.06, 0.14, -0.05, t(0.1) - 0.12, "acero_galv", "bajante", name="BAJANTE 3in", group=nm))
    out.append(box(0.05, 7.95, 0.0, 0.20, t(0.1) - 0.12, t(0.1) + 0.07, "acero_galv", "canaleta", name="CANALETA COCHERA", group="COBERTURA"))
    return out


def terrace_cover_prisms():
    out = []
    t = terrace_top
    kw = dict(level=3, group="COB-TERRAZA")
    out.append(sloped(0.0, 8.0, Y0 + 0.05, 16.10, t, 0.0, 0.05, "panel_tr4", "cobertura", "PANEL TR4 TERRAZA", 3, "COB-TERRAZA"))
    out.append(sloped(0.0, 8.0, 16.10, YB - 0.05, t, 0.0, 0.012, "policarbonato", "cobertura", "POLICARBONATO SOBRE DUCTOS", 3, "COB-TERRAZA"))
    for yc in [5.25 + i * 1.0 for i in range(12)] + [16.85]:
        out.append(sloped(0.05, 7.95, yc - 0.025, yc + 0.025, t, 0.05, 0.15, "acero", "correa", "CORREA CO-1 50x100x2", 3, "COB-TERRAZA"))
    for xc in (0.20, AX_X["B"], 7.80):
        out.append(sloped(xc - 0.05, xc + 0.05, Y0 + 0.05, YB - 0.05, t, 0.15, 0.40, "acero", "viga_met", "VIGA VT-1 100x250x3", 3, "COB-TERRAZA"))
        for yc in (5.20, AX_Y["2"], AX_Y["3"], 16.80):
            out.append(box(xc - 0.05, xc + 0.05, yc - 0.05, yc + 0.05, LV[3], t(yc) - 0.40, "acero", "columna_met", name="COL CT-1 100x100x3", **kw))
    out.append(box(0.05, 7.95, YB - 0.20, YB - 0.02, t(YB) - 0.12, t(YB) + 0.05, "acero_galv", "canaleta", name="CANALETA TERRAZA", **kw))
    for (d1, d2) in ((0.20, 0.28), (7.72, 7.80)):
        out.append(box(d1, d2, 16.40, 16.48, -0.05, t(YB) - 0.12, "acero_galv", "bajante", level=1, name="BAJANTE 3in (en ducto)", group="COB-TERRAZA"))
    return out


# --------------------------------------------------------------------------
# MOBILIARIO REALISTA (3D por piezas) + BLOQUES 2D equivalentes para las plantas
# --------------------------------------------------------------------------
PLAN2D = []          # (nivel, bloque, (x, y), rot, sx, sy)


def reg(level, block, pos, rot=0.0, sx=1.0, sy=1.0):
    PLAN2D.append((level, block, (round(pos[0], 4), round(pos[1], 4)), rot, sx, sy))


def _xf(dx, dy, ox, oy, rot):
    """Local (a lo largo, a lo ancho) -> global segun orientacion rot en grados (0,90,180,270)."""
    rot = rot % 360
    if rot == 0:
        return ox + dx, oy + dy
    if rot == 90:
        return ox - dy, oy + dx
    if rot == 180:
        return ox - dx, oy - dy
    return ox + dy, oy - dx


def lbox(ox, oy, rot, a1, a2, b1, b2, z1, z2, mat, cat, name, group, level=1):
    """Caja en coordenadas locales (a: fondo/largo, b: ancho) de un mueble orientado."""
    p1 = _xf(a1, b1, ox, oy, rot)
    p2 = _xf(a2, b2, ox, oy, rot)
    return box(min(p1[0], p2[0]), max(p1[0], p2[0]), min(p1[1], p2[1]), max(p1[1], p2[1]), z1, z2, mat, cat,
               level=level, name=name, group=group)


def bed(ox, oy, rot, w, l, z, level, tag, stands=(True, True)):
    """Cama: cabecera en a=0, largo l a lo largo de a, ancho w a lo ancho de b."""
    g = f"CAMA-{tag}"
    o = []
    o.append(lbox(ox, oy, rot, 0.0, 0.06, 0, w, z, z + 1.05, "madera", "mobiliario", "CABECERA", g, level))
    o.append(lbox(ox, oy, rot, 0.06, l, 0.02, w - 0.02, z + 0.12, z + 0.32, "madera_osc", "mobiliario", "BASE CAMA", g, level))
    o.append(lbox(ox, oy, rot, 0.08, l - 0.02, 0.04, w - 0.04, z + 0.32, z + 0.55, "colchon", "mobiliario", "COLCHÓN", g, level))
    o.append(lbox(ox, oy, rot, 0.62, l - 0.01, 0.02, w - 0.02, z + 0.55, z + 0.60, "edredon", "mobiliario", "EDREDÓN", g, level))
    o.append(lbox(ox, oy, rot, l - 0.45, l - 0.01, 0.0, w, z + 0.30, z + 0.58, "edredon", "mobiliario", "PIE EDREDÓN", g, level))
    n = 2 if w > 1.2 else 1
    pw = (w - 0.20) / n
    for k in range(n):
        b0 = 0.10 + k * pw
        o.append(lbox(ox, oy, rot, 0.12, 0.50, b0 + 0.03, b0 + pw - 0.03, z + 0.55, z + 0.70, "almohada", "mobiliario", "ALMOHADA", g, level))
    reg(level, f"CAMA_{w:.2f}_{l:.2f}", _xf(l, 0, ox, oy, rot), rot + 90)
    for use, b0 in zip(stands, (-0.50, w + 0.05)):
        if not use:
            continue
        o.append(lbox(ox, oy, rot, 0.02, 0.42, b0, b0 + 0.45, z, z + 0.50, "madera", "mobiliario", "VELADOR", g, level))
        cxy = _xf(0.21, b0 + 0.225, ox, oy, rot)
        o += vcyl(cxy[0], cxy[1], z + 0.50, z + 0.62, 0.04, "acero", "mobiliario", "LÁMPARA", g, level, n=4)
        o += vcyl(cxy[0], cxy[1], z + 0.62, z + 0.82, 0.11, "lampara", "mobiliario", "LÁMPARA", g, level, n=6, r2=0.08)
        reg(level, "VELADOR", _xf(0.02, b0 + 0.45, ox, oy, rot), rot - 90)
    return o


def sofa(ox, oy, rot, l, d, z, level, tag, mat="tela_osc", cush="tela"):
    """Sofa: respaldo en a=0, largo l (b), fondo d (a)."""
    g = f"SOFA-{tag}"
    o = [lbox(ox, oy, rot, 0.0, d, 0.0, l, z + 0.08, z + 0.42, mat, "mobiliario", "BASE SOFÁ", g, level),
         lbox(ox, oy, rot, 0.0, 0.20, 0.0, l, z + 0.42, z + 0.85, mat, "mobiliario", "RESPALDO", g, level),
         lbox(ox, oy, rot, 0.0, d, 0.0, 0.18, z + 0.42, z + 0.62, mat, "mobiliario", "BRAZO", g, level),
         lbox(ox, oy, rot, 0.0, d, l - 0.18, l, z + 0.42, z + 0.62, mat, "mobiliario", "BRAZO", g, level)]
    n = 3 if l > 1.4 else 1
    cw = (l - 0.36) / n
    for k in range(n):
        b0 = 0.18 + k * cw
        o.append(lbox(ox, oy, rot, 0.20, d - 0.02, b0 + 0.01, b0 + cw - 0.01, z + 0.42, z + 0.52, cush, "mobiliario", "COJÍN", g, level))
        o.append(lbox(ox, oy, rot, 0.20, 0.34, b0 + 0.05, b0 + cw - 0.05, z + 0.52, z + 0.80, cush, "mobiliario", "COJÍN RESPALDO", g, level))
    reg(level, f"SOFA_{l:.2f}_{d:.2f}", (ox, oy), rot - 90, -1.0, 1.0)
    return o


def table(x1, y1, x2, y2, z, level, tag, h=0.75, mat="madera", block=None):
    g = f"MESA-{tag}"
    o = [box(x1, x2, y1, y2, z + h - 0.04, z + h, mat, "mobiliario", level=level, name="TABLERO", group=g)]
    for (xa, ya) in ((x1 + 0.05, y1 + 0.05), (x2 - 0.10, y1 + 0.05), (x1 + 0.05, y2 - 0.10), (x2 - 0.10, y2 - 0.10)):
        o.append(box(xa, xa + 0.05, ya, ya + 0.05, z, z + h - 0.04, "acero", "mobiliario", level=level, name="PATA", group=g))
    if block:
        reg(level, block, (x1, y1))
    return o


def chair(cx, cy, rot, z, level, tag, mat="madera"):
    """Silla: el respaldo queda hacia +a local."""
    g = f"SILLA-{tag}"
    o = [lbox(cx, cy, rot, -0.21, 0.21, -0.21, 0.21, z + 0.43, z + 0.47, mat, "mobiliario", "ASIENTO", g, level),
         lbox(cx, cy, rot, 0.17, 0.21, -0.21, 0.21, z + 0.47, z + 0.88, mat, "mobiliario", "RESPALDO", g, level)]
    for (a, b) in ((-0.19, -0.19), (0.15, -0.19), (-0.19, 0.15), (0.15, 0.15)):
        o.append(lbox(cx, cy, rot, a, a + 0.04, b, b + 0.04, z, z + 0.43, "acero", "mobiliario", "PATA", g, level))
    return o


def dining(x1, y1, x2, y2, z, level, tag, mat="madera"):
    """Mesa con sillas a ambos lados largos (largo a lo largo de x)."""
    n = max(1, int((x2 - x1) / 0.60 + 1e-6))
    o = table(x1, y1, x2, y2, z, level, tag, mat=mat, block=f"MESA_{x2 - x1:.2f}_{y2 - y1:.2f}_{n}")
    for k in range(n):
        cx = x1 + (k + 0.5) * (x2 - x1) / n
        o += chair(cx, y1 - 0.25, 270, z, level, f"{tag}-{k}a")
        o += chair(cx, y2 + 0.25, 90, z, level, f"{tag}-{k}b")
    return o


def kitchen_run(x1, x2, y_wall, depth_dir, z, level, tag, uppers=True):
    """Muebles bajos de cocina a lo largo de x junto a un muro en y_wall; depth_dir=+1/-1 hacia el ambiente."""
    g = f"COCINA-{tag}"
    yw, yi = y_wall, y_wall + 0.60 * depth_dir
    o = [box(x1, x2, min(yw, yi), max(yw, yi), z + 0.10, z + 0.88, "laca", "mobiliario", level=level, name="MUEBLE BAJO", group=g),
         box(x1, x2, min(yw, yi + 0.02 * depth_dir), max(yw, yi + 0.02 * depth_dir), z + 0.88, z + 0.92, "cuarzo", "mobiliario", level=level, name="ENCIMERA", group=g),
         box(x1, x2, min(yw, yi - 0.05 * depth_dir), max(yw, yi - 0.05 * depth_dir), z, z + 0.10, "acero", "mobiliario", level=level, name="ZÓCALO", group=g)]
    if uppers:
        yu = y_wall + 0.35 * depth_dir
        o.append(box(x1, x2, min(yw, yu), max(yw, yu), z + 1.50, z + 2.20, "laca", "mobiliario", level=level, name="MUEBLE ALTO", group=g))
    if depth_dir > 0:
        reg(level, f"MUEBLE_{x2 - x1:.2f}", (x1, y_wall))
    else:
        reg(level, f"MUEBLE_{x2 - x1:.2f}", (x2, y_wall), 180)
    return o


def sphere(cx, cy, cz, rx, rz, mat, cat, name, group, level=1, n=9, seg=14, ry=None):
    """Elipsoide aproximado por rebanadas transversales (poligonos en YZ)."""
    ry = rx if ry is None else ry
    out = []
    for k in range(n):
        ta = -rx + 2 * rx * k / n
        tb = -rx + 2 * rx * (k + 1) / n
        tm = (ta + tb) / 2
        f = math.sqrt(max(1 - (tm / rx) ** 2, 0.0))
        if f < 0.05:
            continue
        poly = [(cy + ry * f * math.cos(2 * math.pi * i / seg), cz + rz * f * math.sin(2 * math.pi * i / seg)) for i in range(seg)]
        out.append(Prism(cx + ta, cx + tb, poly, mat, cat, level, "F1", name, group))
    return out


def vcyl(cx, cy, z1, z2, r, mat, cat, name, group, level=1, n=8, r2=None):
    """Cilindro (o tronco de cono) de eje vertical por rebanadas."""
    r2 = r if r2 is None else r2
    out = []
    for k in range(n):
        ta = -r + 2 * r * k / n
        tb = -r + 2 * r * (k + 1) / n
        tm = (ta + tb) / 2
        f = math.sqrt(max(1 - (tm / r) ** 2, 0.0))
        poly = [(cy - r * f, z1), (cy + r * f, z1), (cy + r2 * f, z2), (cy - r2 * f, z2)]
        out.append(Prism(cx + ta, cx + tb, poly, mat, cat, level, "F1", name, group))
    return out


def plant(cx, cy, z, level, tag, r=0.30, h=1.10):
    g = f"PLANTA-{tag}"
    o = vcyl(cx, cy, z, z + 0.42, 0.17, "maceta", "jardin", "MACETA", g, level, r2=0.21)
    o += sphere(cx, cy, z + 0.42 + (h - 0.42) * 0.55, r, (h - 0.42) * 0.55, "verde", "jardin", "FOLLAJE", g, level)
    reg(level, f"PLANTA_{r:.2f}", (cx, cy))
    return o


def toilet(cx, cy, rot, z, level, tag):
    g = f"INODORO-{tag}"
    reg(level, "INODORO", (cx, cy), rot - 90)
    return [lbox(cx, cy, rot, 0.0, 0.18, -0.20, 0.20, z + 0.40, z + 0.78, "loza", "mobiliario", "TANQUE", g, level),
            lbox(cx, cy, rot, 0.12, 0.66, -0.18, 0.18, z, z + 0.40, "loza", "mobiliario", "TAZA", g, level),
            lbox(cx, cy, rot, 0.18, 0.68, -0.19, 0.19, z + 0.40, z + 0.43, "loza", "mobiliario", "ASIENTO", g, level)]


def vanity(cx, cy, rot, w, z, level, tag):
    g = f"LAVATORIO-{tag}"
    reg(level, f"LAVATORIO_{w:.2f}", _xf(0, w / 2, cx, cy, rot), rot - 90)
    return [lbox(cx, cy, rot, 0.0, 0.48, -w / 2, w / 2, z + 0.15, z + 0.82, "madera", "mobiliario", "MUEBLE LAVATORIO", g, level),
            lbox(cx, cy, rot, 0.0, 0.50, -w / 2, w / 2, z + 0.82, z + 0.86, "cuarzo", "mobiliario", "TABLERO", g, level),
            lbox(cx, cy, rot, 0.10, 0.40, -0.20, 0.20, z + 0.86, z + 0.98, "loza", "mobiliario", "OVALÍN", g, level),
            lbox(cx, cy, rot, 0.0, 0.02, -w / 2 + 0.05, w / 2 - 0.05, z + 1.10, z + 1.90, "espejo", "mobiliario", "ESPEJO", g, level)]


def shower(x1, y1, x2, y2, z, level, tag, glass_side="x2"):
    g = f"DUCHA-{tag}"
    reg(level, f"DUCHA_{x2 - x1:.2f}_{y2 - y1:.2f}", (x1, y1))
    o = [box(x1, x2, y1, y2, z, z + 0.04, "loza", "mobiliario", level=level, name="PLATO DUCHA", group=g)]
    if glass_side == "x2":
        o.append(box(x2 - 0.02, x2, y1, y2, z, z + 2.00, "vidrio", "mobiliario", level=level, name="MAMPARA DUCHA", group=g))
    elif glass_side == "y1":
        o.append(box(x1, x2, y1, y1 + 0.02, z, z + 2.00, "vidrio", "mobiliario", level=level, name="MAMPARA DUCHA", group=g))
    elif glass_side == "y2":
        o.append(box(x1, x2, y2 - 0.02, y2, z, z + 2.00, "vidrio", "mobiliario", level=level, name="MAMPARA DUCHA", group=g))
    else:
        o.append(box(x1, x1 + 0.02, y1, y2, z, z + 2.00, "vidrio", "mobiliario", level=level, name="MAMPARA DUCHA", group=g))
    return o


def wardrobe(x1, y1, x2, y2, z, level, tag, doors="-x", h=2.20):
    """Closet; doors indica el lado de las puertas ('-x', '+x', '-y', '+y')."""
    g = f"CLOSET-{tag}"
    if doors == "-x":
        reg(level, f"CLOSET_{y2 - y1:.2f}_{x2 - x1:.2f}", (x1, y2), -90)
    elif doors == "+x":
        reg(level, f"CLOSET_{y2 - y1:.2f}_{x2 - x1:.2f}", (x2, y1), 90)
    elif doors == "-y":
        reg(level, f"CLOSET_{x2 - x1:.2f}_{y2 - y1:.2f}", (x1, y1))
    else:
        reg(level, f"CLOSET_{x2 - x1:.2f}_{y2 - y1:.2f}", (x2, y2), 180)
    return [box(x1, x2, y1, y2, z, z + h, "laca", "mobiliario", level=level, name="CLOSET", group=g),
            box(x1 - 0.005, x2 + 0.005, y1 - 0.005, y2 + 0.005, z, z + 0.08, "madera_osc", "mobiliario", level=level, name="ZÓCALO CLOSET", group=g)]


def desk(x1, y1, x2, y2, z, level, tag, chair_side="-y"):
    """Escritorio con silla del lado indicado."""
    o = table(x1, y1, x2, y2, z, level, f"ESC-{tag}", h=0.75, mat="madera")
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
    if chair_side == "-y":
        reg(level, f"ESCRITORIO_{x2 - x1:.2f}", (x1, y1)); o += chair(cx, y1 - 0.30, 270, z, level, f"E{tag}")
    elif chair_side == "+y":
        reg(level, f"ESCRITORIO_{x2 - x1:.2f}", (x2, y2), 180); o += chair(cx, y2 + 0.30, 90, z, level, f"E{tag}")
    elif chair_side == "-x":
        reg(level, f"ESCRITORIO_{y2 - y1:.2f}", (x1, y2), -90); o += chair(x1 - 0.30, cy, 180, z, level, f"E{tag}")
    else:
        reg(level, f"ESCRITORIO_{y2 - y1:.2f}", (x2, y1), 90); o += chair(x2 + 0.30, cy, 0, z, level, f"E{tag}")
    return o


def car(x0, y0, color, tag, L=4.45, Wd=1.80):
    """Auto compacto con su perfil lateral real (poligono YZ) extruido a lo ancho.
    Largo a lo largo de +y desde y0 (posterior) hasta y0+L (frente); ancho de x0 a x0+Wd."""
    g = f"AUTO-{tag}"
    o = []
    rw, fw, R, r = 0.95, L - 0.95, 0.40, 0.33

    def arch(c):
        pts = [(c - R, 0.28)]
        for k in range(11):
            th = math.pi * (1 - k / 10)
            pts.append((c + R * math.cos(th), r + R * math.sin(th)))
        pts.append((c + R, 0.28))
        return pts

    def body(inset):
        s = 1 - 2 * inset / L
        dz = 0.04 if inset else 0.0
        pts = [(0.08, 0.30)] + arch(rw) + arch(fw) + [(L - 0.08, 0.30), (L, 0.42), (L, 0.62 - dz), (L - 0.06, 0.72 - dz),
                                                      (L - 0.45, 0.81 - dz), (L - 1.05, 0.88 - dz), (0.62, 0.95 - dz),
                                                      (0.25, 0.94 - dz), (0.03, 0.85 - dz), (0.0, 0.70 - dz), (0.0, 0.45)]
        return [(y0 + L / 2 + (p - L / 2) * s, z) for p, z in pts]

    def glass(inset):
        dz = 0.07 if inset else 0.0
        pts = [(L - 1.05, 0.88), (L - 1.85 + dz, 1.38 - dz), (1.05 - dz, 1.40 - dz), (0.62, 0.95)]
        return [(y0 + p, z) for p, z in pts]

    xs = [x0, x0 + 0.05, x0 + 0.10, x0 + Wd - 0.10, x0 + Wd - 0.05, x0 + Wd]
    for i in range(5):
        o.append(Prism(xs[i], xs[i + 1], body(0.05 if i in (0, 4) else 0.0), color, "vehiculo", 1, "F1", "CARROCERÍA", g))
    gx = [x0 + 0.12, x0 + 0.20, x0 + Wd - 0.20, x0 + Wd - 0.12]
    for i in range(3):
        o.append(Prism(gx[i], gx[i + 1], glass(i != 1), "vidrio_auto", "vehiculo", 1, "F1", "VENTANAS", g))
    o.append(Prism(x0 + 0.14, x0 + Wd - 0.14, [(y0 + 1.04, 1.36), (y0 + L - 1.82, 1.35), (y0 + L - 1.90, 1.43), (y0 + 1.10, 1.45)],
                   color, "vehiculo", 1, "F1", "TECHO", g))
    o.append(box(x0 + 0.115, x0 + Wd - 0.115, y0 + 2.12, y0 + 2.22, 0.90, 1.40, color, "vehiculo", name="PARANTE", group=g))
    # paragolpes, parrilla, faros, placa
    o.append(box(x0 + 0.05, x0 + Wd - 0.05, y0 + L - 0.06, y0 + L + 0.03, 0.28, 0.45, "plastico", "vehiculo", name="PARACHOQUE", group=g))
    o.append(box(x0 + 0.05, x0 + Wd - 0.05, y0 - 0.03, y0 + 0.06, 0.30, 0.48, "plastico", "vehiculo", name="PARACHOQUE", group=g))
    o.append(box(x0 + 0.55, x0 + Wd - 0.55, y0 + L - 0.03, y0 + L + 0.005, 0.47, 0.60, "plastico", "vehiculo", name="PARRILLA", group=g))
    for xa in (x0 + 0.12, x0 + Wd - 0.45):
        o.append(box(xa, xa + 0.33, y0 + L - 0.04, y0 + L + 0.005, 0.60, 0.69, "faro", "vehiculo", name="FARO", group=g))
        o.append(box(xa, xa + 0.33, y0 - 0.005, y0 + 0.03, 0.70, 0.81, "faro_post", "vehiculo", name="STOP", group=g))
    for yy in (y0 + L + 0.03, y0 - 0.04):
        o.append(box(x0 + Wd / 2 - 0.25, x0 + Wd / 2 + 0.25, yy, yy + 0.01, 0.32, 0.44, "blanco", "vehiculo", name="PLACA", group=g))
    for xa in (x0 - 0.12, x0 + Wd):
        o.append(box(xa, xa + 0.12, y0 + L - 1.20, y0 + L - 1.08, 0.90, 1.02, color, "vehiculo", name="ESPEJO", group=g))
    # ruedas: circulo real en el plano YZ
    for c in (rw, fw):
        circ = [(y0 + c + r * math.cos(2 * math.pi * k / 20), r + r * math.sin(2 * math.pi * k / 20)) for k in range(20)]
        rim = [(y0 + c + 0.19 * math.cos(2 * math.pi * k / 16), r + 0.19 * math.sin(2 * math.pi * k / 16)) for k in range(16)]
        for (xa, xb, xr) in ((x0 - 0.01, x0 + 0.22, (x0 - 0.02, x0 - 0.01)), (x0 + Wd - 0.22, x0 + Wd + 0.01, (x0 + Wd + 0.01, x0 + Wd + 0.02))):
            o.append(Prism(xa, xb, circ, "llanta", "vehiculo", 1, "F1", "LLANTA", g))
            o.append(Prism(xr[0], xr[1], rim, "aro", "vehiculo", 1, "F1", "ARO", g))
    reg(1, f"AUTO_{L:.2f}_{Wd:.2f}", (x0, y0 + L), -90)
    return o


def tree(cx, cy, z, level, tag, h=3.4, r=1.1):
    g = f"ARBOL-{tag}"
    o = vcyl(cx, cy, z, z + h * 0.62, 0.10, "madera_osc", "jardin", "TRONCO", g, level, n=6, r2=0.07)
    o += sphere(cx, cy, z + h * 0.72, r, h * 0.28, "verde", "jardin", "COPA", g, level, n=11, seg=16)
    o += sphere(cx + r * 0.25, cy - r * 0.2, z + h * 0.88, r * 0.65, h * 0.16, "verde_claro", "jardin", "COPA", g, level, n=8)
    reg(level, f"ARBOL_{r:.2f}", (cx, cy))
    return o


def _bath(L, side, back, z):
    """Equipamiento de un baño de dormitorio (1.90 x 1.70)."""
    o = []
    tag = f"{side}{L}{'P' if back else 'F'}"
    if side == "I":
        xs, xt, xv = (0.15, 1.05), 0.60, 1.55
    else:
        xs, xt, xv = (6.95, 7.85), 7.40, 6.45
    if back:          # baño y 12.30 - 14.00 ; ducha junto al hall
        o += shower(xs[0], 12.30, xs[1], 13.20, z, L, tag, "y2")
        o += toilet(xt, 14.00, 270, z, L, tag)
        o += vanity(xv, 12.30, 90, 0.60, z, L, tag)
    else:             # baño y 8.15 - 9.85 ; ducha junto al hall
        o += shower(xs[0], 8.95, xs[1], 9.85, z, L, tag, "y1")
        o += toilet(xt, 8.15, 90, z, L, tag)
        o += vanity(xv, 9.85, 270, 0.60, z, L, tag)
    return o


def _bedroom_front(L, side, z, tag):
    """Dormitorio delantero (mampara al balcon): cama de 1.35, closet y escritorio."""
    o = []
    if side == "I":
        o += bed(0.15, 5.95, 0, 1.35, 1.90, z, L, tag)
        o += wardrobe(3.27, 6.30, 3.87, 8.00, z, L, tag, "-x")
        o += desk(3.30, 5.25, 3.87, 6.10, z, L, tag, "-x")
    else:
        o += bed(7.85, 7.30, 180, 1.35, 1.90, z, L, tag)
        o += wardrobe(4.10, 6.30, 4.70, 8.00, z, L, tag, "+x")
        o += desk(4.10, 5.25, 4.67, 6.10, z, L, tag, "+x")
    return o


def _bedroom_back(L, side, z, tag):
    """Dormitorio posterior (ventanas altas al ducto): cama de 1.35, closet y escritorio."""
    o = []
    if side == "I":
        o += bed(0.15, 14.65, 0, 1.35, 1.90, z, L, tag, stands=(True, False))
        o += wardrobe(3.27, 13.30, 3.87, 15.00, z, L, tag, "-x")
        o += desk(2.40, 16.30, 3.40, 16.85, z, L, tag, "-y")
    else:
        o += bed(7.85, 16.00, 180, 1.35, 1.90, z, L, tag, stands=(False, True))
        o += wardrobe(4.10, 13.30, 4.70, 15.00, z, L, tag, "+x")
        o += desk(4.60, 16.30, 5.60, 16.85, z, L, tag, "-y")
    return o


def program_prisms():
    o = []
    z1, z2, z3 = LV[1], LV[2], LV[3]
    # ---- cochera / reuniones: 2 autos lado a lado, pasillo al ingreso, banca y plantas
    o += car(0.60, 0.40, "pintura_1", "1")
    o += car(4.20, 0.40, "pintura_2", "2")
    o += [box(7.30, 7.80, 1.60, 3.60, -0.05, 0.40, "madera", "mobiliario", name="BANCA", group="BANCA"),
          box(7.30, 7.36, 1.60, 3.60, 0.40, 0.85, "madera", "mobiliario", name="RESPALDO BANCA", group="BANCA")]
    reg(1, "CAJA_2.00_0.50", (7.80, 1.60), 90)
    o += plant(7.45, 4.50, -0.05, 1, "C1", 0.26, 1.0)
    o += plant(7.45, 0.85, -0.05, 1, "C2", 0.26, 1.0)
    # ---- 1er piso: sala y comedor frente a la cochera, cocina abierta al fondo
    o += sofa(0.90, 9.80, 270, 2.40, 0.90, z1, 1, "S1")
    o += sofa(1.95, 6.30, 90, 0.85, 0.85, z1, 1, "S2")
    o += sofa(3.30, 6.30, 90, 0.85, 0.85, z1, 1, "S3")
    o += table(1.45, 7.55, 2.85, 8.25, z1, 1, "CENTRO", h=0.40, block="MESACENTRO_1.40_0.70")
    o += plant(0.45, 5.50, z1, 1, "S", 0.28, 1.25)
    o += plant(3.55, 9.50, z1, 1, "S2", 0.24, 1.10)
    o += dining(4.90, 6.60, 6.70, 7.50, z1, 1, "COM")
    o += [box(7.40, 7.85, 6.00, 7.60, z1, z1 + 0.06, "madera_osc", "mobiliario", level=1, name="ZÓCALO", group="APARADOR"),
          box(7.40, 7.85, 6.00, 7.60, z1 + 0.06, z1 + 0.80, "madera", "mobiliario", level=1, name="APARADOR", group="APARADOR")]
    reg(1, "CAJA_1.60_0.45", (7.85, 6.00), 90)
    # barra de desayuno entre comedor y cocina
    o += [box(4.40, 6.10, 10.70, 11.25, z1, z1 + 0.90, "laca", "mobiliario", level=1, name="BARRA", group="BARRA"),
          box(4.35, 6.15, 10.65, 11.30, z1 + 0.90, z1 + 0.94, "cuarzo", "mobiliario", level=1, name="BARRA", group="BARRA")]
    reg(1, "CAJA_1.70_0.55", (4.40, 10.70))
    for xx in (4.75, 5.25, 5.75):
        o += vcyl(xx, 10.40, z1, z1 + 0.68, 0.17, "madera", "mobiliario", "BANQUETA", f"BANQ{xx}", 1, n=6)
    # baño de visitas
    o += toilet(7.15, 11.45, 270, z1, 1, "BV")
    o += vanity(7.85, 10.40, 180, 0.45, z1, 1, "BV")
    o += plant(3.45, 10.40, z1, 1, "H1", 0.22, 0.95)
    # dormitorio 1 + baño
    o += _bedroom_back(1, "I", z1, "D1")
    o += _bath(1, "I", True, z1)
    # cocina abierta
    o += kitchen_run(4.10, 7.25, YM2, -1, z1, 1, "K1")
    o += [box(7.25, 7.85, 13.00, 15.65, z1 + 0.10, z1 + 0.88, "laca", "mobiliario", level=1, name="MUEBLE BAJO", group="COCINA-K2"),
          box(7.23, 7.85, 13.00, 15.65, z1 + 0.88, z1 + 0.92, "cuarzo", "mobiliario", level=1, name="ENCIMERA", group="COCINA-K2"),
          box(7.30, 7.85, 13.00, 15.65, z1, z1 + 0.10, "acero", "mobiliario", level=1, name="ZÓCALO", group="COCINA-K2"),
          box(7.50, 7.85, 13.00, 15.65, z1 + 1.50, z1 + 2.20, "laca", "mobiliario", level=1, name="MUEBLE ALTO", group="COCINA-K2"),
          box(7.28, 7.80, 13.95, 14.55, z1 + 0.92, z1 + 0.94, "acero", "mobiliario", level=1, name="COCINA 4H", group="COCINA-K2"),
          box(7.45, 7.85, 13.90, 14.60, z1 + 1.55, z1 + 1.95, "acero_inox", "mobiliario", level=1, name="CAMPANA", group="COCINA-K2"),
          box(4.10, 4.80, 15.45, 16.15, z1, z1 + 1.95, "acero_inox", "mobiliario", level=1, name="REFRIGERADORA", group="REFRI"),
          box(5.40, 6.20, 16.30, 16.70, z1 + 0.86, z1 + 0.93, "acero_inox", "mobiliario", level=1, name="LAVADERO COCINA", group="COCINA-K1")]
    reg(1, "MUEBLE_2.65", (7.85, 13.00), 90)
    reg(1, "COCINA", (7.85, 13.95), 90)
    reg(1, "REFRI", (4.10, 15.45))
    reg(1, "TARJA", (6.20, YM2), 180)
    o += [box(5.00, 6.40, 13.60, 14.50, z1, z1 + 0.88, "laca", "mobiliario", level=1, name="ISLA", group="ISLA"),
          box(4.95, 6.45, 13.55, 14.55, z1 + 0.88, z1 + 0.92, "cuarzo", "mobiliario", level=1, name="ISLA", group="ISLA")]
    reg(1, "CAJA_1.40_0.90", (5.00, 13.60))
    # ---- 2do piso: 2 dormitorios con balcon hacia la cochera + 2 posteriores
    o += _bedroom_front(2, "I", z2, "D2")
    o += _bath(2, "I", False, z2)
    o += _bedroom_front(2, "D", z2, "D3")
    o += _bath(2, "D", False, z2)
    o += _bedroom_back(2, "I", z2, "D4")
    o += _bath(2, "I", True, z2)
    o += _bedroom_back(2, "D", z2, "D5")
    o += _bath(2, "D", True, z2)
    o += sofa(7.85, 11.70, 180, 1.60, 0.80, z2, 2, "H2")
    o += plant(5.70, 10.30, z2, 2, "H2", 0.22, 0.95)
    for (x1, x2) in BALCONIES:
        o += chair(x1 + 0.55, Y0 - 0.55, 90, z2, 2, f"BAL{x1}")
        o += plant(x2 - 0.30, Y0 - 0.55, z2, 2, f"BAL{x1}", 0.22, 0.85)
    # ---- terraza: sala y comedor exterior al frente, parrilla y lavanderia al fondo
    o += dining(1.30, 6.30, 3.10, 7.20, z3, 3, "TER")
    o += sofa(7.80, 8.30, 180, 2.40, 0.85, z3, 3, "T1")
    o += sofa(4.85, 6.20, 0, 1.60, 0.80, z3, 3, "T2")
    o += table(5.95, 6.40, 6.75, 7.80, z3, 3, "TC", h=0.40, block="MESACENTRO_0.80_1.40")
    o += [box(0.85, 2.25, 16.25, 16.85, z3, z3 + 0.90, "concreto_visto", "mobiliario", level=3, name="BARRA PARRILLA", group="PARRILLA"),
          box(1.15, 1.75, 16.32, 16.80, z3 + 0.90, z3 + 1.00, "acero", "mobiliario", level=3, name="PARRILLA", group="PARRILLA"),
          box(1.10, 1.80, 16.30, 16.85, z3 + 1.85, z3 + 2.25, "acero", "mobiliario", level=3, name="CAMPANA", group="PARRILLA"),
          box(1.35, 1.55, 16.50, 16.70, z3 + 2.25, terrace_top(16.6) - 0.05, "acero", "mobiliario", level=3, name="CHIMENEA", group="PARRILLA")]
    reg(3, "PARRILLA_1.40", (0.85, 16.85), -90)
    o += dining(1.00, 14.20, 2.80, 15.10, z3, 3, "TER2")
    o += [box(4.60, 5.40, 16.25, 16.85, z3, z3 + 0.90, "concreto_visto", "mobiliario", level=3, name="LAVADERO", group="LAV"),
          box(5.55, 6.15, 16.25, 16.85, z3, z3 + 0.85, "blanco", "mobiliario", level=3, name="LAVADORA", group="LAV"),
          box(6.25, 6.85, 16.25, 16.85, z3, z3 + 0.85, "blanco", "mobiliario", level=3, name="SECADORA", group="LAV")]
    reg(3, "LAVADERO", (5.40, YM2), 180)
    reg(3, "LAVADORA", (6.15, YM2), 180)
    reg(3, "LAVADORA", (6.85, YM2), 180)
    for yy in (13.6, 14.1, 14.6, 15.1):
        o.append(box(4.40, 7.60, yy - 0.005, yy + 0.005, z3 + 1.90, z3 + 1.91, "acero", "mobiliario", level=3, name="TENDAL", group="TENDAL-T"))
    for (cx, cy) in ((0.45, 5.45), (3.60, 5.45), (7.55, 5.45), (0.45, 13.20), (3.55, 12.60)):
        o += plant(cx, cy, z3, 3, f"T{cx}{cy}", 0.25, 1.0)
    return o


SPLIT_PREFIX = ("C-",)


def split_by_levels(p):
    if len(p.poly) != 4 or not p.name.startswith(SPLIT_PREFIX):
        return [p]
    y1, y2, z1, z2 = p.yz_bounds()
    zs = [z1] + [c for c in (LV[2], LV[3]) if z1 + 1e-6 < c < z2 - 1e-6] + [z2]
    out = []
    for a, b in zip(zs[:-1], zs[1:]):
        mid = (a + b) / 2
        lvl = 1 if mid < LV[2] else 2 if mid < LV[3] else 3
        out.append(box(p.x1, p.x2, y1, y2, a, b, p.mat, p.cat, level=lvl, name=p.name, group=p.group))
    return out


_ALL = None


def all_prisms():
    global _ALL
    if _ALL is not None:
        return _ALL
    PLAN2D.clear()
    P = []
    for w in build_walls():
        P += wall_prisms(w)
    for s in (1, 2):
        P += stair_prisms(s)
    P += slab_prisms() + structure_prisms() + facade_prisms() + strip_cover_prisms() + terrace_cover_prisms() + program_prisms()
    out = []
    for p in P:
        out += split_by_levels(p)
    _ALL = out
    return out


def plan2d(level):
    all_prisms()
    return [it for it in PLAN2D if it[0] == level]


MATERIALS = {
    "muro_blanco": ("#f4f1ea", 1.0), "muro_gris": ("#d9d5cc", 1.0), "muro_int": ("#efebe3", 1.0),
    "concreto": ("#b9b6b0", 1.0), "concreto_visto": ("#8f8c87", 1.0), "cimiento": ("#9c958a", 1.0),
    "vidrio": ("#9ec9dc", 0.35), "aluminio": ("#3a3d40", 1.0), "madera": ("#b07a45", 1.0),
    "madera_osc": ("#6b4528", 1.0), "acero": ("#2f3236", 1.0), "acero_galv": ("#a7adb2", 1.0), "acero_inox": ("#c9ccce", 1.0),
    "panel_tr4": ("#4a4f55", 1.0), "policarbonato": ("#e8f2f5", 0.50), "celosia_met": ("#3b3f44", 0.55),
    "piso_int": ("#d8cdbb", 1.0), "piso_ext": ("#cfc8bb", 1.0), "piso_cochera": ("#b3aea4", 1.0), "vereda": ("#bdbab3", 1.0),
    "canto_rodado": ("#c9c3b6", 1.0),
    "verde": ("#5f8f4e", 1.0), "verde_claro": ("#77a65c", 1.0), "maceta": ("#7d5a44", 1.0), "tela": ("#d8d2c6", 1.0), "tela_osc": ("#6f7378", 1.0),
    "cuarzo": ("#ebe8e2", 1.0), "laca": ("#e9e6df", 1.0), "blanco": ("#fafafa", 1.0), "loza": ("#f7f7f5", 1.0),
    "espejo": ("#c7d6dd", 1.0), "colchon": ("#f2efe8", 1.0), "edredon": ("#8fa3ad", 1.0), "almohada": ("#fbfaf7", 1.0),
    "lampara": ("#f3e2b3", 1.0), "pantalla": ("#111315", 1.0),
    "pintura_1": ("#e6e8ea", 1.0), "pintura_2": ("#2d4f73", 1.0), "vidrio_auto": ("#26323a", 1.0),
    "llanta": ("#1b1c1e", 1.0), "aro": ("#b8bcc0", 1.0), "plastico": ("#2a2b2d", 1.0), "faro": ("#f4f6f8", 1.0),
    "faro_post": ("#a3221c", 1.0),
}

if __name__ == "__main__":
    P = all_prisms()
    print(len(P), "prismas", len(PLAN2D), "bloques 2D")
    for r in build_rooms():
        print(f"{r.level} {r.name:22s} {r.area:6.2f}")
