import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";

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
      WINDOWS_JOB_HOST,
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
  return environment;
}

const WINDOWS_JOB_HOST = Buffer.from(String.raw`
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;

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

  [DllImport("kernel32.dll")]
  public static extern bool CloseHandle(IntPtr handle);

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

  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = [string] $request.program
  $start.WorkingDirectory = [string] $request.cwd
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.Arguments = [string]::Join(" ", @(
    $request.args | ForEach-Object { [MyAgentWindowsJob]::QuoteArgument([string] $_) }
  ))
  $start.EnvironmentVariables.Clear()
  foreach ($property in $request.env.PSObject.Properties) {
    $start.EnvironmentVariables[[string] $property.Name] = [string] $property.Value
  }

  $process = [Diagnostics.Process]::Start($start)
  if (-not [MyAgentWindowsJob]::AssignProcessToJobObject($job, $process.Handle)) {
    try { $process.Kill() } catch {}
    throw "job_assign_failed:$([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }
  $process.StandardInput.Close()
  $stdout = $process.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())
  $stderr = $process.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
  $process.WaitForExit()
  $exitCode = $process.ExitCode
  $null = [MyAgentWindowsJob]::CloseHandle($job)
  $job = [IntPtr]::Zero
  [Threading.Tasks.Task]::WaitAll(@($stdout, $stderr))
  exit $exitCode
} finally {
  if ($job -ne [IntPtr]::Zero) {
    $null = [MyAgentWindowsJob]::CloseHandle($job)
  }
}
`, "utf16le").toString("base64");
