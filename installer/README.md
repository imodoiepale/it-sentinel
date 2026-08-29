# installer/ — double-clickable enrollment

Two launchers that do what the one-liner on `/enroll` does, for people who
would rather double-click a file than paste a command into PowerShell.

| File | What it is | Needs building? |
|---|---|---|
| `SentinelSetup.cmd` | Batch launcher. Plain text, readable in Notepad. | No |
| `SentinelSetup.cs` → `dist/SentinelSetup.exe` | C# console app with a numbered branch menu. | Yes — `build.ps1` |

**Neither is an installer.** Both download `scripts/bootstrap.ps1` from the
control plane and run it under `powershell.exe`. Every decision about the
machine is still made by `scripts/install-sentinel-agent.ps1`, behind its
disclosure screen and its typed `INSTALL` gate. That is deliberate: the moment
a launcher starts making install decisions of its own there are two answers on
one machine to "what does enrollment do", and the one that drifts is always
the one nobody has to type `INSTALL` under.

---

## Which one to actually use

**Use `SentinelSetup.cmd`.** For nearly every team it is the better artifact,
and the honest recommendation is not the compiled one.

**Use the one-liner** — `irm …/v1/enroll/bootstrap.ps1 | iex` — if the person
at the laptop is comfortable with PowerShell. It is still the shortest path
with the fewest things that can go wrong, and it is what everything else in
this repo documents.

**Use `SentinelSetup.exe`** only when you specifically want the numbered
branch menu, and you have warned the recipient about SmartScreen first.

### Why the .cmd wins

| | `.cmd` | `.exe` |
|---|---|---|
| Double-clickable | yes | yes |
| Readable before running | yes — it is text | no — it is a binary |
| SmartScreen | one "Run anyway" on the Open File dialog | full-screen blue panel, two clicks, `More info` hidden |
| Defender quarantine risk | low | real, and unfixable without a certificate |
| Branch menu | no (branch is a command-line argument, or the installer asks) | yes, fetched live |
| Build step | none | `csc.exe` on Windows |
| Exists in production | yes, it is committed | usually no — see below |

The one thing the `.exe` genuinely adds is the branch menu. That is worth
something at a demo table with seven branches on a slide. It is not worth
enough to make it the default.

---

## The SmartScreen reality, in detail

`SentinelSetup.exe` is **not code signed**, because signing needs an
Authenticode certificate nobody on this project has. An unsigned binary that
arrives through a browser and then spawns PowerShell is close to the textbook
description of a dropper, and Windows treats it accordingly.

**What a teammate actually sees**, after downloading it in Edge or Chrome and
double-clicking:

1. The browser may flag the download itself first — Chrome shows
   *"SentinelSetup.exe is not commonly downloaded and may be dangerous"* with
   a **Keep** / **Discard** choice hidden behind the `⋮` menu on the download
   chip. They must choose **Keep**.
2. On double-click, a **full-screen blue panel**: *"Windows protected your
   PC — Microsoft Defender SmartScreen prevented an unrecognised app from
   starting. Running this app might put your PC at risk."* Underneath is a
   single button: **Don't run**.
3. The way forward is a small underlined link, **More info**, above that
   button. It is easy to miss and it is meant to be. Clicking it expands two
   lines — `App: SentinelSetup.exe`, `Publisher: Unknown publisher` — and
   reveals a second button, **Run anyway**.
4. Only then does the console window open.

There is a fifth possibility, and it has no click-path: some Defender and
most third-party AV configurations will **quarantine the file outright** on
download, or kill the process when it calls `Process.Start` on
`powershell.exe`. When that happens the file simply vanishes from Downloads
and nothing you click will bring it back. That is not a bug to be fixed; it is
the correct behaviour of a machine you do not administer.

**Be straight with people about this.** The `.exe` was built to make
enrollment feel friendlier. On a locked-down laptop it does the opposite: it
turns a ten-second paste into a security scare with a teammate wondering
whether IT just tried to install malware on their machine. The `/enroll` page
carries this warning next to the download for exactly that reason.

### What we did do about it

Nothing that substitutes for a certificate, but the cheap things are worth
doing and they are all in `SentinelSetup.cs`:

- **Real assembly metadata** — `AssemblyTitle`, `AssemblyProduct`,
  `AssemblyCompany`, `AssemblyDescription`, `AssemblyVersion`. csc turns these
  into the Win32 `VERSIONINFO` resource. A binary with a blank version
  resource scores measurably worse in SmartScreen's heuristics than one with
  a real product name, and it is also the first thing a suspicious teammate
  checks in **Properties → Details**. Verify with:
  ```powershell
  (Get-Item installer\dist\SentinelSetup.exe).VersionInfo | Format-List *
  ```
- **A console app, not WinForms.** It cannot silently do nothing, and
  everything it is about to do is on screen before it does it.
- **No obfuscation, no packing, no self-extraction.** Every one of those is an
  AV heuristic trigger, and each would make the binary less inspectable for
  no gain.

The actual fix is an Authenticode certificate (an OV cert builds reputation
over time; an EV cert bypasses SmartScreen immediately). Until then, the
`.cmd` is the answer.

---

## Building the exe

```powershell
powershell -ExecutionPolicy Bypass -File installer\build.ps1
```

Output: `installer\dist\SentinelSetup.exe`, with its SHA-256 printed.

No SDK, no NuGet, no MSBuild. `build.ps1` finds the C# compiler that ships
inside the .NET Framework —
`%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe` — which is present on
every Windows 10 and 11 machine. It also checks `Framework\` (32-bit Windows)
and a `dotnet` SDK's Roslyn, in that order, so it does not fail on the first
miss where a later candidate would have worked.

That compiler tops out at **C# 5**. No string interpolation, no
null-conditional operators, no expression-bodied members, no `out var`. Keep
`SentinelSetup.cs` inside that dialect — the whole point of this arrangement
is that it builds on a laptop with nothing installed on it.

Check the result without installing anything:

```powershell
installer\dist\SentinelSetup.exe --dry-run --no-pause
```

`--dry-run` fetches the live branch list, prints the exact command line it
would run, and stops. It downloads no script, starts no process and changes
nothing.

---

## Why the .exe is not in git

`installer/dist/` is covered by the repo's existing `.gitignore` (`dist/`),
and that is the intended state rather than an oversight.

The tension is real and worth stating: **the control plane serves these files
from its own checkout on Render, so an artifact that is not in the repo does
not exist in production.** Three ways out, and why this one:

1. **Commit the binary.** Rejected. Render builds on Linux, where there is no
   `csc.exe`, so a committed `.exe` could never be rebuilt or verified at
   deploy time — it would be an opaque blob that nobody in CI can reproduce
   from the source sitting next to it, kept in git forever, that launches
   PowerShell. That is precisely the artifact a security review should object
   to, and we would be asking teammates to trust it while telling them in the
   same breath that we cannot sign it.
2. **Have the route build it.** Not possible. No C# compiler on the Render
   image, and adding one to serve a 28 KB convenience wrapper is absurd.
3. **Serve it when present, and say so plainly when it is not.** Chosen.

So `GET /v1/enroll/installer/SentinelSetup.exe` returns **`503
installer_unavailable`** on the hosted deployment, with a message naming the
two things that do work:

```json
{
  "error": "installer_unavailable",
  "message": "SentinelSetup.exe is not available from this control plane. Use …/SentinelSetup.cmd …",
  "alternatives": {
    "cmd": "https://…/v1/enroll/installer/SentinelSetup.cmd",
    "oneLiner": "irm https://…/v1/enroll/bootstrap.ps1 | iex"
  }
}
```

**Nobody hits that 503 through the console.** `GET /v1/enroll` reports an
`available` flag per launcher, and `/enroll` renders each download button only
when the hub says it has the file. On Render the page shows the `.cmd` and no
`.exe` button; on a Windows-hosted hub where somebody has run `build.ps1`, it
shows both. The 503 exists for whoever hits the URL directly, and it is
written so that person is never left at a dead end.

The `.exe` is therefore an **opt-in artifact**: build it, and it is served by
whatever control plane is running out of that checkout — a laptop during
development, or a Windows on-prem hub. The download button that ships to
production is the `.cmd`, which is committed and always served.

If you decide the demo needs the `.exe` on the hosted hub badly enough, the
change is one line in `.gitignore` (`!installer/dist/SentinelSetup.exe`) plus
a commit of the binary. Do it knowingly, re-commit it whenever
`SentinelSetup.cs` changes, and put the SHA-256 in the commit message.

---

## The routes

| Route | Returns |
|---|---|
| `GET /v1/enroll/installer/SentinelSetup.cmd` | the batch launcher, `Content-Disposition: attachment` |
| `GET /v1/enroll/installer/SentinelSetup.exe` | the binary, or `503` (above) |
| `GET /v1/enroll` | includes `installers[]` with an `available` flag each |

Both are served through the same allowlist discipline as the `.ps1` routes:
the `:file` parameter is a `Map` key, and the matched **constant** is what
gets joined onto the path, so no caller-supplied string reaches the
filesystem. `apps/control-plane/test/enroll.routes.test.ts` exercises thirteen
traversal shapes against this route specifically, plus the case that matters
most — that `/v1/enroll/installer/bootstrap.ps1` is a 404, so the two
allowlists cannot quietly merge into one servable directory.

The `.cmd` is **re-line-ended to CRLF on the way out**. This is not
cosmetic: `cmd.exe` mis-parses `goto` labels and parenthesised blocks in a
file with bare LF endings, and `SentinelSetup.cmd` uses both. Render checks
out on Linux, where git may normalise the working tree to LF, so what is on
disk at serve time is not something the route can assume.

---

## Files

| File | |
|---|---|
| `SentinelSetup.cs` | the launcher. C# 5 dialect — read the header comment before editing. |
| `build.ps1` | finds a compiler, builds to `dist/`, prints path and SHA-256. Pure ASCII, no BOM, PS 5.1 + 7. |
| `SentinelSetup.cmd` | the no-compilation launcher. Pure ASCII, CRLF. |
| `dist/` | build output. Gitignored. |

Both `build.ps1` and `SentinelSetup.cmd` are **pure ASCII with no BOM**, and
must stay that way. Windows PowerShell 5.1 reads a BOM-less `.ps1` as ANSI, so
a UTF-8 en-dash or a typographic quote arrives as two garbage bytes and the
parser treats one of them as a string delimiter — that has broken scripts in
this repo twice. `cmd.exe` renders the `.cmd` in the console's OEM code page,
where the same characters become mojibake on any machine with a different
regional setting. There is a test asserting the `.cmd` is ASCII at the route.

---

## See also

- [`docs/19-enrollment.md`](../docs/19-enrollment.md) — enrollment end to end
- [`scripts/bootstrap.ps1`](../scripts/bootstrap.ps1) — what both launchers run
- [`apps/control-plane/src/enroll/enroll.routes.ts`](../apps/control-plane/src/enroll/enroll.routes.ts)
