# NwdMcpCliente.psm1
# Cliente MCP mínimo (JSON-RPC sobre stdio) para hablar con nwd-mcp.exe desde PowerShell.
# Compatible con Windows PowerShell 5.1 y PowerShell 7.

$script:Proc = $null
$script:Writer = $null
$script:NextId = 1
$script:Schemas = @{}

function Start-NwdMcp {
    param(
        [string]$Exe = "$env:LOCALAPPDATA\Bimwright\nwd-mcp\server\current\nwd-mcp.exe",
        [string]$Target = "2027",
        [switch]$ReadOnly
    )
    if (-not (Test-Path $Exe)) { throw "No se encuentra el servidor MCP en: $Exe" }

    $argsLine = "--target $Target"
    if ($ReadOnly) { $argsLine += " --read-only" }

    $psi = New-Object System.Diagnostics.ProcessStartInfo $Exe, $argsLine
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8

    $script:Proc = [System.Diagnostics.Process]::Start($psi)
    $script:Proc.BeginErrorReadLine()   # descarta los logs de stderr para que no bloqueen
    $script:Writer = New-Object System.IO.StreamWriter($script:Proc.StandardInput.BaseStream, (New-Object System.Text.UTF8Encoding $false))
    $script:Writer.AutoFlush = $true

    $init = Invoke-NwdRpc -Method "initialize" -Params @{
        protocolVersion = "2025-06-18"
        capabilities    = @{}
        clientInfo      = @{ name = "nwd-mcp-demo"; version = "1.0" }
    }
    Send-NwdRaw @{ jsonrpc = "2.0"; method = "notifications/initialized" }

    $tools = Invoke-NwdRpc -Method "tools/list" -Params @{}
    $script:Schemas = @{}
    foreach ($t in $tools.tools) { $script:Schemas[$t.name] = $t.inputSchema }

    [pscustomobject]@{
        Servidor     = "$($init.serverInfo.name) $($init.serverInfo.version)"
        Herramientas = @($tools.tools | ForEach-Object { $_.name })
    }
}

function Stop-NwdMcp {
    if ($script:Proc -and -not $script:Proc.HasExited) {
        try { $script:Writer.Close() } catch {}
        if (-not $script:Proc.WaitForExit(3000)) { $script:Proc.Kill() }
    }
    $script:Proc = $null
}

function Send-NwdRaw($obj) {
    $script:Writer.WriteLine(($obj | ConvertTo-Json -Depth 30 -Compress))
}

function Invoke-NwdRpc {
    param([string]$Method, $Params, [int]$TimeoutSec = 90)
    $id = $script:NextId; $script:NextId++
    Send-NwdRaw @{ jsonrpc = "2.0"; id = $id; method = $Method; params = $Params }
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ($true) {
        $restante = [int]($deadline - (Get-Date)).TotalMilliseconds
        if ($restante -le 0) { throw "Sin respuesta del servidor MCP para '$Method' (timeout $TimeoutSec s)" }
        $task = $script:Proc.StandardOutput.ReadLineAsync()
        if (-not $task.Wait($restante)) { throw "Sin respuesta del servidor MCP para '$Method' (timeout $TimeoutSec s)" }
        $line = $task.Result
        if ($null -eq $line) { throw "El servidor MCP se cerró inesperadamente." }
        if ($line.Trim() -eq "") { continue }
        $msg = $line | ConvertFrom-Json
        # Ignora notificaciones y respuestas con otro id
        if ($msg.PSObject.Properties.Name -notcontains "id" -or $msg.id -ne $id) { continue }
        if ($msg.PSObject.Properties.Name -contains "error" -and $msg.error) {
            throw "Error MCP en '$Method': $($msg.error.message)"
        }
        return $msg.result
    }
}

# Traduce nombres de argumento (p. ej. "item_ids") al nombre exacto que declara el esquema
# de la herramienta ("itemIds" o "item_ids"), para no depender de la convención del servidor.
function Resolve-ArgName([string]$Tool, [string]$Name) {
    $schema = $script:Schemas[$Tool]
    if (-not $schema -or -not $schema.properties) { return $Name }
    $norm = ($Name -replace "_", "").ToLower()
    foreach ($p in $schema.properties.PSObject.Properties.Name) {
        if (($p -replace "_", "").ToLower() -eq $norm) { return $p }
    }
    return $Name
}

function Invoke-NwdTool {
    <#
      Llama a una herramienta nwd_* y devuelve el JSON ya interpretado (objeto PowerShell).
      Ejemplo: Invoke-NwdTool nwd_find_items_by_name @{ name = "Muro"; max_items = 20 }
    #>
    param([Parameter(Mandatory)][string]$Tool, [hashtable]$Arguments = @{}, [int]$TimeoutSec = 90)
    if ($script:Schemas.Count -gt 0 -and -not $script:Schemas.ContainsKey($Tool)) {
        throw "La herramienta '$Tool' no está disponible (¿modo --read-only?)."
    }
    $mapped = @{}
    foreach ($k in $Arguments.Keys) { $mapped[(Resolve-ArgName $Tool $k)] = $Arguments[$k] }

    $res = Invoke-NwdRpc -Method "tools/call" -Params @{ name = $Tool; arguments = $mapped } -TimeoutSec $TimeoutSec
    $text = ($res.content | Where-Object { $_.type -eq "text" } | ForEach-Object { $_.text }) -join "`n"
    $parsed = $null
    try { $parsed = $text | ConvertFrom-Json } catch { $parsed = $text }
    if ($res.isError) {
        Write-Warning "La herramienta $Tool devolvió un error: $text"
    }
    return $parsed
}

# Obtiene el bloque "data" de la respuesta estándar { ok, data, meta } si existe.
function Get-NwdData($respuesta) {
    if ($respuesta -and $respuesta.PSObject.Properties.Name -contains "data") { return $respuesta.data }
    return $respuesta
}

# Busca recursivamente la primera propiedad con ese nombre dentro de una respuesta.
function Find-NwdProperty($obj, [string]$Name) {
    if ($null -eq $obj -or $obj -is [string] -or $obj -is [ValueType]) { return $null }
    if ($obj -is [System.Collections.IEnumerable]) {
        foreach ($i in $obj) { $r = Find-NwdProperty $i $Name; if ($null -ne $r) { return $r } }
        return $null
    }
    foreach ($p in $obj.PSObject.Properties) {
        if ($p.Name -eq $Name) { return $p.Value }
    }
    foreach ($p in $obj.PSObject.Properties) {
        $r = Find-NwdProperty $p.Value $Name
        if ($null -ne $r) { return $r }
    }
    return $null
}

function Write-Paso([string]$Texto) {
    Write-Host ""
    Write-Host ("=" * 70) -ForegroundColor DarkCyan
    Write-Host " $Texto" -ForegroundColor Cyan
    Write-Host ("=" * 70) -ForegroundColor DarkCyan
}

function Save-NwdJson($obj, [string]$Path) {
    $dir = Split-Path $Path -Parent
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $obj | ConvertTo-Json -Depth 30 | Set-Content -Path $Path -Encoding UTF8
    Write-Host "  -> guardado: $Path" -ForegroundColor DarkGray
}

Export-ModuleMember -Function Start-NwdMcp, Stop-NwdMcp, Invoke-NwdTool, Get-NwdData, Find-NwdProperty, Write-Paso, Save-NwdJson
