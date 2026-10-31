# Ejemplos de prompts para Claude con nwd-mcp

Primero conecta el servidor a Claude.

**Claude Code** (en PowerShell):

```powershell
claude mcp add nwd-mcp -- "$env:LOCALAPPDATA\Bimwright\nwd-mcp\server\current\nwd-mcp.exe" --target 2027
```

**Claude Desktop:** en `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "nwd-mcp": {
      "command": "C:\\Users\\Denis\\AppData\\Local\\Bimwright\\nwd-mcp\\server\\current\\nwd-mcp.exe",
      "args": ["--target", "2027"]
    }
  }
}
```

Con Navisworks 2027 abierto y un modelo cargado, prueba:

## Conocer el modelo
- "Haz un health check de Navisworks y dime qué documento está abierto."
- "¿Cuántos elementos y modelos tiene el proyecto? Muéstrame el árbol hasta 3 niveles."
- "¿Qué disciplinas o archivos están federados en este NWD?"

## Buscar y leer propiedades
- "Busca todos los elementos que se llamen 'Puerta' y hazme una tabla con su nivel, tipo y material."
- "Dame las propiedades del elemento seleccionado en Navisworks."
- "Lista las categorías de propiedades que tienen los muros y dime cuáles parecen venir de Revit."

## Control de la vista
- "Selecciona todas las tuberías y ocúltalas."
- "Muestra de nuevo todo lo oculto."
- "Guarda la vista actual como 'Revisión MEP - Nivel 2'."
- "Lista las vistas guardadas y ve a la que se llama 'Fachada norte'."

## Conjuntos
- "¿Qué conjuntos de búsqueda hay? Ejecuta 'Estructura' y dime cuántos elementos encuentra."

## Análisis con C# (`nwd_send_code`)
- "Cuenta los elementos con geometría agrupados por clase y dame el top 10."
- "Calcula la caja envolvente del proyecto y sus dimensiones."
- "Encuentra elementos sin la propiedad 'Material' y lístalos."

## Informes
- "Hazme un informe en Excel con todos los elementos cuyo nombre contenga 'Losa' y sus propiedades principales."
- "Compara las propiedades de dos elementos que te indico por id y dime en qué difieren."

## Consejos
- Para empezar sin riesgo, añade `--read-only` a los argumentos del servidor: deja solo las 21 herramientas que no cambian nada.
- Las acciones que cambian cosas (abrir archivos, ocultar, etc.) piden confirmación en Claude Desktop.
- Si tienes varias versiones de Navisworks abiertas, `--target 2027` fija la versión.
