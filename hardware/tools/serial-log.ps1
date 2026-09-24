param(
  [string]$PortName = 'COM8',
  [int]$Baud = 115200,
  [int]$Seconds = 10
)

Write-Output "=== VID/PID for $PortName ==="
Get-PnpDevice -Class Ports | Where-Object { $_.FriendlyName -like "*$PortName*" } | ForEach-Object {
  Write-Output ("FriendlyName: " + $_.FriendlyName)
  Write-Output ("InstanceId  : " + $_.InstanceId)
  (Get-PnpDeviceProperty -InstanceId $_.InstanceId -KeyName 'DEVPKEY_Device_HardwareIds').Data | ForEach-Object {
    Write-Output ("HWID        : " + $_)
  }
}

Write-Output "=== Serial log from $PortName @ $Baud ($Seconds s) ==="
$port = New-Object System.IO.Ports.SerialPort($PortName, $Baud, 'None', 8, 'One')
$port.ReadTimeout = 600
$port.DtrEnable = $true
$port.RtsEnable = $true
try {
  $port.Open()
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt $Seconds) {
    try { $line = $port.ReadLine(); Write-Output $line } catch {}
  }
} finally {
  if ($port.IsOpen) { $port.Close() }
}
