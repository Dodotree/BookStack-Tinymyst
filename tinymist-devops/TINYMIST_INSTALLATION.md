# 5. Add Scheduled Cleanup

**File:** `app/Console/Kernel.php`

```php
protected function schedule(Schedule $schedule)
{
    // ... existing schedules ...

    // Clean up idle Tinymist preview servers every 10 minutes
    $schedule->call(function () {
        app(TinymistPreviewManager::class)->cleanupIdleServers();
    })->everyTenMinutes();
}
```

## Development Mode

**Concurrency:** Configure max concurrent preview servers in `.env`:
TINYMIST_MAX_PREVIEW_SERVERS=20

### Firewall Configuration

```bash
# Allow preview server port range / not recommended, use proxy instead
sudo ufw allow 33625:33999/tcp comment 'Tinymist preview servers'
```

**Recommended:** Keep preview servers on localhost only (`127.0.0.1`). Use Nginx reverse proxy if remote access needed.

### Nginx Reverse Proxy (Optional - for Remote Access)

Only needed if users connect from different servers than where Tinymist runs.

**File:** `/etc/nginx/sites-available/bookstack`

```nginx
server {
    listen 80;
    server_name bookstack.example.com;

    # ... existing BookStack config ...

    # Dynamic WebSocket proxy (pass through page-specific ports)
    # This requires Nginx Plus or custom Lua scripting
    # For simplicity, it's better to keep preview servers localhost-only
}
```

## Verification

```bash
tinymist --version

echo "= Hello World\nThis is *Typst*!" > test.typ
./vendor/bin/typst.exe compile test.typ output.svg --format svg
./vendor/bin/typst.exe compile test.typ output.pdf
cat output.svg  # Should show SVG XML

# Should output SVG content
php -r "echo shell_exec('./vendor/bin/tinymist --version');"
# php can execute

# Try starting manually to see error
tinymist preview --control-port 33636 --data-port 33637 --no-open storage/app/tinymist/page_5.typ

# Check file syntax
tinymist compile storage/app/tinymist/page_5.typ --format svg -o /tmp/test.svg

# Check for corrupted content
file storage/app/tinymist/page_5.typ
# Should be: ASCII text or UTF-8 Unicode text

# Check config
php artisan tinker
>>> config('tinymist.tinymist_cli_path')
# Should return: /usr/local/bin/tinymist (or your path)

# Verify binary exists and is executable
which tinymist
ls -l $(which tinymist)
# Should be: -rwxr-xr-x

# Check firewall for blocking ports
sudo ufw status

# Allow ports (if needed, not recommended, use Nginx proxy)
sudo ufw allow 23625/tcp
sudo ufw allow 23626/tcp

# Monitor Tinymist CPU usage if slow
top -p $(pgrep -f "tinymist preview")

# If consistently >80%, consider:
# 1. Simpler Typst document
# 2. Faster hardware
# 3. Reduce update frequency (increase debounce)

# Monitor memory usage (all preview servers)
watch -n 1 'ps aux | grep "tinymist preview" | grep -v grep'

# Check for memory leaks
valgrind --leak-check=full tinymist compile test.typ --format svg -o test.svg

# Test compilation time on large file
time tinymist compile large-file.typ --format svg -o output.svg

# Check file size
wc -l large-file.typ
du -h large-file.typ

```

### Tinkering

```bash
php artisan tinker
  DB::connection()->getPdo();

php artisan config:clear
php artisan tinker --execute="echo config('tinymyst.typst_cli_path');"
php artisan tinker --execute="echo config('tinymist.typst_cli_path') . PHP_EOL;"
php artisan tinker --execute="echo config('tinymist.tinymist_cli_path') . PHP_EOL;"
php artisan tinker --execute="var_dump(config('tinymist'));"

php artisan tinker --execute="echo App\Entities\Models\Page::where('editor', 'tinymyst')->first()->html;" | head -50

php artisan tinker --execute="\$page = BookStack\Entities\Models\Page::where('editor', 'tinymyst')->first(); if (\$page) { echo substr(\$page->html, 0, 500); }"
```

**Check file permissions:**

```bash
ls -la storage/app/tinymist/
chmod -R 775 storage/app/tinymist/
chown -R www-data:www-data storage/app/tinymist/

# Check file exists and is writable
ls -lah storage/app/tinymist/page_5.typ
# Should be readable/writable by www-data (or PHP user)

# Fix permissions
chown www-data:www-data storage/app/tinymist/page_5.typ
chmod 644 storage/app/tinymist/page_5.typ

# Verify directory permissions
ls -lad storage/app/tinymist/
# Should be: drwxr-xr-x www-data www-data
```

### Testing

```bash
# Use systemd for better logging
sudo systemctl start tinymist-preview@test

# View logs
sudo journalctl -u tinymist-preview@test -f
```

### Check DB

```bash
# Check database connection
php artisan tinker --execute="DB::connection()->getPdo();"
# Expected: PDO object

# Test preview server start via API
curl -X POST http://localhost/ajax/tinymist/start-preview \
  -H "Content-Type: application/json" \
  -d '{"page_id": 999}'
# Expected: {"success": true, "control_port": 34624, "data_port": 34623}

# Test WebSocket connection (use returned port)
curl -i -N \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: x3JJHMbDL1EzLkh9GBhXDw==" \
  http://127.0.0.1:34624
# Expected: HTTP/1.1 101 Switching Protocols

# Check pages table has Tinymist pages
php artisan tinker --execute="\BookStack\Entities\Models\Page::where('editor', 'tinymist')->count();"
# Expected: Count of Tinymist pages

# Check if page exists
php artisan tinker
>>> use BookStack\Entities\Models\Page;
>>> Page::find(123);
# Should return Page object, not null

# Check column type
php artisan tinker
>>> DB::select("SHOW COLUMNS FROM pages WHERE Field = 'html'");
# Type should be 'longtext' (4GB max) to fit large svg

# Check if page was saved
php artisan tinker
>>> $page = Page::find(123);
>>> $page->editor;
# Should be 'tinymist'
>>> strlen($page->html);
# Should be > 0 (SVG size in bytes) if not empty
```


### Load Testing

```bash
# Simulate 10 concurrent editors (Pages 1-10)
for i in {1..10}; do
    curl -X POST http://localhost/ajax/tinymist/start-preview \
      -H "Content-Type: application/json" \
      -d "{\"page_id\": $i}" &
done
wait

# Check resource usage
ps aux | grep "tinymist preview" | grep -v grep | wc -l
# Expected: 10 processes

# Check memory consumption
ps aux | grep "tinymist preview" | awk '{sum+=$6} END {print "Total memory:", sum/1024, "MB"}'

# Expected: ~500MB - 1GB for 10 processes
```

### Cleanup After Testing

```bash
# Stop all preview servers
for i in {1..10}; do
    curl -X POST http://localhost/ajax/tinymist/stop-preview \
      -H "Content-Type: application/json" \
      -d "{\"page_id\": $i}"
done

# Verify all stopped
ps aux | grep "tinymist preview" | grep -v grep
# Expected: No output
```

### Timeout

**Solution 1:** Increase timeout

```php
// Not controller, though
// app/Http/Controllers/TinymistController.php

protected function compileTypst(string $source): string
{
    $result = Process::timeout(60)->run([  // Increase to 60 seconds
        config('tinymist.tinymist_cli_path'),
        'compile',
        '-',
        '--format', 'svg',
        '-o', '-'
    ], $source);

    if (!$result->successful()) {
        throw new \RuntimeException($result->errorOutput());
    }

    return $result->output();
}
```

### CLI Returns Empty Output

**Symptom:**

```php
RuntimeException: Compilation produced empty output
```

**Diagnosis:**

```bash
# Test manually
echo "= Test" | tinymist compile - --format svg -o -

# Check stderr
echo "= Test" | tinymist compile - --format svg -o - 2>&1
```

**Solution:**

```php
protected function compileTypst(string $source): string
{
    // Add validation
    if (empty(trim($source))) {
        throw new \InvalidArgumentException('Source cannot be empty');
    }

    $result = Process::timeout(30)->run([
        config('tinymist.tinymist_cli_path'),
        'compile',
        '-',
        '--format', 'svg',
        '-o', '-'
    ], $source);

    if (!$result->successful()) {
        // Log detailed error
        \Log::error('Tinymist compilation failed', [
            'exit_code' => $result->exitCode(),
            'stdout' => $result->output(),
            'stderr' => $result->errorOutput(),
            'source_length' => strlen($source),
        ]);

        throw new \RuntimeException(
            'Compilation failed: ' . $result->errorOutput()
        );
    }

    $output = $result->output();

    // Validate output
    if (empty($output)) {
        throw new \RuntimeException('Compilation produced empty output');
    }

    if (!str_starts_with($output, '<svg')) {
        throw new \RuntimeException('Output is not valid SVG');
    }

    return $output;
}
```

## Enable Verbose Logging

```php
// app/Http/Controllers/TinymistController.php

use Illuminate\Support\Facades\Log;

public function compile(Request $request)
{
    Log::info('Tinymist compile started', [
        'page_id' => $request->input('page_id'),
        'content_length' => strlen($request->input('content')),
        'user_id' => auth()->id(),
    ]);

    try {
        $svgContent = $this->compileTypst($typstSource);

        Log::info('Tinymist compile completed', [
            'page_id' => $pageId,
            'svg_size' => strlen($svgContent),
        ]);
    } catch (\Exception $e) {
        Log::error('Tinymist compile failed', [
            'page_id' => $pageId,
            'error' => $e->getMessage(),
            'trace' => $e->getTraceAsString(),
        ]);

        throw $e;
    }
}
```

**View logs:**

```bash
tail -f storage/logs/laravel.log | grep Tinymist
```
