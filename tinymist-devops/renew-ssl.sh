#!/bin/bash
#
# Manual SSL Certificate Renewal Script
# Use this if you need to manually renew certificates
#
# Usage: sudo bash renew-ssl.sh

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}=== Renewing SSL Certificates ===${NC}\n"

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Error: This script must be run as root (use sudo)${NC}"
    exit 1
fi

# Renew all certificates
echo -e "${YELLOW}Attempting to renew certificates...${NC}"
certbot renew

# Reload nginx if certificates were renewed
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Certificate renewal complete${NC}"
    echo -e "${YELLOW}Reloading nginx...${NC}"
    systemctl reload nginx
    echo -e "${GREEN}✓ Nginx reloaded${NC}\n"

    # Show certificate status
    echo -e "${YELLOW}Current certificate status:${NC}"
    certbot certificates
else
    echo -e "${RED}✗ Certificate renewal failed${NC}"
    exit 1
fi

echo -e "\n${GREEN}=== Renewal Complete! ===${NC}"

exit 0
