# Щоденний збір цін з цього комп'ютера і публікація на GitHub.
# Запускається Планувальником завдань Windows (див. scripts\install-task.ps1).
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
Start-Transcript -Path (Join-Path $root 'daily.log') -Append | Out-Null

function Invoke-Step($name, [scriptblock]$cmd) {
    Write-Host "== $name"
    & $cmd
    if ($LASTEXITCODE -ne 0) { throw "$name завершився з кодом $LASTEXITCODE" }
}

# Завдання будить комп'ютер зі сну: не даємо Windows приспати його знову, поки йде збір.
Add-Type -Namespace Win32 -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
$ES_CONTINUOUS = [uint32]'0x80000000'
$ES_SYSTEM_REQUIRED = [uint32]1

try {
    [Win32.Power]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED) | Out-Null
    Write-Host "Старт: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
    # Після пробудження мережа піднімається не одразу — чекаємо до 3 хвилин.
    for ($i = 0; $i -lt 36; $i++) {
        try { Invoke-WebRequest -Uri 'https://github.com' -Method Head -UseBasicParsing -TimeoutSec 5 | Out-Null; break }
        catch { Start-Sleep -Seconds 5 }
    }
    Invoke-Step 'git pull' { git pull --rebase --quiet }
    Invoke-Step 'npm ci' { npm ci --silent }
    Invoke-Step 'Збір цін' { npm run scrape }
    Invoke-Step 'git add' { git add site/data }
    git diff --cached --quiet
    if ($LASTEXITCODE -ne 0) {
        Invoke-Step 'git commit' { git commit --quiet -m "Ціни за $(Get-Date -Format 'yyyy-MM-dd')" }
        Invoke-Step 'git push' { git push --quiet }
        Write-Host 'Дані опубліковано.'
    } else {
        Write-Host 'Змін немає.'
    }
} catch {
    Write-Host "ПОМИЛКА: $_"
    exit 1
} finally {
    [Win32.Power]::SetThreadExecutionState($ES_CONTINUOUS) | Out-Null
    Stop-Transcript | Out-Null
}
