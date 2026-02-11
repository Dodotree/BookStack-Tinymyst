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

### On your Windows machine (Git Bash or WSL)

ssh-keygen -t ed25519 -f ~/.ssh/aws-new-key -C "<your-email@example.com>"

### Copy the public key

cat ~/.ssh/aws-new-key.pub

then on the Ubuntu server:

### Add the new public key to authorized_keys

echo "paste-your-public-key-here" >> ~/.ssh/authorized_keys

Then convert the new private key to .ppk format using PuTTYgen and use that instead
