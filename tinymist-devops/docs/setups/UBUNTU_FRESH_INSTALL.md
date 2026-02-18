## Upgrade and set vim as default editor

``` sh
apt-get update
apt-get dist-upgrade

set default editor to vim:
update-alternatives --config editor
(the table of available editors shows up, select number for vim)

sudo vim /usr/share/vim/vimrc
```

### Add to the end of file

``` rc
    " show existing tab with 4 spaces width
    set tabstop=4
    " when indenting with '>', use 4 spaces width
    set shiftwidth=4
    " On pressing tab, insert 4 spaces
    set expandtab
```

``` sh
USERNAME=myusername
adduser $USERNAME --disabled-password
adduser $USERNAME sudo
sudo passwd $USERNAME

cp -r .ssh/ /home/$USERNAME/
chown -R $USERNAME:$USERNAME /home/$USERNAME
```

Try logging in with new user. If it works, remove ubuntu from there:

``` sh
deluser --remove-home ubuntu
```

``` sh
php -v
php -m
apt install -y php-fpm php-ldap php-xml php-gd php-mysql
systemctl status php8.3-fpm

apt install -y nginx
apt install -y composer
# node20 required by bookstack
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

apt install mariadb-server
mariadb --version
# To start at boot time
systemctl enable mariadb
vim /etc/mysql/mariadb.conf.d/50-server.cnf
```

### Add after [mysqld]

``` cnf
[mysqld]
# Unix socket location
socket = /var/run/mysqld/mysqld.sock

# Comment out or remove bind-address for local-only access
# bind-address = 127.0.0.1
```

### Remove default users and disallow remote logins

``` sh
mysql_secure_installation
systemctl restart mariadb
mariadb -u root -p
```

```sql
-- MariaDB syntax for creating database and user
DROP DATABASE IF EXISTS bookstack;
DROP USER IF EXISTS 'bookstack_user'@'localhost';

-- Create user (MariaDB connects via socket when using @'localhost')
CREATE USER 'bookstack_user'@'localhost' IDENTIFIED BY 'secure_password_here';

-- Create database
CREATE DATABASE bookstack CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Grant all privileges on the database
GRANT ALL PRIVILEGES ON bookstack.* TO 'bookstack_user'@'localhost';

-- Apply changes
FLUSH PRIVILEGES;

-- Verify the user and database
SELECT User, Host FROM mysql.user WHERE User = 'bookstack_user';
SHOW DATABASES LIKE 'bookstack';

-- ============================================================
-- TESTING DATABASE SETUP (for PHPUnit tests)
-- ============================================================

-- Create test database
CREATE DATABASE IF NOT EXISTS `bookstack-test` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create test user (using TCP connection @'127.0.0.1' as required by phpunit.xml)
-- IMPORTANT: Use 'mysql_native_password' to avoid GSSAPI authentication issues on Windows
CREATE USER IF NOT EXISTS 'bookstack-test'@'127.0.0.1' IDENTIFIED VIA mysql_native_password USING PASSWORD('bookstack-test');

-- Grant all privileges on test database
GRANT ALL PRIVILEGES ON `bookstack-test`.* TO 'bookstack-test'@'127.0.0.1';

-- Apply changes
FLUSH PRIVILEGES;

-- Verify test database setup
SELECT 'Database created successfully!' AS status;
SHOW DATABASES LIKE 'bookstack-test';
SELECT User, Host FROM mysql.user WHERE User = 'bookstack-test';


EXIT;
```

### Laravel .env Configuration for Unix Socket

```env
DB_CONNECTION=mysql
DB_HOST=localhost
DB_PORT=3306
DB_DATABASE=bookstack
DB_USERNAME=bookstack_user
DB_PASSWORD=secure_password_here
DB_SOCKET=/var/run/mysqld/mysqld.sock
```

**Note:** Using `@'localhost'` in MariaDB/MySQL automatically uses Unix socket connection. Using `@'127.0.0.1'` would force TCP connection.

### Required .env additions for Tinymist

Add these to .env (if not already present):

- TINYMIST_ENABLED=true
- TINYMIST_LSP_ENABLED=true
- TINYMIST_WS_SECRET=<random 64-hex string>

Tip: generate a secret with Node:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

```bash
git clone https://github.com/Dodotree/BookStack-Tinymist.git /var/www/bookstack
cd /var/www/bookstack/
git config core.fileMode false
```

### Testing Setup (PHPUnit)

After database setup, verify test database connection:

```bash
# Check MariaDB is running
sudo systemctl status mariadb

# Verify port 3306 is listening
sudo netstat -tlnp | grep 3306

# If needed, check bind-address in config
sudo vim /etc/mysql/mariadb.conf.d/50-server.cnf
# Ensure: bind-address = 127.0.0.1
sudo systemctl restart mariadb

# Test the test database connection (use single quotes to avoid bash history expansion)
mysql -h 127.0.0.1 -u bookstack-test -pbookstack-test bookstack-test -e 'SELECT "Test DB connected!" AS status;'

```

**Important:** Tests use TCP connection (`127.0.0.1`) not unix socket. The `bookstack-test` user must be created with `@'127.0.0.1'` as shown in the SQL above.

For detailed testing documentation, see `tinymist-devops/TESTING_SETUP.md`.

### Nginx configuration for tensorsum.com with free https

Change: EMAIL="admin@tensorsum.com" to your real email in setup-letsencrypt.sh

``` sh
cd /var/www/bookstack/tinymist-devops
chmod +x setup-letsencrypt.sh renew-ssl.sh
./setup-letsencrypt.sh
mv tensorsum.com /etc/nginx/sites-available/tensorsum.com
ln -s /etc/nginx/sites-available/tensorsum.com /etc/nginx/sites-enabled/
# Test and reload
nginx -t
systemctl reload nginx
```

### Run Node WebSocket services with PM2 (recommended)

Tinymist uses two Node services:

- File sync + LSP: port 4000
- Preview bridge: port 4020

#### Install PM2

```bash
sudo npm install -g pm2
pm2 --version
```

#### Production mode (recommended)

Build the Node services once, then run the built output:

```bash
cd /var/www/bookstack
npm ci
npm run ws:build
npm run preview:build

pm2 start npm --name tinymist-ws -- run ws:start
pm2 start npm --name tinymist-preview -- run preview:start
pm2 save
pm2 startup systemd -u www-data --hp /var/www
```

#### Development mode (hot reload)

```bash
cd /var/www/bookstack
pm2 start npm --name tinymist-ws-dev -- run ws:dev
pm2 start npm --name tinymist-preview-dev -- run preview:dev
```

#### PM2 tips

```bash
pm2 list
pm2 logs tinymist-ws
pm2 logs tinymist-preview
pm2 restart tinymist-ws tinymist-preview
```

#### Recommendation

Keep both WebSocket services bound to localhost (127.0.0.1) and proxy via Nginx.

Check renewal status:

``` sh
sudo systemctl list-timers certbot.timer
sudo certbot renew --dry-run

# Force renewal
cd /var/www/bookstack/tinymist-devops
sudo bash renew-ssl.sh
# View certificate info
sudo certbot certificates
```

#### Typst and Tinymist package system uploads

Every time there is and #import @namespace statement it will upload packages from Typst Universe. To prevent that

```bash
sudo systemctl edit tinymist-preview.service

# Add
[Service]
IPAddressDeny=any
IPAddressAllow=localhost

sudo systemctl daemon-reload
sudo systemctl restart tinymist-preview.service
```

Other options are firejail or iptables owner match (block by user)
Block outbound traffic for the Linux user that runs Tinymist.

### Make builds

```bash
# create .env
composer install --no-dev --no-interaction --prefer-dist --optimize-autoloader
php artisan key:generate
php artisan optimize:clear
php artisan migrate --force

# pre-seed for testing if you want
php artisan db:seed --class=DummyContentSeeder

php artisan queue:restart
systemctl restart php8.3-fpm.service
npm ci
npm run build
```

## File Permissions

The installation script sets these permissions:

```bash
# Application files: 644 (rw-r--r--)
# Directories: 755 (rwxr-xr-x)
# Storage directories: 775 (rwxrwxr-x)
# Owner: www-data:www-data
cd /var/www/bookstack
chown -R www-data:www-data .
find . -type f -exec chmod 644 {} \;
find . -type d -exec chmod 755 {} \;
chmod -R 775 storage bootstrap/cache public/uploads
chmod +x artisan
```

### Users

``` bash
php artisan list | grep -iE "(bookstack|user|admin)"
php artisan bookstack:create-admin --email=admin@local.dev --name="Admin User" --password=password
# list users
php artisan tinker --execute="echo 'Users: '; \$users = \BookStack\Users\Models\User::all(['id', 'email', 'name']); foreach(\$users as \$u) { echo \$u->id . ' - ' . \$u->email . ' (' . \$u->name . ')' . PHP_EOL; }"
# list admins
 php artisan tinker --execute="echo 'Admin Users:' . PHP_EOL; \$adminRole = \BookStack\Permissions\Models\Role::where('system_name', 'admin')->first(); \$admins = \$adminRole->users; foreach(\$admins as \$admin) { echo '- ' . \$admin->email . ' (' . \$admin->name . ')' . PHP_EOL; }"
```

### Testing

Creates tables in test db, editor user, viewer user, and test content

``` bash
php artisan migrate --database=mysql_testing --force
php artisan db:seed --database=mysql_testing --class=DummyContentSeeder
# Verify Users Created
mysql -h 127.0.0.1 -u bookstack-test -pbookstack-test bookstack-test -e 'SELECT id, email, name FROM users;'

php artisan test

# Run only Activity tests
php artisan test --testsuite=Tests\\Activity

# Run specific test class
php artisan test --filter=AuditLogApiTest

# Run specific test method
php artisan test --filter=AuditLogApiTest::test_index_endpoint_returns_expected_data
```

### Reset Test Database

```bash
# Drop and recreate (tests will rebuild it)
sudo mariadb -u root -p -e "DROP DATABASE IF EXISTS \`bookstack-test\`; CREATE DATABASE \`bookstack-test\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
```

### Clean Up Test Database

Tests should clean up after themselves, but if needed:

```bash
mysql -h 127.0.0.1 -u bookstack-test -pbookstack-test bookstack-test -e "DROP TABLE IF EXISTS users, pages, books, chapters, migrations;"
```

## Understanding Test Configuration

### phpunit.xml

- Defines test environment variables
- Sets `DB_CONNECTION=mysql_testing`
- Disables external services for isolated testing

### app/Config/database.php

- The `mysql_testing` connection uses:
  - Host: `127.0.0.1` (TCP, not unix socket)
  - Database: `bookstack-test`
  - Username: `bookstack-test`
  - Password: `bookstack-test`

### tests/TestCase.php

- Base class for all tests
- Automatically creates test database if missing
- Runs migrations before tests
- Provides helper methods for testing

## Monitoring

### Check Application Status

```bash
# View logs
sudo tail -f /var/www/bookstack/storage/logs/laravel.log

# Check nginx logs
sudo tail -f /var/log/nginx/tensorsum.com-error.log
sudo tail -f /var/log/nginx/tensorsum.com-access.log

# Check PHP-FPM
sudo systemctl status php8.3-fpm

# Check disk space
df -h /var/www

# Test Tinymist LSP manually:
/var/www/bookstack/vendor/bin/tinymist lsp
#Should start and wait for input (Ctrl+C to exit)
```

### Health Check Endpoints

- **Application**: https://tensorsum.com
- **Status**: https://tensorsum.com/status
- **SSL Test**: https://www.ssllabs.com/ssltest/analyze.html?d=tensorsum.com

### Cleaning Up

```bash
# Remove old Git history (if repo gets too large)
cd /var/www/bookstack
git gc --aggressive --prune=now

# Clean old logs
find storage/logs -name "*.log" -mtime +30 -delete

# Clean Laravel caches
php artisan cache:clear
php artisan view:clear
```

## Database Backups

Create a backup before updates:

```bash
# Manual backup
sudo -u www-data php artisan backup:run

# Backups are stored in:
# /var/www/bookstack/storage/backups/
```

### Build Failures

```bash
# Clear npm cache
npm cache clean --force
# Remove node_modules and reinstall
rm -rf node_modules package-lock.json
npm install
npm run build
```

### Laravel Issues

```bash
# Clear all caches
php artisan cache:clear
php artisan config:clear
php artisan route:clear
php artisan view:clear

# Rebuild caches
php artisan config:cache
php artisan route:cache
php artisan view:cache
```

### Merge with bookstack upstream (release branch)

``` bash
# Make sure you're on your development branch
git checkout development

# Verify you're merging from release (not development)
git merge upstream/release --no-commit --no-ff

# Review what will be merged
git diff --cached

# If it looks good, complete the merge
git commit -m "Merge upstream BookStack release branch"

# Or abort if something's wrong
git merge --abort
```

### Regular updates via git

git pull
npm run build
php artisan optimize:clear
php artisan queue:restart
systemctl restart php8.3-fpm.service


