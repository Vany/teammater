# Certificate Setup for Rust Server

## Problem

Chrome (and other browsers) strictly validate TLS certificates for ES6 module imports, even for localhost. Self-signed certificates without proper trust setup will cause module loading failures:

```
Failed to load resource: net::ERR_CERT_AUTHORITY_INVALID
```

## Solutions

### Option 1: Use Caddy's Certificate (Recommended)

Caddy generates proper certificates with internal CA. Copy them to the Rust server:

```bash
# Find Caddy's cert location
caddy file-server --browse &
# Certificates typically in: ~/Library/Application Support/Caddy/certificates/

# Copy to Rust server
cp /path/to/caddy/cert.pem server/certs/
cp /path/to/caddy/key.pem server/certs/
```

### Option 2: Trust Self-Signed Certificate

Add the generated certificate to macOS keychain:

```bash
# Add to keychain
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain \
  server/certs/cert.pem

# Restart browser to pick up changes
```

### Option 3: Chrome with Certificate Bypass (Development Only)

Launch Chrome with flags to ignore certificate errors:

```bash
# Close all Chrome windows first
pkill "Google Chrome"

# Launch with bypass flags
open -a "Google Chrome" --args \
  --ignore-certificate-errors \
  --allow-insecure-localhost \
  --user-data-dir=/tmp/chrome-dev \
  https://localhost:8443/
```

**Warning:** Never use these flags for regular browsing - security risk!

### Option 4: Use mkcert (Best for Development)

Install `mkcert` to create locally-trusted certificates:

```bash
# Install mkcert
brew install mkcert
mkcert -install

# Generate certificate
cd server/certs
mkcert localhost 127.0.0.1 ::1

# Rename to expected filenames
mv localhost+2.pem cert.pem
mv localhost+2-key.pem key.pem

# Restart server
```

This creates certificates trusted by your system without manual import.

## Verification

Test if certificate is trusted:

```bash
# Should not show certificate errors
curl -v https://localhost:8443/ 2>&1 | grep -i cert

# Test WebSocket upgrade
curl -i -N \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: test" \
  https://localhost:8443/echowire
```

Should return: `HTTP/1.1 101 Switching Protocols`

## Current Status

The Rust server works correctly - the issue is purely browser certificate validation for ES6 modules. Static files load fine, but JavaScript modules require trusted certificates.

**Recommendation:** Use mkcert (Option 4) for seamless development experience.
