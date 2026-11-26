# Geometry only: no window titles, process names, screenshots, or document text.
# $ExcludedProcessId is supplied by the trusted Electron main process.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

try {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class MongleMongWindowGeometry {
    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left, Top, Right, Bottom; }
    private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr param);

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr param);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder name, int maxCount);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] private static extern IntPtr GetWindowLongPtr64(IntPtr hwnd, int index);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] private static extern int GetWindowLong32(IntPtr hwnd, int index);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out RECT value, int size);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
    [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
    [DllImport("shcore.dll")] private static extern int SetProcessDpiAwareness(int awareness);
    [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

    public sealed class WindowRect {
        public string id;
        public int x, y, width, height, zOrder;
    }
    public sealed class Snapshot {
        public List<WindowRect> windows = new List<WindowRect>();
        public List<WindowRect> taskbars = new List<WindowRect>();
    }

    public static void SetDpiAwareness() {
        bool set = false;
        try { set = SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) {}
        if (!set) {
            try { set = SetProcessDpiAwareness(2) == 0; } catch (DllNotFoundException) {} catch (EntryPointNotFoundException) {}
        }
        if (!set) SetProcessDPIAware();
    }

    public static Snapshot Read(uint excludedProcessId) {
        // PowerShell may already have set process awareness. Apply per-monitor
        // awareness to the enumerating thread too, preventing virtualized pixels.
        IntPtr previousContext = IntPtr.Zero;
        try { previousContext = SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) {}
        Snapshot result = new Snapshot();
        int zOrder = 0;
        try {
            EnumWindows(delegate(IntPtr hwnd, IntPtr unused) {
                int order = zOrder++;
                if (!IsWindowVisible(hwnd) || IsIconic(hwnd)) return true;
                uint processId;
                GetWindowThreadProcessId(hwnd, out processId);
                if (processId == excludedProcessId) return true;
                int cloaked;
                if (DwmGetWindowAttribute(hwnd, 14, out cloaked, 4) == 0 && cloaked != 0) return true;

                StringBuilder buffer = new StringBuilder(256);
                GetClassName(hwnd, buffer, buffer.Capacity);
                string className = buffer.ToString();
                bool taskbar = className == "Shell_TrayWnd" || className == "Shell_SecondaryTrayWnd";
                if (className == "Progman" || className == "WorkerW" || className == "#32768"
                    || className == "tooltips_class32" || className == "TaskListThumbnailWnd") return true;
                long styles = IntPtr.Size == 8 ? GetWindowLongPtr64(hwnd, -20).ToInt64() : GetWindowLong32(hwnd, -20);
                // Tool palettes/popups are not platforms. Keep the taskbar even
                // though Windows itself marks it as a tool/no-activate window.
                if (!taskbar && (styles & (0x00000080L | 0x08000000L)) != 0) return true;

                RECT rect;
                if (taskbar) {
                    if (!GetWindowRect(hwnd, out rect)) return true;
                } else if (DwmGetWindowAttribute(hwnd, 9, out rect, Marshal.SizeOf(typeof(RECT))) != 0
                    && !GetWindowRect(hwnd, out rect)) return true;
                int width = rect.Right - rect.Left;
                int height = rect.Bottom - rect.Top;
                if (width <= 0 || height <= 0 || (!taskbar && (width < 32 || height < 24))) return true;
                WindowRect item = new WindowRect { id = hwnd.ToInt64().ToString(), x = rect.Left, y = rect.Top,
                    width = width, height = height, zOrder = order };
                if (taskbar) {
                    if (result.taskbars.Count < 16) result.taskbars.Add(item);
                } else if (result.windows.Count < 128) result.windows.Add(item);
                return true;
            }, IntPtr.Zero);
        } finally {
            if (previousContext != IntPtr.Zero) {
                try { SetThreadDpiAwarenessContext(previousContext); } catch (EntryPointNotFoundException) {}
            }
        }
        return result;
    }
}
'@ | Out-Null

    [MongleMongWindowGeometry]::SetDpiAwareness()
    # Normal shutdown kills the helper. Also stop after a crashed/force-closed
    # game, so a detached PowerShell collector cannot linger in the background.
    $gameProcess = [System.Diagnostics.Process]::GetProcessById([int]$ExcludedProcessId)
    while (-not $gameProcess.HasExited) {
        $snapshot = [MongleMongWindowGeometry]::Read([uint32]$ExcludedProcessId)
        [Console]::WriteLine((ConvertTo-Json -InputObject $snapshot -Depth 4 -Compress))
        [Console]::Out.Flush()
        Start-Sleep -Milliseconds 400
    }
} catch {
    [Console]::Error.WriteLine('MongleMong window geometry collector unavailable.')
    exit 1
}
