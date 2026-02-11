# Initial troubleshooting

## Verification

```bash

npm install
# for linux without .exe
./vendor/bin/typst.exe --version  # Should show: typst 0.x.x
./vendor/bin/tinymist.exe --version  # Should show: tinymist v0.x.x

# Check tinymist LSP capabilities
tinymist --help
tinymist lsp --help

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
# Verify all stopped
ps aux | grep "tinymist preview" | grep -v grep
# Expected: No output
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

**View logs:**

```bash
tail -f storage/logs/laravel.log | grep Tinymist
```

### If command works manually but not from php

The problem could be in shell wrappers from Laravel or Symfony
This is the method to replicate shell command exactly as manually in command line
Tinymist spawns websocket, it needs Winsock and throws The Windows error 10106 ("The requested service provider could not be loaded or initialized") because Winsock doesn't want to work in this environment

```php
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
```

### API Testing for fallback (typst command line render)

```bash
# Test compilation endpoint
curl -X POST http://localhost:8000/ajax/tinymist/compile \
  -H "Content-Type: application/json" \
  -d '{"source": "= Test\n\nHello *world*!"}'

# Expected response:
# {"success": true, "svg": "<svg>...</svg>", "errors": []}

# Test validation endpoint
curl -X POST http://localhost:8000/ajax/tinymist/check \
  -H "Content-Type: application/json" \
  -d '{"source": "= Invalid Typst \n\n#unknowncommand"}'

# Test status endpoint
curl http://localhost:8000/ajax/tinymist/status

# Expected response:
# {"available": true, "enabled": true}
```

### Error Handling Test

- [ ] Typst CLI not installed
  - Should show compilation errors
  - `/ajax/tinymist/status` returns `{"available": false}`

- [ ] Document exceeds max size (1024 KB)
  - Should show "Document exceeds maximum size limit"

- [ ] Compilation timeout (30s limit)
  - Should handle gracefully with error message
