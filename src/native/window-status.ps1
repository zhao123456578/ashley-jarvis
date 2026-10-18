$ErrorActionPreference = 'Stop'
$excludedPid = if ($args.Count -ge 1) { [uint32]$args[0] } else { [uint32]0 }

# Windows version of the macOS window-status helper. Enumerates on-screen
# top-level windows via user32 and prints "occupied" when any visible window
# owned by another process has a non-empty title, otherwise "clear". The
# contract matches the original Swift helper consumed by hasVisibleApplication
# Windows() in src/main/main.ts.
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class WinStatus {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowTextLength(IntPtr h);
  public static bool HasOccupied(uint excluded) {
    bool found = false;
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == excluded) return true;
      if (GetWindowTextLength(h) > 0) { found = true; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@

if ([WinStatus]::HasOccupied($excludedPid)) { 'occupied' } else { 'clear' }
