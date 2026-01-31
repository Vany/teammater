use anyhow::{Context, Result};
use rcgen::{CertificateParams, DistinguishedName, DnType, KeyPair, SanType};
use std::{
    fs,
    net::{IpAddr, Ipv4Addr},
    path::Path,
};
use tracing::{info, warn};

const LOCALHOST: Ipv4Addr = Ipv4Addr::new(127, 0, 0, 1);

pub fn ensure_cert_exists(cert_path: &Path, key_path: &Path) -> Result<()> {
    match (cert_path.exists(), key_path.exists()) {
        (true, true) => {
            info!("✅ Using existing certificate: {}", cert_path.display());
            return Ok(());
        }
        (true, false) => warn!("⚠️ Certificate exists but key missing, regenerating..."),
        (false, true) => warn!("⚠️ Key exists but certificate missing, regenerating..."),
        (false, false) => {}
    }

    info!("🔐 Generating self-signed certificate...");

    let key_pair = KeyPair::generate()?;

    let mut params = CertificateParams::default();
    params.distinguished_name = DistinguishedName::new();
    params
        .distinguished_name
        .push(DnType::CommonName, "localhost");
    params.subject_alt_names = vec![
        SanType::DnsName("localhost".try_into()?),
        SanType::IpAddress(IpAddr::V4(LOCALHOST)),
    ];

    let cert = params.self_signed(&key_pair)?;

    if let Some(parent) = cert_path.parent() {
        fs::create_dir_all(parent).context("Failed to create certs directory")?;
    }

    fs::write(cert_path, cert.pem()).context("Failed to write certificate")?;
    fs::write(key_path, key_pair.serialize_pem()).context("Failed to write private key")?;

    info!(
        "✅ Generated: {} + {}",
        cert_path.display(),
        key_path.display()
    );

    Ok(())
}
