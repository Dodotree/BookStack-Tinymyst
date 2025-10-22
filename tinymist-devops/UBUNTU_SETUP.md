# Dealing with Ubuntu 24 and later ssh login and putty

``` sh
sudo su
vim /etc/ssh/sshd_config
```

append:

``` txt
# Enable RSA keys for PuTTY compatibility
PubkeyAcceptedKeyTypes=+ssh-rsa
HostkeyAlgorithms=+ssh-rsa
```

``` sh
service ssh restart
```

Patty should work now.

## Alternative: Update PuTTY to use modern key types

If you prefer not to modify the server, you can regenerate your key in a modern format:

# On your Windows machine (Git Bash or WSL)
ssh-keygen -t ed25519 -f ~/.ssh/aws-new-key -C "<your-email@example.com>"

# Copy the public key
cat ~/.ssh/aws-new-key.pub

then on the Ubuntu server:

# Add the new public key to authorized_keys
echo "paste-your-public-key-here" >> ~/.ssh/authorized_keys

Then convert the new private key to .ppk format using PuTTYgen and use that instead

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

```bash
git clone https://github.com/Dodotree/BookStack-Tinymyst.git /var/www/bookstack
git config core.fileMode false

cd /var/www/bookstack/
# create .env
composer install --no-dev --no-interaction --prefer-dist --optimize-autoloader
php artisan key:generate
php artisan optimize:clear
php artisan migrate --force
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

### Nginx configuration for tensorsum.com

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
