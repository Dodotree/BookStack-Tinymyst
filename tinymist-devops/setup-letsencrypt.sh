#!/bin/bash
#
# Let's Encrypt SSL Setup and Auto-Renewal Script for tensorsum.com
# This script installs certbot, obtains SSL certificates, and sets up auto-renewal
#
# Usage: sudo bash setup-letsencrypt.sh

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
DOMAIN="tensorsum.com"
DOMAIN_WWW="www.tensorsum.com"
EMAIL="admin@tensorsum.com"  # Change this to your email
WEBROOT="/var/www/letsencrypt"
NGINX_AVAILABLE="/etc/nginx/sites-available/tensorsum.com"
NGINX_ENABLED="/etc/nginx/sites-enabled/tensorsum.com"

echo -e "${GREEN}=== Let's Encrypt SSL Setup for $DOMAIN ===${NC}\n"

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Error: This script must be run as root (use sudo)${NC}"
    exit 1
fi

# Step 1: Install certbot
echo -e "${YELLOW}Step 1: Installing certbot...${NC}"
if ! command -v certbot &> /dev/null; then
    apt-get update
    apt-get install -y certbot python3-certbot-nginx
    echo -e "${GREEN}✓ Certbot installed${NC}\n"
else
    echo -e "${GREEN}✓ Certbot already installed${NC}\n"
fi

# Step 2: Create webroot directory for ACME challenge
echo -e "${YELLOW}Step 2: Creating webroot directory...${NC}"
mkdir -p $WEBROOT
chown -R www-data:www-data $WEBROOT
echo -e "${GREEN}✓ Webroot created at $WEBROOT${NC}\n"

# Step 3: Deploy nginx configuration (HTTP only, for initial certificate)
echo -e "${YELLOW}Step 3: Deploying initial nginx configuration...${NC}"
cat > /etc/nginx/sites-available/tensorsum.com-temp << 'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name tensorsum.com www.tensorsum.com;

    location /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
    }

    location / {
        root /var/www/bookstack/public;
        index index.php index.html;
        try_files $uri $uri/ /index.php?$query_string;
    }

    location ~ \.php$ {
        root /var/www/bookstack/public;
        try_files $uri =404;
        fastcgi_pass unix:/var/run/php/php8.3-fpm.sock;
        fastcgi_index index.php;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
        include fastcgi_params;
    }
}
EOF

# Remove existing config if present and use temp config
rm -f $NGINX_ENABLED
ln -sf /etc/nginx/sites-available/tensorsum.com-temp $NGINX_ENABLED

# Test nginx configuration
nginx -t
if [ $? -eq 0 ]; then
    systemctl reload nginx
    echo -e "${GREEN}✓ Initial nginx configuration deployed${NC}\n"
else
    echo -e "${RED}✗ Nginx configuration test failed${NC}"
    exit 1
fi

# Step 4: Obtain SSL certificate
echo -e "${YELLOW}Step 4: Obtaining SSL certificate from Let's Encrypt...${NC}"
echo -e "${YELLOW}Note: Make sure DNS is pointing to this server!${NC}\n"

certbot certonly \
    --webroot \
    --webroot-path=$WEBROOT \
    --email $EMAIL \
    --agree-tos \
    --no-eff-email \
    -d $DOMAIN \
    -d $DOMAIN_WWW

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ SSL certificate obtained successfully${NC}\n"
else
    echo -e "${RED}✗ Failed to obtain SSL certificate${NC}"
    echo -e "${YELLOW}Make sure:${NC}"
    echo -e "  1. DNS A records for $DOMAIN and $DOMAIN_WWW point to this server"
    echo -e "  2. Port 80 is open in your firewall"
    echo -e "  3. Nginx is running"
    exit 1
fi

# Step 5: Deploy full nginx configuration (with SSL)
echo -e "${YELLOW}Step 5: Deploying full nginx configuration with SSL...${NC}"

# Copy nginx config from tinymist-devops directory
NGINX_SOURCE="/var/www/bookstack/tinymist-devops/nginx-tensorsum.conf"

if [ -f "$NGINX_SOURCE" ]; then
    cp "$NGINX_SOURCE" $NGINX_AVAILABLE
    echo -e "${GREEN}✓ Nginx config copied from $NGINX_SOURCE${NC}"
else
    echo -e "${RED}✗ nginx-tensorsum.conf not found at $NGINX_SOURCE${NC}"
    echo -e "${YELLOW}Please ensure BookStack is installed at /var/www/bookstack${NC}"
    exit 1
fi

# Remove temp config and enable the real one
rm -f /etc/nginx/sites-available/tensorsum.com-temp
rm -f $NGINX_ENABLED
ln -sf $NGINX_AVAILABLE $NGINX_ENABLED

# Test and reload nginx
nginx -t
if [ $? -eq 0 ]; then
    systemctl reload nginx
    echo -e "${GREEN}✓ Full nginx configuration deployed${NC}\n"
else
    echo -e "${RED}✗ Nginx configuration test failed${NC}"
    exit 1
fi

# Step 6: Set up automatic renewal
echo -e "${YELLOW}Step 6: Setting up automatic certificate renewal...${NC}"

# Create renewal hook script
cat > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh << 'EOF'
#!/bin/bash
# Reload nginx after certificate renewal
systemctl reload nginx
EOF

chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh

# Test automatic renewal (dry run)
echo -e "${YELLOW}Testing automatic renewal (dry run)...${NC}"
certbot renew --dry-run

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Automatic renewal test successful${NC}\n"
else
    echo -e "${RED}✗ Automatic renewal test failed${NC}"
fi

# Certbot automatically creates a systemd timer for renewal
systemctl list-timers | grep certbot

echo -e "${GREEN}✓ Automatic renewal configured via systemd timer${NC}\n"

# Step 7: Test SSL certificate
echo -e "${YELLOW}Step 7: Verifying SSL certificate...${NC}"
certbot certificates

echo -e "\n${GREEN}=== Setup Complete! ===${NC}\n"
echo -e "Your site should now be accessible at:"
echo -e "  ${GREEN}https://$DOMAIN${NC}"
echo -e "  ${GREEN}https://$DOMAIN_WWW${NC}"
echo -e "\nSSL certificate will automatically renew via systemd timer."
echo -e "Check renewal status: ${YELLOW}sudo certbot renew --dry-run${NC}"
echo -e "View timer status: ${YELLOW}sudo systemctl list-timers certbot.timer${NC}"
echo -e "\nSSL Labs test: ${YELLOW}https://www.ssllabs.com/ssltest/analyze.html?d=$DOMAIN${NC}"

exit 0
