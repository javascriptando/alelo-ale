# Para o backend (3333) e o web (3000). Os containers Docker continuam rodando.
# Para parar os containers também:  docker compose down
foreach ($port in @(3333, 3000)) {
  $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if ($conns) {
    $conns.OwningProcess | Sort-Object -Unique | ForEach-Object {
      Write-Host "parando PID $_ (porta $port)"
      Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
    }
  } else {
    Write-Host "porta $port ja livre"
  }
}
Write-Host "Backend e web parados. (Containers Docker seguem de pe; use 'docker compose down' para pará-los.)"
