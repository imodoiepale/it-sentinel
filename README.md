# IT Sentinel

The Sentinel Global IT Operations Command Center: a live fleet dashboard,
telemetry from every Windows machine, brokered remote access where the
operator never sees a credential, and elevated PowerShell execution locked
behind a deny-list and hash-pinning.

Full documentation is in [`docs/`](./docs/README.md). Start with
[`docs/01-overview.md`](./docs/01-overview.md).

---

## Install on a branch laptop

**One command.** Open PowerShell on the laptop (Start, type `powershell`,
Enter) and paste:

```powershell
irm https://raw.githubusercontent.com/imodoiepale/it-sentinel/main/scripts/bootstrap.ps1 | iex
```

No git, no clone, no `cd`. It installs git if the machine does not have it
(one UAC prompt), clones this repo to `%USERPROFILE%\it-sentinel`, and hands
over to `scripts\install-sentinel-agent.ps1`, which shows a full disclosure of
what the agent collects and will not proceed until you type `INSTALL`. Safe to
run twice - a second run pulls instead of cloning.

To pass arguments (`iex` cannot take them), use this form - still one line:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/imodoiepale/it-sentinel/main/scripts/bootstrap.ps1))) -BranchSlug lagos -ControlPlaneUrl http://HUB_IP:8787
```

> **Two things must be true before that URL works.** `scripts/` has to be
> pushed to `main` - as of writing it is only on a feature branch - and this
> repo has to be readable by the laptop. It is **private** today, so an
> unauthenticated machine gets `remote: Repository not found`. Until both are
> fixed, use the USB fallback below.

### No GitHub? USB stick or network share

Copy the whole `it-sentinel` folder onto a USB stick or a share (skip
`node_modules`; the installer runs `pnpm install` itself), then on each laptop:

```powershell
powershell -ExecutionPolicy Bypass -File D:\it-sentinel\scripts\bootstrap.ps1
```

It notices it is already inside a checkout, skips the clone, and goes straight
to the installer. `-RepoUrl D:\it-sentinel` clones off the stick instead, if
you want each laptop to have its own copy.

Full instructions, flags, and the remaining fallbacks:
[`docs/15-hackathon-demo-runbook.md`](./docs/15-hackathon-demo-runbook.md)
section 1.
