<#
  00-instalar-2027.ps1
  Compila e instala nwd-mcp (plugin + servidor) para Navisworks Manage 2027.
  Incluye la corrección del proyecto plugin-navis27 (referencia a Autodesk.Navisworks.Controls.dll
  y paquete IsExternalInit), que en el repositorio original impide compilar.

  Uso:  powershell -ExecutionPolicy Bypass -File .\00-instalar-2027.ps1
  Requisitos: Git, .NET 8 SDK y Navisworks Manage 2027. CIERRA Navisworks antes de ejecutarlo.
#>
param(
    [string]$RepoDir = "$env:USERPROFILE\nwd-mcp",
    [string]$NavisworksDir = "C:\Program Files\Autodesk\Navisworks Manage 2027"
)
$ErrorActionPreference = "Continue"   # los comandos nativos (git, dotnet) se validan con $LASTEXITCODE

function Paso($t) { Write-Host ""; Write-Host ">> $t" -ForegroundColor Cyan }
function Ok($t)   { Write-Host "   OK  $t" -ForegroundColor Green }
function Falla($t){ Write-Host "   ERROR  $t" -ForegroundColor Red; exit 1 }

Paso "Comprobando requisitos"
if (Get-Process -Name "Roamer" -ErrorAction SilentlyContinue) { Falla "Navisworks está abierto. Ciérralo y vuelve a ejecutar el script." }
if (-not (Get-Command git -ErrorAction SilentlyContinue))    { Falla "Git no está instalado (winget install Git.Git)." }
if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) { Falla ".NET SDK no está instalado (winget install Microsoft.DotNet.SDK.8)." }
$sdks = & dotnet --list-sdks
if (-not ($sdks -match "^8\.")) { Falla "Falta el .NET 8 SDK (winget install Microsoft.DotNet.SDK.8)." }
Ok ".NET SDK: $((& dotnet --version))"
if (-not (Test-Path "$NavisworksDir\Autodesk.Navisworks.Api.dll")) { Falla "No se encuentra Navisworks 2027 en $NavisworksDir (usa -NavisworksDir)." }
Ok "Navisworks 2027: $NavisworksDir"

Paso "Descargando / actualizando el código de nwd-mcp"
if (Test-Path "$RepoDir\.git") {
    git -C $RepoDir checkout -- src/plugin-navis27
    git -C $RepoDir pull --ff-only
    if ($LASTEXITCODE -ne 0) { Falla "git pull falló." }
} else {
    git clone https://github.com/bimwright/nwd-mcp.git $RepoDir
    if ($LASTEXITCODE -ne 0) { Falla "git clone falló." }
}
Ok $RepoDir

Paso "Corrigiendo el proyecto del plugin 2027"
$p25 = "$RepoDir\src\plugin-navis25\Bimwright.Nwd.Plugin.Navis25.csproj"
$p27 = "$RepoDir\src\plugin-navis27\Bimwright.Nwd.Plugin.Navis27.csproj"
$actual = Get-Content $p27 -Raw
if ($actual -match "IsExternalInit" -and $actual -notmatch "Autodesk\.Navisworks\.Api\.Controls") {
    Ok "El proyecto ya está corregido (no se toca)."
} else {
    (Get-Content $p25 -Raw) -replace '2025', '2027' -replace 'Navis25', 'Navis27' | Set-Content $p27 -Encoding UTF8
    Ok "plugin-navis27 actualizado a partir de plugin-navis25"
}

Paso "Compilando el plugin (net48)"
& dotnet build $p27 -c Release "/p:NavisworksInstallDir=$NavisworksDir" -nologo -v q
if ($LASTEXITCODE -ne 0) { Falla "La compilación del plugin falló." }
Ok "Plugin compilado"

Paso "Instalando el plugin en Navisworks"
& powershell -NoProfile -ExecutionPolicy Bypass -File "$RepoDir\scripts\install-bundle.ps1" -Year 2027 -Configuration Release
$dll = "$env:APPDATA\Autodesk\ApplicationPlugins\Bimwright.Nwd.bundle\Contents\2027\Bimwright.Nwd.Plugin.Navis27.dll"
if (-not (Test-Path $dll)) { Falla "El plugin no quedó instalado en $dll" }
Ok $dll

Paso "Publicando el servidor MCP (.NET 8, autocontenido)"
$serverDir = "$env:LOCALAPPDATA\Bimwright\nwd-mcp\server\current"
& dotnet publish "$RepoDir\src\server\Bimwright.Nwd.Server.csproj" -c Release -r win-x64 --self-contained -o $serverDir -nologo -v q
if ($LASTEXITCODE -ne 0) { Falla "La publicación del servidor falló." }
Ok "$serverDir\nwd-mcp.exe"

Write-Host ""
Write-Host "Instalación terminada." -ForegroundColor Green
Write-Host "Abre Navisworks Manage 2027, carga un modelo y ejecuta: .\01-diagnostico.ps1"
