<?php

namespace BookStack\Extensions\Tinymist\Tools;

use BookStack\Entities\Models\Page;
use BookStack\Uploads\Attachment;
use BookStack\Uploads\FileStorage;
use Illuminate\Support\Facades\Log;

class TinymistPreviewManager
{
    public function generateTinymistWsToken(Page $page): ?array
    {
        $userId = user()?->id;
        $secret = config('tinymist.ws_token_secret');
        $ttl = (int) config('tinymist.ws_token_ttl', 1800);
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
        Page $page,
        string $dbContent,
        ?\DateTimeInterface $pageUpdatedAt
    ): string {
        $pageId = $page->id;
        $pageDir = storage_path("app/tinymist/page_{$pageId}");
        $filePath = $pageDir . DIRECTORY_SEPARATOR . 'entry.typ';
        $legacyPath = storage_path("app/tinymist/page_{$pageId}.typ");
        $directory = dirname($filePath);

        if (!is_dir($directory)) {
            mkdir($directory, 0755, true);
        }

        if (!file_exists($filePath)) {
            if (file_exists($legacyPath)) {
                $legacyContent = @file_get_contents($legacyPath);
                if (is_string($legacyContent)) {
                    file_put_contents($filePath, $legacyContent);
                    @unlink($legacyPath);
                    $this->syncAttachmentFiles($page, $pageDir);
                    return $legacyContent;
                }
            }

            file_put_contents($filePath, $dbContent);
            $this->syncAttachmentFiles($page, $pageDir);
            return $dbContent;
        }

        $fileMtime = @filemtime($filePath) ?: 0;
        $dbTimestamp = $pageUpdatedAt ? $pageUpdatedAt->getTimestamp() : 0;

        if ($fileMtime > $dbTimestamp) {
            $fileContent = @file_get_contents($filePath);
            if (is_string($fileContent)) {
                $fileEmpty = trim($fileContent) === '';
                $dbEmpty = trim((string)$dbContent) === '';
                if ($fileEmpty && !$dbEmpty) {
                    Log::warning('Tinymist preview file empty but DB has content, restoring DB copy', [
                        'page_id' => $page->id,
                    ]);
                    file_put_contents($filePath, $dbContent);
                    $this->syncAttachmentFiles($page, $pageDir);
                    return $dbContent;
                }
            }
            $this->syncAttachmentFiles($page, $pageDir);
            return is_string($fileContent) ? $fileContent : $dbContent;
        }

        file_put_contents($filePath, $dbContent);
        $this->syncAttachmentFiles($page, $pageDir);
        return $dbContent;
    }

    protected function syncAttachmentFiles(Page $page, string $pageDir): void
    {
        foreach ($page->attachments as $attachment) {
            $this->syncSingleAttachment($page, $pageDir, $attachment);
        }
    }

    public function syncNewAttachmentToPreviewDir(Page $page, Attachment $attachment): void
    {
        $pageDir = storage_path("app/tinymist/page_{$page->id}");
        if (!is_dir($pageDir)) {
            mkdir($pageDir, 0755, true);
        }

        $this->syncSingleAttachment($page, $pageDir, $attachment);
    }

    public function restoreAttachmentToPreviewDir(Page $page, Attachment $attachment): void
    {
        $pageDir = storage_path("app/tinymist/page_{$page->id}");
        if (!is_dir($pageDir)) {
            mkdir($pageDir, 0755, true);
        }

        $this->syncSingleAttachment($page, $pageDir, $attachment, true);
    }

    public function removeAttachmentFromPreviewDir(Page $page, string $attachmentFileName): void
    {
        $fileName = basename($attachmentFileName);
        if ($fileName === '' || $fileName === 'entry.typ') {
            return;
        }

        $pageDir = storage_path("app/tinymist/page_{$page->id}");
        $destPath = $pageDir . DIRECTORY_SEPARATOR . $fileName;
        if (file_exists($destPath) && is_file($destPath)) {
            @unlink($destPath);
        }
    }

    protected function syncSingleAttachment(Page $page, string $pageDir, Attachment $attachment, bool $forceOverwrite = false): void
    {
        if ($attachment->external) {
            return;
        }

        $storage = app()->make(FileStorage::class);
        $sourcePath = $storage->getSystemPath($attachment->path);
        if ($sourcePath === '' || !file_exists($sourcePath)) {
            return;
        }

        $fileName = basename($attachment->getFileName());
        if ($fileName === 'entry.typ') {
            Log::warning('Skipping attachment named entry.typ to avoid overwriting editor file', [
                'page_id' => $page->id,
                'attachment_id' => $attachment->id,
            ]);
            return;
        }

        $destPath = $pageDir . DIRECTORY_SEPARATOR . $fileName;
        if (!$forceOverwrite && file_exists($destPath)) {
            $sourceMtime = @filemtime($sourcePath) ?: 0;
            $destMtime = @filemtime($destPath) ?: 0;
            if ($destMtime >= $sourceMtime) {
                return;
            }
        }

        @copy($sourcePath, $destPath);
    }
}
