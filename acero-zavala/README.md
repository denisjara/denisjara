# Taller de Diseño en Acero

Aplicación web de aprendizaje construida a partir del curso **Diseño en Acero** (Ing. Carlos Zavala Toledo, UNI, 2021-I), publicado como [lista de reproducción en YouTube](https://www.youtube.com/playlist?list=PLWJA_k_OD5L8167OvI7m7lVQ3j87qjhWl).

## Qué incluye

- **Plan de estudio** en 8 módulos, con competencias por módulo y el sistema de evaluación del curso.
- **Una lección por clase**: resumen, objetivos, teoría detallada por subtema, fórmulas con referencias AISC/NTE, ejemplos resueltos paso a paso (se revelan de a uno), ejercicios propuestos, conceptos clave, autoevaluación y avisos del profesor.
- **Calculadoras AISC 360-16 (LRFD)**: combinaciones de carga E.090, viento E.020, cortante basal E.030, tracción, bloque de corte, compresión E3, flexión F2/F3 con Lp y Lr, Cb, corte G2, flexocompresión H1 con B1, pernos y soldadura de filete.
- **Formulario**, **glosario**, **buscador** y **examen de práctica** con preguntas al azar por módulo.
- El avance de cada estudiante se guarda en su navegador (localStorage).

## Estado del contenido

| Clases | Estado |
| --- | --- |
| 01–09, 12, 13, 15–22 | Transcritas completas y analizadas |
| 10, 11 | Videos duplicados de la 08 y la 09 en la playlist |
| 14 | El video solo tiene 44 s (inicio de la clase del 12/05/2021) |
| 23–29 | Pendientes de transcripción |

Los cálculos dichos en clase que no cuadran con la norma se señalan en la pestaña «Avisos y notas» de cada clase.

## Estructura

```
app/template.html      interfaz (HTML + CSS + JS sin dependencias)
data/curso.json        módulos, metadatos y enlaces a los videos
data/clases/NN.json    contenido de cada clase
tools/build.py         genera dist/index.html (un solo archivo)
dist/index.html        aplicación lista para abrir en el navegador
```

## Uso

Abre `dist/index.html` en cualquier navegador. Para regenerarlo tras editar el contenido:

```bash
python3 tools/build.py
```

Para agregar una clase nueva, crea `data/clases/NN.json` con el mismo formato que las existentes y vuelve a ejecutar el build.
