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
