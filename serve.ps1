# Minimal static file server (TcpListener-based, no admin / URL-ACL needed).
# Serves the project directory so ES modules load with correct MIME types.
param(
  [int]$Port = 8123,
  [string]$Root = $PSScriptRoot
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Net | Out-Null

$mime = @{
  ".html" = "text/html; charset=utf-8"
  ".js"   = "text/javascript; charset=utf-8"
  ".mjs"  = "text/javascript; charset=utf-8"
  ".css"  = "text/css; charset=utf-8"
  ".json" = "application/json; charset=utf-8"
  ".stl"  = "model/stl"
  ".svg"  = "image/svg+xml"
  ".png"  = "image/png"
  ".ico"  = "image/x-icon"
}

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()
Write-Host "Static server on http://localhost:$Port  (root: $Root)"

while ($true) {
  $client = $listener.AcceptTcpClient()
  try {
    # Read timeout so a speculative / preconnect socket that never sends a
    # request line can't deadlock this single-threaded server.
    $client.ReceiveTimeout = 4000
    $stream = $client.GetStream()
    $stream.ReadTimeout = 4000
    $reader = [System.IO.StreamReader]::new($stream)
    $requestLine = $reader.ReadLine()
    if (-not $requestLine) { $client.Close(); continue }

    $parts = $requestLine.Split(" ")
    $url = if ($parts.Length -ge 2) { $parts[1] } else { "/" }
    $url = $url.Split("?")[0]
    $url = [System.Uri]::UnescapeDataString($url)
    if ($url -eq "/") { $url = "/index.html" }

    # Resolve safely under root (block directory traversal).
    $relative = $url.TrimStart("/").Replace("/", [IO.Path]::DirectorySeparatorChar)
    $full = [IO.Path]::GetFullPath((Join-Path $Root $relative))
    $rootFull = [IO.Path]::GetFullPath($Root)

    $writer = [System.IO.BinaryWriter]::new($stream)
    if (-not $full.StartsWith($rootFull) -or -not (Test-Path $full -PathType Leaf)) {
      $body = [Text.Encoding]::UTF8.GetBytes("404 Not Found: $url")
      $head = "HTTP/1.1 404 Not Found`r`nContent-Type: text/plain`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n"
      $writer.Write([Text.Encoding]::ASCII.GetBytes($head))
      $writer.Write($body)
    } else {
      $ext = [IO.Path]::GetExtension($full).ToLower()
      $ct = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { "application/octet-stream" }
      $bytes = [IO.File]::ReadAllBytes($full)
      $head = "HTTP/1.1 200 OK`r`nContent-Type: $ct`r`nContent-Length: $($bytes.Length)`r`nCache-Control: no-cache`r`nAccess-Control-Allow-Origin: *`r`nConnection: close`r`n`r`n"
      $writer.Write([Text.Encoding]::ASCII.GetBytes($head))
      $writer.Write($bytes)
    }
    $writer.Flush()
  } catch {
    Write-Host "err: $($_.Exception.Message)"
  } finally {
    $client.Close()
  }
}
