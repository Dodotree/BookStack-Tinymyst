<?php

namespace BookStack\Entities\Tools\Tinymist;

use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Facades\Process;
use Symfony\Component\Process\Process as SymfonyProcess;
use BookStack\Entities\Models\Page;

class TinymistPreviewManager
{
    function generateTinymistWsToken(Page $page): ?array
    {
        $userId = auth()->id();
        $secret = config('tinymist.ws_token_secret', env('TINYMIST_WS_SECRET'));
        $ttl = (int) config('tinymist.ws_token_ttl', 900);
        $issuedAt = time();

        if (!$userId) {
            throw new \Exception('User not logged in');
        }

        if (!$secret) {
            throw new \Exception('WebSocket token secret not configured');
        }

        $payload = [
            'user_id' => (int)$userId,
            'page_id' => (int)$page->id,
            'iat' => $issuedAt,
            'exp' => $issuedAt + max($ttl, 60),
        ];

        return [
            'ws_token' => $this->encodeHs256Jwt($payload, $secret),
            'expires_at' => $payload['exp'],
        ];
    }

    protected function encodeHs256Jwt(array $payload, string $secret): ?string
    {
        $header = ['alg' => 'HS256', 'typ' => 'JWT'];
        $segments = [];

        foreach ([$header, $payload] as $part) {
            $json = json_encode($part, JSON_UNESCAPED_SLASHES);
            if ($json === false) {
                return null;
            }
            $segments[] = $this->base64UrlEncode($json);
        }

        $signingInput = implode('.', $segments);
        $signature = hash_hmac('sha256', $signingInput, $secret, true);
        $segments[] = $this->base64UrlEncode($signature);

        return implode('.', $segments);
    }

    protected function base64UrlEncode(string $data): string
    {
        $encoded = base64_encode($data);
        return rtrim(strtr($encoded, '+/', '-_'), '=');
    }

    /**
     * Check if process is actually running by PID
     */
    protected function isProcessRunningByPid(int $pid): bool
    {
        if (DIRECTORY_SEPARATOR === '\\') {
            // Windows: use tasklist
            $output = shell_exec("tasklist /FI \"PID eq {$pid}\" /NH 2>NUL");
            return $output && strpos($output, (string)$pid) !== false;
        } else {
            // Unix: check if process exists
            return file_exists("/proc/{$pid}");
        }
    }

    /**
     * Start preview server for a specific page
     */
    public function startPreviewServer(int $pageId, bool $restart = false, int $pid = 0): array
    {
        // TODO: if the process is actually lost connection, restart it anyway
        if ($restart) {
            $this->stopPreviewServer($pid);
        }

        // Find available ports
        $basePort = config('tinymist.data_plane_base_port');
        $ports = $this->findAvailablePorts($basePort);

        if (!$ports) {
            throw new \RuntimeException("'Could not find available ports for preview server'");
        }

        $controlPort = $ports['control_port'];
        $dataPort = $ports['data_port'];

        $host = config('tinymist.preview_host', '127.0.0.1');

        // Check if already running for THIS page (check cache for persistent data)
        if (!$restart && $pid && $this->isProcessRunningByPid($pid)) {
            Log::info("Preview server already running for page {$pageId}", ['pid' => $pid]);
            return [
                'success' => true,
                'status' => 'already_running',
            ];
        }

        // Ensure directory exists (file should be created by caller with actual content)
        $fullPath = storage_path("app/tinymist/page_{$pageId}.typ");

        // Use relative path from base directory (tinymist works better with relative paths)
        $relativePath = "storage/app/tinymist/page_{$pageId}.typ";

        // File should already exist with content from PageEditorData
        // If it doesn't exist, that's an error condition
        if (!file_exists($fullPath)) {
            throw new \RuntimeException("Typst file not found: {$fullPath}. File should be created before starting preview server.");
        }

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
                // other working option "--preview-mode=slide"
                $command = [
                    $tinymistPath,
                    'preview',
                    '--no-open',
                    '--control-plane-host',
                    $controlPlaneHost,
                    '--data-plane-host',
                    $dataPlaneHost,
                    '--partial-rendering',
                    'true',
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
                } else {
                    fclose($logHandle);
                    throw new \RuntimeException('Failed to start tinymist process');
                }

                $tinymistCommand = implode(' ', $command);
            } else {
                // Unix: use nohup with log file
                $tinymistCommand = sprintf(
                    'nohup %s preview --no-open --control-plane-host "%s" --data-plane-host "%s" --partial-rendering true %s > %s 2>&1 &',
                    escapeshellarg($tinymistPath),
                    $controlPlaneHost,
                    $dataPlaneHost,
                    escapeshellarg($relativePath),
                    escapeshellarg($logFile)
                );

                /** @var \Illuminate\Process\InvokedProcess $process */
                $process = Process::path(base_path())->start($tinymistCommand);
            }

            $processInfo = [
                'control_port' => $controlPort,
                'data_port' => $dataPort,
                'file' => $fullPath,
                'started_at' => now()->toDateTimeString(),
            ];

            $pid = null;
            if (DIRECTORY_SEPARATOR === '\\' && isset($proc)) {
                // Windows proc_open - check status
                $status = proc_get_status($proc);
                $processInfo['process_running'] = $status['running'];
                $processInfo['pid'] = $status['pid'];
                $pid = $status['pid'];
            } elseif ($process) {
                // Unix Laravel InvokedProcess
                $processInfo['process_running'] = $process->running();
                $pid = $process->id();
                $processInfo['pid'] = $pid;
            }

            Log::info("Starting tinymist preview", [
                'command' => $tinymistCommand,
                'page_id' => $pageId,
                'working_dir' => base_path(),
                'log_file' => $logFile,
                'process_info' => $processInfo,
            ]);

            return [
                'success' => true,
                'control_port' => $controlPort,
                'data_port' => $dataPort,
                'host' => $host,
                'status' => 'started',
                'pid' => $pid,
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
    public function stopPreviewServer(int $pid): bool
    {
        try {
            // Kill process by PID
            if (DIRECTORY_SEPARATOR === '\\') {
                // Windows: use taskkill
                exec("taskkill /F /PID {$pid} 2>NUL", $output, $returnCode);
                $killed = ($returnCode === 0);
            } else {
                // Unix: use kill command
                // Try graceful SIGTERM first
                exec("kill -15 {$pid} 2>/dev/null", $output, $returnCode);

                // Wait a moment for graceful shutdown
                usleep(500000); // 500ms

                // Check if still running
                if (file_exists("/proc/{$pid}")) {
                    // Force kill with SIGKILL
                    exec("kill -9 {$pid} 2>/dev/null");
                }
                $killed = true;
            }

            Log::info("Stopped preview server", ['pid' => $pid, 'killed' => $killed]);
            return true;
        } catch (\Exception $e) {
            Log::error("Failed to stop preview server", [
                'error' => $e->getMessage(),
            ]);

            return false;
        }
    }

    /**
     * Tinymist's file watcher will detect the change and trigger incremental compilation.
     */
    public function updateTinymistPreviewFile(int $pageId, string $content): void
    {
        // Write directly to file instead of using Storage facade
        // Because filesystems.php sets 'root' to public_path(), not storage_path()
        $filePath = storage_path("app/tinymist/page_{$pageId}.typ");
        $directory = dirname($filePath);

        if (!is_dir($directory)) {
            mkdir($directory, 0755, true);
        }

        if (file_exists($filePath) && filesize($filePath) > 0) {
            Log::debug("Tinymist preview file already exists and is not empty; skipping overwrite", [
                'page_id' => $pageId,
                'path' => $filePath,
            ]);
            return;
        }

        file_put_contents($filePath, $content);
    }

    /**
     * Find available ports (not bound by page ID calculation)
     * Returns a pair of consecutive ports where dataPort = controlPort + 1
     */
    public function findAvailablePorts(int $startPort = 20000, int $maxAttempts = 100): ?array
    {
        $host = config('tinymist.preview_host', '127.0.0.1');

        for ($i = 0; $i < $maxAttempts; $i++) {
            $controlPort = $startPort + ($i * 2);
            $dataPort = $controlPort + 1;

            // Check if both ports are available
            if ($this->isPortAvailable($host, $controlPort) && $this->isPortAvailable($host, $dataPort)) {
                Log::info("Found available ports: control={$controlPort}, data={$dataPort}");
                return [
                    'control_port' => $controlPort,
                    'data_port' => $dataPort,
                ];
            }
        }

        Log::warning("Could not find available ports after {$maxAttempts} attempts");
        return null;
    }

    /**
     * Check if a port is available
     */
    protected function isPortAvailable(string $host, int $port): bool
    {
        $connection = @fsockopen($host, $port, $errno, $errstr, 1);
        if (is_resource($connection)) {
            fclose($connection);
            return false; // Port is in use
        }
        return true; // Port is available
    }
}
