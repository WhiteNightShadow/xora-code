# Copyright (c) 2026 Xora Code contributors.
# SPDX-License-Identifier: Apache-2.0
# Fixed launcher only: arguments and credentials are never interpolated into code.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

try {
    Add-Type -ReferencedAssemblies @('System.dll', 'System.Core.dll', 'System.Web.Extensions.dll') -TypeDefinition @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

public sealed class XoraWindowsProcessJob
{
    private const uint KillOnJobClose = 0x00002000;
    private const uint CreateSuspended = 0x00000004;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private const uint CreateNoWindow = 0x08000000;
    private const uint WaitObject0 = 0;
    private const uint WaitTimeout = 258;
    private const int MaximumControlLine = 128 * 1024;
    private static readonly IntPtr InvalidHandle = new IntPtr(-1);

    private NamedPipeClientStream control;
    private StreamReader reader;
    private StreamWriter writer;
    private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = MaximumControlLine };
    private IntPtr job;
    private PROCESS_INFORMATION child;
    private string stopReason;
    private int closed;

    public static int Run()
    {
        return new XoraWindowsProcessJob().Execute();
    }

    private int Execute()
    {
        string reason = "error";
        uint exitCode = 1;
        try
        {
            Connect();
            string token = Environment.GetEnvironmentVariable("XORA_WINDOWS_JOB_TOKEN");
            if (String.IsNullOrEmpty(token) || token.Length > 256) throw new GuardianError("invalid-control-token");
            Send(new { type = "hello", token = token });
            Task<string> first = Task.Factory.StartNew(() => ReadBoundedLine(reader));
            if (!first.Wait(5000)) throw new GuardianError("launch-request-timeout");
            if (first.Result == null)
            {
                reason = "disconnect";
                exitCode = 0;
            }
            else
            {
                Dictionary<string, object> request = Parse(first.Result);
                string type = StringField(request, "type");
                if (type == "stop")
                {
                    reason = "stop";
                    exitCode = 0;
                }
                else
                {
                    if (type != "launch") throw new GuardianError("invalid-launch-request");
                    Task.Factory.StartNew(() => ObserveControl());
                    Launch(request);
                    Send(new { type = "started", pid = child.dwProcessId });
                    while (true)
                    {
                        string requestedStop = Volatile.Read(ref stopReason);
                        if (requestedStop != null)
                        {
                            reason = requestedStop;
                            break;
                        }
                        uint wait = WaitForSingleObject(child.hProcess, 50);
                        if (wait == WaitObject0)
                        {
                            if (!GetExitCodeProcess(child.hProcess, out exitCode)) throw new GuardianError("process-exit-query-failed");
                            reason = "exit";
                            break;
                        }
                        if (wait != WaitTimeout) throw new GuardianError("process-wait-failed");
                    }
                }
            }
        }
        catch (GuardianError error)
        {
            Send(new { type = "error", code = error.Code });
        }
        catch
        {
            // Never forward PowerShell, .NET, JSON or native exception text:
            // command lines and environment variables can contain credentials.
            Send(new { type = "error", code = "guardian-operation-failed" });
        }

        bool confirmed = TerminateAndConfirm();
        if (confirmed)
        {
            // This is the sole terminal authority. A leader exit or successful
            // TerminateJobObject call alone does not release the host's fences.
            Send(new { type = "terminated", exitCode = exitCode, reason = reason });
        }
        else
        {
            Send(new { type = "error", code = "job-termination-unconfirmed" });
        }
        Interlocked.Exchange(ref closed, 1);
        try { if (control != null) control.Dispose(); } catch { }
        if (child.hThread != IntPtr.Zero) CloseHandle(child.hThread);
        if (child.hProcess != IntPtr.Zero) CloseHandle(child.hProcess);
        // The handle was never inheritable or sent to another process. Any
        // guardian crash/forced exit also closes it and kills the owned Job.
        if (job != IntPtr.Zero) CloseHandle(job);
        return confirmed ? unchecked((int)exitCode) : 1;
    }

    private void Connect()
    {
        string pipeName = Environment.GetEnvironmentVariable("XORA_WINDOWS_JOB_PIPE");
        const string prefix = @"\\.\pipe\";
        if (pipeName != null && pipeName.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) pipeName = pipeName.Substring(prefix.Length);
        if (String.IsNullOrEmpty(pipeName) || pipeName.Length > 180 || !pipeName.StartsWith("xora-", StringComparison.Ordinal)
            || !System.Text.RegularExpressions.Regex.IsMatch(pipeName, @"\A[A-Za-z0-9._-]+\z")) throw new GuardianError("invalid-control-pipe");
        control = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        control.Connect(5000);
        reader = new StreamReader(control, new UTF8Encoding(false, true), false, 4096, true);
        writer = new StreamWriter(control, new UTF8Encoding(false), 4096, true) { AutoFlush = true, NewLine = "\n" };
    }

    private void ObserveControl()
    {
        try
        {
            while (Volatile.Read(ref closed) == 0)
            {
                string line = ReadBoundedLine(reader);
                if (line == null)
                {
                    Interlocked.CompareExchange(ref stopReason, "disconnect", null);
                    return;
                }
                Dictionary<string, object> message = Parse(line);
                if (StringField(message, "type") != "stop")
                {
                    Interlocked.CompareExchange(ref stopReason, "error", null);
                    return;
                }
                Interlocked.CompareExchange(ref stopReason, "stop", null);
                return;
            }
        }
        catch
        {
            if (Volatile.Read(ref closed) == 0) Interlocked.CompareExchange(ref stopReason, "disconnect", null);
        }
    }

    private void Launch(Dictionary<string, object> request)
    {
        string binary = StringField(request, "binary");
        string cwd = StringField(request, "cwd");
        if (!Path.IsPathRooted(binary) || !Path.IsPathRooted(cwd) || binary.IndexOf('\0') >= 0 || cwd.IndexOf('\0') >= 0
            || binary.Length > 16384 || cwd.Length > 16384) throw new GuardianError("invalid-launch-path");
        object rawArgs;
        if (!request.TryGetValue("args", out rawArgs) || !(rawArgs is object[])) throw new GuardianError("invalid-launch-arguments");
        object[] args = (object[])rawArgs;
        if (args.Length > 64) throw new GuardianError("invalid-launch-arguments");
        StringBuilder commandLine = new StringBuilder(QuoteArgument(binary));
        foreach (object argument in args)
        {
            string value = argument as string;
            if (value == null || value.Length > 16384 || value.IndexOf('\0') >= 0) throw new GuardianError("invalid-launch-arguments");
            commandLine.Append(' ').Append(QuoteArgument(value));
        }
        if (commandLine.Length >= 32767) throw new GuardianError("launch-command-too-long");

        job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new GuardianError("job-create-failed");
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = KillOnJobClose;
        if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits))) throw new GuardianError("job-configure-failed");

        IntPtr attributes = IntPtr.Zero;
        IntPtr jobList = IntPtr.Zero;
        IntPtr handleList = IntPtr.Zero;
        IntPtr environment = IntPtr.Zero;
        IntPtr[] handles = new IntPtr[3];
        bool attributesInitialized = false;
        try
        {
            for (int index = 0; index < handles.Length; index++)
            {
                IntPtr original = GetStdHandle(-10 - index);
                if (original == IntPtr.Zero || original == InvalidHandle
                    || !DuplicateHandle(GetCurrentProcess(), original, GetCurrentProcess(), out handles[index], 0, true, 2))
                    throw new GuardianError("stdio-inheritance-failed");
            }
            IntPtr attributeBytes = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref attributeBytes);
            if (attributeBytes == IntPtr.Zero || attributeBytes.ToInt64() > 65536) throw new GuardianError("launch-attributes-failed");
            attributes = Marshal.AllocHGlobal(attributeBytes);
            if (!InitializeProcThreadAttributeList(attributes, 2, 0, ref attributeBytes)) throw new GuardianError("launch-attributes-failed");
            attributesInitialized = true;
            jobList = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobList, job);
            handleList = Marshal.AllocHGlobal(IntPtr.Size * handles.Length);
            for (int index = 0; index < handles.Length; index++) Marshal.WriteIntPtr(handleList, index * IntPtr.Size, handles[index]);
            // Windows 10+ associates the Job atomically at process creation.
            // CREATE_SUSPENDED + AssignProcessToJobObject alone would leave a
            // suspended orphan if this guardian crashed between those calls.
            if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x0002000D), jobList, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero)
                || !UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x00020002), handleList, new IntPtr(IntPtr.Size * handles.Length), IntPtr.Zero, IntPtr.Zero))
                throw new GuardianError("job-launch-attributes-failed");

            STARTUPINFOEX startup = new STARTUPINFOEX();
            startup.StartupInfo.cb = Marshal.SizeOf(startup);
            startup.StartupInfo.dwFlags = 0x00000101;
            startup.StartupInfo.wShowWindow = 0;
            startup.StartupInfo.hStdInput = handles[0];
            startup.StartupInfo.hStdOutput = handles[1];
            startup.StartupInfo.hStdError = handles[2];
            startup.lpAttributeList = attributes;
            environment = ChildEnvironment();
            if (!CreateProcess(binary, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                CreateSuspended | CreateUnicodeEnvironment | ExtendedStartupInfoPresent | CreateNoWindow,
                environment, cwd, ref startup, out child)) throw new GuardianError("sidecar-create-failed");
            bool assigned;
            if (!IsProcessInJob(child.hProcess, job, out assigned) || !assigned) throw new GuardianError("job-assignment-unconfirmed");
            // Cancellation can arrive while CreateProcess is resolving an
            // executable or working directory. Keep that process suspended
            // until the normal Job cleanup confirms that it has been killed.
            if (Volatile.Read(ref stopReason) == null && ResumeThread(child.hThread) == UInt32.MaxValue)
                throw new GuardianError("sidecar-resume-failed");
            CloseHandle(child.hThread);
            child.hThread = IntPtr.Zero;
        }
        finally
        {
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            if (attributesInitialized) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
            if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
            foreach (IntPtr handle in handles) if (handle != IntPtr.Zero) CloseHandle(handle);
        }
    }

    private bool TerminateAndConfirm()
    {
        if (job == IntPtr.Zero) return child.hProcess == IntPtr.Zero;
        // Query, rather than the return value of termination, proves completion.
        TerminateJobObject(job, 1);
        // If membership verification itself failed, retain authority over the
        // exact process handle returned by CreateProcess. Never leave a
        // suspended child behind or fall back to an unverified/reused PID.
        if (child.hProcess != IntPtr.Zero && WaitForSingleObject(child.hProcess, 0) != WaitObject0)
            TerminateProcess(child.hProcess, 1);
        Stopwatch deadline = Stopwatch.StartNew();
        do
        {
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
            if (!QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), IntPtr.Zero)) return false;
            if (accounting.ActiveProcesses == 0
                && (child.hProcess == IntPtr.Zero || WaitForSingleObject(child.hProcess, 0) == WaitObject0)) return true;
            Thread.Sleep(20);
        } while (deadline.ElapsedMilliseconds < 5000);
        return false;
    }

    private void Send(object message)
    {
        try { if (writer != null) writer.WriteLine(json.Serialize(message)); } catch { }
    }

    private Dictionary<string, object> Parse(string line)
    {
        JavaScriptSerializer parser = new JavaScriptSerializer { MaxJsonLength = MaximumControlLine };
        Dictionary<string, object> parsed = parser.DeserializeObject(line) as Dictionary<string, object>;
        if (parsed == null) throw new GuardianError("invalid-control-message");
        return parsed;
    }

    private static string StringField(Dictionary<string, object> message, string field)
    {
        object value;
        if (!message.TryGetValue(field, out value) || !(value is string)) throw new GuardianError("invalid-control-field");
        return (string)value;
    }

    private static string ReadBoundedLine(StreamReader input)
    {
        StringBuilder value = new StringBuilder();
        int character;
        while ((character = input.Read()) != -1)
        {
            if (character == '\n') return value.ToString();
            if (value.Length >= MaximumControlLine) throw new GuardianError("control-message-too-large");
            value.Append((char)character);
        }
        return value.Length == 0 ? null : value.ToString();
    }

    private static IntPtr ChildEnvironment()
    {
        SortedDictionary<string, string> values = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables())
        {
            string name = (string)entry.Key;
            if (name.Equals("XORA_WINDOWS_JOB_PIPE", StringComparison.OrdinalIgnoreCase)
                || name.Equals("XORA_WINDOWS_JOB_TOKEN", StringComparison.OrdinalIgnoreCase)) continue;
            values[name] = (string)entry.Value;
        }
        StringBuilder block = new StringBuilder();
        foreach (KeyValuePair<string, string> entry in values) block.Append(entry.Key).Append('=').Append(entry.Value).Append('\0');
        block.Append('\0');
        return Marshal.StringToHGlobalUni(block.ToString());
    }

    private static string QuoteArgument(string argument)
    {
        if (argument.Length > 0 && argument.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0) return argument;
        StringBuilder result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in argument)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '"') result.Append('\\', slashes * 2 + 1).Append('"');
            else result.Append('\\', slashes).Append(character);
            slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }

    private sealed class GuardianError : Exception
    {
        public readonly string Code;
        public GuardianError(string code) { Code = code; }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved, lpDesktop, lpTitle;
        public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public ushort wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public uint dwProcessId, dwThreadId;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr handle, int informationClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool QueryInformationJobObject(IntPtr handle, int informationClass, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information, uint size, IntPtr returnedSize);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateJobObject(IntPtr handle, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool assigned);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previousValue, IntPtr returnedSize);
    [DllImport("kernel32.dll")] private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateProcess(string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string cwd, ref STARTUPINFOEX startup, out PROCESS_INFORMATION information);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GetStdHandle(int standardHandle);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);
}
'@
    $guardianExitCode = [XoraWindowsProcessJob]::Run()
    exit $guardianExitCode
} catch {
    # Compilation/policy failures occur before any sidecar can be created.
    # The controller times out or observes this fixed nonzero exit safely.
    exit 1
}
