// Worker Service skeleton — NEVER COMPILED, .NET SDK not present in this
// environment. Written from scratch against packages/contracts' wire
// shape, not copied from any existing agent implementation.

using System.Management;
using System.Net.Http.Json;
using System.Text.Json;

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddHostedService<HeartbeatWorker>();
builder.Services.AddHttpClient();

var host = builder.Build();
host.Run();

public class HeartbeatWorker(IHttpClientFactory httpClientFactory, ILogger<HeartbeatWorker> logger) : BackgroundService
{
    private readonly string _controlPlaneUrl = Environment.GetEnvironmentVariable("CONTROL_PLANE_URL") ?? "http://localhost:8787";
    private readonly string _branchSlug = Environment.GetEnvironmentVariable("SENTINEL_BRANCH_SLUG")
        ?? throw new InvalidOperationException("SENTINEL_BRANCH_SLUG is required");
    private readonly string _branchName = Environment.GetEnvironmentVariable("SENTINEL_BRANCH_NAME")
        ?? throw new InvalidOperationException("SENTINEL_BRANCH_NAME is required");

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var client = httpClientFactory.CreateClient();
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var heartbeat = CollectHeartbeat();
                var response = await client.PostAsJsonAsync($"{_controlPlaneUrl}/v1/heartbeat", heartbeat, stoppingToken);
                if (!response.IsSuccessStatusCode)
                {
                    logger.LogError("Heartbeat rejected: {Status}", response.StatusCode);
                }
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Heartbeat collection or send failed");
            }

            await Task.Delay(TimeSpan.FromSeconds(60), stoppingToken);
        }
    }

    /// <summary>
    /// TODO: native CIM/WMI collection via System.Management — the whole
    /// point of this agent versus agent-node's PowerShell shell-out. Every
    /// field here must match packages/contracts/src/heartbeat.ts exactly;
    /// that file is the source of truth, not this stub.
    /// </summary>
    private object CollectHeartbeat()
    {
        using var searcher = new ManagementObjectSearcher("SELECT * FROM Win32_OperatingSystem");
        var os = searcher.Get().Cast<ManagementObject>().First();

        return new
        {
            schemaVersion = 1,
            collector = "agent-dotnet",
            collectedAt = DateTime.UtcNow.ToString("o"),
            branch = _branchName,
            hostname = Environment.MachineName,
            online = true,
            ramUsage = 0, // TODO: compute from Win32_OperatingSystem FreePhysicalMemory/TotalVisibleMemorySize
            diskFreePercent = 0, // TODO: Win32_LogicalDisk
            printer = "unknown",
            email = "unknown",
            endpointSecurity = "unknown",
            tightvnc = "not_installed",
            enquest = "unknown",
            lastSeen = DateTime.UtcNow.ToString("o"),
            machine = new { hostname = Environment.MachineName, branchSlug = _branchSlug, ip = "0.0.0.0", assetType = "workstation" },
            // TODO: cpu, ram, storage, windows, network, tightVncDetail, security,
            // printers, emailDetail, enquestDetail, services, applications,
            // updates, recentEvents, user — all required by HeartbeatPayload.
        };
    }
}
