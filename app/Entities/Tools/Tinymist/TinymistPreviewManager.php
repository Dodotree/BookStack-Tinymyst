<?php

namespace BookStack\Entities\Tools\Tinymist;

use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Facades\Process;
use Symfony\Component\Process\Process as SymfonyProcess;

class TinymistPreviewManager
{
    protected array $processes = [];
    protected array $lastActivity = [];

    /**
     * Start preview server for a specific page
     */
    public function startPreviewServer(int $pageId, string $typstFilePath): array
    {
        // Calculate ports based on page ID (2 ports per page to avoid conflicts)
        // Note: Control port is automatically set to data_port - 1 by tinymist
        // TODO: Obviously needs a better port management strategy
        $dataPort = config('tinymist.data_plane_base_port') + (2 * $pageId);
        $controlPort = $dataPort - 1; // Tinymist automatically uses data_port - 1 for control plane
        $host = config('tinymist.preview_host', '127.0.0.1');

        // Check if already running for THIS page
        if (isset($this->processes[$pageId]) && $this->isProcessRunning($pageId)) {
            Log::info("Preview server already running for page {$pageId}");
            return [
                'success' => true,
                'control_port' => $controlPort,
                'data_port' => $dataPort,
                'host' => $host,
                'status' => 'already_running',
            ];
        }

        // Ensure directory exists (file should be created by caller with actual content)
        $fullPath = storage_path("app/{$typstFilePath}");
        $directory = dirname($fullPath);

        if (!is_dir($directory)) {
            mkdir($directory, 0755, true);
        }

        // File should already exist with content from PageEditorData
        // If it doesn't exist, that's an error condition
        if (!file_exists($fullPath)) {
            throw new \RuntimeException("Typst file not found: {$fullPath}. File should be created before starting preview server.");
        }

        // Use relative path from base directory (tinymist works better with relative paths)
        $relativePath = "storage/app/{$typstFilePath}";
        $absolutePath = storage_path("app/{$typstFilePath}");

        // Get tinymist CLI path and normalize for Windows
        $tinymistPath = config('tinymist.tinymist_cli_path');

        // Format: --data-plane-host "127.0.0.1:PORT"
        $controlPlaneHost = "{$host}:{$controlPort}";
        $dataPlaneHost = "{$host}:{$dataPort}";

        try {
            // Create log file for process output
            $logFile = storage_path("logs/tinymist_preview_{$pageId}.log");

            if (DIRECTORY_SEPARATOR === '\\') {
                // Windows: Use proc_open directly to preserve environment
                $command = [
                    $tinymistPath,
                    'preview',
                    '--no-open',
                    '--control-plane-host', $controlPlaneHost,
                    '--data-plane-host', $dataPlaneHost,
                    '--partial-rendering', 'true',
                    $relativePath,
                ];

                $logHandle = fopen($logFile, 'w');
                $descriptors = [
                    0 => ['pipe', 'r'],  // stdin
                    1 => $logHandle,      // stdout -> log file
                    2 => $logHandle,      // stderr -> log file
                ];

                $proc = proc_open($command, $descriptors, $pipes, base_path(), null);

                if (is_resource($proc)) {
                    fclose($pipes[0]); // Close stdin pipe
                    // Don't wait - let it run in background
                    // Store proc resource for later cleanup
                    $this->processes[$pageId] = $proc;
                    $process = null; // No Symfony Process object
                } else {
                    fclose($logHandle);
                    throw new \RuntimeException('Failed to start tinymist process');
                }

                $tinymistCommand = implode(' ', $command);
            } else {
                // Unix: use nohup with log file
                $tinymistCommand = sprintf(
                    'nohup %s preview --no-open --control-plane-host "%s" --data-plane-host "%s" --partial-rendering true "%s" > %s 2>&1 &',
                    escapeshellarg($tinymistPath),
                    $controlPlaneHost,
                    $dataPlaneHost,
                    escapeshellarg($relativePath),
                    escapeshellarg($logFile)
                );

                $process = Process::path(base_path())->start($tinymistCommand);
                $this->processes[$pageId] = $process;
            }

            Log::info("Starting tinymist preview", [
                'command' => $tinymistCommand,
                'page_id' => $pageId,
                'working_dir' => base_path(),
                'log_file' => $logFile,
            ]);

            // Wait a moment for server to start
            usleep(500000); // 500ms

            $this->lastActivity[$pageId] = now();

            $processInfo = [
                'control_port' => $controlPort,
                'data_port' => $dataPort,
                'file' => $fullPath,
            ];

            if (DIRECTORY_SEPARATOR === '\\' && isset($proc)) {
                // Windows proc_open - check status
                $status = proc_get_status($proc);
                $processInfo['process_running'] = $status['running'];
                $processInfo['process_id'] = $status['pid'];
            } elseif ($process) {
                // Unix Symfony Process
                $processInfo['process_running'] = $process->isRunning();
                $processInfo['process_id'] = $process->getPid();
            }

            Log::info("Started preview server for page {$pageId}", $processInfo);

            return [
                'success' => true,
                'control_port' => $controlPort,
                'data_port' => $dataPort,
                'host' => $host,
                'status' => 'started',
            ];

        } catch (\Exception $e) {
            Log::error("Failed to start preview server for page {$pageId}", [
                'error' => $e->getMessage(),
            ]);

            return [
                'success' => false,
                'error' => $e->getMessage(),
            ];
        }
    }

    /**
     * Stop preview server for a specific page
     */
    public function stopPreviewServer(int $pageId): bool
    {
        if (!isset($this->processes[$pageId])) {
            return true; // Already stopped
        }

        try {
            $process = $this->processes[$pageId];

            if ($process->running()) {
                // On Windows, just kill the process (signals don't work the same way)
                if (DIRECTORY_SEPARATOR === '\\') {
                    $process->signal(9); // SIGKILL equivalent on Windows
                } else {
                    // Unix: try graceful shutdown first
                    $process->signal(15); // SIGTERM

                    // Wait for graceful shutdown
                    $timeout = 5;
                    while ($process->running() && $timeout > 0) {
                        usleep(100000); // 100ms
                        $timeout -= 0.1;
                    }

                    // Force kill if still running
                    if ($process->running()) {
                        $process->signal(9); // SIGKILL
                    }
                }
            }

            unset($this->processes[$pageId]);
            unset($this->lastActivity[$pageId]);

            Log::info("Stopped preview server for page {$pageId}");
            return true;

        } catch (\Exception $e) {
            Log::error("Failed to stop preview server for page {$pageId}", [
                'error' => $e->getMessage(),
            ]);
            return false;
        }
    }

    /**
     * Update activity timestamp (called on each WebSocket message)
     */
    public function updateActivity(int $pageId): void
    {
        if (isset($this->processes[$pageId])) {
            $this->lastActivity[$pageId] = now();
        }
    }

    /**
     * Clean up idle preview servers
     */
    public function cleanupIdleServers(): int
    {
        $timeout = config('tinymist.preview_idle_timeout', 30);
        $cleaned = 0;

        foreach ($this->lastActivity as $pageId => $lastActive) {
            if ($lastActive->diffInMinutes(now()) > $timeout) {
                $this->stopPreviewServer($pageId);
                $cleaned++;
            }
        }

        if ($cleaned > 0) {
            Log::info("Cleaned up {$cleaned} idle preview servers");
        }

        return $cleaned;
    }

    /**
     * Check if process is running
     */
    protected function isProcessRunning(int $pageId): bool
    {
        return isset($this->processes[$pageId]) &&
               $this->processes[$pageId]->running();
    }

    /**
     * Get active preview server info
     */
    public function getServerInfo(int $pageId): ?array
    {
        if (!$this->isProcessRunning($pageId)) {
            return null;
        }

        return [
            'control_port' => config('tinymist.control_plane_base_port') + (2 * $pageId),
            'data_port' => config('tinymist.data_plane_base_port') + (2 * $pageId) + 1,
            'host' => config('tinymist.preview_host'),
            'last_activity' => $this->lastActivity[$pageId] ?? null,
        ];
    }

    /**
     * Shutdown all preview servers (cleanup on application shutdown)
     */
    public function shutdownAll(): void
    {
        foreach (array_keys($this->processes) as $pageId) {
            $this->stopPreviewServer($pageId);
        }
        Log::info("Shut down all preview servers");
    }
}
