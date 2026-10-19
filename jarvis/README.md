# J.A.R.V.I.S. — Asistente personal futurista

Interfaz holográfica estilo Iron Man que corre 100 % en el navegador: sin servidor, sin build, sin dependencias.

## Cómo ejecutarlo

```bash
cd jarvis
python3 -m http.server 8080
# abre http://localhost:8080 en Chrome o Edge
```

> El micrófono necesita `localhost` o `https`. Abrir el `index.html` directo funciona, pero algunos navegadores bloquean el micrófono en `file://`.
> Para publicarlo gratis: GitHub Pages (Settings → Pages → carpeta `/jarvis`), Vercel o Netlify.

## Características

| Módulo | Qué hace |
|---|---|
| **Reactor holográfico** | Núcleo animado en canvas que reacciona en tiempo real al micrófono, a la voz de JARVIS y a los efectos de sonido. Cambia de comportamiento según el estado: espera, escucha, procesa o habla. |
| **Audio futurista** | Todos los sonidos se sintetizan con Web Audio API (osciladores, ruido filtrado, reverb por convolución, eco): arranque, clics, hover, notificaciones, alarmas y un zumbido ambiental de reactor. No hay ningún archivo de audio. |
| **Voz** | Reconocimiento de voz en español y respuesta hablada con voz, velocidad y tono configurables. **Modo vigilia**: escucha continua que se activa al decir *"Jarvis…"*. |
| **Menú radial** | Botones orbitales que se despliegan con animación elástica alrededor del núcleo (tecla `M` o clic derecho en el núcleo). |
| **Paneles dinámicos** | Diagnóstico, clima, notas, temporizadores, protocolos, ajustes y ayuda, que entran deslizándose. |
| **Paleta de comandos** | `Ctrl+K` abre un buscador de acciones al estilo VS Code. |
| **Temas** | Arc (cian), Mark (rojo Iron Man), Matrix (verde), Nebula (violeta) y Gold, con transición *glitch*. |
| **Protocolos** | Fiesta, Alerta roja, Enfoque (Pomodoro), Silencio, Normal y Reinicio. |
| **Cerebro IA (opcional)** | Si pegas una clave de la API de Claude en Ajustes, JARVIS conversa de cualquier tema con memoria de la conversación y su propia personalidad. Sin clave funciona con comandos locales y Wikipedia. |

## Comandos de ejemplo

- *"¿Qué hora es?"* · *"¿Qué día es hoy?"*
- *"Clima"* · *"Clima en Bogotá"*
- *"¿Quién fue Nikola Tesla?"* · *"¿Qué es un agujero negro?"* (Wikipedia o Claude)
- *"Abre YouTube"* · *"Busca recetas de pasta"* · *"Pon música lo-fi"*
- *"Temporizador de 5 minutos"* · *"Anota que debo llamar a mamá"* · *"Lee mis notas"*
- *"Cuánto es 25 por 4 más 10"* · *"Raíz cuadrada de 144"*
- *"Modo rojo"* · *"Protocolo fiesta"* · *"Protocolo alerta"* · *"Estado del sistema"*
- *"Me llamo Denis"* · *"Cuéntame un chiste"* · *"Lanza una moneda"* · *"Apágate"*

## Atajos

`Espacio` micrófono · `Ctrl+K` paleta · `M` menú radial · `F` pantalla completa · `/` escribir · `Esc` cerrar

## Estructura

```
jarvis/
├── index.html      # Estructura del HUD
├── css/style.css   # Estilo holográfico, temas y animaciones
└── js/
    ├── audio.js    # Sintetizador de efectos (Web Audio)
    ├── voice.js    # Reconocimiento y síntesis de voz
    ├── brain.js    # Motor de intenciones + Wikipedia + Claude
    ├── hud.js      # Reactor, partículas y gráficos en canvas
    └── app.js      # Orquestación: boot, menús, paneles, clima, timers
```

## Cómo extenderlo

Agrega un comando nuevo en `js/brain.js`, dentro del arreglo `intents`:

```js
{ re: /abre mi proyecto/, run: () => { App.openUrl("https://github.com/denisjara"); return "Abriendo su proyecto, señor."; } },
```

## Notas de privacidad

- Las notas, ajustes y la clave de API se guardan solo en el `localStorage` de tu navegador.
- La clave de Claude se envía directamente a `api.anthropic.com`, sin intermediarios. Úsala solo en tu equipo personal.
- El clima usa Open-Meteo (gratis, sin clave) y las definiciones vienen de Wikipedia en español.
