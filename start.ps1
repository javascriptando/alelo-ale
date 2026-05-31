# Sobe TODA a stack do Alelo de forma persistente (sobrevive ao fechar terminais).
# Uso:  powershell -ExecutionPolicy Bypass -File start.ps1
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

Write-Host "== 1/3 Docker (Postgres + Redis + Evolution) ==" -ForegroundColor Cyan
docker compose -f "$root\docker-compose.yml" up -d | Out-Host

Write-Host "   aguardando Postgres ficar healthy..."
for ($i=0; $i -lt 40; $i++) {
  $h = (docker inspect --format '{{.State.Health.Status}}' alelo-db 2>$null)
  if ($h -eq 'healthy') { break }
  Start-Sleep -Seconds 2
}

Write-Host "== 2/3 Backend (porta 3333) ==" -ForegroundColor Cyan
Start-Process -FilePath "cmd.exe" `
  -ArgumentList '/c','npm','run','dev' `
  -WorkingDirectory "$root\server" `
  -WindowStyle Hidden
Write-Host "   backend iniciando em background"

Write-Host "== 3/3 Painel web (porta 3000) ==" -ForegroundColor Cyan
Start-Process -FilePath "cmd.exe" `
  -ArgumentList '/c','npm','run','dev' `
  -WorkingDirectory "$root\web" `
  -WindowStyle Hidden
Write-Host "   web iniciando em background"

Write-Host ""
Write-Host "Pronto. Aguarde ~15s e acesse:" -ForegroundColor Green
Write-Host "  Painel:    http://localhost:3000   (admin@alelo.com / admin123)"
Write-Host "  Backend:   http://localhost:3333/health"
Write-Host "  QR Whats:  http://localhost:3333/whatsapp/qr"
Write-Host ""
Write-Host "Para parar tudo: powershell -ExecutionPolicy Bypass -File stop.ps1"
