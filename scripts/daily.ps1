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

$started = Get-Date
$ok = $false
$result = ''
$scrapeOut = @()

# Короткий звіт на робочому столі після кожного запуску (перезаписується).
function Write-StatusFile {
    $today = $started.ToString('yyyy-MM-dd')
    $sum = @{ down = 0; up = 0; added = 0; removed = 0; cities = 0 }
    foreach ($f in Get-ChildItem (Join-Path $root 'site\data\cities') -Recurse -Filter 'changes.json' -ErrorAction SilentlyContinue) {
        try { $c = Get-Content $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json } catch { continue }
        if ($c.date -ne $today) { continue }
        $sum.cities++
        $sum.down += @($c.prices | Where-Object { $_.to -lt $_.from }).Count
        $sum.up += @($c.prices | Where-Object { $_.to -gt $_.from }).Count
        $sum.added += @($c.added).Count
        $sum.removed += @($c.removed).Count
    }
    $finished = Get-Date
    $done = $scrapeOut | Where-Object { $_ -match '^Готово' } | Select-Object -Last 1
    $status = if (-not $ok) { 'ПОМИЛКА' } elseif ($done -match 'з помилками [1-9]') { 'ЧАСТКОВО (деякі міста не зібрано)' } else { 'УСПІШНО' }
    $lines = @(
        'PriceTrail — щоденний збір цін',
        '',
        "Статус: $status",
        "Початок:    $($started.ToString('dd.MM.yyyy HH:mm:ss'))",
        "Завершення: $($finished.ToString('dd.MM.yyyy HH:mm:ss'))",
        "Тривалість: $([math]::Round(($finished - $started).TotalMinutes)) хв",
        '',
        $result
    )
    if ($done) { $lines += $done }
    if ($sum.cities) {
        $lines += "Зміни за сьогодні (міст: $($sum.cities)): подешевшало $($sum.down), подорожчало $($sum.up), нових товарів $($sum.added), зникло $($sum.removed)"
    }
    $lines += '', "Сайт: https://fima02.github.io/pricetrail/", "Повний журнал: $(Join-Path $root 'daily.log')"
    $file = Join-Path ([Environment]::GetFolderPath('Desktop')) 'PriceTrail — статус збору.txt'
    $lines | Out-File -FilePath $file -Encoding utf8
}

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
    Write-Host '== Збір цін'
    # Виводимо в журнал і водночас запам'ятовуємо — для звіту на робочому столі.
    $scrapeOut = @(npm run scrape | ForEach-Object { Write-Host $_; $_ })
    if ($LASTEXITCODE -ne 0) { throw "Збір цін завершився з кодом $LASTEXITCODE" }
    Invoke-Step 'git add' { git add site/data }
    git diff --cached --quiet
    if ($LASTEXITCODE -ne 0) {
        Invoke-Step 'git commit' { git commit --quiet -m "Ціни за $(Get-Date -Format 'yyyy-MM-dd')" }
        Invoke-Step 'git push' { git push --quiet }
        $result = 'Дані опубліковано на сайті (оновиться за кілька хвилин).'
    } else {
        $result = 'Змін у даних немає — публікувати нічого.'
    }
    Write-Host $result
    $ok = $true
} catch {
    $result = "Що сталося: $_"
    Write-Host "ПОМИЛКА: $_"
    exit 1
} finally {
    [Win32.Power]::SetThreadExecutionState($ES_CONTINUOUS) | Out-Null
    try { Write-StatusFile } catch { Write-Host "Не вдалося записати звіт: $_" }
    Stop-Transcript | Out-Null
}
