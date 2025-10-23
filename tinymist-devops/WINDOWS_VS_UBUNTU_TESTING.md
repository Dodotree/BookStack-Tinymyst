# Why Tests Fail on Windows but Work on Ubuntu

## TL;DR

**Windows:** MariaDB + PHP 8.4 = Authentication incompatibility ❌
**Ubuntu:** MariaDB + PHP 8.3 = Works perfectly ✅

## The Technical Details

### What Happens on Windows

1. **You run:** `php artisan test`
2. **PHPUnit tries to connect** to MariaDB using PDO MySQL driver
3. **MariaDB responds:** "I use GSSAPI authentication"
4. **PHP PDO says:** "I don't know what GSSAPI is"
5. **Error:** `SQLSTATE[HY000] [2054] The server requested authentication method unknown to the client [auth_gssapi_client]`

vim ~/.bashrc

``` bashrc
alias mariadb="/c/Program\ Files/MariaDB\ 11.8/bin/mysql.exe"
alias mysql="/c/Program\ Files/MariaDB\ 11.8/bin/mysql.exe
```

source ~/.bashrc



### Why This Happens

**MariaDB on Windows** includes the GSSAPI authentication plugin by default. This plugin is used for enterprise authentication scenarios (Active Directory, Kerberos, etc.).

**PHP 8.4 PDO on Windows** doesn't include support for GSSAPI authentication. The PDO driver expects:

- `mysql_native_password` (traditional MySQL) ✅
- `caching_sha2_password` (MySQL 8.0+ only) ⚠️
- But NOT `auth_gssapi_client` (MariaDB enterprise auth) ❌

### Why Ubuntu Works

On Ubuntu:

- ✅ **PHP 8.3** has better compatibility
- ✅ **MariaDB on Linux** uses unix socket authentication for `@'localhost'`
- ✅ **TCP connections** (`@'127.0.0.1'`) use standard `mysql_native_password`
- ✅ GSSAPI plugin less aggressive on Linux installations

## The Solution: Force mysql_native_password

### On Windows MariaDB

When creating the test user, explicitly specify the authentication plugin:

```sql
-- Connect to MariaDB as root
mysql -u root -p

-- Create test database and user with mysql_native_password
CREATE DATABASE IF NOT EXISTS `bookstack-test` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'bookstack-test'@'127.0.0.1'
IDENTIFIED VIA mysql_native_password USING PASSWORD('bookstack-test');
GRANT ALL PRIVILEGES ON `bookstack-test`.* TO 'bookstack-test'@'127.0.0.1';
FLUSH PRIVILEGES;
EXIT;
```

**Why this works:**
- ✅ Explicitly sets `mysql_native_password` authentication
- ✅ Bypasses GSSAPI plugin completely
- ✅ Compatible with PHP 8.4 PDO
- ✅ Works for TCP connections (`127.0.0.1`)

### Verify Authentication Method

```bash
mysql -u root -p -e "SELECT User, Host, plugin FROM mysql.user WHERE User = 'bookstack-test';"
```

**Expected output:**
```
+----------------+-----------+-----------------------+
| User           | Host      | plugin                |
+----------------+-----------+-----------------------+
| bookstack-test | 127.0.0.1 | mysql_native_password |
+----------------+-----------+-----------------------+
```

### Test Connection

```bash
mysql -h 127.0.0.1 -u bookstack-test -pbookstack-test bookstack-test -e 'SELECT "Connected!" AS status;'
```

## Alternative Workarounds (If Solution Above Doesn't Work)

### Attempt 2: Provide MySQL Credentials

```env
MYSQL_USER=root
MYSQL_PASSWORD=your_password
```

**Result:** Failed
**Reason:** Authentication *method* is the issue, not credentials

### Solution 3: Switch to MySQL on Windows

Replace MariaDB with Oracle MySQL:

1. Uninstall MariaDB
2. Install MySQL Community Server
3. MySQL doesn't have GSSAPI issues on Windows

**Note:** This is overkill just for testing.

### Solution 4: Skip Automated Testing on Windows

For personal development:

1. **Manual testing:** Test features in browser at `http://localhost:8000`
2. **Production testing:** Deploy to Ubuntu and test there
3. **Disable GitHub Actions:** Remove `.github/workflows/` to stop CI/CD

This is perfectly valid for a personal fork!

## Recommended Workflow

### For Personal Fork Development (like yours)

``` txt
┌─────────────────┐
│ Windows Dev     │
│ - Code changes  │
│ - Manual test   │ → Test in browser (localhost:8000)
│   in browser    │
└────────┬────────┘
         │
         ↓ git push
┌────────┴────────┐
│ Ubuntu Server   │
│ - Deploy code   │ → php artisan test (if needed)
│ - Run tests     │ → Manual testing in production
│ - Production    │
└─────────────────┘
```

### For Contributing to BookStack Core

``` txt
┌─────────────────┐
│ WSL2 Ubuntu     │
│ - Full dev env  │
│ - Run all tests │ → php artisan test
│ - Match CI      │
└────────┬────────┘
         │
         ↓ pull request
┌────────┴────────┐
│ GitHub Actions  │
│ - Linux runner  │ → Automated tests
│ - Full suite    │ → Must pass before merge
└─────────────────┘
```

## Understanding the Error Message

```
PDOException: SQLSTATE[HY000] [2054] The server requested
authentication method unknown to the client [auth_gssapi_client]
```

**Breaking it down:**

- `PDOException`: PHP Data Objects error
- `SQLSTATE[HY000]`: General error code
- `[2054]`: MySQL error 2054 = unknown auth plugin
- `auth_gssapi_client`: The problematic MariaDB plugin

**Location:**
```
vendor\laravel\framework\src\Illuminate\Database\Connectors\Connector.php:67
```

This is **Laravel's database connector**, not your code. The error happens when Laravel tries to establish a PDO connection to MariaDB.
