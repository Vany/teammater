use anyhow::{Context, Result};
use rcgen::{CertificateParams, DistinguishedName, DnType, KeyPair, SanType};
use std::{fs, path::Path};
use tracing::info;

pub fn ensure_cert_exists(cert_path: &Path, key_path: &Path) -> Result<()> {
    if cert_path.exists() && key_path.exists() {
        info!("✅ Using existing certificate: {:?}", cert_path);
        return Ok(());
    }

    info!("🔐 Generating self-signed certificate...");

    let key_pair = KeyPair::generate()?;
    let key_pem = key_pair.serialize_pem();

    let mut params = CertificateParams::default();
    params.distinguished_name = DistinguishedName::new();
    params.distinguished_name.push(
        DnType::CommonName,
        "localhost",
    );
    params.subject_alt_names = vec![
        SanType::DnsName("localhost".try_into()?),
        SanType::IpAddress(std::net::IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 1))),
    ];

    let cert = params.self_signed(&key_pair)?;
    let cert_pem = cert.pem();

    if let Some(parent) = cert_path.parent() {
        fs::create_dir_all(parent)?;
    }

    fs::write(cert_path, cert_pem)
        .context("Failed to write certificate")?;
    fs::write(key_path, key_pem)
        .context("Failed to write private key")?;

    info!("✅ Generated self-signed certificate");
    info!("   📄 Certificate: {:?}", cert_path);
    info!("   🔑 Private key: {:?}", key_path);

    Ok(())
}
