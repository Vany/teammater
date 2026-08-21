use anyhow::{anyhow, Context, Result};
use rcgen::{CertificateParams, DistinguishedName, DnType, KeyPair, SanType};
use rustls::ServerConfig;
use std::{
    fs,
    net::{IpAddr, Ipv4Addr, UdpSocket},
    path::Path,
};
use tracing::{info, warn};

const LOCALHOST: Ipv4Addr = Ipv4Addr::LOCALHOST;
const LAN_IP_CACHE: &str = "server/certs/lan_ip.txt";

/// Detect the real LAN IP, preferring 192.168.x.x over VPN/tunnel ranges.
/// Falls back to the UDP routing trick if no typical LAN IP is found.
pub fn detect_lan_ip() -> Option<IpAddr> {
    let ifaces = if_addrs::get_if_addrs().unwrap_or_default();

    // Priority 1: 192.168.x.x — typical home/office LAN
    for iface in &ifaces {
        if let IpAddr::V4(v4) = iface.ip() {
            let o = v4.octets();
            if o[0] == 192 && o[1] == 168 {
                return Some(IpAddr::V4(v4));
            }
        }
    }

    // Priority 2: 172.16–31.x.x — less common LAN range
    for iface in &ifaces {
        if let IpAddr::V4(v4) = iface.ip() {
            let o = v4.octets();
            if o[0] == 172 && (16..=31).contains(&o[1]) {
                return Some(IpAddr::V4(v4));
            }
        }
    }

    // Priority 3: 10.x.x.x — may be VPN, but better than nothing
    for iface in &ifaces {
        if let IpAddr::V4(v4) = iface.ip() {
            if v4.octets()[0] == 10 && !v4.is_loopback() {
                return Some(IpAddr::V4(v4));
            }
        }
    }

    // Fallback: UDP routing trick
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    socket.local_addr().ok().map(|a| a.ip())
}

/// Load TLS config, generating a cert if needed.
pub fn load_tls_config(cert_path: &Path, key_path: &Path, lan_ip: Option<IpAddr>) -> Result<ServerConfig> {
    ensure_cert_exists(cert_path, key_path, lan_ip)?;

    let cert_pem = fs::read(cert_path).context("read certificate")?;
    let key_pem  = fs::read(key_path).context("read private key")?;

    let certs = rustls_pemfile::certs(&mut &cert_pem[..])
        .collect::<Result<Vec<_>, _>>()
        .context("parse certificates")?;
    let key = rustls_pemfile::private_key(&mut &key_pem[..])?
        .ok_or_else(|| anyhow!("no private key in {}", key_path.display()))?;

    let mut cfg = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .context("configure TLS")?;
    cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(cfg)
}

/// Ensure a valid TLS cert exists for both localhost and the given LAN IP.
/// Regenerates the cert if the stored LAN IP differs from the current one.
/// Returns Ok(()) on success; the caller loads the cert files separately.
pub fn ensure_cert_exists(cert_path: &Path, key_path: &Path, lan_ip: Option<IpAddr>) -> Result<()> {
    let current_ip = lan_ip.map(|ip| ip.to_string());

    if cert_path.exists() && key_path.exists() {
        let stored_ip = fs::read_to_string(LAN_IP_CACHE)
            .ok()
            .map(|s| s.trim().to_string());

        if stored_ip.as_deref() == current_ip.as_deref() {
            info!(
                "✅ Using existing certificate: {} (IP: {})",
                cert_path.display(),
                current_ip.as_deref().unwrap_or("none")
            );
            return Ok(());
        }
        warn!(
            "🔐 LAN IP changed ({} → {}), regenerating cert...",
            stored_ip.as_deref().unwrap_or("none"),
            current_ip.as_deref().unwrap_or("none"),
        );
    }

    info!("🔐 Generating self-signed certificate...");
    generate_cert(cert_path, key_path, lan_ip)?;

    if let Some(ref ip) = current_ip {
        fs::write(LAN_IP_CACHE, ip).context("Failed to write LAN IP cache")?;
    }

    info!(
        "✅ Generated: {} + {} (SAN: localhost, 127.0.0.1{})",
        cert_path.display(),
        key_path.display(),
        lan_ip.map(|ip| format!(", {ip}")).unwrap_or_default(),
    );
    Ok(())
}

fn generate_cert(cert_path: &Path, key_path: &Path, lan_ip: Option<IpAddr>) -> Result<()> {
    let key_pair = KeyPair::generate()?;

    let mut params = CertificateParams::default();
    params.distinguished_name = DistinguishedName::new();
    params.distinguished_name.push(DnType::CommonName, "localhost");

    let mut sans = vec![
        SanType::DnsName("localhost".try_into()?),
        SanType::IpAddress(IpAddr::V4(LOCALHOST)),
    ];
    if let Some(ip) = lan_ip {
        sans.push(SanType::IpAddress(ip));
    }
    params.subject_alt_names = sans;

    let cert = params.self_signed(&key_pair)?;

    if let Some(parent) = cert_path.parent() {
        fs::create_dir_all(parent).context("Failed to create certs directory")?;
    }
    fs::write(cert_path, cert.pem()).context("Failed to write certificate")?;
    fs::write(key_path, key_pair.serialize_pem()).context("Failed to write private key")?;

    Ok(())
}
