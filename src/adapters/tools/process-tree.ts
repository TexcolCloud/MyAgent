import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { DomainError } from "../../domain/errors.js";

export interface ProcessStartOptions {
  cwd: string;
  env: Readonly<Record<string, string>>;
}

export interface ProcessExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export class ProcessTree {
  readonly #exit: Promise<ProcessExit>;
  #closed = false;
  #exited = false;
  #termination: Promise<void> | undefined;

  private constructor(readonly child: ChildProcessWithoutNullStreams) {
    this.#exit = new Promise((resolve, reject) => {
      child.once("error", (error) => {
        this.#exited = true;
        reject(error);
      });
      child.once("exit", () => {
        this.#exited = true;
      });
      child.once("close", (exitCode, signal) => {
        this.#closed = true;
        resolve({ exitCode, signal });
      });
    });
  }

  static start(
    program: string,
    args: readonly string[],
    options: ProcessStartOptions,
  ): ProcessTree {
    const child = process.platform === "win32"
      ? startWindowsJob(program, args, options)
      : spawn(program, args, {
          cwd: options.cwd,
          env: isolatedEnvironment(options.env),
          shell: false,
          windowsHide: true,
          detached: true,
        });
    if (process.platform !== "win32") child.stdin.end();
    return new ProcessTree(child);
  }

  wait(): Promise<ProcessExit> {
    return this.#exit;
  }

  terminate(graceMs = 1_000): Promise<void> {
    this.#termination ??= this.#terminate(graceMs);
    return this.#termination;
  }

  async #terminate(graceMs: number): Promise<void> {
    if (this.#hasExited()) {
      await this.#exit;
      return;
    }
    const pid = this.child.pid;
    if (pid === undefined) {
      await this.#exit;
      return;
    }

    if (process.platform === "win32") {
      if (!this.child.kill("SIGKILL") && !this.#hasExited()) {
        throw new DomainError("process_tree_termination_failed");
      }
    } else {
      signalProcessGroup(pid, "SIGTERM");
      if (await processGroupStillRunning(pid, graceMs)) {
        signalProcessGroup(pid, "SIGKILL");
      }
    }
    await this.#exit;
  }

  #hasExited(): boolean {
    return (
      this.#exited ||
      this.#closed ||
      this.child.exitCode !== null ||
      this.child.signalCode !== null
    );
  }
}

function startWindowsJob(
  program: string,
  args: readonly string[],
  options: ProcessStartOptions,
): ChildProcessWithoutNullStreams {
  const systemRoot =
    Object.entries(process.env).find(
      ([name]) => name.toLowerCase() === "systemroot",
    )?.[1] ?? "C:\\Windows";
  const child = spawn(
    path.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      WINDOWS_JOB_BOOTSTRAP,
    ],
    {
      cwd: options.cwd,
      env: windowsSupervisorEnvironment(options.env),
      shell: false,
      windowsHide: true,
    },
  );
  child.stdin.end(JSON.stringify({
    program,
    args,
    cwd: options.cwd,
    env: isolatedEnvironment(options.env),
  }));
  return child;
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!hasErrorCode(error, "ESRCH")) {
      throw error;
    }
  }
}

async function processGroupStillRunning(
  pid: number,
  graceMs: number,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, graceMs);
  while (isProcessGroupRunning(pid)) {
    if (Date.now() >= deadline) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

function isProcessGroupRunning(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ESRCH")) {
      return false;
    }
    throw error;
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function isolatedEnvironment(
  allowedValues: Readonly<Record<string, string>>,
): Record<string, string> {
  if (process.platform !== "win32") {
    return { ...allowedValues };
  }

  const environment = Object.fromEntries(
    Object.keys(process.env).map((name) => [name, ""]),
  );
  const systemRootName = Object.keys(process.env).find(
    (name) => name.toLowerCase() === "systemroot",
  );
  if (systemRootName !== undefined) {
    environment[systemRootName] = process.env[systemRootName] ?? "";
  }
  for (const [name, value] of Object.entries(allowedValues)) {
    for (const existingName of Object.keys(environment)) {
      if (existingName.toLowerCase() === name.toLowerCase()) {
        delete environment[existingName];
      }
    }
    environment[name] = value;
  }
  return environment;
}

function windowsSupervisorEnvironment(
  allowedValues: Readonly<Record<string, string>>,
): Record<string, string> {
  const structuralNames = new Set([
    "appdata",
    "comspec",
    "localappdata",
    "path",
    "pathext",
    "programdata",
    "psmodulepath",
    "systemroot",
    "temp",
    "tmp",
    "userprofile",
    "windir",
  ]);
  const environment = Object.fromEntries(
    Object.entries(process.env)
      .filter(([name, value]) => structuralNames.has(name.toLowerCase()) && value !== undefined)
      .map(([name, value]) => [name, value as string]),
  );
  for (const [name, value] of Object.entries(allowedValues)) {
    for (const existingName of Object.keys(environment)) {
      if (existingName.toLowerCase() === name.toLowerCase()) {
        delete environment[existingName];
      }
    }
    environment[name] = value;
  }
  environment.MYAGENT_WINDOWS_JOB_HOST = WINDOWS_JOB_HOST_GZIP;
  return environment;
}

const WINDOWS_JOB_HOST_GZIP = gzipSync(Buffer.from(String.raw`
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

Add-Type @'
using System;
using System.ComponentModel;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class MyAgentWindowsJob {
  [StructLayout(LayoutKind.Sequential)]
  public struct BasicLimits {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct IoCounters {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct ExtendedLimits {
    public BasicLimits BasicLimitInformation;
    public IoCounters IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct SecurityAttributes {
    public int Length;
    public IntPtr SecurityDescriptor;
    [MarshalAs(UnmanagedType.Bool)]
    public bool InheritHandle;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct StartupInfo {
    public int Size;
    public string Reserved;
    public string Desktop;
    public string Title;
    public int X;
    public int Y;
    public int XSize;
    public int YSize;
    public int XCountChars;
    public int YCountChars;
    public int FillAttribute;
    public int Flags;
    public short ShowWindow;
    public short ReservedBytes;
    public IntPtr ReservedPointer;
    public IntPtr StandardInput;
    public IntPtr StandardOutput;
    public IntPtr StandardError;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct ProcessInformation {
    public IntPtr Process;
    public IntPtr Thread;
    public uint ProcessId;
    public uint ThreadId;
  }

  public sealed class SuspendedProcess : IDisposable {
    private IntPtr process;
    private IntPtr thread;

    public SuspendedProcess(
      IntPtr process,
      IntPtr thread,
      IntPtr standardOutput,
      IntPtr standardError
    ) {
      this.process = process;
      this.thread = thread;
      StandardOutput = new FileStream(
        new SafeFileHandle(standardOutput, true),
        FileAccess.Read,
        4096,
        false
      );
      StandardError = new FileStream(
        new SafeFileHandle(standardError, true),
        FileAccess.Read,
        4096,
        false
      );
    }

    public Stream StandardOutput { get; private set; }
    public Stream StandardError { get; private set; }

    public void Resume() {
      if (ResumeThread(thread) == UInt32.MaxValue) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "process_resume_failed");
      }
      CloseHandle(thread);
      thread = IntPtr.Zero;
    }

    public void WaitForExit() {
      if (WaitForSingleObject(process, UInt32.MaxValue) != 0) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "process_wait_failed");
      }
    }

    public int ExitCode {
      get {
        uint exitCode;
        if (!GetExitCodeProcess(process, out exitCode)) {
          throw new Win32Exception(Marshal.GetLastWin32Error(), "process_exit_code_failed");
        }
        return unchecked((int)exitCode);
      }
    }

    public void Dispose() {
      StandardOutput.Dispose();
      StandardError.Dispose();
      if (thread != IntPtr.Zero) {
        CloseHandle(thread);
        thread = IntPtr.Zero;
      }
      if (process != IntPtr.Zero) {
        CloseHandle(process);
        process = IntPtr.Zero;
      }
    }
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr CreateJobObject(IntPtr attributes, string name);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool SetInformationJobObject(
    IntPtr job,
    int informationClass,
    ref ExtendedLimits information,
    uint informationLength
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr handle);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CreatePipe(
    out IntPtr readPipe,
    out IntPtr writePipe,
    ref SecurityAttributes attributes,
    int size
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetHandleInformation(
    IntPtr handle,
    uint mask,
    uint flags
  );

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  private static extern bool CreateProcessW(
    string applicationName,
    StringBuilder commandLine,
    IntPtr processAttributes,
    IntPtr threadAttributes,
    [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
    uint creationFlags,
    IntPtr environment,
    string currentDirectory,
    ref StartupInfo startupInfo,
    out ProcessInformation processInformation
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern uint ResumeThread(IntPtr thread);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool TerminateProcess(IntPtr process, uint exitCode);

  public static SuspendedProcess CreateSuspendedProcess(
    string program,
    string[] arguments,
    string currentDirectory,
    string[] environment,
    IntPtr job
  ) {
    const uint HandleFlagInherit = 0x1;
    const int StartfUseStdHandles = 0x100;
    const uint CreateSuspended = 0x4;
    const uint CreateUnicodeEnvironment = 0x400;
    const uint CreateNoWindow = 0x08000000;
    IntPtr standardInputRead = IntPtr.Zero;
    IntPtr standardInputWrite = IntPtr.Zero;
    IntPtr standardOutputRead = IntPtr.Zero;
    IntPtr standardOutputWrite = IntPtr.Zero;
    IntPtr standardErrorRead = IntPtr.Zero;
    IntPtr standardErrorWrite = IntPtr.Zero;
    ProcessInformation information = new ProcessInformation();
    GCHandle environmentHandle = new GCHandle();
    try {
      SecurityAttributes attributes = new SecurityAttributes();
      attributes.Length = Marshal.SizeOf(attributes);
      attributes.InheritHandle = true;
      if (!CreatePipe(out standardInputRead, out standardInputWrite, ref attributes, 0) ||
          !CreatePipe(out standardOutputRead, out standardOutputWrite, ref attributes, 0) ||
          !CreatePipe(out standardErrorRead, out standardErrorWrite, ref attributes, 0)) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "process_pipe_failed");
      }
      if (!SetHandleInformation(standardInputWrite, HandleFlagInherit, 0) ||
          !SetHandleInformation(standardOutputRead, HandleFlagInherit, 0) ||
          !SetHandleInformation(standardErrorRead, HandleFlagInherit, 0)) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "process_pipe_inherit_failed");
      }

      StartupInfo startup = new StartupInfo();
      startup.Size = Marshal.SizeOf(startup);
      startup.Flags = StartfUseStdHandles;
      startup.StandardInput = standardInputRead;
      startup.StandardOutput = standardOutputWrite;
      startup.StandardError = standardErrorWrite;
      StringBuilder commandLine = new StringBuilder(QuoteArgument(program));
      foreach (string argument in arguments) {
        commandLine.Append(' ');
        commandLine.Append(QuoteArgument(argument));
      }
      byte[] environmentBlock = BuildEnvironmentBlock(environment);
      environmentHandle = GCHandle.Alloc(environmentBlock, GCHandleType.Pinned);
      if (!CreateProcessW(
        program,
        commandLine,
        IntPtr.Zero,
        IntPtr.Zero,
        true,
        CreateSuspended | CreateUnicodeEnvironment | CreateNoWindow,
        environmentHandle.AddrOfPinnedObject(),
        currentDirectory,
        ref startup,
        out information
      )) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "process_create_failed");
      }

      CloseOwnedHandle(ref standardInputRead);
      CloseOwnedHandle(ref standardInputWrite);
      CloseOwnedHandle(ref standardOutputWrite);
      CloseOwnedHandle(ref standardErrorWrite);
      if (!AssignProcessToJobObject(job, information.Process)) {
        int error = Marshal.GetLastWin32Error();
        TerminateProcess(information.Process, 1);
        WaitForSingleObject(information.Process, UInt32.MaxValue);
        throw new Win32Exception(error, "job_assign_failed");
      }

      SuspendedProcess result = new SuspendedProcess(
        information.Process,
        information.Thread,
        standardOutputRead,
        standardErrorRead
      );
      information.Process = IntPtr.Zero;
      information.Thread = IntPtr.Zero;
      standardOutputRead = IntPtr.Zero;
      standardErrorRead = IntPtr.Zero;
      return result;
    } finally {
      if (environmentHandle.IsAllocated) environmentHandle.Free();
      if (information.Process != IntPtr.Zero) {
        TerminateProcess(information.Process, 1);
        WaitForSingleObject(information.Process, UInt32.MaxValue);
      }
      CloseOwnedHandle(ref information.Thread);
      CloseOwnedHandle(ref information.Process);
      CloseOwnedHandle(ref standardInputRead);
      CloseOwnedHandle(ref standardInputWrite);
      CloseOwnedHandle(ref standardOutputRead);
      CloseOwnedHandle(ref standardOutputWrite);
      CloseOwnedHandle(ref standardErrorRead);
      CloseOwnedHandle(ref standardErrorWrite);
    }
  }

  public static string QuoteArgument(string value) {
    if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) {
      return value;
    }
    var result = new StringBuilder(value.Length + 2);
    result.Append('"');
    var slashes = 0;
    foreach (var character in value) {
      if (character == '\\') {
        slashes += 1;
      } else if (character == '"') {
        result.Append('\\', slashes * 2 + 1);
        result.Append('"');
        slashes = 0;
      } else {
        result.Append('\\', slashes);
        result.Append(character);
        slashes = 0;
      }
    }
    result.Append('\\', slashes * 2);
    result.Append('"');
    return result.ToString();
  }

  private static byte[] BuildEnvironmentBlock(string[] values) {
    string[] ordered = (string[])values.Clone();
    Array.Sort(ordered, StringComparer.OrdinalIgnoreCase);
    return Encoding.Unicode.GetBytes(String.Join("\0", ordered) + "\0\0");
  }

  private static void CloseOwnedHandle(ref IntPtr handle) {
    if (handle != IntPtr.Zero) {
      CloseHandle(handle);
      handle = IntPtr.Zero;
    }
  }
}
'@

$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$job = [MyAgentWindowsJob]::CreateJobObject([IntPtr]::Zero, $null)
if ($job -eq [IntPtr]::Zero) {
  throw "job_create_failed:$([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
}

try {
  $limits = New-Object MyAgentWindowsJob+ExtendedLimits
  $basic = New-Object MyAgentWindowsJob+BasicLimits
  $basic.LimitFlags = 0x2000
  $limits.BasicLimitInformation = $basic
  if (-not [MyAgentWindowsJob]::SetInformationJobObject(
    $job,
    9,
    [ref] $limits,
    [Runtime.InteropServices.Marshal]::SizeOf($limits)
  )) {
    throw "job_limit_failed:$([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }

  $environment = @(
    $request.env.PSObject.Properties |
      ForEach-Object { [string] $_.Name + "=" + [string] $_.Value }
  )
  $process = [MyAgentWindowsJob]::CreateSuspendedProcess(
    [string] $request.program,
    [string[]] @($request.args),
    [string] $request.cwd,
    [string[]] $environment,
    $job
  )
  $stdout = $process.StandardOutput.CopyToAsync([Console]::OpenStandardOutput())
  $stderr = $process.StandardError.CopyToAsync([Console]::OpenStandardError())
  $process.Resume()
  $process.WaitForExit()
  $exitCode = $process.ExitCode
  $null = [MyAgentWindowsJob]::CloseHandle($job)
  $job = [IntPtr]::Zero
  [Threading.Tasks.Task]::WaitAll(@($stdout, $stderr))
  exit $exitCode
} finally {
  if ($null -ne $process) {
    $process.Dispose()
  }
  if ($job -ne [IntPtr]::Zero) {
    $null = [MyAgentWindowsJob]::CloseHandle($job)
  }
}
`, "utf16le")).toString("base64");

const WINDOWS_JOB_BOOTSTRAP = Buffer.from(String.raw`
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$compressed = [Convert]::FromBase64String($env:MYAGENT_WINDOWS_JOB_HOST)
$memory = New-Object IO.MemoryStream(,$compressed)
$gzip = New-Object IO.Compression.GzipStream(
  $memory,
  [IO.Compression.CompressionMode]::Decompress
)
$reader = New-Object IO.StreamReader($gzip, [Text.Encoding]::Unicode)
try {
  & ([ScriptBlock]::Create($reader.ReadToEnd()))
} finally {
  $reader.Dispose()
  $gzip.Dispose()
  $memory.Dispose()
}
`, "utf16le").toString("base64");
