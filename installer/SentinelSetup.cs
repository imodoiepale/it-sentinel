// IT Sentinel - double-clickable enrollment launcher.
//
// This is a THIN LAUNCHER, not a second installer. Everything it does could
// be done by pasting the one-liner from /enroll; the only thing it adds is
// that a teammate can double-click it. It picks a branch, downloads
// scripts/bootstrap.ps1 from the control plane, and runs it under
// powershell.exe. Every decision about the machine is still made by
// install-sentinel-agent.ps1, behind its disclosure screen and its typed
// INSTALL gate.
//
// It deliberately duplicates nothing from bootstrap.ps1. The moment this
// file starts making install decisions of its own there are two answers on
// one machine to "what does enrollment do", and the one that drifts is
// always the one nobody has to type INSTALL under.
//
// ---------------------------------------------------------------------
// LANGUAGE LEVEL
//
// Compiled by C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe, which
// is present on every Windows 10/11 machine and needs no SDK install. That
// compiler tops out at C# 5: no string interpolation, no null-conditional,
// no expression-bodied members, no `out var`. Keep it that way - the whole
// point of this file is that it builds on a laptop with nothing on it.
// ---------------------------------------------------------------------

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;

// Assembly metadata is not decoration. SmartScreen and several AV engines
// weigh "unsigned binary with a blank version resource that spawns
// PowerShell" considerably more heavily than the same binary carrying a real
// product name, company and description. csc turns these into the Win32
// VERSIONINFO resource, which is also the first thing a suspicious teammate
// looks at in the file's Properties > Details tab. It costs nothing.
[assembly: AssemblyTitle("IT Sentinel Setup")]
[assembly: AssemblyProduct("IT Sentinel")]
[assembly: AssemblyCompany("Sentinel Global")]
[assembly: AssemblyDescription("Enrolls this Windows machine into the IT Sentinel fleet.")]
[assembly: AssemblyCopyright("Sentinel Global")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]
[assembly: ComVisible(false)]

internal sealed class Branch
{
    public string Slug;
    public string Name;
    public string Region;
}

internal static class Program
{
    // Compile-time default, overridable with --url. Not a secret: it is the
    // same public hostname printed on the enrollment page and baked into
    // bootstrap.ps1. Nothing in this program is a credential.
    private const string DefaultControlPlaneUrl = "https://it-sentinel-control-plane.onrender.com";

    private const string SetupVersion = "1.0.0";

    // Short, because a cold free-tier dyno can take ~50s to wake and a
    // teammate staring at a frozen window will close it. Missing the branch
    // list is recoverable (FallbackBranches); a hang is not.
    private const int BranchTimeoutMs = 15000;

    // Longer: this one is the actual payload, and slow venue wifi is the
    // normal case rather than the exception.
    private const int ScriptTimeoutMs = 60000;

    /// <summary>
    /// Used when /v1/enroll/branches cannot be reached. A copy of
    /// ENROLLABLE_SLUGS in apps/control-plane/src/enroll/enroll.routes.ts,
    /// which is itself a copy of $Branches in
    /// scripts/install-sentinel-agent.ps1. All three trace back to
    /// packages/db/seed/003_bootstrap_demo.sql; if that seed changes, all
    /// three change. The live fetch is preferred precisely so this copy going
    /// stale costs nothing on a machine that is online.
    /// </summary>
    private static readonly Branch[] FallbackBranches = new Branch[]
    {
        NewBranch("nairobi-hq", "Nairobi HQ", "Africa"),
        NewBranch("lagos", "Lagos", "Africa"),
        NewBranch("dubai", "Dubai", "Middle East"),
        NewBranch("london", "London", "Europe"),
        NewBranch("singapore", "Singapore", "APAC"),
        NewBranch("sao-paulo", "Sao Paulo", "LATAM"),
        NewBranch("new-york", "New York", "Americas"),
    };

    /// <summary>
    /// What a branch slug is allowed to look like.
    ///
    /// The slug ends up as an argument on a powershell.exe command line. It
    /// is quoted when it gets there, but refusing anything that is not a
    /// plain lowercase slug removes the question entirely rather than
    /// answering it - and a slug can arrive from --branch on the command line
    /// or from a JSON body over the network, so "we control the source" is
    /// not quite true.
    /// </summary>
    private static readonly Regex SlugShape = new Regex("^[a-z0-9][a-z0-9-]{0,63}$");

    private static Branch NewBranch(string slug, string name, string region)
    {
        Branch b = new Branch();
        b.Slug = slug;
        b.Name = name;
        b.Region = region;
        return b;
    }

    // ------------------------------------------------------------ output ---
    // The same visual grammar as bootstrap.ps1, so the two halves of one
    // enrollment do not look like two different products.

    private static void Say(string text)
    {
        Console.WriteLine(text);
    }

    private static void Colour(ConsoleColor colour, string text)
    {
        ConsoleColor prev = Console.ForegroundColor;
        try
        {
            Console.ForegroundColor = colour;
            Console.WriteLine(text);
        }
        finally
        {
            try { Console.ForegroundColor = prev; } catch { }
        }
    }

    private static void Head(string text)
    {
        Console.WriteLine();
        Colour(ConsoleColor.Cyan, "== " + text + " " + new string('=', Math.Max(4, 68 - text.Length)));
    }

    private static void Ok(string text) { Colour(ConsoleColor.Green, "  [ ok ] " + text); }
    private static void Info(string text) { Say("  [ .. ] " + text); }
    private static void Warn(string text) { Colour(ConsoleColor.Yellow, "  [warn] " + text); }

    /// <summary>
    /// Every failure exit goes through here. A console window that closes the
    /// instant something goes wrong is indistinguishable from one that did
    /// nothing at all, so this always names the problem and always gives a
    /// next action; Main is what makes it wait.
    /// </summary>
    private static int Fail(string problem, string[] whatToDo)
    {
        Console.WriteLine();
        Colour(ConsoleColor.Red, "  [FAIL] " + problem);
        Console.WriteLine();
        Colour(ConsoleColor.Yellow, "  What to do:");
        for (int i = 0; i < whatToDo.Length; i++)
        {
            Colour(ConsoleColor.Yellow, "    " + whatToDo[i]);
        }
        Console.WriteLine();
        return 1;
    }

    private static void Pause(string prompt)
    {
        Console.WriteLine();
        Say(prompt);
        try
        {
            Console.ReadKey(true);
        }
        catch (InvalidOperationException)
        {
            // No console to read from - output piped, or launched by a tool
            // that detached stdin. Not worth failing over.
        }
        catch (IOException)
        {
        }
    }

    // ------------------------------------------------------------- entry ---

    private static int Main(string[] args)
    {
        Options opts;
        string parseError;
        if (!Options.TryParse(args, out opts, out parseError))
        {
            int bad = Fail(parseError, new string[]
            {
                "Run  SentinelSetup.exe --help  to see the accepted arguments.",
            });
            Pause("Press any key to close this window.");
            return bad;
        }

        if (opts.ShowHelp)
        {
            PrintHelp();
            return 0;
        }

        int code;
        try
        {
            code = Run(opts);
        }
        catch (Exception ex)
        {
            // A .NET stack trace on a teammate's laptop tells them nothing
            // they can act on. The exception message is kept because it is
            // often the only real clue - a proxy refusing CONNECT, a TLS
            // failure - but it is framed rather than thrown.
            code = Fail("IT Sentinel Setup hit an unexpected error: " + ex.Message, new string[]
            {
                "This is a fault in the setup program, not in your machine.",
                "You can still enroll without it. Open the console at",
                "  " + ConsoleUrlFor(opts.ControlPlaneUrl) + "/enroll",
                "and use the PowerShell command shown there.",
            });
        }

        if (!opts.NoPause)
        {
            Pause(code == 0
                ? "Press any key to close this window."
                : "Press any key to close this window. Nothing further will run.");
        }
        return code;
    }

    /// <summary>
    /// Best effort, and the messages that use it say so. The console is a
    /// separate deployment and this program has no way to discover its
    /// hostname; getting somebody to the right product beats saying nothing.
    /// </summary>
    private static string ConsoleUrlFor(string controlPlaneUrl)
    {
        if (controlPlaneUrl.IndexOf("-control-plane", StringComparison.OrdinalIgnoreCase) >= 0)
        {
            return controlPlaneUrl.Replace("-control-plane", "-web");
        }
        return "https://it-sentinel-web.onrender.com";
    }

    private static void PrintHelp()
    {
        Say("");
        Say("  IT SENTINEL - Setup " + SetupVersion);
        Say("  --------------------------");
        Say("");
        Say("  Enrolls this Windows machine into the IT Sentinel fleet. It downloads");
        Say("  scripts/bootstrap.ps1 from the control plane and runs it; the installer");
        Say("  that bootstrap hands over to shows a full disclosure and waits for you");
        Say("  to type INSTALL before anything on this machine changes.");
        Say("");
        Say("  Usage:  SentinelSetup.exe [options]");
        Say("");
        Say("    --url <https://host>   Control plane to enroll into.");
        Say("                           Default: " + DefaultControlPlaneUrl);
        Say("    --branch <slug>        Skip the branch menu (for example: lagos).");
        Say("    --dry-run              Show exactly what would happen, then stop.");
        Say("                           Downloads nothing, runs nothing, changes nothing.");
        Say("    --elevate              Ask for administrator up front. Not the default;");
        Say("                           see the note below.");
        Say("    --no-pause             Do not wait for a keypress before closing.");
        Say("    --help                 This text.");
        Say("");
        Say("  On administrator: this program deliberately runs UNELEVATED, exactly as");
        Say("  the documented one-liner does. bootstrap.ps1 elevates only the short");
        Say("  child process that installs git, and install-sentinel-agent.ps1 elevates");
        Say("  itself after its consent screen. Starting out elevated would put the");
        Say("  working copy in the administrator's profile rather than yours, which is");
        Say("  the wrong place for the scheduled task that starts the agent at sign-in.");
        Say("");
    }

    // -------------------------------------------------------------- flow ---

    private static int Run(Options opts)
    {
        Say("");
        Colour(ConsoleColor.White, "  IT SENTINEL - Setup " + SetupVersion);
        Colour(ConsoleColor.White, "  --------------------------");
        Say("  Machine      : " + Environment.MachineName);
        Say("  Signed in as : " + Environment.UserDomainName + "\\" + Environment.UserName);
        Say("  Control plane: " + opts.ControlPlaneUrl);
        Say("");
        Say("  What this does, in order:");
        Say("    1. asks which branch this laptop belongs to");
        Say("    2. downloads bootstrap.ps1 from the control plane above");
        Say("    3. runs it, which fetches the agent code and starts the real installer");
        Say("");
        Say("  That installer tells you exactly what it collects and what it changes,");
        Say("  and waits for you to type INSTALL before touching anything. Once this");
        Say("  machine is enrolled an operator will be able to view and control the");
        Say("  desktop. Do not enroll a personal laptop you would not want watched.");

        EnableModernTls();

        if (opts.Elevate && !IsElevated())
        {
            return Relaunch(opts);
        }

        // ----------------------------------------------------- 1. branch ---
        Head("BRANCH");

        List<Branch> branches = LoadBranches(opts.ControlPlaneUrl);

        string slug = opts.BranchSlug;
        if (slug != null)
        {
            Ok("Branch given on the command line: " + slug);
        }
        else if (opts.DryRun)
        {
            Info("No --branch given. You would be asked to pick one from the list above.");
        }
        else
        {
            slug = AskForBranch(branches);
            if (slug == null)
            {
                Say("");
                Info("No branch chosen. Nothing was downloaded and nothing has changed.");
                return 1;
            }
        }

        // ---------------------------------------------------- 2. confirm ---
        string scriptUrl = opts.ControlPlaneUrl + "/v1/enroll/bootstrap.ps1";
        string psExe = FindPowerShell();

        Head("WHAT WILL RUN");
        Say("  Download : " + scriptUrl);
        Say("  Run      : " + psExe);
        Say("  Arguments: -NoProfile -ExecutionPolicy Bypass -File <the downloaded script>");
        Say("             -BranchSlug " + (slug == null ? "<you would be asked>" : slug));
        Say("             -ControlPlaneUrl " + opts.ControlPlaneUrl);

        if (opts.DryRun)
        {
            Head("DRY RUN - STOPPING HERE");
            Ok("Nothing was downloaded, nothing was run, nothing on this machine changed.");
            Say("  Re-run without --dry-run to actually enroll this machine.");
            Say("");
            return 0;
        }

        // The same principle as the installer's typed INSTALL gate, and a
        // different word on purpose: somebody who has learned to type INSTALL
        // without reading should not be able to clear this one by reflex.
        Say("");
        Colour(ConsoleColor.Yellow, "  Type ENROLL to continue, or anything else to stop:");
        Console.Write("  > ");
        string answer = ReadLineSafe();
        if (answer == null || !answer.Trim().Equals("ENROLL", StringComparison.Ordinal))
        {
            Say("");
            Info("Stopped. Nothing was downloaded and nothing on this machine changed.");
            return 1;
        }

        // --------------------------------------------------- 3. download ---
        Head("DOWNLOAD");
        string body;
        try
        {
            Info("Fetching " + scriptUrl);
            body = HttpGetString(scriptUrl, ScriptTimeoutMs);
        }
        catch (Exception ex)
        {
            return Fail("Could not download bootstrap.ps1 from " + opts.ControlPlaneUrl, new string[]
            {
                ex.Message,
                "",
                "Check, in this order:",
                "  - is this laptop online? Open " + opts.ControlPlaneUrl + "/healthz in a browser.",
                "  - is that the right hub? Point at another one with:",
                "      SentinelSetup.exe --url https://your-hub.example.com",
                "  - a free-tier host can take ~50 seconds to wake from idle, so waiting",
                "    a minute and trying again is worth one attempt.",
            });
        }

        // A captive portal or an intercepting proxy answers 200 with a
        // sign-in page in the body. Handing that to PowerShell is the worst
        // outcome available here, so the content is checked and not just the
        // status code.
        if (body == null || body.IndexOf("IT Sentinel", StringComparison.Ordinal) < 0)
        {
            return Fail("The control plane returned something that is not the bootstrap script.", new string[]
            {
                "This usually means a captive portal or a proxy answered instead of the",
                "hub - a hotel or venue wifi sign-in page, typically.",
                "",
                "Open " + scriptUrl,
                "in a browser on this machine. If you see a sign-in page rather than",
                "PowerShell code, deal with that first and run this again.",
            });
        }

        string tempDir = Path.Combine(Path.GetTempPath(), "sentinel-setup-" + Guid.NewGuid().ToString("N"));
        string scriptPath = Path.Combine(tempDir, "bootstrap.ps1");
        try
        {
            Directory.CreateDirectory(tempDir);

            // Written by this process rather than downloaded by the shell, so
            // the file carries no mark-of-the-web Zone.Identifier stream and
            // PowerShell will not refuse it on a machine whose execution
            // policy is stricter than the one we pass.
            File.WriteAllText(scriptPath, body, new UTF8Encoding(false));
            Ok("Saved to " + scriptPath);

            // -------------------------------------------------- 4. hand off ---
            Head("HANDING OVER TO BOOTSTRAP.PS1");
            Say("  Everything below this line is bootstrap.ps1 and the installer it runs.");
            Say("");

            int rc = RunPowerShell(psExe, scriptPath, slug, opts.ControlPlaneUrl);

            Say("");
            if (rc == 0)
            {
                Head("DONE");
                Ok("Enrollment finished. This machine should appear in the Command Center");
                Say("         within a minute.");
            }
            else
            {
                Head("THE INSTALLER STOPPED");
                Warn("bootstrap.ps1 exited with code " + rc + ".");
                Say("  The reason is in its own output above - scroll up. This program only");
                Say("  downloaded and started it, so there is nothing more it can tell you.");
                Say("");
                Say("  Re-running is safe. If it is easier to debug by hand,");
                Say("  " + ConsoleUrlFor(opts.ControlPlaneUrl) + "/enroll");
                Say("  has the same thing as a command you can paste into PowerShell.");
            }
            return rc;
        }
        finally
        {
            try
            {
                if (Directory.Exists(tempDir)) { Directory.Delete(tempDir, true); }
            }
            catch
            {
                // A locked temp file is not worth a failure exit on a machine
                // that has just enrolled successfully. Windows clears %TEMP%.
            }
        }
    }

    // -------------------------------------------------------- elevation ---

    private static bool IsElevated()
    {
        try
        {
            WindowsIdentity id = WindowsIdentity.GetCurrent();
            return new WindowsPrincipal(id).IsInRole(WindowsBuiltInRole.Administrator);
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// Restarts this program elevated. Only reached with --elevate - see the
    /// note in PrintHelp for why that is opt-in rather than the default.
    /// </summary>
    private static int Relaunch(Options opts)
    {
        Head("ADMINISTRATOR");
        Say("  You passed --elevate, so this has to restart as administrator.");
        Say("  Windows will show a User Account Control prompt naming");
        Say("  SentinelSetup.exe. Nothing has run yet, and nothing will run if you");
        Say("  say No - this program simply stops.");
        Pause("  Press any key to bring up that prompt.");

        string exe = Assembly.GetExecutingAssembly().Location;
        if (string.IsNullOrEmpty(exe))
        {
            return Fail("Could not work out where this program is on disk, so it cannot restart itself.", new string[]
            {
                "Right-click SentinelSetup.exe and choose Run as administrator instead.",
            });
        }

        ProcessStartInfo psi = new ProcessStartInfo(exe, opts.ToCommandLineWithout("--elevate"));
        psi.UseShellExecute = true;
        psi.Verb = "runas";

        try
        {
            using (Process child = Process.Start(psi))
            {
                child.WaitForExit();
                // The elevated child gets its own console and has already
                // said everything there is to say, so this parent returns its
                // code and keeps quiet.
                return child.ExitCode;
            }
        }
        catch (Win32Exception ex)
        {
            // ERROR_CANCELLED - overwhelmingly the common case, and a choice
            // rather than a fault, so it gets no [FAIL] banner.
            if (ex.NativeErrorCode == 1223)
            {
                Say("");
                Info("You said No to the administrator prompt. Nothing has changed.");
                Say("         Run this again when you are ready, or drop --elevate: the normal");
                Say("         path does not need administrator up front.");
                return 1;
            }
            return Fail("Windows refused to restart this program as administrator: " + ex.Message, new string[]
            {
                "Right-click SentinelSetup.exe and choose Run as administrator instead.",
            });
        }
    }

    // --------------------------------------------------------- branches ---

    private static List<Branch> LoadBranches(string controlPlaneUrl)
    {
        List<Branch> branches = null;
        try
        {
            Info("Fetching the branch list from " + controlPlaneUrl + " ...");
            string json = HttpGetString(controlPlaneUrl + "/v1/enroll/branches", BranchTimeoutMs);
            branches = ParseBranches(json);
        }
        catch (Exception ex)
        {
            Warn("Could not reach the control plane for the branch list (" + ex.Message + ").");
        }

        if (branches == null || branches.Count == 0)
        {
            Warn("Using the list built into this program. It may be out of date.");
            branches = new List<Branch>(FallbackBranches);
        }
        else
        {
            Ok("Branch list is live from the control plane.");
        }

        Say("");
        for (int i = 0; i < branches.Count; i++)
        {
            Branch b = branches[i];
            string region = string.IsNullOrEmpty(b.Region) ? "" : "  (" + b.Region + ")";
            Say("    " + (i + 1).ToString().PadLeft(2) + ". " + b.Name.PadRight(14) + b.Slug + region);
        }
        return branches;
    }

    // Objects in this response never nest, so a non-greedy brace match is
    // enough to split them and there is no reason to carry a JSON parser into
    // a binary whose whole selling point is that it has no dependencies.
    // Anything that does not match cleanly falls back to FallbackBranches
    // rather than guessing, which is what lets this be this simple.
    private static readonly Regex ObjectShape = new Regex("\\{[^{}]*\\}");
    private static readonly Regex SlugField = new Regex("\"slug\"\\s*:\\s*\"([^\"]*)\"");
    private static readonly Regex NameField = new Regex("\"name\"\\s*:\\s*\"([^\"]*)\"");
    private static readonly Regex RegionField = new Regex("\"region\"\\s*:\\s*\"([^\"]*)\"");

    private static List<Branch> ParseBranches(string json)
    {
        List<Branch> result = new List<Branch>();
        if (json == null) { return result; }

        foreach (Match obj in ObjectShape.Matches(json))
        {
            Match slug = SlugField.Match(obj.Value);
            if (!slug.Success) { continue; }

            string value = slug.Groups[1].Value;
            // A slug the installer would reject, or one shaped like a command
            // line argument, is dropped rather than shown: offering it would
            // hand somebody a choice that cannot work.
            if (!SlugShape.IsMatch(value)) { continue; }

            Match name = NameField.Match(obj.Value);
            Match region = RegionField.Match(obj.Value);
            result.Add(NewBranch(
                value,
                name.Success ? name.Groups[1].Value : value,
                region.Success ? region.Groups[1].Value : null));
        }
        return result;
    }

    private static string AskForBranch(List<Branch> branches)
    {
        for (int attempt = 0; attempt < 3; attempt++)
        {
            Say("");
            Colour(ConsoleColor.Yellow,
                "  Which branch is this laptop? Enter a number 1-" + branches.Count + ", or press Enter to stop.");
            Console.Write("  > ");

            string line = ReadLineSafe();
            if (line == null) { return null; }
            line = line.Trim();
            if (line.Length == 0) { return null; }

            int choice;
            if (int.TryParse(line, out choice) && choice >= 1 && choice <= branches.Count)
            {
                Branch picked = branches[choice - 1];
                Ok("Enrolling into " + picked.Name + " (" + picked.Slug + ").");
                Say("         Pick the wrong one and this machine shows up in somebody else's");
                Say("         fleet. Re-running the installer changes it.");
                return picked.Slug;
            }

            Warn("'" + line + "' is not one of the numbers listed above.");
        }

        Warn("No valid choice after three attempts. Stopping.");
        return null;
    }

    private static string ReadLineSafe()
    {
        try
        {
            return Console.ReadLine();
        }
        catch (IOException)
        {
            return null;
        }
    }

    // ---------------------------------------------------------- network ---

    /// <summary>
    /// Windows PowerShell's problem is .NET's problem: a machine that has not
    /// been patched in a while still offers TLS 1.0 first, which every modern
    /// host refuses. 3072 and 12288 are Tls12 and Tls13, written as numbers
    /// because those enum members do not exist in the .NET 4.0 reference
    /// assemblies this compiles against even though the 4.8 runtime
    /// underneath understands them perfectly well.
    /// </summary>
    private static void EnableModernTls()
    {
        try
        {
            ServicePointManager.SecurityProtocol =
                ServicePointManager.SecurityProtocol | (SecurityProtocolType)3072 | (SecurityProtocolType)12288;
            return;
        }
        catch (NotSupportedException)
        {
            // An older runtime that does not know TLS 1.3.
        }
        catch
        {
            return;
        }

        try
        {
            ServicePointManager.SecurityProtocol =
                ServicePointManager.SecurityProtocol | (SecurityProtocolType)3072;
        }
        catch { }
    }

    private static string HttpGetString(string url, int timeoutMs)
    {
        HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
        request.Method = "GET";
        request.Timeout = timeoutMs;
        request.ReadWriteTimeout = timeoutMs;
        request.UserAgent = "SentinelSetup/" + SetupVersion;

        // Corporate networks put an authenticating proxy in the way far more
        // often than they block outright, and this is what makes that work
        // without anybody having to type proxy settings into this program.
        request.Proxy = WebRequest.GetSystemWebProxy();
        request.Proxy.Credentials = CredentialCache.DefaultCredentials;

        using (WebResponse response = request.GetResponse())
        using (Stream stream = response.GetResponseStream())
        using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
        {
            return reader.ReadToEnd();
        }
    }

    // --------------------------------------------------------- handover ---

    private static string FindPowerShell()
    {
        // The absolute path, not the bare name: PATH on a machine we have
        // never seen is not something to bet an install on, and a
        // powershell.exe planted earlier on PATH than the real one is an old
        // and effective trick.
        string system = Environment.GetFolderPath(Environment.SpecialFolder.System);
        string candidate = Path.Combine(system, "WindowsPowerShell\\v1.0\\powershell.exe");
        if (File.Exists(candidate)) { return candidate; }
        return "powershell.exe";
    }

    private static int RunPowerShell(string psExe, string scriptPath, string slug, string controlPlaneUrl)
    {
        StringBuilder args = new StringBuilder();
        args.Append("-NoProfile -ExecutionPolicy Bypass -File ");
        args.Append(Quote(scriptPath));
        if (slug != null)
        {
            args.Append(" -BranchSlug ");
            args.Append(Quote(slug));
        }
        args.Append(" -ControlPlaneUrl ");
        args.Append(Quote(controlPlaneUrl));

        ProcessStartInfo psi = new ProcessStartInfo(psExe, args.ToString());
        // Not redirected, on purpose. The installer is a long interactive
        // conversation - a disclosure screen, a typed INSTALL, a prompt for a
        // VNC password - and pumping that through redirected pipes is how you
        // get a program that looks hung while it waits for input nobody can
        // see. Sharing this console is both simpler and correct.
        psi.UseShellExecute = false;
        psi.WorkingDirectory = Path.GetDirectoryName(scriptPath);

        using (Process child = Process.Start(psi))
        {
            child.WaitForExit();
            return child.ExitCode;
        }
    }

    /// <summary>
    /// Windows command-line quoting, which is not shell quoting: a run of
    /// backslashes immediately before the closing quote has to be doubled or
    /// it escapes that quote instead, and a temp path ending in a backslash
    /// is exactly how that bug gets found in production. Everything passed
    /// through here has already been shape-checked, so this is the belt to
    /// that pair of braces rather than the only defence.
    /// </summary>
    private static string Quote(string value)
    {
        StringBuilder sb = new StringBuilder();
        sb.Append('"');
        int backslashes = 0;
        for (int i = 0; i < value.Length; i++)
        {
            char c = value[i];
            if (c == '\\')
            {
                backslashes++;
                continue;
            }
            if (c == '"')
            {
                sb.Append('\\', backslashes * 2 + 1);
                backslashes = 0;
                sb.Append('"');
                continue;
            }
            sb.Append('\\', backslashes);
            backslashes = 0;
            sb.Append(c);
        }
        sb.Append('\\', backslashes * 2);
        sb.Append('"');
        return sb.ToString();
    }

    // -------------------------------------------------------------- args ---

    private sealed class Options
    {
        public string ControlPlaneUrl = DefaultControlPlaneUrl;
        public string BranchSlug;
        public bool DryRun;
        public bool Elevate;
        public bool NoPause;
        public bool ShowHelp;

        public static bool TryParse(string[] args, out Options opts, out string error)
        {
            opts = new Options();
            error = null;

            for (int i = 0; i < args.Length; i++)
            {
                string arg = args[i];
                switch (arg.ToLowerInvariant())
                {
                    case "--help":
                    case "-h":
                    case "-?":
                    case "/?":
                        opts.ShowHelp = true;
                        return true;

                    case "--dry-run":
                        opts.DryRun = true;
                        break;

                    case "--elevate":
                        opts.Elevate = true;
                        break;

                    case "--no-pause":
                        opts.NoPause = true;
                        break;

                    case "--url":
                        if (i + 1 >= args.Length)
                        {
                            error = "--url needs a value, for example --url https://hub.example.com";
                            return false;
                        }
                        string url = args[++i].TrimEnd('/');
                        if (!IsUsableUrl(url))
                        {
                            error = "'" + url + "' is not a usable control plane URL. It has to be an "
                                  + "http:// or https:// address with no spaces or quotes in it.";
                            return false;
                        }
                        opts.ControlPlaneUrl = url;
                        break;

                    case "--branch":
                        if (i + 1 >= args.Length)
                        {
                            error = "--branch needs a value, for example --branch lagos";
                            return false;
                        }
                        string slug = args[++i];
                        if (!SlugShape.IsMatch(slug))
                        {
                            error = "'" + slug + "' is not a branch slug. Slugs are lowercase letters, "
                                  + "digits and hyphens, like lagos or nairobi-hq.";
                            return false;
                        }
                        opts.BranchSlug = slug;
                        break;

                    default:
                        error = "Do not recognise the argument '" + arg + "'.";
                        return false;
                }
            }
            return true;
        }

        /// <summary>
        /// The URL is concatenated into request URIs and then quoted onto a
        /// PowerShell command line, so its shape is checked here once rather
        /// than trusted at either of those two places.
        /// </summary>
        private static bool IsUsableUrl(string value)
        {
            Uri parsed;
            if (!Uri.TryCreate(value, UriKind.Absolute, out parsed)) { return false; }
            if (parsed.Scheme != Uri.UriSchemeHttp && parsed.Scheme != Uri.UriSchemeHttps) { return false; }
            char[] refused = new char[] { '"', '\'', ' ', '\t', '\r', '\n', '`', '&', '|', ';', '$', '<', '>', '^', '%' };
            return value.IndexOfAny(refused) < 0;
        }

        /// <summary>Rebuilds the command line for the elevated relaunch.</summary>
        public string ToCommandLineWithout(string drop)
        {
            List<string> parts = new List<string>();
            if (ControlPlaneUrl != DefaultControlPlaneUrl) { parts.Add("--url"); parts.Add(ControlPlaneUrl); }
            if (BranchSlug != null) { parts.Add("--branch"); parts.Add(BranchSlug); }
            if (DryRun) { parts.Add("--dry-run"); }
            if (NoPause) { parts.Add("--no-pause"); }
            if (Elevate && drop != "--elevate") { parts.Add("--elevate"); }

            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < parts.Count; i++)
            {
                if (i > 0) { sb.Append(' '); }
                sb.Append(Program.Quote(parts[i]));
            }
            return sb.ToString();
        }
    }
}
