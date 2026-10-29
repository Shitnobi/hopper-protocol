//! Prints the OP_RETURN push payload (hex) for a MINT envelope.
//!
//! Usage: `cargo run -p hopper-core --example mint_envelope -- <seed-hex> <name>`
//! Example: `cargo run -p hopper-core --example mint_envelope -- abcd Hopz`

fn main() {
    let mut args = std::env::args().skip(1);
    let seed = args.next().expect("seed as hex, e.g. abcd");
    let name = args.next().unwrap_or_default();
    let seed = u32::from_str_radix(&seed, 16).expect("seed hex");
    let payload = hopper_core::envelope(
        hopper_core::Action::Mint,
        &hopper_core::encode_mint(seed, &name),
    );
    println!(
        "{}",
        payload
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    );
}
