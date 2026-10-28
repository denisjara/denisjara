"""Une data/curso.json y data/clases/NN.json con app/template.html en dist/index.html (un solo archivo)."""
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
REQUIRED = ["titulo", "resumen", "temas", "ejemplos", "preguntas"]


def load_clase(n):
    p = ROOT / "data" / "clases" / f"{n}.json"
    if not p.exists():
        return None
    d = json.loads(p.read_text(encoding="utf-8"))
    for k in REQUIRED:
        if k not in d:
            raise SystemExit(f"{p.name}: falta el campo '{k}'")
    for q in d["preguntas"]:
        if not (0 <= q["correcta"] < len(q["opciones"])):
            raise SystemExit(f"{p.name}: índice de respuesta fuera de rango en '{q['pregunta'][:40]}'")
    return d


def main():
    curso = json.loads((ROOT / "data" / "curso.json").read_text(encoding="utf-8"))
    orden = [c for m in curso["modulos"] for c in m["clases"]]
    clases = {}
    for n in orden:
        vid, dur = curso["videos"][n]
        base = {"corto": curso["cortos"][n], "video": f"https://www.youtube.com/watch?v={vid}", "duracion_min": dur}
        d = load_clase(n)
        if d:
            d.pop("clase", None)
            d.pop("duracion_min", None)
            clases[n] = {**d, **base, "estado": "ok"}
        else:
            clases[n] = {**base, **curso["especiales"][n], "estado": "pendiente", "temas": []}
    data = {"meta": curso["meta"], "modulos": curso["modulos"], "orden": orden, "clases": clases}
    tpl = (ROOT / "app" / "template.html").read_text(encoding="utf-8")
    blob = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    out = tpl.replace("/*__DATA__*/null", blob)
    (ROOT / "dist").mkdir(exist_ok=True)
    (ROOT / "dist" / "index.html").write_text(out, encoding="utf-8")
    listas = sum(1 for c in clases.values() if c["estado"] == "ok")
    print(f"dist/index.html: {len(out)/1024:.0f} KB, {listas} clases con contenido de {len(orden)}")


if __name__ == "__main__":
    main()
