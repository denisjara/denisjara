# Política de seguridad — FutStat Lab

FutStat Lab es un proyecto personal: una web estática de analítica de fútbol publicada en
GitHub Pages (<https://denisjara.github.io/denisjara/>) y un pipeline de datos en Node que se
ejecuta en GitHub Actions. Se agradece cualquier aviso de seguridad hecho de forma responsable.

## Cómo informar de una vulnerabilidad

1. **No abras un issue público con los detalles.**
2. Usa el aviso privado de GitHub: pestaña **Security → Report a vulnerability** de este
   repositorio ("Private vulnerability reporting").
3. Si esa opción no aparece, abre un issue **sin detalles técnicos** pidiendo un canal de
   contacto privado y te responderemos por allí.

Incluye, si puedes: qué parte afecta (web, pipeline o workflows), pasos para reproducirlo, el
impacto que crees que tiene y, si la tienes, una propuesta de solución.

Qué puedes esperar (es un proyecto mantenido por una sola persona, sin SLA):

- Acuse de recibo en un plazo aproximado de **7 días**.
- Una primera valoración y, si se confirma, un plan de corrección en unas **4 semanas**.
- Publicación coordinada: el problema se hará público solo cuando esté corregido, citándote si
  lo deseas.

## Versiones con soporte

Solo se mantiene la rama `main` y la web publicada desde ella. No hay versiones antiguas con
soporte.

## Alcance

**Dentro del alcance**

- La web publicada y su código: `futstat/src/` (app React).
- El pipeline de datos: `futstat/pipeline/` y `futstat/scripts/`.
- La configuración de compilación y de dependencias: `futstat/package.json`,
  `futstat/package-lock.json`, `futstat/vite.config.ts`.
- Los workflows y la configuración de `.github/`.

**Fuera del alcance**

- La exactitud de los datos de ESPN, de las predicciones o de las cuotas, y el resultado de
  cualquier apuesta: la web es informativa y no es asesoramiento de apuestas.
- Fallos en servicios de terceros (ESPN, GitHub, GitHub Pages): infórmalos directamente a ellos.
- Cabeceras HTTP que GitHub Pages no permite configurar, ataques de denegación de servicio
  contra GitHub Pages e informes de escáneres automáticos sin un impacto demostrado.
- Ataques que requieren acceso previo al equipo del desarrollador o a la cuenta de GitHub.

## Qué protege el proyecto

**La web**

- Es 100 % estática: no hay servidor propio, ni cuentas de usuario, ni cookies, ni formularios
  que envíen datos. En el navegador solo se guarda la preferencia de tema claro/oscuro.
- Solo lee los JSON publicados junto a la web y, durante los partidos, el marcador público de
  ESPN (sin claves ni credenciales). Las tipografías están autoalojadas: no se contacta con
  Google Fonts ni con otros terceros salvo el CDN de imágenes y el marcador de ESPN.
- CSP de producción sin `'unsafe-inline'`, con hashes calculados en cada build y Trusted Types
  (`scripts/csp.ts`); una pantalla de arranque estática evita la página en blanco si el código
  de la app no llega a cargar.
- Los enlaces externos se abren con `rel="noopener noreferrer"`.

**Los datos publicados**

- Antes de publicar, el workflow valida todos los JSON generados contra el contrato de datos
  (`futstat/src/types/data.ts`), ejecuta los tests y compila la web. Si cualquiera de esos pasos
  falla, **no se despliega nada** y la web sigue mostrando la última versión buena.
- El almacén incremental (`data-store/`) se escribe de forma atómica, se valida en profundidad
  al cargarlo (registros anómalos descartados, no propagados) y, antes de guardarlo en la caché
  de Actions, se compara con el almacén restaurado: si está dañado o una competición desaparece o
  pierde más del 25 % de sus datos, no se guarda (la siguiente ejecución parte del último almacén
  bueno) y no se publica nada. Además se sube una copia semanal como artefacto (90 días).
- Si ESPN no responde, se compila con el almacén de la ejecución anterior: la web muestra la fecha
  real de la última descarga correcta y la validación rechaza publicar si tiene más de 72 h.

**Las dependencias (cadena de suministro)**

- Versiones exactas en `package.json` (sin `^`) y `package-lock.json` versionado; CI instala con
  `npm ci`, que respeta el lockfile al pie de la letra.
- `npm audit --omit=dev --audit-level=high` es **bloqueante** en cada publicación (al final del
  job, para que un fallo del servicio de npm no impida descargar los datos; un error de red del
  servicio se avisa sin bloquear) y en cada pull request: una vulnerabilidad alta o crítica en
  una dependencia que acaba en la web impide desplegar o fusionar. La auditoría completa
  (incluidas las herramientas de desarrollo) se ejecuta como aviso.
- Cada pull request (incluidos los de Dependabot) pasa por `.github/workflows/ci.yml`: auditoría,
  typecheck, tests y compilación. Recomendado: marcarlo como check obligatorio en `main`.
- Dependabot propone subidas semanales (`.github/dependabot.yml`), esperando 7 días desde la
  publicación de cada versión antes de proponerla.
- CodeQL analiza el código JavaScript/TypeScript y los workflows en cada push y pull request a
  `main` y una vez por semana (`.github/workflows/codeql.yml`).

**GitHub Actions**

- Cada action está fijada a un SHA de commit completo (con la versión en un comentario).
- Permisos mínimos: ninguno por defecto; el job de compilación solo puede leer el repositorio y el
  de despliegue solo puede publicar en Pages (`pages: write` + `id-token: write`).
- El token no se guarda en el checkout (`persist-credentials: false`), el proyecto no usa
  secretos propios y los workflows no interpolan datos no confiables dentro de los scripts.
- Cada paso pesado tiene un tiempo máximo (`timeout-minutes`).

**El equipo de desarrollo**

- `npm run dev` y `npm run preview` escuchan solo en `127.0.0.1` (no se exponen a la red local)
  y fallan si el puerto está ocupado en lugar de cambiar de puerto en silencio.
- Requiere Node.js 20 o superior (`engines`); se recomienda la versión LTS actual (22).
- Recomendación: instala con `npm ci` (respeta el lockfile) y no ejecutes `npm audit fix --force`
  sin revisar el resultado, porque puede saltar versiones mayores.

## Riesgos conocidos y aceptados

- **Enmarcado (clickjacking)**: GitHub Pages no permite enviar `X-Frame-Options` ni
  `Content-Security-Policy: frame-ancestors` como cabeceras, y `frame-ancestors` no funciona en
  `<meta>`. No se añade un "frame-buster" en JavaScript porque rompería las vistas previas
  legítimas que enmarcan la web (p. ej. la vista previa de artefactos) y el riesgo es bajo: la web
  no tiene sesión, cuentas, formularios ni acciones con estado (solo el cambio de tema claro/oscuro
  y enlaces externos que se abren en otra pestaña). Si algún día se añade algo con estado, habrá
  que servir la web desde un hosting que permita esas cabeceras.
- **Actions en versiones mayores anteriores** (checkout v5, setup-node v5, cache v5): están
  fijadas a SHA, son las últimas de su versión mayor y no tienen avisos de seguridad conocidos.
  Las subidas mayores las propone Dependabot (grupo semanal `github-actions`); antes de fusionarlas,
  revisar las notas de cada versión mayor y comprobar que el comentario `# vX.Y.Z` corresponde al SHA.
- Resuelto: react-router 6.x (GHSA-wrjc-x8rr-h8h6 y GHSA-337j-9hxr-rhxg) se ha actualizado a
  react-router-dom 7.18.4; `npm audit` no informa de vulnerabilidades.
