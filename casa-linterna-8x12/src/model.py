"""
CASA LINTERNA 8x12 - Modelo parametrico (fuente unica de verdad).

Sistema de coordenadas (metros):
  x : ancho del lote (0 = medianera izquierda vista desde la calle, 8 = medianera derecha)
  y : fondo del lote (0 = linea de fachada / calle, 12 = lindero posterior)
  z : altura (0.00 = NPT primer piso)

Zonificacion:
  Edificacion material noble : x 0-8, y 0-7   (8.00 x 7.00 = 56.00 m2)  -> 2 pisos + proyeccion 3er piso
  Area libre (cobertura liviana): x 0-8, y 7-12 (8.00 x 5.00 = 40.00 m2)

Todos los elementos 3D se describen como PRISMAS: un poligono en el plano YZ
extruido a lo largo de X entre x1 y x2. Con esa unica primitiva se generan
el visor 3D, el IFC, los cortes y las elevaciones.
"""
from dataclasses import dataclass, field
import math

# --------------------------------------------------------------------------
# PARAMETROS GENERALES
# --------------------------------------------------------------------------
LOT_W, LOT_D = 8.00, 12.00
BLD_D = 7.00
TE, TI = 0.25, 0.15            # muro exterior / interior
SLAB = 0.20                    # losa aligerada h=0.20
BEAM_H = 0.40                  # peralte de vigas
LV = {1: 0.00, 2: 2.80, 3: 5.60, 4: 8.40}   # NPT por nivel (4 = azotea)
LEVEL_NAMES = {1: "1er PISO", 2: "2do PISO", 3: "3er PISO (PROYECCION)", 4: "AZOTEA"}
PHASE = {1: "F1", 2: "F1", 3: "F2", 4: "F2"}  # F2 = proyeccion 3er piso

# Ejes estructurales
AX_X = {"1": 0.125, "2": 2.225, "3": 5.375, "4": 7.875}
AX_Y = {"A": 0.125, "B": 3.975, "C": 6.875}

# Escalera en U (por entrepiso): 16 contrapasos de 0.175, pasos de 0.25
RISER, TREAD, N_TREADS = 0.175, 0.25, 7
ST_X_A = (0.25, 1.15)          # tramo 1 (sube hacia la fachada)
ST_X_B = (1.25, 2.15)          # tramo 2 (sube hacia el fondo)
ST_Y_LAND = (0.25, 1.25)       # descanso junto a la fachada-linterna
ST_Y_FL = (1.25, 3.00)         # tramos

# Cobertura liviana del area libre: pendiente 10 % subiendo hacia el fondo
ROOF_Z0, ROOF_SLOPE = 3.05, 0.10


def roof_top(y):
    return ROOF_Z0 + ROOF_SLOPE * (y - BLD_D)


# --------------------------------------------------------------------------
# PRIMITIVA 3D
# --------------------------------------------------------------------------
@dataclass
class Prism:
    x1: float
    x2: float
    poly: list            # [(y, z), ...] antihorario
    mat: str
    cat: str              # categoria BIM: muro, losa, columna, viga, escalera, vidrio, ...
    level: int = 1
    phase: str = "F1"
    name: str = ""
    group: str = ""       # agrupa piezas de un mismo elemento (p.ej. un muro con vanos)

    def yz_bounds(self):
        ys = [p[0] for p in self.poly]
        zs = [p[1] for p in self.poly]
        return min(ys), max(ys), min(zs), max(zs)


def box(x1, x2, y1, y2, z1, z2, mat, cat, **kw):
    return Prism(min(x1, x2), max(x1, x2),
                 [(y1, z1), (y2, z1), (y2, z2), (y1, z2)], mat, cat, **kw)


# --------------------------------------------------------------------------
# MUROS Y VANOS
# --------------------------------------------------------------------------
@dataclass
class Opening:
    name: str          # tag: P1, V1 ...
    kind: str          # door | door2 (doble/pivot) | slide | window | void
    s1: float          # inicio a lo largo del eje del muro (coordenada absoluta x o y)
    s2: float
    sill: float        # alfeizar respecto al NPT del nivel
    head: float        # dintel respecto al NPT del nivel
    hinge: str = "a"   # a = bisagra en s1, b = bisagra en s2
    side: int = 1      # +1 abre hacia +perpendicular, -1 hacia -perpendicular
    desc: str = ""


@dataclass
class Wall:
    name: str
    a: tuple
    b: tuple
    t: float
    level: int
    h: float = None            # altura (por defecto hasta fondo de losa superior)
    kind: str = "albanileria"
    openings: list = field(default_factory=list)
    z0: float = None
    top_poly: list = None      # muro de coronacion inclinada: [(y,z)...] poligono YZ completo

    @property
    def horizontal(self):
        return abs(self.a[1] - self.b[1]) < 1e-9

    def base(self):
        return LV[self.level] if self.z0 is None else self.z0

    def height(self):
        if self.h is not None:
            return self.h
        return LV[self.level + 1] - SLAB - LV[self.level]

    def rect(self):
        """Rectangulo en planta (x1, y1, x2, y2)."""
        if self.horizontal:
            x1, x2 = sorted([self.a[0], self.b[0]])
            return (x1, self.a[1] - self.t / 2, x2, self.a[1] + self.t / 2)
        y1, y2 = sorted([self.a[1], self.b[1]])
        return (self.a[0] - self.t / 2, y1, self.a[0] + self.t / 2, y2)


def W(name, a, b, t, level, **kw):
    return Wall(name, a, b, t, level, **kw)


def build_walls():
    walls = []
    # ---------------- 1er PISO ----------------
    L = 1
    walls += [
        W("M-IZQ", (0.125, 0.0), (0.125, 7.0), TE, L, kind="medianera"),
        W("M-DER", (7.875, 0.0), (7.875, 7.0), TE, L, kind="medianera"),
        W("M-FRO", (2.15, 0.125), (7.75, 0.125), TE, L, kind="fachada", openings=[
            Opening("PP", "door2", 2.45, 3.45, 0.0, 2.40, "b", +1, "Puerta principal pivotante de madera"),
            Opening("V-01", "window", 3.75, 7.45, 0.45, 2.40, desc="Ventanal sala"),
        ]),
        W("M-POS", (0.25, 6.875), (7.75, 6.875), TE, L, kind="fachada", openings=[
            Opening("V-03", "window", 0.55, 1.85, 1.60, 2.20, desc="Ventana alta baño visitas"),
            Opening("MP-01", "slide", 2.45, 5.05, 0.0, 2.40, desc="Mampara corrediza comedor-terraza"),
            Opening("V-02", "window", 5.75, 7.45, 1.05, 2.20, desc="Ventana cocina"),
        ]),
        W("T-NUC1a", (2.225, 0.25), (2.225, 3.10), TI, L),
        W("T-NUC1b", (2.225, 5.10), (2.225, 6.75), TI, L),
        W("T-HALL1", (0.25, 5.175), (2.30, 5.175), TI, L, openings=[
            Opening("P-03", "door", 0.45, 1.15, 0.0, 2.10, "a", +1, "Baño visitas"),
        ]),
        W("T-DEP", (1.25, 3.05), (2.15, 3.05), 0.10, L, h=2.45, openings=[
            Opening("P-04", "door", 1.35, 2.05, 0.0, 2.00, "a", -1, "Depósito bajo escalera"),
        ]),
        W("T-DEP2", (1.20, 1.25), (1.20, 3.10), 0.10, L, top_poly=[
            (1.25, 0.0), (3.10, 0.0), (3.10, 2.55), (1.25, 1.15)]),
    ]
    # ---------------- 2do y 3er PISO (tipico) ----------------
    for L in (2, 3):
        walls += [
            W(f"M-IZQ", (0.125, 0.0), (0.125, 7.0), TE, L, kind="medianera"),
            W(f"M-DER", (7.875, 0.0), (7.875, 7.0), TE, L, kind="medianera"),
            W(f"M-FRO", (2.15, 0.125), (7.75, 0.125), TE, L, kind="fachada", openings=[
                Opening("V-04", "window", 2.60, 5.00, 0.10, 2.40, desc="Ventanal piso-techo + baranda vidrio"),
                Opening("V-05", "window", 5.80, 7.40, 1.50, 2.20, desc="Ventana alta baño"),
            ]),
            W(f"M-POS", (0.25, 6.875), (7.75, 6.875), TE, L, kind="fachada", openings=[
                Opening("V-06", "window", 0.55, 1.85, 1.50, 2.20, desc="Ventana walk-in"),
                Opening("V-07", "window", 2.70, 5.05, 0.90, 2.40, desc="Ventana dormitorio posterior"),
                Opening("V-06", "window", 6.45, 7.45, 1.50, 2.20, desc="Ventana alta baño"),
            ]),
            W("T-NUC", (2.225, 0.25), (2.225, 6.75), TI, L, openings=[
                Opening("P-01", "door", 3.05, 3.85, 0.0, 2.10, "b", +1, "Dormitorio principal"),
                Opening("P-01", "door", 4.22, 5.02, 0.0, 2.10, "a", +1, "Dormitorio posterior"),
                Opening("P-02", "door", 5.40, 6.10, 0.0, 2.10, "b", -1, "Walk-in closet"),
            ]),
            W("T-SUI", (2.30, 3.975), (7.75, 3.975), TI, L),
            W("T-DOR1", (5.375, 0.25), (5.375, 3.90), TI, L, openings=[
                Opening("P-02", "door", 2.40, 3.10, 0.0, 2.10, "a", +1, "Walk-in closet"),
            ]),
            W("T-BAN1", (5.45, 2.125), (7.75, 2.125), TI, L, openings=[
                Opening("P-03", "door", 6.25, 6.95, 0.0, 2.10, "a", -1, "Baño"),
            ]),
            W("T-BAN2", (6.075, 4.05), (6.075, 6.75), TI, L, openings=[
                Opening("P-03", "door", 4.35, 5.05, 0.0, 2.10, "a", +1, "Baño"),
            ]),
            W("T-HALL", (0.25, 5.175), (2.15, 5.175), TI, L),
        ]
    # ---------------- AZOTEA: parapetos y caseta ----------------
    L = 4
    walls += [
        W("PAR-IZQ", (0.125, 0.0), (0.125, 7.0), TE, L, h=1.00, kind="parapeto"),
        W("PAR-DER", (7.875, 0.0), (7.875, 7.0), TE, L, h=1.00, kind="parapeto"),
        W("PAR-FRO", (2.35, 0.075), (7.75, 0.075), TI, L, h=1.00, kind="parapeto"),
        W("PAR-POS", (2.30, 6.925), (7.75, 6.925), TI, L, h=1.00, kind="parapeto"),
        W("PAR-POS2", (0.25, 6.925), (2.15, 6.925), TI, L, h=1.00, kind="parapeto"),
        W("CAS-DER", (2.225, 0.25), (2.225, 5.25), TI, L, h=2.40, kind="caseta", openings=[
            Opening("P-05", "door", 3.15, 3.95, 0.0, 2.10, "b", +1, "Salida a azotea"),
        ]),
        W("CAS-POS", (0.25, 5.175), (2.15, 5.175), TI, L, h=2.40, kind="caseta"),
    ]
    # ---------------- AREA LIBRE: cercos y medianeras ----------------
    walls += [
        W("C-IZQ", (0.125, 7.0), (0.125, 12.0), TE, 1, kind="medianera", top_poly=[
            (7.0, 0.0), (12.0, 0.0), (12.0, roof_top(12.0) - 0.05), (7.0, roof_top(7.0) - 0.05)]),
        W("C-DER", (7.875, 7.0), (7.875, 12.0), TE, 1, kind="medianera", top_poly=[
            (7.0, 0.0), (12.0, 0.0), (12.0, roof_top(12.0) - 0.05), (7.0, roof_top(7.0) - 0.05)]),
        W("C-POS", (0.25, 11.875), (7.75, 11.875), TE, 1, h=2.40, kind="cerco"),
    ]
    return walls


# --------------------------------------------------------------------------
# AMBIENTES (para rotulos, areas, IfcSpace y Rooms de Revit)
# --------------------------------------------------------------------------
@dataclass
class Room:
    name: str
    level: int
    rect: tuple          # x1, y1, x2, y2 (cara interior)
    finish: str = ""
    label_at: tuple = None

    @property
    def area(self):
        x1, y1, x2, y2 = self.rect
        return (x2 - x1) * (y2 - y1)


def build_rooms():
    r = [
        Room("SALA", 1, (2.30, 0.25, 7.75, 3.90), "Porcelanato 60x120", (4.85, 2.55)),
        Room("COMEDOR", 1, (2.30, 4.05, 5.00, 6.75), "Porcelanato 60x120", (3.10, 4.45)),
        Room("COCINA", 1, (5.00, 4.05, 7.75, 6.75), "Porcelanato 60x120", (6.35, 4.35)),
        Room("HALL", 1, (0.25, 3.10, 2.15, 5.10), "Porcelanato 60x120", (1.20, 4.30)),
        Room("BAÑO VISITAS", 1, (0.25, 5.25, 2.15, 6.75), "Cerámico antideslizante", (1.30, 5.55)),
        Room("JARDÍN INTERIOR", 1, (0.25, 0.25, 2.15, 1.25), "Canto rodado + helechos", (1.20, 0.75)),
        Room("DEPÓSITO", 1, (1.25, 1.25, 2.15, 3.00), "", (1.70, 2.15)),
        Room("TERRAZA - PARRILLA", 1, (0.25, 7.00, 7.75, 11.75), "Porcelanato antideslizante / deck WPC", (4.05, 10.70)),
    ]
    for L in (2, 3):
        r += [
            Room("DORMITORIO 1" if L == 2 else "DORMITORIO 3", L, (2.30, 0.25, 5.30, 3.90), "Piso laminado", (3.00, 3.35)),
            Room("WALK-IN", L, (5.45, 2.20, 7.75, 3.90), "Piso laminado", (6.45, 2.85)),
            Room("BAÑO 1" if L == 2 else "BAÑO 3", L, (5.45, 0.25, 7.75, 2.05), "Porcelanato", (6.20, 1.55)),
            Room("DORMITORIO 2" if L == 2 else "DORMITORIO 4", L, (2.30, 4.05, 6.00, 6.75), "Piso laminado", (3.15, 4.55)),
            Room("BAÑO 2" if L == 2 else "BAÑO 4", L, (6.15, 4.05, 7.75, 6.75), "Porcelanato", (6.95, 4.35)),
            Room("WALK-IN", L, (0.25, 5.25, 2.15, 6.75), "Piso laminado", (1.40, 5.55)),
            Room("ESTAR / HALL", L, (0.25, 3.00, 2.15, 5.10), "Piso laminado", (1.15, 4.62)),
        ]
    r += [
        Room("AZOTEA", 4, (2.30, 0.10, 7.75, 6.85), "Impermeabilizante + deck", (5.0, 4.6)),
        Room("CASETA ESCALERA", 4, (0.25, 3.00, 2.15, 5.10), "", (1.20, 4.45)),
    ]
    return r


# --------------------------------------------------------------------------
# GENERACION DE PRISMAS 3D
# --------------------------------------------------------------------------
def wall_prisms(w: Wall):
    out = []
    ph = "F2" if (w.level >= 3 and not w.name.startswith("C-")) else "F1"
    mat = {"medianera": "muro_gris", "fachada": "muro_blanco", "parapeto": "muro_blanco",
           "caseta": "muro_blanco", "cerco": "muro_gris"}.get(w.kind, "muro_int")
    cat = "muro"
    z0 = w.base()
    H = w.height()
    if w.top_poly is not None:
        x1, y1, x2, y2 = w.rect()
        poly = [(y, z0 + z) for (y, z) in w.top_poly]
        out.append(Prism(x1, x2, poly, mat, cat, w.level, ph, w.name, w.name))
        return out
    x1, y1, x2, y2 = w.rect()
    if w.horizontal:
        s_lo, s_hi = x1, x2
    else:
        s_lo, s_hi = y1, y2
    ops = sorted(w.openings, key=lambda o: o.s1)
    cuts = []   # (s1, s2, zlo, zhi) partes solidas
    cur = s_lo
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
            out.append(box(a, b, y1, y2, z0 + zl, z0 + zh, mat, cat, level=w.level, phase=ph, name=w.name, group=w.name))
        else:
            out.append(box(x1, x2, a, b, z0 + zl, z0 + zh, mat, cat, level=w.level, phase=ph, name=w.name, group=w.name))
    # carpinterias
    for o in ops:
        zl, zh = z0 + o.sill, z0 + o.head
        tk = 0.03
        gid = f"{o.name}@{w.name}@{o.s1:.2f}"
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
            out.append(box(o.s1, o.s2, yc - tk, yc + tk, zl, zh, m, c, level=w.level, phase=ph, name=o.name, group=gid))
            if o.kind in ("window", "slide"):   # marco aluminio
                for xx in (o.s1, o.s2 - 0.05):
                    out.append(box(xx, xx + 0.05, yc - 0.04, yc + 0.04, zl, zh, "aluminio", c, level=w.level, phase=ph, name=o.name, group=gid))
                out.append(box(o.s1, o.s2, yc - 0.04, yc + 0.04, zh - 0.05, zh, "aluminio", c, level=w.level, phase=ph, name=o.name, group=gid))
                out.append(box(o.s1, o.s2, yc - 0.04, yc + 0.04, zl, zl + 0.05, "aluminio", c, level=w.level, phase=ph, name=o.name, group=gid))
        else:
            xc = (x1 + x2) / 2
            out.append(box(xc - tk, xc + tk, o.s1, o.s2, zl, zh, m, c, level=w.level, phase=ph, name=o.name, group=gid))
    return out


def stair_prisms(storey):
    """Escalera en U entre LV[storey] y LV[storey+1]."""
    z0 = LV[storey]
    ph = PHASE[storey + 1] if storey >= 2 else "F1"
    ph = "F2" if storey >= 3 else "F1"
    out = []
    yA, yB = ST_Y_FL
    waist = 0.15 / math.cos(math.atan(RISER / TREAD))
    # Tramo 1: sube de y=3.00 (z0) a y=1.25 (z0+1.40)
    top = [(yB, z0)]
    for i in range(1, N_TREADS + 1):
        yr = yB - TREAD * (i - 1)
        top += [(yr, z0 + RISER * i), (yr - TREAD, z0 + RISER * i)]
    top += [(yA, z0 + 8 * RISER)]
    bot_hi = (yA, z0 + RISER * N_TREADS - waist)
    bot_lo = (yB, z0 - waist)
    polyA = [bot_lo] + top[:-1] + [top[-1], bot_hi]
    # orientar antihorario
    out.append(Prism(ST_X_A[0], ST_X_A[1], _ccw(polyA), "concreto", "escalera", storey, ph, f"ESC-T1-{storey}", f"ESC-{storey}"))
    # Tramo 2: sube de y=1.25 (z0+1.40) a y=3.00 (z0+2.80)
    zl = z0 + 8 * RISER
    top = [(yA, zl)]
    for j in range(1, N_TREADS + 1):
        yr = yA + TREAD * (j - 1)
        top += [(yr, zl + RISER * j), (yr + TREAD, zl + RISER * j)]
    top += [(yB, z0 + 16 * RISER)]
    polyB = [(yA, zl - 0.20)] + top + [(yB, z0 + 16 * RISER - SLAB), (yB, zl + RISER * N_TREADS - waist)]
    out.append(Prism(ST_X_B[0], ST_X_B[1], _ccw(polyB), "concreto", "escalera", storey, ph, f"ESC-T2-{storey}", f"ESC-{storey}"))
    # Descanso
    out.append(box(0.25, 2.15, ST_Y_LAND[0], ST_Y_LAND[1], zl - SLAB, zl, "concreto", "escalera",
                   level=storey, phase=ph, name=f"ESC-DESC-{storey}", group=f"ESC-{storey}"))
    # Baranda central de vidrio (entre tramos) siguiendo la pendiente
    rail = [(yA, zl - 0.0), (yB, z0 - 0.0), (yB, z0 + 0.95), (yA, zl + 0.95)]
    out.append(Prism(1.17, 1.23, _ccw(rail), "vidrio", "baranda", storey, ph, f"BAR-{storey}A", f"ESC-{storey}"))
    rail2 = [(yA, zl), (yB, z0 + 2.80), (yB, z0 + 2.80 + 0.95), (yA, zl + 0.95)]
    out.append(Prism(1.17, 1.23, _ccw(rail2), "vidrio", "baranda", storey, ph, f"BAR-{storey}B", f"ESC-{storey}"))
    out.append(Prism(1.15, 1.25, _ccw([(yA, zl + 0.95), (yB, z0 + 0.95), (yB, z0 + 1.0), (yA, zl + 1.0)]),
                     "acero", "baranda", storey, ph, f"PAS-{storey}", f"ESC-{storey}"))
    return out


def _ccw(poly):
    s = 0
    for i in range(len(poly)):
        y1, z1 = poly[i]
        y2, z2 = poly[(i + 1) % len(poly)]
        s += (y2 - y1) * (z2 + z1)
    return poly if s < 0 else list(reversed(poly))


def slab_prisms():
    out = []
    # Piso 1 (contrapiso) y area libre
    out.append(box(0, 8, 0, 7, -0.10, 0.0, "piso_int", "losa", level=1, name="CONTRAPISO-1"))
    out.append(box(0.25, 7.75, 7.0, 11.75, -0.12, -0.02, "piso_ext", "losa", level=1, name="PISO-TERRAZA"))
    out.append(box(-0.0, 8.0, -1.20, 0.0, -0.30, -0.15, "vereda", "losa", level=1, name="VEREDA"))
    # Losas aligeradas niveles 2, 3 y techo (con hueco de escalera, excepto techo de caseta)
    for L in (2, 3, 4):
        z = LV[L]
        ph = "F1" if L <= 3 else "F2"
        nm = f"LOSA-{L}"
        out.append(box(0, 8, 3.00, 7.0, z - SLAB, z, "concreto", "losa", level=L, phase=ph, name=nm, group=nm))
        out.append(box(2.15, 8, 0, 3.00, z - SLAB, z, "concreto", "losa", level=L, phase=ph, name=nm, group=nm))
        out.append(box(0, 0.25, 0, 3.00, z - SLAB, z, "concreto", "losa", level=L, phase=ph, name=nm, group=nm))
    # Techo de caseta (+ lucernario de vidrio sobre la escalera)
    zc = LV[4] + 2.40
    out.append(box(0, 2.35, 3.00, 5.25, zc, zc + SLAB, "concreto", "losa", level=4, phase="F2", name="TECHO-CASETA"))
    out.append(box(0.0, 2.35, 0.0, 0.25, zc, zc + SLAB, "concreto", "losa", level=4, phase="F2", name="TECHO-CASETA"))
    out.append(box(0.25, 2.15, 0.25, 3.00, zc + 0.10, zc + 0.13, "vidrio", "lucernario", level=4, phase="F2", name="LUCERNARIO"))
    return out


def structure_prisms():
    out = []
    ztop = LV[4] + 1.00
    # Columnas C-1 (25x40) perimetrales y C-2 (25x25) interiores
    cols = []
    for ax, xc in AX_X.items():
        for ay, yc in AX_Y.items():
            if ax in ("1", "4"):
                w, d = 0.25, 0.40
            elif ay in ("A", "C"):
                w, d = 0.25, 0.25
            else:
                w, d = 0.25, 0.25
            x1 = min(max(xc - w / 2, 0), 8 - w)
            y1 = min(max(yc - d / 2, 0), 7 - d)
            if ay == "B" and ax in ("2", "3"):
                y1 = 3.90
            cols.append((ax + ay, x1, y1, w, d))
    for (nm, x1, y1, w, d) in cols:
        out.append(box(x1, x1 + w, y1, y1 + d, -1.0, LV[3], "concreto", "columna", level=1, name=f"C-{nm}", group=f"C-{nm}"))
        top = ztop if nm[0] in "14" or nm in ("2A", "2B", "2C", "3A", "3C") else LV[4]
        out.append(box(x1, x1 + w, y1, y1 + d, LV[3], top, "concreto", "columna", level=3, phase="F2", name=f"C-{nm}", group=f"C-{nm}"))
    # Vigas peraltadas (bajo cada losa)
    for L in (2, 3, 4):
        z = LV[L]
        ph = "F1" if L <= 3 else "F2"
        b = (z - BEAM_H, z - SLAB)
        for ax, xc in AX_X.items():
            out.append(box(xc - 0.125, xc + 0.125, 0.0 if ax != "2" else 0.0, 7.0, *b, "concreto", "viga", level=L, phase=ph, name=f"VP-{ax}"))
        out.append(box(2.10, 8.0, 0.0, 0.25, *b, "concreto", "viga", level=L, phase=ph, name="VS-A"))
        out.append(box(0.0, 8.0, 3.85, 4.10, *b, "concreto", "viga", level=L, phase=ph, name="VS-B"))
        out.append(box(0.0, 8.0, 6.75, 7.0, *b, "concreto", "viga", level=L, phase=ph, name="VS-C"))
        out.append(box(0.25, 2.10, 3.00, 3.25, *b, "concreto", "viga", level=L, phase=ph, name="VB-ESC"))
    # Cimentacion: cimientos corridos y zapatas
    for (x1, x2, y1, y2) in [(0, 0.60, 0, 12.0), (7.40, 8.0, 0, 12.0), (0, 8, 0, 0.60), (0, 8, 6.55, 7.20),
                             (0, 8, 11.40, 12.0), (1.95, 2.50, 0, 7.0)]:
        out.append(box(x1, x2, y1, y2, -1.00, -0.30, "cimiento", "cimentacion", level=1, name="CIMIENTO"))
    for (nm, x1, y1, w, d) in cols:
        cx, cy = x1 + w / 2, y1 + d / 2
        a = 0.60
        out.append(box(max(cx - a, 0), min(cx + a, 8), max(cy - a, 0), min(cy + a, 7.0), -1.60, -1.00,
                       "cimiento", "cimentacion", level=1, name=f"Z-{nm}"))
    return out


def facade_prisms():
    """Marco volado de concreto visto + linterna de vidrio con celosia de madera."""
    out = []
    zb, zt = LV[2] - SLAB, LV[4] + 0.10
    out.append(box(2.15, 8.0, -0.50, 0.0, zb, LV[2], "concreto_visto", "fachada", level=2, name="MARCO-BASE"))
    out.append(box(2.15, 8.0, -0.50, 0.0, zt - 0.30, zt + 0.15, "concreto_visto", "fachada", level=4, phase="F2", name="MARCO-SUP"))
    out.append(box(7.75, 8.0, -0.50, 0.0, zb, zt, "concreto_visto", "fachada", level=2, name="MARCO-DER"))
    out.append(box(2.15, 2.40, -0.50, 0.0, zb, zt, "concreto_visto", "fachada", level=2, name="MARCO-IZQ"))
    # Barandas de vidrio de ventanales piso-techo
    for L in (2, 3):
        z = LV[L]
        out.append(box(2.60, 5.00, -0.06, -0.04, z + 0.10, z + 1.00, "vidrio", "baranda", level=L, phase=PHASE[L], name="BARANDA-V04"))
    # Linterna: muro cortina sobre la escalera (3 pisos + caseta)
    zl_top = LV[4] + 2.40 + 0.20
    out.append(box(0.25, 2.10, 0.20, 0.23, 0.0, zl_top, "vidrio", "muro_cortina", level=1, name="LINTERNA"))
    for xm in (0.25, 1.15, 2.05):
        out.append(box(xm, xm + 0.05, 0.15, 0.25, 0.0, zl_top, "aluminio", "muro_cortina", level=1, name="LINTERNA-MONT"))
    for zt_ in (LV[2], LV[3], LV[4]):
        out.append(box(0.25, 2.10, 0.15, 0.25, zt_ - 0.05, zt_, "aluminio", "muro_cortina", level=1, name="LINTERNA-TRAV"))
    # Celosia vertical de listones (aluminio acabado madera) frente a la linterna
    n = 0
    x = 0.28
    while x < 2.08:
        out.append(box(x, x + 0.04, -0.14, -0.04, -0.15, zl_top + 0.15, "madera", "celosia", level=1, name="CELOSIA-LINTERNA", group="CELOSIA-LINTERNA"))
        x += 0.11
        n += 1
    # Jardin interior bajo el descanso (visible desde la calle)
    out.append(box(0.25, 2.15, 0.25, 1.25, 0.0, 0.10, "canto_rodado", "jardin", level=1, name="JARDIN-INT"))
    out.append(box(0.45, 0.85, 0.45, 0.85, 0.10, 0.85, "verde", "jardin", level=1, name="PLANTA"))
    out.append(box(1.45, 1.85, 0.55, 0.95, 0.10, 0.65, "verde", "jardin", level=1, name="PLANTA"))
    # Tanque elevado 1100 L en azotea
    out.append(box(0.55, 1.65, 5.55, 6.55, LV[4], LV[4] + 1.45, "tanque", "instalaciones", level=4, phase="F2", name="TANQUE-1100L"))
    return out


def patio_cover_prisms():
    """Cobertura metalica liviana sobre el area libre (8.00 x 5.00)."""
    out = []

    def sl(ya, yb, dz_top, dz_bot, mat, cat, name, x1, x2):
        poly = [(ya, roof_top(ya) - dz_bot), (yb, roof_top(yb) - dz_bot),
                (yb, roof_top(yb) - dz_top), (ya, roof_top(ya) - dz_top)]
        out.append(Prism(x1, x2, poly, mat, cat, 1, "F1", name, "COBERTURA"))

    # Paneles termoacusticos TR4 (e=50 mm) + franja de policarbonato alveolar
    sl(7.12, 9.00, 0.00, 0.05, "panel_tr4", "cobertura", "PANEL-TR4", 0.0, 8.0)
    sl(9.00, 10.20, 0.00, 0.012, "policarbonato", "cobertura", "POLICARBONATO", 0.0, 8.0)
    sl(10.20, 12.00, 0.00, 0.05, "panel_tr4", "cobertura", "PANEL-TR4", 0.0, 8.0)
    # Correas (tubo 50x100) cada ~0.95 m
    for yc in (7.40, 8.35, 9.30, 9.95, 10.90, 11.85):
        sl(yc - 0.05, yc + 0.05, 0.05, 0.15, "acero", "correa", "CORREA 50x100x2", 0.25, 7.75)
    # Vigas principales (tubo 100x200x3) cada 1.45 m
    for i in range(6):
        xc = 0.375 + i * 1.45
        sl(7.10, 11.95, 0.15, 0.35, "acero", "viga_met", "VIGA 100x200x3", xc - 0.05, xc + 0.05)
    # Viga posterior (tubo 150x300x4) y columnas (tubo 150x150x4)
    zb_top = roof_top(11.525) - 0.35
    out.append(box(0.25, 7.75, 11.45, 11.60, zb_top - 0.30, zb_top, "acero", "viga_met", level=1, name="VIGA 150x300x4", group="COBERTURA"))
    for x1 in (0.40, 7.45):
        out.append(box(x1, x1 + 0.15, 11.45, 11.60, 0.0, zb_top - 0.30, "acero", "columna_met", level=1, name="COL 150x150x4", group="COBERTURA"))
    # Viga de apoyo (angulo) anclada a la viga VS-C del edificio + canaleta
    zl = roof_top(7.10) - 0.35
    out.append(box(0.25, 7.75, 7.00, 7.10, zl - 0.20, zl, "acero", "viga_met", level=1, name="ANGULO 100x100x6", group="COBERTURA"))
    out.append(box(0.25, 7.75, 7.00, 7.20, roof_top(7.0) - 0.12, roof_top(7.0) + 0.07, "acero_galv", "canaleta", level=1, name="CANALETA", group="COBERTURA"))
    for xb in (0.30, 7.60):
        out.append(box(xb, xb + 0.10, 7.05, 7.15, 0.0, roof_top(7.0) - 0.12, "acero_galv", "bajante", level=1, name="BAJANTE 3in", group="COBERTURA"))
    # Celosia metalica perforada sobre el cerco posterior (ventilacion cruzada)
    out.append(box(0.25, 7.75, 11.85, 11.90, 2.40, zb_top - 0.30, "celosia_met", "celosia", level=1, name="CELOSIA-POSTERIOR"))
    return out


def patio_program_prisms():
    out = []
    # Parrilla / barra BBQ en concreto visto + campana + chimenea
    out.append(box(0.25, 0.90, 8.00, 10.40, 0.0, 0.90, "concreto_visto", "mobiliario", name="BARRA-PARRILLA"))
    out.append(box(0.25, 0.95, 8.60, 9.60, 1.70, 2.10, "acero", "mobiliario", name="CAMPANA"))
    out.append(box(0.40, 0.75, 8.95, 9.30, 2.10, roof_top(9.3) + 0.80, "acero", "mobiliario", name="CHIMENEA"))
    # Mesa exterior 6 personas
    out.append(box(3.05, 5.05, 8.55, 9.55, 0.72, 0.76, "madera", "mobiliario", name="MESA-EXT"))
    out.append(box(3.95, 4.15, 8.95, 9.15, 0.0, 0.72, "acero", "mobiliario", name="MESA-EXT"))
    for (xa, ya) in [(3.25, 8.20), (3.85, 8.20), (4.45, 8.20), (3.25, 9.55), (3.85, 9.55), (4.45, 9.55)]:
        out.append(box(xa, xa + 0.40, ya, ya + 0.40, 0.0, 0.45, "madera", "mobiliario", name="SILLA"))
    # Lavanderia (lavadero + lavadora) tras celosia de listones
    out.append(box(6.95, 7.75, 10.95, 11.75, 0.0, 0.90, "concreto_visto", "mobiliario", name="LAVADERO"))
    out.append(box(6.25, 6.85, 11.10, 11.75, 0.0, 0.85, "blanco", "mobiliario", name="LAVADORA"))
    x = 6.10
    while x < 7.72:
        out.append(box(x, x + 0.04, 10.00, 10.08, 0.0, 2.10, "madera", "celosia", name="CELOSIA-LAV", group="CELOSIA-LAV"))
        x += 0.10
    # Jardinera + jardin vertical en cerco posterior
    out.append(box(0.25, 5.95, 11.30, 11.75, 0.0, 0.45, "concreto_visto", "jardin", name="JARDINERA"))
    out.append(box(0.30, 5.90, 11.35, 11.70, 0.45, 0.60, "verde", "jardin", name="JARDINERA"))
    out.append(box(0.60, 5.90, 11.68, 11.75, 0.60, 2.30, "verde", "jardin", name="JARDIN-VERTICAL"))
    return out


def interior_furniture_prisms():
    out = []
    # 1er piso
    out.append(box(6.85, 7.75, 0.90, 3.10, 0.0, 0.75, "tela", "mobiliario", name="SOFA"))
    out.append(box(5.60, 6.40, 1.50, 2.50, 0.0, 0.40, "madera", "mobiliario", name="MESA-CENTRO"))
    out.append(box(2.75, 4.55, 4.95, 5.85, 0.72, 0.76, "madera", "mobiliario", name="MESA-COMEDOR"))
    out.append(box(7.15, 7.75, 4.85, 6.75, 0.0, 0.90, "cuarzo", "mobiliario", name="MUEBLE-COCINA"))
    out.append(box(5.20, 7.15, 6.15, 6.75, 0.0, 0.90, "cuarzo", "mobiliario", name="MUEBLE-COCINA"))
    out.append(box(7.05, 7.75, 4.10, 4.80, 0.0, 1.90, "acero", "mobiliario", name="REFRIGERADORA"))
    out.append(box(5.30, 6.10, 4.55, 5.95, 0.0, 0.92, "cuarzo", "mobiliario", name="ISLA"))
    for L in (2, 3):
        z = LV[L]
        ph = PHASE[L]
        out.append(box(3.30, 5.30, 1.25, 2.85, z, z + 0.55, "tela", "mobiliario", level=L, phase=ph, name="CAMA 2P"))
        out.append(box(4.00, 6.00, 4.60, 6.20, z, z + 0.55, "tela", "mobiliario", level=L, phase=ph, name="CAMA 2P"))
    return out


SPLIT_PREFIX = ("C-", "LINTERNA", "CELOSIA-LINTERNA", "MARCO-DER", "MARCO-IZQ")


def split_by_levels(p):
    """Divide elementos verticales continuos (columnas, linterna, marco) por entrepiso."""
    if len(p.poly) != 4 or not p.name.startswith(SPLIT_PREFIX) or p.cat == "muro":
        return [p]
    y1, y2, z1, z2 = p.yz_bounds()
    cuts = [LV[2], LV[3], LV[4]]
    zs = [z1] + [c for c in cuts if z1 + 1e-6 < c < z2 - 1e-6] + [z2]
    out = []
    for a, b in zip(zs[:-1], zs[1:]):
        mid = (a + b) / 2
        lvl = 1 if mid < LV[2] else 2 if mid < LV[3] else 3 if mid < LV[4] else 4
        out.append(box(p.x1, p.x2, y1, y2, a, b, p.mat, p.cat, level=lvl,
                       phase="F2" if lvl >= 3 else "F1", name=p.name, group=p.group))
    return out


def all_prisms():
    P = []
    for w in build_walls():
        P += wall_prisms(w)
    for s in (1, 2, 3):
        P += stair_prisms(s)
    P += slab_prisms()
    P += structure_prisms()
    P += facade_prisms()
    P += patio_cover_prisms()
    P += patio_program_prisms()
    P += interior_furniture_prisms()
    out = []
    for p in P:
        out += split_by_levels(p)
    return out


# Colores de materiales (visor / renders)
MATERIALS = {
    "muro_blanco": ("#f4f1ea", 1.0), "muro_gris": ("#d9d5cc", 1.0), "muro_int": ("#efebe3", 1.0),
    "concreto": ("#b9b6b0", 1.0), "concreto_visto": ("#8f8c87", 1.0), "cimiento": ("#9c958a", 1.0),
    "vidrio": ("#9ec9dc", 0.35), "aluminio": ("#3a3d40", 1.0), "madera": ("#b07a45", 1.0),
    "madera_osc": ("#6b4528", 1.0), "acero": ("#2f3236", 1.0), "acero_galv": ("#a7adb2", 1.0),
    "panel_tr4": ("#4a4f55", 1.0), "policarbonato": ("#e8f2f5", 0.55), "celosia_met": ("#3b3f44", 0.55),
    "piso_int": ("#d8cdbb", 1.0), "piso_ext": ("#c9bba3", 1.0), "vereda": ("#bdbab3", 1.0),
    "verde": ("#5f8f4e", 1.0), "canto_rodado": ("#d6d2c8", 1.0), "tanque": ("#2b2b2b", 1.0),
    "tela": ("#c8c2b8", 1.0), "cuarzo": ("#ebe8e2", 1.0), "blanco": ("#fafafa", 1.0),
}

if __name__ == "__main__":
    P = all_prisms()
    print(len(P), "prismas")
    rooms = build_rooms()
    for r in rooms:
        print(f"{r.level} {r.name:22s} {r.area:6.2f}")
