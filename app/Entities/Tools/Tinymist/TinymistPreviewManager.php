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
     * Ensure the preview file exists and return the content that should be used in the editor.
     * If an existing file is newer than the page updated time, it is preserved and used.
     */
    public function ensurePreviewFileContent(
        int $pageId,
        string $dbContent,
        ?\DateTimeInterface $pageUpdatedAt
    ): string {
        $filePath = storage_path("app/tinymist/page_{$pageId}.typ");
        $directory = dirname($filePath);

        if (!is_dir($directory)) {
            mkdir($directory, 0755, true);
        }

        if (!file_exists($filePath)) {
            file_put_contents($filePath, $dbContent);
            return $dbContent;
        }

        $fileMtime = @filemtime($filePath) ?: 0;
        $dbTimestamp = $pageUpdatedAt ? $pageUpdatedAt->getTimestamp() : 0;

        if ($fileMtime > $dbTimestamp) {
            $fileContent = @file_get_contents($filePath);
            return is_string($fileContent) ? $fileContent : $dbContent;
        }

        file_put_contents($filePath, $dbContent);
        return $dbContent;
    }

}
